// MCH-49: Aider-style repo-map. PageRank over the codegraph symbol graph,
// aggregated to file level, to surface the structurally most important files
// for context selection. Read-only over the existing codegraph SQLite tables
// (calls + relations + symbols); degrades to empty when the index is
// unavailable (no sqlite, light mode, no languages indexed).
//
// P1.2: task-conditioned selection. repoMap()/repoMapText() keep the original
// global behaviour (prefetch and other consumers depend on it). The new
// taskRepoMap()/taskRepoMapText() rank files for ONE task by combining:
//   (a) global PageRank importance (structural hubs still matter),
//   (b) lexical relevance of the file path + its symbol names to the task
//       terms (identifier-split tokenization shared with memory relevance),
//   (c) a 1-hop codegraph neighbourhood boost: files adjacent (call edge in
//       either direction) to the strongest lexical hits inherit decayed
//       relevance, so the feature's collaborators surface with it.
// Selected files render WITH their key symbol signatures (first line of the
// codegraph body) instead of bare names, inside a hard char budget comparable
// to the old names-only section — signatures replace names within the budget,
// they do not grow it unboundedly.
//
// NOTE (future slot): a fast-model rerank in Codebuff's style (cheap model
// picks from the top ~30 deterministic candidates) could be layered on top of
// taskRepoMap's ordering. The default path deliberately makes NO model call:
// deterministic scoring is free, sub-millisecond-to-milliseconds, and keeps
// task start latency and prompt construction cache-friendly.
import { isAbsolute, relative } from 'node:path';
import { hasSqlite, querySymbolGraphSync } from './codegraph.js';
import { tokenize } from '../memory/relevance.js';

export interface RepoMapEntry {
  file: string;
  rank: number;
}

const DAMPING = 0.85;
const ITERATIONS = 20;
const TOP_K = 15;

// --- task-conditioned scoring weights (documented in taskRepoMap) ---
const W_PAGERANK = 0.2;
const W_LEXICAL = 1.0;
const W_NEIGHBOR = 0.5;
const NEIGHBOR_DECAY = 0.6;
const SEED_COUNT = 10;
const MAX_SIGNATURES = 3;
/** Aider repomap.py:519 — PageRank multiplier for files in the chat. */
const CHAT_FILE_MULT = 50;
/** Hard char budget for the rendered task-conditioned section. The old
 *  names-only section ran ~0.6–0.9K chars on real repos; this caps the
 *  richer section at roughly 2x that, and the renderer never exceeds it. */
export const TASK_REPO_MAP_MAX_CHARS = 1600;

interface FileGraph {
  /** Normalized PageRank per file (top file = 1.0); only edge participants. */
  ranks: Map<string, number>;
  /** Undirected file<->file adjacency from call edges (either direction). */
  adjacency: Map<string, Set<string>>;
}

