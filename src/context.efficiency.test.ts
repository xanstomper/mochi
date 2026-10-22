import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextEngine,
  approxTokens,
  cachedMessageTokens,
  estimateMessagesTokens,
  heuristicTokenCount,
} from './context.js';
import { loadRulesCached, clearRulesCache } from './rules.js';
import { listArchivedOutputs, recallArchivedOutput } from './tools/output-archive.js';
import type { MochiConfig, ChatMessage } from './types.js';

function cfg(budget = 100_000): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: budget, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── 1. Token accounting truth ────────────────────────────────────────────
// Hand-computed from the Rust algorithm (native/mochi_core/src/
// tokenizer.rs): word runs ceil(len/5) (min 1), whitespace free, symbol
// runs ceil(len/3), other chars 1 each, specials 1, then clamp to
// ceil(bytes/4) and floor 1 for non-empty input.
describe('heuristicTokenCount (TS port of the native tokenizer)', () => {
  const cases: Array<[string, number]> = [
    ['', 0],
    ['hello', 1],
    ['hello world', 2],
    ['a b', 1], // 2 word tokens, clamped by ceil(3/4)=1 — mirrors the Rust clamp
    ['const x = 42;', 4], // raw 5, clamped by ceil(13/4)=4
    ['aaaaaaaaaaaaaaaaaaaa', 4], // one word run: ceil(20/5)
    ['!!!!!!', 2], // one symbol run: ceil(6/3)
    ['café', 2], // 'caf' word (1) + 'é' (1)
    ['<think>', 1], // special token
    ['{"a":1}', 2], // raw 5, clamped by ceil(7/4)=2
    ['hello_world foo', 4], // 'hello_world' ceil(11/5)=3 + 'foo' 1
  ];
  for (const [text, expected] of cases) {
    it(`counts ${JSON.stringify(text)} as ${expected}`, () => {
      expect(heuristicTokenCount(text)).toBe(expected);
    });
  }

  it('approxTokens agrees with the port on fixture text (one counter everywhere)', () => {
    const fixtures = [
      'The quick brown fox jumps over the lazy dog. '.repeat(20),
      'export function parse(input: string): Token[] {\n  return [];\n}\n'.repeat(10),
      '2026-01-01T00:00:00.000Z INFO worker[job=abc123] attempt 3/5 status=ok\n'.repeat(20),
      JSON.stringify({ role: 'tool', name: 'shell', content: 'x'.repeat(500) }),
    ];
    for (const f of fixtures) {
      // Whether or not the native core is loaded in this environment,
      // approxTokens must return the ported algorithm's number — the
      // native counter implements the same algorithm (parity by design).
      expect(approxTokens(f)).toBe(heuristicTokenCount(f));
      // And it must never exceed the old ceil(chars/4) ceiling the native
      // tokenizer is clamped to.
      expect(approxTokens(f)).toBeLessThanOrEqual(Math.ceil(f.length / 4));
    }
  });
});

describe('estimator agreement (context backstop vs conversation estimate)', () => {
  it('estimateTokens, estimateMessagesTokens and packet usedTokens agree', () => {
    const dir = tmpRoot('mochi-eff-agree-');
    const c = new ContextEngine(cfg(), dir, join(dir, 'no-skills'));
    c.addMessage({ role: 'user', content: 'Fix the parser bug' } as ChatMessage);
    c.addMessage({ role: 'assistant', content: 'On it.' } as ChatMessage);
    c.addMessage({ role: 'tool', name: 'shell', content: 'build output line\n'.repeat(40) } as ChatMessage);
    c.addMessage({ role: 'assistant', content: 'Found it in src/parser.ts — error TS2345 at line 142.' } as ChatMessage);

    const sum = c.getMessages().reduce((s, m) => s + cachedMessageTokens(m), 0);
    expect(c.estimateTokens()).toBe(sum);
    expect(estimateMessagesTokens(c.getMessages())).toBe(sum);

    const packet = c.buildPacket([]);
    const packetSum = packet.messages.reduce((s, m) => s + cachedMessageTokens(m), 0);
    expect(packet.usedTokens).toBe(packetSum);
  });
});

