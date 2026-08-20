// Baseline verification: pre-existing repo failures must not fail good work.
// Regression test for the "agent writes the file correctly, unrelated repo
// test debt then marks the task failed" class of bug (observed live: a
// trivial write task burned 47k tokens re-running the whole suite and was
// reported 'failed' because the repo already had a failing check).
import { describe, it, expect } from 'vitest';
import { failureSignature, matchesBaseline, type VerificationBaseline } from './verification.js';

function baseline(entries: Record<string, string>): VerificationBaseline {
  const signatures = new Map(Object.entries(entries));
  return { signatures, capturedAt: Date.now() };
}

describe('failureSignature', () => {
  it('extracts the failing lines and strips noise', () => {
    const out = [
      'RUN v2.1.0',
      '',
      '✓ src/a.test.ts',
      '❯ src/b.test.ts > thing',
      '  × expected 3 to be 4',
      '  1.23s',
      'Tests  1 failed | 40 passed',
    ].join('\n');
    const sig = failureSignature(out);
    expect(sig).toContain('expected 3 to be 4');
    expect(sig).not.toContain('1.23s');
    expect(sig).not.toContain('RUN v2.1.0');
  });

  it('normalizes line numbers so the same failure matches after edits elsewhere', () => {
    const before = failureSignature('src/b.test.ts:41:7 error: expected 3 to be 4');
    const after = failureSignature('src/b.test.ts:57:7 error: expected 3 to be 4');
    expect(before).toBe(after);
  });

  it('normalizes absolute paths', () => {
    const a = failureSignature('/home/user/proj/src/b.test.ts:12:1 Error: assert failed');
    const b = failureSignature('/tmp/other/proj/src/b.test.ts:12:1 Error: assert failed');
    expect(a).toBe(b);
  });
});

describe('matchesBaseline', () => {
  it('matches an identical post-work failure', () => {
    const bl = baseline({ 'npm test': failureSignature('src/b.test.ts:41:7 expected 3 to be 4') });
    const out = 'exit_code: 1\nsrc/b.test.ts:41:7 expected 3 to be 4';
    expect(matchesBaseline(bl, 'npm test', out)).toBe(true);
  });

  it('does not match when the failure is new', () => {
    const bl = baseline({ 'npm test': failureSignature('src/b.test.ts:41:7 expected 3 to be 4') });
    const out = 'exit_code: 1\nsrc/c.test.ts:9:1 expected "x" to be "y"';
    expect(matchesBaseline(bl, 'npm test', out)).toBe(false);
  });

  it('does not mask new failures when the check passed at baseline', () => {
    const bl = baseline({ 'npm test': '' });
    const out = 'exit_code: 1\nanything';
    expect(matchesBaseline(bl, 'npm test', out)).toBe(false);
  });

  it('returns false without a baseline', () => {
    expect(matchesBaseline(undefined, 'npm test', 'exit_code: 1')).toBe(false);
  });

  it('returns false for commands missing from the baseline', () => {
    const bl = baseline({ 'npm test': 'old' });
    expect(matchesBaseline(bl, 'cargo test', 'exit_code: 1\ncargo failure')).toBe(false);
  });
});
