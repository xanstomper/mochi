import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createPrTool } from './create-pr.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

let dir: string;
let originalPath: string;

function makeConfig(): MochiConfig {
  return {
    permissions: { shell: true, write: true, read: true, network: true, gitDestructive: true },
    safety: { mode: 'auto' },
  } as unknown as MochiConfig;
}

function testCtx(): ToolContext {
  return { cwd: dir, workspace: { dir, root: dir } as any, config: makeConfig(), events: new EventBus(), agentId: 'test' } as ToolContext;
}

beforeAll(() => {
  originalPath = process.env.PATH ?? '';

  // Real git repo to branch/commit in.
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-createpr-'));
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init && git branch -M main', { cwd: dir });
  writeFileSync(resolve(dir, 'a.txt'), 'base\n');
  execSync('git add a.txt && git commit -q -m a', { cwd: dir });
  // A local bare remote so `git push origin <branch>` succeeds.
  const origin = mkdtempSync(resolve(tmpdir(), 'mochi-origin-'));
  execSync(`git init -q --bare ${origin} && git remote add origin ${origin} && git push -q -u origin main`, { cwd: dir });

  // A fake `gh` on PATH: `gh pr create` prints a PR URL; anything else fails.
  const fakeBin = mkdtempSync(resolve(tmpdir(), 'mochi-ghbin-'));
  writeFileSync(resolve(fakeBin, 'gh'), [
    '#!/bin/sh',
    `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then`,
    '  echo "https://github.com/example/repo/pull/123"',
    '  exit 0',
    'fi',
    'exit 1',
  ].join('\n'));
  execSync(`chmod +x ${resolve(fakeBin, 'gh')}`);
  process.env.PATH = `${fakeBin}:${originalPath}`;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

beforeEach(() => {
  // Reset to a clean base with a pending change to commit.
  execSync('git checkout -q main', { cwd: dir });
  execSync('git reset -q --hard HEAD', { cwd: dir });
  try { execSync('git branch -q -D mochi/add-a-new-feature', { cwd: dir }); } catch { /* branch may not exist yet */ }
  writeFileSync(resolve(dir, 'a.txt'), 'base\nnew stuff\n');
  writeFileSync(resolve(dir, 'new.txt'), 'fresh\n');
});

describe('create_pr tool', () => {
  it('creates a branch, stages, commits, and opens a PR', async () => {
    const res = await createPrTool.execute({ title: 'Add a new feature' }, testCtx());
    expect(res).toContain('Opened PR');
    expect(res).toContain('https://github.com/example/repo/pull/123');
    expect(res).toContain('mochi/add-a-new-feature');
    expect(res).toContain('→ main');
    expect(execSync('git branch --show-current', { cwd: dir, encoding: 'utf8' }).trim()).toBe('mochi/add-a-new-feature');
  }, 30_000);

  it('refuses to run from a clean working tree', async () => {
    execSync('git reset -q --hard HEAD && git clean -qfd .', { cwd: dir });
    const res = await createPrTool.execute({ title: 'noop' }, testCtx());
    expect(res).toContain('No pending changes');
  });
});