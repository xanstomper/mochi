import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { searchTool } from './search.js';
import { memoryTool } from './memory.js';
import { searchReplaceMultiTool } from './search-replace-multi.js';
import { analyzeCodeTool } from './analyze-code.js';
import { EventBus } from '../events.js';
import type { ToolContext, ReadCache } from './types.js';
import type { MochiConfig } from '../types.js';

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    workspace: { dir: cwd, root: cwd } as any,
    config: {} as MochiConfig,
    events: new EventBus(),
    agentId: 'test',
  };
}

describe('file tools', () => {
  it('reads files with line numbers', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    writeFileSync(resolve(dir, 'a.ts'), 'line1\nline2\nline3');
    const out = await readTool.execute({ path: resolve(dir, 'a.ts'), offset: 2, limit: 1 }, ctx(dir));
    expect(out).toContain('2 | line2');
  });

  it('writes and edits files', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    await writeTool.execute({ path: resolve(dir, 'b.ts'), content: 'hello world' }, ctx(dir));
    await editTool.execute({ path: resolve(dir, 'b.ts'), oldText: 'world', newText: 'mochi' }, ctx(dir));
    const content = readTool.execute({ path: resolve(dir, 'b.ts') }, ctx(dir));
    expect(await content).toContain('hello mochi');
  });

  it('edit falls back to fuzzy matching when whitespace differs', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    // File on disk: 4-space indentation. Model remembers 2-space.
    writeFileSync(resolve(dir, 'c.ts'), 'function a() {\n    if (x) {\n        return 1;\n    }\n}\n');
    const out = await editTool.execute(
      { path: resolve(dir, 'c.ts'), oldText: 'if (x) {\n  return 1;\n}', newText: 'if (x) {\n  return 42;\n}' },
      ctx(dir),
    );
    expect(out).toContain('fuzzy match');
    expect(readFileSync(resolve(dir, 'c.ts'), 'utf8')).toContain('return 42;');
  });

  it('edit refuses ambiguous fuzzy matches instead of guessing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    writeFileSync(resolve(dir, 'd.ts'), 'const a = 1;\nconst b = 2;\nconst a = 1;\n');
    await expect(editTool.execute(
      { path: resolve(dir, 'd.ts'), oldText: 'const a = 1;', newText: 'const a = 9;' },
      ctx(dir),
    )).rejects.toThrow();
    expect(readFileSync(resolve(dir, 'd.ts'), 'utf8')).not.toContain('= 9');
  });

  it('glob matches patterns', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    writeFileSync(resolve(dir, 'x.ts'), '1');
    writeFileSync(resolve(dir, 'y.js'), '1');
    const out = await globTool.execute({ pattern: '*.ts' }, ctx(dir));
    expect(out).toContain('x.ts');
  });

  it('curates project memory', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    const c = ctx(dir);
    await memoryTool.execute({ action: 'add', kind: 'decision', title: 'Use Zustand', body: 'State uses Zustand.' }, c);
    const out = await memoryTool.execute({ action: 'read' }, c);
    expect(out).toContain('Use Zustand');
  });
});

describe('read cache', () => {
  it('caches unchanged files and reflects edits via the mtime/size check', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    const p = resolve(dir, 'cached.ts');
    writeFileSync(p, 'v1\n');
    const cache: ReadCache = new Map();
    const c = { ...ctx(dir), readCache: cache };

    const first = await readTool.execute({ path: p }, c);
    expect(first).toContain('v1');
    expect(cache.size).toBe(1);

    // Second read of the same unchanged file hits the cache.
    const again = await readTool.execute({ path: p }, c);
    expect(again).toContain('v1');

    // Mutate the file with a distinct content/length; the signature changes and
    // the cache must reflect the new content even with the same cache instance.
    writeFileSync(p, 'v2 content that is longer\n');
    const afterWrite = await readTool.execute({ path: p }, c);
    expect(afterWrite).toContain('v2 content');
  });

  it('shares one cache across agent contexts so hot files are read once', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-'));
    const p = resolve(dir, 'shared.ts');
    writeFileSync(p, 'shared content\n');
    const shared: ReadCache = new Map();

    // Two different agents (distinct agentId) share the run-wide cache.
    const agentA = { ...ctx(dir), agentId: 'agent-a', readCache: shared };
    const agentB = { ...ctx(dir), agentId: 'agent-b', readCache: shared };

    const outA = await readTool.execute({ path: p }, agentA);
    expect(outA).toContain('shared content');
    expect(shared.size).toBe(1);

    // Agent B's read of the same unchanged file must hit the shared entry, not
    // grow the cache (i.e. not re-read the disk) -- cross-agent dedup.
    const outB = await readTool.execute({ path: p }, agentB);
    expect(outB).toContain('shared content');
    expect(shared.size).toBe(1);
  });
});

