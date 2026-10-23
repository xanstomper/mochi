// S4 — compaction-survival for task obligations + the marked-message
// upsert the pinned verifier objection relies on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from './context.js';
import type { MochiConfig } from './types.js';

let skillsDir: string;
beforeAll(() => { skillsDir = mkdtempSync(join(tmpdir(), 'mochi-ctx-skills-')); });
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

function makeEngine(dir: string): ContextEngine {
  const cfg = {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: 100000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as unknown as MochiConfig;
  return new ContextEngine(cfg, dir, skillsDir);
}

const CHECKLIST = 'The failure was reproduced (or observed) before the fix and is gone after it';
const CRITERION = 'node repro.js prints OK';

describe('ContextEngine obligations (S4)', () => {
  it('setObligations dedupes, trims, and bounds the set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-obl-'));
    try {
      const engine = makeEngine(dir);
      engine.setObligations(['  First obligation here  ', 'First obligation here', 'tiny', 'Second obligation here']);
      expect(engine.getObligations()).toEqual(['First obligation here', 'Second obligation here']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('obligations survive compaction: probed as must-survive facts and carried in the ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-obl-'));
    try {
      const engine = makeEngine(dir);
      engine.setGoal('Fix the bug in math.js');
      engine.setObligations([CHECKLIST, CRITERION]);
      engine.addMessage({ role: 'user', content: 'Fix the bug in math.js: add() returns the wrong result, make the repro pass.' });
      // Flood the transcript so the cut drops the early messages (where a
      // pinned contract message would live) — 30 bulky tool turns.
      for (let i = 0; i < 30; i++) {
        engine.addMessage({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `file${i}.js` }) } }] } as never);
        engine.addMessage({ role: 'tool', tool_call_id: `t${i}`, name: 'read', content: `file${i} contents ${'lorem ipsum dolor sit amet '.repeat(40)}` });
      }
      await engine.compact();
      const joined = engine.getMessages().map((m) => String(m.content ?? '')).join('\n');
      expect(joined).toContain(CHECKLIST);
      expect(joined).toContain(CRITERION);
      const verification = engine.lastCompactionVerification;
      expect(verification).toBeTruthy();
      const obligationFacts = verification!.facts.filter((f) => f.kind === 'obligation');
      expect(obligationFacts.map((f) => f.text)).toEqual(expect.arrayContaining([CHECKLIST, CRITERION]));
      expect(verification!.final.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upsertMarkedSystemMessage keeps exactly one live copy, refreshed in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-obl-'));
    try {
      const engine = makeEngine(dir);
      engine.addMessage({ role: 'user', content: 'hello world, this is a task' });
      const MARKER = 'VERIFIER OBJECTION';
      expect(engine.upsertMarkedSystemMessage(MARKER, 'VERIFIER OBJECTION — OPEN (attempt 1)')).toBe(false);
      expect(engine.upsertMarkedSystemMessage(MARKER, 'VERIFIER OBJECTION — OPEN (attempt 2)')).toBe(true);
      expect(engine.upsertMarkedSystemMessage(MARKER, 'VERIFIER OBJECTION — CLOSED')).toBe(true);
      const matches = engine.getMessages().filter((m) => String(m.content ?? '').includes(MARKER));
      expect(matches.length).toBe(1);
      expect(String(matches[0].content)).toContain('CLOSED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
