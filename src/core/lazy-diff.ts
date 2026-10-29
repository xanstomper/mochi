// Lazy diffs (MCH-lazy 14.2).
//
// Diff/patch presentation defaults to a compact summary — files changed,
// hunk count, per-file line deltas — with the full hunks available on
// demand (recompute the diff deterministically, or recall the archived full
// text). Lazy means DEFERRED, not dropped: the summary states exactly what
// was elided and how to fetch it, and a hunk that carries a failure or a
// requested change is NEVER truncated away silently — either it stays in
// the summary or the output carries an explicit truncation marker.

/** Kill-switch (repo convention): MOCHI_LAZY_DIFF=0 restores full diffs. */
export function lazyDiffEnabled(): boolean {
  return process.env.MOCHI_LAZY_DIFF !== '0';
}

export interface DiffFileSummary {
  file: string;
  added: number;
  deleted: number;
  hunks: number;
  binary: boolean;
}

export interface DiffSummary {
  files: DiffFileSummary[];
  totalFiles: number;
  totalHunks: number;
  totalAdded: number;
  totalDeleted: number;
  /** Hunk lines whose text carries failure/request markers. */
  markedHunks: string[];
}

// A hunk carrying one of these markers must never be elided without an
// explicit truncation marker in the presentation.
const MARKER_RE =
  /\b(error|fail(?:ed|ure|ing)?|assert(?:ion)?|expect(?:ed)?|panic|fixme|todo|must|regression|security|vulnerab)\b/i;

/** Pure: parse a unified diff (git-style `diff --git` headers OR plain
 *  `---`/`+++` label pairs) into per-file summaries. */
