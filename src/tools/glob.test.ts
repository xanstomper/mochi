// tools/glob.ts: file globbing across a real temp tree.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { globTool } from './glob.js';
import type { ToolContext } from './types.js';

let dir: string;
let ctx: ToolContext;
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-glob-'));
  mkdirSync(resolve(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(resolve(dir, 'src', 'a.ts'), '');
  writeFileSync(resolve(dir, 'src', 'b.ts'), '');
  writeFileSync(resolve(dir, 'src', 'c.js'), '');
  writeFileSync(resolve(dir, 'src', 'deep', 'd.ts'), '');
  writeFileSync(resolve(dir, 'README.md'), '');
  writeFileSync(resolve(dir, '.gitignore'), 'ignored.txt\n');
  writeFileSync(resolve(dir, 'ignored.txt'), 'x');
  ctx = { cwd: dir, workspace: {} as any, config: {} as any, events: {} as any, agentId: 't' };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runGlob(pattern: string, limit = 100): Promise<string> {
  const out = await globTool.execute({ pattern, limit }, ctx);
  return String(out);
}

describe('glob tool', () => {
  it('matches a literal pattern', async () => {
    const out = await runGlob('README.md');
    expect(out).toContain('README.md');
  });

  it('single * matches one segment only', async () => {
    const out = await runGlob('src/*');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(out).not.toContain('src/deep/d.ts'); // ** needed for recursion
  });

  it('** recurses into subdirectories', async () => {
    const out = await runGlob('src/**/*.ts');
    expect(out).toContain('src/deep/d.ts');
    expect(out).toContain('src/a.ts');
  });

  it('? matches exactly one character', async () => {
    writeFileSync(resolve(dir, 'src', 'xb.ts'), '');
    const q = await runGlob('src/?b.ts');
    expect(q).toContain('src/xb.ts');
    expect(q).not.toContain('src/b.ts'); // one char required before 'b'
    expect(q).not.toContain('src/ab.ts');
  });

  it('escapes user metacharacters so globs cannot inject regex (hardened code path)', async () => {
    // A '[' bracket in the pattern must not become a character class.
    const out = await runGlob('src/[a].ts');
    expect(out).not.toContain('src/a.ts'); // literal '[a]' matches nothing
  });

  it('respects limit', async () => {
    const out = await runGlob('**', 2);
    expect(out.split('\n').filter(Boolean).length).toBeLessThanOrEqual(2);
  });
});