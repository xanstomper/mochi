// D2 integration tests: the evidence-survival bundle exercised through the
// REAL ContextEngine seams (addMessage / compact / buildPacket) and the REAL
// recall_output tool — no fake provider, no hand-written fixture (Mochi
// compaction is deterministic; compact() summarizes and probes without a
// model call). The full torture-transcript METRIC lives in
// src/d2-torture-metric.test.ts; these pin each mechanism separately.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextEngine } from './context.js';
import { recallOutputTool } from './tools/recall-output.js';
import { clearSpillStore, retrieveSpilled, scanSpillRefs, spillDirPath, DEFAULT_SPILL_THRESHOLD_CHARS } from './summary/spill-store.js';
import type { MochiConfig, ChatMessage } from './types.js';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function makeConfig(dir: string): MochiConfig {
  return {
    model: { provider: 'openai', model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function fillers(ctx: ContextEngine, n: number, start = 0): void {
  for (let i = 0; i < n; i++) {
    ctx.addMessage({ role: 'user', content: `Continuing with step ${start + i} of the retry rework.` });
    ctx.addMessage({ role: 'assistant', content: `Working through step ${start + i} carefully now.` });
  }
}

/** Oversized (300K chars) tool output with the evidence buried at depth. */
function oversizedOutput(marker: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 2000; i++) lines.push(`padding-before ${i}: ordinary output, nothing to see here`);
  lines.push(marker);
  for (let i = 0; i < 2000; i++) lines.push(`padding-after ${i}: ordinary output, nothing to see here`);
  return lines.join('\n');
}

const EVIDENCE = 'EVIDENCE-9F2A: the staging backoff constant is RATE_LIMIT_BACKOFF_MS=45000 (set at src/auth/backoff.ts:201)';

let dir: string;
let ctx: ContextEngine;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-d2-int-'));
  ctx = new ContextEngine(makeConfig(dir), dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function flatMessages(msgs: readonly ChatMessage[]): string {
  return msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');
}

describe('D2 leg 1: oversized-output spill (ingestion seam)', () => {
  it('spills the full content and replaces the in-context copy with a marker naming a resolvable key', async () => {
    ctx.addMessage({ role: 'user', content: 'Run the staging suite.' });
    ctx.addMessage({ role: 'assistant', content: 'Running.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test"}' } }] });
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput(EVIDENCE) });

    const stored = ctx.getMessages().find((m) => m.role === 'tool')!;
    const content = stored.content as string;
    // The in-context copy is small now (head + marker + tail).
    expect(content.length).toBeLessThan(2000);
    expect(content).toContain('[mochi-spill: spill-');
    expect(content).toContain('recall_output key="');
    expect(content).not.toContain(EVIDENCE); // the evidence itself is OUT of context

    // ...and the marker resolves: full content, byte-identical, in the store.
    const keys = scanSpillRefs(content);
    expect(keys.length).toBe(1);
    const hit = retrieveSpilled(dir, keys[0]);
    expect(hit).toBeTruthy();
    expect(hit!.text).toContain(EVIDENCE);
    expect(hit!.text.length).toBeGreaterThan(DEFAULT_SPILL_THRESHOLD_CHARS);

    // The store is local + gitignored.
    expect(spillDirPath(dir)).toBe(resolve(dir, '.mochi', 'spill'));
    expect(readFileSync(resolve(spillDirPath(dir), '.gitignore'), 'utf8')).toContain('*');
  });

  it('round-trips through the real recall_output tool by key', async () => {
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput(EVIDENCE) });
    const keys = scanSpillRefs(flatMessages(ctx.getMessages()));
    expect(keys.length).toBe(1);
    const out = await recallOutputTool.execute({ key: keys[0] }, { workspace: { dir } } as never);
    expect(out).toContain(EVIDENCE);
    expect(out).toContain('full spilled content');
  });

  it('emits NO marker when the spill cannot land (a marker that points nowhere is a silent drop)', async () => {
    // Unwritable store: .mochi/spill exists as a FILE, so mkdir/write fails.
    mkdirSync(resolve(dir, '.mochi'), { recursive: true });
    writeFileSync(resolve(dir, '.mochi', 'spill'), 'not a dir', 'utf8');
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput(EVIDENCE) });
    const content = (ctx.getMessages().find((m) => m.role === 'tool')!.content) as string;
    expect(content).not.toContain('[mochi-spill:');
    // The pre-existing fallback still applied (fold/condense), so the result
    // is small WITHOUT a dangling pointer.
    expect(content).toContain('output folded');
    expect(content.length).toBeLessThan(6000);
  });

  it('leaves below-threshold outputs on the unchanged fold path (no behavior change)', () => {
    const medium = `start\n${'line of ordinary output\n'.repeat(400)}end`; // ~10K chars, below every spill limit
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: medium });
    const content = (ctx.getMessages().find((m) => m.role === 'tool')!.content) as string;
    expect(content).toContain('output folded');
    expect(content).not.toContain('[mochi-spill:');
    expect(existsSync(spillDirPath(dir))).toBe(false); // nothing was spilled
  });
});

