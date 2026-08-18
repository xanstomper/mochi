import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryStore } from './memory.js';

describe('MemoryStore', () => {
  it('curates durable engineering memory', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-memory-'));
    const store = new MemoryStore(dir);
    expect(store.addDecision('Use Zustand', 'State management uses Zustand instead of Redux.', 'commit 82af31')).toBe(true);
    expect(store.addDecision('Use Zustand', 'Duplicate entry should be ignored.')).toBe(false);
    const content = readFileSync(resolve(dir, 'memory/decisions.md'), 'utf8');
    expect(content).toContain('## decision: Use Zustand');
    expect(content).not.toContain('Duplicate entry');
    expect(store.summary()).toContain('Use Zustand');
  });

  it('separates memory categories', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-memory-'));
    const store = new MemoryStore(dir);
    store.addArchitecture('Monorepo', 'pnpm workspaces');
    store.addConvention('REST naming', 'API routes use plural nouns.');
    const summary = store.load();
    expect(summary).toContain('architectures');
    expect(summary).toContain('conventions');
  });
});
