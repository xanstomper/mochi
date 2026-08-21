import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDiagnosticsTool } from './diagnostics-tool.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

describe('diagnostics-tool', () => {
  let dir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-diagtool-'));
    const ws = new Workspace(dir);
    ws.ensure();
    ctx = { cwd: dir, workspace: ws, config: {} as MochiConfig, events: new EventBus(), agentId: 'test' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports missing file', async () => {
    const res = await getDiagnosticsTool.execute({ path: 'nonexistent.ts' }, ctx);
    expect(res).toContain('file not found');
  });

  it('runs diagnostics on valid python file', async () => {
    writeFileSync(join(dir, 'clean.py'), 'def add(a, b):\n    return a + b\n');
    const res = await getDiagnosticsTool.execute({ path: 'clean.py' }, ctx);
    expect(res).toContain('No diagnostics or syntax errors');
  });
});
