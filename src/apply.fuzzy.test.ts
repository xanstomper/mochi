import { describe, it, expect } from 'vitest';
import { applyHunks, applyDiffAtomically } from './apply.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('applyHunks (aider fuzzy ladder)', () => {
  it('applies exact-match hunks unchanged', () => {
    const out = applyHunks('a\nb\nc\n', ['@@ -2,1 +2,1 @@', '-b', '+B']);
    expect(out).toBe('a\nB\nc\n');
  });

  it('recovers from trailing-whitespace drift via the trim-end retry', () => {
    const file = 'function f() {\n  return 1;   \n}\n';
    // Diff remembers the line WITHOUT trailing spaces; old code hard-failed.
    const out = applyHunks(file, ['@@ -2,1 +2,1 @@', '-  return 1;', '+  return 2;']);
    expect(out).toBe('function f() {\n  return 2;\n}\n');
  });

  it('relocates a hunk when the file drifted from the diff line numbers', () => {
    const file = 'x\ny\nz\na\nb\nc\n';
    // Diff says lines 1-3, but the a/b/c block now sits at lines 4-6.
    const out = applyHunks(file, ['@@ -1,3 +1,3 @@', '-a', '-b', '-c', '+A', '+B', '+C']);
    expect(out).toBe('x\ny\nz\nA\nB\nC\n');
  });

  it('still fails when the context truly cannot be found', () => {
    expect(applyHunks('a\nb\n', ['@@ -1,1 +1,1 @@', '-nope', '+x'])).toBeNull();
  });
});

describe('applyDiffAtomically fuzzy path (end to end)', () => {
  it('applies a drifted unified diff to a real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-apply-fuzzy-'));
    try {
      const p = join(dir, 't.txt');
      writeFileSync(p, 'one\ntwo  \nthree\n');
      const diff = [
        'diff --git a/t.txt b/t.txt',
        '--- a/t.txt',
        '+++ b/t.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '',
      ].join('\n');
      const res = applyDiffAtomically(dir, diff);
      expect(res.applied).toContain('t.txt');
      expect(readFileSync(p, 'utf8')).toBe('one\nTWO\nthree\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
