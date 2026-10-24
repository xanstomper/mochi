import { describe, it, expect } from 'vitest';
import { aggregateReviews } from './subagent-runtime.js';
import type { ChildRunResult } from './subagent-runtime.js';

function reviewResult(over: Partial<ChildRunResult> = {}): ChildRunResult {
  return {
    status: 'done',
    summary: 'ok',
    findings: [],
    artifacts: [],
    usage: { tokens: 1, toolCalls: 1, durationMs: 1 },
    ...over,
  };
}

describe('fleet dedup line bucketing', () => {
  it('merges the same finding cited a few lines apart by different lenses', () => {
    const agg = aggregateReviews([
      { lens: 'correctness', result: reviewResult({ verdict: 'comment', findings: [{ severity: 'high', file: 'src/a.ts', line: 88, message: 'Race condition on cache write' }] }) },
      { lens: 'security', result: reviewResult({ verdict: 'comment', findings: [{ severity: 'high', file: 'src/a.ts', line: 91, message: 'Race condition on cache write' }] }) },
    ]);
    expect(agg.findings).toHaveLength(1);
    expect(agg.duplicatesMerged).toBe(1);
  });

  it('does not merge distinct defects in far-apart regions of the same file', () => {
    const agg = aggregateReviews([
      { lens: 'correctness', result: reviewResult({ findings: [{ severity: 'high', file: 'src/a.ts', line: 88, message: 'Race condition on cache write' }] }) },
      { lens: 'security', result: reviewResult({ findings: [{ severity: 'high', file: 'src/a.ts', line: 160, message: 'Race condition on cache write' }] }) },
    ]);
    expect(agg.findings).toHaveLength(2);
    expect(agg.duplicatesMerged).toBe(0);
  });
});

describe('failed reviewer demotion', () => {
  it('a failed lens blocks the approve verdict — partial review is never a pass', () => {
    const agg = aggregateReviews(
      [
        { lens: 'correctness', result: reviewResult({ verdict: 'approve' }) },
        { lens: 'tests', result: reviewResult({ verdict: 'approve' }) },
      ],
      { failedLenses: ['security'] },
    );
    expect(agg.verdict).toBe('comment');
    expect(agg.failedLenses).toEqual(['security']);
  });

  it('request-changes still wins even when a lens failed', () => {
    const agg = aggregateReviews(
      [
        { lens: 'correctness', result: reviewResult({ verdict: 'request-changes' }) },
      ],
      { failedLenses: ['security', 'tests'] },
    );
    expect(agg.verdict).toBe('request-changes');
  });

  it('a full fleet with no failures approves as before', () => {
    const agg = aggregateReviews(
      [
        { lens: 'correctness', result: reviewResult({ verdict: 'approve' }) },
        { lens: 'security', result: reviewResult({ verdict: 'approve' }) },
      ],
    );
    expect(agg.verdict).toBe('approve');
    expect(agg.failedLenses).toEqual([]);
  });
});
