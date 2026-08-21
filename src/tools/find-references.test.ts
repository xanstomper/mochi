import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findReferencesTool, findDefinitionsTool } from './find-references.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

describe('find-references and find-definitions tools', () => {
  let dir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-findref-'));
    const ws = new Workspace(dir);
    ws.ensure();
    ctx = { cwd: dir, workspace: ws, config: {} as MochiConfig, events: new EventBus(), agentId: 'test' };

    writeFileSync(join(dir, 'a.ts'), 'export function computeTotal(x: number) { return x * 2; }\n');
    writeFileSync(join(dir, 'b.ts'), 'import { computeTotal } from "./a.js";\nconst val = computeTotal(5);\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds definitions of a symbol', async () => {
    const res = await findDefinitionsTool.execute({ symbol: 'computeTotal' }, ctx);
    expect(res).toContain('Definitions for "computeTotal"');
    expect(res).toContain('a.ts');
    expect(res).toContain('function computeTotal');
  });

  it('finds references and usages of a symbol across files', async () => {
    const res = await findReferencesTool.execute({ symbol: 'computeTotal' }, ctx);
    expect(res).toContain('References for "computeTotal"');
    expect(res).toContain('a.ts');
    expect(res).toContain('b.ts');
  });
});
