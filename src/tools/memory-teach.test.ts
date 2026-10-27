import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { memoryTool } from './memory.js';
import { loadFacts } from '../memory/memory-store.js';
import type { ToolContext } from './types.js';

function ctx(dir: string): ToolContext {
  return { workspace: { dir } } as unknown as ToolContext;
}

describe('memory tool teach action (model self-training)', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'mochi-teach-'));
  const memFile = resolve(tmp, 'memory.jsonl');
  const old = process.env['MOCHI_MEMORY_FILE'];
  let workspace: string;

  beforeAll(() => {
    process.env['MOCHI_MEMORY_FILE'] = memFile;
    workspace = resolve(tmp, 'ws');
    // workspace needs a project memory dir the store will create on demand
    writeFileSync(resolve(tmp, 'placeholder'), '');
  });

  afterAll(() => {
    if (old === undefined) delete process.env['MOCHI_MEMORY_FILE'];
    else process.env['MOCHI_MEMORY_FILE'] = old;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('teach persists a global fact that loadFacts can read', async () => {
    const out = await memoryTool.execute(
      { action: 'teach', statement: 'The test VM is ssh host vermes', kind: 'fact' },
      ctx(workspace),
    );
    expect(out).toContain('Taught');
    const facts = loadFacts();
    expect(facts.some((f) => f.statement.includes('vermes'))).toBe(true);
  });

  it('teach dedups near-duplicate facts', async () => {
    await memoryTool.execute({ action: 'teach', statement: 'The Oracle test VM is ssh host vermes' }, ctx(workspace));
    const out2 = await memoryTool.execute(
      { action: 'teach', statement: 'The test VM is ssh host vermes' },
      ctx(workspace),
    );
    expect(out2).toContain('Already known');
    expect(loadFacts().filter((f) => f.statement.includes('vermes')).length).toBe(1);
  });

  it('teach accepts preference kind', async () => {
    const out = await memoryTool.execute(
      { action: 'teach', statement: 'User prefers tests run on the VM, never locally', kind: 'preference' },
      ctx(workspace),
    );
    expect(out).toContain('preference');
  });

  it('forget removes a fact by substring', async () => {
    const out = await memoryTool.execute({ action: 'forget', statement: 'vermes' }, ctx(workspace));
    expect(out).toContain('Forgot');
    expect(loadFacts().filter((f) => f.statement.includes('vermes')).length).toBe(0);
  });

  it('facts lists current global facts', async () => {
    await memoryTool.execute({ action: 'teach', statement: 'Mochi learns durable facts' }, ctx(workspace));
    const out = await memoryTool.execute({ action: 'facts' }, ctx(workspace));
    expect(out).toContain('Mochi learns durable facts');
    expect(out).toContain('[');
  });

  it('teach requires a statement', async () => {
    await expect(memoryTool.execute({ action: 'teach' }, ctx(workspace))).rejects.toThrow(/statement/);
  });
});
