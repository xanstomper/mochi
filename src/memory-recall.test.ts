import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Set the override BEFORE importing memory-store (it binds MEMORY_FILE at
// module load), so we never touch the real ~/.mochi/memory.jsonl. When bun
// bundles several test files into one process, a sibling's static import may
// bind first — so statements below carry a random suffix to sidestep both
// real-store dedup and cross-run dedup regardless of which file binds.
const tmpFile = join(mkdtempSync('/tmp/mochi-mem-'), 'memory.jsonl');
process.env['MOCHI_MEMORY_FILE'] = tmpFile;
const { addFact, recallFacts, memorySimilarity } = await import('./memory-store.js');

const R = Math.random().toString(36).slice(2, 8); // per-run uniqueness

afterAll(() => {
  try { rmSync(tmpFile, { force: true }); } catch { /* tmp */ }
});

describe('recallFacts category weighting (MCH-59)', () => {
  it('ranks a weakly-matching preference above a strongly-matching fact', () => {
    const pref = addFact(`User prefers concise responses with no preamble ${R}`, 'preference', 'user');
    const fact = addFact(`The parser handles nested arrays by recursing with depth tracking ${R}`, 'fact', 'session');
    expect(pref).not.toBeNull();
    expect(fact).not.toBeNull();
    const ctx = `user wants short replies and response style ${R}`;
    const ranked = recallFacts(ctx, 5);
    expect(ranked[0].category).toBe('preference');
  });

  it('still ranks a strongly-matching fact above an irrelevant preference', () => {
    const fact = addFact(`Build outputs land in dist and the bundle is dist/mochi-bin ${R}`, 'fact', 'session');
    expect(fact).not.toBeNull();
    const ranked = recallFacts(`where do build outputs go in dist ${R}`, 5);
    expect(ranked[0].category).toBe('fact');
  });

  it('similarity tokenizer still works', () => {
    expect(memorySimilarity('build dist', 'build dist output')).toBeGreaterThan(0);
  });
});
