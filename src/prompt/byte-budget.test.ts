// D4 byte-budget meter tests.
//
// Three families, mirroring the D4 contract:
//   1. byte-counting: the stable/volatile split follows the REAL prompt
//      assembly seams (ContextEngine.buildSystemPrompt's P5 stable head vs
//      session tail), not a hand-written string;
//   2. per-tool schema bytes: EVERY registered tool appears — no silent
//      omission — and the bytes equal the JSON.stringify(def) serialization
//      the tool-exposure budget already uses;
//   3. baseline check: growth beyond the allowances fails, flat/decreasing
//      passes, and a tool without a baseline entry is reported, never
//      silently ignored.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectByteBudget,
  compareAgainstBaseline,
  ENV_PLACEHOLDER,
  DEFAULT_ALLOWANCES,
  type ByteBudgetBaseline,
  type ByteBudgetDump,
} from './byte-budget.js';
import { ContextEngine, machineAccessBlock } from '../context.js';
import { ALL_TOOLS_MAP } from '../tools/index.js';
import { detectRepo } from '../repo/repo.js';
import type { MochiConfig, ToolDefinition } from '../types.js';

const byteLen = (text: string): number => Buffer.byteLength(text, 'utf8');

function cfg(): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: 400_000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

function tools(names: string[]): ToolDefinition[] {
  return names.map((name) => ({ name, description: `${name} tool`, parameters: [] })) as unknown as ToolDefinition[];
}

function tmpRoot(withRules = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'byte-budget-test-'));
  if (withRules) writeFileSync(join(dir, 'MOCHI.md'), '# Test rules\n\nRule one: verify before claiming done.\n');
  return dir;
}

// ── 1. byte counting: the split matches the assembly seams ──────────────

