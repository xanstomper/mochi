// Per-hunk edit review (W3-4): BEFORE a file-edit tool call applies, the
// approval gate decomposes the proposed change into hunks so the host UI can
// offer per-hunk accept/reject instead of all-or-nothing approval.
//
// Pure, best-effort, fail-open: every builder returns undefined when it
// cannot produce an exact decomposition (missing file, unmatched needle,
// malformed patch) and the caller falls back to the plain approval menu —
// the review UI must never change whether a call is allowed, only how
// finely the user can carve it up. Tool never breaks: buildEditReview
// catches everything.
//
// Hunk formats by tool (documented contract):
//   edit  → unified-diff hunks (exactly one: a single contiguous replacement)
//   write → unified-diff hunks (old content vs new content)
//   patch → Codex-patch fragments (one per file section / @@ hunk group),
//           each re-emittable through parsePatch
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { applyHunks } from '../apply.js';
import { applyEdit } from '../tools/edit-apply.js';
import { parsePatch } from '../tools/patch.js';
import { trimIndent } from '../tools/edit.js';

/** The review payload carried on an ApprovalRequest. */
export interface EditReview {
  /** Display path (or comma-joined paths for multi-file patches). */
  path: string;
  /** Full diff text for the transcript preview. */
  diff: string;
  /** Acceptable units in order — the indices of THIS array are what an
   *  acceptedHunks decision refers to. */
  hunks: string[];
}

// ─── Unified-diff construction (edit / write) ─────────────────────────────

type DiffOp = { t: ' ' | '-' | '+'; s: string };

/** Line diff with a common prefix/suffix trim and a bounded LCS middle.
 *  Beyond the cap the middle degrades to a whole-block replace — a review
 *  preview must stay O(1) even on pathological files. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: DiffOp[] = a.slice(0, start).map((s) => ({ t: ' ' as const, s }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const LCS_CAP = 1500;
  if (midA.length > LCS_CAP || midB.length > LCS_CAP) {
    for (const s of midA) ops.push({ t: '-', s });
    for (const s of midB) ops.push({ t: '+', s });
  } else {
    // Standard LCS table; backtrack to interleave unchanged lines.
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ t: ' ', s: midA[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', s: midA[i] }); i++; }
      else { ops.push({ t: '+', s: midB[j] }); j++; }
    }
    while (i < n) { ops.push({ t: '-', s: midA[i] }); i++; }
    while (j < m) { ops.push({ t: '+', s: midB[j] }); j++; }
  }
  for (const s of a.slice(endA)) ops.push({ t: ' ', s });
  return ops;
}

/** Split a unified diff's hunk bodies with `context` lines of context,
 *  merging changes closer than 2*context+1 lines into one hunk. */
