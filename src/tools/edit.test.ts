// tools/edit.ts: exact + whitespace-tolerant fuzzy replace with ambiguity guard.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { editTool } from './edit.js';
import type { ToolContext } from './types.js';

let dir: string;
let ctx: ToolContext;
const F = 'file.ts';
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit-'));
  ctx = { cwd: dir, workspace: {} as any, config: {} as any, events: { emit: () => {} } as any, agentId: 'e' };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seed(content: string): void {
  writeFileSync(resolve(dir, F), content);
}

describe('edit tool', () => {
  it('replaces an exact unique block', async () => {
    seed('export const a = 1;\nexport const b = 2;\n');
    const out = String(await editTool.execute({ path: F, oldText: 'a = 1', newText: 'a = 42' }, ctx));
    expect(out).toContain('Edited file.ts');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('a = 42');
  });

  it('tolerates whitespace drift via fuzzy match (unique only)', async () => {
    seed('function x() {\n    return 1;\n}\n');
    const out = String(await editTool.execute({
      path: F,
      oldText: '  function x() {\n    return 1;\n  }', // different indentation
      newText: 'function x() {\n  return 2;\n}',
    }, ctx));
    expect(out).toContain('fuzzy match');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('return 2;');
  });

  it('refuses ambiguous matches (needs unique context)', async () => {
    seed('const v = 1;\nconst v = 2;\n');
    await expect(editTool.execute({ path: F, oldText: 'const v =', newText: 'const w =' }, ctx)).rejects.toThrow(/unique|locations/);
  });

  it('throws when oldText is absent', async () => {
    seed('nothing here');
    await expect(editTool.execute({ path: F, oldText: 'missing', newText: 'x' }, ctx)).rejects.toThrow(/not found/);
  });

  it('trims common indentation when trim is set', async () => {
    seed('const z = 0;\n');
    const out = String(await editTool.execute({
      path: F, oldText: 'z = 0', newText: '\n  z = 1\n', trim: true,
    }, ctx));
    expect(out).toContain('Edited');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('z = 1;');
  });
});