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

describe('cache-hit ratio (P5)', () => {
  it('flat entries stamped cacheMeasured fold into a ratio over measured calls', () => {
    const s = costFromTraceEntries([
      { t: 1, kind: 'usage:updated', model: 'gpt-4o', inputTokens: 700, outputTokens: 10, cacheTokens: 300, totalTokens: 1010, costUsd: 0.01, cacheMeasured: true },
      { t: 2, kind: 'usage:updated', model: 'gpt-4o', inputTokens: 1000, outputTokens: 10, cacheTokens: 0, totalTokens: 1010, costUsd: 0.01, cacheMeasured: true },
      { t: 3, kind: 'usage:updated', model: 'gpt-4o', inputTokens: 500, outputTokens: 10, cacheTokens: 0, totalTokens: 510, costUsd: 0.01, cacheMeasured: false },
    ]);
    expect(s.cacheMeasured).toBe(true);
    expect(s.cacheReadTokens).toBe(300);
    expect(s.inputTokens).toBe(2500);
    // Measured calls only: 300 / (1000 + 1000) — the unmeasured call is excluded.
    expect(s.cacheHitRatio).toBeCloseTo(300 / 2000, 10);
  });

  it('no provider cache data anywhere → UNMEASURED (null), never a fabricated 0', () => {
    const s = costFromTraceEntries([
      { t: 1, kind: 'usage:updated', model: 'gpt-4o', inputTokens: 100, outputTokens: 5, cacheTokens: 0, totalTokens: 105, costUsd: 0.01 },
    ]);
    expect(s.cacheMeasured).toBe(false);
    expect(s.cacheHitRatio).toBeNull();
    expect(s.cacheReadTokens).toBe(0);
  });

  it('nested usage with cachedTokens counts as measured (includes-cache convention)', () => {
    const s = costFromTraceEntries([
      { t: 1, kind: 'agent:iteration', model: 'gpt-4o', usage: { promptTokens: 1000, completionTokens: 10, cachedTokens: 250, totalTokens: 1010 } },
    ]);
    expect(s.cacheMeasured).toBe(true);
    expect(s.cacheHitRatio).toBeCloseTo(0.25, 10);
    expect(s.inputTokens).toBe(1000);
  });

  it('legacy flat entries with positive cacheTokens count as measured', () => {
    const s = costFromTraceEntries([zeroCostCall]);
    expect(s.cacheMeasured).toBe(true);
    expect(s.cacheHitRatio).toBeCloseTo(200_000 / 1_000_000, 10);
  });
});
