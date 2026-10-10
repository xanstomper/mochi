import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Set the override BEFORE importing memory-store (it binds MEMORY_FILE at
// module load), so we never touch the real ~/.mochi/memory.jsonl.
const tmpFile = join(mkdtempSync('/tmp/mochi-mem-'), 'memory.jsonl');
process.env['MOCHI_MEMORY_FILE'] = tmpFile;
const { addFact, recallFacts, memorySimilarity } = await import('./memory-store.js');

afterAll(() => {
  try { rmSync(tmpFile, { force: true }); } catch { /* tmp */ }
});

describe('recallFacts category weighting (MCH-59)', () => {
  it('ranks a weakly-matching preference above a strongly-matching fact', () => {
    const pref = addFact('User prefers concise responses with no preamble', 'preference', 'user');
    const fact = addFact('The parser handles nested arrays by recursing with depth tracking', 'fact', 'session');
    expect(pref).not.toBeNull();
    expect(fact).not.toBeNull();
    const ctx = 'user wants short replies and response style';
    const ranked = recallFacts(ctx, 2);
    expect(ranked[0].category).toBe('preference');
  });

  it('still ranks a strongly-matching fact above an irrelevant preference', () => {
    const fact = addFact('Build outputs land in dist and the bundle is dist/mochi-bin', 'fact', 'session');
    expect(fact).not.toBeNull();
    const ranked = recallFacts('where do build outputs go in dist', 2);
    expect(ranked[0].category).toBe('fact');
  });

  it('similarity tokenizer still works', () => {
    expect(memorySimilarity('build dist', 'build dist output')).toBeGreaterThan(0);
  });
});
