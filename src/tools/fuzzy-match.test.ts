import { describe, it, expect } from 'vitest';
import { fuzzyFindUnique, levenshtein, lineSimilarity, normalizeLine } from './fuzzy-match.js';

describe('3-Way Tolerant Fuzzy Matcher', () => {
  it('computes exact Levenshtein distance accurately', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('hello', 'hello')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('computes line similarity ratio', () => {
    expect(lineSimilarity('const x = 1;', 'const x = 1;')).toBe(1.0);
    expect(lineSimilarity('const x = 1;', 'const y = 1;')).toBeGreaterThan(0.8);
    expect(lineSimilarity('const x = 1;', 'function veryDifferent() {}')).toBeLessThan(0.4);
  });

  it('matches exact and whitespace-normalized blocks', () => {
    const text = 'function add(a: number, b: number) {\n  return a + b;\n}\n';
    const needle = 'return a + b;';
    const match = fuzzyFindUnique(text, needle);
    expect(match).not.toBeNull();
    expect(text.slice(match!.start, match!.end)).toBe('  return a + b;');
  });

  it('self-heals minor line/comment drift across multi-line blocks', () => {
    const text = [
      '// Initialize auth handler',
      'const user = await getUser(id);',
      'if (!user) {',
      '  return null;',
      '}',
      'return user;',
    ].join('\n');

    // Needle with 1 drifted comment line ("// Init auth handler" instead of "// Initialize auth handler")
    const driftedNeedle = [
      '// Init auth handler',
      'const user = await getUser(id);',
      'if (!user) {',
      '  return null;',
      '}',
    ].join('\n');

    const match = fuzzyFindUnique(text, driftedNeedle);
    expect(match).not.toBeNull();
    const matchedSnippet = text.slice(match!.start, match!.end);
    expect(matchedSnippet).toContain('Initialize auth handler');
    expect(matchedSnippet).toContain('return null;');
  });

  it('returns null on completely unrelated needles', () => {
    const text = 'const a = 10;\nconst b = 20;\n';
    const needle = 'class DatabaseConnectionPool {\n  connect() {}\n}';
    expect(fuzzyFindUnique(text, needle)).toBeNull();
  });
});
