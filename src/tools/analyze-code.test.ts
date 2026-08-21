import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { analyzeCodeTool } from './analyze-code.js';
import { searchReplaceMultiTool } from './search-replace-multi.js';
import type { ToolContext } from './types.js';

function makeCtx(dir: string): ToolContext {
  return {
    cwd: dir,
    agentId: 'test-agent',
    events: { emit: () => {} } as any,
  } as unknown as ToolContext;
}

describe('analyze_code', () => {
  it('reports metrics for a single file', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-analyze-'));
    writeFileSync(resolve(dir, 'a.ts'), 'class Foo {}\nfunction bar() { if (x) { for (;;) {} } }\n');
    const out = await analyzeCodeTool.execute({ path: 'a.ts' }, makeCtx(dir));
    expect(out).toContain('Files: 1');
    expect(out).toContain('Classes: 1');
    expect(out).toContain('Complexity Score: 2'); // if + for
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks directories respecting depth', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-analyze-'));
    writeFileSync(resolve(dir, 'top.ts'), 'const a = 1;\n');
    mkdirSync(resolve(dir, 'sub'));
    writeFileSync(resolve(dir, 'sub', 'inner.js'), 'function f() {}\n');
    const depth0 = await analyzeCodeTool.execute({ path: '.', depth: 0 }, makeCtx(dir));
    expect(depth0).toContain('Files: 1'); // only top-level ts
    const depth1 = await analyzeCodeTool.execute({ path: '.', depth: 1 }, makeCtx(dir));
    expect(depth1).toContain('Files: 2');
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws for a missing path', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-analyze-'));
    await expect(analyzeCodeTool.execute({ path: 'nope.ts' }, makeCtx(dir))).rejects.toThrow(/not found/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('search_replace_multi', () => {
  it('replaces across multiple files and reports counts', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-srm-'));
    writeFileSync(resolve(dir, 'a.ts'), 'const oldFn = 1;\n');
    writeFileSync(resolve(dir, 'b.ts'), 'oldFn(); oldFn();\n');
    const out = await searchReplaceMultiTool.execute(
      { pattern: 'oldFn', replacement: 'newFn', path: '.' },
      makeCtx(dir),
    );
    expect(out).toContain('Replaced 3 occurrence(s)');
    expect(readFileSync(resolve(dir, 'a.ts'), 'utf8')).toContain('newFn');
    expect(readFileSync(resolve(dir, 'b.ts'), 'utf8')).toBe('newFn(); newFn();\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('preview mode does not write and shows a diff', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-srm-'));
    writeFileSync(resolve(dir, 'a.ts'), 'keep me\nchange me\n');
    const out = await searchReplaceMultiTool.execute(
      { pattern: 'change', replacement: 'CHANGED', path: '.', preview: true },
      makeCtx(dir),
    );
    expect(out).toContain('Preview: 1 replacement(s)');
    expect(out).toContain('- change me');
    expect(out).toContain('+ CHANGED me');
    expect(readFileSync(resolve(dir, 'a.ts'), 'utf8')).toBe('keep me\nchange me\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('honors extension filters', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-srm-'));
    writeFileSync(resolve(dir, 'a.ts'), 'target token\n');
    writeFileSync(resolve(dir, 'b.md'), 'target token\n');
    await searchReplaceMultiTool.execute(
      { pattern: 'target', replacement: 'done', path: '.', extensions: ['.ts'] },
      makeCtx(dir),
    );
    expect(readFileSync(resolve(dir, 'a.ts'), 'utf8')).toContain('done');
    expect(readFileSync(resolve(dir, 'b.md'), 'utf8')).toContain('target');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects invalid regex', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-srm-'));
    await expect(
      searchReplaceMultiTool.execute({ pattern: '([unclosed', replacement: 'x' }, makeCtx(dir)),
    ).rejects.toThrow(/Invalid regex/);
    rmSync(dir, { recursive: true, force: true });
  });
});