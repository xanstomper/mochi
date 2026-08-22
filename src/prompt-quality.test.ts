// Phase 8 (VNext): prompt-quality regression harness.
//
// The bundled-skills ESM bug shipped because nothing asserted the REAL system
// prompt's structure. These tests build the actual prompt (bundled skills,
// rules, conditional guidelines) and pin its structural invariants:
//   - skills are advertised (count >= bundled catalog size)
//   - all eleven sections present, in order, exactly once
//   - the prompt stays within sane byte bounds
//   - conditional guidelines really are conditional
// so a future regression fails loudly here instead of silently in production.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ContextEngine } from './context.js';
import { discoverSkills, bundledSkillsDir } from './skills.js';
import type { MochiConfig, ToolDefinition } from './types.js';

let dir: string;
let engine: ContextEngine;
const FULL_TOOLS: ToolDefinition[] = [
  'read', 'write', 'edit', 'patch', 'delete', 'replace_symbol', 'shell',
  'web_search', 'web_crawl', 'fetch', 'subagent', 'todo', 'skill', 'grep', 'glob',
].map((name) => ({ name, description: '', parameters: [] })) as ToolDefinition[];

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-promptq-'));
  const config = {
    model: { provider: 'x', baseUrl: 'http://l', model: 'm' },
    safety: { contextBudgetTokens: 8000, mode: 'auto', commandTimeoutSeconds: 5, maxIterations: 5, maxRuntimeMinutes: 1, maxConcurrentAgents: 1 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
  } as unknown as MochiConfig;
  engine = new ContextEngine(config, dir);
  engine.setGoal('prompt quality test');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECTION_HEADERS = [
  '# I. Core Directives',
  '# II. Execution Protocol',
  '# III. Advanced Orchestration',
  '# IV. Tool-Specific Guidelines',
  '# V. Cognitive & Engineering Discipline',
  '# VI. Output Constraints (CRITICAL)',
];

describe('system prompt structural invariants (VNext phase 8)', () => {
  it('advertises every bundled skill', () => {
    const catalog = bundledSkillsDir();
    expect(catalog).toBeTruthy();
    const bundled = discoverSkills(catalog!).skills;
    expect(bundled.length).toBeGreaterThanOrEqual(20); // catalog shipped with the package

    const packet = engine.buildPacket(FULL_TOOLS);
    const sys = String(packet.messages[0].content);
    for (const s of bundled) {
      expect(sys).toContain(`name="${s.name}"`);
    }
  });

  it('has all sections present, ordered, and unique', () => {
    const packet = engine.buildPacket(FULL_TOOLS);
    const sys = String(packet.messages[0].content);
    let last = -1;
    for (const h of SECTION_HEADERS) {
      const first = sys.indexOf(h);
      expect(first, `section "${h}" missing from prompt`).toBeGreaterThanOrEqual(0);
      expect(first, `section "${h}" out of order`).toBeGreaterThan(last);
      expect(sys.split(h).length, `section "${h}" duplicated`).toBe(2);
      last = first;
    }
  });

  it('stays within sane byte bounds (regression: 0-skills bug shrank it)', () => {
    const packet = engine.buildPacket(FULL_TOOLS);
    const sys = String(packet.messages[0].content);
    // 24+ skills (~7KB) + identity sections (~7KB) + repo info. If this drops
    // below ~12KB something silently stopped rendering (the ESM bug produced 8.6KB).
    expect(sys.length).toBeGreaterThan(12_000);
    expect(sys.length).toBeLessThan(60_000); // and it must never balloon unbounded
  });

  it('conditional guidelines render per tool set', () => {
    const full = String(engine.buildPacket(FULL_TOOLS).messages[0].content);
    expect(full).toContain('replace_symbol:');
    expect(full).toContain('web_search / web_crawl / fetch');

    const narrowTools = [{ name: 'read', description: '', parameters: [] }] as ToolDefinition[];
    const narrow = String(engine.buildPacket(narrowTools).messages[0].content);
    expect(narrow).not.toContain('replace_symbol:');
    expect(narrow).not.toContain('subagent:');
    expect(narrow.length).toBeLessThan(full.length);
  });

  it('state prompt carries the stuck signal when set', () => {
    engine.stuckSignal = 'repeated tool calls x3';
    const packet = engine.buildPacket(FULL_TOOLS, {
      id: 't', title: 'Do work', description: 'work', role: 'coder',
      status: 'pending', priority: 1, dependencies: [], fileScope: [],
      acceptanceCriteria: [], attempts: [],
    } as any);
    // The volatile state is a TRAILING system message, not the stable lead.
    const trailing = packet.messages.filter((m) => m.role === 'system').map((m) => String(m.content));
    const stateMsg = trailing.find((c) => c.includes('Current State'));
    expect(stateMsg, 'state message present').toBeTruthy();
    expect(stateMsg!).toContain('WARNING (loop detected)');
    engine.stuckSignal = null;
  });
});
