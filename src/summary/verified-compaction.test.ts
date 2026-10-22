// C7 verified compaction: retention probe + summary lineage.
//
// Falsifiable core: a lossy post-compaction context MUST fail the probe
// (missing facts named), escalation MUST be what makes it pass, and a
// no-op escalation MUST leave the failure visible — never silently pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  buildRecoveryBlock, buildSummaryLineage, ensureRetention, extractProbeFacts,
  parseSummaryMarker, renderSummaryLineage, runRetentionProbe,
  type ProbeMessageLike,
} from './verified-compaction.js';
import { compactSession, compactToPrompt } from './compact.js';
import { ContextEngine } from '../context.js';
import type { MochiConfig } from '../types.js';

function buriedHistory(): ProbeMessageLike[] {
  return [
    { role: 'user', content: 'Fix the payment retry bug so that failed charges are retried exactly once' },
    { role: 'assistant', content: 'Investigating the payment module first.' },
    { role: 'tool', name: 'shell', content: 'compiling modules, all quiet so far\nsrc/payment.ts:88: error TS2345: Argument of type string is not assignable to parameter of type Charge.\nstill compiling, nothing else to report' },
    { role: 'assistant', content: 'DECISION: we will use an idempotency key per charge instead of a retry counter.' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit', arguments: '{"path":"src/payment.ts"}' } }] },
    { role: 'assistant', content: 'routine status note, nothing notable in this line at all, moving on now' },
  ];
}

describe('extractProbeFacts', () => {
  it('extracts goal, error, decision and path facts from the pre-compaction slice', () => {
    const facts = extractProbeFacts(buriedHistory());
    const kinds = facts.map((f) => f.kind);
    expect(kinds).toContain('goal');
    expect(kinds).toContain('error');
    expect(kinds).toContain('decision');
    const errorFact = facts.find((f) => f.kind === 'error')!;
    expect(errorFact.text).toContain('TS2345');
    expect(errorFact.needles).toContain('src/payment.ts');
    expect(errorFact.needles).toContain('TS2345');
    // Dedupe: the edit tool-call on src/payment.ts must not create a second
    // fact whose only signal is the same path needle as the error fact,
    // unless it IS the error fact.
    const pathOnly = facts.filter((f) => f.kind === 'path' && f.needles.includes('src/payment.ts'));
    expect(pathOnly.length).toBe(0);
  });

  it('caps the probe at N facts and ignores filler', () => {
    const msgs: ProbeMessageLike[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'tool', name: 'shell', content: `src/mod${i}/file.ts:1: error TS1005: problem number ${i} in this module` });
    }
    msgs.push({ role: 'assistant', content: 'routine status note, nothing notable here, moving along with the work' });
    const facts = extractProbeFacts(msgs);
    expect(facts.length).toBe(5);
    expect(extractProbeFacts(msgs, { maxFacts: 3 }).length).toBe(3);
    expect(facts.every((f) => f.kind === 'error')).toBe(true);
  });

  it('returns no facts for a slice with no salient content', () => {
    const msgs: ProbeMessageLike[] = [
      { role: 'user', content: 'msg 0' },
      { role: 'assistant', content: 'step 1 done' },
      { role: 'user', content: 'msg 2' },
    ];
    expect(extractProbeFacts(msgs)).toEqual([]);
  });
});

describe('runRetentionProbe', () => {
  const facts = extractProbeFacts(buriedHistory());

  it('passes when the post-compaction text retains the facts (paraphrase-tolerant)', () => {
    const post = [
      'Goal: fix the payment retry bug — failed charges are retried exactly once.',
      'src/payment.ts had error TS2345 on the Charge argument.',
      'Decision: use an idempotency key per charge instead of a retry counter.',
    ].join('\n');
    const report = runRetentionProbe(facts, post);
    expect(report.passed).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.score).toBe(1);
  });

  it('fails and NAMES the missing facts when the summary dropped them', () => {
    const post = 'Goal: fix the payment retry bug — failed charges are retried exactly once.';
    const report = runRetentionProbe(facts, post);
    expect(report.passed).toBe(false);
    expect(report.missing.map((f) => f.kind)).toContain('error');
    expect(report.missing.map((f) => f.kind)).toContain('decision');
    expect(report.score).toBeLessThan(1);
  });
});

describe('ensureRetention escalation', () => {
  const facts = extractProbeFacts(buriedHistory());

  it('re-include escalation makes a failing probe pass', () => {
    let post = 'Goal: fix the payment retry bug — failed charges are retried exactly once.';
    const out = ensureRetention({
      facts,
      readText: () => post,
      reinject: (missing) => { post += '\n' + buildRecoveryBlock(missing); },
    });
    expect(out.initial.passed).toBe(false);
    expect(out.escalations).toEqual(['re-include']);
    expect(out.final.passed).toBe(true);
  });

  it('widens when re-include alone does not restore the facts', () => {
    let post = 'a summary that kept nothing at all';
    const out = ensureRetention({
      facts,
      readText: () => post,
      reinject: () => { /* broken reinject: adds nothing */ },
      widen: (missing) => { post += '\n' + missing.map((f) => f.text).join('\n'); },
    });
    expect(out.escalations).toEqual(['re-include', 'widen']);
    expect(out.final.passed).toBe(true);
  });

  it('a no-op escalation leaves the failure VISIBLE (never silently passes)', () => {
    const out = ensureRetention({
      facts,
      readText: () => 'nothing retained here',
      reinject: () => {},
      widen: () => {},
    });
    expect(out.escalations).toEqual(['re-include', 'widen']);
    expect(out.final.passed).toBe(false);
    expect(out.final.missing.length).toBeGreaterThan(0);
  });

  it('does not escalate when the first probe already passes', () => {
    const post = buriedHistory().map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    let reinjected = false;
    const out = ensureRetention({
      facts,
      readText: () => post,
      reinject: () => { reinjected = true; },
    });
    expect(out.initial.passed).toBe(true);
    expect(out.escalations).toEqual([]);
    expect(reinjected).toBe(false);
  });
});

