// Multi-strategy edit application engine for the `edit` tool.
//
// The legacy pipeline was exact → whitespace-fuzzy → relaxed, and every
// non-exact stage collapsed "no match" and "too many matches" into the same
// opaque `oldText not found (exact and fuzzy match failed)` error. Real-world
// edit failures are mostly mundane drift — stale lines, an inserted log line,
// a renamed identifier — which a fixed-size sliding window cannot absorb
// (any line-count change misaligns every window), and the tolerant similarity
// stage silently disabled itself on large files.
//
// This engine makes the strategy ladder explicit and evidence-based:
//   1. exact      — verbatim substring; >1 occurrence is an ambiguity error.
//   2. normalized — whitespace-normalized line equality (legacy fuzzy stage).
//   3. relaxed    — normalized + quote unification + trailing-semicolon strip.
//   4. anchored   — the needle's first/last lines are anchors; candidate
//      spans between anchor occurrences are scored with a line-alignment DP
//      (so inserted/deleted/drifted lines inside the block are tolerated),
//      and a candidate is accepted only with a clear uniqueness margin.
// Every stage below exact must prove uniqueness; ambiguity is reported with
// the candidate sites, never guessed. A conflation guard refuses anchored
// matches whose drifted lines appear verbatim elsewhere in the file (the
// needle mixes two sites — the model must disambiguate). On total failure
// the engine returns near-miss regions with the first diverging line, so the
// model can repair its oldText in one retry instead of blind re-reads.
import { fuzzyFindUnique, normalizeLine, levenshtein } from './fuzzy-match.js';
import { fuzzyFindUniqueNative } from './native-match.js';

export type EditStrategy = 'exact' | 'normalized' | 'relaxed' | 'anchored';

export interface StrategyAttempt {
  strategy: EditStrategy;
  outcome: 'applied' | 'no-match' | 'ambiguous';
  detail?: string;
}

export interface SiteInfo {
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  preview: string; // first line of the region, trimmed
}

export interface NearMiss extends SiteInfo {
  similarity: number; // 0..1, two decimals
  divergence?: {
    needleLine: number; // 1-based within the needle block
    expected: string; // what the model sent
    actual: string; // what the file has
  };
}

export type ApplyEditResult =
  | {
      ok: true;
      start: number;
      end: number;
      strategy: EditStrategy;
      similarity?: number;
      attempts: StrategyAttempt[];
    }
  | {
      ok: false;
      failureKind: 'not-found' | 'ambiguous';
      attempts: StrategyAttempt[];
      /** Candidate sites when failureKind === 'ambiguous'. */
      sites: SiteInfo[];
      /** Closest regions when failureKind === 'not-found'. */
      nearMisses: NearMiss[];
      note?: string;
    };

// ─── line indexing ──────────────────────────────────────────────────────────

interface LineIndex {
  lines: string[];
  norm: string[];
  /** offsets[i] = char offset where line i starts. */
  offsets: number[];
}

function buildLineIndex(text: string): LineIndex {
  const lines = text.split('\n');
  const offsets: number[] = new Array(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = acc;
    acc += lines[i].length + 1;
  }
  return { lines, norm: lines.map(normalizeLine), offsets };
}

/** Char span covering lines [startLine0, endLine0Exclusive). The span does not
 *  include the final line's trailing newline (same convention as fuzzy-match). */
function spanOf(idx: LineIndex, startLine0: number, endLine0Exclusive: number): { start: number; end: number } {
  const start = idx.offsets[startLine0];
  const end = endLine0Exclusive < idx.lines.length ? idx.offsets[endLine0Exclusive] - 1 : start + sumLen(idx, startLine0, endLine0Exclusive);
  return { start, end: Math.max(start, end) };
}

function sumLen(idx: LineIndex, from: number, toExclusive: number): number {
  let n = 0;
  for (let k = from; k < toExclusive; k++) n += idx.lines[k].length + 1;
  return n - 1;
}

/** Split a needle into lines with \r\n normalized and blank edge lines dropped
 *  (mirrors fuzzy-match: models pad blocks with stray blank lines). */
