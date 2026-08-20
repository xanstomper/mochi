// tools/search.ts: literal search with structure hints + mutation-keyed cache.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { searchTool } from './search.js';
import type { ToolContext } from './types.js';

let dir: string;
let ctx: ToolContext;
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-search-'));
  mkdirSync(resolve(dir, 'src'), { recursive: true });
  writeFileSync(resolve(dir, 'src', 'math.ts'), [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '// the add helper',
    '',
  ].join('\n'));
  writeFileSync(resolve(dir, 'src', 'util.js'), 'const add = (a, b) => a + b;\n');
  writeFileSync(resolve(dir, 'README.md'), '# math utils\n');
  ctx = { cwd: dir, workspace: {} as any, config: {} as any, events: {} as any, agentId: 't' };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runSearch(query: string, glob?: string): Promise<string> {
  return String(await searchTool.execute({ query, ...(glob ? { glob } : {}) }, ctx));
}

describe('search tool', () => {
  it('finds a literal with line numbers + declaration outline', async () => {
    const out = await runSearch('a + b');
    expect(out).toContain('src/math.ts');
    expect(out).toContain('2:'); // line number of `return a + b;`
    // rg was found, so structured output includes the decl outline hint
    expect(out).toContain('decl:');
  });

  it('glob filter restricts which files are searched', async () => {
    const out = await runSearch('add', 'src/util.js');
    expect(out).toContain('src/util.js');
    expect(out).not.toContain('src/math.ts');
  });

  it('caches repeat queries and invalidates on mutation', async () => {
    const first = await runSearch('a + b');
    expect(first.length).toBeGreaterThan(0);
    // Second same-generation call returns the cache-hit marker.
    const second = await runSearch('a + b');
    expect(second).toContain('[query cache hit]');
    // Mutate a file + bump the fs-signal generation (as write/edit/delete do
    // via markMutation), then query again: the cache must invalidate.
    writeFileSync(resolve(dir, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n// changed after mutation\n');
    const { markMutation } = await import('./fs-signal.js');
    markMutation();
    const third = await runSearch('a + b');
    expect(third).not.toContain('[query cache hit]');
    // Fresh search: the mutated file is still matched (cache was invalidated
    // so results reflect the post-write tree, not a stale generation).
    expect(third).toContain('src/math.ts');
  }, 30_000);
});