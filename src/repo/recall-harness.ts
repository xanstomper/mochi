// W3-1 recall harness: recall@k for lexical vs embedded vs hybrid (RRF)
// over a semantic index at `root`, against the frozen RECALL_QUERIES set
// (or any caller-supplied set).
//
// All three rankings come from ONE production semanticSearch call per
// query: each hit already carries lexicalScore, vectorScore and the fused
// final score, so the harness derives the three file rankings by
// aggregating the respective signal with the SAME aggregateHitsToFiles the
// tool/context/benchmark surfaces use — no scoring logic is duplicated.
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

function fileRanking(hits: SemanticHit[], scoreOf: (h: SemanticHit) => number, limit: number): string[] {
  // Reuse the production file aggregation, with the requested signal in
  // the `score` slot it ranks by.
  const reScored = hits.map((h) => ({ ...h, score: scoreOf(h) }));
  return aggregateHitsToFiles(reScored, limit).map((f) => f.rel);
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
  opts: { queries?: RecallQuery[]; searchLimit?: number } = {},
): Promise<RecallReport> {
  const queries = opts.queries ?? RECALL_QUERIES;
  const rows: RecallRow[] = [];
  for (const q of queries) {
    // limit high enough to keep every chunk that carries ANY signal; the
    // per-signal file rankings are derived below, not from this order.
    const res = await semanticSearch(root, q.query, { embedder, limit: opts.searchLimit ?? 500_000 });
    if (!res) throw new Error(`no semantic index at ${root} — build it with the same embedder first`);
    const all = res.hits;
    const lexicalRank = fileRanking(all, (h) => h.lexicalScore, 10);
    const embeddedRank = fileRanking(all, (h) => h.vectorScore, 10);
    const hybridRank = fileRanking(all, (h) => h.score, 10);
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
