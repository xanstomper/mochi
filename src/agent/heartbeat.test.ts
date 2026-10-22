// Progress heartbeat: pure helper + file-op counts + end-to-end stuck stop.
// The heartbeat catches what exact-repeat/oscillation guards miss: DIFFERENT
// actions every turn that go nowhere (re-reading the same files forever).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { heartbeatShowsProgress, HEARTBEAT_EVERY, HEARTBEAT_MAX_STALL, Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

describe('heartbeatShowsProgress', () => {
  const zero = { read: 0, edited: 0, verifyPass: 0 };
  it('any growth counts as progress', () => {
    expect(heartbeatShowsProgress(zero, { read: 1, edited: 0, verifyPass: 0 })).toBe(true);
    expect(heartbeatShowsProgress(zero, { read: 0, edited: 1, verifyPass: 0 })).toBe(true);
    expect(heartbeatShowsProgress(zero, { read: 0, edited: 0, verifyPass: 1 })).toBe(true);
  });
  it('identical snapshots mean stalled', () => {
    const s = { read: 3, edited: 1, verifyPass: 2 };
    expect(heartbeatShowsProgress(s, { ...s })).toBe(false);
  });
  it('heartbeat cadence constants are sane', () => {
    expect(HEARTBEAT_EVERY).toBeGreaterThanOrEqual(4);
    expect(HEARTBEAT_EVERY).toBeLessThanOrEqual(12);
    expect(HEARTBEAT_MAX_STALL).toBe(2);
  });
});

describe('ContextEngine.fileOpCounts', () => {
  it('tracks distinct files read and edited', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hb-'));
    try {
      writeFileSync(resolve(dir, 'a.ts'), 'v1');
      const config = { safety: { contextBudgetTokens: 100_000 } } as unknown as MochiConfig;
      const ctx = new ContextEngine(config, dir);
      expect(ctx.fileOpCounts()).toEqual({ read: 0, edited: 0 });
      const tc = (name: string, args: Record<string, unknown>) => ({
        role: 'assistant' as const, content: '',
        tool_calls: [{ id: 't1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
      });
      ctx.addMessage(tc('read', { path: 'a.ts' }));
      ctx.addMessage(tc('read', { path: 'a.ts' })); // re-read: still 1 distinct
      expect(ctx.fileOpCounts()).toEqual({ read: 1, edited: 0 });
      ctx.addMessage(tc('edit', { path: 'a.ts' }));
      expect(ctx.fileOpCounts()).toEqual({ read: 1, edited: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

describe('progress heartbeat end-to-end', () => {
  it('stops honest re-reading-the-same-files wandering well before maxIterations', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hb-e2e-'));
    writeFileSync(resolve(dir, 'a.ts'), 'export const a = 1;');
    writeFileSync(resolve(dir, 'b.ts'), 'export const b = 2;');
    // Alternate reads of two files: evades the exact-repeat guard (signatures
    // differ every turn) and the oscillation guard (read-only exempt).
    // Historically ONLY the progress heartbeat could stop this run (at ~24
    // turns); the reasoning-discipline progress forcing (agent/discipline.ts)
    // now stops it sooner — re-reading already-read files is deliberation,
    // and deliberation is force-finished at 3 turns. The contract this test
    // pins is unchanged in substance: an honest stuck_no_progress finish,
    // well before maxIterations, with no fake success. The heartbeat still
    // owns the shapes progress forcing cannot see (varied actions that
    // cover new ground yet never converge).
    const scripted = Array.from({ length: 38 }, (_, k) => ({
      content: k % 2 === 0 ? 'Checking a.' : 'Checking b.',
      toolCalls: [{
        id: `r-${k}`, type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: k % 2 === 0 ? 'a.ts' : 'b.ts' }) },
      }],
      finishReason: 'tool_calls',
    }));
    const fake = await startFakeOpenAI(scripted);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Fix the login bug');
      const task = createTask('Fix the login bug', 'Find and fix the login bug.', {
        acceptanceCriteria: ['login works', 'regression test added'],
      } as never);
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const result = await agent.run(task);
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('stuck_no_progress');
      expect(result.summary).toContain('deliberating');
      // Progress forcing: 2 progress reads (a, b), then deliberation turns
      // (commit directive, then the forced decisive finish) — a handful of
      // requests, far short of both the old heartbeat stop (~24) and the
      // 40-iteration budget.
      expect(fake.requests.length).toBeLessThanOrEqual(8);
      expect(fake.requests.length).toBeGreaterThan(3);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
