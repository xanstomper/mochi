import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += String(c); });
    proc.stderr.on('data', (c) => { err += String(c); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && out.trim().length === 0) return reject(new Error(err.trim() || `git ${args[0]} failed`));
      resolve(out.trim());
    });
  });
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    await run(cwd, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function status(cwd: string): Promise<string> {
  if (!(await isRepo(cwd))) return 'Not a git repository';
  return run(cwd, ['status', '--short']);
}

export async function diff(cwd: string): Promise<string> {
  if (!(await isRepo(cwd))) return '';
  return run(cwd, ['diff']);
}

export async function log(cwd: string, n = 10): Promise<string> {
  if (!(await isRepo(cwd))) return '';
  return run(cwd, ['log', '--oneline', `-${n}`]);
}

export interface CheckpointResult {
  ref: string;
  type: 'commit' | 'stash';
  message: string;
}

export async function checkpoint(cwd: string, message = 'mochi checkpoint'): Promise<CheckpointResult> {
  const statusOut = await status(cwd);
  if (!statusOut.trim()) {
    // Already clean; create an empty commit to mark point.
    const ref = randomUUID().slice(0, 8);
    const fullMessage = `${message} [${ref}]`;
    await run(cwd, ['commit', '--allow-empty', '-m', fullMessage]);
    const head = (await run(cwd, ['rev-parse', 'HEAD'])).split('\n')[0];
    return { ref: head, type: 'commit', message: fullMessage };
  }
  const branch = (await run(cwd, ['branch', '--show-current'])).trim() || 'HEAD';
  const stashMessage = `${message} on ${branch}`;
  await run(cwd, ['stash', 'push', '-u', '-m', stashMessage]);
  const list = await run(cwd, ['stash', 'list']);
  const line = list.split('\n').find((l) => l.includes(stashMessage));
  const stashRef = line ? line.split(':')[0] : 'stash@{0}';
  return { ref: stashRef, type: 'stash', message: stashMessage };
}

export async function restore(cwd: string, checkpoint: CheckpointResult): Promise<string> {
  if (checkpoint.type === 'commit') {
    await run(cwd, ['reset', '--hard', checkpoint.ref]);
    return `Restored to commit ${checkpoint.ref}`;
  }
  await run(cwd, ['stash', 'pop', checkpoint.ref]);
  return `Restored stash ${checkpoint.ref}`;
}

/**
 * Pre-edit rollback point: an empty commit on a CLEAN tree. Unlike
 * `checkpoint()`, this never moves or stashes working-tree changes, so the
 * agent keeps editing exactly what it saw. Restoring later (`reset --hard` +
 * bounded `clean`) discards everything the agent did after the snapshot while
 * preserving the state the run started from. The harness's own state dir
 * (default `.mochi`) is invisible to both the cleanliness check and the
 * restore, so agent bookkeeping never blocks a snapshot or gets wiped.
 * Returns null when the tree is dirty (can't safely snapshot without touching
 * the user's changes) or not a repo.
 */
export async function preEditSnapshot(cwd: string, message = 'mochi pre-edit', stateDir = '.mochi'): Promise<CheckpointResult | null> {
  if (!(await isRepo(cwd))) return null;
  const statusOut = await status(cwd);
  const dirty = statusOut
    .split('\n')
    .filter((l) => l.trim() && !l.slice(3).trim().startsWith(`${stateDir}/`) && !l.slice(3).trim().startsWith(`"${stateDir}/`));
  if (dirty.length > 0) return null; // dirty: refuse rather than stash user work
  const ref = randomUUID().slice(0, 8);
  const fullMessage = `${message} [${ref}]`;
  await run(cwd, ['commit', '--allow-empty', '-m', fullMessage]);
  const head = (await run(cwd, ['rev-parse', 'HEAD'])).split('\n')[0];
  return { ref: head, type: 'commit', message: fullMessage };
}

/**
 * Undo everything after a pre-edit snapshot. `reset --hard` alone leaves the
 * agent's NEW files behind (untracked); because the snapshot only exists on a
 * tree that was clean (modulo the state dir), every untracked file at this
 * point was created by the run, so `clean -fd` restores the exact starting
 * state. The state dir is excluded so harness bookkeeping survives, and
 * ignored files are never touched (no -x).
 */
export async function rollbackToSnapshot(cwd: string, cp: CheckpointResult, stateDir = '.mochi'): Promise<string> {
  await run(cwd, ['reset', '--hard', cp.ref]);
  await run(cwd, ['clean', '-fd', `-e`, stateDir]);
  return `Rolled back to pre-edit state ${cp.ref.slice(0, 8)} (agent edits discarded)`;
}
