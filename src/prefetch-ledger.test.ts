// MCH-61: prefetch effectiveness ledger tests.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPrefetchOutcome, prefetchSignalWeights, prefetchFiles } from './prefetch.js';

let dir = '';
afterAll(() => { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('prefetch effectiveness ledger (MCH-61)', () => {
  it('records outcomes and derives weights from hit-rates', () => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-mch61-'));
    mkdirSync(join(dir, '.mochi'), { recursive: true });

    const entries = [
      { file: 'a.ts', score: 0.8, signals: ['structure'] },
      { file: 'b.ts', score: 0.6, signals: ['cochange'] },
    ];
    // a.ts read, b.ts never.
    recordPrefetchOutcome(dir, entries, [join(dir, 'a.ts')]);
    recordPrefetchOutcome(dir, entries, [join(dir, 'a.ts')]);

    const raw = JSON.parse(readFileSync(join(dir, '.mochi', 'prefetch-stats.json'), 'utf8')) as Record<string, { predicted: number; hit: number }>;
    expect(raw['structure']).toEqual({ predicted: 2, hit: 2 });
    expect(raw['cochange']).toEqual({ predicted: 2, hit: 0 });

    // Thin data (<5 predictions) -> weights stay neutral.
    const w = prefetchSignalWeights(dir);
    expect(w['structure']).toBe(1);
    expect(w['cochange']).toBe(1);
  });

  it('weight responds once enough data accumulates', () => {
    // 20 predictions, 100% hit -> structure weight above 1.
    for (let i = 0; i < 10; i++) recordPrefetchOutcome(dir, [{ file: 'a.ts', score: 0.8, signals: ['structure'] }], [join(dir, 'a.ts')]);
    const w = prefetchSignalWeights(dir);
    expect(w['structure']).toBeGreaterThan(1);
    // 20 predictions, 0% hit -> cochange weight below 1.
    for (let i = 0; i < 10; i++) recordPrefetchOutcome(dir, [{ file: 'b.ts', score: 0.6, signals: ['cochange'] }], []);
    const w2 = prefetchSignalWeights(dir);
    expect(w2['cochange']).toBeLessThan(1);
    expect(w2['cochange']).toBeGreaterThanOrEqual(0.4);
  });

  it('fusion scoring stays sane with weighted signals', () => {
    writeFileSync(join(dir, 'c.ts'), 'export const c = 1;\n');
    const list = prefetchFiles(dir, [], 5);
    for (const e of list) {
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.score).toBeLessThanOrEqual(1.01); // capped fusion
    }
  });
});
