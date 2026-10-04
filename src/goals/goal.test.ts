import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { GoalEngine } from './goal.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import { createTask } from './task.js';
import { startFakeOpenAI, type FakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

let fake: FakeOpenAI;
let config: MochiConfig;

beforeAll(async () => {
  fake = await startFakeOpenAI([
    {
      content: 'Writing file.',
      toolCalls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path: 'generated.txt', content: 'mochi goal' }) },
        },
      ],
      finishReason: 'tool_calls',
    },
    { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    { content: '{"status":"PASS","passed":["file created","tests passed"],"failed":[],"recommendation":"Complete"}', finishReason: 'stop', completionTokens: 40 },
  ]);
  config = {
    model: {
      provider: 'openai',
      baseUrl: fake.url,
      model: 'fake-model',
    },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 10,
      maxConcurrentAgents: 2,
      contextBudgetTokens: 4000,
      maxModelCalls: 10,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false,
    projectDir: '.mochi',
    configDir: '/tmp',
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
});

afterAll(async () => { await fake.close(); });

describe('GoalEngine', () => {
  it('runs a task through the builder, verifier, and scheduler', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-goal-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const engine = new GoalEngine(config, workspace, new EventBus(), dir);
    const goal = await engine.createGoal('create generated.txt');
    const task = createTask('Create file', 'Create generated.txt containing mochi goal', {
      acceptanceCriteria: ['generated.txt exists'],
    });
    const result = await engine.runGoal(goal, [task]);
    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'generated.txt'), 'utf8')).toBe('mochi goal');
    expect(result.summary).toContain('1 done');
  });

  it('decomposes a one-shot answer objective into a single no-verify task', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-goal-'));
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const engine = new GoalEngine(config, workspace, new EventBus(), dir);
    const goal = await engine.createGoal('Say hello in exactly 3 words.');
    const tasks = await engine.decompose(goal);
    // The fast path short-circuits the model decomposition: one bare answer task.
    expect(tasks.length).toBe(1);
    expect(tasks[0].acceptanceCriteria.length).toBe(0);
    expect(tasks[0].verificationCommand).toBeUndefined();
    // It must not be routed to the heavyweight generate/verify path.
    expect(tasks[0].title).toContain('Say hello');
  });
});

describe('GoalEngine auto-resume', () => {
  it('re-sends the prompt and completes after a mid-task model_error', async () => {
    const resumeFake = await startFakeOpenAI([
      {
        // Route by request shape: pre-resume requests fail like a dead
        // provider; the resume prompt (marker below) gets a clean answer.
        respondFn: (body: any) => {
          const msgs = JSON.stringify(body?.messages ?? []);
          if (msgs.includes('Continue the task EXACTLY where you left off')) {
            return { content: 'Resumed and finished the task.', finishReason: 'stop', completionTokens: 8 };
          }
          return { error: { status: 503, message: 'provider exploded mid-run' } };
        },
      } as any,
    ]);
    try {
      const cfg = { ...config, model: { ...config.model, baseUrl: resumeFake.url } } as unknown as MochiConfig;
      const dir = mkdtempSync(resolve(tmpdir(), 'mochi-resume-'));
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const engine = new GoalEngine(cfg, workspace, new EventBus(), dir);
      const goal = await engine.createGoal('answer only, no tools');
      const task = createTask('Answer task', 'Say OK', { acceptanceCriteria: [] });
      const result = await engine.runGoal(goal, [task]);
      // The first run died model_error; the auto-resume re-sent the prompt
      // with progress and the SAME task finished successfully.
      expect(result.success).toBe(true);
      expect(result.summary).toContain('1 done');
      expect(result.summary).not.toContain('auto-resume');
    } finally {
      await resumeFake.close();
    }
  }, 30_000);

  it('does NOT resume when the caller aborts mid-task', async () => {
    // Stall the first response, abort from the caller mid-flight, and prove
    // the run surfaces as aborted with NO auto-resume attempt afterwards.
    const abortFake = await startFakeOpenAI([{ stall: true }]);
    try {
      const cfg = { ...config, model: { ...config.model, baseUrl: abortFake.url } } as unknown as MochiConfig;
      const dir = mkdtempSync(resolve(tmpdir(), 'mochi-abort-'));
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const probeEngine = new GoalEngine(cfg, workspace, new EventBus(), dir);
      const goal = await probeEngine.createGoal('answer only, no tools');
      const task = createTask('Answer task', 'Say OK', { acceptanceCriteria: [] });
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error('user cancel')), 400);
      const logs: string[] = [];
      const events = new EventBus();
      events.on('agent:log', (e) => { logs.push(e.message); });
      const engine2 = new GoalEngine(cfg, workspace, events, dir);
      const result = await engine2.runGoal(goal, [task], [], ac.signal);
      // Aborted runs surface as failure — cancelling stays cancelling.
      expect(result.success).toBe(false);
      // No resume attempt was made for an abort.
      expect(logs.join('\n')).not.toContain('[auto-resume');
    } finally {
      await abortFake.close();
    }
  }, 30_000);
});
