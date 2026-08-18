import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import { todoTool } from './todo.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

describe('todo tool', () => {
  let dir: string;
  let ws: Workspace;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-todo-'));
    ws = new Workspace(dir);
    ws.ensure();
    ctx = {
      cwd: dir,
      workspace: ws,
      config: {} as MochiConfig,
      events: new EventBus(),
      agentId: 'test',
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds and lists', async () => {
    const out = await todoTool.execute({ action: 'add', title: 'Write tests' }, ctx);
    expect(out).toContain('Write tests');
    const list = await todoTool.execute({ action: 'list' }, ctx);
    expect(list).toContain('1. [ ] Write tests');
  });

  it('dedups identical titles', async () => {
    await todoTool.execute({ action: 'add', title: '  Refactor   module  ' }, ctx);
    const second = await todoTool.execute({ action: 'add', title: 'Refactor module' }, ctx);
    expect(second).toContain('already present');
    const list = await todoTool.execute({ action: 'list' }, ctx);
    // Only one entry, not two.
    expect(list.match(/Refactor module/g)).toHaveLength(1);
  });

  it('marks complete and prunes on clear', async () => {
    await todoTool.execute({ action: 'add', title: 'One' }, ctx);
    await todoTool.execute({ action: 'complete', title: 'One' }, ctx);
    expect(await todoTool.execute({ action: 'list' }, ctx)).toContain('[x] One');
    const cleared = await todoTool.execute({ action: 'clear' }, ctx);
    expect(cleared).toContain('(no todos)');
  });

  it('persists across a reloaded workspace handle', async () => {
    await todoTool.execute({ action: 'add', title: 'Persisted' }, ctx);
    const reloaded = new Workspace(dir);
    expect(reloaded.loadTodos().map((t) => t.title)).toEqual(['Persisted']);
  });

  it('does not lose updates under concurrent writes from different agents', async () => {
    // Simulate two parallel agents mutating shared todos via the mutex path.
    const titles = Array.from({ length: 20 }, (_, i) => `T${i}`);
    await Promise.all(
      titles.map((t) =>
        new Workspace(dir).mutateTodos((todos) => {
          todos.push({ title: t, status: 'pending', order: todos.length + 1 });
          return true;
        }),
      ),
    );
    const all = ws.loadTodos().map((t) => t.title);
    expect(new Set(all).size).toBe(titles.length);
    expect(all).toEqual(expect.arrayContaining(titles));
  });
});