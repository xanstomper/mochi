// Git plumbing snapshots
// Uses low-level git tree objects (git write-tree / git read-tree)
// for atomic state captures and rollback without moving HEAD.

import { spawnSync } from 'node:child_process';

export interface TreeSnapshot {
  treeSha: string;
  timestamp: number;
  label: string;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    return {
      ok: res.status === 0,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
    };
  } catch (err: any) {
    return { ok: false, stdout: '', stderr: err?.message || String(err) };
  }
}

/** Stage the current working tree and write a tree object without moving HEAD. */
export function writeTreeSnapshot(cwd: string, label = 'ephemeral'): TreeSnapshot | null {
  // 1. Stage tracked/untracked changes temporarily into index
  const addRes = runGit(cwd, ['add', '-A']);
  if (!addRes.ok) return null;

  // 2. Write tree object directly to object database
  const writeRes = runGit(cwd, ['write-tree']);
  if (!writeRes.ok || !writeRes.stdout) return null;

  return {
    treeSha: writeRes.stdout,
    timestamp: Date.now(),
    label,
  };
}

/** Restore the working tree to a recorded tree snapshot. */
export function restoreTreeSnapshot(cwd: string, treeSha: string): boolean {
  if (!treeSha || treeSha.length !== 40) return false;

  // Read tree into index with --reset to overwrite dirty index entries, and -u to update working tree
  const readTreeRes = runGit(cwd, ['read-tree', '--reset', '-u', treeSha]);
  if (readTreeRes.ok) {
    // Clean any untracked files created since the snapshot
    runGit(cwd, ['clean', '-fd']);
    return true;
  }

  // Fallback to git checkout-index or git restore
  const restoreRes = runGit(cwd, ['restore', '--source', treeSha, '--staged', '--worktree', ':/']);
  if (restoreRes.ok) {
    runGit(cwd, ['clean', '-fd']);
    return true;
  }

  return false;
}

/** Get instantaneous unified diff against a tree snapshot */
export function diffAgainstTreeSnapshot(cwd: string, treeSha: string): string {
  if (!treeSha) return '';
  const diffRes = runGit(cwd, ['diff', treeSha]);
  return diffRes.stdout;
}
