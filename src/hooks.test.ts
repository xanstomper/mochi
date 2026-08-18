import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HookManager } from './hooks.js';

describe('HookManager', () => {
  it('runs after hooks and records output', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hooks-'));
    const marker = resolve(dir, 'marker.txt');
    writeFileSync(resolve(dir, 'hooks.json'), JSON.stringify({ after_edit: `touch ${marker}` }));
    const hooks = new HookManager(dir);
    expect(hooks.enabled('after_edit')).toBe(true);
    const results = await hooks.runAfter('after_edit', { file: 'a.ts' });
    expect(results[0].exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('allows before hooks to veto an action', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hooks-'));
    writeFileSync(resolve(dir, 'hooks.json'), JSON.stringify({ before_shell: 'exit 1' }));
    const hooks = new HookManager(dir);
    const result = await hooks.runBefore('before_shell', { command: 'echo hi' });
    expect(result.allowed).toBe(false);
  });

  it('treats successful before hooks as allowed', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hooks-'));
    writeFileSync(resolve(dir, 'hooks.json'), JSON.stringify({ before_edit: 'true' }));
    const hooks = new HookManager(dir);
    const result = await hooks.runBefore('before_edit');
    expect(result.allowed).toBe(true);
  });
});
