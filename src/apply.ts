/**
 * `mochi apply` — atomic multi-file patch application.
 *
 * Reads a unified diff (git format) from a file or stdin, validates every
 * target against the working tree, then applies ALL files or NONE: originals
 * of every touched path are snapshotted before the first write, and any
 * parse/apply failure mid-way restores every already-written file before
 * returning an error. New files are created; deletions remove the file.
 * Never touches the git index — review with `git diff` afterwards.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute, sep as pathSep } from 'node:path';
import { atomicWriteFileSync } from './core/atomic-fs.js';

export interface ApplyResult {
  applied: string[];   // paths written/updated
  created: string[];   // paths that did not exist before
  deleted: string[];   // paths removed
  skipped: string[];   // hunks that were already applied (no-op)
}

interface FileOp { path: string; op: 'update' | 'create' | 'delete'; hunks: string[]; }

/** Parse a unified diff into per-file operations. Throws on malformed input. */
export function parseUnifiedDiff(diffText: string, root?: string): FileOp[] {
  const ops: FileOp[] = [];
  const lines = diffText.split('\n');
  let i = 0;
  const stripA = (p: string) => p.replace(/^[ab]\//, '');
  // B14: plain `diff -u` output attaches a timestamp to each header path:
  // "+++ b/new.ts\t2024-01-01 10:00:00.000000000 +0000". The timestamp must be
  // stripped BEFORE the /dev/null comparison and path extraction, or create
  // ops write junk files named "new.ts\t2024-01-01..." and update ops never
  // match the real file.
  const cleanHeaderPath = (p: string) => p.split('\t')[0].trim();
  while (i < lines.length) {
    // Standard git diff headers:
    const diffHeader = lines[i].startsWith('diff --git');
    if (!diffHeader) { i++; continue; }
    let oldPath: string | null = null;
    let newPath: string | null = null;
    i++;
    // Collect ---/+++ headers
    while (i < lines.length && !lines[i].startsWith('@@')) {
      if (lines[i].startsWith('--- ')) oldPath = cleanHeaderPath(lines[i].slice(4));
      else if (lines[i].startsWith('+++ ')) newPath = cleanHeaderPath(lines[i].slice(4));
      i++;
    }
    if (i >= lines.length || !lines[i].startsWith('@@')) {
      // diff header with no hunks (rename-only / mode change) — skip
      continue;
    }
    const hunks: string[] = [];
    while (i < lines.length && (lines[i].startsWith('@@') || /^[ +\-\\]/.test(lines[i]))) {
      if (lines[i].startsWith('\\')) { i++; continue; } // "\ No newline at end"
      if (lines[i].startsWith('@@')) { hunks.push(lines[i]); i++; continue; }
      hunks.push(lines[i]); i++;
    }
    if (!oldPath || !newPath) throw new Error(`Malformed diff near line ${i}: missing ---/+++ headers`);
    let op: FileOp['op'];
    if (oldPath === '/dev/null') op = 'create';
    else if (newPath === '/dev/null') op = 'delete';
    else op = 'update';
    const path = stripA(op === 'create' ? newPath : op === 'delete' ? oldPath : newPath);
    // B14: absolute paths bypassed the `..` containment check — an absolute
    // path like /etc/evil sailed through and applyDiffAtomically's abs()
    // wrote OUTSIDE the workspace root verbatim.
    // Restructure (intent + invariant): when a root is known, an absolute
    // path that resolves INSIDE the root is re-rooted to workspace-relative
    // and applied (external tooling legitimately emits absolute-path diffs),
    // while one that escapes the root is rejected. Without a root, absolute
    // paths are rejected outright (the conservative pre-B14-fix posture is
    // unreachable for callers; applyDiffAtomically always passes root).
    let normalized = path;
    if (!path) throw new Error(`Unsafe path in diff: ${path}`);
    if (isAbsolute(path)) {
      if (root === undefined) throw new Error(`Unsafe path in diff (absolute): ${path}`);
      const rootResolved = resolve(root);
      const inside = resolve(root, path);
      if (inside === rootResolved || !inside.startsWith(rootResolved + '/')) {
        throw new Error(`Path escapes workspace root: ${path}`);
      }
      normalized = inside.slice(rootResolved.length + 1);
    }
    if (normalized.includes('..')) throw new Error(`Unsafe path in diff: ${normalized}`);
    ops.push({ path: normalized, op, hunks });
  }
  return ops;
}

/** Apply hunks to content. Returns null when a hunk doesn't match (context drift). */
export function applyHunks(content: string, hunks: string[]): string | null {
  const src = content.length ? content.split('\n') : [];
  // Pre-compute hunk ranges: @@ -oldStart,oldCount +newStart,newCount @@
  type H = { oldStart: number; oldLines: string[]; newLines: string[] };
  const parsed: H[] = [];
  let cur: H | null = null;
  for (const l of hunks) {
    const hm = l.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (hm) {
      cur = { oldStart: parseInt(hm[1], 10), oldLines: [], newLines: [] };
      parsed.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('+')) cur.newLines.push(l.slice(1));
    else if (l.startsWith('-')) cur.oldLines.push(l.slice(1));
    else if (l.startsWith(' ')) { cur.oldLines.push(l.slice(1)); cur.newLines.push(l.slice(1)); }
  }
  // Apply bottom-up so earlier offsets stay valid.
  for (const h of parsed.reverse()) {
    const idx = h.oldStart - 1;
    const slice = src.slice(idx, idx + h.oldLines.length);
    const matches = h.oldLines.length === 0
      ? true
      : slice.length === h.oldLines.length && slice.every((s, k) => s === h.oldLines[k]);
    if (!matches) return null;
    src.splice(idx, h.oldLines.length, ...h.newLines);
  }
  return src.join('\n');
}

/**
 * Atomically apply a unified diff to the working tree at `root`.
 * All-or-nothing: on any failure every file already written this run is
 * restored to its pre-apply content (new files are removed).
 */
export function applyDiffAtomically(root: string, diffText: string): ApplyResult {
  const ops = parseUnifiedDiff(diffText, root);
  if (ops.length === 0) throw new Error('No file operations found in diff.');
  const result: ApplyResult = { applied: [], created: [], deleted: [], skipped: [] };
  const rollback: Array<{ path: string; prev: string | null }> = [];
  // B14: containment enforced at the write boundary, not just at parse time —
  // resolve() normalizes any remaining traversal, and the resolved target must
  // stay inside `root`. (Parse-time checks are the first line; this is the
  // backstop, so a hostile diff can never escape the workspace.)
  const rootResolved = resolve(root);
  const abs = (p: string) => {
    const t = resolve(root, p);
    // path.sep, not a literal '/': on win32 resolve() returns backslash paths,
    // so a literal-slash startsWith rejected EVERY path ("Path escapes
    // workspace root: mod.txt") and broke the apply tool on Windows entirely.
    if (t !== rootResolved && !t.startsWith(rootResolved + pathSep)) {
      throw new Error(`Path escapes workspace root: ${p}`);
    }
    return t;
  };

  try {
    for (const op of ops) {
      const target = abs(op.path);
      const prev = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (op.op === 'delete') {
        if (prev === null) { result.skipped.push(op.path); continue; }
        unlinkSync(target);
        rollback.push({ path: target, prev });
        result.deleted.push(op.path);
        result.applied.push(op.path);
        continue;
      }
      let next: string | null;
      if (op.op === 'create') {
        if (prev !== null) { result.skipped.push(op.path); continue; }
        next = applyHunks('', op.hunks) ?? '';
      } else {
        if (prev === null) throw new Error(`Cannot update missing file: ${op.path} (use create or check path)`);
        next = applyHunks(prev, op.hunks);
        if (next === null) throw new Error(`Hunk context mismatch in ${op.path} — file drifts from diff. Aborting (no changes written for this file).`);
        if (next === prev) { result.skipped.push(op.path); continue; }
      }
      mkdirSync(dirname(target), { recursive: true });
      atomicWriteFileSync(target, next);
      rollback.push({ path: target, prev });
      if (prev === null) result.created.push(op.path);
      result.applied.push(op.path);
    }
  } catch (err) {
    // Roll back every write this run made, in reverse order.
    for (const rb of rollback.reverse()) {
      try {
        if (rb.prev === null) unlinkSync(rb.path);
        else writeFileSync(rb.path, rb.prev, 'utf8');
      } catch { /* best-effort restore; primary error is rethrown */ }
    }
    throw err;
  }
  return result;
}
