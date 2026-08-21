import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirTool, moveFileTool, copyFileTool } from './file-ops.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

describe('file-ops tools', () => {
  let dir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-fileops-'));
    const ws = new Workspace(dir);
    ws.ensure();
    ctx = { cwd: dir, workspace: ws, config: {} as MochiConfig, events: new EventBus(), agentId: 'test' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates directories recursively', async () => {
    const res = await mkdirTool.execute({ path: 'a/b/c' }, ctx);
    expect(res).toContain('Created directory');
    expect(existsSync(join(dir, 'a', 'b', 'c'))).toBe(true);
  });

  it('moves and renames files', async () => {
    writeFileSync(join(dir, 'hello.txt'), 'hello world');
    const res = await moveFileTool.execute({ source: 'hello.txt', destination: 'sub/hello.txt' }, ctx);
    expect(res).toContain('Moved');
    expect(existsSync(join(dir, 'hello.txt'))).toBe(false);
    expect(existsSync(join(dir, 'sub', 'hello.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'sub', 'hello.txt'), 'utf8')).toBe('hello world');
  });

  it('copies files to a destination path', async () => {
    writeFileSync(join(dir, 'source.txt'), 'content');
    const res = await copyFileTool.execute({ source: 'source.txt', destination: 'copied.txt' }, ctx);
    expect(res).toContain('Copied');
    expect(existsSync(join(dir, 'source.txt'))).toBe(true);
    expect(existsSync(join(dir, 'copied.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'copied.txt'), 'utf8')).toBe('content');
  });
});
