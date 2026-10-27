// Lazy file contents (MCH-lazy 14.1).
//
// Paths that used to load FULL file contents into context now serve a bounded
// slice — head + the region relevant to the task — and fetch further regions
// only on demand. Lazy means DEFERRED, not dropped: every slice records the
// source path + mtime/size revision at read time, and any deferred region
// fetch re-validates that revision first, so a file that changed after
// slicing is re-read fresh, never served stale (same staleness bar as the
// warm-daemon item 13, which rejected cross-task caching for exactly this
// reason). There is deliberately NO cross-task content cache here: state
// lives per call/run, nothing persists.
//
// Consumers: read tool (default window for large files), and any caller that
// wants task-relevant bounded slices instead of head-only windows.

import { readFileSync, statSync, existsSync } from 'node:fs';

/** Hard kill-switch (repo convention, cf. MOCHI_READ_RUN_STUB=0). */
export function lazyFileEnabled(): boolean {
  return process.env.MOCHI_LAZY_FILE !== '0';
}

/** Revision stamp for a file at slice time. mtime+size is the repo's
 *  staleness bar (readCache, warm daemon): a change to either forces a
 *  re-read. */
export interface FileRevision {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface SliceRange {
  start: number; // 1-based, inclusive
  end: number; // 1-based, inclusive
}

export interface SliceOptions {
  /** Task terms that locate the relevant region (identifiers, filenames…). */
  taskTerms?: string[];
  /** Lines kept from the top of the file (structure, imports, docs). */
  headLines?: number;
  /** Lines kept from the tail (exports, entry points). */
  tailLines?: number;
  /** Context lines kept around each task-term hit. */
  contextLines?: number;
  /** Hard char budget for the rendered slice. */
  maxChars?: number;
}

export interface FileSlice {
  path: string;
  rev: FileRevision;
  /** Numbered slice text with honest elision markers. */
  text: string;
  /** Ranges INCLUDED (1-based inclusive) — everything else was elided. */
  ranges: SliceRange[];
  totalLines: number;
  omittedLines: number;
  /** True when a task-term region was found and spliced in. */
  taskRegion: boolean;
}

export function statRevision(absPath: string): FileRevision | null {
  try {
    if (!existsSync(absPath)) return null;
    const st = statSync(absPath);
    if (st.isDirectory()) return null;
    return { path: absPath, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** True when the file on disk no longer matches the recorded revision. */
export function revisionChanged(absPath: string, rev: FileRevision): boolean {
  const now = statRevision(absPath);
  if (!now) return true; // vanished → treat as changed; callers surface the error
  return now.mtimeMs !== rev.mtimeMs || now.size !== rev.size;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split free text into lowercase term candidates (identifiers, path parts,
 *  quoted words). Shared shape with the loop's term mining. */
export function extractTaskTerms(task: string): string[] {
  const terms = new Set<string>();
  for (const m of task.matchAll(/[A-Za-z_][A-Za-z0-9_-]{3,}/g)) {
    const t = m[0];
    if (/^(the|and|for|with|this|that|then|when|your|you|should|must|into|from|file|line|lines|read|write|test|make|sure|please)$/.test(t.toLowerCase())) continue;
    terms.add(t);
  }
  return [...terms].slice(0, 40);
}

/** Rank a line's relevance: definitions first, then any term hit. */
function lineRelevance(line: string, termRes: RegExp[]): number {
  const isDef = /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|def|struct|impl|fn|public|private)\b/.test(line)
    || /(?:^|\s)(?:def|class)\s+\w/.test(line)
    || /^[#/*]/.test(line) === false && /\w+\s*[(:]\s*[)a-zA-Z]/.test(line) && /=>|\{\s*$/.test(line);
  let hits = 0;
  for (const re of termRes) if (re.test(line)) hits++;
  if (hits === 0) return 0;
  return isDef ? 2 + hits : 1 + hits;
}

interface Region {
  start: number;
  end: number;
  score: number;
}

/** Pure: pick head + tail + task-relevant regions from content. */
export function pickSliceRanges(
  content: string,
  opts: SliceOptions = {},
): { ranges: SliceRange[]; taskRegion: boolean } {
  const lines = content.split('\n');
  const total = lines.length;
  const headLines = Math.max(0, opts.headLines ?? 40);
  const tailLines = Math.max(0, opts.tailLines ?? 8);
  const ctx = Math.max(0, opts.contextLines ?? 4);

  const keep: Array<[number, number]> = [[1, Math.min(headLines, total)]];
  if (total > headLines + tailLines) keep.push([total - tailLines + 1, total]);

  let taskRegion = false;
  const terms = opts.taskTerms?.filter(Boolean) ?? [];
  if (terms.length > 0 && total > headLines + tailLines + 2 * ctx + 8) {
    const termRes = terms.map((t) => new RegExp(escapeRegExp(t), 'i'));
    const scored: Array<{ idx: number; score: number }> = [];
    for (let i = headLines; i < total - tailLines; i++) {
      const s = lineRelevance(lines[i], termRes);
      if (s > 0) scored.push({ idx: i, score: s });
    }
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      // Take the best hits (bounded: a slice, not the whole file).
      const chosen: Region[] = [];
      for (const c of scored.slice(0, 6)) {
        const start = Math.max(headLines + 1, c.idx - ctx + 1);
        const end = Math.min(total - tailLines, c.idx + ctx + 1);
        if (chosen.some((r) => start <= r.end + 1 && end >= r.start - 1)) {
          const hit = chosen.find((r) => start <= r.end + 1 && end >= r.start - 1)!;
          hit.start = Math.min(hit.start, start);
          hit.end = Math.max(hit.end, end);
          continue;
        }
        chosen.push({ start, end, score: c.score });
      }
      for (const r of chosen) keep.push([r.start, r.end]);
      taskRegion = true;
    }
  }

  // Merge + normalize.
  keep.sort((a, b) => a[0] - b[0]);
  const merged: SliceRange[] = [];
  for (const [s, e] of keep) {
    if (s > total) continue;
    const start = Math.max(1, s);
    const end = Math.min(total, e);
    if (merged.length > 0 && start <= merged[merged.length - 1]!.end + 1) {
      merged[merged.length - 1]!.end = Math.max(merged[merged.length - 1]!.end, end);
    } else {
      merged.push({ start, end });
    }
  }
  return { ranges: merged, taskRegion };
}

export interface RenderedSlice {
  text: string;
  ranges: SliceRange[];
  omittedLines: number;
  taskRegion: boolean;
}

/** Pure: render numbered slice lines with elision markers. */
export function renderSlice(
  path: string,
  content: string,
  rev: FileRevision,
  ranges: SliceRange[],
  taskRegion: boolean,
  maxChars = 20_000,
): RenderedSlice {
  const lines = content.split('\n');
  const total = lines.length;
  const kept = ranges.reduce((n, r) => n + (r.end - r.start + 1), 0);
  const omitted = Math.max(0, total - kept);
  const pad = String(total).length;
  const parts: string[] = [];
  let prev = 0;
  let chars = 0;
  let truncated = false;
  for (const r of ranges) {
    if (prev > 0 && r.start > prev + 1) {
      const gap = r.start - prev - 1;
      parts.push(`  … [${gap} line${gap === 1 ? '' : 's'} omitted — read with offset/limit to fetch] …`);
    }
    for (let i = r.start; i <= r.end; i++) {
      const line = `${String(i).padStart(pad, ' ')} | ${lines[i - 1] ?? ''}`;
      if (chars + line.length > maxChars && i > r.start) {
        truncated = true;
        break;
      }
      parts.push(line);
      chars += line.length + 1;
    }
    if (truncated) {
      parts.push(`  … [slice cut at char budget — fetch the rest with read offset/limit] …`);
      break;
    }
    prev = r.end;
  }
  const footer = taskRegion
    ? `\n[lazy slice of ${path}: lines ${ranges.map((r) => `${r.start}-${r.end}`).join(', ')} of ${total} total${truncated ? ', cut at budget' : ''}; rev mtime=${rev.mtimeMs} size=${rev.size}. Deferred regions fetch on demand: read { path, offset, limit }]`
    : `\n[lazy slice of ${path}: first ${Math.min(headOf(ranges), total)}… see ranges ${ranges.map((r) => `${r.start}-${r.end}`).join(', ')} of ${total} total${truncated ? ', cut at budget' : ''}. Fetch regions on demand: read { path, offset, limit }]`;
  return { text: parts.join('\n') + footer, ranges, omittedLines: omitted, taskRegion };
}

function headOf(ranges: SliceRange[]): number {
  return ranges[0]?.end ?? 0;
}

/** Read a file and produce the lazy slice, stamped with the revision it was
 *  read at. Pure disk read + slice — no caching across tasks. */
export function lazySliceFile(absPath: string, opts: SliceOptions = {}): FileSlice | null {
  const rev = statRevision(absPath);
  if (!rev) return null;
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const { ranges, taskRegion } = pickSliceRanges(content, opts);
  const rendered = renderSlice(absPath, content, rev, ranges, taskRegion, opts.maxChars ?? 20_000);
  return {
    path: absPath,
    rev,
    text: rendered.text,
    ranges: rendered.ranges,
    totalLines: content.split('\n').length,
    omittedLines: rendered.omittedLines,
    taskRegion,
  };
}

/** ON-DEMAND deferred region fetch. Re-validates the revision FIRST: when
 *  the file changed since the slice was taken (mtime/size), it re-reads the
 *  CURRENT content from disk and says so — a changed file is never served
 *  from the old bytes. This is the invalidation guarantee. */
export function lazySliceRegion(
  absPath: string,
  rev: FileRevision,
  start: number,
  end: number,
): { text: string; fresh: boolean; rev: FileRevision } | null {
  const changed = revisionChanged(absPath, rev);
  let content: string;
  let nowRev: FileRevision;
  try {
    content = readFileSync(absPath, 'utf8');
    nowRev = changed ? (statRevision(absPath) as FileRevision) : rev;
  } catch {
    return null;
  }
  const lines = content.split('\n');
  const s = Math.max(1, start);
  const e = Math.min(lines.length, Math.max(start, end));
  const pad = String(lines.length).length;
  const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(pad, ' ')} | ${l}`).join('\n');
  const note = changed
    ? `\n[fresh re-read: ${absPath} changed since the earlier slice (rev mtime=${rev.mtimeMs}→${nowRev.mtimeMs}, size=${rev.size}→${nowRev.size}) — the region above is CURRENT disk content, not the stale slice]`
    : `\n[${absPath} lines ${s}-${e} of ${lines.length} — unchanged since slice (rev mtime=${rev.mtimeMs}, size=${rev.size})]`;
  return { text: body + note, fresh: changed, rev: nowRev };
}
