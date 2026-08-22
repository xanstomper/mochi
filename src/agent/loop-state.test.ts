import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { LoopStateMachine, type IterationTrace, type LoopPhase } from './loop-state.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

describe('LoopStateMachine (harness-v2 Phase 1)', () => {
  it('accepts the full legal chain preflight → … → finish with zero violations', () => {
    const sm = new LoopStateMachine(new EventBus(), 'a1');
    sm.beginIteration(0);
    sm.enter('model-call');
    sm.enter('stream-guard');
    sm.enter('tool-exec');
    // Next iteration: nudge paths restart cleanly through beginIteration.
    sm.beginIteration(1);
    sm.enter('model-call');
    sm.enter('stream-guard');
    sm.enter('verify');
    sm.enter('finish');
    expect(sm.violations).toEqual([]);
  });

  it('records (but never throws on) illegal transitions', () => {
    const sm = new LoopStateMachine(new EventBus(), 'a1');
    sm.beginIteration(3);
    sm.enter('tool-exec'); // preflight → tool-exec skips model-call
    expect(sm.violations).toEqual([{ from: 'preflight', to: 'tool-exec', iteration: 3 }]);
    expect(sm.phase).toBe('tool-exec'); // still transitions — never crashes a live run
  });

  it('treats re-entering the current phase as an idempotent no-op', () => {
    const sm = new LoopStateMachine(new EventBus(), 'a1');
    sm.beginIteration(0);
    sm.enter('model-call');
    sm.enter('model-call'); // stream retry re-enters gatherStream
    expect(sm.violations).toEqual([]);
  });

  it('can finish (abort) from ANY state', () => {
    const states: LoopPhase[] = ['preflight', 'model-call', 'stream-guard', 'tool-exec', 'verify'];
    for (const target of states) {
      const sm = new LoopStateMachine(new EventBus(), 'a1');
      sm.beginIteration(0);
      if (target === 'preflight') {
        sm.flush('aborted');
        expect(sm.phase).toBe('preflight');
        continue;
      }
      sm.enter(target);
      sm.enter('finish');
      const t = sm.flush('aborted');
      expect(t?.stopReason).toBe('aborted');
      expect(t?.phase).toBe('finish');
    }
  });

  it('resets counters each iteration and emits one trace per iteration', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on('agent:iteration', (e) => seen.push(e.trace));
    const sm = new LoopStateMachine(bus, 'a1');

    sm.beginIteration(0);
    sm.recordToolCalls(2);
    sm.addStreamBytes(120);
    const t0 = sm.flush();
    expect(t0).toMatchObject({ iteration: 0, toolCalls: 2, streamBytes: 120 });
    expect(t0?.durationMs).toBeGreaterThanOrEqual(0);

    sm.beginIteration(1);
    sm.recordToolCalls(1);
    const t1 = sm.flush('completed');
    expect(t1).toMatchObject({ iteration: 1, toolCalls: 1, streamBytes: 0 });
    expect(t1?.stopReason).toBe('completed');
    expect(seen).toHaveLength(2);
  });

  it('flushes pending trace on beginIteration (continue-ended iterations emit too)', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on('agent:iteration', (e) => seen.push(e.trace));
    const sm = new LoopStateMachine(bus, 'a1');

    sm.beginIteration(0);
    sm.recordToolCalls(1);
    sm.beginIteration(1); // iteration 0 ended via continue → flushed here
    sm.flush('max_iterations');

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ iteration: 0, toolCalls: 1 });
    expect(seen[1]).toMatchObject({ iteration: 1, stopReason: 'max_iterations' });
  });

  it('returns undefined when flushing with no active iteration or twice', () => {
    const sm = new LoopStateMachine(new EventBus(), 'a1');
    expect(sm.flush()).toBeUndefined(); // never begun
    sm.beginIteration(0);
    expect(sm.flush()).toBeDefined();
    expect(sm.flush()).toBeUndefined(); // already flushed
  });
});

describe('Agent emits agent:iteration traces (integration)', () => {
  function makeConfig(dir: string, url: string): MochiConfig {
    return {
      model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
      safety: {
        mode: 'auto',
        commandTimeoutSeconds: 10,
        maxIterations: 10,
        maxRuntimeMinutes: 5,
        maxConcurrentAgents: 1,
        contextBudgetTokens: 4000,
      },
      permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
      telemetry: false,
      projectDir: '.mochi',
      configDir: resolve(dir, '.config/mochi'),
      quiet: true,
      verbose: false,
      debug: false,
    } as unknown as MochiConfig;
  }

  it('emits one monotonically-numbered trace per turn with a final stop reason', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-trace-'));
    const fake = await startFakeOpenAI([
      {
        content: 'I will write the file now.',
        toolCalls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'hello.txt'), content: 'hello mochi' }) },
          },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('write a greeting');
    const task = createTask('Write greeting', 'Create hello.txt with "hello mochi".');

    const bus = new EventBus();
    const traces: IterationTrace[] = [];
    bus.on('agent:iteration', (e) => traces.push(e.trace));

    const agent = new Agent({ id: 'trace-agent', role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'hello.txt'), 'utf8')).toBe('hello mochi');

    // Exactly one trace per iteration, numbered from 0 with no gaps/dupes.
    expect(traces.length).toBeGreaterThanOrEqual(2);
    expect(traces.map((t) => t.iteration)).toEqual(traces.map((_, i) => i));
    // The write iteration records its single tool call.
    expect(traces[0].toolCalls).toBe(1);
    // Every trace is well-formed.
    for (const t of traces) {
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
      expect(t.toolCalls).toBeGreaterThanOrEqual(0);
      expect(t.streamBytes).toBeGreaterThanOrEqual(0);
      expect(typeof t.phase).toBe('string');
    }
    // The final trace carries the run's stop reason.
    expect(traces[traces.length - 1].stopReason).toBe('completed');
    await fake.close();
  }, 60_000);
});

