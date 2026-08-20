// tools/delete.ts: file deletion + mutation fence + event.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { deleteTool } from './delete.js';
import { mutationGeneration } from './fs-signal.js';
import type { ToolContext } from './types.js';

let dir: string;
const F = 'gone.txt';
beforeAll(() => { dir = mkdtempSync(resolve(tmpdir(), 'mochi-del-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ctx(): ToolContext {
  return { cwd: dir, workspace: {} as any, config: {} as any, events: { emit: () => {} } as any, agentId: 'd' };
}

describe('delete tool', () => {
  it('deletes an existing file and bumps the mutation fence', async () => {
    const path = resolve(dir, F);
    writeFileSync(path, 'x');
    expect(existsSync(path)).toBe(true);
    const before = mutationGeneration();
    const out = String(await deleteTool.execute({ path: F }, ctx()));
    expect(out).toContain('Deleted gone.txt');
    expect(existsSync(path)).toBe(false);
    expect(mutationGeneration()).toBeGreaterThan(before);
  });

  it('throws File not found for missing files', async () => {
    await expect(deleteTool.execute({ path: 'nope.txt' }, ctx())).rejects.toThrow(/not found/);
  });
});