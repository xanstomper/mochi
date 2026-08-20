// worktree.ts: ephemeral git worktree manager for parallel agents.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
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