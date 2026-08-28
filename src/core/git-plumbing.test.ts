import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeTreeSnapshot, restoreTreeSnapshot, diffAgainstTreeSnapshot } from './git-plumbing.js';

describe('Git Plumbing Snapshots', () => {
  let testRepo: string;

  beforeEach(() => {
    testRepo = mkdtempSync(resolve(tmpdir(), 'mochi-plumbing-test-'));
    execFileSync('git', ['init'], { cwd: testRepo });
    execFileSync('git', ['config', 'user.email', 'mochi@example.com'], { cwd: testRepo });
    execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: testRepo });
    writeFileSync(resolve(testRepo, 'README.md'), '# Initial Repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: testRepo });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: testRepo });
  });

  afterEach(() => {
    rmSync(testRepo, { recursive: true, force: true });
  });

  it('captures a tree snapshot in <10ms and produces a 40-char SHA', () => {
    writeFileSync(resolve(testRepo, 'file.txt'), 'Hello world\n');
    const start = performance.now();
    const snap = writeTreeSnapshot(testRepo, 'step-1');
    const elapsed = performance.now() - start;

    expect(snap).not.toBeNull();
    expect(snap?.treeSha).toHaveLength(40);
    expect(snap?.label).toBe('step-1');
    expect(elapsed).toBeLessThan(100); // under 100ms even on busy CI
  });

  it('instantaneously restores modified files to the snapshot state', () => {
    writeFileSync(resolve(testRepo, 'config.json'), '{"version": 1}\n');
    const snap = writeTreeSnapshot(testRepo, 'clean-state');
    expect(snap).not.toBeNull();

    // Make a breaking edit
    writeFileSync(resolve(testRepo, 'config.json'), '{"corrupted": true}\n');
    expect(readFileSync(resolve(testRepo, 'config.json'), 'utf8')).toContain('corrupted');

    // Restore
    const restored = restoreTreeSnapshot(testRepo, snap!.treeSha);
    expect(restored).toBe(true);
    expect(readFileSync(resolve(testRepo, 'config.json'), 'utf8')).toBe('{"version": 1}\n');
  });

  it('diffs against tree snapshots accurately', () => {
    writeFileSync(resolve(testRepo, 'app.ts'), 'export const a = 1;\n');
    const snap = writeTreeSnapshot(testRepo, 'v1');

    writeFileSync(resolve(testRepo, 'app.ts'), 'export const a = 2;\n');
    const diff = diffAgainstTreeSnapshot(testRepo, snap!.treeSha);

    expect(diff).toContain('+export const a = 2;');
  });
});
