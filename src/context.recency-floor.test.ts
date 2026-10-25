// B15 regression: the complex-task recency floor fights the token window.
//
// Three faces, all in src/context.ts:
// 1. buildPacket(): `overBudget` required recent.length >= MIN_RECENT, so the
//    first 24 (complex) messages were added UNCONDITIONALLY — the implicit
//    fall-through below the floor never consulted the budget. When the
//    clamped window couldn't hold 24 dense messages, the packet went out
//    over budget → provider 400.
// 2. compact()/planCutIndex() refuse to shrink below the SAME 24-message
//    floor (keep = 24), so once messages.length <= 24, compaction is a
//    no-op and cannot repair the overshoot it is asked to fix.
// 3. shrinkOldToolOutputs() exempted the newest 40 (complex) messages from
//    in-place shrinking — wider than the 24-message floor — so the
//    cheapest lever was also locked out.
// Result: provider 400s, compaction can't fix it, retries burn out.
//
// Contract pinned here: the recency floor is a TARGET, not an override —
// the packet builder stops adding at the budget line (keeping at least the
// newest turn), compaction accepts an explicit smaller floor, and the floor
// region is not exempt from in-place shrinking.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Hermetic: this file exercises the TypeScript context engine only. The
// native Rust runtime must NOT be spawned from here — a live child process
// left behind in the vitest worker keeps the macOS runner's test step alive
// (the runner's orphan cleanup then tears the job down). The native path has
// its own parity tests.
process.env.MOCHI_NO_NATIVE = '1';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, approxTokens } from './context.js';
import type { MochiConfig, ChatMessage } from './types.js';

let skillsDir: string;
beforeAll(() => { skillsDir = mkdtempSync(join(tmpdir(), 'mochi-b15-')); });
afterAll(() => { rmSync(skillsDir, { recursive: true, force: true }); });

function cfg(budget: number): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: budget, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

// A read result of ~1000 estimated tokens (4000 chars).
const DENSE = 'x'.repeat(4000);

function pushTurns(c: ContextEngine, n: number): void {
  for (let k = 0; k < n; k++) {
    c.addMessage({ role: 'assistant', content: `step ${k}` } as ChatMessage);
    c.addMessage({ role: 'tool', tool_call_id: `c${k}`, name: 'read', content: DENSE } as ChatMessage);
  }
}

