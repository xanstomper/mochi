import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from './context.js';
import { lintStablePrefix } from './prompt/stable-prefix.js';
import type { MochiConfig, RepoInfo, Task, ToolDefinition } from './types.js';

// P5: cache-aware prompt shaping. The stable head (identity + guidelines +
// root rules + repo context) must be byte-identical across runs that vary
// only in wall-clock time, input orderings, or per-run store content;
// forked children inherit it verbatim; every mid-run prefix break is
// counted and attributed to a segment or a history rewrite.

const DAY = 24 * 3600 * 1000;

function cfg(): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: 100000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' },
  } as unknown as MochiConfig;
}

function makeTask(title: string, description: string): Task {
  return {
    id: 't1', title, description, role: 'coder', status: 'pending', priority: 1,
    dependencies: [], fileScope: [], acceptanceCriteria: [], attempts: [],
  } as unknown as Task;
}

const TASK = () => makeTask('add tests for the login flow', 'establish a test suite and fix flaky specs');

function tools(names: string[]): ToolDefinition[] {
  return names.map((name) => ({ name, description: `${name} tool`, parameters: [] })) as unknown as ToolDefinition[];
}
const TOOL_NAMES = ['read', 'edit', 'shell', 'skill', 'subagent', 'think'];

function repo(flip = false): RepoInfo {
  const entrypoints = ['src/index.ts', 'src/cli.ts'];
  const importantDirs = ['src', 'test'];
  return {
    language: 'TypeScript', framework: 'none', buildCommand: 'npm run build', testCommand: 'npm test',
    lintCommand: 'npm run lint', typecheckCommand: 'npx tsc --noEmit',
    entrypoints: flip ? [...entrypoints].reverse() : entrypoints,
    importantDirs: flip ? [...importantDirs].reverse() : importantDirs,
  } as unknown as RepoInfo;
}

const SKILLS: Array<[string, string]> = [
  ['tdd-workflow', 'test driven development workflow: write failing tests, run specs, fix flaky tests'],
  ['git-workflow', 'git branching, rebase, merge conflict resolution and commit structuring'],
  ['zebra-utils', 'utility helpers for sorting and zebra striping tables'],
];