describe('byte-budget stable/volatile split (seam-faithful)', () => {
  it('splits exactly where buildSystemPrompt splits: stable head vs session tail', () => {
    const root = tmpRoot();
    const engine = new ContextEngine(cfg(), root, join(root, 'no-skills'));
    const composed = engine.composeForByteBudget(tools(['read', 'edit']));
    // The P5 seam: the stable head is the composed prefix (core + root rules +
    // repo info); the composed system prompt starts with it byte-for-byte.
    expect(composed.system.startsWith(composed.head)).toBe(true);
    expect(composed.head.startsWith('You are Mochi')).toBe(true);
    // The root rules the engine loaded from the project land in the HEAD.
    expect(composed.head).toContain('Rule one: verify before claiming done.');
    // Wire-order segments, as named in buildSystemPrompt.
    expect(composed.segments.map((s) => s.name)).toEqual([
      'core', 'rulesRoot', 'repo', 'rulesModular', 'skills', 'contract', 'memory', 'feedback',
    ]);
  });

  it('counts stable bytes = env-normalized head bytes, volatile = total - stable', () => {
    const root = tmpRoot();
    const dump = collectByteBudget(root);
    // The counting rule: normalize the machine env block out, then count utf8.
    // Recompute through the same seam with the SAME toolset the meter passes
    // (ALL_TOOLS_MAP — toolGuidelines renders per registered tool, so the
    // head only matches when the toolset matches).
    const defs = [...ALL_TOOLS_MAP.values()].map((t) => t.def)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const engine = new ContextEngine(cfg(), root, join(root, 'no-skills'));
    const composed = engine.composeForByteBudget(defs, detectRepo(root));
    const norm = (text: string): string => text.replace(machineAccessBlock(root), ENV_PLACEHOLDER);
    expect(dump.prompt.headIsPrefix).toBe(true);
    expect(dump.prompt.stableBytes).toBe(byteLen(norm(composed.head)));
    expect(dump.prompt.totalBytes).toBe(byteLen(norm(composed.system)));
    expect(dump.prompt.totalBytes).toBe(dump.prompt.stableBytes + dump.prompt.volatileBytes);
    // The env block (hostname/CPU/cwd/toolchain) is excluded from the totals
    // and reported separately.
    expect(dump.prompt.machineEnvBytes).toBe(byteLen(machineAccessBlock(root)));
    expect(dump.prompt.machineEnvBytes).toBeGreaterThan(0);
    expect(dump.prompt.stableBytes).toBeLessThan(byteLen(composed.head));
  });

  it('per-segment and per-skill bytes match the composed segments', () => {
    const root = tmpRoot();
    const dump = collectByteBudget(root);
    // The engine advertises the bundled catalog when tools are registered
    // with no task; the meter reads that same composed segment.
    expect(dump.prompt.segments.skills).toBeGreaterThan(0);
    expect(dump.skills.totalBytes).toBe(dump.prompt.segments.skills);
    expect(dump.skills.count).toBeGreaterThan(0);
    for (const bytes of Object.values(dump.skills.perSkill)) expect(bytes).toBeGreaterThan(0);
    // No-tool-relevant volatile segments are present but empty under
    // isolated user state (the meter must not read the caller's ~/.mochi).
    expect(dump.prompt.segments.memory).toBe(0);
    expect(dump.prompt.segments.feedback).toBe(0);
  });

  it('is deterministic: the same repo state yields byte-identical numbers', () => {
    const root = tmpRoot();
    const a = collectByteBudget(root);
    const b = collectByteBudget(root);
    expect(a).toEqual(b);
  });

  it('user-machine state cannot move the numbers (isolated composition)', () => {
    const root = tmpRoot();
    const clean = collectByteBudget(root);
    // Pollute the caller's user state, then meter again: memory/feedback
    // digests must stay empty because the meter isolates HOME + memory file.
    const savedMem = process.env.MOCHI_MEMORY_FILE;
    const savedHome = process.env.HOME;
    try {
      const fakeHome = mkdtempSync(join(tmpdir(), 'byte-budget-polluted-'));
      process.env.HOME = fakeHome;
      const memFile = join(fakeHome, 'memory.jsonl');
      writeFileSync(memFile, JSON.stringify({ id: 'f1', fact: 'polluting fact '.repeat(50), created: 1, last_hit: 1, source: 'user' }) + '\n');
      process.env.MOCHI_MEMORY_FILE = memFile;
      const polluted = collectByteBudget(root);
      expect(polluted).toEqual(clean);
    } finally {
      if (savedMem === undefined) delete process.env.MOCHI_MEMORY_FILE; else process.env.MOCHI_MEMORY_FILE = savedMem;
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });
});

// ── 2. per-tool schema bytes: every registered tool, no omission ────────

describe('byte-budget per-tool schema bytes', () => {
  const dump = collectByteBudget(tmpRoot());

  it('every registered tool appears — no silent omission, no phantom extras', () => {
    const registered = [...ALL_TOOLS_MAP.keys()].sort();
    const metered = Object.keys(dump.tools.perTool).sort();
    expect(metered).toEqual(registered);
    expect(dump.tools.count).toBe(registered.length);
  });

  it('schema bytes equal the JSON.stringify(def) serialization the exposure budget uses', () => {
    for (const [name, bytes] of Object.entries(dump.tools.perTool)) {
      const def = ALL_TOOLS_MAP.get(name)!.def;
      expect(bytes).toBe(byteLen(JSON.stringify(def)));
      expect(bytes).toBeGreaterThan(0);
    }
    expect(dump.tools.totalBytes).toBe(Object.values(dump.tools.perTool).reduce((a, b) => a + b, 0));
  });

  it('a tool whose schema text changes changes its metered bytes', () => {
    const name = 'read';
    const def = ALL_TOOLS_MAP.get(name)!.def;
    const grown: ToolDefinition = { ...def, description: def.description + ' ' + 'x'.repeat(200) };
    const before = byteLen(JSON.stringify(def));
    const after = byteLen(JSON.stringify(grown));
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeGreaterThan(DEFAULT_ALLOWANCES.perToolBytes);
  });
});

// ── 3. baseline check: the ratchet bites ────────────────────────────────

function fixtureDump(): ByteBudgetDump {
  const perTool: Record<string, number> = { read: 800, edit: 900, shell: 1200 };
  return {
    prompt: {
      stableBytes: 10_000,
      volatileBytes: 5_000,
      totalBytes: 15_000,
      headIsPrefix: true,
      machineEnvBytes: 2_000,
      segments: { core: 8_000, rulesRoot: 1_000, repo: 1_000, rulesModular: 0, skills: 4_000, contract: 1_000, memory: 0, feedback: 0 },
    },
    tools: { count: 3, totalBytes: 2_900, perTool },
    skills: { count: 2, totalBytes: 4_000, perSkill: { alpha: 120, beta: 180 } },
  };
}

function fixtureBaseline(dump: ByteBudgetDump): ByteBudgetBaseline {
  return { countingRule: {}, allowances: { ...DEFAULT_ALLOWANCES }, dump };
}

describe('byte-budget baseline check (CI ratchet)', () => {
  it('passes on a flat baseline', () => {
    const v = compareAgainstBaseline(fixtureDump(), fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it('passes (ratchet) when bytes decrease', () => {
    const dump = fixtureDump();
    dump.prompt.totalBytes -= 500;
    dump.prompt.stableBytes -= 300;
    dump.tools.perTool.read! -= 100;
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(true);
  });

  it('fails when the prompt total grows beyond the allowance', () => {
    const dump = fixtureDump();
    dump.prompt.volatileBytes += DEFAULT_ALLOWANCES.totalBytes + 1;
    dump.prompt.totalBytes = dump.prompt.stableBytes + dump.prompt.volatileBytes;
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(false);
    expect(v.violations.join('\n')).toContain('prompt total grew');
  });

  it('fails when the STABLE head grows beyond its allowance', () => {
    const dump = fixtureDump();
    dump.prompt.stableBytes += DEFAULT_ALLOWANCES.stableBytes + 1;
    dump.prompt.totalBytes += DEFAULT_ALLOWANCES.stableBytes + 1;
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(false);
    expect(v.violations.join('\n')).toContain('prompt STABLE head grew');
  });

  it('tolerates growth within the stated allowance (small edits stay green)', () => {
    const dump = fixtureDump();
    dump.prompt.totalBytes += 128; // < totalBytes allowance
    dump.prompt.volatileBytes += 128;
    dump.tools.perTool.read! += 32; // < perToolBytes allowance
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(true);
  });

  it('fails when any single tool schema grows beyond the per-tool allowance', () => {
    const dump = fixtureDump();
    dump.tools.perTool.edit! += DEFAULT_ALLOWANCES.perToolBytes + 1;
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(false);
    expect(v.violations.join('\n')).toContain("tool 'edit' schema grew");
  });

  it('reports a new tool without a baseline entry instead of silently ignoring it', () => {
    const dump = fixtureDump();
    dump.tools.perTool['brand_new_tool'] = 777;
    dump.tools.count += 1;
    dump.tools.totalBytes += 777;
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(false);
    expect(v.violations.join('\n')).toContain("'brand_new_tool'");
    expect(v.violations.join('\n')).toContain('NO baseline entry');
  });

  it('notes a removed tool as a decrease, not a failure', () => {
    const dump = fixtureDump();
    delete dump.tools.perTool.shell;
    dump.tools.count -= 1;
    dump.tools.totalBytes -= 1_200;
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(true);
    expect(v.notes.join('\n')).toContain("tool 'shell' removed");
  });

  it('fails closed when the baseline is missing or unreadable', () => {
    const v = compareAgainstBaseline(fixtureDump(), null);
    expect(v.ok).toBe(false);
    expect(v.violations.join('\n')).toContain('no readable baseline');
  });

  it('reports a newly advertised skill as a note (the volatile total gates it)', () => {
    const dump = fixtureDump();
    dump.skills.perSkill['gamma'] = 150;
    dump.skills.count += 1;
    const v = compareAgainstBaseline(dump, fixtureBaseline(fixtureDump()));
    expect(v.ok).toBe(true);
    expect(v.notes.join('\n')).toContain("new skill advertised: 'gamma'");
  });
});
