// G11 — idle compaction (queue item 4, second half): decision matrix,
// activity clock, and the first-turn-after-idle token measurement.
//
// The gap: Mochi had no idle trigger — a user returning to an idle long
// session paid an uncached full-context turn. The decision function below
// is pure so every refusal (the false-trigger set) is unit-testable; the
// fixture measures the token win of compacting before the resumed turn.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  ContextEngine,
  shouldIdleCompact,
  DEFAULT_IDLE_COMPACTION_THRESHOLD_MS,
} from './context.js';
import type { MochiConfig } from './types.js';

function makeConfig(dir: string): MochiConfig {
  return {
    model: { provider: 'openai', model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

/** Chars of the conversation transcript itself (excluding the constant
 *  system head, which compaction never touches — the head would swamp
 *  the measurement). This is the portion idle compaction actually cuts. */
function transcriptChars(ctx: ContextEngine): number {
  const msgs = (ctx as any).messages as Array<{ content?: unknown }>;
  let chars = 0;
  for (const m of msgs) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
  }
  return chars;
}

function longTranscript(ctx: ContextEngine, rounds: number): void {
  ctx.setGoal('Refactor the billing pipeline to itemize usage per tenant');
  ctx.addMessage({ role: 'user', content: 'Refactor the billing pipeline to itemize usage per tenant' });
  ctx.addMessage({ role: 'assistant', content: 'I will start by reading the billing module.', tool_calls: [{ id: 't0', type: 'function', function: { name: 'read', arguments: '{"path":"src/billing.ts"}' } }] });
  ctx.addMessage({ role: 'tool', tool_call_id: 't0', name: 'read', content: 'export function bill(tenant) { return tenant.usage * 0.02; }' });
  for (let i = 0; i < rounds; i++) {
    ctx.addMessage({ role: 'user', content: `Continuing — progress check ${i}. The billing refactor must still itemize usage per tenant, with per-tenant line items in the invoice.` });
    ctx.addMessage({ role: 'assistant', content: `Working on step ${i}: refactoring the billing flow carefully, keeping each tenant's usage separate and verifying the invoice totals still reconcile.` });
  }
}

describe('shouldIdleCompact decision matrix (false-trigger set = 0)', () => {
  const base = { enabled: true, thresholdMs: 60_000, lastActivityAt: 1000, now: 70_000, active: false };

  it('refuses when disabled (kill switch)', () => {
    expect(shouldIdleCompact({ ...base, enabled: false })).toEqual({ eligible: false, reason: 'disabled' });
  });

  it('refuses when a turn is in flight — never interrupts active work', () => {
    expect(shouldIdleCompact({ ...base, active: true })).toEqual({ eligible: false, reason: 'active' });
  });

  it('refuses on an unknown activity clock', () => {
    expect(shouldIdleCompact({ ...base, lastActivityAt: undefined })).toEqual({ eligible: false, reason: 'unknown-activity' });
  });

  it('refuses when not yet idle', () => {
    expect(shouldIdleCompact({ ...base, now: 50_000 })).toEqual({ eligible: false, reason: 'not-idle' });
  });

  it('fires exactly at the threshold', () => {
    expect(shouldIdleCompact({ ...base, now: 61_000 })).toEqual({ eligible: true, idleMs: 60_000 });
  });

  it('refuses a second compaction for the same idle period', () => {
    expect(shouldIdleCompact({ ...base, lastIdleCompactionAt: 65_000 })).toEqual({ eligible: false, reason: 'already-compacted' });
  });

  it('re-arms when new activity arrives after a compaction', () => {
    expect(shouldIdleCompact({ ...base, lastActivityAt: 66_000, lastIdleCompactionAt: 65_000, now: 200_000 })).toEqual({ eligible: true, idleMs: 134_000 });
  });

  it('default threshold sits inside a 1-hour cache TTL', () => {
    expect(DEFAULT_IDLE_COMPACTION_THRESHOLD_MS).toBe(54 * 60 * 1000);
    expect(DEFAULT_IDLE_COMPACTION_THRESHOLD_MS).toBeLessThan(60 * 60 * 1000);
  });
});

describe('ContextEngine idle clock + config', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('activity clock starts unknown and advances on every message', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-idle-clock-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      expect(ctx.getLastActivityAt()).toBeUndefined();
      ctx.addMessage({ role: 'user', content: 'hello' });
      const at = ctx.getLastActivityAt();
      expect(at).toBeDefined();
      expect(at).toBeLessThanOrEqual(Date.now());
      expect(ctx.getIdleCompactionConfig()).toEqual({ enabled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('idle config round-trips and markIdleCompaction stamps the time', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-idle-cfg-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      ctx.setIdleCompactionConfig({ enabled: true, thresholdMs: 1234 });
      expect(ctx.getIdleCompactionConfig()).toEqual({ enabled: true, thresholdMs: 1234 });
      expect(ctx.getLastIdleCompactionAt()).toBeUndefined();
      ctx.markIdleCompaction(9999);
      expect(ctx.getLastIdleCompactionAt()).toBe(9999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('first turn after a 60-minute idle gap costs far fewer tokens once compacted', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-idle-tokens-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      longTranscript(ctx, 40);
      const beforeChars = transcriptChars(ctx);
      const beforeTokens = beforeChars / 3.8;
      await ctx.compact();
      const afterChars = transcriptChars(ctx);
      const afterTokens = afterChars / 3.8;
      // The resumed turn's transcript shrinks to the recency window +
      // ledger (the constant system head is excluded — compaction never
      // touches it, so including it would swamp the measurement).
      expect(afterChars).toBeLessThan(beforeChars);
      expect(afterTokens).toBeLessThan(beforeTokens * 0.5);
      // And the compaction is named in P5 break attribution.
      expect(ctx.prefixStats().breaks.map((b) => b.cause)).toContain('compaction');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an idle-triggered compaction names itself idle-compaction in break attribution', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-idle-reason-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      longTranscript(ctx, 40);
      await ctx.compact(undefined, undefined, { reason: 'idle-compaction' });
      expect(ctx.prefixStats().breaks.map((b) => b.cause)).toContain('idle-compaction');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
