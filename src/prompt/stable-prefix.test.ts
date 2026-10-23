import { describe, it, expect } from 'vitest';
import { lintStablePrefix, cacheHitRatio, firstChangedSegment } from './stable-prefix.js';

describe('lintStablePrefix (P5)', () => {
  it('passes a genuinely stable text', () => {
    const text = [
      'You are Mochi, an autonomous coding agent.',
      'Workspace: /home/dev/project',
      'Memory: 7.7 GB total',
      'Node.js available: v22.1.0',
    ].join('\n');
    expect(lintStablePrefix(text)).toEqual([]);
  });

  it('catches deliberately injected volatile fields', () => {
    const poisoned = [
      'You are Mochi, an autonomous coding agent.',
      'Generated at 2026-10-22T08:15:30Z',
      'Build date: 2026-10-22',
      'Started 08:15:30 sharp',
      'Run id: 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'Epoch checkpoint 1761182130000',
      'Memory: 3.2 GB free / 7.7 GB total',
    ].join('\n');
    const joined = lintStablePrefix(poisoned).join('\n');
    expect(joined).toContain('ISO-8601 datetime');
    expect(joined).toContain('calendar date (YYYY-MM-DD)');
    expect(joined).toContain('wall-clock time (HH:MM:SS)');
    expect(joined).toContain('UUID');
    expect(joined).toContain('epoch milliseconds');
    expect(joined).toContain('live free-memory figure');
  });
});

describe('cacheHitRatio (P5)', () => {
  it('computes the ratio over measured calls only', () => {
    const r = cacheHitRatio([
      { promptTokens: 1000, cachedTokens: 800 },
      { promptTokens: 500 },                     // unmeasured — excluded
      { promptTokens: 2000, cachedTokens: 0 },   // measured miss — counted
    ]);
    expect(r.measuredCalls).toBe(2);
    expect(r.promptTokens).toBe(3000);
    expect(r.cachedTokens).toBe(800);
    expect(r.ratio).toBeCloseTo(800 / 3000, 10);
  });

  it('a measured all-miss run reports ratio 0, not UNMEASURED', () => {
    const r = cacheHitRatio([{ promptTokens: 100, cachedTokens: 0 }]);
    expect(r.measuredCalls).toBe(1);
    expect(r.ratio).toBe(0);
  });

  it('no measured calls → null ratio (UNMEASURED), never a fabricated 0', () => {
    const r = cacheHitRatio([{ promptTokens: 100 }, { promptTokens: 50, cachedTokens: undefined }]);
    expect(r.measuredCalls).toBe(0);
    expect(r.ratio).toBeNull();
    expect(cacheHitRatio([]).ratio).toBeNull();
  });
});

describe('firstChangedSegment (P5)', () => {
  const seg = (name: string, hash: string) => ({ name, hash });
  it('names the first segment whose hash moved', () => {
    const prev = [seg('core', 'a'), seg('repo', 'b'), seg('memory', 'c')];
    const next = [seg('core', 'a'), seg('repo', 'b'), seg('memory', 'Z')];
    expect(firstChangedSegment(prev, next)).toBe('memory');
  });
  it('null when byte-equivalent; reports an appended segment by name', () => {
    const prev = [seg('core', 'a')];
    expect(firstChangedSegment(prev, [seg('core', 'a')])).toBeNull();
    expect(firstChangedSegment(prev, [seg('core', 'a'), seg('feedback', 'x')])).toBe('feedback');
  });
});