describe('D2 leg 1 at the cut + leg 2: compact() carries spilled evidence and the protected head', () => {
  it('a dropped oversized unit stays reachable: key rides the ledger, marker resolves, content identical', async () => {
    ctx.setGoal('Fix the 503 retry storm');
    ctx.addMessage({ role: 'user', content: 'Fix the 503 retry storm' });
    ctx.addMessage({ role: 'assistant', content: 'Running the suite.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test"}' } }] });
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput(EVIDENCE) });
    fillers(ctx, 12); // push the evidence deep past the cut

    await ctx.compact();

    const post = flatMessages(ctx.getMessages());
    // The message that held the marker was dropped, but the ledger carries
    // the key and the key still resolves to the identical content.
    expect(post).toContain('Spilled oversized outputs');
    const keys = scanSpillRefs(post);
    expect(keys.length).toBe(1);
    const hit = retrieveSpilled(dir, keys[0])!;
    expect(hit).toBeTruthy();
    expect(hit.text).toContain(EVIDENCE);
    // And the real tool resolves it post-compaction.
    const out = await recallOutputTool.execute({ key: keys[0] }, { workspace: { dir } } as never);
    expect(out).toContain(EVIDENCE);
  });

  it('spills an oversized unit found in the dropped slice even when it never went through addMessage (restored-session shape)', async () => {
    ctx.setGoal('Fix the 503 retry storm');
    ctx.addMessage({ role: 'user', content: 'Fix the 503 retry storm' });
    // Simulate a restored/legacy history that bypassed addMessage: the raw
    // oversized result sits in the transcript unspilled.
    (ctx as unknown as { messages: ChatMessage[] }).messages.push(
      { role: 'assistant', content: 'Restored context.', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test"}' } }] },
      { role: 'tool', tool_call_id: 'r1', name: 'shell', content: oversizedOutput(EVIDENCE) },
    );
    fillers(ctx, 12, 100);
    await ctx.compact();

    const post = flatMessages(ctx.getMessages());
    expect(post).toContain('Spilled oversized outputs');
    const keys = scanSpillRefs(post);
    expect(keys.length).toBe(1);
    expect(retrieveSpilled(dir, keys[0])!.text).toContain(EVIDENCE);
  });

  it('protected head: goal, plan state, open TODOs, and the skill name each survive compaction', async () => {
    ctx.setGoal('Fix the 503 retry storm with exponential backoff');
    mkdirSync(resolve(dir, '.mochi', 'state'), { recursive: true });
    writeFileSync(resolve(dir, '.mochi', 'state', 'todo.json'), JSON.stringify([
      { order: 1, status: 'done', title: 'Reproduce the storm' },
      { order: 2, status: 'in_progress', title: 'Add regression test for the 503 retry loop' },
      { order: 3, status: 'pending', title: 'Wire recall of spilled outputs in finish summary' },
    ]), 'utf8');
    ctx.updateState({ nextAction: 'Run the backoff migration on staging (migrate-staging-backoff)' });
    ctx.addMessage({ role: 'user', content: 'Fix the 503 retry storm with exponential backoff' });
    ctx.addMessage({ role: 'assistant', content: 'Loading the workflow skill.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'skill', arguments: '{"name":"test-driven-development"}' } }] });
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'skill', content: `# test-driven-development\n${'RED-GREEN-REFACTOR discipline text. '.repeat(60)}` });
    // A `skill list` call is advertisement, not play — never tracked.
    ctx.addMessage({ role: 'assistant', content: 'Browsing.', tool_calls: [{ id: 't2', type: 'function', function: { name: 'skill', arguments: '{"name":"list"}' } }] });
    ctx.addMessage({ role: 'tool', tool_call_id: 't2', name: 'skill', content: 'test-driven-development\ngit-workflow' });
    fillers(ctx, 12);

    expect(ctx.getSkillsInPlay()).toEqual(['test-driven-development']);
    await ctx.compact();

    const post = flatMessages(ctx.getMessages());
    const headBlock = post.split('\n').findIndex((l) => l.includes('PROTECTED SESSION HEAD'));
    expect(headBlock).toBeGreaterThanOrEqual(0);
    const block = post;
    // Member 1 — session snapshot: goal.
    expect(block).toContain('Goal: Fix the 503 retry storm with exponential backoff');
    // Member 2 — session snapshot: current plan state.
    expect(block).toContain('Next action: Run the backoff migration on staging (migrate-staging-backoff)');
    // Member 3/4 — open TODOs (done item NOT carried).
    expect(block).toContain('Add regression test for the 503 retry loop');
    expect(block).toContain('Wire recall of spilled outputs in finish summary');
    expect(block).not.toContain('Reproduce the storm');
    // Member 5 — skill NAMES in play (name, not the body).
    expect(block).toContain('test-driven-development');
    expect(block).not.toContain('RED-GREEN-REFACTOR discipline text.');
  });
});

