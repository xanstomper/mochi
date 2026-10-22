// worktree.ts: ephemeral git worktree manager for parallel agents.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { WorktreeManager } from './worktree.js';

let dir: string;
let manager: WorktreeManager;
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-wt-'));
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir });
  writeFileSync(resolve(dir, 'a.txt'), 'base');
  execSync('git add a.txt && git commit -q -m a', { cwd: dir });
  manager = new WorktreeManager(dir, resolve(dir, '.mochi'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('WorktreeManager', () => {
  it('creates an isolated worktree with its own branch and path', async () => {
    const wt = await manager.create('fix-x');
    expect(wt.branch).toMatch(/fix-x/);
    expect(existsSync(resolve(wt.path, 'a.txt'))).toBe(true);
  });

  it('isolates edits: main tree unchanged, worktree sees its own change', async () => {
    const wt = await manager.create('iso-work');
    writeFileSync(resolve(wt.path, 'iso.txt'), 'worktree-only');
    expect(existsSync(resolve(dir, 'iso.txt'))).toBe(false); // main tree clean
    expect(existsSync(resolve(wt.path, 'iso.txt'))).toBe(true);
  });

  it('removes a worktree', async () => {
    const wt = await manager.create('remove-me');
    expect(existsSync(wt.path)).toBe(true);
    await manager.discard(wt.id);
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe('WorktreeManager.reapOrphans', () => {
  let repo: string;
  const repos: string[] = [];

  function freshRepo(): string {
    repo = mkdtempSync(resolve(tmpdir(), 'mochi-wt-reap-'));
    repos.push(repo);
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
    writeFileSync(resolve(repo, 'a.txt'), 'base');
    execSync('git add a.txt && git commit -q -m init', { cwd: repo });
    return repo;
  }

  function branchList(cwd: string): string {
    return execSync('git branch --list "mochi/worktree/*" --format="%(refname:short)"', { cwd, encoding: 'utf8' });
  }

  function backdate(path: string, msAgo: number): void {
    const t = new Date(Date.now() - msAgo);
    utimesSync(path, t, t);
  }

  afterEach(() => {
    while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('reaps a worktree orphaned by a crashed process (dir + branch gone)', async () => {
    const cwd = freshRepo();
    // Process 1 creates a worktree, then "crashes" — no discard.
    const crashed = new WorktreeManager(cwd, resolve(cwd, '.mochi'));
    const wt = await crashed.create('crash-victim');
    expect(existsSync(wt.path)).toBe(true);
    expect(branchList(cwd)).toContain(wt.branch);

    // It sat untouched for >24h before anyone noticed.
    backdate(wt.path, 48 * 60 * 60 * 1000);

    // Process 2: a fresh manager with an EMPTY registry over the same repo.
    const survivor = new WorktreeManager(cwd, resolve(cwd, '.mochi'));
    const result = await survivor.reapOrphans();

    expect(result.removedDirs).toContain(wt.path);
    expect(result.removedBranches).toContain(wt.branch);
    expect(existsSync(wt.path)).toBe(false);
    expect(branchList(cwd)).not.toContain(wt.branch);
  });

  it('never reaps a worktree registered in the calling manager, even when old / maxAgeMs 0', async () => {
    const cwd = freshRepo();
    const mgr = new WorktreeManager(cwd, resolve(cwd, '.mochi'));
    const wt = await mgr.create('still-mine');
    backdate(wt.path, 72 * 60 * 60 * 1000);

    const result = await mgr.reapOrphans({ maxAgeMs: 0 });

    expect(result.removedDirs).not.toContain(wt.path);
    expect(result.removedBranches).not.toContain(wt.branch);
    expect(existsSync(wt.path)).toBe(true);
    expect(branchList(cwd)).toContain(wt.branch);
    await mgr.discard(wt.id);
  });

  it('does not reap a fresh unregistered worktree under the default age rule', async () => {
    const cwd = freshRepo();
    const other = new WorktreeManager(cwd, resolve(cwd, '.mochi'));
    const wt = await other.create('fresh-work');
    // A different manager (empty registry) reaps with the default 24h rule:
    // the worktree is unregistered there but brand-new, so it must survive.
    const mgr = new WorktreeManager(cwd, resolve(cwd, '.mochi'));
    const result = await mgr.reapOrphans();
    expect(result.removedDirs).not.toContain(wt.path);
    expect(existsSync(wt.path)).toBe(true);
    await other.discard(wt.id);
  });

  it('reaps an orphan branch with no worktree when maxAgeMs is 0', async () => {
    const cwd = freshRepo();
    execSync('git branch mochi/worktree/lonely-1234abcd', { cwd });
    const mgr = new WorktreeManager(cwd, resolve(cwd, '.mochi'));
    const result = await mgr.reapOrphans({ maxAgeMs: 0 });
    expect(result.removedBranches).toContain('mochi/worktree/lonely-1234abcd');
    expect(branchList(cwd)).not.toContain('lonely-1234abcd');
  });

  it('returns empty on a clean repo and does not throw', async () => {
    const cwd = freshRepo();
    const mgr = new WorktreeManager(cwd, resolve(cwd, '.mochi'));
    await expect(mgr.reapOrphans()).resolves.toEqual({ removedDirs: [], removedBranches: [] });
    await expect(mgr.reapOrphans({ maxAgeMs: 0 })).resolves.toEqual({ removedDirs: [], removedBranches: [] });
  });
});