export function summarizeUnifiedDiff(diffText: string): DiffSummary {
  const files: DiffFileSummary[] = [];
  const markedHunks: string[] = [];
  let cur: DiffFileSummary | null = null;
  let inHunk = false;
  let pendingMinus: string | null = null;

  const cleanPath = (raw: string): string =>
    raw.replace(/\t.*$/, '').replace(/^[ab]\//, '').trim();

  for (const line of diffText.split('\n')) {
    const gitMatch = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (gitMatch) {
      cur = { file: gitMatch[2], added: 0, deleted: 0, hunks: 0, binary: false };
      files.push(cur);
      pendingMinus = null;
      inHunk = false;
      continue;
    }
    if (/^--- /.test(line)) {
      pendingMinus = cleanPath(line.slice(4));
      inHunk = false;
      continue;
    }
    if (/^\+\+\+ /.test(line) && (pendingMinus !== null || cur === null)) {
      const p = cleanPath(line.slice(4));
      // A `+++` header opens a file section — unless the current file was
      // already opened by its `diff --git` header for the same path.
      const alreadyOpenedForP = cur !== null && files[files.length - 1] === cur && cur.file === p && cur.hunks === 0 && cur.added === 0 && cur.deleted === 0;
      if (!alreadyOpenedForP) {
        cur = { file: p, added: 0, deleted: 0, hunks: 0, binary: false };
        files.push(cur);
      }
      pendingMinus = null;
      inHunk = false;
      continue;
    }
    if (/^Binary files .* differ$/.test(line)) {
      const m = /Binary files (?:a\/)?(.*) and (?:b\/)?(.*) differ$/.exec(line);
      const bPath = m ? m[2] : '(binary)';
      const aPath = m ? m[1] : null;
      // When the current file section IS this binary file (its git header or
      // ---/+++ pair), mark it binary instead of opening a phantom file.
      const isCurrentSection = cur !== null && files[files.length - 1] === cur && cur.hunks === 0 && cur.added === 0 && cur.deleted === 0 && (cur.file === bPath || (aPath !== null && cur.file === aPath));
      if (!isCurrentSection) {
        cur = { file: bPath, added: 0, deleted: 0, hunks: 0, binary: true };
        files.push(cur);
      } else if (cur) {
        cur.binary = true;
      }
      inHunk = false;
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      if (!cur) {
        cur = { file: '(unknown file)', added: 0, deleted: 0, hunks: 0, binary: false };
        files.push(cur);
      }
      cur.hunks++;
      inHunk = true;
      continue;
    }
    if (!cur) continue;
    if (inHunk) {
      if (MARKER_RE.test(line)) markedHunks.push(line.trim().slice(0, 200));
      if (line.startsWith('+')) cur.added++;
      else if (line.startsWith('-')) cur.deleted++;
    }
  }

  return {
    files,
    totalFiles: files.length,
    totalHunks: files.reduce((n, f) => n + f.hunks, 0),
    totalAdded: files.reduce((n, f) => n + f.added, 0),
    totalDeleted: files.reduce((n, f) => n + f.deleted, 0),
    markedHunks,
  };
}

/** Render the compact presentation. `recoveryHint` tells the model how to
 *  fetch the full hunks (tool-specific). */
export function renderDiffSummary(s: DiffSummary, recoveryHint: string): string {
  if (s.totalFiles === 0) return 'No changes.';
  const lines: string[] = [
    `[lazy diff: ${s.totalFiles} file${s.totalFiles === 1 ? '' : 's'} changed, ${s.totalHunks} hunk${s.totalHunks === 1 ? '' : 's'}, +${s.totalAdded}/-${s.totalDeleted} lines]`,
  ];
  const pad = Math.max(...s.files.map((f) => Math.min(f.file.length, 60)));
  for (const f of s.files) {
    const name = f.file.length > 60 ? '…' + f.file.slice(-59) : f.file;
    const delta = f.binary ? ' (binary)' : ` +${f.added}/-${f.deleted}`;
    lines.push(`  ${name.padEnd(pad)}${delta}${f.hunks ? ` (${f.hunks} hunk${f.hunks === 1 ? '' : 's'})` : ''}`);
  }
  if (s.markedHunks.length > 0) {
    lines.push('');
    lines.push(`[hunks carry marked lines (${s.markedHunks.length}); sample:]`);
    for (const m of s.markedHunks.slice(0, 5)) lines.push(`  ${m}`);
  }
  lines.push(recoveryHint);
  return lines.join('\n');
}

export interface LazyDiffOptions {
  /** Present the full hunks instead of the summary. */
  full?: boolean;
  /** How the model fetches the elided hunks. */
  recoveryHint?: string;
  /** Char budget for the full presentation when full=true (never silent). */
  maxFullChars?: number;
}

export interface LazyDiffResult {
  text: string;
  summary: DiffSummary;
  /** true when the caller asked for (and got) full hunks. */
  expanded: boolean;
  /** true when even the FULL presentation had to cut (always marked). */
  truncated: boolean;
}

/** The laziness boundary: summary by default, full on demand. Even in full
 *  mode an oversized diff is cut with an EXPLICIT marker (never silently),
 *  and hunks carrying failure/request markers are stated when elided. */
export function lazyDiff(diffText: string, opts: LazyDiffOptions = {}): LazyDiffResult {
  const summary = summarizeUnifiedDiff(diffText);
  if (opts.full) {
    const max = opts.maxFullChars ?? 48_000;
    if (diffText.length <= max) {
      return { text: diffText, summary, expanded: true, truncated: false };
    }
    const hint = opts.recoveryHint ?? 'narrow the diff path to fetch the rest';
    const text =
      diffText.slice(0, max) +
      `\n[LAZY DIFF TRUNCATION MARKER: full hunks cut at ${max} chars of ${diffText.length} total. ` +
      (summary.markedHunks.length > 0
        ? `${summary.markedHunks.length} marked hunk line(s) (error/fail/request markers) were among the elided content: ${summary.markedHunks.slice(0, 3).join(' | ')}. `
        : '') +
      hint + ']';
    return { text, summary, expanded: true, truncated: true };
  }
  const hint = opts.recoveryHint ?? 'expand on demand';
  return { text: renderDiffSummary(summary, hint), summary, expanded: false, truncated: false };
}
