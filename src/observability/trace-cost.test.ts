import { describe, it, expect } from 'vitest';
import { costFromTraceEntries, costPerSolveFromTraces } from './trace-cost.js';

// gpt-4o at $2.50 in / $10 out / $1.25 cache-read per 1M. The flat
// usage:updated convention: inputTokens is non-cached, cache bills on top:
// 800k*2.5 + 200k*1.25 + 100k*10 = 2.00 + 0.25 + 1.00 = $3.25.
const zeroCostCall = {
  t: 1, kind: 'usage:updated', model: 'gpt-4o',
  inputTokens: 800_000, outputTokens: 100_000, cacheTokens: 200_000, totalTokens: 1_100_000, costUsd: 0,
};

describe('costFromTraceEntries (C5)', () => {
  it('a trace with token counts but $0 provider cost yields a nonzero table estimate', () => {
    const s = costFromTraceEntries([zeroCostCall]);
    expect(s.providerCostUsd).toBe(0);
    expect(s.estimatedCostUsd).toBeCloseTo(3.25, 8);
    expect(s.effectiveCostUsd).toBeCloseTo(3.25, 8);
    expect(s.costSource).toBe('estimated');
    expect(s.complete).toBe(true);
    expect(s.tokens).toBe(1_100_000);
  });

  it('provider-reported cost wins when nonzero; the table is not consulted', () => {
    const s = costFromTraceEntries([{ ...zeroCostCall, costUsd: 0.5 }]);
    expect(s.providerCostUsd).toBeCloseTo(0.5, 8);
    expect(s.estimatedCostUsd).toBe(0);
    expect(s.effectiveCostUsd).toBeCloseTo(0.5, 8);
    expect(s.costSource).toBe('provider');
  });

  it('an explicit price override changes the trace estimate', () => {
    const s = costFromTraceEntries([zeroCostCall], { 'gpt-4o': { output: 20 } });
    // 2.00 + 0.25 + 100k*20/1M=2.00 → 4.25
    expect(s.estimatedCostUsd).toBeCloseTo(4.25, 8);
  });

  it('nested provider usage objects are priced with the includes-cache convention', () => {
    const s = costFromTraceEntries([
      { t: 1, kind: 'agent:iteration', model: 'gpt-4o', usage: { promptTokens: 1_000_000, completionTokens: 100_000, cachedTokens: 200_000, totalTokens: 1_100_000 } },
    ]);
    expect(s.estimatedCostUsd).toBeCloseTo(3.25, 8);
    expect(s.complete).toBe(true);
  });

  it('a $0 call with no model id is unpriced: effective cost is null, never a partial sum', () => {
    const { model: _m, ...noModel } = zeroCostCall;
    const s = costFromTraceEntries([noModel, { ...zeroCostCall, t: 2 }]);
    expect(s.unpricedCalls).toBe(1);
    expect(s.complete).toBe(false);
    expect(s.effectiveCostUsd).toBeNull();
  });

  it('no usage at all → tokens and cost unknown', () => {
    const s = costFromTraceEntries([{ t: 1, kind: 'agent:log', message: 'hi' }]);
    expect(s.tokens).toBeNull();
    expect(s.effectiveCostUsd).toBeNull();
    expect(s.costSource).toBe('none');
  });
});

describe('costPerSolveFromTraces (C5)', () => {
  it('averages effective cost over solved runs only', () => {
    const r = costPerSolveFromTraces([
      { entries: [zeroCostCall], solved: true },
      { entries: [zeroCostCall], solved: true },
      { entries: [zeroCostCall, zeroCostCall], solved: false },
    ]);
    expect(r.solvedRuns).toBe(2);
    expect(r.usdPerSolve).toBeCloseTo(3.25, 8);
    expect(r.tokensPerSolve).toBe(1_100_000);
  });

  it('is null when a solved run has unpriceable usage, or nothing was solved', () => {
    const { model: _m, ...noModel } = zeroCostCall;
    expect(costPerSolveFromTraces([{ entries: [noModel], solved: true }]).usdPerSolve).toBeNull();
    expect(costPerSolveFromTraces([{ entries: [zeroCostCall], solved: false }]).usdPerSolve).toBeNull();
  });
});
