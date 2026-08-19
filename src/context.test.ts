import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from './context.js';
import type { MochiConfig } from './types.js';

function cfg(): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: 100000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

const NO_TOOLS = [];

describe('ContextEngine project-rule + memory caching', () => {
  it('loads project rules from AGENTS.md and reflects edits on fingerprint change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-ctx-'));
    mkdirSync(join(dir, '.mochi', 'memory'), { recursive: true });
    const rulesPath = join(dir, 'AGENTS.md');
    writeFileSync(rulesPath, '# v1 rules');

    const engine = new ContextEngine(cfg(), dir);
    const p1 = engine.buildPacket(NO_TOOLS);
    expect(p1.systemPrompt).toContain('# v1 rules');

    // Same fingerprint: cached, no change observed.
    const p2 = engine.buildPacket(NO_TOOLS);
    expect(p2.systemPrompt).toContain('# v1 rules');

    // Edit the file (size/mtime change) then confirm the cache refreshes.
    writeFileSync(rulesPath, '# v2 rules after edit');
    const p3 = engine.buildPacket(NO_TOOLS);
    expect(p3.systemPrompt).toContain('# v2 rules after edit');
  });

  it('returns empty rules when no candidate file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-ctx-'));
    const engine = new ContextEngine(cfg(), dir);
    const p = engine.buildPacket(NO_TOOLS);
    expect(p.systemPrompt).not.toContain('Project rules');
  });

  it('estimates growing transcript tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-ctx-'));
    const engine = new ContextEngine(cfg(), dir);
    const before = engine.estimateTokens();
    engine.addMessage({ role: 'user', content: 'hello world this is a message'.repeat(50) });
    const after = engine.estimateTokens();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(0);
  });
});

describe('ContextEngine task-kind hints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-ctx-kind-'));
  const engine = new ContextEngine(cfg(), dir);
  it('injects a debug-focused hint when the task title says fix', () => {
    const p = engine.buildPacket(NO_TOOLS, {
      id: 't1', title: 'Fix the login crash', description: 'reproduces on every load',
      role: 'coder', status: 'pending', priority: 1, dependencies: [], fileScope: [], acceptanceCriteria: [], attempts: [],
    });
    expect(p.systemPrompt).toContain('Focus: debugging');
    expect(p.systemPrompt).toContain('reproduc');
  });
  it('injects a research hint for "investigate" tasks', () => {
    const p = engine.buildPacket(NO_TOOLS, {
      id: 't2', title: 'Investigate the auth flow', description: 'how does session live?',
      role: 'coder', status: 'pending', priority: 1, dependencies: [], fileScope: [], acceptanceCriteria: [], attempts: [],
    });
    expect(p.systemPrompt).toContain('Focus: research');
    expect(p.systemPrompt).toContain('read-only');
  });
  it('falls back to implementation hint for plain tasks', () => {
    const p = engine.buildPacket(NO_TOOLS, {
      id: 't3', title: 'Add export to foo', description: 'export const x = 1',
      role: 'coder', status: 'pending', priority: 1, dependencies: [], fileScope: [], acceptanceCriteria: [], attempts: [],
    });
    expect(p.systemPrompt).toContain('Focus: implementation');
  });
});