import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { regexReplaceTool } from './regex-replace.js';

function makeCtx(cwd: string) {
  return { cwd, workspace: new Workspace(cwd, '.mochi'), events: new EventBus(), config: { permissions: { write: true }, safety: { mode: 'auto' } } as any, agentId: 'test' };
}

describe('regexReplaceTool', () => {
  it('replaces all occurrences by default', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rr-'));
    writeFileSync(resolve(dir, 'f.ts'), 'const a = 1;\nconst b = 1;\n');
    const ctx = makeCtx(dir);
    const result = await regexReplaceTool.execute({ path: 'f.ts', pattern: '1', replacement: '42' }, ctx);
    expect(result).toContain('2 occurrence');
    expect(readFileSync(resolve(dir, 'f.ts'), 'utf8')).toContain('const a = 42;');
  });

  it('returns no-match message when pattern not found', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rr-'));
    writeFileSync(resolve(dir, 'f.ts'), 'hello world');
    const ctx = makeCtx(dir);
    const result = await regexReplaceTool.execute({ path: 'f.ts', pattern: 'zzz', replacement: 'x' }, ctx);
    expect(result).toContain('No matches');
  });

  it('preview mode returns diff without writing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rr-'));
    const original = 'foo bar foo';
    writeFileSync(resolve(dir, 'f.ts'), original);
    const ctx = makeCtx(dir);
    const result = await regexReplaceTool.execute({ path: 'f.ts', pattern: 'foo', replacement: 'baz', preview: true }, ctx);
    expect(result).toContain('Preview');
    expect(result).toContain('+baz');
    // File should be unchanged
    expect(readFileSync(resolve(dir, 'f.ts'), 'utf8')).toBe(original);
  });
});
