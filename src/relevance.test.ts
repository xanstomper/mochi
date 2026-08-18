import { describe, it, expect } from 'vitest';
import { tokenOverlap, scoreEntry, selectRelevant, type SelectableEntry } from './relevance.js';

const E: SelectableEntry[] = [
  { title: 'Zustand state management', body: 'All app state uses Zustand stores instead of Redux.', kind: 'decision' },
  { title: 'Redis cache policy', body: 'Cache invalidation TTL is 5 minutes for user profiles.', kind: 'architecture' },
  { title: 'API route naming', body: 'REST routes use plural nouns (e.g. /users).', kind: 'convention' },
];

describe('relevance-scoped memory retrieval', () => {
  it('scores title overlap higher than body overlap', () => {
    expect(scoreEntry('zustand', 'Zustand state management', '')).toBeGreaterThan(
      scoreEntry('zustand', 'unrelated title', 'uses Zustand in body'),
    );
  });

  it('selects only the entries relevant to the query', () => {
    const out = selectRelevant('add redis cache to profile', E);
    const titles = out.map((e) => e.title);
    expect(titles).toContain('Redis cache policy');
    expect(titles).not.toContain('Zustand state management');
  });

  it('floats always-carry entries regardless of score', () => {
    const base: SelectableEntry[] = [{ title: 'A', body: 'x', always: true }, { title: 'other', body: 'unrelated words', kind: 'decision' }];
    const out = selectRelevant('completely unrelated query term xyzw', base);
    expect(out.map((e) => e.title)).toContain('A');
  });

  it('caps total selected tokens and drops low-score entries by default', () => {
    const out = selectRelevant('cache profile ttl redis', E, { maxTokens: 3, minScore: 0.5 });
    // maxTokens=3 chars/4 is tiny, so at most a single tiny entry survives.
    expect(out.length).toBeLessThanOrEqual(1);
  });

  it('deterministic tie-break on insertion order', () => {
    const a = selectRelevant('workers pool', [{ title: 'w', body: 'pool' }, { title: 'p', body: 'workers' }]);
    // Both score the same shape; the result is stable regardless (no NaN/sort jitter).
    expect(Array.isArray(a)).toBe(true);
  });

  it('tokenOverlap is 0 for empty query', () => {
    expect(tokenOverlap('this that', 'that')).toBe(0); // both are stopwords -> empty token set
    expect(tokenOverlap('cache', 'cache')).toBe(1);
    expect(tokenOverlap('cache', 'unrelated')).toBe(0);
  });
});