describe('structure-aware search', () => {
  it('groups matches by file with a per-file declaration outline', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-search-'));
    writeFileSync(resolve(dir, 'math.ts'), 'export function add(a, b) {\n  return a + b;\n}\nexport class Calc {\n  ping() {}\n}');
    const out = await searchTool.execute({ query: 'add' }, ctx(dir));
    expect(out).toContain('math.ts');
    expect(out).toContain('export function add');
    // structure hint surfaced without printing the whole file
    expect(out).toContain('function');
  });

  it('dedups repeated identical match lines', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-search-'));
    const repeated = 'import { x } from "./y";\n'.repeat(10);
    writeFileSync(resolve(dir, 'dup.ts'), repeated + 'export const z = 1;');
    const out = await searchTool.execute({ query: 'x' }, ctx(dir));
    // 11 raw matches (10 identical imports + 'export'), collapse display to ~2.
    expect(out).toMatch(/11 matches/);
    expect(out.match(/import \{ x \}/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('caps result lines via limit and marks truncation', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-search-'));
    let content = '';
    for (let i = 0; i < 30; i++) content += `export const v${i} = "${i}";\n`;
    writeFileSync(resolve(dir, 'many.ts'), content);
    const out = await searchTool.execute({ query: 'const', limit: 3 }, ctx(dir));
    // body lines are "N:export const v..." at start-of-line (outline is indented)
    const bodyCount = out.split('\n').filter((l) => /^\d+:\s*export const v\d/.test(l)).length;
    expect(bodyCount).toBeLessThanOrEqual(3);
    expect(out).toContain('(30 matches)'); // count intact, display capped
  });

  it('returns cached results on a repeated identical query', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-search-'));
    writeFileSync(resolve(dir, 'a.ts'), 'export function target() {}');
    const c = ctx(dir);
    const first = await searchTool.execute({ query: 'target' }, c);
    expect(first).toContain('target');
    expect(first).not.toContain('query cache hit');
    const second = await searchTool.execute({ query: 'target' }, c);
    expect(second).toContain('query cache hit');
  });

  it('invalidates the query cache after a write so results stay truthful', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-search-'));
    writeFileSync(resolve(dir, 'a.ts'), 'export const alpha = 1;');
    const c = ctx(dir);

    const first = await searchTool.execute({ query: 'alpha' }, c);
    expect(first).toContain('alpha');
    const repeat = await searchTool.execute({ query: 'alpha' }, c);
    expect(repeat).toContain('[query cache hit]');

    // A write that changes the answer must invalidate the stale cache entry.
    await writeTool.execute({ path: resolve(dir, 'b.ts'), content: 'export const gamma = 2;' }, c);
    const fresh = await searchTool.execute({ query: 'gamma' }, c);
    expect(fresh).toContain('gamma');
    expect(fresh).not.toContain('[query cache hit]');
  });

    it('invalidates the query cache after an edit', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-search-'));
    writeFileSync(resolve(dir, 'c.ts'), 'export const marker = "old";');
    const c = ctx(dir);

    await searchTool.execute({ query: 'newval' }, c); // no match -> cached
    await editTool.execute({ path: resolve(dir, 'c.ts'), oldText: 'old', newText: 'newval' }, c);
    const afterEdit = await searchTool.execute({ query: 'newval' }, c);
    expect(afterEdit).toContain('newval');
    expect(afterEdit).not.toContain('[query cache hit]');
  });
});

describe('search_replace_multi', () => {
  it('replaces patterns across multiple files', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-mreplace-'));
    await writeTool.execute({ path: resolve(dir, 'a.ts'), content: 'old\nold\n' }, ctx(dir));
    await writeTool.execute({ path: resolve(dir, 'b.ts'), content: 'old\n' }, ctx(dir));
    const out = await searchReplaceMultiTool.execute(
      { pattern: 'old', replacement: 'new', preview: false },
      ctx(dir),
    );
    expect(out).toContain('Replaced 3');
    expect(readFileSync(resolve(dir, 'a.ts'), 'utf8')).toBe('new\nnew\n');
    expect(readFileSync(resolve(dir, 'b.ts'), 'utf8')).toBe('new\n');
  });

  it('previews changes without writing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-mreplace-'));
    await writeTool.execute({ path: resolve(dir, 'a.ts'), content: 'old\n' }, ctx(dir));
    const out = await searchReplaceMultiTool.execute(
      { pattern: 'old', replacement: 'new', preview: true },
      ctx(dir),
    );
    expect(out).toContain('Preview');
    expect(readFileSync(resolve(dir, 'a.ts'), 'utf8')).toBe('old\n');
  });
});

describe('analyze_code', () => {
  it('analyzes a file and returns complexity metrics', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-analyze-'));
    await writeTool.execute({
      path: resolve(dir, 'test.ts'),
      content: 'function foo() {\n  if (x) {\n    return 1;\n  }\n  return 0;\n}\n',
    }, ctx(dir));
    const out = await analyzeCodeTool.execute({ path: 'test.ts' }, ctx(dir));
    expect(out).toContain('Code Analysis');
    expect(out).toContain('Complexity Score:');
    expect(out).toContain('Functions:');
  });
});