// ── 3/4. Cache-prefix hygiene + per-turn IO caching ──────────────────────
describe('stable prefix and per-turn IO caches', () => {
  function fixtureRoot(): string {
    const dir = tmpRoot('mochi-eff-prefix-');
    mkdirSync(join(dir, '.mochi', 'state'), { recursive: true });
    mkdirSync(join(dir, '.mochi', 'rules'), { recursive: true });
    writeFileSync(join(dir, '.mochi', 'state', 'todo.json'), JSON.stringify([
      { order: 1, status: 'in_progress', title: 'Alpha task' },
    ]));
    writeFileSync(join(dir, '.mochi', 'rules', 'style.md'),
      '---\ntitle: "Style"\nkeywords: ["typescript"]\n---\nUse strict typing everywhere.\n');
    return dir;
  }

  it('system prompt is byte-identical across volatile state changes', () => {
    const dir = fixtureRoot();
    const c = new ContextEngine(cfg(), dir, join(dir, 'no-skills'));
    c.setGoal('Fix the parser bug');
    const task = { title: 'Fix parser bug', description: 'Fix the parser bug', acceptanceCriteria: [] } as never;
    const p1 = c.buildPacket([], task);
    // Volatile changes: todo rewritten, next-action set.
    writeFileSync(join(dir, '.mochi', 'state', 'todo.json'), JSON.stringify([
      { order: 1, status: 'done', title: 'Alpha task' },
      { order: 2, status: 'in_progress', title: 'Beta task with a longer title' },
    ]));
    c.updateState({ nextAction: 'do the beta thing now' });
    const p2 = c.buildPacket([], task);
    expect(p2.messages[0].content).toBe(p1.messages[0].content);
    expect(p2.systemPrompt).toBe(p1.systemPrompt);
    // Sanity: the volatile tier DID pick up the new todo (cache is fresh,
    // not frozen) — the last message is the state prompt.
    const state2 = p2.messages[p2.messages.length - 1].content as string;
    expect(state2).toContain('Beta task with a longer title');
    const state1 = p1.messages[p1.messages.length - 1].content as string;
    expect(state1).toContain('Alpha task');
    expect(state1).not.toContain('Beta task');
  });

  it('loadRulesCached serves the cache until a rule file changes', () => {
    clearRulesCache();
    const dir = tmpRoot('mochi-eff-rules-');
    mkdirSync(join(dir, '.mochi', 'rules'), { recursive: true });
    const rulePath = join(dir, '.mochi', 'rules', 'one.md');
    writeFileSync(rulePath, '# One\nOriginal body.\n');
    const first = loadRulesCached(dir);
    expect(first).toHaveLength(1);
    expect(loadRulesCached(dir)).toBe(first); // same reference: cache hit
    writeFileSync(rulePath, '# One\nOriginal body, now noticeably longer after the edit.\n');
    const third = loadRulesCached(dir);
    expect(third).not.toBe(first);
    expect(third[0].content).toContain('noticeably longer');
  });
});

// ── 5. Tool-result economy: ingest fold archives for recall ─────────────
describe('ingest fold archives the full output for recall_output', () => {
  beforeEach(() => { /* each test uses its own tmp root; archive is per-root */ });

  it('a mid-band (5-20KB) tool output keeps its middle recoverable', () => {
    const dir = tmpRoot('mochi-eff-fold-');
    const c = new ContextEngine(cfg(), dir, join(dir, 'no-skills'));
    const body = Array.from({ length: 150 }, (_, i) => `line ${i}: build step output ${'x'.repeat(48)}`).join('\n')
      + '\nMIDDLE-MARKER: the one line that matters is here\n'
      + Array.from({ length: 60 }, (_, i) => `tail ${i}: more output`).join('\n');
    c.addMessage({ role: 'tool', name: 'shell', content: body } as ChatMessage);
    const stored = c.getMessages()[0].content as string;
    // Inline form is folded (marker not inline) and points at the archive.
    expect(stored.length).toBeLessThan(body.length);
    expect(stored.includes('MIDDLE-MARKER')).toBe(false);
    expect(stored).toContain('recall_output');
    // The archive recovers the full text, marker included.
    const entries = listArchivedOutputs(dir);
    expect(entries.length).toBeGreaterThan(0);
    const hit = recallArchivedOutput(dir, entries[entries.length - 1].id);
    expect(hit?.text).toContain('MIDDLE-MARKER: the one line that matters is here');
  });

  it('small tool outputs are stored untouched (no fold, no archive)', () => {
    const dir = tmpRoot('mochi-eff-small-');
    const c = new ContextEngine(cfg(), dir, join(dir, 'no-skills'));
    c.addMessage({ role: 'tool', name: 'shell', content: 'short output\nall good' } as ChatMessage);
    expect(c.getMessages()[0].content).toBe('short output\nall good');
    expect(listArchivedOutputs(dir)).toHaveLength(0);
  });
});
