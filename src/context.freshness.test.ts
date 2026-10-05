import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ContextEngine } from './context.js';
import type { MochiConfig } from './types.js';

const baseConfig = {
  safety: { contextBudgetTokens: 100_000 },
} as unknown as MochiConfig;

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ id: 't1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
  };
}

describe('ContextEngine file freshness (Cline fileContextTracker port)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-fresh-'));
  });

  it('flags a file whose fingerprint changed after the agent read it', async () => {
    const engine = new ContextEngine(baseConfig, dir);
    writeFileSync(resolve(dir, 'a.ts'), 'v1');
    engine.addMessage(toolCall('read', { path: 'a.ts' }));
    expect(engine.detectStaleFiles()).toEqual([]);

    // External edit: bump mtime + size like another agent/process would.
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(resolve(dir, 'a.ts'), 'v2-changed');
    expect(engine.detectStaleFiles()).toEqual(['a.ts']);

    // Reported once per change — no repeat nagging.
    expect(engine.detectStaleFiles()).toEqual([]);
  });

  it('re-arms the alert after the agent re-reads the file, and clears on edit', async () => {
    const engine = new ContextEngine(baseConfig, dir);
    writeFileSync(resolve(dir, 'b.ts'), 'one');
    engine.addMessage(toolCall('read', { path: 'b.ts' }));

    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(resolve(dir, 'b.ts'), 'two');
    expect(engine.detectStaleFiles()).toEqual(['b.ts']);

    // Agent re-reads the now-current file → snapshot refreshed, alert cleared.
    engine.addMessage(toolCall('read', { path: 'b.ts' }));
    expect(engine.detectStaleFiles()).toEqual([]);

    // Agent edits → snapshot refreshed post-edit, still no alert.
    engine.addMessage(toolCall('edit', { path: 'b.ts' }));
    expect(engine.detectStaleFiles()).toEqual([]);
  });

  it('stalenessWarning() renders the volatile-tier alert line', async () => {
    const engine = new ContextEngine(baseConfig, dir);
    expect(engine.stalenessWarning()).toBe('');
    writeFileSync(resolve(dir, 'c.ts'), 'x');
    engine.addMessage(toolCall('read', { path: 'c.ts' }));
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(resolve(dir, 'c.ts'), 'y');
    const warn = engine.stalenessWarning();
    expect(warn).toContain('STALE FILE ALERT');
    expect(warn).toContain('c.ts');
  });

  it('does not flag files that were never read', () => {
    const engine = new ContextEngine(baseConfig, dir);
    writeFileSync(resolve(dir, 'unread.ts'), 'a');
    expect(engine.detectStaleFiles()).toEqual([]);
  });
});