function normRel(rel: string): string {
  return (rel ?? '').replace(/^\.\//, '');
}

/**
 * Load the file-level call graph + PageRank for `cwd`. Returns null when the
 * codegraph is unavailable or has no call edges (the historical repoMap
 * empty case).
 */
function loadFileGraph(cwd: string): FileGraph | null {
  if (!hasSqlite()) return null;
  // calls rows: (callee symbol, caller symbol, rel = relative path of the file
  // where the call appears). callee is a bare symbol name, so we resolve
  // callee -> defining file via the symbols table to get file-to-file edges.
  let rows: Array<{ callee: string; caller: string; rel: string }>;
  let defs: Array<{ name: string; rel: string }>;
  try {
    const q = querySymbolGraphSync(cwd, 'SELECT callee, caller, rel FROM calls', 200000);
    if (!q || !('rows' in q)) return null;
    rows = q.rows as Array<{ callee: string; caller: string; rel: string }>;
    const d = querySymbolGraphSync(cwd, 'SELECT DISTINCT name, rel FROM symbols', 200000);
    defs = d && 'rows' in d ? (d.rows as Array<{ name: string; rel: string }>) : [];
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const defFile = new Map<string, string>();
  for (const s of defs) {
    const rel = normRel(s.rel);
    if (rel && !defFile.has(s.name)) defFile.set(s.name, rel);
  }

  // Build file-level adjacency: caller file -> callee definition file votes.
  const out = new Map<string, Map<string, number>>();
  const files = new Set<string>();
  for (const r of rows) {
    const callerFile = normRel(r.rel);
    const calleeFile = defFile.get(r.callee);
    if (!callerFile || !calleeFile || callerFile === calleeFile) continue;
    files.add(callerFile);
    files.add(calleeFile);
    let m = out.get(callerFile);
    if (!m) { m = new Map(); out.set(callerFile, m); }
    m.set(calleeFile, (m.get(calleeFile) ?? 0) + 1);
  }
  if (files.size === 0) return null;

  // Aider repomap.py:512 — scale repeated-reference counts down with sqrt so
  // high-frequency (low-value) mentions don't dominate the edge weights.
  for (const dsts of Array.from(out.values())) {
    for (const [dst, w] of Array.from(dsts.entries())) dsts.set(dst, Math.sqrt(w));
  }

  // PageRank.
  const ids = Array.from(files);
  const idx = new Map<string, number>(ids.map((f, i) => [f, i]));
  const n = ids.length;
  let rank = new Array<number>(n).fill(1 / n);
  const outTotal = new Array<number>(n).fill(0);
  const edges: Array<[number, number, number]> = [];
  for (const src of Array.from(out.keys())) {
    const dsts = out.get(src)!;
    let total = 0;
    for (const w of Array.from(dsts.values())) total += w;
    if (total === 0) continue;
    outTotal[idx.get(src)!] = total;
    for (const dst of Array.from(dsts.keys())) {
      const w = dsts.get(dst)!;
      edges.push([idx.get(src)!, idx.get(dst)!, w / total]);
    }
  }

  for (let it = 0; it < ITERATIONS; it++) {
    const next = new Array<number>(n).fill((1 - DAMPING) / n);
    for (const [s, d, w] of edges) next[d] += DAMPING * rank[s] * w;
    // Dangling nodes (no out-edges) redistribute uniformly.
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outTotal[i] === 0) dangling += rank[i];
    if (dangling > 0) {
      const share = (DAMPING * dangling) / n;
      for (let i = 0; i < n; i++) next[i] += share;
    }
    rank = next;
  }

  const max = Math.max(...rank);
  const ranks = new Map<string, number>();
  ids.forEach((file, i) => ranks.set(file, max > 0 ? rank[i] / max : 0));

  // Undirected adjacency for the neighbourhood boost.
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = adjacency.get(a);
    if (!s) { s = new Set(); adjacency.set(a, s); }
    s.add(b);
  };
  for (const [src, dsts] of Array.from(out.entries())) {
    for (const dst of Array.from(dsts.keys())) { link(src, dst); link(dst, src); }
  }

  return { ranks, adjacency };
}

/**
 * Compute file-level PageRank for the repo at `cwd` from codegraph call
 * edges. Each call edge (caller file -> callee file) is a vote; rank flows
 * along edges. Returns up to TOP_K files sorted by rank descending, with
 * relative ranks normalized so the top file is 1.0.
 */
