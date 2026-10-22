// Frozen-task fixture: `mochi apply` — atomic multi-file patch application,
// ported from src/apply.ts as of b484d84^ (the parent of the absolute-path
// re-rooting fix), types stripped. One named substitution: the repo's
// atomicWriteFileSync (single-file write-temp-then-rename) is replaced by
// writeFileSync — the fixture freezes path handling and all-or-nothing
// rollback, not the single-file rename.
//
// Reads a unified diff (git format), validates every target against the
// working tree, then applies ALL files or NONE: originals of every touched
// path are snapshotted before the first write, and any parse/apply failure
// mid-way restores every already-written file before returning an error.
// New files are created; deletions remove the file.
//
// PATH POSTURE AT THIS REVISION: an earlier hardening (B14) made the
// parser reject ALL absolute paths outright — safe, but it also rejects
// the absolute-path diffs that external tooling (filters, formatters,
// agents operating via SDK on explicit roots) legitimately emits, paths
// that previously applied.
const { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, resolve, isAbsolute } = require('node:path');

/** Parse a unified diff into per-file operations. Throws on malformed input. */
function parseUnifiedDiff(diffText) {
  const ops = [];
  const lines = diffText.split('\n');
  let i = 0;
  const stripA = (p) => p.replace(/^[ab]\//, '');
  // B14: plain `diff -u` output attaches a timestamp to each header path:
  // "+++ b/new.ts\t2024-01-01 10:00:00.000000000 +0000". The timestamp must
  // be stripped BEFORE the /dev/null comparison and path extraction, or
  // create ops write junk files named "new.ts\t2024-01-01..." and update
  // ops never match the real file.
  const cleanHeaderPath = (p) => p.split('\t')[0].trim();
  while (i < lines.length) {
    // Standard git diff headers:
    const diffHeader = lines[i].startsWith('diff --git');
    if (!diffHeader) { i++; continue; }
    let oldPath = null;
    let newPath = null;
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
    const hunks = [];
    while (i < lines.length && (lines[i].startsWith('@@') || /^[ +\-\\]/.test(lines[i]))) {
      if (lines[i].startsWith('\\')) { i++; continue; } // "\ No newline at end"
      if (lines[i].startsWith('@@')) { hunks.push(lines[i]); i++; continue; }
      hunks.push(lines[i]); i++;
    }
    if (!oldPath || !newPath) throw new Error(`Malformed diff near line ${i}: missing ---/+++ headers`);
    let op;
    if (oldPath === '/dev/null') op = 'create';
    else if (newPath === '/dev/null') op = 'delete';
    else op = 'update';
    const path = stripA(op === 'create' ? newPath : op === 'delete' ? oldPath : newPath);
    // B14: reject absolute paths too. The `..` check alone was bypassable —
    // an absolute path like /etc/evil sailed through and
    // applyDiffAtomically's abs() wrote OUTSIDE the workspace root
    // verbatim.
    if (!path || isAbsolute(path) || path.includes('..')) throw new Error(`Unsafe path in diff: ${path}`);
    ops.push({ path, op, hunks });
  }
  return ops;
}

/** Apply hunks to content. Returns null when a hunk doesn't match (context drift). */
function applyHunks(content, hunks) {
  const src = content.length ? content.split('\n') : [];
  // Pre-compute hunk ranges: @@ -oldStart,oldCount +newStart,newCount @@
  const parsed = [];
  let cur = null;
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
function applyDiffAtomically(root, diffText) {
  const ops = parseUnifiedDiff(diffText);
  if (ops.length === 0) throw new Error('No file operations found in diff.');
  const result = { applied: [], created: [], deleted: [], skipped: [] };
  const rollback = [];
  // B14: containment enforced at the write boundary, not just at parse
  // time — resolve() normalizes any remaining traversal, and the resolved
  // target must stay inside `root`. (Parse-time checks are the first line;
  // this is the backstop, so a hostile diff can never escape the
  // workspace.)
  const rootResolved = resolve(root);
  const abs = (p) => {
    const t = resolve(root, p);
    if (t !== rootResolved && !t.startsWith(rootResolved + '/')) {
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
      let next;
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
      writeFileSync(target, next, 'utf8');
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

module.exports = { parseUnifiedDiff, applyHunks, applyDiffAtomically };
