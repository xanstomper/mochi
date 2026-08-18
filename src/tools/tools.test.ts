import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { memoryTool } from './memory.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
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
