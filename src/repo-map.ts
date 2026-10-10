// MCH-49: Aider-style repo-map. PageRank over the codegraph symbol graph,
// aggregated to file level, to surface the structurally most important files
// for context selection. Steals the one thing MASTER_PROMPT says Aider has
// that we don't: PageRank-style file ranking. Read-only over the existing
// codegraph SQLite tables (calls + relations); degrades to empty when the
// index is unavailable (no sqlite, light mode, no languages indexed).
import { hasSqlite, querySymbolGraphSync } from './codegraph.js';

export interface RepoMapEntry {
  file: string;
  rank: number;
}

const DAMPING = 0.85;
const ITERATIONS = 20;
const TOP_K = 15;

/**
 * Compute file-level PageRank for the repo at `cwd` from codegraph call
 * edges. Each call edge (caller file -> callee file) is a vote; rank flows
 * along edges. Returns up to TOP_K files sorted by rank descending, with
 * relative ranks normalized so the top file is 1.0.
 */
export function repoMap(cwd: string, topK = TOP_K): RepoMapEntry[] {
  if (!hasSqlite()) return [];
  // calls rows: (callee symbol, caller symbol, file = defining file of the
  // CALL SITE? no — file is the file where the call appears; rel = relative
  // path of that file). callee is a bare symbol name, so we resolve callee ->
  // defining file via the symbols table to get file-to-file edges.
  let rows: Array<{ callee: string; caller: string; rel: string }>;
  let defs: Array<{ name: string; rel: string }>;
  try {
    const q = querySymbolGraphSync(cwd, 'SELECT callee, caller, rel FROM calls', 200000);
    if (!q || !('rows' in q)) return [];
    rows = q.rows as Array<{ callee: string; caller: string; rel: string }>;
    const d = querySymbolGraphSync(cwd, 'SELECT DISTINCT name, rel FROM symbols', 200000);
    defs = d && 'rows' in d ? (d.rows as Array<{ name: string; rel: string }>) : [];
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const defFile = new Map<string, string>();
  for (const s of defs) {
    if (s.rel && !defFile.has(s.name)) defFile.set(s.name, s.rel);
  }

  // Build file-level adjacency: caller file -> callee definition file votes.
  const out = new Map<string, Map<string, number>>();
  const files = new Set<string>();
  for (const r of rows) {
    const callerFile = (r.rel ?? '').replace(/^\.\//, '');
    const calleeFile = defFile.get(r.callee);
    if (!callerFile || !calleeFile || callerFile === calleeFile) continue;
    files.add(callerFile);
    files.add(calleeFile);
    let m = out.get(callerFile);
    if (!m) { m = new Map(); out.set(callerFile, m); }
    m.set(calleeFile, (m.get(calleeFile) ?? 0) + 1);
  }
  if (files.size === 0) return [];

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
  return ids
    .map((file, i) => ({ file, rank: max > 0 ? rank[i] / max : 0 }))
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
