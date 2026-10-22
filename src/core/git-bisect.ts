/**
 * git-bisect — binary search for the first bad commit, run entirely inside a
 * throwaway git worktree so the user's own checkout is never disturbed (no
 * HEAD moves, no bisect state, no stray files in their tree).
 *
 * Check-command convention (same as `git bisect run`):
 *   exit 0          → the checked-out commit is GOOD
 *   exit 1..124     → BAD (125 excluded)
 *   exit 125        → SKIP (commit cannot be tested)
 *   exit >= 126     → the check itself is broken: bisect ABORTS instead of
 *                     misclassifying the commit and returning a wrong answer.
 *
 * Determinism + bounds: the search is driven step by step (not delegated to
 * `git bisect run`) so every run is capped at `maxSteps` check executions and
 * each check has a hard timeout. Before searching, both endpoints are
 * verified — the `bad` ref must actually fail the check and the `good` ref
 * must actually pass it. A flipped or meaningless check command fails fast
 * with a clear error instead of silently bisecting to a wrong commit.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BisectStep {
  commit: string;
  subject: string;
  verdict: 'good' | 'bad' | 'skip';
}

export interface BisectOptions {
  /** Repository (any directory inside the work tree). */
  repoDir: string;
  /** Ref known to be GOOD (check passes). Must be an ancestor of `bad`. */
  good: string;
  /** Ref known to be BAD (check fails). */
  bad: string;
  /** Shell command run in the bisect worktree; exit 0 = good (see header). */
  checkCommand: string;
  /** Hard cap on check executions (endpoints included). Default 42. */
  maxSteps?: number;
  /** Per-check timeout in ms. Default 300_000 (5 min). */
  checkTimeoutMs?: number;
  /** Verify that `bad` fails and `good` passes before searching. Default true. */
  verifyEndpoints?: boolean;
}

export interface BisectResult {
  firstBadCommit: string;
  firstBadSubject: string;
  /** Every candidate commit actually checked, in the order checked. */
  steps: BisectStep[];
  /** Number of commits in good..bad at the start. */
  rangeSize: number;
}

