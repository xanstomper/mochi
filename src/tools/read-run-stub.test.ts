// tools/read.ts S4: run-scoped repeat-read stub. MCH-84 stubbed only an
// IMMEDIATELY repeated read; the ordinary waste is non-adjacent (read A,
// read B, read A). These tests pin the extended behavior and its safety
// rails: per-agent scoping (the cache Map is shared with subagents whose
// contexts lack the parent's reads) and stamp invalidation on change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readTool } from './read.js';
import type { ToolContext, ReadCache } from './types.js';

let dir: string;
let cache: ReadCache;

const A = ['alpha one', 'alpha two', 'alpha three', 'alpha four'].join('\n') + '\n';
const B = ['beta one', 'beta two'].join('\n') + '\n';

function ctxFor(agentId: string): ToolContext {
  return { cwd: dir, workspace: {} as any, config: {} as any, events: {} as any, agentId, readCache: cache } as ToolContext;
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-readstub-'));
  writeFileSync(resolve(dir, 'a.txt'), A);
  writeFileSync(resolve(dir, 'b.txt'), B);
  cache = new Map();
  delete process.env.MOCHI_READ_RUN_STUB;
});
afterEach(() => {
  delete process.env.MOCHI_READ_RUN_STUB;
  rmSync(dir, { recursive: true, force: true });
});

describe('read run stub (S4)', () => {
  it('stubs a non-adjacent repeat read of an unchanged file', async () => {
    const ctx = ctxFor('agent-1');
    const first = String(await readTool.execute({ path: 'a.txt' }, ctx));
    expect(first).toContain('alpha one');
    await readTool.execute({ path: 'b.txt' }, ctx);
    const third = String(await readTool.execute({ path: 'a.txt' }, ctx));
    expect(third).toContain('[mochi:cache-hit]');
    expect(third).toContain('earlier read in this run');
    expect(third).not.toContain('alpha one');
  });

  it('serves full content again after the file changes (stamp invalidation)', async () => {
    const ctx = ctxFor('agent-1');
    await readTool.execute({ path: 'a.txt' }, ctx);
    await readTool.execute({ path: 'b.txt' }, ctx);
    writeFileSync(resolve(dir, 'a.txt'), A + 'alpha five\n'); // size changes
    const afterChange = String(await readTool.execute({ path: 'a.txt' }, ctx));
    expect(afterChange).toContain('alpha five');
    expect(afterChange).not.toContain('[mochi:cache-hit]');
    // And the NEW content is now the stub-able serve.
    await readTool.execute({ path: 'b.txt' }, ctx);
    const stubbed = String(await readTool.execute({ path: 'a.txt' }, ctx));
    expect(stubbed).toContain('[mochi:cache-hit]');
  });

  it('does not stub for a different agent sharing the cache (its context lacks the content)', async () => {
    const parent = ctxFor('parent');
    const child = ctxFor('child');
    await readTool.execute({ path: 'a.txt' }, parent);
    const childFirst = String(await readTool.execute({ path: 'a.txt' }, child));
    expect(childFirst).toContain('alpha one');
    expect(childFirst).not.toContain('[mochi:cache-hit]');
    // The child's own repeat DOES stub.
    await readTool.execute({ path: 'b.txt' }, child);
    const childRepeat = String(await readTool.execute({ path: 'a.txt' }, child));
    expect(childRepeat).toContain('[mochi:cache-hit]');
  });

  it('does not stub a different range of the same file', async () => {
    const ctx = ctxFor('agent-1');
    await readTool.execute({ path: 'a.txt', limit: 2 }, ctx);
    const otherRange = String(await readTool.execute({ path: 'a.txt', limit: 3 }, ctx));
    expect(otherRange).toContain('alpha three');
    expect(otherRange).not.toContain('[mochi:cache-hit]');
  });

  it('the kill-switch restores full re-injection on non-adjacent repeats', async () => {
    process.env.MOCHI_READ_RUN_STUB = '0';
    const ctx = ctxFor('agent-1');
    await readTool.execute({ path: 'a.txt' }, ctx);
    await readTool.execute({ path: 'b.txt' }, ctx);
    const third = String(await readTool.execute({ path: 'a.txt' }, ctx));
    expect(third).toContain('alpha one');
  });

  it('with S4 disabled, the MCH-84 adjacency stub still fires (on the third read — the second arms __lastRead)', async () => {
    process.env.MOCHI_READ_RUN_STUB = '0';
    const ctx = ctxFor('agent-1');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const second = String(await readTool.execute({ path: 'a.txt' }, ctx));
    expect(second).toContain('alpha one');
    const third = String(await readTool.execute({ path: 'a.txt' }, ctx));
    expect(third).toContain('[mochi:cache-hit]');
    expect(third).toContain('previous read');
  });
});
