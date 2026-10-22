// Phase C6: durable run journal — agent-loop integration.
//
// A first Agent run executes two calls of a counting tool (side-effect
// counter = ground truth). A SECOND Agent (new instance, new context, same
// workspace + same task id = a resume, as after a process restart) is
// driven by the same scripted model responses with REGENERATED tool_call
// ids. The journal must serve both completed steps from disk: the counter
// must not move, and the resumed run must still complete.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { journalFilePath } from './run-journal.js';
import type { MochiConfig } from '../types.js';
import type { Tool } from '../tools/types.js';

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

describe('Agent loop + durable journal resume', () => {
  it('resumed run replays journaled tool steps instead of re-executing them', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-loop-'));
    const counter = { calls: 0, labels: [] as string[] };
    const countTool: Tool = {
      def: {
        name: 'count_step',
        description: 'Counts one step execution (test side-effect tool).',
        parameters: [{ name: 'label', type: 'string', description: 'Step label', required: true }],
      },
      execute: async (args) => {
        counter.calls++;
        counter.labels.push(String(args.label));
        return `counted ${String(args.label)}: execution #${counter.calls}`;
      },
    };
    const script = (idPrefix: string) => [
      {
        content: 'Counting a.',
        toolCalls: [{ id: `${idPrefix}-1`, type: 'function' as const, function: { name: 'count_step', arguments: JSON.stringify({ label: 'a' }) } }],
        finishReason: 'tool_calls',
      },
      {
        content: 'Counting b.',
        toolCalls: [{ id: `${idPrefix}-2`, type: 'function' as const, function: { name: 'count_step', arguments: JSON.stringify({ label: 'b' }) } }],
        finishReason: 'tool_calls',
      },
      { content: 'The counter total is two steps: a and b.', finishReason: 'stop' },
    ];
    const fake = await startFakeOpenAI(script('call'));
    try {
      const config = makeConfig(dir, fake.url);
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');

      const runOnce = async () => {
        const workspace = new Workspace(dir, '.mochi');
        workspace.ensure();
        const context = new ContextEngine(config, dir);
        context.setGoal('Counter total');
        const agent = new Agent({
          role: 'coder',
          config,
          workspace,
          events: new EventBus(),
          cwd: dir,
          context,
          extraTools: new Map([['count_step', countTool]]),
        });
        const result = await agent.run(task);
        return { result, stats: agent.getJournalStats() };
      };

      // ── First run: both steps really execute ──────────────────────────
      const first = await runOnce();
      expect(counter.calls).toBe(2);
      expect(counter.labels).toEqual(['a', 'b']);
      expect(first.result.success).toBe(true);
      expect(first.stats?.recordedSteps).toBe(2);
      expect(existsSync(journalFilePath(resolve(dir, '.mochi'), task.id))).toBe(true);

      // ── Resume: new Agent + context, same task, regenerated call ids ──
      fake.append(script('resume-call'));
      const second = await runOnce();

      // The journaled steps replayed — the tool was NOT re-executed...
      expect(counter.calls).toBe(2);
      expect(counter.labels).toEqual(['a', 'b']);
      expect(second.stats?.replayedSteps).toBe(2);
      expect(second.stats?.recordedSteps).toBe(0);
      // ...and the resumed run still completes successfully.
      expect(second.result.success).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
