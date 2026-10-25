// G11 — loop trigger + per-child window (queue item 4, second half).
//
// maybeIdleCompact is exercised directly (it is the run() trigger's whole
// body — run() calls it once at the top, swallowed on failure), with fake
// timers standing in for a 60-minute idle gap. The child test proves a
// per-child window flows through spawnSubagent without breaking spawning.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: {
      provider: 'openai',
      baseUrl: url,
      model: 'fake-model',
      speculative: { preflight: false },
    },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 4000,
      skipReproGate: true,
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

function packetLen(ctx: ContextEngine): number {
  return ctx.buildPacket([], undefined as any, undefined as any).messages.length;
}

function longTranscript(ctx: ContextEngine): void {
  ctx.setGoal('Refactor the billing pipeline to itemize usage per tenant');
  ctx.addMessage({ role: 'user', content: 'Refactor the billing pipeline to itemize usage per tenant' });
  for (let i = 0; i < 15; i++) {
    ctx.addMessage({ role: 'user', content: `Progress check ${i}: the billing refactor must still itemize usage per tenant, with per-tenant line items in every invoice.` });
    ctx.addMessage({ role: 'assistant', content: `Working on step ${i}: refactoring the billing flow carefully, keeping each tenant's usage separate and verifying invoice totals reconcile.` });
  }
}

describe('Agent idle-compaction trigger', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fires after an idle gap, then refuses the same idle period, then re-arms on new activity', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-loop-idle-'));
    try {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const config = makeConfig(dir, 'http://127.0.0.1:1');
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      const agent = new Agent({
        role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context,
        idleCompaction: { enabled: true, thresholdMs: 60 * 60 * 1000 },
      });
      expect(context.getIdleCompactionConfig()).toEqual({ enabled: true, thresholdMs: 60 * 60 * 1000 });
      longTranscript(context);
      const before = packetLen(context);

      // 61 idle minutes: the trigger fires and names itself.
      vi.setSystemTime(t0 + 61 * 60 * 1000);
      expect(await (agent as any).maybeIdleCompact()).toBe(true);
      expect(packetLen(context)).toBeLessThan(before);
      expect(context.prefixStats().breaks.map((b: { cause: string }) => b.cause)).toContain('idle-compaction');
      expect(context.getLastIdleCompactionAt()).toBe(t0 + 61 * 60 * 1000);

      // Same idle period, still idle: refuses (no second compaction).
      expect(await (agent as any).maybeIdleCompact()).toBe(false);

      // New activity AFTER the compaction re-arms; another idle gap fires again.
      vi.setSystemTime(t0 + 62 * 60 * 1000);
      context.addMessage({ role: 'user', content: 'Continue the billing refactor.' });
      vi.setSystemTime(t0 + 123 * 60 * 1000);
      expect(await (agent as any).maybeIdleCompact()).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never fires while a turn is in flight, and never fires when disabled', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-loop-idle-guard-'));
    try {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const config = makeConfig(dir, 'http://127.0.0.1:1');
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      const agent = new Agent({
        role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context,
        idleCompaction: { enabled: true, thresholdMs: 60 * 1000 },
      });
      longTranscript(context);
      const before = packetLen(context);

      // Active guard: a turn in flight blocks the trigger absolutely.
      (agent as any).runActive = true;
      vi.setSystemTime(t0 + 61 * 60 * 1000);
      expect(await (agent as any).maybeIdleCompact()).toBe(false);
      expect(packetLen(context)).toBe(before);
      (agent as any).runActive = false;

      // Disabled guard: a second agent with no opt-in never fires.
      const context2 = new ContextEngine(config, dir);
      const agent2 = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context: context2 });
      longTranscript(context2);
      expect(await (agent2 as any).maybeIdleCompact()).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a per-child autoCompactWindow flows through spawning without breaking the child', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-loop-idle-child-'));
    const fake = await startFakeOpenAI([
      { content: 'hello\n<result>\nSTATUS: done\nFILES: none\nRESULT: said hello\n</result>', finishReason: 'stop' },
      { content: 'hello\n<result>\nSTATUS: done\nFILES: none\nRESULT: said hello\n</result>', finishReason: 'stop' },
      { content: 'hello\n<result>\nSTATUS: done\nFILES: none\nRESULT: said hello\n</result>', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const out = await (agent as any).spawnSubagent('Say hello', { autoCompactWindow: 60_000 });
      expect(out).toContain('hello');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