export function repoMap(cwd: string, topK = TOP_K): RepoMapEntry[] {
  const graph = loadFileGraph(cwd);
  if (!graph) return [];
  return Array.from(graph.ranks.entries())
    .map(([file, rank]) => ({ file, rank }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, topK);
}

/** Render the repo map as a compact context block for the model. */
export function repoMapText(cwd: string, topK = TOP_K): string | undefined {
  const entries = repoMap(cwd, topK);
  if (entries.length === 0) return undefined;
  const lines = entries.map((e) => `- ${e.file} (${e.rank.toFixed(2)})`);
  return `REPO MAP (structural importance, PageRank over the symbol graph — touch these first when planning):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// P1.2: task-conditioned repo map
// ---------------------------------------------------------------------------

export interface RepoMapSymbol {
  name: string;
  kind: string;
  /** First line of the symbol's codegraph body (the declaration/signature
   *  line), whitespace-collapsed and clipped; `${kind} ${name}` when the
   *  graph has no body for the symbol. */
  signature: string;
}

export interface TaskRepoMapEntry {
  file: string;
  /** Global PageRank (normalized, top = 1.0); 0 for files outside the graph. */
  rank: number;
  /** Combined task-conditioned score, normalized so the top entry is 1.0. */
  score: number;
  /** Lexical relevance component (0..1) before weighting. */
  lexical: number;
  /** Key symbols defined in this file, best first, with signature lines. */
  symbols: RepoMapSymbol[];
}

export interface TaskRepoMapOptions {
  /** Free-form task text (title + description). */
  task: string;
  /** Coarse task kind (classifyTaskKind output); only used for a small
   *  test-file tilt on test tasks. */
  kind?: string;
  topK?: number;
  /** Aider repomap.py:374/519 — files already in the working set (read or
   *  edited this session) get a ×50 PageRank personalization multiplier so
   *  the map anchors on what the agent is actively touching. */
  chatFiles?: string[];
}

interface SymbolLite { name: string; kind: string; rel: string; line: number }

function loadSymbolsLite(cwd: string): SymbolLite[] {
  try {
    const q = querySymbolGraphSync(cwd, 'SELECT name, kind, rel, line FROM symbols', 200000);
    if (!q || !('rows' in q)) return [];
    return (q.rows as Array<{ name: string; kind: string; rel: string; line: number }>)
      .map((r) => ({ name: r.name, kind: r.kind, rel: normRel(r.rel), line: r.line ?? 0 }))
      .filter((r) => r.name && r.rel);
  } catch {
    return [];
  }
}

/** Fraction of query terms present in the candidate's token set. 0..1. */
function termOverlap(terms: Set<string>, candidateTokens: string[]): number {
  if (terms.size === 0 || candidateTokens.length === 0) return 0;
  const cand = new Set(candidateTokens);
  let hits = 0;
  for (const t of Array.from(terms)) if (cand.has(t)) hits++;
  return hits / terms.size;
}

const KIND_PRIORITY: Record<string, number> = {
  class: 0, interface: 0, enum: 0,
  type: 1, function: 1,
  method: 2, constructor: 2,
};

function signatureOf(body: string | undefined, name: string, kind: string): string {
  if (body) {
    const first = body.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
    if (first) {
      const flat = first.replace(/\s+/g, ' ');
      return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
    }
  }
  return `${kind} ${name}`;
}

/** Fetch bodies for the selected files only and build their signature lists:
 *  task-matching symbols first, then declaration-kind priority, then line. */
function attachSignatures(
  cwd: string,
  entries: TaskRepoMapEntry[],
  terms: Set<string>,
  symbolsByFile: Map<string, SymbolLite[]>,
): void {
  if (entries.length === 0) return;
  const bodies = new Map<string, string>();
  try {
    const inList = entries.map((e) => `'${e.file.replace(/'/g, "''")}'`).join(',');
    const q = querySymbolGraphSync(
      cwd,
      `SELECT name, rel, body FROM symbols WHERE rel IN (${inList})`,
      200000,
    );
    if (q && 'rows' in q) {
      for (const r of q.rows as Array<{ name: string; rel: string; body: string }>) {
        const key = `${normRel(r.rel)}${r.name}`;
        if (!bodies.has(key)) bodies.set(key, r.body ?? '');
      }
    }
  } catch { /* signatures fall back to `${kind} ${name}` */ }

  for (const e of entries) {
    const syms = (symbolsByFile.get(e.file) ?? []).slice().sort((a, b) => {
      const ma = termOverlap(terms, tokenize(a.name)) > 0 ? 0 : 1;
      const mb = termOverlap(terms, tokenize(b.name)) > 0 ? 0 : 1;
      if (ma !== mb) return ma - mb;
      const ka = KIND_PRIORITY[a.kind] ?? 3;
      const kb = KIND_PRIORITY[b.kind] ?? 3;
      if (ka !== kb) return ka - kb;
      return a.line - b.line;
    });
    e.symbols = syms.slice(0, MAX_SIGNATURES).map((s) => ({
      name: s.name,
      kind: s.kind,
      signature: signatureOf(bodies.get(`${e.file}${s.name}`), s.name, s.kind),
    }));
  }
}

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$/i;

