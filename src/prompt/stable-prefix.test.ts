import { describe, it, expect } from 'vitest';
import { cacheHitRatio, firstChangedSegment, sha256Hex } from './stable-prefix.js';

describe('stable-prefix accounting (P5)', () => {
  it('hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('attributes the FIRST changed segment', () => {
    const prev = [
      { name: 'core', hash: 'a' },
      { name: 'rules', hash: 'b' },
      { name: 'repo', hash: 'c' },
    ];
    expect(firstChangedSegment(prev, prev)).toBeNull();
    expect(firstChangedSegment(prev, [
      { name: 'core', hash: 'a' },
      { name: 'rules', hash: 'X' },
      { name: 'repo', hash: 'X' },
    ])).toBe('rules');
    // A disappearing segment is attributed to that segment.
    expect(firstChangedSegment(prev, [
      { name: 'core', hash: 'a' },
      { name: 'repo', hash: 'c' },
    ])).toBe('rules');
  });

  it('cache ratio counts ONLY measured calls — silence is not a 0% hit', () => {
    const r = cacheHitRatio([
      { promptTokens: 1000, cachedTokens: 800 },
      { promptTokens: 1000, cachedTokens: 200 },
      { promptTokens: 500 }, // unmeasured
    ]);
    expect(r.measuredCalls).toBe(2);
    expect(r.promptTokens).toBe(2000);
    expect(r.cachedTokens).toBe(1000);
    expect(r.ratio).toBeCloseTo(0.5, 10);
  });

  it('no measured calls → ratio null, never fabricated', () => {
    const r = cacheHitRatio([{ promptTokens: 1000 }, { promptTokens: 0, cachedTokens: 10 }]);
    expect(r.measuredCalls).toBe(0);
    expect(r.ratio).toBeNull();
  });

  it('clamps impossible cached > prompt figures', () => {
    const r = cacheHitRatio([{ promptTokens: 100, cachedTokens: 500 }]);
    expect(r.cachedTokens).toBe(100);
    expect(r.ratio).toBe(1);
  });
});
