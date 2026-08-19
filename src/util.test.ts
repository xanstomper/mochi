import { describe, expect, it } from 'vitest';
import {
  randomSlug, binarySearch, binaryInsert, binaryInsertInPlace, sortableId, lazy,
  getFilename, getDirectory, getFilenameTruncated, truncateMiddle,
} from './util.js';

describe('randomSlug (from OpenFable)', () => {
  it('returns adjective-noun slugs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const s = randomSlug();
      expect(s).toMatch(/^[a-z]+-[a-z]+$/);
      seen.add(s);
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('binarySearch / binaryInsert (from OpenFable)', () => {
  it('finds existing items and reports the insertion index for missing ones', () => {
    const arr = ['apple', 'banana', 'cherry'];
    expect(binarySearch(arr, 'banana', (x) => x)).toEqual({ found: true, index: 1 });
    expect(binarySearch(arr, 'blueberry', (x) => x).found).toBe(false);
    expect(binarySearch(arr, 'blueberry', (x) => x).index).toBe(2);
    expect(binarySearch(arr, 'aardvark', (x) => x).index).toBe(0);
  });

  it('inserts while keeping the array sorted (copy and in place)', () => {
    const sorted = binaryInsert(['apple', 'cherry'], 'banana', (x) => x);
    expect(sorted).toEqual(['apple', 'banana', 'cherry']);

    const inPlace = ['alpha', 'gamma'];
    binaryInsertInPlace(inPlace, 'beta', (x) => x);
    expect(inPlace).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('sortableId (from OpenFable Identifier)', () => {
  it('produces ascending lexicographic IDs', () => {
    const earlier = sortableId(1_700_000_000_000);
    const later = sortableId(1_700_000_000_010);
    expect(earlier < later).toBe(true);
    expect(earlier.length).toBe(26);
    expect(later.length).toBe(26);
  });
});

describe('lazy (from OpenFable)', () => {
  it('initializes once and memoizes', () => {
    let calls = 0;
    const get = lazy(() => {
      calls++;
      return { value: 42 };
    });
    expect(get().value).toBe(42);
    expect(get().value).toBe(42);
    expect(calls).toBe(1);
  });
});

describe('path + truncate (from OpenFable)', () => {
  it('basename and directory handle / and \\', () => {
    expect(getFilename('src/deep/file.ts')).toBe('file.ts');
    expect(getFilename('C:\\repo\\main.ts')).toBe('main.ts');
    expect(getFilename('')).toBe('');
    expect(getDirectory('src/deep/file.ts')).toBe('src/deep/');
  });

  it('truncates long filenames keeping the extension', () => {
    expect(getFilenameTruncated('src/a/veryLongModuleNameHereFile.ts', 18)).toBe('veryLongModule….ts');
  });

  it('truncates text in the middle so both ends survive', () => {
    expect(truncateMiddle('0123456789', 9)).toBe('0123…6789'); // head+tail, ellipsis
    expect(truncateMiddle('short', 10)).toBe('short');
    const t = truncateMiddle('header-middle-tail', 10);
    expect(t.startsWith('heade')).toBe(true);
    expect(t.endsWith('tail')).toBe(true);
  });
});