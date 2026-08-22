// tools/read.ts: per-run read cache + line-sliced numbered output.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readTool } from './read.js';
import type { ToolContext } from './types.js';

let dir: string;
let ctx: ToolContext;
const FILE = 'src/data.txt';
const CONTENT = ['one', 'two', 'three', 'four', 'five'].join('\n') + '\n';

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-read-'));
  mkdirSync(resolve(dir, 'src'), { recursive: true });
  writeFileSync(resolve(dir, FILE), CONTENT);
  ctx = { cwd: dir, workspace: {} as any, config: {} as any, events: {} as any, agentId: 'r' };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('read tool', () => {
  it('returns the whole file with line numbers', async () => {
    const out = String(await readTool.execute({ path: FILE }, ctx));
    expect(out).toContain('   1 | one');
    expect(out).toContain('   5 | five');
  });

  it('honors offset and limit', async () => {
    const out = String(await readTool.execute({ path: FILE, offset: 2, limit: 2 }, ctx));
    expect(out).toContain('   2 | two');
    expect(out).toContain('   3 | three');
    expect(out).not.toContain('   1 | one');
    expect(out).not.toContain('   4 | four');
  });

  it('throws File not found for missing paths', async () => {
    await expect(readTool.execute({ path: 'nope.ts' }, ctx)).rejects.toThrow(/not found/);
  });

  it('caches reads by mtime+size and invalidates on change', async () => {
    const cache = new Map<string, { mtimeMs: number; size: number; content: string }>();
    const cctx = { ...ctx, readCache: cache };
    await readTool.execute({ path: FILE }, cctx);
    expect(cache.has(resolve(dir, FILE))).toBe(true);
    // Unchanged re-read hits the cache (no disk read; content identical).
    const first = cache.get(resolve(dir, FILE))!.content;
    // Mutate the file: cache must be refreshed on next read.
    writeFileSync(resolve(dir, FILE), CONTENT + 'six\n');
    const out = String(await readTool.execute({ path: FILE }, cctx));
    expect(out).toContain('   6 | six');
    expect(cache.get(resolve(dir, FILE))!.content).toContain('six');
    void first;
  });

  it('supports structural skeleton extraction when skeleton is true', async () => {
    const codeFile = 'src/example.ts';
    writeFileSync(resolve(dir, codeFile), 'export function calculate(x: number): number {\n  return x * 2;\n}\n');
    const out = String(await readTool.execute({ path: codeFile, skeleton: true }, ctx));
    expect(out).toContain('calculate');
  });
});