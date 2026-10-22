// Wave J retrieval benchmark — thin printer over
// src/repo/semantic-benchmark.ts (the fixture test asserts on the same
// numbers). Run: ./node_modules/.bin/tsx bench/semantic-retrieval.mts [dir]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runSemanticBenchmark } from '../src/repo/semantic-benchmark.js';

const root = process.argv[2] ?? mkdtempSync(resolve(tmpdir(), 'mochi-semantic-fixture-'));
const r = await runSemanticBenchmark(root);
console.log(`fixture root: ${root}`);
console.log(`generated ${r.fileCount} files`);
console.log(`build: ${r.buildMs}ms files=${r.stats.filesTotal} updated=${r.stats.filesUpdated} chunks=${r.stats.chunksTotal} embedded=${r.stats.chunksEmbedded} reused=${r.stats.chunksReused} graphSymbols=${r.stats.graphSymbols} embedder=${r.stats.embedderId} (${r.stats.embedderKind})`);
for (const row of r.rows) {
  console.log(`${row.kind.padEnd(10)} ${row.conceptId.padEnd(14)} lex=${row.lexical.toFixed(2)} map=${row.repoMap.toFixed(2)} hyb=${row.hybrid.toFixed(2)} cond=${row.conditioned.toFixed(2)}  "${row.query.slice(0, 60)}"`);
}
const f = (n: number) => n.toFixed(3);
console.log('\n| query set | lexical/grep-only | repo-map-only | hybrid (fallback) | hybrid + conditioning |');
console.log('|---|---|---|---|---|');
console.log(`| lexical (n=8) | ${f(r.averages.lexical.lexical)} | ${f(r.averages.lexical.repoMap)} | ${f(r.averages.lexical.hybrid)} | ${f(r.averages.lexical.conditioned)} |`);
console.log(`| conceptual (n=8) | ${f(r.averages.conceptual.lexical)} | ${f(r.averages.conceptual.repoMap)} | ${f(r.averages.conceptual.hybrid)} | ${f(r.averages.conceptual.conditioned)} |`);
console.log(`| ALL (n=16) | ${f(r.averages.all.lexical)} | ${f(r.averages.all.repoMap)} | ${f(r.averages.all.hybrid)} | ${f(r.averages.all.conditioned)} |`);
console.log(`hybrid query latency: first=${r.queryLatencyFirstMs}ms (one-time corpus load), steady-state median=${r.queryLatencySteadyMedianMs}ms over ${r.stats.chunksTotal} chunks`);
console.log(`incremental rebuild after touching 10 files: ${r.incrementalMs}ms updated=${r.incrementalUpdated} embedded=${r.incrementalEmbedded}`);
console.log(`provider embeddings: ${r.providerNote}`);
