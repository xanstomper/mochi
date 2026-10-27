// Finish-summary hygiene + run-digest honesty (Ben 2026-10-26: a task that
// gets done must not read as failed, and the summary must not be sloppy).
import { describe, it, expect } from 'vitest';
import { cleanFinishSummary, buildRunDigest } from './loop.js';

describe('cleanFinishSummary', () => {
  it('strips think blocks', () => {
    const out = cleanFinishSummary('Hello <think>secret reasoning</think> world');
    expect(out).not.toContain('<think>');
    expect(out).not.toContain('secret reasoning');
    expect(out).toContain('Hello');
    expect(out).toContain('world');
  });

  it('strips ANSI escapes', () => {
    const out = cleanFinishSummary('\x1b[31mred\x1b[0m text');
    expect(out).not.toContain('\x1b');
    expect(out).toContain('red text');
  });

  it('trims and collapses blank runs', () => {
    expect(cleanFinishSummary('  hi\n\n\n\nbye  ')).toBe('hi\n\nbye');
  });

  it('leaves clean text alone', () => {
    expect(cleanFinishSummary('Done. Fixed add().\n\nTests pass.')).toBe('Done. Fixed add().\n\nTests pass.');
  });
});

describe('buildRunDigest', () => {
  it('omits errors on success (they were overcome, not the outcome)', () => {
    expect(buildRunDigest(['a.ts'], ['b.ts'], ['boom'], true)).toBe(
      '[run-digest] changed=[a.ts] | read=[b.ts]',
    );
  });

  it('includes errors on failure', () => {
    expect(buildRunDigest(['a.ts'], [], ['boom'], false)).toBe(
      '[run-digest] changed=[a.ts] | errors=[boom]',
    );
  });

  it('returns undefined when nothing remains', () => {
    expect(buildRunDigest([], [], [], true)).toBeUndefined();
    expect(buildRunDigest([], [], ['x'], true)).toBeUndefined();
  });

  it('caps the error text at 300 chars on failure', () => {
    const out = buildRunDigest([], [], ['e'.repeat(500)], false)!;
    expect(out.startsWith('[run-digest] errors=[')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(800);
  });
});