function needleLinesOf(needle: string): string[] {
  const lines = needle.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

// ─── relaxed matching (moved from edit.ts; same semantics) ──────────────────

export function normalizeRelaxedLine(line: string): string {
  return line
    .trim()
    .replace(/["'`]/g, '"')
    .replace(/;+$/, '')
    .replace(/\s+/g, ' ');
}

type UniqueSpan =
  | { kind: 'unique'; start: number; end: number; startLine: number; endLine: number }
  | { kind: 'ambiguous'; sites: SiteInfo[] }
  | { kind: 'none' };

function scanNormalized(idx: LineIndex, needleNorm: string[], normalize: (l: string) => string): UniqueSpan {
  const textNorm = idx.lines.map(normalize);
  const spans: Array<{ i: number }> = [];
  for (let i = 0; i + needleNorm.length <= textNorm.length; i++) {
    let ok = true;
    for (let j = 0; j < needleNorm.length; j++) {
      if (textNorm[i + j] !== needleNorm[j]) { ok = false; break; }
    }
    if (ok) spans.push({ i });
  }
  if (spans.length === 0) return { kind: 'none' };
  if (spans.length > 1) {
    return {
      kind: 'ambiguous',
      sites: spans.slice(0, 6).map(({ i }) => ({
        startLine: i + 1,
        endLine: i + needleNorm.length,
        preview: idx.lines[i].trim().slice(0, 100),
      })),
    };
  }
  const i = spans[0].i;
  const { start, end } = spanOf(idx, i, i + needleNorm.length);
  return { kind: 'unique', start, end, startLine: i + 1, endLine: i + needleNorm.length };
}

// ─── anchored matching ──────────────────────────────────────────────────────

const ANCHOR_MIN_SCORE = 0.68;
const ANCHOR_MARGIN = 0.08;
const GAP_PENALTY = 0.35;
const MAX_SPAN_GROW = 3;
const MAX_SPAN_SHRINK = 2;
const MAX_ANCHOR_PAIRS = 64;


function simNorm(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  if (a.length > 1000 || b.length > 1000) return 0; // minified blobs: equality or nothing
  return Math.max(0, 1 - levenshtein(a, b) / maxLen);
}

interface Alignment {
  score: number; // 0..1, gap-penalized, normalized by needle length
  /** For each needle line: the file line (relative to span start) it aligned
   *  to, or -1 when the needle line was skipped (deleted in the file). */
  alignedFileLine: number[];
  /** Per-needle-line similarity at its aligned position (0 when skipped). */
  lineSims: number[];
}

/** Line-alignment DP (Needleman–Wunsch over lines) between the needle lines
 *  and a candidate file span. Tolerates inserted lines (file-side gaps),
 *  deleted lines (needle-side gaps) and drifted lines (low-sim pairings). */
function alignLines(needleNorm: string[], spanNorm: string[]): Alignment {
  const m = needleNorm.length;
  const n = spanNorm.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  const choice: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0)); // 0=diag 1=skip-needle 2=skip-file
  for (let i = 1; i <= m; i++) { dp[i][0] = -GAP_PENALTY * i; choice[i][0] = 1; }
  for (let j = 1; j <= n; j++) { dp[0][j] = -GAP_PENALTY * j; choice[0][j] = 2; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const diag = dp[i - 1][j - 1] + simNorm(needleNorm[i - 1], spanNorm[j - 1]);
      const skipN = dp[i - 1][j] - GAP_PENALTY;
      const skipF = dp[i][j - 1] - GAP_PENALTY;
      let best = diag; let ch = 0;
      if (skipN > best) { best = skipN; ch = 1; }
      if (skipF > best) { best = skipF; ch = 2; }
      dp[i][j] = best;
      choice[i][j] = ch;
    }
  }
  const alignedFileLine = new Array<number>(m).fill(-1);
  const lineSims = new Array<number>(m).fill(0);
  let i = m; let j = n;
  while (i > 0 || j > 0) {
    const ch = i > 0 && j > 0 ? choice[i][j] : (i > 0 ? 1 : 2);
    if (ch === 0 && i > 0 && j > 0) {
      alignedFileLine[i - 1] = j - 1;
      lineSims[i - 1] = simNorm(needleNorm[i - 1], spanNorm[j - 1]);
      i--; j--;
    } else if (ch === 1 && i > 0) {
      i--;
    } else if (j > 0) {
      j--;
    } else {
      i--;
    }
  }
  return { score: Math.max(0, dp[m][n] / Math.max(1, m)), alignedFileLine, lineSims };
}

