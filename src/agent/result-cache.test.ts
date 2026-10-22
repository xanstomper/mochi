// Wave S4 — run-scoped result cache units.
import { describe, it, expect } from 'vitest';
import { RunResultCache, RESULT_CACHE_VERBATIM_MAX } from './result-cache.js';

const big = 'x'.repeat(RESULT_CACHE_VERBATIM_MAX + 500);

describe('RunResultCache', () => {
  it('misses before any store', () => {
    const c = new RunResultCache();
    expect(c.lookup('outline', { path: 'a.ts' })).toBeUndefined();
    expect(c.stats.misses).toBe(1);
  });

  it('serves small results verbatim and large results as a stub', () => {
    const c = new RunResultCache();
    c.store('read', { path: 'a.ts' }, 'small output');
    const small = c.lookup('read', { path: 'a.ts' });
    expect(small?.kind).toBe('verbatim');
    if (small?.kind === 'verbatim') expect(small.output).toBe('small output');

    c.store('outline', { path: 'b.ts' }, big);
    const large = c.lookup('outline', { path: 'b.ts' });
    expect(large?.kind).toBe('stub');
    if (large?.kind === 'stub') {
      expect(large.text).toContain('[result-cache]');
      expect(large.text.length).toBeLessThan(big.length);
      expect(large.savedChars).toBe(big.length);
    }
    expect(c.stats.hits).toBe(2);
  });

  it('keys on tool + full args (arg differences miss)', () => {
    const c = new RunResultCache();
    c.store('search', { query: 'add' }, big);
    expect(c.lookup('search', { query: 'subtract' })).toBeUndefined();
    expect(c.lookup('search', { query: 'add', glob: '*.ts' })).toBeUndefined();
    expect(c.lookup('outline', { query: 'add' })).toBeUndefined();
    expect(c.lookup('search', { query: 'add' })?.kind).toBe('stub');
  });

  it('a mutation invalidates every stored result (epoch bump)', () => {
    const c = new RunResultCache();
    c.store('outline', { path: 'b.ts' }, big);
    expect(c.lookup('outline', { path: 'b.ts' })?.kind).toBe('stub');
    c.noteMutation();
    expect(c.lookup('outline', { path: 'b.ts' })).toBeUndefined();
    // Re-storing after the mutation re-arms the entry.
    c.store('outline', { path: 'b.ts' }, big);
    expect(c.lookup('outline', { path: 'b.ts' })?.kind).toBe('stub');
  });

  it('a history rewrite invalidates too (generation bump) — stubs must not point at compacted-away content', () => {
    const c = new RunResultCache();
    c.store('read', { path: 'a.ts' }, 'small output');
    c.noteHistoryRewrite();
    expect(c.lookup('read', { path: 'a.ts' })).toBeUndefined();
  });

  it('does not store oversized outputs', () => {
    const c = new RunResultCache();
    c.store('read', { path: 'huge.ts' }, 'x'.repeat(70_000));
    expect(c.lookup('read', { path: 'huge.ts' })).toBeUndefined();
    expect(c.stats.skippedLarge).toBe(1);
  });

  it('clear() drops everything (per-run reset)', () => {
    const c = new RunResultCache();
    c.store('read', { path: 'a.ts' }, 'small output');
    c.clear();
    expect(c.size).toBe(0);
    expect(c.lookup('read', { path: 'a.ts' })).toBeUndefined();
  });
});
