// MCH-219: lineage compression — a prior compaction's ledger must survive the
// NEXT compaction. Before this, the "Earlier in this session (compacted):"
// system message was just another dropped message: run compact() twice and
// everything from run 1 (goal, decisions, files) was silently orphaned —
// the model's memory only reached back to the most recent compaction.
// Contract pinned here: compact() carries prior ledger bodies forward into
// the new ledger (oldest→newest, capped at the 2 most recent lineages).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from './context.js';
import type { MochiConfig, ChatMessage } from './types.js';

let skillsDir: string;
beforeAll(() => { skillsDir = mkdtempSync(join(tmpdir(), 'mochi-m219-')); });
afterAll(() => { rmSync(skillsDir, { recursive: true, force: true }); });

function cfg(): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: 100_000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

const MARK = 'Earlier in this session (compacted):';

function turn(c: ContextEngine, k: number): void {
  c.addMessage({ role: 'assistant', content: `decision point ${k}` } as ChatMessage);
  c.addMessage({ role: 'tool', tool_call_id: `c${k}`, name: 'read', content: `file ${k}: ok` } as ChatMessage);
}

function compactedLedger(c: ContextEngine): string | undefined {
  const m = c.getMessages().find((x) => x.role === 'system' && typeof x.content === 'string' && x.content.startsWith(MARK));
  return m ? (m.content as string).slice(MARK.length).trim() : undefined;
}

describe('MCH-219: compaction lineage carry-forward', () => {
  it('second compaction preserves the first ledger inside the new one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-m219-1-'));
    try {
      const c = new ContextEngine(cfg(), dir, skillsDir);
      for (let k = 0; k < 10; k++) turn(c, k);
      c.addDecision('FIRST-RUN-DECISION');
      await c.compact(undefined, 4);
      const ledger1 = compactedLedger(c);
      expect(ledger1).toBeTruthy();
      expect(ledger1).toContain('FIRST-RUN-DECISION');

      // Fill past the floor again so a second compaction has a valid cut.
      for (let k = 10; k < 20; k++) turn(c, k);
      await c.compact(undefined, 4);
      const ledger2 = compactedLedger(c);
      expect(ledger2).toBeTruthy();
      // The lineage body is carried forward, not orphaned.
      expect(ledger2).toContain('FIRST-RUN-DECISION');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lineage chain is capped — the 2 most recent ledgers survive, older ones fold away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-m219-2-'));
    try {
      const c = new ContextEngine(cfg(), dir, skillsDir);
      // Seed a ledger, compact, reseed, compact — final ledger must contain
      // both lineages but never an unbounded chain.
      for (let gen = 0; gen < 4; gen++) {
        for (let k = 0; k < 8; k++) turn(c, gen * 10 + k);
        c.addDecision(`GEN-${gen}-DECISION`);
        await c.compact(undefined, 4);
      }
      const final = compactedLedger(c);
      expect(final).toBeTruthy();
      expect(final).toContain('GEN-3-DECISION'); // newest checkpoint
      expect(final).toContain('GEN-2-DECISION'); // carried lineage
      // Cap on prior ledger BODIES: at most the 2 most recent lineages join
      // the new ledger (one "(earlier compaction)" separator). NOTE: the
      // state ledger's Decisions list is cumulative by design (addDecision
      // never forgets) — the cap governs ledger bodies only.
      const separators = (final!.match(/\(earlier compaction\)/g) ?? []).length;
      expect(separators).toBeLessThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
