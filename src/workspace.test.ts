import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from './workspace.js';

describe('Workspace appendCompletedTask', () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-ws-'));
    ws = new Workspace(dir);
    ws.ensure();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedups identical titles across concurrent writers', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ws.appendCompletedTask('SameTask')),
    );
    // Only the first caller should report "added".
    expect(results.filter(Boolean).length).toBe(1);
    const state = ws.loadState();
    expect(state.completedTasks).toEqual(['SameTask']);
  });

  it('keeps every unique title exactly once under parallel writers', async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `Task ${i}`);
    // Fire all appends concurrently, but also duplicate each one to prove dedup
    // under load does not corrupt the set.
    const calls: Promise<boolean>[] = [];
    for (const t of titles) {
      calls.push(ws.appendCompletedTask(t));
      calls.push(ws.appendCompletedTask(t)); // duplicate
    }
    await Promise.all(calls);

    const state = ws.loadState();
    expect(new Set(state.completedTasks).size).toBe(titles.length);
    expect(state.completedTasks).toEqual(expect.arrayContaining(titles));
  });

  it('persists across a fresh Workspace handle loaded from disk', async () => {
    await ws.appendCompletedTask('Persisted');
    const reloaded = new Workspace(dir);
    expect(reloaded.loadState().completedTasks).toEqual(['Persisted']);
  });
});