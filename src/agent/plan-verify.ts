// B9 restructure (plan-mode verify): plan mode vetoes every mutating tool,
// which made `verify` unusable for research (running the project's own
// checks against the current tree). This module restores the research intent
// WITHOUT giving up the containment invariant: a verify command executed in
// plan mode runs against a recorded tree snapshot, and any TRACKED-file
// modification it leaves behind is rolled back before the loop continues.
//
// Mechanics (git-based, tree-untouched at snapshot time):
//  - snapshotTree(): `git stash create` records the current tracked state as
//    a dangling commit WITHOUT touching the working tree (null when clean);
//    plus a baseline of tracked-dirty paths WITH their staged flags (so the
//    rollback preserves the user's index state) and the pre-existing
//    untracked set (so verify-created artifacts can be cleaned without
//    touching paths that predate the command).
//  - rollbackTracked(): after the command, any tracked file now dirty that
//    was NOT dirty in the baseline is restored from the snapshot (or from
//    HEAD when the tree was clean), index-preserving; untracked paths the
//    command CREATED are deleted; pre-existing untracked paths are reported.
//
// Fail-closed contract: callers must veto verify in plan mode when this
// module cannot establish a snapshot (non-git workspace, git errors).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const execFileAsync = promisify(execFile);

/** Resolve the command a `verify` tool call WILL RUN, mirroring
 *  tools/verify.ts's alias handling AND its target appending (`command` can
 *  be a repo-derived alias — test/build/typecheck/lint — or an arbitrary
 *  shell string; a `target` arg is appended verbatim, exactly like the tool
 *  does before execution). Returns null when the resolution cannot be made
 *  statically (no/unparseable package.json for an alias): the caller must
 *  then fail closed. The classifier sees the FULL post-append string, so a
 *  hostile target can never smuggle a risk class past the gate. Note: the
 *  targeted-tests narrowing (scope:"auto" substitutes a related-tests-only
 *  command) is intentionally NOT modeled — that path is a SUBSET of the same
 *  test-command family, which the alias classification already covers. */
export function resolveVerifyCommand(args: Record<string, unknown>, cwd: string): string | null {
  const cmdType = String(args.command ?? 'test');
  const target = args.target ? String(args.target) : undefined;
  let resolved: string;
  if (cmdType === 'auto' || cmdType === '' || cmdType === 'test' || cmdType === 'build' || cmdType === 'typecheck' || cmdType === 'lint') {
    // Repo-derived alias: read package.json scripts the way repo detection
    // does, mirroring the tool's own fallbacks.
    try {
      const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      const pm = pkg.packageManager?.split('@')[0]
        || (existsSync(resolve(cwd, 'bun.lockb')) || existsSync(resolve(cwd, 'bun.lock')) ? 'bun' : 'npm');
      if (cmdType === 'auto') {
        // Tool behavior: repo.testCommand || 'echo ...' — with scripts present
        // the test command is `<pm> test`; without, classify the echo (safe).
        resolved = typeof pkg.scripts?.test === 'string' ? `${pm} test` : 'echo "No test command detected"';
      } else if (cmdType === 'test') {
        resolved = pkg.scripts?.test ? `${pm} test` : 'npm test -- --run';
      } else if (cmdType === 'build') {
        resolved = pkg.scripts?.build ? `${pm} run build` : 'npm run build';
      } else if (cmdType === 'typecheck') {
        resolved = 'npx tsc --noEmit';
      } else {
        resolved = pkg.scripts?.lint ? `${pm} run lint` : 'npx eslint .';
      }
    } catch {
      return null; // package.json unreadable → not statically resolvable
    }
  } else {
    // Verbatim command: classify exactly what will run.
    resolved = cmdType;
  }
  // Mirror tools/verify.ts:52 — a target is appended to the command BEFORE it
  // runs, so the classification input must be the appended string. The tool
  // only appends for test-shaped commands; a target on any other command is
  // ignored there, so it is ignored here too (classification matches
  // execution — anything the tool would actually run, and ONLY that).
  if (target && (cmdType === 'test' || resolved.includes('test'))) {
    resolved = `${resolved} ${target.includes('--') ? '' : '-- '}${target}`.trim();
  }
  return resolved;
}

