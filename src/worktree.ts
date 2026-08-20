// Ephemeral Git Worktree Manager
// Provides Copy-on-Write isolated worktrees for parallel swarm agents so they
// can edit files concurrently without dirtying each other's working state.
// Each worker gets its own branch + worktree, which is squash-merged back into
// the main branch once verified.

import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WorktreeInfo {
  id: string;
  branch: string;
  path: string;
  baseBranch: string;
  createdAt: number;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr ?? err.message}`);
  }
}

function gitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve((stdout as string).trim());
    });
  });
}

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeInfo>();
  private worktreeBase: string;

  constructor(
    private readonly repoRoot: string,
    private readonly mochiDir: string,
  ) {
    this.worktreeBase = join(mochiDir, 'worktrees');
  }

  /** Create an isolated ephemeral worktree branched from the current HEAD. */
  async create(label = 'worker'): Promise<WorktreeInfo> {
    const id = `${label}-${randomUUID().slice(0, 8)}`;
    const branch = `mochi/worktree/${id}`;
    const path = join(this.worktreeBase, id);

    mkdirSync(this.worktreeBase, { recursive: true });

    // Get current branch name
    let baseBranch = 'HEAD';
    try { baseBranch = git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* ok */ }

    // Create branch + worktree
    await gitAsync(this.repoRoot, ['worktree', 'add', '-b', branch, path, 'HEAD']);

    const info: WorktreeInfo = { id, branch, path, baseBranch, createdAt: Date.now() };
    this.worktrees.set(id, info);
    return info;
  }

  /** Squash-merge the worktree branch back into the base branch.
   *  Returns the squash commit SHA. */
  async merge(id: string, message?: string): Promise<string> {
    const info = this.worktrees.get(id);
    if (!info) throw new Error(`Worktree ${id} not found`);
    const msg = message ?? `mochi: merge worktree ${id}`;
    // squash merge — produces a single clean commit on the base branch
    await gitAsync(this.repoRoot, ['merge', '--squash', info.branch]);
    await gitAsync(this.repoRoot, ['commit', '-m', msg, '--allow-empty']);
    const sha = git(this.repoRoot, ['rev-parse', 'HEAD']);
    return sha;
  }

  /** Discard the worktree and delete its branch without merging. */
  async discard(id: string): Promise<void> {
    const info = this.worktrees.get(id);
    if (!info) return;
    try { await gitAsync(this.repoRoot, ['worktree', 'remove', '--force', info.path]); } catch { /* ok if already gone */ }
    try { await gitAsync(this.repoRoot, ['branch', '-D', info.branch]); } catch { /* ok */ }
    if (existsSync(info.path)) rmSync(info.path, { recursive: true, force: true });
    this.worktrees.delete(id);
  }

  /** Discard all tracked worktrees. */
  async discardAll(): Promise<void> {
    await Promise.all([...this.worktrees.keys()].map((id) => this.discard(id)));
  }

  list(): WorktreeInfo[] {
    return [...this.worktrees.values()];
  }

  get(id: string): WorktreeInfo | undefined {
    return this.worktrees.get(id);
  }
}