/**
 * Rank files for ONE task. Combined score per file:
 *   score = 0.2 * pageRank + 1.0 * lexical + 0.5 * neighborBoost
 * where lexical is the best of (path overlap, best symbol-name overlap) plus
 * a small bonus per additional matching symbol, and neighborBoost is the
 * decayed (x0.6) lexical mass of adjacent seed files, capped at the top
 * lexical score. Test files get a +0.08 tilt on `test`-kind tasks.
 *
 * Falls back to pure PageRank ordering (with signatures) when the task has
 * no usable terms or nothing lexically matches — i.e. the global map, made
 * navigable. Returns [] only when the codegraph itself is unavailable/empty.
 */
export function taskRepoMap(cwd: string, opts: TaskRepoMapOptions): TaskRepoMapEntry[] {
  const topK = opts.topK ?? TOP_K;
  const graph = loadFileGraph(cwd);
  if (!graph) return [];
  const chatSet = new Set((opts.chatFiles ?? []).map((p) => {
    const n = normRel(p);
    // Accept absolute paths (ReadCache keys) by relativizing against cwd.
    if (isAbsolute(n)) return relative(cwd, n);
    return n;
  }).filter((p) => p && !p.startsWith('..')));

  const symbols = loadSymbolsLite(cwd);
  const symbolsByFile = new Map<string, SymbolLite[]>();
  for (const s of symbols) {
    let arr = symbolsByFile.get(s.rel);
    if (!arr) { arr = []; symbolsByFile.set(s.rel, arr); }
    arr.push(s);
  }

  const terms = new Set(tokenize(opts.task ?? ''));
  const taskLower = (opts.task ?? '').toLowerCase();
  const usable = terms.size > 0;

  const files = new Set<string>([...Array.from(graph.ranks.keys()), ...Array.from(symbolsByFile.keys())]);
  const lexical = new Map<string, number>();
  let maxLex = 0;
  for (const file of Array.from(files)) {
    let lex = 0;
    if (usable) {
      const pathScore = taskLower.includes(file.toLowerCase())
        ? 1
        : termOverlap(terms, tokenize(file));
      let best = 0;
      let extraHits = 0;
      for (const s of symbolsByFile.get(file) ?? []) {
        let ov = termOverlap(terms, tokenize(s.name));
        // The task naming a symbol verbatim is the strongest lexical signal.
        if (s.name.length >= 4 && taskLower.includes(s.name.toLowerCase())) ov = Math.max(ov, 1);
        if (ov > 0) {
          if (ov > best) { if (best > 0) extraHits++; best = ov; } else extraHits++;
        }
      }
      lex = Math.min(1, Math.max(pathScore, best) + 0.1 * Math.min(3, extraHits));
    }
    lexical.set(file, lex);
    if (lex > maxLex) maxLex = lex;
  }

  // 1-hop neighbourhood boost from the strongest lexical hits (seeds).
  const seeds = Array.from(files)
    .filter((f) => (lexical.get(f) ?? 0) > 0)
    .sort((a, b) => (lexical.get(b)! - lexical.get(a)!) || (a < b ? -1 : 1))
    .slice(0, SEED_COUNT);
  const seedSet = new Set(seeds);
  const neighborBoost = new Map<string, number>();
  for (const file of Array.from(files)) {
    const adj = graph.adjacency.get(file);
    if (!adj || seeds.length === 0) { neighborBoost.set(file, 0); continue; }
    let sum = 0;
    for (const g of Array.from(adj)) if (seedSet.has(g) && g !== file) sum += lexical.get(g) ?? 0;
    neighborBoost.set(file, NEIGHBOR_DECAY * Math.min(maxLex, sum));
  }

  const scored: TaskRepoMapEntry[] = [];
  for (const file of Array.from(files)) {
    const pr = graph.ranks.get(file) ?? 0;
    const lex = lexical.get(file) ?? 0;
    let combined = W_PAGERANK * pr + W_LEXICAL * lex + W_NEIGHBOR * (neighborBoost.get(file) ?? 0);
    // Aider personalization: files the agent has already touched anchor the
    // map. Applied as a multiplier on the PageRank component (rank is
    // normalized 0..1, so ×50 dominates every structural hub but still
    // yields to a perfect lexical hit when W_LEXICAL leads).
    if (chatSet.has(file)) combined += W_PAGERANK * pr * CHAT_FILE_MULT;
    if (opts.kind === 'test' && TEST_FILE_RE.test(file)) combined += 0.08;
    if (combined <= 0) continue;
    scored.push({ file, rank: pr, score: combined, lexical: lex, symbols: [] });
  }
  scored.sort((a, b) =>
    (b.score - a.score) || (b.rank - a.rank) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const top = scored.slice(0, topK);
  const maxCombined = top.length > 0 ? top[0].score : 0;
  if (maxCombined > 0) for (const e of top) e.score = e.score / maxCombined;

  attachSignatures(cwd, top, terms, symbolsByFile);
  return top;
}

export interface TaskRepoMapTextOptions extends TaskRepoMapOptions {
  /** Hard char budget for the rendered block; never exceeded. */
  maxChars?: number;
}

/**
 * Render the task-conditioned repo map for the prompt. Falls back to the
 * global repoMapText when the codegraph is unavailable (which itself renders
 * nothing for an empty graph). The block is built greedily inside maxChars:
 * whole file blocks are added while they fit; signatures are dropped before
 * files are, and at least the top file's line always renders.
 */
export function taskRepoMapText(cwd: string, opts: TaskRepoMapTextOptions): string | undefined {
  const maxChars = opts.maxChars ?? TASK_REPO_MAP_MAX_CHARS;
  const entries = taskRepoMap(cwd, opts);
  if (entries.length === 0) return repoMapText(cwd, opts.topK ?? TOP_K);

  const conditioned = entries.some((e) => e.lexical > 0);
  const header = conditioned
    ? 'REPO MAP (task-conditioned: PageRank + task relevance over the symbol graph — files most relevant to THIS task first, with key signatures):'
    : 'REPO MAP (structural importance, PageRank over the symbol graph — with key signatures):';
  const lines: string[] = [header];
  let used = header.length;
  for (const e of entries) {
    const fileLine = `- ${e.file} (${e.score.toFixed(2)})`;
    const sigLines = e.symbols.map((s) => `    ${s.signature}`);
    const blockLen = fileLine.length + 1 + sigLines.reduce((n, s) => n + s.length + 1, 0);
    if (used + 1 + blockLen <= maxChars) {
      lines.push(fileLine, ...sigLines);
      used += 1 + blockLen;
      continue;
    }
    // Does not fit whole: the first file still renders (line + as many
    // signatures as fit); later files are dropped rather than truncated.
    if (lines.length === 1) {
      if (used + 1 + fileLine.length > maxChars) break;
      lines.push(fileLine);
      used += 1 + fileLine.length;
      for (const s of sigLines) {
        if (used + 1 + s.length > maxChars) break;
        lines.push(s);
        used += 1 + s.length;
      }
    }
    break;
  }
  return lines.join('\n');
}