describe('summary lineage', () => {
  it('renders a parseable marker and round-trips id + parents', () => {
    const lineage = buildSummaryLineage(buriedHistory());
    expect(lineage.id).toMatch(/^sum-[0-9a-f]{8}$/);
    expect(lineage.replacedCount).toBe(6);
    expect(lineage.replaced.length).toBe(6);
    expect(lineage.parents).toEqual([]);
    const parsed = parseSummaryMarker(`prefix ${renderSummaryLineage(lineage)} suffix`);
    expect(parsed?.id).toBe(lineage.id);
    expect(parsed?.parents).toEqual([]);
  });

  it('a second-generation summary adopts the first as a parent', () => {
    const first = buildSummaryLineage(buriedHistory());
    const secondSlice: ProbeMessageLike[] = [
      { role: 'system', content: `Earlier in this session (compacted):\n${renderSummaryLineage(first)}\nGoal: payment retry` },
      { role: 'user', content: 'continue with the next step of the repair work please' },
    ];
    const second = buildSummaryLineage(secondSlice);
    expect(second.parents).toContain(first.id);
    expect(second.id).not.toBe(first.id);
    const parsed = parseSummaryMarker(renderSummaryLineage(second));
    expect(parsed?.parents).toContain(first.id);
  });

  it('is deterministic: same slice, same lineage id', () => {
    expect(buildSummaryLineage(buriedHistory()).id).toBe(buildSummaryLineage(buriedHistory()).id);
  });

  it('compactSession renders caller-supplied lineage into the prompt', () => {
    const lineage = buildSummaryLineage(buriedHistory());
    const ctx = compactSession(
      [{ type: 'file:changed', path: 'src/payment.ts', operation: 'edit', agentId: 'a' } as never],
      { goal: 'fix payments', lineage },
    );
    expect(ctx.lineage?.id).toBe(lineage.id);
    expect(compactToPrompt(ctx)).toContain(`[summary ${lineage.id}`);
  });
});

// ── Integration: the real ContextEngine.compact() ────────────────────────────

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

describe('ContextEngine.compact verified compaction (C7 integration)', () => {
  it('probe catches a fact the heuristic ledger drops and escalation re-includes it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-c7-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      ctx.setGoal('Fix the payment retry bug so that failed charges are retried exactly once');
      ctx.addMessage({ role: 'user', content: 'Fix the payment retry bug so that failed charges are retried exactly once' });
      ctx.addMessage({ role: 'assistant', content: 'Investigating the payment module first.' });
      // A LONG tool output (>500 chars): compact()'s Session-facts path only
      // carries tool results under 500 chars, so the heuristic ledger drops
      // this buried error entirely — exactly the silent loss the probe is
      // for. The probe must catch it and escalation must restore it.
      const longTool = `${'compiling modules one after another, all quiet so far, no diagnostics.\n'.repeat(14)}src/payment.ts:88: error TS2345: Argument of type string is not assignable to parameter of type Charge.\n${'trailing build noise continues after the failure line above.\n'.repeat(3)}`;
      expect(longTool.length).toBeGreaterThan(500);
      ctx.addMessage({ role: 'tool', name: 'shell', content: longTool });
      fillers(ctx, 12);

      await ctx.compact();
      const v = ctx.lastCompactionVerification;
      expect(v).toBeTruthy();
      expect(v!.facts.map((f) => f.kind)).toContain('error');
      // The probe FAILED before escalation (the ledger alone lost the error)…
      expect(v!.initial.passed).toBe(false);
      expect(v!.initial.missing.map((f) => f.kind)).toContain('error');
      // …escalation ran…
      expect(v!.escalations).toContain('re-include');
      // …and the final state actually retains the fact.
      expect(v!.final.passed).toBe(true);
      expect(v!.passed).toBe(true);
      const flat = ctx.getMessages().map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      expect(flat).toContain('TS2345');
      expect(flat).toContain('RETENTION RECOVERY');
      expect(flat).toContain(`[summary ${v!.lineage.id}`);
      expect(flat).toContain('[compaction-probe:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('records a clean verification (no escalation, no recovery block) when nothing salient was dropped', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-c7-clean-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      for (let i = 0; i < 20; i++) ctx.addMessage({ role: 'user', content: `msg ${i}` });
      await ctx.compact();
      const v = ctx.lastCompactionVerification;
      expect(v).toBeTruthy();
      expect(v!.facts).toEqual([]);
      expect(v!.passed).toBe(true);
      expect(v!.escalations).toEqual([]);
      const flat = ctx.getMessages().map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      expect(flat).not.toContain('RETENTION RECOVERY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('second compaction chains lineage: its parents include the first summary id', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-c7-chain-'));
    try {
      const ctx = new ContextEngine(makeConfig(dir), dir);
      ctx.setGoal('Fix the payment retry bug so that failed charges are retried exactly once');
      ctx.addMessage({ role: 'user', content: 'Fix the payment retry bug so that failed charges are retried exactly once' });
      fillers(ctx, 12);
      await ctx.compact();
      const firstId = ctx.lastCompactionVerification!.lineage.id;
      expect(firstId).toMatch(/^sum-/);
      fillers(ctx, 12, 100);
      await ctx.compact();
      const second = ctx.lastCompactionVerification!;
      expect(second.lineage.id).not.toBe(firstId);
      expect(second.lineage.parents).toContain(firstId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