describe('recency floor must not override the token window (B15)', () => {
  it('buildPacket stays within budget when the window cannot hold the floor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-b15-1-'));
    try {
      const c = new ContextEngine(cfg(4000), dir, skillsDir);
      c.setTaskComplexity('complex');
      pushTurns(c, 30); // 60 messages x ~1000 tokens >> 4000 budget
      const packet = c.buildPacket([], undefined, undefined);
      // The packet is what gets sent to the provider. It must fit the
      // working budget (approx 4000 tokens); with the bug the 24-message
      // floor alone carries ~12K+ tokens of dense tool results.
      // REVIEW-STRENGTHENED: usedTokens = budget - remaining, and remaining
      // is inflated by the rescue add-back (context.ts:933), so it can read
      // NEGATIVE on a grossly over-budget packet. Pin the real wire size.
      const real = packet.messages.reduce(
        (a, m) => a + approxTokens(JSON.stringify(m)), 0);
      expect(real).toBeLessThanOrEqual(4000);
      expect(packet.usedTokens).toBeLessThanOrEqual(4000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compact() can shrink below the 24-message floor when the budget demands it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-b15-2-'));
    try {
      const c = new ContextEngine(cfg(4000), dir, skillsDir);
      c.setTaskComplexity('complex');
      pushTurns(c, 30); // 60 messages > 24 floor
      await c.compact();
      // First compaction keeps the 24-message floor by design. The invariant
      // under test: a caller that must go deeper (context-limit recovery
      // with a tightened budget) can request an explicit smaller floor.
      // With the bug, compact() hard-codes 24 and short-circuits to a no-op.
      await c.compact(undefined, 12);
      expect(c.messageCount).toBeLessThanOrEqual(12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shrinkOldToolOutputs can shrink the oversized floor on complex tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-b15-3-'));
    try {
      const c = new ContextEngine(cfg(4000), dir, skillsDir);
      c.setTaskComplexity('complex');
      // REVIEW-STRENGTHENED: 18 turns = 36 messages — ALL inside main's
      // 40-message complex window (so main's shrink is a no-op: saved 0),
      // but 12 of them sit outside the fixed 24-message window (so the fix
      // reaches them).
      pushTurns(c, 18);
      const saved = c.shrinkOldToolOutputs();
      expect(saved).toBeGreaterThan(0);
      // A later pass still finds new mass as messages age past the window.
      pushTurns(c, 25);
      expect(c.shrinkOldToolOutputs()).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recency floor can never expand the budget window — only reorder within it (B15 restructure pin)', () => {
    // CONTRACT (see context.ts buildPacket comment): the floor is a TARGET
    // for the TOKEN window — the packet that goes to the provider always
    // fits the budget, and the floor decides WHICH messages keep their full
    // payload (newest first). It does NOT decide how many MESSAGES survive:
    // below the floor a message is kept even when it does not fit at full
    // size (its dense payload is truncated instead), because dropping a tool
    // message or its assistant parent breaks provider tool-pairing and
    // hides veto replies from the model.
    //
    // The DISCRIMINATOR is the token bound: an implementation that treated
    // the floor as an override would keep all 20 messages at full size
    // (~22k tokens — nearly three times the window) and blow the budget.
    const dir = mkdtempSync(join(tmpdir(), 'mochi-b15-pin-'));
    try {
      const c = new ContextEngine(cfg(8000), dir, skillsDir);
      c.setTaskComplexity('complex'); // floor request: 24 messages
      // 10 turns = 20 messages (~20k tokens with dense tool results) against
      // an 8000-token window: an override would keep all 20 at full size
      // (~22k tokens); a compliant builder keeps the newest payload
      // intact and shrinks the older ones to fit.
      for (let k = 0; k < 10; k++) {
        c.addMessage({ role: 'assistant', content: `step ${k}`, tool_calls: [{ id: `c${k}`, type: 'function', function: { name: 'read', arguments: '{}' } }] } as ChatMessage);
        c.addMessage({ role: 'tool', tool_call_id: `c${k}`, name: 'read', content: DENSE } as ChatMessage);
      }
      const packet = c.buildPacket([], undefined, undefined);
      // WIRE bound: cachedMessageTokens and this measure share the same basis
      // (approxTokens over JSON.stringify), so the slack here only absorbs
      // rounding at the walk boundary — the token bound above is the
      // decisive discriminator (an override measures ~22k, nearly three
      // times the window).
      const real = packet.messages.reduce(
        (a, m) => a + approxTokens(JSON.stringify(m)), 0);
      expect(real).toBeLessThanOrEqual(8000 * 1.12);
      expect(packet.usedTokens).toBeLessThanOrEqual(8000);
      // PAYLOAD bound: the oldest dense payloads are truncated rather than
      // riding along at full size — the floor reorders, it does not expand.
      const toolMsgs = packet.messages.filter((m) => m.role === 'tool') as Array<ChatMessage & { tool_call_id?: string; content?: string }>;
      const oldest = toolMsgs.find((m) => m.tool_call_id === 'c0');
      expect(oldest).toBeDefined();
      expect(String(oldest?.content).length).toBeLessThan(DENSE.length);
      // Recency priority held: the NEWEST turn specifically survives — the
      // sole unconditional add is the LAST message pushed (tool result of
      // call c9). Matching any tool result would let an oldest-first builder
      // pass while dropping the newest turn, which is the bug shape.
      const newestTool = packet.messages.find(
        (m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'c9');
      expect(newestTool).toBeDefined();
      // Its payload stays essentially intact (the final budget backstop may
      // shave the tail of the assembled packet, so this is a bound, not an
      // exact equality).
      expect(String((newestTool as { content?: string }).content).length).toBeGreaterThan(DENSE.length * 0.75);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
