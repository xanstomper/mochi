import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { diffTool } from './diff.js';

function makeCtx(cwd: string) {
  return { cwd, workspace: new Workspace(cwd, '.mochi'), events: new EventBus(), config: { permissions: { read: true }, safety: { mode: 'auto' } } as any, agentId: 'test' };
}

describe('diffTool', () => {
  it('returns "No changes." when file and content are identical', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-diff-'));
    writeFileSync(resolve(dir, 'a.txt'), 'hello\nworld\n');
    const ctx = makeCtx(dir);
    const result = await diffTool.execute({ path: 'a.txt', content: 'hello\nworld\n' }, ctx);
    expect(result).toBe('No changes.');
  });

  it('shows added and removed lines when content differs (full: true; default is the lazy summary)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-diff-'));
    writeFileSync(resolve(dir, 'a.txt'), 'foo\nbar\n');
    const ctx = makeCtx(dir);
    // MCH-lazy 14.2: the default presentation is now the compact lazy
    // summary; the full hunks are one `full: true` call away.
    const lazy = await diffTool.execute({ path: 'a.txt', content: 'foo\nbaz\n' }, ctx);
    expect(lazy).toContain('[lazy diff: 1 file changed');
    expect(lazy).toContain('+2/-2');
    const result = await diffTool.execute({ path: 'a.txt', content: 'foo\nbaz\n', full: true }, ctx);
    expect(result).toContain('-bar');
    expect(result).toContain('+baz');
  });

  it('diffs two files (full: true; default is the lazy summary)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-diff-'));
    writeFileSync(resolve(dir, 'a.txt'), 'line1\nline2\n');
    writeFileSync(resolve(dir, 'b.txt'), 'line1\nline3\n');
    const ctx = makeCtx(dir);
    const result = await diffTool.execute({ path: 'a.txt', path_b: 'b.txt', full: true }, ctx);
    expect(result).toContain('-line2');
    expect(result).toContain('+line3');
  });
});
