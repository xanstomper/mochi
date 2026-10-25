// W3-5 productized subagent worktree isolation: the scoped helper that gives
// a child agent its own git worktree and GUARANTEES cleanup on exit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createChildWorktreeScope, withChildWorktreeScope } from './worktree-child.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-wtc-'));
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir });
  writeFileSync(resolve(dir, 'base.txt'), 'base');
  execSync('git add base.txt && git commit -q -m base', { cwd: dir });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function branchList(): string {
  return execSync('git branch --list "mochi/worktree/*" --format="%(refname:short)"', { cwd: dir, encoding: 'utf8' });
}

describe('createChildWorktreeScope', () => {
  it('gives a child an isolated worktree: edits never touch the parent tree', async () => {
    const scope = createChildWorktreeScope(dir, resolve(dir, '.mochi'));
    try {
      const wt = await scope.create('iso-child');
      expect(existsSync(resolve(wt.path, 'base.txt'))).toBe(true);
      writeFileSync(resolve(wt.path, 'child.txt'), 'worktree-only');
      expect(existsSync(resolve(dir, 'child.txt'))).toBe(false);
      expect(wt.branch.startsWith('mochi/worktree/')).toBe(true);
    } finally {
      await scope.dispose();
    }
  });

  it('dispose discards every non-kept worktree (dir + branch gone), keeps survive', async () => {
    const scope = createChildWorktreeScope(dir, resolve(dir, '.mochi'));
    const dropped = await scope.create('drop-me');
    const saved = await scope.create('keep-me');
    scope.keep(saved.id);
    const discarded = await scope.dispose();
    expect(discarded).toEqual([dropped.id]);
    expect(existsSync(dropped.path)).toBe(false);
    expect(branchList()).not.toContain(dropped.branch);
    // The kept one survives for parent review/apply.
    expect(existsSync(saved.path)).toBe(true);
    expect(branchList()).toContain(saved.branch);
    await scope.discard(saved.id); // explicit cleanup when the review is done
    expect(existsSync(saved.path)).toBe(false);
  });

  it('list() reports kept-status', async () => {
    const scope = createChildWorktreeScope(dir, resolve(dir, '.mochi'));
    try {
      const a = await scope.create('listed-a');
      const b = await scope.create('listed-b');
      scope.keep(b.id);
      const all = scope.list();
      expect(all.find((w) => w.id === a.id)?.kept).toBe(false);
      expect(all.find((w) => w.id === b.id)?.kept).toBe(true);
    } finally {
      await scope.dispose();
    }
  });
});

describe('withChildWorktreeScope', () => {
  it('cleanup runs on success: the body need not remember to dispose', async () => {
    const wt = await withChildWorktreeScope(dir, resolve(dir, '.mochi'), async (scope) => {
      const w = await scope.create('auto-cleanup');
      return w;
    });
    expect(existsSync(wt.path)).toBe(false);
    expect(branchList()).not.toContain(wt.branch);
  });

  it('cleanup runs on THROW, and the error still propagates', async () => {
    const wt = await withChildWorktreeScope(dir, resolve(dir, '.mochi'), async (scope) => {
      const w = await scope.create('throw-cleanup');
      throw new Error(`child exploded (${w.id})`);
    }).then(() => null, (e: Error) => e);
    expect(wt).toBeInstanceOf(Error);
    expect((wt as Error).message).toContain('child exploded');
    expect(branchList()).not.toContain('throw-cleanup');
    const orphanedDir = resolve(dir, '.mochi', 'worktrees');
    if (existsSync(orphanedDir)) {
      // At most the earlier describe's directories; nothing from this test.
      expect(execSync(`ls ${orphanedDir} | grep -c throw-cleanup || true`, { encoding: 'utf8' }).trim()).toBe('0');
    }
  });

  it('kept worktrees survive the scope exit, then discard explicitly (review/apply flow)', async () => {
    const scope = createChildWorktreeScope(dir, resolve(dir, '.mochi'));
    const wt = await scope.create('review-me');
    writeFileSync(resolve(wt.path, 'review.txt'), 'diff for parent');
    scope.keep(wt.id);
    await scope.dispose(); // scope exit: kept worktree untouched
    expect(existsSync(resolve(wt.path, 'review.txt'))).toBe(true);
    expect(branchList()).toContain(wt.branch);
    // Parent finished reviewing: explicit discard removes dir + branch.
    await scope.discard(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(branchList()).not.toContain(wt.branch);
  });
});
