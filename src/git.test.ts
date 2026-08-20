// git.ts: checkpoint / rollback safety layer (agent rollback path).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  isRepo, status, checkpoint, restore, preEditSnapshot, rollbackToSnapshot, type CheckpointResult,
} from './git.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function makeRepo(): string {
  const d = mkdtempSync(resolve(tmpdir(), 'mochi-git-'));
  dirs.push(d);
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: d });
  return d;
}

function dirty(cwd: string): boolean {
  return Boolean(execSync('git status --short', { cwd, encoding: 'utf-8' }).trim());
}

describe('isRepo/status', () => {
  it('detects a repo and reports dirty state', async () => {
    const d = makeRepo();
    expect(await isRepo(d)).toBe(true);
    expect((await status(d)).trim()).toBe('');
    writeFileSync(resolve(d, 'a.txt'), 'x');
    expect((await status(d)).trim()).toMatch(/a\.txt/);
  });
});

describe('checkpoint/restore', () => {
  it('creates an empty commit on a clean tree and restores it', async () => {
    const d = makeRepo();
    const cp = await checkpoint(d, 'test checkpoint');
    expect(cp.type).toBe('commit');
    expect(cp.ref).toBeTruthy();
    // dirty a TRACKED file, then restore the clean checkpoint
    const tracked = resolve(d, 'tracked.txt');
    writeFileSync(tracked, 'base');
    execSync('git add tracked.txt && git commit -q -m tracked', { cwd: d });
    writeFileSync(tracked, 'modified');
    const out = await restore(d, cp);
    expect(out).toContain('Restored to commit');
    // restore() reset --hard to cp.ref (the empty-commit checkpoint, which
    // predates the tracked.txt commit), so the file is removed entirely.
    expect(existsSync(tracked)).toBe(false);
  });

  it('stashes dirty work and pops it back', async () => {
    const d = makeRepo();
    writeFileSync(resolve(d, 'wip.txt'), 'wip');
    const cp = await checkpoint(d, 'stash checkpoint');
    expect(cp.type).toBe('stash');
    // working tree is clean after stashing
    expect(await dirty(d)).toBe(false);
    const out = await restore(d, cp);
    expect(out).toMatch(/Restored stash/);
    expect(readFileSync(resolve(d, 'wip.txt'), 'utf8')).toBe('wip');
  });
});

describe('preEditSnapshot/rollbackToSnapshot', () => {
  it('refuses a dirty tree', async () => {
    const d = makeRepo();
    writeFileSync(resolve(d, 'usr.txt'), 'mine');
    const cp = await preEditSnapshot(d);
    expect(cp).toBeNull();
  });

  it('snapshots a clean tree, then rollback discards agent edits but keeps the state dir', async () => {
    const d = makeRepo();
    const cp = (await preEditSnapshot(d)) as CheckpointResult;
    expect(cp.type).toBe('commit');
    // agent edits a tracked file + creates a new file + harness state dir
    writeFileSync(resolve(d, 'a.txt'), 'changed');
    writeFileSync(resolve(d, 'new-agent-file.txt'), 'created');
    mkdirSync(resolve(d, '.mochi'), { recursive: true });
    writeFileSync(resolve(d, '.mochi', 'state.json'), '{}');
    const out = await rollbackToSnapshot(d, cp);
    expect(out).toMatch(/Rolled back/);
    // agent edits gone (file reverted to committed content; there is no
    // committed a.txt — `init` was empty, so the file is removed entirely).
    expect(existsSync(resolve(d, 'new-agent-file.txt'))).toBe(false);
    // the ONLY remaining dirty entry is the preserved harness state dir
    const statusOut = await status(d);
    const dirtyLines = statusOut.split('\n').map((l) => l.trim().slice(3)).filter(Boolean);
    expect(dirtyLines.every((l) => l.startsWith('.mochi/'))).toBe(true);
    // harness state dir preserved
    expect(readFileSync(resolve(d, '.mochi', 'state.json'), 'utf8')).toBe('{}');
  });
});