function writeSkills(root: string, order: Array<[string, string]>): void {
  const dir = join(root, '.mochi', 'skills');
  rmSync(dir, { recursive: true, force: true });
  for (const [name, desc] of order) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}.\n`);
  }
}

function makeWorkspace(skillOrder: Array<[string, string]> = SKILLS): string {
  const root = mkdtempSync(join(tmpdir(), 'mochi-p5-'));
  writeFileSync(join(root, 'AGENTS.md'), '# Audit Rules\nAlways write tests first.\n');
  writeSkills(root, skillOrder);
  return root;
}

let savedHome: string | undefined;
let savedMemEnv: string | undefined;
let home: string;

function seedMemory(now: number): void {
  const facts = [
    { id: 'f1', ts: now - 5 * DAY, category: 'convention', statement: 'The login flow tests live in test/auth and use vitest.', attempts: 3, success_count: 2 },
    // Straddles the 60-day decay boundary: live at seed time, pruned +25h.
    { id: 'f2', ts: now - 60 * DAY + 12 * 3600 * 1000, category: 'fact', statement: 'Boundary fact about test suite history.', attempts: 2, success_count: 0 },
    { id: 'f3', ts: now - 2 * DAY, category: 'preference', statement: 'Prefer table-driven tests for parsers.', attempts: 1, success_count: 1 },
  ];
  writeFileSync(process.env.MOCHI_MEMORY_FILE!, facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedMemEnv = process.env.MOCHI_MEMORY_FILE;
  home = mkdtempSync(join(tmpdir(), 'mochi-p5-home-'));
  mkdirSync(join(home, '.mochi'), { recursive: true });
  process.env.HOME = home;
  process.env.MOCHI_MEMORY_FILE = join(home, 'memory.jsonl');
  seedMemory(Date.now());
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedMemEnv === undefined) delete process.env.MOCHI_MEMORY_FILE; else process.env.MOCHI_MEMORY_FILE = savedMemEnv;
});

describe('stable head determinism (P5)', () => {
  it('byte-identical stable head across a day boundary + reordered inputs', () => {
    const ws = makeWorkspace();
    const engineA = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    engineA.setGoal('Fix the parser bug');
    const packetA = engineA.buildPacket(tools(TOOL_NAMES), TASK(), repo(false));
    const headA = engineA.stableHeadSnapshot();
    expect(headA).not.toBeNull();
    expect(packetA.systemPrompt).toContain('Boundary fact about test suite history.');

    // Same workspace path, skills recreated in reverse creation order.
    writeSkills(ws, [...SKILLS].reverse());
    // +25h: the boundary fact decays out of the memory TAIL.
    const origNow = Date.now;
    Date.now = () => origNow() + 25 * 3600 * 1000;
    try {
      const engineB = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
      engineB.setGoal('Fix the parser bug');
      const packetB = engineB.buildPacket(tools([...TOOL_NAMES].reverse()), TASK(), repo(true));
      const headB = engineB.stableHeadSnapshot();
      expect(headB!.text).toBe(headA!.text);
      expect(engineB.prefixStats().stableHash).toBe(engineA.prefixStats().stableHash);
      // The tail legitimately changed (fact decayed) — and ONLY the tail.
      expect(packetB.systemPrompt).not.toContain('Boundary fact about test suite history.');
      expect(packetB.systemPrompt.startsWith(headB!.text)).toBe(true);
    } finally {
      Date.now = origNow;
    }
  });

  it('the rendered stable head passes the volatile-field lint', () => {
    const ws = makeWorkspace();
    const engine = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    engine.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    const head = engine.stableHeadSnapshot()!;
    expect(lintStablePrefix(head.text)).toEqual([]);
  });

  it('an injected volatile field in the stable tier is caught by the lint', () => {
    const ws = makeWorkspace();
    const engine = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    engine.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    const head = engine.stableHeadSnapshot()!;
    const poisoned = `${head.text}\nGenerated at 2026-10-22T08:15:30Z · run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 · Memory: 3.2 GB free`;
    const joined = lintStablePrefix(poisoned).join('\n');
    expect(joined).toContain('ISO-8601 datetime');
    expect(joined).toContain('UUID');
    expect(joined).toContain('live free-memory figure');
  });

  it('volatile content moved tiers, not dropped: free memory rides the state prompt', () => {
    const ws = makeWorkspace();
    const engine = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    const packet = engine.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    expect(packet.systemPrompt).not.toContain('GB free');
    const state = packet.messages[packet.messages.length - 1];
    expect(String(state.content)).toContain('Host free memory:');
    // Task-relevant content survived stabilization:
    expect(packet.systemPrompt).toContain('tdd-workflow');
    expect(packet.systemPrompt).toContain('The login flow tests live in test/auth');
    expect(packet.systemPrompt).toContain('Always write tests first.');
  });
});

describe('fork inheritance (P5)', () => {
  it('child stable head equals the parent\'s byte-for-byte (same workspace + tools)', () => {
    const ws = makeWorkspace();
    const parent = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    parent.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    const snap = parent.stableHeadSnapshot()!;

    const child = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    child.inheritStableHead(snap.text, snap.sig);
    child.buildPacket(tools(TOOL_NAMES), makeTask('subtask: write the failing spec', 'write one failing test for login'), repo());
    const childSnap = child.stableHeadSnapshot()!;
    expect(childSnap.text).toBe(snap.text);
    expect(child.prefixStats().stableHash).toBe(parent.prefixStats().stableHash);
  });

  it('a pruned-tool child does NOT inherit — it renders its own head', () => {
    const ws = makeWorkspace();
    const parent = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    parent.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    const snap = parent.stableHeadSnapshot()!;

    const pruned = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    pruned.inheritStableHead(snap.text, snap.sig);
    pruned.buildPacket(tools(['read']), TASK(), repo());
    expect(pruned.stableHeadSnapshot()!.text).not.toBe(snap.text);
  });

  it('a different-workspace child does NOT inherit (its root legitimately differs)', () => {
    const ws = makeWorkspace();
    const parent = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    parent.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    const snap = parent.stableHeadSnapshot()!;

    const ws2 = makeWorkspace();
    const other = new ContextEngine(cfg(), ws2, join(ws2, 'no-user-skills'));
    other.inheritStableHead(snap.text, snap.sig);
    other.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    expect(other.stableHeadSnapshot()!.text).not.toBe(snap.text);
    expect(other.stableHeadSnapshot()!.text).toContain(ws2);
  });
});

describe('prefix break attribution (P5)', () => {
  it('feedback landing mid-run breaks once, attributed to the feedback segment', () => {
    const ws = makeWorkspace();
    const engine = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    engine.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    expect(engine.prefixStats().breakCount).toBe(0);

    const fb = [
      { ts: Date.now() - 3600000, session: 's1', turn: 3, verdict: 'bad', reason: 'too verbose', snippet: 'long answer about tests' },
      { ts: Date.now() - 3500000, session: 's1', turn: 4, verdict: 'good', snippet: 'concise fix summary' },
    ];
    writeFileSync(join(home, '.mochi', 'feedback.jsonl'), fb.map((f) => JSON.stringify(f)).join('\n') + '\n');

    engine.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    const stats = engine.prefixStats();
    expect(stats.breakCount).toBe(1);
    expect(stats.breaks[0].cause).toBe('feedback');

    engine.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    expect(engine.prefixStats().breakCount).toBe(1);
    expect(existsSync(join(home, '.mochi', 'feedback.jsonl'))).toBe(true);
  });

  it('compaction and tool-output shrink record labeled breaks', async () => {
    const ws = makeWorkspace();
    const engine = new ContextEngine(cfg(), ws, join(ws, 'no-user-skills'));
    engine.buildPacket(tools(TOOL_NAMES), TASK(), repo());
    const headHashBefore = engine.prefixStats().stableHash;

    engine.addMessage({ role: 'user', content: 'Fix the login validation bug so rejected passwords return 401' });
    for (let i = 0; i < 8; i++) {
      engine.addMessage({ role: 'assistant', content: `step ${i}`, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }] });
      engine.addMessage({ role: 'tool', tool_call_id: `t${i}`, name: 'read', content: `payload ${i} ` + 'x'.repeat(1500) });
    }
    for (let i = 0; i < 6; i++) {
      engine.addMessage({ role: 'user', content: `Continuing — progress check ${i}.` });
      engine.addMessage({ role: 'assistant', content: `Working on step ${i}.` });
    }

    const saved = engine.shrinkOldToolOutputs();
    expect(saved).toBeGreaterThan(0);
    expect(engine.prefixStats().breaks.map((b) => b.cause)).toContain('tool-output-shrink');

    await engine.compact();
    expect(engine.prefixStats().breaks.map((b) => b.cause)).toContain('compaction');
    // The rewrites touched history, not the stable head.
    expect(engine.prefixStats().stableHash).toBe(headHashBefore);
  });
});