const GIT_TIMEOUT_MS = 60_000;
const FIRST_BAD_RE = /^([0-9a-f]{40}) is the first bad commit/m;

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]} failed to run: ${r.error.message}`);
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function gitOrThrow(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

function resolveCommit(repoDir: string, ref: string): string {
  const r = git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (r.status !== 0) throw new Error(`cannot resolve ref "${ref}" to a commit in ${repoDir}`);
  return r.stdout.trim();
}

function subjectOf(repoDir: string, sha: string): string {
  return gitOrThrow(repoDir, ['log', '-1', '--format=%s', sha]).trim();
}

/** Classify a check-command exit code per the convention in the header. */
export function classifyCheckExit(status: number | null): 'good' | 'bad' | 'skip' | 'abort' {
  if (status === 0) return 'good';
  if (status === 125) return 'skip';
  if (status !== null && status >= 1 && status <= 124) return 'bad';
  return 'abort'; // null (killed/timeout), 126, 127, 128+ — the check is broken, not the commit
}

function runCheck(worktree: string, checkCommand: string, commit: string, timeoutMs: number): number | null {
  const r = spawnSync('/bin/sh', ['-c', checkCommand], {
    cwd: worktree,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, BISECT_COMMIT: commit },
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return null;
  return r.status;
}

export function runBisect(opts: BisectOptions): BisectResult {
  const maxSteps = opts.maxSteps ?? 42;
  const checkTimeoutMs = opts.checkTimeoutMs ?? 300_000;
  const verifyEndpoints = opts.verifyEndpoints ?? true;
  const repoDir = opts.repoDir;

  if (!opts.checkCommand?.trim()) throw new Error('checkCommand is required');
  if (git(repoDir, ['rev-parse', '--git-dir']).status !== 0) {
    throw new Error(`not a git repository: ${repoDir}`);
  }
  const goodSha = resolveCommit(repoDir, opts.good);
  const badSha = resolveCommit(repoDir, opts.bad);
  if (goodSha === badSha) throw new Error(`good and bad resolve to the same commit (${goodSha.slice(0, 12)}) — nothing to bisect`);
  if (git(repoDir, ['merge-base', '--is-ancestor', goodSha, badSha]).status !== 0) {
    throw new Error(`"${opts.good}" (${goodSha.slice(0, 12)}) is not an ancestor of "${opts.bad}" (${badSha.slice(0, 12)}) — bisect needs a good→bad ancestry range`);
  }
  const rangeSize = Number(gitOrThrow(repoDir, ['rev-list', '--count', `${goodSha}..${badSha}`]).trim());
  if (!Number.isFinite(rangeSize) || rangeSize < 1) throw new Error('empty bisect range');

  const tmp = mkdtempSync(join(tmpdir(), 'mochi-bisect-'));
  const worktree = join(tmp, 'wt');
  const steps: BisectStep[] = [];
  let checksUsed = 0;

  const check = (sha: string): 'good' | 'bad' | 'skip' => {
    checksUsed++;
    if (checksUsed > maxSteps) {
      throw new Error(`bisect exceeded maxSteps (${maxSteps}) — refusing to run unbounded; raise max_steps if the range really needs it`);
    }
    const status = runCheck(worktree, opts.checkCommand, sha, checkTimeoutMs);
    const verdict = classifyCheckExit(status);
    if (verdict === 'abort') {
      throw new Error(
        status === null
          ? `check command timed out after ${checkTimeoutMs}ms at commit ${sha.slice(0, 12)} — aborting (a timeout is not evidence about the commit)`
          : `check command exited ${status} at commit ${sha.slice(0, 12)} — exit codes ≥126 mean the check itself is broken; aborting rather than misclassifying`,
      );
    }
    return verdict;
  };

  try {
    gitOrThrow(repoDir, ['worktree', 'add', '--detach', worktree, badSha]);

    if (verifyEndpoints) {
      // The bad endpoint is already checked out by the worktree add.
      const badVerdict = check(badSha);
      if (badVerdict !== 'bad') {
        throw new Error(`endpoint verification failed: the "bad" ref ${opts.bad} (${badSha.slice(0, 12)}) checks as ${badVerdict.toUpperCase()} — the check command does not reproduce the failure at the bad ref (flipped command? wrong ref?)`);
      }
      gitOrThrow(worktree, ['checkout', '--detach', goodSha]);
      const goodVerdict = check(goodSha);
      if (goodVerdict !== 'good') {
        throw new Error(`endpoint verification failed: the "good" ref ${opts.good} (${goodSha.slice(0, 12)}) checks as ${goodVerdict.toUpperCase()} — the failure already exists at the good ref, so bisect cannot isolate its introduction`);
      }
    }

    gitOrThrow(worktree, ['bisect', 'start']);
    let out = gitOrThrow(worktree, ['bisect', 'bad', badSha]);
    out += gitOrThrow(worktree, ['bisect', 'good', goodSha]);

    let firstBad = FIRST_BAD_RE.exec(out)?.[1] ?? null;
    let previous = '';
    while (!firstBad) {
      const current = gitOrThrow(worktree, ['rev-parse', 'HEAD']).trim();
      if (current === previous) {
        throw new Error('bisect stalled — git did not advance (only untestable/skipped commits remain in the range)');
      }
      previous = current;
      const verdict = check(current);
      steps.push({ commit: current, subject: subjectOf(repoDir, current), verdict });
      out = gitOrThrow(worktree, ['bisect', verdict, current]);
      firstBad = FIRST_BAD_RE.exec(out)?.[1] ?? null;
    }

    return { firstBadCommit: firstBad, firstBadSubject: subjectOf(repoDir, firstBad), steps, rangeSize };
  } finally {
    // Best-effort cleanup: end the bisect session, drop the worktree, prune
    // stale registrations, remove the temp dir. The user's checkout was
    // never touched, so nothing here can damage it.
    try { git(worktree, ['bisect', 'reset']); } catch { /* worktree may be gone */ }
    try { git(repoDir, ['worktree', 'remove', '--force', worktree]); } catch { /* fall through to prune */ }
    try { git(repoDir, ['worktree', 'prune']); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}
