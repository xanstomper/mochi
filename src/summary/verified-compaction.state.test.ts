// C7 verified compaction — the parts beyond the dropped slice:
//   * probe facts from pinned engine state (contract / constraints /
//     decisions / known errors / modified files),
//   * the recovery appendix bound: the contract is carried even when it
//     alone exceeds the budget, and omitted facts are NAMED,
//   * the persisted lineage record under .mochi/state (hashes, probe
//     outcome, recall_output pointers, redaction).
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildCompactionLineageRecord, buildRecoveryBlock, buildSummaryLineage,
  dedupeProbeFacts, probeFactsFromState, readCompactionLineage,
  type CompactionVerification, type ProbeFact,
} from './verified-compaction.js';
import { ContextEngine } from '../context.js';
import type { MochiConfig } from '../types.js';

function fact(kind: ProbeFact['kind'], text: string, sourceIndex = 0): ProbeFact {
  return { id: `fact-${kind}-${sourceIndex}`, text, kind, sourceIndex, sourceRole: 'test', needles: [], tokens: [] };
}

describe('probeFactsFromState', () => {
  it('produces contract, constraint, decision, error and path facts from pinned state', () => {
    const facts = probeFactsFromState({
      goal: 'fallback goal',
      initialUserPrompt: 'Fix the payment retry bug so failed charges retry exactly once',
      constraints: ['Never edit generated files under dist/'],
      decisions: ['Use an idempotency key per charge'],
      errors: ['src/payment.ts:88: error TS2345: bad Charge argument'],
      filesModified: ['src/payment.ts'],
    });
    const byKind = new Map(facts.map((f) => [f.kind, f]));
    expect(byKind.get('contract')!.text).toContain('payment retry bug');
    expect(byKind.get('constraint')!.text).toContain('Never edit generated files');
    expect(byKind.get('decision')!.text).toContain('idempotency key');
    expect(byKind.get('error')!.needles).toContain('TS2345');
    expect(byKind.get('path')!.needles).toContain('src/payment.ts');
    expect(facts.every((f) => f.sourceIndex === -1)).toBe(true);
  });

  it('dedupeProbeFacts lets the contract win over a slice goal with the same text', () => {
    const merged = dedupeProbeFacts([
      fact('goal', 'Fix the payment retry bug'),
      fact('contract', 'Fix the payment retry bug'),
      fact('error', 'src/payment.ts:88: error TS2345: bad argument'),
    ]);
    expect(merged.map((f) => f.kind)).toEqual(['contract', 'error']);
  });
});

describe('buildRecoveryBlock budget', () => {
  it('(c) the contract is carried in full even when it alone exceeds the budget; omitted facts are named', () => {
    const contractText = `Task contract: ${'fix the payment retry bug with exactly-once semantics and full regression coverage. '.repeat(3)}`.trim();
    const block = buildRecoveryBlock([
      fact('error', 'src/payment.ts:88: error TS2345: Argument of type string is not assignable'),
      fact('contract', contractText),
      fact('decision', 'DECISION: use an idempotency key per charge instead of a retry counter'),
    ], 160);
    // Contract present VERBATIM despite blowing the 160-char budget…
    expect(block).toContain(contractText);
    expect(block).toContain('RETENTION RECOVERY');
    // …and the facts that did not fit are named, not silently dropped.
    expect(block).toContain('omitted by the recovery budget');
    expect(block).toContain('[error]');
    expect(block).toContain('[decision]');
  });

  it('with ample budget everything is restored and nothing is reported omitted', () => {
    const block = buildRecoveryBlock([
      fact('error', 'src/payment.ts:88: error TS2345: bad argument'),
      fact('decision', 'DECISION: use an idempotency key per charge'),
    ]);
    expect(block).toContain('TS2345');
    expect(block).toContain('idempotency key');
    expect(block).not.toContain('omitted by the recovery budget');
  });
});

// ── Engine integration ───────────────────────────────────────────────────────

