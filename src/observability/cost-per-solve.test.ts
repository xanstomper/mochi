import { describe, it, expect } from 'vitest';
import { costPerSolveFromTrajectories, isSolvedRecord } from './cost-per-solve.js';
import type { TrajectoryRecord, TrajectoryUsage } from './trajectory.js';

function rec(runId: string, status: string | null, usage: TrajectoryUsage | null): TrajectoryRecord {
  return {
    schemaVersion: 1,
    runId,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    task: null,
    steps: [],
    skills: [],
    verification: status === null ? null : { status, verdict: status === 'PASS' || status === 'FLAKY-PASS' ? 'pass' : 'fail' },
    outcome: { completed: status === 'PASS' || status === 'FLAKY-PASS' },
    usage,
    failureTaxonomy: [],
  };
}

describe('costPerSolveFromTrajectories (C5)', () => {
  it('solved = PASS or FLAKY-PASS only; dollars split reported vs estimated', () => {
    const r = costPerSolveFromTrajectories([
      rec('a', 'PASS', { totalTokens: 100, costUsd: 0.5 }),
      rec('b', 'FLAKY-PASS', { totalTokens: 300, costUsd: 0, estimatedCostUsd: 0.25, costSource: 'estimated' }),
      rec('c', 'FAIL', { totalTokens: 900, costUsd: 9 }),
      rec('d', null, { totalTokens: 900, costUsd: 9 }),
      rec('e', 'BLOCKED', { totalTokens: 900, costUsd: 9 }),
    ]);
    expect(r.totalRuns).toBe(5);
    expect(r.solvedRuns).toBe(2);
    expect(r.reportedUsdPerSolve).toBeCloseTo(0.25, 10);
    expect(r.estimatedUsdPerSolve).toBeCloseTo(0.125, 10);
    expect(r.usdPerSolve).toBeCloseTo(0.375, 10);
    expect(r.tokensPerSolve).toBe(200);
    expect(r.complete).toBe(true);
    expect(r.unpricedRunIds).toEqual([]);
  });

  it('a solved run with tokens but no priced cost refuses the $ figure and names the run', () => {
    const r = costPerSolveFromTrajectories([
      rec('ok', 'PASS', { totalTokens: 100, costUsd: 0.5 }),
      // Tokens spent, neither provider cost nor estimate on the export.
      rec('mystery', 'PASS', { totalTokens: 400 }),
    ]);
    expect(r.usdPerSolve).toBeNull();
    expect(r.reportedUsdPerSolve).toBeNull();
    expect(r.estimatedUsdPerSolve).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.unpricedRunIds).toEqual(['mystery']);
    // Token coverage is a separate fact and still reported.
    expect(r.tokensPerSolve).toBe(250);
  });

  it('a solved run with no usage at all is unpriced too', () => {
    const r = costPerSolveFromTrajectories([rec('bare', 'PASS', null)]);
    expect(r.usdPerSolve).toBeNull();
    expect(r.unpricedRunIds).toEqual(['bare']);
    expect(r.tokensPerSolve).toBeNull();
  });

  it('a genuinely free solved run (estimate present at $0) prices fine', () => {
    const r = costPerSolveFromTrajectories([
      rec('free', 'PASS', { totalTokens: 50, costUsd: 0, estimatedCostUsd: 0, costSource: 'estimated' }),
    ]);
    expect(r.usdPerSolve).toBe(0);
    expect(r.complete).toBe(true);
  });

  it('nothing solved → nulls, never $0', () => {
    const r = costPerSolveFromTrajectories([rec('x', 'FAIL', { totalTokens: 10, costUsd: 1 })]);
    expect(r.solvedRuns).toBe(0);
    expect(r.usdPerSolve).toBeNull();
    expect(r.tokensPerSolve).toBeNull();
    expect(isSolvedRecord(rec('y', 'PARTIAL', null))).toBe(false);
  });
});