interface AnchorCandidate {
  startLine0: number;
  endLine0: number; // inclusive
  score: number;
  alignment: Alignment;
}

function anchoredCandidates(idx: LineIndex, needleNorm: string[]): AnchorCandidate[] | 'no-anchors' {
  const m = needleNorm.length;
  const firstAnchor = needleNorm[0];
  const lastAnchor = needleNorm[m - 1];
  const firstOcc: number[] = [];
  const lastOcc: number[] = [];
  for (let i = 0; i < idx.norm.length; i++) {
    if (idx.norm[i] === firstAnchor) firstOcc.push(i);
    if (idx.norm[i] === lastAnchor) lastOcc.push(i);
  }
  const scoreSpan = (i: number, j: number): AnchorCandidate => {
    const alignment = alignLines(needleNorm, idx.norm.slice(i, j + 1));
    return { startLine0: i, endLine0: j, score: alignment.score, alignment };
  };
  if (firstOcc.length > 0 && lastOcc.length > 0) {
    const pairs: Array<[number, number]> = [];
    for (const i of firstOcc) {
      for (const j of lastOcc) {
        const span = j - i + 1;
        if (j <= i) continue;
        if (span - m > MAX_SPAN_GROW || m - span > MAX_SPAN_SHRINK) continue;
        pairs.push([i, j]);
        if (pairs.length >= MAX_ANCHOR_PAIRS) break;
      }
      if (pairs.length >= MAX_ANCHOR_PAIRS) break;
    }
    if (pairs.length > 0) return pairs.map(([i, j]) => scoreSpan(i, j));
  }
  // Fallback: the first/last lines themselves drifted (e.g. a typo in the
  // signature line). Use needle lines that occur EXACTLY ONCE in the file
  // as interior anchors and search a bounded neighborhood of spans around
  // each implied position. The DP score + margin + conflation guard still
  // gate acceptance, so a wider candidate net does not weaken the proof.
  const seen = new Set<string>();
  const out: AnchorCandidate[] = [];
  for (let j = 0; j < m && out.length < MAX_ANCHOR_PAIRS; j++) {
    const occ: number[] = [];
    for (let i = 0; i < idx.norm.length; i++) if (idx.norm[i] === needleNorm[j]) occ.push(i);
    if (occ.length !== 1) continue;
    const f = occ[0];
    for (let ds = -MAX_SPAN_SHRINK; ds <= MAX_SPAN_GROW && out.length < MAX_ANCHOR_PAIRS; ds++) {
      const s = f - j + ds;
      if (s < 0) continue;
      for (let L = Math.max(1, m - MAX_SPAN_SHRINK); L <= m + MAX_SPAN_GROW; L++) {
        const e = s + L - 1;
        if (e >= idx.lines.length || e <= s) continue;
        const key = `${s}:${e}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(scoreSpan(s, e));
        if (out.length >= MAX_ANCHOR_PAIRS) break;
      }
    }
  }
  return out.length > 0 ? out : 'no-anchors';
}

type AnchoredOutcome =
  | { kind: 'unique'; cand: AnchorCandidate }
  | { kind: 'ambiguous'; sites: SiteInfo[]; reason: string }
  | { kind: 'none'; best?: AnchorCandidate };

function anchoredFind(idx: LineIndex, needleNorm: string[]): AnchoredOutcome {
  const m = needleNorm.length;
  if (m === 1) {
    // Single-line needle: tolerant per-line search (the legacy tolerant stage
    // covered this, but with a whole-file work bound that disabled it on big
    // files; a per-line scan is bounded by total line count).
    let best = -1; let bestSim = 0; let secondSim = 0;
    const tied: number[] = [];
    for (let i = 0; i < idx.lines.length; i++) {
      const s = simNorm(idx.norm[i], needleNorm[0]);
      if (s > bestSim) { secondSim = bestSim; bestSim = s; best = i; tied.length = 0; tied.push(i); }
      else if (s === bestSim && s > 0) tied.push(i);
      else if (s > secondSim) secondSim = s;
    }
    if (best === -1 || bestSim < 0.85) return { kind: 'none' };
    if (tied.length > 1 || bestSim - secondSim < 0.1) {
      return {
        kind: 'ambiguous',
        reason: `single line matches ${tied.length > 1 ? tied.length + ' lines' : 'multiple lines'} at similarity ${bestSim.toFixed(2)}`,
        sites: (tied.length > 1 ? tied : [best]).slice(0, 6).map((i) => ({ startLine: i + 1, endLine: i + 1, preview: idx.lines[i].trim().slice(0, 100) })),
      };
    }
    return {
      kind: 'unique',
      cand: { startLine0: best, endLine0: best, score: bestSim, alignment: { score: bestSim, alignedFileLine: [0], lineSims: [bestSim] } },
    };
  }

  const cands = anchoredCandidates(idx, needleNorm);
  if (cands === 'no-anchors' || cands.length === 0) return { kind: 'none' };
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  // The uniqueness margin is measured against DISJOINT regions only: span
  // variants of the same region (a boundary off by one line, an extra gap)
  // are the same site described worse, not a competing site.
  const second = sorted.find((c) => c.startLine0 > best.endLine0 || c.endLine0 < best.startLine0);
  if (best.score < ANCHOR_MIN_SCORE) return { kind: 'none', best };
  if (second && second.score >= ANCHOR_MIN_SCORE && best.score - second.score < ANCHOR_MARGIN && second.score >= 0.5) {
    return {
      kind: 'ambiguous',
      reason: `two regions match at similarity ${best.score.toFixed(2)} and ${second.score.toFixed(2)}`,
      sites: [best, second].map((c) => ({
        startLine: c.startLine0 + 1,
        endLine: c.endLine0 + 1,
        preview: idx.lines[c.startLine0].trim().slice(0, 100),
      })),
    };
  }

  // Conflation guard: a needle line that is NOT verbatim at its aligned
  // position inside the chosen span (similarity < 1, or skipped by the
  // alignment) but appears VERBATIM somewhere else in the file means the
  // needle mixes two sites (e.g. one function's margin inside another's
  // body — the line can be 0.93-similar to its aligned site and still have
  // its true home elsewhere). Refuse and point at both places — the model
  // must disambiguate. Lines that are verbatim at their aligned site are
  // exempt no matter how often they recur (braces, shared idioms).
  const inSpan = new Set<number>();
  for (let k = best.startLine0; k <= best.endLine0; k++) inSpan.add(k);
  for (let j = 0; j < m; j++) {
    if (best.alignment.lineSims[j] >= 0.999) continue;
    const elsewhere = idx.norm.findIndex((l, li) => l === needleNorm[j] && !inSpan.has(li));
    if (elsewhere !== -1) {
      return {
        kind: 'ambiguous',
        reason: `needle line ${j + 1} ("${needleNorm[j].slice(0, 60)}") does not match inside the anchored region but appears verbatim at line ${elsewhere + 1} — the block may mix two sites`,
        sites: [
          { startLine: best.startLine0 + 1, endLine: best.endLine0 + 1, preview: idx.lines[best.startLine0].trim().slice(0, 100) },
          { startLine: elsewhere + 1, endLine: elsewhere + 1, preview: idx.lines[elsewhere].trim().slice(0, 100) },
        ],
      };
    }
  }
  return { kind: 'unique', cand: best };
}

// ─── near misses (failure diagnostics) ──────────────────────────────────────

function divergenceOf(idx: LineIndex, cand: AnchorCandidate, needleNorm: string[], needleRaw: string[]): NearMiss {
  let divergence: NearMiss['divergence'];
  for (let j = 0; j < needleNorm.length; j++) {
    if (cand.alignment.lineSims[j] < 0.99) {
      const fileRel = cand.alignment.alignedFileLine[j];
      divergence = {
        needleLine: j + 1,
        expected: needleRaw[j].trim().slice(0, 120),
        actual: fileRel >= 0 ? idx.lines[cand.startLine0 + fileRel].trim().slice(0, 120) : '(line absent in file)',
      };
      break;
    }
  }
  return {
    startLine: cand.startLine0 + 1,
    endLine: cand.endLine0 + 1,
    preview: idx.lines[cand.startLine0].trim().slice(0, 100),
    similarity: Math.round(cand.score * 100) / 100,
    divergence,
  };
}

function findNearMisses(idx: LineIndex, needleNorm: string[], needleRaw: string[]): NearMiss[] {
  const m = needleNorm.length;
  const fromAnchors = anchoredCandidates(idx, needleNorm);
  if (fromAnchors !== 'no-anchors' && fromAnchors.length > 0) {
    return [...fromAnchors]
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .filter((c) => c.score >= 0.3)
      .map((c) => divergenceOf(idx, c, needleNorm, needleRaw));
  }
  // No anchors at all: bounded sliding-window scan over fixed spans.
  const misses: NearMiss[] = [];
  const work = Math.max(0, idx.lines.length - m + 1) * m;
  if (work <= 400_000) {
    const scored: Array<{ i: number; score: number }> = [];
    for (let i = 0; i + m <= idx.lines.length; i++) {
      let total = 0;
      for (let j = 0; j < m; j++) total += simNorm(idx.norm[i + j], needleNorm[j]);
      scored.push({ i, score: total / m });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored) {
      if (s.score < 0.35) break;
      if (misses.some((mm) => Math.abs(mm.startLine - 1 - s.i) < m)) continue;
      let divergence: NearMiss['divergence'];
      for (let j = 0; j < m; j++) {
        if (simNorm(idx.norm[s.i + j], needleNorm[j]) < 0.99) {
          divergence = {
            needleLine: j + 1,
            expected: needleRaw[j].trim().slice(0, 120),
            actual: idx.lines[s.i + j].trim().slice(0, 120),
          };
          break;
        }
      }
      misses.push({
        startLine: s.i + 1,
        endLine: s.i + m,
        preview: idx.lines[s.i].trim().slice(0, 100),
        similarity: Math.round(s.score * 100) / 100,
        divergence,
      });
      if (misses.length >= 2) break;
    }
  }
  return misses;
}

// ─── the ladder ─────────────────────────────────────────────────────────────

/**
 * Apply the strategy ladder to find where `oldText` lives in `content`.
 * Returns the winning span + strategy + per-stage attempts, or a structured
 * failure (kind, candidate sites / near misses) for the tool to report.
 */
export function applyEdit(content: string, oldText: string): ApplyEditResult {
  const attempts: StrategyAttempt[] = [];
  const idx = buildLineIndex(content);
  const needleRaw = needleLinesOf(oldText);
  const needleNorm = needleRaw.map(normalizeLine);

  // 1. exact
  const occurrences: number[] = [];
  if (oldText.length > 0) {
    let pos = 0;
    while (true) {
      const found = content.indexOf(oldText, pos);
      if (found === -1) break;
      occurrences.push(found);
      pos = found + Math.max(1, oldText.length);
    }
  }
  if (occurrences.length === 1) {
    attempts.push({ strategy: 'exact', outcome: 'applied' });
    return { ok: true, start: occurrences[0], end: occurrences[0] + oldText.length, strategy: 'exact', attempts };
  }
  if (occurrences.length > 1) {
    attempts.push({ strategy: 'exact', outcome: 'ambiguous', detail: `${occurrences.length} verbatim occurrences` });
    return {
      ok: false,
      failureKind: 'ambiguous',
      attempts,
      sites: occurrences.slice(0, 6).map((o) => {
        const line = content.slice(0, o).split('\n').length;
        return { startLine: line, endLine: line + needleRaw.length - 1, preview: (content.slice(o).split('\n')[0] ?? '').trim().slice(0, 100) };
      }),
      nearMisses: [],
      note: 'verbatim',
    };
  }
  attempts.push({ strategy: 'exact', outcome: 'no-match' });

  if (needleNorm.length === 0) {
    return { ok: false, failureKind: 'not-found', attempts, sites: [], nearMisses: [] };
  }

  let firstAmbiguity: { strategy: EditStrategy; sites: SiteInfo[]; reason?: string } | null = null;

  // 2. normalized (whitespace-tolerant line equality) — native-accelerated
  // first for parity with the legacy path; a TS scan classifies ambiguity
  // when the matcher returns null (it cannot distinguish none vs many).
  const fuzzy = fuzzyFindUniqueNative(content, oldText) ?? fuzzyFindUnique(content, oldText);
  if (fuzzy) {
    attempts.push({ strategy: 'normalized', outcome: 'applied' });
    return { ok: true, start: fuzzy.start, end: fuzzy.end, strategy: 'normalized', attempts };
  }
  const normScan = scanNormalized(idx, needleNorm, normalizeLine);
  if (normScan.kind === 'ambiguous') {
    attempts.push({ strategy: 'normalized', outcome: 'ambiguous', detail: `${normScan.sites.length}+ sites after whitespace normalization` });
    firstAmbiguity = { strategy: 'normalized', sites: normScan.sites };
  } else {
    attempts.push({ strategy: 'normalized', outcome: 'no-match' });
  }

  // 3. relaxed (quotes / trailing semicolons unified)
  const relaxedNorm = needleRaw.map(normalizeRelaxedLine);
  const relaxedScan = scanNormalized(idx, relaxedNorm, normalizeRelaxedLine);
  if (relaxedScan.kind === 'unique') {
    attempts.push({ strategy: 'relaxed', outcome: 'applied' });
    return { ok: true, start: relaxedScan.start, end: relaxedScan.end, strategy: 'relaxed', attempts };
  }
  if (relaxedScan.kind === 'ambiguous') {
    attempts.push({ strategy: 'relaxed', outcome: 'ambiguous', detail: `${relaxedScan.sites.length}+ sites after relaxed normalization` });
    firstAmbiguity ??= { strategy: 'relaxed', sites: relaxedScan.sites };
  } else {
    attempts.push({ strategy: 'relaxed', outcome: 'no-match' });
  }

  // 4. anchored (anchor lines + alignment DP; tolerates drift inside the block)
  const anchored = anchoredFind(idx, needleNorm);
  if (anchored.kind === 'unique') {
    const { start, end } = spanOf(idx, anchored.cand.startLine0, anchored.cand.endLine0 + 1);
    // A merely-normalized ambiguity can only be overridden by a very strong
    // anchored candidate; anything weaker keeps the ambiguity verdict.
    if (firstAmbiguity && !(anchored.cand.score >= 0.9)) {
      attempts.push({ strategy: 'anchored', outcome: 'ambiguous', detail: `anchored candidate at lines ${anchored.cand.startLine0 + 1}–${anchored.cand.endLine0 + 1} (similarity ${anchored.cand.score.toFixed(2)}) does not override the ${firstAmbiguity.strategy} ambiguity` });
    } else {
      attempts.push({ strategy: 'anchored', outcome: 'applied', detail: `similarity ${anchored.cand.score.toFixed(2)}` });
      return { ok: true, start, end, strategy: 'anchored', similarity: anchored.cand.score, attempts };
    }
  } else if (anchored.kind === 'ambiguous') {
    attempts.push({ strategy: 'anchored', outcome: 'ambiguous', detail: anchored.reason });
    firstAmbiguity ??= { strategy: 'anchored', sites: anchored.sites, reason: anchored.reason };
  } else {
    attempts.push({ strategy: 'anchored', outcome: 'no-match', detail: anchored.best ? `best anchored similarity ${anchored.best.score.toFixed(2)} < ${ANCHOR_MIN_SCORE}` : 'no anchor lines found verbatim' });
  }

  if (firstAmbiguity) {
    return {
      ok: false,
      failureKind: 'ambiguous',
      attempts,
      sites: firstAmbiguity.sites,
      nearMisses: [],
      note: firstAmbiguity.reason ?? `ambiguous after ${firstAmbiguity.strategy} matching`,
    };
  }
  return {
    ok: false,
    failureKind: 'not-found',
    attempts,
    sites: [],
    nearMisses: findNearMisses(idx, needleNorm, needleRaw),
  };
}

/** Backwards-compatible wrapper matching the legacy findRelaxedUnique
 *  contract (unique span or null), now backed by the classified scan. */
export function findRelaxedUnique(text: string, needle: string): { start: number; end: number } | null {
  const needleRaw = needleLinesOf(needle);
  if (needleRaw.length === 0) return null;
  const idx = buildLineIndex(text);
  const scan = scanNormalized(idx, needleRaw.map(normalizeRelaxedLine), normalizeRelaxedLine);
  return scan.kind === 'unique' ? { start: scan.start, end: scan.end } : null;
}
