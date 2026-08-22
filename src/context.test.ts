import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  it('advertises available skills in system prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-ctx-'));
    const engine = new ContextEngine(cfg(), dir);
    const p = engine.buildPacket(NO_TOOLS);
    expect(p.systemPrompt).toContain('<available_skills>');
    expect(p.systemPrompt).toContain('tdd-workflow');
    expect(p.systemPrompt).toContain('git-wizard');
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
    expect(JSON.stringify(p)).toContain('Focus: debugging');
    expect(JSON.stringify(p)).toContain('reproduc');
  });
  it('injects a research hint for "investigate" tasks', () => {
    const p = engine.buildPacket(NO_TOOLS, {
      id: 't2', title: 'Investigate the auth flow', description: 'how does session live?',
      role: 'coder', status: 'pending', priority: 1, dependencies: [], fileScope: [], acceptanceCriteria: [], attempts: [],
    });
    expect(JSON.stringify(p)).toContain('Focus: research');
    expect(p.systemPrompt).toContain('read-only');
  });
  it('falls back to implementation hint for plain tasks', () => {
    const p = engine.buildPacket(NO_TOOLS, {
      id: 't3', title: 'Add export to foo', description: 'export const x = 1',
      role: 'coder', status: 'pending', priority: 1, dependencies: [], fileScope: [], acceptanceCriteria: [], attempts: [],
    });
    expect(JSON.stringify(p)).toContain('Focus: implementation');
  });
});
describe('ContextEngine cache-stable packet prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-ctx-cache-'));
  const engine = new ContextEngine(cfg(), dir);
  const task = {
    id: 't', title: 'Add export to foo', description: 'export const x = 1',
    role: 'coder', status: 'pending', priority: 1, dependencies: [], fileScope: [],
    acceptanceCriteria: [], attempts: [],
  } as any;

  it('keeps the leading system message byte-identical as state grows (prefix cache hit)', () => {
    const p1 = engine.buildPacket(NO_TOOLS, task);
    const leading1 = p1.messages[0].content;

    // Simulate a second turn: the task state evolves (known errors, files).
    engine.updateState({ nextAction: 'verify the edit', knownErrors: ['ERROR'], filesModified: ['src/x.ts'] } as any);
    engine.addKnownError('compile error in src/x.ts');
    const p2 = engine.buildPacket(NO_TOOLS, task);

    // The leading system prompt (identity+skills+rules) is UNCHANGED → the
    // provider can prefix-cache the whole front of the conversation.
    expect(p2.messages[0].content).toBe(leading1);
    // Volatile state lives in a SEPARATE trailing system message, not the lead.
    const last = p2.messages[p2.messages.length - 1];
    expect(last.role).toBe('system');
    expect(String(last.content)).toContain('Current State');
  });

  it('does not freeze the leading prompt when the task kind hint changes', () => {
    const pA = engine.buildPacket(NO_TOOLS, task);
    const pB = engine.buildPacket(NO_TOOLS, task);
    expect(pA.messages[0].content).toBe(pB.messages[0].content);
  });
});

describe('conditional tool guidelines (VNext P1.3)', () => {
  const mk = (name: string) => ({ name, description: '', parameters: [] }) as any;

  it('mentions only registered tools in section 9', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ctx2-'));
    const engine = new ContextEngine({
      model: { provider: 'x', baseUrl: 'http://l', model: 'm' },
      safety: { contextBudgetTokens: 8000, mode: 'auto', commandTimeoutSeconds: 5, maxIterations: 5, maxRuntimeMinutes: 1, maxConcurrentAgents: 1 },
      permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    } as any, dir);
    const narrow = engine.buildPacket([mk('read'), mk('shell')]);
    const sys = String(narrow.messages[0].content);
    expect(sys).toContain('shell:');
    expect(sys).not.toContain('replace_symbol:');
    expect(sys).not.toContain('web_search');
    const full = engine.buildPacket([mk('edit'), mk('replace_symbol'), mk('web_search'), mk('web_crawl')]);
    const sys2 = String(full.messages[0].content);
    expect(sys2).toContain('replace_symbol:');
    expect(sys2).toContain('web_search / web_crawl / fetch');
    // Narrow prompt must be strictly smaller than the full one.
    expect(sys.length).toBeLessThan(sys2.length);
    rmSync(dir, { recursive: true, force: true });
  });
});
