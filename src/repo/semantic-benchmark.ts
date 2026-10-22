// Retrieval benchmark over the synthetic monorepo fixture (Wave J).
// Shared by bench/semantic-retrieval.mts (human-readable report) and the
// fixture test (regression assertions) so both quote the same numbers.
//
// Baselines, all recall@10 at FILE level against planted ground truth:
//   lexical     — grep-style: the codebase's own keyword scorer
//                 (scoreEntry semantics) over full file text.
//   repoMap     — taskRepoMap alone (PageRank + lexical + call-graph
//                 neighbourhood over the codegraph).
//   hybrid      — semanticSearch: vector ⊕ lexical RRF over the index.
//   conditioned — semanticSearchForTask: hybrid re-ranked by the repo
//                 map's task conditioning (grounding-gated).
// The hybrid runs use the LOCAL LEXICAL-FALLBACK embedder unless a real
// provider embedder is passed in — see providerNote in the result.
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateMonorepoFixture } from './semantic-fixture.js';
import {
  aggregateHitsToFiles,
  ensureSemanticIndex,
  semanticSearch,
  semanticSearchForTask,
  type IndexStats,
} from './semantic-index.js';
import { resolveEmbedder, type Embedder } from './embeddings.js';
import { taskRepoMap } from './repo-map.js';
import { tokenize } from '../memory/relevance.js';

export const BENCH_K = 10;

export interface BenchRow {
  conceptId: string;
  kind: 'lexical' | 'conceptual';
  query: string;
  lexical: number;
  repoMap: number;
  hybrid: number;
  conditioned: number;
}

export interface SemanticBenchmarkResult {
  root: string;
  fileCount: number;
  buildMs: number;
  stats: IndexStats;
  rows: BenchRow[];
  averages: Record<'lexical' | 'conceptual' | 'all', { lexical: number; repoMap: number; hybrid: number; conditioned: number }>;
  /** Hybrid query latency: first call includes the one-time corpus load
   *  (SQLite read + token-set build); steadyStateMedianMs is the honest
   *  per-query figure after that. */
  queryLatencyFirstMs: number;
  queryLatencySteadyMedianMs: number;
  incrementalMs: number;
  incrementalUpdated: number;
  incrementalEmbedded: number;
  providerNote: string;
}

function recallAtK(rankedFiles: string[], relevant: string[], k = BENCH_K): number {
  const top = new Set(rankedFiles.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

/** scoreEntry(query, '', text) computed over a precomputed token set —
 *  identical semantics (title is empty: 0.6x0 + 0.4x body overlap, 2dp). */
function fileLexicalScore(queryTokens: Set<string>, fileTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let hits = 0;
  for (const t of Array.from(queryTokens)) if (fileTokens.has(t)) hits++;
  return Math.round(0.4 * (hits / queryTokens.size) * 100) / 100;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function runSemanticBenchmark(
  root: string,
  opts: { embedder?: Embedder; totalFiles?: number } = {},
): Promise<SemanticBenchmarkResult> {
  const fixture = generateMonorepoFixture(root, { totalFiles: opts.totalFiles });
  const embedder = opts.embedder ?? resolveEmbedder(undefined).embedder;

  const t0 = Date.now();
  const stats = await ensureSemanticIndex(root, { embedder });
  const buildMs = Date.now() - t0;
  if (!stats) throw new Error('semantic index build returned null (disabled or no SQLite driver)');

  const allFiles = [...fixture.plantedFiles, ...fixture.distractorFiles];
  const fileTokens = new Map<string, Set<string>>();
  for (const rel of allFiles) {
    fileTokens.set(rel, new Set(tokenize(readFileSync(resolve(root, rel), 'utf8'))));
  }

  const rows: BenchRow[] = [];
  const hybridLatencies: number[] = [];
  for (const q of fixture.queries) {
    const queryTokens = new Set(tokenize(q.text));
    const lexicalRanked = allFiles
      .map((rel) => ({ rel, s: fileLexicalScore(queryTokens, fileTokens.get(rel)!) }))
      .sort((a, b) => (b.s - a.s) || (a.rel < b.rel ? -1 : 1))
      .map((x) => x.rel);
    const repoMapRanked = taskRepoMap(root, { task: q.text, topK: BENCH_K }).map((e) => e.file);

    const tq = Date.now();
    const hybrid = await semanticSearch(root, q.text, { embedder, limit: 80 });
    hybridLatencies.push(Date.now() - tq);
    const hybridRanked = hybrid ? aggregateHitsToFiles(hybrid.hits, BENCH_K).map((f) => f.rel) : [];

    const conditioned = await semanticSearchForTask(root, q.text, { embedder, limit: 80 });
    const conditionedRanked = conditioned ? aggregateHitsToFiles(conditioned.hits, BENCH_K).map((f) => f.rel) : [];

    rows.push({
      conceptId: q.conceptId,
      kind: q.kind,
      query: q.text,
      lexical: recallAtK(lexicalRanked, q.relevant),
      repoMap: recallAtK(repoMapRanked, q.relevant),
      hybrid: recallAtK(hybridRanked, q.relevant),
      conditioned: recallAtK(conditionedRanked, q.relevant),
    });
  }

  const avgFor = (rs: BenchRow[]) => ({
    lexical: rs.reduce((a, r) => a + r.lexical, 0) / Math.max(1, rs.length),
    repoMap: rs.reduce((a, r) => a + r.repoMap, 0) / Math.max(1, rs.length),
    hybrid: rs.reduce((a, r) => a + r.hybrid, 0) / Math.max(1, rs.length),
    conditioned: rs.reduce((a, r) => a + r.conditioned, 0) / Math.max(1, rs.length),
  });
  const averages = {
    lexical: avgFor(rows.filter((r) => r.kind === 'lexical')),
    conceptual: avgFor(rows.filter((r) => r.kind === 'conceptual')),
    all: avgFor(rows),
  };

  // Incremental: touch 10 distractor files, rebuild, measure.
  for (const rel of fixture.distractorFiles.slice(0, 10)) {
    appendFileSync(resolve(root, rel), `\n// touched ${Date.now()}\n`);
  }
  const t1 = Date.now();
  const stats2 = await ensureSemanticIndex(root, { embedder });
  const incrementalMs = Date.now() - t1;

  const resolution = resolveEmbedder(undefined);
  const providerNote = resolution.embedder.kind === 'provider'
    ? `a provider embedder is resolvable in this environment (${resolution.embedder.id}); the benchmark ${opts.embedder && opts.embedder.kind === 'provider' ? 'RAN on it' : 'was NOT re-run on it (would spend API budget embedding the fixture)'}`
    : `provider embeddings not run — ${resolution.reason}; hybrid numbers use the local lexical-fallback embedder`;

  return {
    root,
    fileCount: fixture.fileCount,
    buildMs,
    stats,
    rows,
    averages,
    queryLatencyFirstMs: hybridLatencies[0] ?? 0,
    queryLatencySteadyMedianMs: median(hybridLatencies.slice(1)),
    incrementalMs,
    incrementalUpdated: stats2?.filesUpdated ?? -1,
    incrementalEmbedded: stats2?.chunksEmbedded ?? -1,
    providerNote,
  };
}
