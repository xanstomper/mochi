// W3-1: recall harness tests over a small temp repo (offline, fallback
// embedder). The full-repo measurement lives in the wave report; here the
// contract is: one production search per query, per-signal file rankings,
// and honest recall arithmetic (target in top-k → 1, else 0, averaged).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSemanticIndex } from './semantic-index.js';
import { LocalFallbackEmbedder } from './embeddings.js';
import { runRecallHarness } from './recall-harness.js';
import { RECALL_QUERIES } from './recall-queries.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FALLBACK = new LocalFallbackEmbedder();

describe('recall queries ground truth', () => {
  it('is a fixed set of >= 20 natural-language queries with existing target files', async () => {
    expect(RECALL_QUERIES.length).toBeGreaterThanOrEqual(20);
    for (const q of RECALL_QUERIES) {
      expect(q.id).toMatch(/^q\d+$/);
      expect(q.targets.length).toBeGreaterThan(0);
      for (const t of q.targets) {
        // Targets are repo files that must keep existing (the set is
        // frozen; a moved file forces a deliberate query-set revision).
        const exists = await import('node:fs').then((fs) => fs.existsSync(t));
        expect(exists, `target of ${q.id} missing: ${t}`).toBe(true);
      }
    }
  });
});

describe('runRecallHarness', () => {
  it('scores a target-bearing query at 1 and a distractor-only query at 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-recall-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'lease.ts'), [
      '/** Grants a fencing token to a single holder with a ttl; heartbeat renewal extends expiry. */',
      'export function acquireFencingLease(state: Record<string, unknown>): Record<string, unknown> {',
      '  return { ...state, expiresAt: Date.now() + 30000 };',
      '}',
      '',
    ].join('\n'));
    // Nine lease-flavoured distractors: they carry the vocabulary (so the
    // miss query ranks THEM above the true off-topic target) but not the
    // unique symbol the hit query names.
    for (let i = 0; i < 9; i++) {
      writeFileSync(join(dir, `leaseShard${i}.ts`), [
        `/** Shard ${i} of the fencing-token lease store; renewal bookkeeping. */`,
        `export function leaseShardSweep${i}(rows: string[]): number {`,
        '  return rows.length;',
        '}',
        '',
      ].join('\n'));
    }
    writeFileSync(join(dir, 'recipes.md'), '# Banana bread\n\nMash the bananas, fold in flour, bake until golden.\n');
    const stats = await ensureSemanticIndex(dir, { embedder: FALLBACK });
    expect(stats).not.toBeNull();

    const report = await runRecallHarness(dir, FALLBACK, {
      queries: [
        { id: 'hit', query: 'acquireFencingLease grant ttl holder', targets: ['lease.ts'] },
        { id: 'miss', query: 'fencing token lease store renewal bookkeeping', targets: ['recipes.md'] },
      ],
    });
    expect(report.queries).toBe(2);
    expect(report.embedderId).toBe(FALLBACK.id);
    const hit = report.rows.find((r) => r.id === 'hit')!;
    const miss = report.rows.find((r) => r.id === 'miss')!;
    expect(hit.lexical[5]).toBe(1);
    expect(hit.hybrid[5]).toBe(1);
    // 10 lease-flavoured files outrank the off-topic target, pushing it
    // out of the top 5 for this query.
    expect(miss.lexical[5]).toBe(0);
    // Averages are means of the per-row values (1 and 0 for lexical).
    expect(report.averages.lexical[5]).toBeCloseTo(0.5, 10);
  });
});
