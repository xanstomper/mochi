import { describe, it, expect } from 'vitest';
import { notesTool } from './notes.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function makeCtx(cwd: string) {
  return { cwd, workspace: {} as any, config: {} as any, events: {} as any, agentId: 'test' };
}

describe('notes tool', () => {
  it('adds and lists notes', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/notes-test-`);
    try {
      const ctx = makeCtx(cwd);
      await notesTool.execute({ action: 'add', content: 'Hello world', tag: 'test' }, ctx);
      const result = await notesTool.execute({ action: 'list' }, ctx);
      expect(result).toContain('Hello world');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('deletes a note by id', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/notes-del-`);
    try {
      const ctx = makeCtx(cwd);
      const added = await notesTool.execute({ action: 'add', content: 'Delete me' }, ctx);
      const id = added.match(/\[([a-z0-9]+)\]/)?.[1];
      const result = await notesTool.execute({ action: 'delete', id }, ctx);
      expect(result).toContain('Deleted');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('clears all notes', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/notes-clear-`);
    try {
      const ctx = makeCtx(cwd);
      await notesTool.execute({ action: 'add', content: 'one' }, ctx);
      await notesTool.execute({ action: 'clear' }, ctx);
      const result = await notesTool.execute({ action: 'list' }, ctx);
      expect(result).toContain('No notes');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
