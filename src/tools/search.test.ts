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

function isolatedCtx(files: Record<string, string>): { testDir: string; testCtx: ToolContext } {
  const testDir = mkdtempSync(resolve(tmpdir(), 'mochi-search-mode-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(testDir, name), content);
  }
  return {
    testDir,
    testCtx: { cwd: testDir, workspace: {} as any, config: {} as any, events: {} as any, agentId: 't' },
  };
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
  }, 60_000);

  it('treats regex metacharacters literally by default', async () => {
    const { testDir, testCtx } = isolatedCtx({
      'sample.ts': 'call foo(bar);\ncall fooXbar);\n',
    });
    try {
      const out = String(await searchTool.execute({ query: 'foo(' }, testCtx));
      expect(out).toContain('call foo(bar);');
      expect(out).not.toContain('call fooXbar);');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('matches a pattern when regex is true', async () => {
    const { testDir, testCtx } = isolatedCtx({
      'sample.ts': 'call foo(alpha);\ncall bar(beta);\ncall baz(gamma);\n',
    });
    try {
      const out = String(await searchTool.execute({ query: 'foo\\(|bar\\(', regex: true }, testCtx));
      expect(out).toContain('call foo(alpha);');
      expect(out).toContain('call bar(beta);');
      expect(out).not.toContain('call baz(gamma);');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('matches get\\w+ as a regex against identifiers', async () => {
    const { testDir, testCtx } = isolatedCtx({
      'sample.ts': 'export function getUser() {}\nexport function setUser() {}\n',
    });
    try {
      const out = String(await searchTool.execute({ query: 'get\\w+', regex: true }, testCtx));
      expect(out).toContain('(1 match)');
      expect(out).toContain('\n1:export function getUser() {}');
      // The file outline may mention setUser, but it must not be a match line.
      expect(out).not.toContain('\n2:export function setUser() {}');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('uses the raw pattern in the fallback walker', async () => {
    const { testDir, testCtx } = isolatedCtx({
      'sample.ts': 'const a = "foobar";\nconst b = "foobaz";\n',
    });
    try {
      // Rust regex (ripgrep's default engine) rejects lookahead, so this
      // JavaScript-supported pattern exercises the bounded-walk fallback.
      const out = String(await searchTool.execute({ query: 'foo(?=bar)', regex: true }, testCtx));
      expect(out).toContain('const a = "foobar";');
      expect(out).not.toContain('\n2:const b = "foobaz";');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns a tool error instead of throwing for an invalid regex', async () => {
    const out = String(await searchTool.execute({ query: '[', regex: true }, ctx));
    expect(out).toContain('Invalid regex:');
  });

  it('does not share a cache entry between literal and regex modes', async () => {
    const { testDir, testCtx } = isolatedCtx({
      'sample.ts': 'const exact = "get.*";\nconst user = getUser();\n',
    });
    try {
      const literal = String(await searchTool.execute({ query: 'get.*' }, testCtx));
      expect(literal).toContain('(1 match)');
      expect(literal).toContain('\n1:const exact = "get.*";');
      // The outline may mention line 2, but only line 1 is a literal match.
      expect(literal).not.toContain('\n2:const user = getUser();');

      const regex = String(await searchTool.execute({ query: 'get.*', regex: true }, testCtx));
      expect(regex).not.toContain('[query cache hit]');
      expect(regex).toContain('(2 matches)');
      expect(regex).toContain('\n1:const exact = "get.*";');
      expect(regex).toContain('\n2:const user = getUser();');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('the sync tree walk is bounded by the file budget (freeze guard)', async () => {
    // Regression for the hard freeze: fallbackSearch walked the whole tree
    // synchronously (readdirSync/readFileSync on the main thread) and could
    // block the event loop for minutes on a large repo (no timer, no trace,
    // no Ctrl-C). A search expected to miss everything must still RESOLVE
    // (not hang) — the walk budget + setImmediate yield path is exercised.
    const walkDir = mkdtempSync(resolve(tmpdir(), 'mochi-walk-'));
    try {
      for (let i = 0; i < 150; i++) writeFileSync(resolve(walkDir, `f${i}.ts`), `// file ${i}\nconst x${i} = ${i};\n`);
      const tctx = { cwd: walkDir, workspace: {} as any, config: {} as any, events: {} as any, agentId: 't' };
      const res = await searchTool.execute({ query: 'zzz_nonexistent_token_zzz' }, tctx);
      expect(String(res).length).toBeGreaterThan(0);
    } finally {
      rmSync(walkDir, { recursive: true, force: true });
    }
  }, 60_000);
});