export function buildHunks(ops: DiffOp[], context = 3): string[] {
  const changed = ops.flatMap((o, i) => (o.t !== ' ' ? [i] : []));
  if (changed.length === 0) return [];
  // Line numbers each op index maps to (1-based; ops that are pure adds
  // repeat the current old line number and vice versa).
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let ol = 1;
  let nl = 1;
  for (const o of ops) {
    oldNo.push(o.t === '+' ? ol : ol++);
    newNo.push(o.t === '-' ? nl : nl++);
  }
  const groups: number[][] = [];
  let cur: number[] = [changed[0]];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - changed[k - 1] <= context * 2 + 1) cur.push(changed[k]);
    else { groups.push(cur); cur = [changed[k]]; }
  }
  groups.push(cur);

  const hunks: string[] = [];
  for (const g of groups) {
    const lo = Math.max(0, g[0] - context);
    const hi = Math.min(ops.length - 1, g[g.length - 1] + context);
    const body = ops.slice(lo, hi + 1);
    let oldCount = 0;
    let newCount = 0;
    for (const o of body) {
      if (o.t !== '+') oldCount++;
      if (o.t !== '-') newCount++;
    }
    const oldStart = oldCount === 0 ? Math.max(0, oldNo[lo] - 1) : oldNo[lo];
    const newStart = newCount === 0 ? Math.max(0, newNo[lo] - 1) : newNo[lo];
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.map((o) => o.t + o.s).join('\n')}`);
  }
  return hunks;
}

/** git-style unified diff text for two contents. */
export function computeUnifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
  const a = oldText.length ? oldText.replace(/\r\n/g, '\n').split('\n') : [];
  const b = newText.length ? newText.replace(/\r\n/g, '\n').split('\n') : [];
  const hunks = buildHunks(diffLines(a, b), context);
  if (hunks.length === 0) return '';
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
  ].join('\n');
}

/** Split a unified diff into its hunk blocks (header + body, joined by \n). */
export function splitHunks(diffText: string): string[] {
  const lines = diffText.split('\n');
  const hunks: string[] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (l.startsWith('@@')) {
      if (cur) hunks.push(cur.join('\n'));
      cur = [l];
    } else if (cur && (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-') || l.startsWith('\\'))) {
      cur.push(l);
    }
    // Header lines (diff --git / --- / +++) and stray prose are skipped.
  }
  if (cur) hunks.push(cur.join('\n'));
  return hunks;
}

// ─── Per-tool review builders ─────────────────────────────────────────────

function resolveFullPath(rawPath: string, cwd: string): string {
  return rawPath === '~' ? homedir()
    : rawPath.startsWith('~/') ? resolve(homedir(), rawPath.slice(2))
    : resolve(cwd, rawPath);
}

function unifiedReview(rawPath: string, content: string, newContent: string): EditReview | undefined {
  const diff = computeUnifiedDiff(content, newContent, rawPath);
  const hunks = splitHunks(diff);
  if (hunks.length === 0) return undefined;
  return { path: rawPath, diff, hunks };
}

function reviewEdit(args: Record<string, unknown>, cwd: string): EditReview | undefined {
  const rawPath = String(args.path ?? '');
  const oldText = String(args.oldText ?? '').replace(/\r\n/g, '\n');
  if (!rawPath || !oldText.trim()) return undefined;
  const full = resolveFullPath(rawPath, cwd);
  if (!existsSync(full)) return undefined;
  // Mirror the edit tool's own first candidate (as-sent needle + trimmed
  // replacement): if it wouldn't apply, the tool falls back to other
  // strategies at exec time and we simply don't offer a review.
  const newText = args.trim ? trimIndent(String(args.newText ?? '')) : String(args.newText ?? '');
  const content = readFileSync(full, 'utf8');
  const applied = applyEdit(content, oldText);
  if (!applied.ok) return undefined;
  const newContent = content.slice(0, applied.start) + newText + content.slice(applied.end);
  return unifiedReview(rawPath, content, newContent);
}

function reviewWrite(args: Record<string, unknown>, cwd: string): EditReview | undefined {
  const rawPath = String(args.path ?? '');
  if (!rawPath || args.append) return undefined; // appends are not overwrites
  const full = resolveFullPath(rawPath, cwd);
  const content = existsSync(full) ? readFileSync(full, 'utf8') : '';
  const newContent = String(args.content ?? '');
  if (newContent === content) return undefined;
  return unifiedReview(rawPath, content, newContent);
}

// Structural view of parsePatch's output (the type itself is not exported).
interface PatchLine { kind: 'ctx' | 'del' | 'add'; text: string }
interface PatchFile { op: 'add' | 'update' | 'delete'; path: string; lines: PatchLine[]; hunks?: PatchLine[][] }

const patchLineText = (l: PatchLine): string => (l.kind === 'ctx' ? ` ${l.text}` : l.kind === 'del' ? `-${l.text}` : `+${l.text}`);

function reviewPatch(args: Record<string, unknown>): EditReview | undefined {
  const patchText = String(args.patch ?? '');
  if (!patchText.trim()) return undefined;
  const fps = parsePatch(patchText) as unknown as PatchFile[];
  if (fps.length === 0) return undefined;
  // One reviewable unit per file section (add/delete) or @@ hunk group
  // (update). Each unit is re-emittable patch text on its own.
  const units: string[] = [];
  const paths: string[] = [];
  for (const fp of fps) {
    if (!paths.includes(fp.path)) paths.push(fp.path);
    if (fp.op === 'add') {
      units.push(`*** Add File: ${fp.path}\n${fp.lines.map((l) => `+${l.text}`).join('\n')}`);
    } else if (fp.op === 'delete') {
      units.push(`*** Delete File: ${fp.path}`);
    } else {
      const groups = fp.hunks && fp.hunks.length ? fp.hunks : (fp.lines.length ? [fp.lines] : []);
      for (const g of groups) {
        units.push(`*** Update File: ${fp.path}\n@@\n${g.map(patchLineText).join('\n')}`);
      }
    }
  }
  if (units.length === 0) return undefined;
  const displayPath = paths.join(', ').length > 80 ? `${paths.slice(0, 3).join(', ')}…` : paths.join(', ');
  return {
    path: displayPath,
    diff: units.map((u) => `${u}\n`).join('\n'),
    hunks: units,
  };
}

/** Build the review payload for an approval-gated file-edit call, or
 *  undefined when no exact decomposition is possible (plain menu then). */
export function buildEditReview(tool: string, args: Record<string, unknown>, cwd: string): EditReview | undefined {
  try {
    if (tool === 'edit') return reviewEdit(args, cwd);
    if (tool === 'write') return reviewWrite(args, cwd);
    if (tool === 'patch') return reviewPatch(args);
    return undefined;
  } catch {
    return undefined; // review is best-effort; the gate must never break
  }
}

// ─── Decision application ─────────────────────────────────────────────────

/** Rewrite tool args so only the ACCEPTED hunks apply. Returns undefined
 *  when no revision is needed (edit is single-hunk) or possible (drift);
 *  the caller then proceeds with the original args. Never mutates `args`. */
export function applyAcceptedHunks(
  tool: string,
  args: Record<string, unknown>,
  review: EditReview,
  accepted: number[],
  cwd: string,
): Record<string, unknown> | undefined {
  const valid = [...new Set(accepted)].filter((i) => Number.isInteger(i) && i >= 0 && i < review.hunks.length);
  if (valid.length === 0) return undefined;
  if (tool === 'edit') return undefined; // one hunk; accept-all needs no rewrite
  if (tool === 'write') {
    const rawPath = String(args.path ?? '');
    if (!rawPath || args.append) return undefined;
    const full = resolveFullPath(rawPath, cwd);
    if (!existsSync(full)) return undefined;
    const content = readFileSync(full, 'utf8');
    // applyHunks consumes a FLAT list of diff lines (header line + body
    // lines); the review keeps hunks as blocks, so flatten the accepted set.
    const flat = valid.map((i) => review.hunks[i]).join('\n').split('\n');
    const next = applyHunks(content, flat);
    if (next === null) return undefined;
    return { ...args, content: next };
  }
  if (tool === 'patch') {
    const rebuilt = `*** Begin Patch\n${valid.map((i) => review.hunks[i]).join('\n')}\n*** End Patch`;
    return { ...args, patch: rebuilt };
  }
  return undefined;
}
