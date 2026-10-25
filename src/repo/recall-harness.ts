// W3-1 recall harness: recall@k for lexical vs embedded vs hybrid (RRF)
// over a semantic index at `root`, against the frozen RECALL_QUERIES set
// (or any caller-supplied set).
//
// Ranking semantics per signal (and why they differ):
// - lexical / embedded: PURE per-signal file ranking — best chunk score
//   per file over the full scored corpus (no aggregation bias). This is
//   the honest ablation: what could each signal alone retrieve?
// - hybrid: the PRODUCTION path verbatim — semanticSearch's fused top
//   chunk pool (limit 80, the shared benchmark's pool size) aggregated by
//   aggregateHitsToFiles exactly as the tool/context surfaces do.
//   (Since P4 the aggregation policy follows the embedder kind: with a
//   provider embedder it is file-level RRF over per-file best per-signal
//   chunks; the old `0.25 x rest` term was only meaningful over a bounded
//   pool — over all ~10.8k chunks a 300-chunk file's tail swamped every
//   best-chunk signal — and, over a bounded pool, let a many-chunk file's
//   vote scale with its chunk count. The fallback embedder KEEPS the
//   count-voting formula: with no strong ranker present it is the
//   spread-evidence mechanism, measured on the 2048-file fixture.)
//
// The index at `root` must have been built with `embedder` (vectors are
// keyed by embedder id; a mismatch just yields vectorScore 0 everywhere).
import {
  aggregateHitsToFiles,
  semanticSearch,
  type SemanticHit,
} from './semantic-index.js';
import type { Embedder } from './embeddings.js';
import { RECALL_QUERIES, type RecallQuery } from './recall-queries.js';

export type RecallSignal = 'lexical' | 'embedded' | 'hybrid';

export interface RecallRow {
  id: string;
  query: string;
  targets: string[];
  lexical: { 5: number; 10: number };
  embedded: { 5: number; 10: number };
  hybrid: { 5: number; 10: number };
}

export interface RecallReport {
  root: string;
  embedderId: string;
  embedderKind: string;
  queries: number;
  rows: RecallRow[];
  /** Mean recall per signal at k=5 / k=10 over all queries. */
  averages: Record<RecallSignal, { 5: number; 10: number }>;
}

/** Pure per-signal ranking: best chunk score per file over every scored
 *  chunk, score-descending, deterministic rel tiebreak. */
function bestChunkFileRanking(hits: SemanticHit[], scoreOf: (h: SemanticHit) => number, limit: number): string[] {
  const best = new Map<string, { rel: string; score: number }>();
  for (const h of hits) {
    const s = scoreOf(h);
    if (s <= 0) continue;
    const cur = best.get(h.rel);
    if (!cur || s > cur.score) best.set(h.rel, { rel: h.rel, score: s });
  }
  return [...best.values()]
    .sort((a, b) => (b.score - a.score) || (a.rel < b.rel ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.rel);
}

function recallAtK(rankedFiles: string[], targets: string[], k: 5 | 10): number {
  if (targets.length === 0) return 0;
  const top = new Set(rankedFiles.slice(0, k));
  let found = 0;
  for (const t of targets) if (top.has(t)) found++;
  return found / targets.length;
}

export async function runRecallHarness(
  root: string,
  embedder: Embedder,
  opts: { queries?: RecallQuery[]; searchLimit?: number; hybridPool?: number } = {},
): Promise<RecallReport> {
  const queries = opts.queries ?? RECALL_QUERIES;
  const hybridPool = opts.hybridPool ?? 80;
  const rows: RecallRow[] = [];
  for (const q of queries) {
    // Full-corpus pass for the pure per-signal rankings (every chunk that
    // carries ANY signal comes back scored).
    const full = await semanticSearch(root, q.query, { embedder, limit: opts.searchLimit ?? 500_000 });
    if (!full) throw new Error(`no semantic index at ${root} — build it with the same embedder first`);
    const lexicalRank = bestChunkFileRanking(full.hits, (h) => h.lexicalScore, 10);
    const embeddedRank = bestChunkFileRanking(full.hits, (h) => h.vectorScore, 10);
    // Production hybrid: bounded fused pool + the shared file aggregation.
    const prod = await semanticSearch(root, q.query, { embedder, limit: hybridPool });
    const hybridRank = prod ? aggregateHitsToFiles(prod.hits, 10, { embedderKind: embedder.kind }).map((f) => f.rel) : [];
    rows.push({
      id: q.id,
      query: q.query,
      targets: q.targets,
      lexical: { 5: recallAtK(lexicalRank, q.targets, 5), 10: recallAtK(lexicalRank, q.targets, 10) },
      embedded: { 5: recallAtK(embeddedRank, q.targets, 5), 10: recallAtK(embeddedRank, q.targets, 10) },
      hybrid: { 5: recallAtK(hybridRank, q.targets, 5), 10: recallAtK(hybridRank, q.targets, 10) },
    });
  }
  const avg = (signal: RecallSignal, k: 5 | 10) =>
    rows.reduce((a, r) => a + r[signal][k], 0) / Math.max(1, rows.length);
  return {
    root,
    embedderId: embedder.id,
    embedderKind: embedder.kind,
    queries: rows.length,
    rows,
    averages: {
      lexical: { 5: avg('lexical', 5), 10: avg('lexical', 10) },
      embedded: { 5: avg('embedded', 5), 10: avg('embedded', 10) },
      hybrid: { 5: avg('hybrid', 5), 10: avg('hybrid', 10) },
    },
  };
}
