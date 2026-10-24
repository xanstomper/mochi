// Wave J: semantic index lifecycle + search tests over small temp repos.
// The full-scale proof lives in semantic-retrieval.fixture.test.ts; here
// the contract is correctness of the incremental machinery: unchanged
// files are never re-embedded, edits/deletes propagate, an embedder
// switch re-embeds, and search/context surfaces behave.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateHitsToFiles,
  ensureSemanticIndex,
  indexStatus,
  semanticContextText,
  semanticSearch,
  SEMANTIC_CONTEXT_MAX_CHARS,
  type SemanticHit,
} from './semantic-index.js';
import { LocalFallbackEmbedder, contentHash, type Embedder } from './embeddings.js';
import { generateMonorepoFixture, FIXTURE_FORBIDDEN_WORDS } from './semantic-fixture.js';

const dirs: string[] = [];
function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'mochi-sem-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FALLBACK = new LocalFallbackEmbedder();

function seedRepo(dir: string): void {
  writeFileSync(join(dir, 'lease.ts'), [
    '/** Grants a fencing token to a single holder with a ttl; the heartbeat renewal extends expiry. */',
    'export function acquireFencingLease(state: Record<string, unknown>): Record<string, unknown> {',
    '  const now = Date.now();',
    '  return { ...state, owner: "node", expiresAt: now + 30000 };',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'billing.ts'), [
    '/** Builds invoice totals, applies tax rows and formats the summary for the operator console. */',
    'export function buildInvoiceTotals(rows: Array<Record<string, unknown>>): number {',
    '  return rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'notes.md'), '# Release notes\n\nThe spring release renames the settings screens and refreshes icons.\n');
}

describe('semantic index lifecycle', () => {
  it('builds, then skips everything unchanged on rebuild', async () => {
    const dir = tmpRepo();
    seedRepo(dir);
    const s1 = await ensureSemanticIndex(dir, { embedder: FALLBACK });
    expect(s1).not.toBeNull();
    expect(s1!.filesTotal).toBe(3);
    expect(s1!.filesUpdated).toBe(3);
    expect(s1!.chunksTotal).toBeGreaterThan(0);
    expect(s1!.chunksEmbedded).toBe(s1!.chunksTotal);
    expect(s1!.complete).toBe(true);
    expect(s1!.embedderKind).toBe('lexical-fallback');

    const s2 = await ensureSemanticIndex(dir, { embedder: FALLBACK });
    expect(s2!.filesUpdated).toBe(0);
    expect(s2!.filesSkipped).toBe(3);
    expect(s2!.chunksEmbedded).toBe(0);

    const status = indexStatus(dir);
    expect(status.exists).toBe(true);
    expect(status.files).toBe(3);
    expect(status.embedderId).toBe(FALLBACK.id);
    expect(status.complete).toBe(true);
  });

  it('re-embeds only the edited file, and drops deleted files', async () => {
    const dir = tmpRepo();
    seedRepo(dir);
    const s1 = await ensureSemanticIndex(dir, { embedder: FALLBACK });
    writeFileSync(join(dir, 'billing.ts'), [
      '/** Builds invoice totals with a brand new withholding schedule for freelancers. */',
      'export function buildInvoiceTotals(rows: Array<Record<string, unknown>>): number {',
      '  return rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0) - 7;',
      '}',
      '',
    ].join('\n'));
    const s2 = await ensureSemanticIndex(dir, { embedder: FALLBACK });
    expect(s2!.filesUpdated).toBe(1);
    expect(s2!.chunksEmbedded).toBeGreaterThan(0);
    expect(s2!.chunksEmbedded).toBeLessThan(s1!.chunksTotal);

    unlinkSync(join(dir, 'notes.md'));
    const s3 = await ensureSemanticIndex(dir, { embedder: FALLBACK });
    expect(s3!.filesDeleted).toBe(1);
    const res = await semanticSearch(dir, 'spring release notes settings screens', { embedder: FALLBACK });
    expect(res!.hits.some((h) => h.rel === 'notes.md')).toBe(false);
  });

  it('re-embeds everything when the embedder changes (vectors are keyed by embedder)', async () => {
    const dir = tmpRepo();
    seedRepo(dir);
    await ensureSemanticIndex(dir, { embedder: FALLBACK });
    const stub: Embedder = {
      id: 'stub:embedder-v0',
      kind: 'provider',
      dims: 4,
      async embed(texts: string[]) {
        return texts.map((t) => {
          const h = contentHash(t);
          return Float32Array.from([0, 2, 4, 6].map((o) => (parseInt(h.slice(o, o + 2), 16) % 89) / 89));
        });
      },
    };
    const s = await ensureSemanticIndex(dir, { embedder: stub });
    expect(s!.embedderId).toBe('stub:embedder-v0');
    expect(s!.chunksEmbedded).toBe(s!.chunksTotal);
    // Search reconstructs the stub from... it cannot (not a real provider),
    // so vector ranking degrades to lexical-only rather than mixing spaces.
    const res = await semanticSearch(dir, 'fencing token ttl heartbeat', {});
    expect(res).not.toBeNull();
    expect(res!.hits[0].rel).toBe('lease.ts');
  });
});

describe('semantic search + surfaces', () => {
  it('ranks the concept file first and aggregates by file', async () => {
    const dir = tmpRepo();
    seedRepo(dir);
    await ensureSemanticIndex(dir, { embedder: FALLBACK });
    const res = await semanticSearch(dir, 'fencing token ttl heartbeat renewal', { embedder: FALLBACK, limit: 20 });
    expect(res).not.toBeNull();
    expect(res!.embedderKind).toBe('lexical-fallback');
    const files = aggregateHitsToFiles(res!.hits, 10);
    expect(files[0].rel).toBe('lease.ts');
    // The file's symbol chunk is among its hits (the header chunk, which
    // embeds the doc comment + signature, may legitimately be its best).
    expect(res!.hits.some((h) => h.rel === 'lease.ts' && h.symbol === 'acquireFencingLease')).toBe(true);
  });

  it('returns null when no index exists', async () => {
    const dir = tmpRepo();
    expect(await semanticSearch(dir, 'anything', { embedder: FALLBACK })).toBeNull();
    expect(indexStatus(dir).exists).toBe(false);
  });

  it('context text: cold index yields nothing, warm index yields a labelled, budgeted block', async () => {
    const dir = tmpRepo();
    seedRepo(dir);
    // Cold: no index yet — the call kicks a background build and returns
    // undefined rather than blocking the task start.
    const cold = await semanticContextText(dir, 'fencing token ttl heartbeat', { timeoutMs: 5000 });
    expect(cold).toBeUndefined();
    // The background build is the same inflight run ensureSemanticIndex
    // returns; awaiting it guarantees the index exists now.
    await ensureSemanticIndex(dir, { embedder: FALLBACK });
    const warm = await semanticContextText(dir, 'fencing token ttl heartbeat renewal', { timeoutMs: 10000 });
    expect(warm).toBeDefined();
    expect(warm!).toContain('SEMANTIC MATCHES');
    expect(warm!).toContain('lexical-fallback');
    expect(warm!).toContain('lease.ts');
    expect(warm!.length).toBeLessThanOrEqual(SEMANTIC_CONTEXT_MAX_CHARS);
  });
});

describe('aggregateHitsToFiles file-level RRF (P4, provider embedder)', () => {
  const hit = (over: Partial<SemanticHit>): SemanticHit => ({
    rel: 'x.ts', symbol: '', kind: 'block', startLine: 1, endLine: 2,
    score: 0, fusedScore: 0, vectorScore: 0, lexicalScore: 0, snippet: '',
    ...over,
  });

  it('provider: file score does not scale with chunk count (per-signal bests, not sums)', () => {
    // One chunk vs ten chunks, identical per-signal bests. The old
    // best + 0.25 x rest formula scored the ten-chunk file ~3x higher;
    // the file-level RRF must score them identically.
    const one = aggregateHitsToFiles([
      hit({ rel: 'a.ts', score: 0.012, fusedScore: 0.012, vectorScore: 0.5, lexicalScore: 0.3 }),
    ], 5, { embedderKind: 'provider' });
    const ten = aggregateHitsToFiles([
      hit({ rel: 'b.ts', score: 0.012, fusedScore: 0.012, vectorScore: 0.5, lexicalScore: 0.3 }),
      ...Array.from({ length: 9 }, (_, i) => hit({
        rel: 'b.ts', score: 0.011 - i * 0.0005, fusedScore: 0.011 - i * 0.0005,
        vectorScore: 0.5, lexicalScore: 0.3,
      })),
    ], 5, { embedderKind: 'provider' });
    expect(one).toHaveLength(1);
    expect(ten[0].chunkCount).toBe(10);
    expect(ten[0].fileScore).toBeCloseTo(one[0].fileScore, 10);
  });

  it('provider: a many-chunk decoy with weaker per-signal bests cannot out-rank the target', () => {
    // Chunk-level fused scores are near-identical (RRF is flat), but the
    // decoy places TEN chunks in the pool. Under best + 0.25 x rest its
    // fileScore would be 0.0323 + 0.25x9x0.0323 = 0.105 — first by chunk
    // count. Under file-level RRF the target's (vec rank 1, lex rank 2)
    // beats the decoy's (vec rank 3, lex rank 1).
    const decoyChunks = Array.from({ length: 10 }, () => hit({
      rel: 'decoy.log', score: 0.032266, fusedScore: 0.032266, vectorScore: 0.4, lexicalScore: 0.3,
    }));
    const files = aggregateHitsToFiles([
      hit({ rel: 'target.ts', score: 0.032519, fusedScore: 0.032519, vectorScore: 0.62, lexicalScore: 0.2 }),
      hit({ rel: 'other.ts', score: 0.031765, fusedScore: 0.031765, vectorScore: 0.55, lexicalScore: 0.1 }),
      ...decoyChunks,
    ], 3, { embedderKind: 'provider' });
    expect(files[0].rel).toBe('target.ts');
    expect(files[0].best.vectorScore).toBe(0.62);
  });

  it('lexical fallback: the legacy count-voting formula is kept (spread evidence)', () => {
    // With the fallback embedder there is no strong ranker to swarm: a
    // file whose evidence spreads over ten pooled chunks MUST out-rank a
    // one-chunk file with the same per-signal bests (measured on the
    // 2048-file fixture: file-level RRF there loses 0.698 -> 0.594 vs
    // pure lexical). Omitted kind = the fallback policy (historical
    // default), so the two calls must agree.
    const tenHits = [
      hit({ rel: 'b.ts', score: 0.012, fusedScore: 0.012, vectorScore: 0.5, lexicalScore: 0.3 }),
      ...Array.from({ length: 9 }, (_, i) => hit({
        rel: 'b.ts', score: 0.011 - i * 0.0005, fusedScore: 0.011 - i * 0.0005,
        vectorScore: 0.5, lexicalScore: 0.3,
      })),
    ];
    const fallbackTen = aggregateHitsToFiles(tenHits, 5, { embedderKind: 'lexical-fallback' });
    const defaultTen = aggregateHitsToFiles(tenHits, 5);
    expect(fallbackTen[0].fileScore).toBeCloseTo(defaultTen[0].fileScore, 10);
    const one = aggregateHitsToFiles([
      hit({ rel: 'a.ts', score: 0.012, fusedScore: 0.012, vectorScore: 0.5, lexicalScore: 0.3 }),
    ], 5, { embedderKind: 'lexical-fallback' });
    expect(fallbackTen[0].fileScore).toBeGreaterThan(one[0].fileScore);
  });
});

describe('fixture integrity', () => {
  it('plants 8 concepts x 6 relevant files and keeps distractor vocabulary disjoint', () => {
    const dir = tmpRepo();
    const fx = generateMonorepoFixture(dir, { totalFiles: 400 });
    expect(fx.fileCount).toBe(400);
    expect(fx.queries.length).toBe(16);
    for (const q of fx.queries) expect(q.relevant.length).toBe(6);
    // Every relevant + planted file exists on disk (generation is the
    // ground truth the benchmark trusts).
    for (const rel of fx.plantedFiles) expect(existsSync(join(dir, rel))).toBe(true);
    // Distractors must not contain any concept's discriminative words.
    for (const rel of fx.distractorFiles.slice(0, 60)) {
      const text = readFileSync(join(dir, rel), 'utf8').toLowerCase();
      for (const w of FIXTURE_FORBIDDEN_WORDS) {
        expect(text.includes(w), `${rel} contains forbidden word ${w}`).toBe(false);
      }
    }
  });
});
