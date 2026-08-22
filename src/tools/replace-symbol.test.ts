// replace_symbol: name-addressed whole-symbol replacement via the codegraph.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { replaceSymbol } from './replace-symbol.js';
import { getFunctionSynapse, ensureParserLoaded, hasSqlite } from '../codegraph.js';

// The symbol index needs node:sqlite (Node >= 22.5); CI also runs Node 20.
const maybeDescribe = hasSqlite() ? describe : describe.skip;

maybeDescribe('replaceSymbol', () => {
  it('replaces a function by name, keeping the rest of the file identical', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rs-'));
    writeFileSync(resolve(dir, 'sample.ts'), [
      'const keep = 1;',
      '',
      'export function target(a: number): number {',
      '  return a + 1;',
      '}',
      '',
      'export function after(): void {',
      '  console.log("untouched");',
      '}',
      '',
    ].join('\n'));
    // warm the index for this dir
    ensureParserLoaded?.();
    await getFunctionSynapse(dir, 'target');
    const r = await replaceSymbol(dir, 'target', 'export function target(a: number): number {\n  return a * 10;\n}');
    expect(r.ok).toBe(true);
    const out = readFileSync(resolve(dir, 'sample.ts'), 'utf8');
    expect(out).toContain('return a * 10;');
    expect(out).toContain('const keep = 1;');
    expect(out).toContain('console.log("untouched");');
    expect(out).not.toContain('return a + 1;');
  }, 30_000);

  it('fails clearly for unknown symbols', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rs-'));
    const r = await replaceSymbol(dir, 'doesNotExist', 'fn x() {}');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No definition|Could not resolve/);
  });
});
