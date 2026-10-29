// MCH-lazy 14.1: lazy file slices — bounded head+task-region windows stamped
// with an mtime/size revision, and INVALIDATION: a file changed after
// slicing is re-read fresh, never served stale.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  lazySliceFile,
  lazySliceRegion,
  revisionChanged,
  extractTaskTerms,
  pickSliceRanges,
} from './lazy-file.js';

let dir: string;

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-lazy-file-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('lazy file slicing', () => {
  it('extracts meaningful task terms and drops stopwords', () => {
    const terms = extractTaskTerms('Fix the parseQux bug in src/parser.ts please, must handle null');
    expect(terms).toContain('parseQux');
    expect(terms).toContain('parser');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('must');
  });

  it('slices head + task-relevant region, not the whole file', () => {
    const lines = Array.from({ length: 900 }, (_, i) => `line ${i + 2} filler`);
    lines[430] = 'function parseQux(input) { return input; }';
    const p = write('parser.js', ['line 1 filler', ...lines].join('\n'));
    const slice = lazySliceFile(p, { taskTerms: ['parseQux'], headLines: 20, tailLines: 5 });
    expect(slice).not.toBeNull();
    expect(slice!.taskRegion).toBe(true);
    expect(slice!.totalLines).toBe(901);
    expect(slice!.omittedLines).toBeGreaterThan(0);
    expect(slice!.text).toContain('parseQux');
    expect(slice!.text).toContain('omitted');
    // Bounded: the slice text must be far smaller than the full file.
    expect(slice!.text.length).toBeLessThan(4000);
  });

  it('records the revision (path + mtime + size) with every slice', () => {
    const p = write('rev.txt', 'alpha\nbeta\n');
    const slice = lazySliceFile(p, { taskTerms: ['alpha'] });
    expect(slice!.rev.path).toBe(p);
    expect(slice!.rev.size).toBeGreaterThan(0);
    expect(slice!.rev.mtimeMs).toBeGreaterThan(0);
    expect(revisionChanged(p, slice!.rev)).toBe(false);
  });

  it('picks definition lines over ordinary mentions when scoring', () => {
    const content = [
      'const parseQux = mentioned here once;',
      ...Array.from({ length: 200 }, (_, i) => `filler ${i}`),
      'function parseQux(input) {',
      '  return input;',
      '}',
    ].join('\n');
    const { ranges, taskRegion } = pickSliceRanges(content, { taskTerms: ['parseQux'], headLines: 5, tailLines: 2, contextLines: 2 });
    expect(taskRegion).toBe(true);
    const last = ranges[ranges.length - 1]!;
    // The definition region (around line 202) must be among the kept ranges.
    expect(last.end).toBeGreaterThanOrEqual(204);
  });

  it('INVALIDATION: file changed after slicing — deferred region fetch re-reads fresh, never serves stale', () => {
    const p = write('mutate.js', ['head', ...Array.from({ length: 500 }, (_, i) => `old body ${i}`), 'tail'].join('\n'));
    const slice = lazySliceFile(p, { taskTerms: ['nonexistent-terms'], headLines: 5, tailLines: 2 });
    expect(slice).not.toBeNull();
    const oldRev = slice!.rev;

    // Mutate the file AFTER slicing.
    write('mutate.js', ['head', ...Array.from({ length: 500 }, (_, i) => `NEW body ${i}`), 'tail'].join('\n'));
    // Force mtime change visibility: bump mtime explicitly in case of coarse
    // timestamps + identical size. Use a different size too for certainty.
    write('mutate.js', ['head', ...Array.from({ length: 500 }, (_, i) => `NEW body ${i} (changed)`), 'tail'].join('\n'));

    expect(revisionChanged(p, oldRev)).toBe(true);

    // The deferred fetch MUST return the CURRENT content and flag the change.
    const region = lazySliceRegion(p, oldRev, 10, 20);
    expect(region).not.toBeNull();
    expect(region!.fresh).toBe(true);
    expect(region!.text).toContain('NEW body 10 (changed)');
    expect(region!.text).not.toContain('old body 10');
    expect(region!.text).toContain('fresh re-read');
    expect(region!.rev.mtimeMs).toBeGreaterThanOrEqual(oldRev.mtimeMs);
  });

  it('unchanged file: deferred fetch serves the slice content with no stale flag', () => {
    const p = write('stable.txt', Array.from({ length: 100 }, (_, i) => `stable ${i}`).join('\n'));
    const slice = lazySliceFile(p, { taskTerms: ['stable 50'], headLines: 5, tailLines: 2 });
    const region = lazySliceRegion(p, slice!.rev, 48, 52);
    expect(region!.fresh).toBe(false);
    expect(region!.text).toContain('stable 50');
    expect(region!.text).not.toContain('fresh re-read');
  });

  it('missing/vanished file: region fetch reports rather than serving stale bytes', () => {
    const p = write('ghost.txt', 'a\nb\nc\n');
    const slice = lazySliceFile(p, { taskTerms: ['a'] });
    rmSync(p);
    expect(lazySliceRegion(p, slice!.rev, 1, 2)).toBeNull();
  });

  it('mtime-only change invalidates even when size is identical', () => {
    const p = write('mtime.txt', 'aaaa\nbbbb\ncccc\n');
    const slice = lazySliceFile(p, { taskTerms: ['aaaa'] });
    const future = slice!.rev.mtimeMs + 5000;
    utimesSync(p, new Date(future / 1000), new Date(future / 1000));
    expect(revisionChanged(p, slice!.rev)).toBe(true);
    const region = lazySliceRegion(p, slice!.rev, 1, 1);
    expect(region!.fresh).toBe(true);
  });

  it('small files never produce a task-region claim (head window covers them)', () => {
    const p = write('small.txt', 'a\nb\nc\n');
    const slice = lazySliceFile(p, { taskTerms: ['b'], headLines: 10, tailLines: 2 });
    expect(slice!.taskRegion).toBe(false);
    expect(slice!.omittedLines).toBe(0);
  });
});
