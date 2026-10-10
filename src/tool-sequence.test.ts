// MCH-52: tool-sequence predictor tests.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolSeqs, saveToolSeq, mineBigrams, toolPatternText } from './tool-sequence.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mochi-ts-'));
  dirs.push(d);
  return d;
}

describe('tool-sequence store', () => {
  it('save + load round-trips and caps at MAX_SEQS', () => {
    const dir = tempDir();
    const store = loadToolSeqs(dir);
    expect(store.seqs).toEqual([]);
    for (let i = 0; i < 5; i++) saveToolSeq(dir, store, ['run', 'edit', 'run', 'finish']);
    expect(store.seqs.length).toBe(5);
    const reloaded = loadToolSeqs(dir);
    expect(reloaded.seqs.length).toBe(5);
    expect(reloaded.seqs[4]).toEqual(['run', 'edit', 'run', 'finish']);
    expect(existsSync(join(dir, '.mochi', 'tool-seqs.json'))).toBe(true);
  });

  it('rejects trivial sequences and corrupt files', () => {
    const dir = tempDir();
    const store = loadToolSeqs(dir);
    saveToolSeq(dir, store, ['run']); // <3 tools: no signal
    expect(store.seqs.length).toBe(0);
    mkdirSync(join(dir, '.mochi'), { recursive: true });
    writeFileSync(join(dir, '.mochi', 'tool-seqs.json'), '{broken');
    expect(loadToolSeqs(dir).seqs).toEqual([]);
  });

  it('mineBigrams ranks transitions and toolPatternText formats', () => {
    const dir = tempDir();
    const store = loadToolSeqs(dir);
    for (let i = 0; i < 3; i++) saveToolSeq(dir, store, ['read', 'grep', 'edit', 'run']);
    saveToolSeq(dir, store, ['read', 'grep', 'edit']);
    const grams = mineBigrams(store, 5);
    expect(grams[0].count).toBe(4); // read -> grep appears in all 4 seqs
    const text = toolPatternText(store);
    expect(text).toContain('TOOL ROUTE PATTERNS');
    expect(text).toContain('read -> grep');
    expect(toolPatternText(loadToolSeqs(tempDir()))).toBe('');
  });
});
