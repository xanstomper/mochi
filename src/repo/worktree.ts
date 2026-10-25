// Ephemeral Git Worktree Manager
// Provides Copy-on-Write isolated worktrees for parallel swarm agents so they
// can edit files concurrently without dirtying each other's working state.
// Each worker gets its own branch + worktree, which is squash-merged back into
// the main branch once verified.

import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
  } catch (err: any) {
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr ?? err.message}`);
  }
}

function gitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve((stdout as string).trim());
    });
  });
}

export interface ReapOrphansResult {
  removedDirs: string[];
  removedBranches: string[];
}

/** Default staleness threshold for orphan reaping: 24 hours. */
export const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Worktree bases that have already had their once-per-process startup reap.
// Keyed by base dir (not a single global flag) so distinct repos/managers in
// the same process each get exactly one automatic reap.
const autoReapedBases = new Set<string>();

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeInfo>();
  private worktreeBase: string;

  constructor(
    private readonly repoRoot: string,
    mochiDir: string,
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

    // Register in the live registry BEFORE the worktree exists on disk and
    // before the background orphan-reap below starts. The old order (fire
    // reap -> git worktree add -> register) meant the background reap read
    // an EMPTY registry snapshot, then — racing with a concurrent
    // reapOrphans()/backdated dir — could reap the very worktree this
    // manager owned (live test: `never reaps a worktree registered in the
    // calling manager`). Registration first makes the entry unconditionally
    // protected; if the checkout fails, the entry is rolled back.
    const info: WorktreeInfo = { id, branch, path, baseBranch, createdAt: Date.now() };
    this.worktrees.set(id, info);

    // Best-effort orphan reap, once per process per worktree base: a previous
    // process that crashed/killed left its worktrees + branches behind
    // (the registry is in-memory only). Fire-and-forget so create() is never
    // slowed or broken by it — reapOrphans never throws, uses the default
    // 24h staleness rule, and everything already in the live registry is
    // safe.
    if (!autoReapedBases.has(this.worktreeBase)) {
      autoReapedBases.add(this.worktreeBase);
      void this.reapOrphans().catch(() => { /* never break create() */ });
    }

    try {
      // Create branch + worktree
      await gitAsync(this.repoRoot, ['worktree', 'add', '-b', branch, path, 'HEAD']);
    } catch (e) {
      this.worktrees.delete(id); // no phantom live entry for a checkout that never happened
      throw e;
    }
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

  /**
   * Reap orphaned worktrees/branches left behind by a crashed or killed
   * process. The registry above is in-memory only, so on-disk worktrees
   * under `.mochi/worktrees` (branch `mochi/worktree/<id>`) whose owning
   * process died are otherwise never cleaned up.
   *
   * Staleness rule: a worktree/branch is an orphan iff it is NOT in this
   * process's live registry AND it is stale — its worktree directory's
   * mtime is older than `maxAgeMs` (default 24h). A worktree registered in
   * this manager is NEVER reaped, regardless of age. `maxAgeMs: 0` reaps
   * every unregistered orphan regardless of age (explicit cleanup).
   * For a `mochi/worktree/*` branch with no worktree directory left, the
   * tip commit's committer date stands in for the directory mtime.
   *
   * Best-effort per item: one failure never stops the rest, and this
   * method never throws.
   */
  async reapOrphans(opts?: { maxAgeMs?: number }): Promise<ReapOrphansResult> {
    const removedDirs: string[] = [];
    const removedBranches: string[] = [];
    try {
      const maxAgeMs = Math.max(0, opts?.maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS);
      const now = Date.now();
      const isStale = (mtimeMs: number): boolean => maxAgeMs === 0 || now - mtimeMs > maxAgeMs;

      // Live-registry protection, checked at decision time — and the sets
      // are re-read from the registry on EVERY check, not snapshotted at
      // call time. reapOrphans is async and yields on git calls; a sibling
      // create() that registers during one of those awaits must be protected
      // even though it was not in the map when this method started.
      const isLive = (path: string, branch?: string): boolean => {
        const wantPath = resolve(path);
        const wantId = basename(path);
        for (const info of this.worktrees.values()) {
          if (info.id === wantId || resolve(info.path) === wantPath) return true;
          if (branch !== undefined && info.branch === branch) return true;
        }
        return false;
      };

      const dirMtime = (p: string): number | null => {
        try { return statSync(p).mtimeMs; } catch { return null; }
      };

      // --- Discover actual git worktrees ---------------------------------
      interface GitWorktree { path: string; branch?: string }
      const gitWorktrees: GitWorktree[] = [];
      try {
        const out = await gitAsync(this.repoRoot, ['worktree', 'list', '--porcelain']);
        let current: GitWorktree | null = null;
        for (const line of out.split('\n')) {
          if (line.startsWith('worktree ')) {
            current = { path: line.slice('worktree '.length).trim() };
            gitWorktrees.push(current);
          } else if (current && line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
          }
        }
      } catch { /* not a git repo / git unavailable: fs scan below still runs */ }

      const branchExists = async (branch: string): Promise<boolean> => {
        try {
          await gitAsync(this.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
          return true;
        } catch { return false; }
      };

      const removeWorktree = async (path: string, branch?: string): Promise<void> => {
        try { await gitAsync(this.repoRoot, ['worktree', 'remove', '--force', path]); } catch { /* fall through to rm */ }
        if (existsSync(path)) {
          try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        if (!existsSync(path) && !removedDirs.includes(path)) removedDirs.push(path);
        if (branch && (await branchExists(branch))) {
          try {
            await gitAsync(this.repoRoot, ['branch', '-D', branch]);
            if (!removedBranches.includes(branch)) removedBranches.push(branch);
          } catch { /* best effort */ }
        }
      };

      // Only worktrees under our base (or on one of our branches) are ours
      // to reap — never the repo's main worktree or a user's own worktree.
      const managedPaths = new Set<string>();
      for (const wt of gitWorktrees) {
        if (resolve(wt.path) === resolve(this.repoRoot)) continue; // main tree
        const underBase = resolve(wt.path).startsWith(resolve(this.worktreeBase));
        const ourBranch = wt.branch?.startsWith('mochi/worktree/') ?? false;
        if (!underBase && !ourBranch) continue;
        managedPaths.add(resolve(wt.path));
        if (isLive(wt.path, wt.branch)) continue;
        const mtime = dirMtime(wt.path);
        // A registered-in-git worktree whose dir vanished is stale by
        // definition (git will prune it); otherwise use the dir mtime.
        if (mtime === null || isStale(mtime)) {
          await removeWorktree(wt.path, wt.branch);
        }
      }
      try { await gitAsync(this.repoRoot, ['worktree', 'prune']); } catch { /* best effort */ }

      // --- Scan the base dir for dirs git no longer lists ----------------
      // (e.g. the .git/worktrees admin entry was pruned but the checkout
      // itself was left behind).
      try {
        if (existsSync(this.worktreeBase)) {
          for (const entry of readdirSync(this.worktreeBase, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = join(this.worktreeBase, entry.name);
            if (managedPaths.has(resolve(path))) continue; // handled above
            const branch = `mochi/worktree/${entry.name}`;
            if (isLive(path, branch)) continue;
            const mtime = dirMtime(path);
            if (mtime !== null && !isStale(mtime)) continue;
            try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
            if (!existsSync(path) && !removedDirs.includes(path)) removedDirs.push(path);
            if (await branchExists(branch)) {
              try {
                await gitAsync(this.repoRoot, ['branch', '-D', branch]);
                if (!removedBranches.includes(branch)) removedBranches.push(branch);
              } catch { /* best effort */ }
            }
          }
        }
      } catch { /* best effort */ }

      // --- Orphan branches with no worktree at all -----------------------
      try {
        const out = await gitAsync(this.repoRoot, [
          'for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/mochi/worktree/',
        ]);
        const attachedBranches = new Set(gitWorktrees.map((w) => w.branch).filter(Boolean));
        for (const line of out.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [branch, unix] = trimmed.split(/\s+/);
          if (!branch || attachedBranches.has(branch)) continue; // handled with its worktree above
          // Live-branch protection: a branch owned by this manager (even one
          // whose worktree has not been created yet) is never reaped.
          let owned = false;
          for (const info of this.worktrees.values()) {
            if (info.branch === branch) { owned = true; break; }
          }
          if (owned) continue;
          const tipMs = Number(unix) * 1000;
          if (Number.isFinite(tipMs) && tipMs > 0 && !isStale(tipMs)) continue;
          try {
            await gitAsync(this.repoRoot, ['branch', '-D', branch]);
            if (!removedBranches.includes(branch)) removedBranches.push(branch);
          } catch { /* best effort */ }
        }
      } catch { /* best effort */ }
    } catch { /* reaping must never throw */ }
    return { removedDirs, removedBranches };
  }
}