export interface PlanVerifySnapshot {
  /** Dangling commit SHA from `git stash create`, or null for a clean tree. */
  sha: string | null;
  /** Tracked paths that were ALREADY dirty before the command ran. */
  baselineDirty: string[];
  /** Full porcelain rows (tracked) at snapshot time — staged-flag per path,
   *  so the rollback can preserve the user's index state. */
  baselinePorcelain: string[];
  /** Untracked paths present BEFORE the command ran. Anything untracked that
   *  is NOT in this set was created by the command and is deleted on
   *  rollback (verify artifacts); paths IN this set are reported, not
   *  touched (they predate the command). */
  baselineUntracked: Set<string>;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function trackedDirtyPaths(porcelain: string): string[] {
  // porcelain v1: XY<space>path — untracked (??) rows excluded (tracked-only).
  return porcelain
    .split('\n')
    .filter((l) => l.length > 3 && !l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

export async function snapshotTree(root: string): Promise<PlanVerifySnapshot | null> {
  try {
    // `git rev-parse --is-inside-work-tree` fails outside a repo.
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') return null;
    const sha = (await git(root, ['stash', 'create'])).trim() || null;
    const porcelain = await git(root, ['status', '--porcelain', '--untracked-files=no']);
    const untracked = await git(root, ['status', '--porcelain', '--untracked-files=all']);
    const baselineUntracked = new Set(
      untracked.split('\n').filter((l) => l.startsWith('??') && l.length > 3).map((l) => l.slice(3).trim()),
    );
    return {
      sha,
      baselineDirty: trackedDirtyPaths(porcelain),
      baselinePorcelain: porcelain.split('\n').filter((l) => l.length > 3),
      baselineUntracked,
    };
  } catch {
    return null; // fail closed: caller must veto without a snapshot
  }
}

/** Roll back tracked-file modifications the verify command left behind.
 *  EVERY tracked path dirty after the command is restored to its PRE-VERIFY
 *  content: paths dirty in the baseline from the snapshot commit (whose tree
 *  records the exact working-tree content at snapshot time), clean-baseline
 *  paths from HEAD. Restoration preserves the user's INDEX state: a path the
 *  user had staged keeps its staged entry (now with pre-verify content); a
 *  path the user had NOT staged is not staged by the rollback itself.
 *  Untracked paths CREATED by the command (absent from the pre-verify
 *  untracked baseline) are DELETED — they are verify's artifacts. Pre-existing
 *  untracked paths are reported only (they may predate the command). */
export async function rollbackTracked(
  root: string,
  snap: PlanVerifySnapshot,
): Promise<{ rolledBack: string[]; untrackedLeftover: string[] }> {
  try {
    const porcelain = await git(root, ['status', '--porcelain']);
    const rows = porcelain.split('\n').filter((l) => l.length > 3);
    const nowDirty = rows.filter((l) => !l.startsWith('??')).map((l) => l.slice(3).trim()).filter(Boolean);
    const untrackedNow = rows.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());
    for (const p of nowDirty) {
      // Snapshot SHA carries the pre-command content of dirty paths; a clean
      // baseline restores from HEAD.
      const src = snap.sha ?? 'HEAD';
      // `checkout <src> -- p` also stages the restored content; that would
      // silently rewrite the user's index. Re-stage ONLY what the user had
      // already staged in the baseline (X != ' ' in porcelain), leave the
      // index alone otherwise (unstaged user edits stay unstaged).
      const baselineRow = snap.baselinePorcelain.find((l) => l.slice(3).trim() === p);
      const userHadStaged = baselineRow !== undefined && baselineRow[0] !== ' ' && baselineRow[0] !== '?';
      await git(root, ['checkout', src, '--', p]);
      if (!userHadStaged) await git(root, ['reset', '-q', '--', p]);
    }
    // Delete untracked paths verify CREATED; pre-existing untracked paths are
    // reported, not touched.
    const created = untrackedNow.filter((p) => !snap.baselineUntracked.has(p));
    for (const p of created) {
      try { await git(root, ['clean', '-q', '-f', '--', p]); } catch { /* keep it; reported below */ }
    }
    // Report what SURVIVED: created-but-undeletable artifacts plus
    // pre-existing untracked paths (never touched, but the caller should
    // know the tree is not pristine).
    const afterClean = (await git(root, ['status', '--porcelain', '--untracked-files=all']))
      .split('\n').filter((l) => l.startsWith('??') && l.length > 3).map((l) => l.slice(3).trim());
    const untrackedLeftover = afterClean.filter((p) => created.includes(p) || snap.baselineUntracked.has(p));
    return { rolledBack: nowDirty, untrackedLeftover };
  } catch {
    // Rollback itself failed — report total, honest failure.
    return { rolledBack: [], untrackedLeftover: ['ROLLBACK FAILED — manual git inspection required'] };
  }
}