describe('D2 leg 3: bounded post-compaction re-injection', () => {
  it('the next step receives the protected head + spill keys within the budget', async () => {
    ctx.setGoal('Fix the 503 retry storm');
    ctx.addMessage({ role: 'user', content: 'Fix the 503 retry storm' });
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput(EVIDENCE) });
    fillers(ctx, 12);
    await ctx.compact();

    const r = ctx.lastReinjection;
    expect(r).toBeTruthy();
    expect(r!.budgetChars).toBeGreaterThan(0);
    expect(r!.spentChars).toBeLessThanOrEqual(r!.budgetChars);
    expect(r!.truncated).toBe(false);
    expect(r!.keys.length).toBe(1);
    expect(r!.keysIncluded).toEqual(r!.keys);
    // The block carries the head and a described line for the key.
    const blockMsg = ctx.getMessages().find((m) => m.role === 'system' && (m.content as string).includes('POST-COMPACTION EVIDENCE RE-INJECTION'));
    expect(blockMsg).toBeTruthy();
    const block = blockMsg!.content as string;
    expect(block).toContain('Goal: Fix the 503 retry storm');
    expect(block).toContain('recall_output key=');

    // And the FOLLOW-UP step's packet (what the model actually sees) contains it.
    ctx.addMessage({ role: 'user', content: 'What did the staging suite actually print?' });
    const packet = ctx.buildPacket([], undefined as never, undefined as never);
    const packetText = flatMessages(packet.messages);
    expect(packetText).toContain('POST-COMPACTION EVIDENCE RE-INJECTION');
    expect(scanSpillRefs(packetText).length).toBe(1);
  });

  it('the budget cap is enforced: spend never exceeds the override, omissions are named', async () => {
    ctx.setGoal('Fix the 503 retry storm');
    // 600 sits above the block's floor (header + snapshot + keys header)
    // but below two described key lines + the omission note — so exactly
    // one key fits and the other's omission must be named.
    ctx.setReinjectionBudgetChars(600);
    ctx.addMessage({ role: 'user', content: 'Fix the 503 retry storm' });
    // Two oversized units → two keys; a 470-char budget cannot describe both.
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput('EVIDENCE-ONE ' + 'a'.repeat(120)) });
    ctx.addMessage({ role: 'tool', tool_call_id: 't2', name: 'read', content: oversizedOutput('EVIDENCE-TWO ' + 'b'.repeat(120)) });
    fillers(ctx, 12);
    await ctx.compact();

    const r = ctx.lastReinjection!;
    expect(r.budgetChars).toBe(600);
    expect(r.spentChars).toBeLessThanOrEqual(600);
    expect(r.truncated).toBe(true);
    expect(r.keys.length).toBe(2);
    expect(r.keysIncluded.length).toBeLessThan(2);
    // Omitted keys remain resolvable via the ledger line — not silent drops.
    const post = flatMessages(ctx.getMessages());
    for (const key of r.keys) {
      expect(retrieveSpilled(dir, key)).toBeTruthy();
      expect(post).toContain(key);
    }
  });

  it('a second compaction rebuilds the hook block (self-healing after it is cut)', async () => {
    ctx.setGoal('Fix the 503 retry storm');
    ctx.addMessage({ role: 'user', content: 'Fix the 503 retry storm' });
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput(EVIDENCE) });
    fillers(ctx, 12);
    await ctx.compact();
    expect(ctx.lastReinjection!.keys.length).toBe(1);
    fillers(ctx, 14, 100);
    await ctx.compact();
    // The first block was in the dropped slice; the hook re-ran and the key
    // (still referenced by the ledger chain) is re-injected.
    const post = flatMessages(ctx.getMessages());
    expect(post).toContain('POST-COMPACTION EVIDENCE RE-INJECTION');
    expect(scanSpillRefs(post).length).toBe(1);
    expect(retrieveSpilled(dir, scanSpillRefs(post)[0])!.text).toContain(EVIDENCE);
  });
});

describe('D2: store hygiene', () => {
  it('clearSpillStore empties the store (test helper sanity)', () => {
    ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'shell', content: oversizedOutput(EVIDENCE) });
    expect(readdirSync(spillDirPath(dir)).some((f) => f.endsWith('.txt'))).toBe(true);
    clearSpillStore(dir);
    expect(existsSync(spillDirPath(dir))).toBe(false);
  });
});
