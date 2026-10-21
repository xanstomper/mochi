import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync as realWriteFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseUnifiedDiff, applyHunks, applyDiffAtomically } from './apply.js';

describe('parseUnifiedDiff', () => {
  it('parses create/update/delete ops', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1;',
      '+export const b = 2;',
      'diff --git a/mod.ts b/mod.ts',
      '--- a/mod.ts',
      '+++ b/mod.ts',
      '@@ -1,1 +1,1 @@',
      '-old line',
      '+new line',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n');
    const ops = parseUnifiedDiff(diff);
    expect(ops.map((o) => [o.path, o.op])).toEqual([
      ['new.ts', 'create'],
      ['mod.ts', 'update'],
      ['gone.ts', 'delete'],
    ]);
  });

  it('rejects unsafe paths', () => {
    const diff = [
      'diff --git a/../evil b/../evil',
      '--- a/../evil',
      '+++ b/../evil',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(() => parseUnifiedDiff(diff)).toThrow(/Unsafe path/);
  });

  it('strips tab-attached timestamps from ---/+++ headers (plain diff -u output, B14)', () => {
    // GNU diff -u writes "+++ b/new.ts\t2024-01-01 10:00:00.000000000 +0000".
    // The old parser kept the timestamp in the path: create ops wrote junk
    // files literally named "new.ts\t2024-01-01..." and update ops never
    // matched the real file.
    const diff = [
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null\t2024-01-01 10:00:00.000000000 +0000',
      '+++ b/new.ts\t2024-01-01 10:00:00.000000000 +0000',
      '@@ -0,0 +1,1 @@',
      '+export const a = 1;',
      'diff --git a/mod.ts b/mod.ts',
      '--- a/mod.ts\t2024-01-01 09:00:00.000000000 +0000',
      '+++ b/mod.ts\t2024-01-01 10:00:00.000000000 +0000',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const ops = parseUnifiedDiff(diff);
    expect(ops.map((o) => [o.path, o.op])).toEqual([
      ['new.ts', 'create'],
      ['mod.ts', 'update'],
    ]);
  });

  it('rejects absolute paths in the diff (B14)', () => {
    const diff = [
      'diff --git /etc/evil /etc/evil',
      '--- /etc/evil',
      '+++ /etc/evil',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(() => parseUnifiedDiff(diff)).toThrow(/Unsafe path/);
  });

  it('re-roots absolute paths that resolve INSIDE the given root (B14 restructure)', () => {
    // External tooling legitimately emits absolute-path diffs. With a root,
    // in-workspace absolute paths are re-rooted to workspace-relative and
    // applied; only ESCAPING paths are rejected.
    const root = '/tmp/b14root';
    const diff = [
      `diff --git ${root}/src/a.ts ${root}/src/a.ts`,
      `--- ${root}/src/a.ts`,
      `+++ ${root}/src/a.ts`,
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const ops = parseUnifiedDiff(diff, root);
    expect(ops.map((o) => [o.path, o.op])).toEqual([['src/a.ts', 'update']]);
  });

  it('still rejects absolute paths that ESCAPE the given root (B14 restructure)', () => {
    const root = '/tmp/b14root';
    const diff = [
      'diff --git /etc/evil /etc/evil',
      '--- /etc/evil',
      '+++ /etc/evil',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(() => parseUnifiedDiff(diff, root)).toThrow(/escapes workspace root/);
  });

  it('applyDiffAtomically applies an in-root absolute-path diff end-to-end', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mochi-b14apply-'));
    try {
      const target = resolve(root, 'abs.ts');
      realWriteFileSync(target, 'old\n', 'utf8');
      const diff = [
        `diff --git ${target} ${target}`,
        `--- ${target}`,
        `+++ ${target}`,
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
      ].join('\n');
      const res = applyDiffAtomically(root, diff);
      expect(res.applied).toContain('abs.ts');
      expect(readFileSync(target, 'utf8')).toBe('new\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('applyHunks', () => {
  it('applies a simple replacement', () => {
    expect(applyHunks('a\nb\nc', ['@@ -2,1 +2,1 @@', '-b', '+B'])).toBe('a\nB\nc');
  });
  it('returns null on context mismatch', () => {
    expect(applyHunks('x\ny', ['@@ -2,1 +2,1 @@', '-zzz', '+q'])).toBeNull();
  });
  it('inserts into empty file for create ops', () => {
    expect(applyHunks('', ['@@ -0,0 +1,1 @@', '+hello'])).toBe('hello');
  });
});

describe('applyDiffAtomically', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mochi-apply-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const diffFor = (updateFrom: string, updateTo: string, createTo = 'new file\n') => [
    'diff --git a/mod.txt b/mod.txt',
    '--- a/mod.txt',
    '+++ b/mod.txt',
    '@@ -1,1 +1,1 @@',
    `-${updateFrom}`,
    `+${updateTo}`,
    'diff --git a/added.txt b/added.txt',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@ -0,0 +1,1 @@',
    `+${createTo.trimEnd()}`,
  ].join('\n');

  it('applies all files', () => {
    realWriteFileSync(join(dir, 'mod.txt'), 'old line\n');
    const res = applyDiffAtomically(dir, diffFor('old line', 'new line'));
    expect(res.applied).toEqual(['mod.txt', 'added.txt']);
    expect(res.created).toEqual(['added.txt']);
    expect(readFileSync(join(dir, 'mod.txt'), 'utf8')).toBe('new line\n');
    expect(readFileSync(join(dir, 'added.txt'), 'utf8')).toBe('new file');
  });

  it('rolls back everything when a later hunk fails', () => {
    realWriteFileSync(join(dir, 'mod.txt'), 'drifted content\n');
    const diff = [
      'diff --git a/mod.txt b/mod.txt',
      '--- a/mod.txt',
      '+++ b/mod.txt',
      '@@ -1,1 +1,1 @@',
      '-old line',   // no longer matches -> should abort
      '+new line',
    ].join('\n');
    expect(() => applyDiffAtomically(dir, diff)).toThrow(/context mismatch/i);
    // Untouched because nothing was written before the failure.
    expect(readFileSync(join(dir, 'mod.txt'), 'utf8')).toBe('drifted content\n');
  });

  it('rolls back earlier successful writes when a later file fails', () => {
    realWriteFileSync(join(dir, 'a.txt'), 'aaa\n');
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-aaa',
      '+AAA',
      'diff --git a/missing.txt b/missing.txt',
      '--- a/missing.txt',
      '+++ b/missing.txt',
      '@@ -1,1 +1,1 @@',
      '-zzz',
      '+zzz!',
    ].join('\n');
    expect(() => applyDiffAtomically(dir, diff)).toThrow(/missing file/i);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('aaa\n'); // restored
    expect(existsSync(join(dir, 'missing.txt'))).toBe(false);
  });

  it('deletes files', () => {
    realWriteFileSync(join(dir, 'del.txt'), 'bye\n');
    const diff = [
      'diff --git a/del.txt b/del.txt',
      '--- a/del.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n');
    const res = applyDiffAtomically(dir, diff);
    expect(res.deleted).toEqual(['del.txt']);
    expect(existsSync(join(dir, 'del.txt'))).toBe(false);
  });
});
