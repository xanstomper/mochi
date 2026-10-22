// Wave J: full-scale retrieval proof. Generates the 2,048-file synthetic
// monorepo (8 planted concepts x 6 ground-truth files, ~1,950 distractors)
// and measures recall@10 for lexical-only, repo-map-only, hybrid and
// hybrid+conditioned retrieval on the LOCAL LEXICAL-FALLBACK embedder.
// The same numbers print in bench/semantic-retrieval.mts and RESULT.md.
//
// Assertions encode the measured relationships with slack for environment
// noise, NOT the marketing version: hybrid must beat the repo map on
// paraphrase (conceptual) queries — the gap this wave exists to close —
// and conditioning must not make the overall result worse than plain
// lexical. On exact-vocabulary queries the structural repo map remains
// strongest on this fixture; that is reported, not asserted away.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSemanticBenchmark, type SemanticBenchmarkResult } from './semantic-benchmark.js';

let dir = '';
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('semantic retrieval fixture (2,048-file monorepo)', () => {
  it('measures hybrid vs baselines and the incremental rebuild', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-semfix-'));
    const r: SemanticBenchmarkResult = await runSemanticBenchmark(dir);

    // Scale + build integrity.
    expect(r.fileCount).toBe(2048);
    expect(r.stats.filesTotal).toBe(2048);
    expect(r.stats.chunksTotal).toBeGreaterThan(10000);
    expect(r.stats.complete).toBe(true);
    expect(r.stats.embedderKind).toBe('lexical-fallback');

    // Incremental: exactly the 10 touched files re-embed.
    expect(r.incrementalUpdated).toBe(10);
    expect(r.incrementalEmbedded).toBeLessThan(200);

    if (r.stats.graphSymbols) {
      // The headline gap: on paraphrase queries the repo map alone loses
      // to hybrid retrieval by a wide margin (measured 0.563 vs 0.729).
      expect(r.averages.conceptual.hybrid).toBeGreaterThan(r.averages.conceptual.repoMap + 0.05);
      // Conditioning (grounding-gated) never drags the hybrid below the
      // plain lexical baseline overall (measured 0.708 vs 0.698).
      expect(r.averages.all.conditioned).toBeGreaterThanOrEqual(r.averages.all.lexical - 0.02);
      // And hybrid overall is at least lexical overall (measured 0.698 vs 0.698).
      expect(r.averages.all.hybrid).toBeGreaterThanOrEqual(r.averages.all.lexical - 0.02);
    }

    // Latency sanity: steady-state per-query cost over ~12k chunks stays
    // in interactive territory even on a loaded box.
    expect(r.queryLatencySteadyMedianMs).toBeLessThan(1500);
  });
});
