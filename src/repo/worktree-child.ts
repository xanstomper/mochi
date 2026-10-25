// W3-5 subagent worktree isolation, productized: a SCOPED helper around
// WorktreeManager that gives a child agent its own git worktree and
// GUARANTEES cleanup on exit — success, throw, or explicit dispose —
// replacing the by-hand create/try/finally-discard pattern.
//
// The loop's delegation machinery (agent/loop.ts) keeps finished children's
// worktrees alive on purpose: the parent reviews the diff, then applies
// (squash-merge) or discards. That flow is intentionally NOT auto-cleaned —
// but every NEW consumer (tools, hooks, hosts spawning one-shot children)
// had to re-implement the cleanup-by-hand, and a missed path leaked
// worktrees until the 24h orphan reap. This scope makes the safe default
// automatic and the review flow an explicit opt-out:
//
//   const result = await withChildWorktreeScope(repoRoot, mochiDir,
//     async (scope) => {
//       const wt = await scope.create('research-child');
//       ... run the child with cwd = wt.path ...
//       if (keepForReview) scope.keep(wt.id);   // opt OUT of cleanup
//       return outcome;
//     });
//   // scope exited: every non-kept worktree (dir + branch) is gone.
import { WorktreeManager, type WorktreeInfo } from './worktree.js';

export interface ChildWorktreeScope {
  /** Create an isolated worktree branched from the repo's current HEAD
   *  (own branch under mochi/worktree/). */
  create(label?: string): Promise<WorktreeInfo>;
  /** Opt a worktree OUT of automatic cleanup — the parent wants to review
   *  or apply (squash-merge) the child's diff itself. */
  keep(id: string): void;
  /** Discard one worktree immediately (dir + branch). Never throws. */
  discard(id: string): Promise<void>;
  /** Discard every non-kept worktree in this scope. Returns the discarded
   *  ids. Never throws; safe to call more than once. */
  dispose(): Promise<string[]>;
  /** Every worktree created in this scope, with kept-status. */
  list(): Array<WorktreeInfo & { kept: boolean }>;
}

export function createChildWorktreeScope(repoRoot: string, mochiDir: string): ChildWorktreeScope {
  const mgr = new WorktreeManager(repoRoot, mochiDir);
  const kept = new Set<string>();
  return {
    create: (label?: string) => mgr.create(label ?? 'child'),
    keep: (id: string) => { kept.add(id); },
    discard: async (id: string) => {
      try { await mgr.discard(id); } catch { /* best effort — reapOrphans is the backstop */ }
    },
    dispose: async (): Promise<string[]> => {
      const discarded: string[] = [];
      for (const info of mgr.list()) {
        if (kept.has(info.id)) continue;
        try {
          await mgr.discard(info.id);
          discarded.push(info.id);
        } catch { /* one failure never stops the rest */ }
      }
      return discarded;
    },
    list: () => mgr.list().map((info) => ({ ...info, kept: kept.has(info.id) })),
  };
}

/** Scoped runner: create a scope, run `fn`, and on EVERY exit path (return,
 *  throw) dispose the scope — discarding every worktree the body did not
 *  explicitly keep. The error (if any) propagates AFTER cleanup. */
export async function withChildWorktreeScope<T>(
  repoRoot: string,
  mochiDir: string,
  fn: (scope: ChildWorktreeScope) => Promise<T>,
): Promise<T> {
  const scope = createChildWorktreeScope(repoRoot, mochiDir);
  try {
    return await fn(scope);
  } finally {
    // dispose() never throws; the guard keeps a disposal accident from
    // masking the body's error.
    try { await scope.dispose(); } catch { /* cleanup is best effort */ }
  }
}