function makeConfig(dir: string): MochiConfig {
  return {
    model: { provider: 'openai', model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function fillers(ctx: ContextEngine, n: number, start = 0): void {
  for (let i = 0; i < n; i++) {
    ctx.addMessage({ role: 'user', content: `Continuing with step ${start + i} of the repair work.` });
    ctx.addMessage({ role: 'assistant', content: `Working through step ${start + i} carefully now.` });
  }
}

describe('ContextEngine.compact state facts + lineage record', () => {
  it('a constraint held only in pinned state survives compaction and is probed', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-c7-state-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      ctx.setGoal('Fix the payment retry bug so that failed charges are retried exactly once');
      ctx.addMessage({ role: 'user', content: 'Fix the payment retry bug so that failed charges are retried exactly once' });
      // The constraint exists ONLY in pinned state — no message carries it.
      // The pre-C7 ledger dropped state constraints entirely; the probe set
      // must include it and the post-compaction context must retain it.
      ctx.updateState({ constraints: ['Never edit generated files under dist/ — change src/ only'] });
      fillers(ctx, 12);
      await ctx.compact();
      const v = ctx.lastCompactionVerification!;
      expect(v.facts.map((f) => f.kind)).toContain('contract');
      expect(v.facts.map((f) => f.kind)).toContain('constraint');
      expect(v.passed).toBe(true);
      const flat = ctx.getMessages().map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      expect(flat).toContain('Never edit generated files under dist/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('(d) persists a lineage record with hashes, probe outcome and archive pointers', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-c7-lineage-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      ctx.setGoal('Fix the payment retry bug so that failed charges are retried exactly once');
      ctx.addMessage({ role: 'user', content: 'Fix the payment retry bug so that failed charges are retried exactly once' });
      ctx.addMessage({ role: 'assistant', content: 'Investigating the payment module first.' });
      // A dropped tool result that cites an archived output: the lineage
      // record must carry the recall_output pointer.
      const toolText = `${'build output line, nothing to see here at all.\n'.repeat(12)}[full output archived — recall_output out-abc123-x9 retrieves it]`;
      ctx.addMessage({ role: 'tool', name: 'shell', content: toolText });
      fillers(ctx, 12);
      await ctx.compact();

      const v = ctx.lastCompactionVerification!;
      expect(existsSync(join(dir, '.mochi', 'state', 'compaction-lineage.json'))).toBe(true);
      const records = readCompactionLineage(dir);
      expect(records.length).toBe(1);
      const rec = records[0];
      expect(rec.id).toBe(v.lineage.id);
      expect(rec.replacedCount).toBe(v.lineage.replacedCount);
      expect(rec.sourceRange.from).toBe(0);
      expect(rec.sourceRange.to).toBeGreaterThan(0);
      expect(rec.sourceHash).toMatch(/^[0-9a-f]{16}$/);
      expect(rec.digestHash).toMatch(/^[0-9a-f]{16}$/);
      expect(rec.probe.total).toBe(v.facts.length);
      expect(rec.probe.passed).toBe(v.passed);
      expect(rec.probe.missed).toEqual([]);
      expect(rec.archiveIds).toContain('out-abc123-x9');
      // Reader by id round-trips; unknown id yields nothing.
      expect(readCompactionLineage(dir, rec.id)).toEqual([rec]);
      expect(readCompactionLineage(dir, 'sum-00000000')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('lineage record redacts still-missed fact text', () => {
    const secret = `sk-ant-${'a'.repeat(24)}`;
    const missed = fact('error', `auth failed for key ${secret} in src/auth.ts`);
    const verification: CompactionVerification = {
      lineage: buildSummaryLineage([{ role: 'user', content: 'some earlier history worth summarizing' }]),
      facts: [missed],
      initial: { total: 1, retainedIds: [], missing: [missed], score: 0, passed: false },
      final: { total: 1, retainedIds: [], missing: [missed], score: 0, passed: false },
      escalations: ['re-include', 'widen'],
      passed: false,
    };
    const rec = buildCompactionLineageRecord({
      lineage: verification.lineage,
      ts: 123,
      sourceRange: { from: 0, to: 1 },
      sourceText: 'source',
      digestText: 'digest',
      verification,
      archiveScanText: 'nothing archived',
    });
    expect(rec.probe.passed).toBe(false);
    expect(rec.probe.missed.length).toBe(1);
    expect(rec.probe.missed[0].text).not.toContain(secret);
    expect(rec.probe.repairedIds).toEqual([]);
  });
});
