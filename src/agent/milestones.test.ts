import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MilestoneTracker,
  buildMilestonePlan,
  loadMilestoneState,
  parseMilestonePlan,
  planMilestonesWithChat,
  resolveLongtaskFlags,
  runMilestoneCheck,
  saveMilestoneState,
  type MilestoneEvent,
  type MilestoneInput,
} from './milestones.js';

const INPUTS: MilestoneInput[] = [
  { title: 'types compile', check: 'npx tsc --noEmit' },
  { title: 'unit tests pass', check: 'npx vitest run src/a.test.ts' },
  { title: 'docs updated', check: 'grep -q foo README.md', optional: true },
];

function tracker(budget = { tokens: 1000, turns: 20 }): { t: MilestoneTracker; events: MilestoneEvent[] } {
  const events: MilestoneEvent[] = [];
  const state = buildMilestonePlan('task-1', 'Fix the thing', INPUTS, budget);
  return { t: new MilestoneTracker(state, (e) => events.push(e)), events };
}

describe('long-task milestones (agent/milestones.ts)', () => {
  it('rejects plans without adjudicable checks instead of auto-passing them', () => {
    expect(() => buildMilestonePlan('t', 'x', [], { tokens: 0, turns: 0 })).toThrow(/empty/);
    expect(() => buildMilestonePlan('t', 'x', [{ title: 'no check' }], { tokens: 0, turns: 0 })).toThrow(/no adjudicable check/);
    expect(() => buildMilestonePlan('t', 'x', [{ title: 'manual', check: { kind: 'manual' } }], { tokens: 0, turns: 0 })).toThrow(/manual/);
  });

  it('activates milestones in order and only passes on a harness check', () => {
    const { t, events } = tracker();
    const first = t.activate();
    expect(first?.title).toBe('types compile');
    expect(t.recordCheck(false, 'exit_code: 1')).toBeNull();
    expect(first?.attempts).toBe(1);
    expect(events.some((e) => e.type === 'check-failed')).toBe(true);
    const closed = t.recordCheck(true, 'exit_code: 0');
    expect(closed?.title).toBe('types compile');
    expect(t.passedCount()).toBe(1);
    expect(t.current()?.title).toBe('unit tests pass');
  });

  it('checkpoint text carries the Next: contract', () => {
    const { t } = tracker();
    t.activate();
    const text = t.checkpointText('resume me');
    expect(text).toContain('Next: types compile');
    expect(text).toContain('npx tsc --noEmit');
  });

  it('tightens by dropping optional milestones when burn outruns progress', () => {
    const { t, events } = tracker();
    t.activate();
    t.recordCheck(true, 'exit_code: 0');
    t.noteSpend(800, 5);
    const verdict = t.assessPacing();
    expect(verdict.action).toBe('tighten');
    const dropped = t.applyTightening(verdict.reason);
    expect(dropped).toEqual(['ms-3']);
    expect(events.some((e) => e.type === 'dropped')).toBe(true);
    expect(t.current()?.title).toBe('unit tests pass');
  });

  it('escalates when the budget is actually exhausted', () => {
    const { t } = tracker();
    t.noteSpend(1000, 1);
    const v = t.assessPacing();
    expect(v.action).toBe('escalate');
    t.markEscalated(v.reason);
    expect(t.state.escalated?.reason).toContain('token budget');
    expect(t.assessPacing().action).toBe('none');
  });

  it('re-plans only with evidence, preserves passed work, and enforces cooldown', () => {
    const { t, events } = tracker();
    t.activate();
    t.recordCheck(true, 'exit_code: 0');
    const gate = t.gateReplan('pacing');
    expect(gate.allowed).toBe(true);
    t.applyReplan([
      { title: 'new path A', check: 'echo a' },
      { title: 'new path B', check: 'echo b' },
    ], gate.reason);
    expect(t.state.milestones.map((m) => m.title)).toEqual(['types compile', 'new path A', 'new path B']);
    expect(t.state.milestones[0]!.status).toBe('passed');
    expect(t.state.milestones[2]!.id).toBe('ms-3');
    expect(events.some((e) => e.type === 'replanned')).toBe(true);
    expect(t.gateReplan('pacing').allowed).toBe(false);
  });

  it('round-trips plan state through the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-ms-'));
    const ws = { stateDir: join(dir, 'state') };
    const { t } = tracker();
    t.activate();
    t.recordCheck(true, 'exit_code: 0');
    saveMilestoneState(ws, t.state);
    const loaded = loadMilestoneState(ws, 'task-1');
    expect(loaded?.milestones[0]?.status).toBe('passed');
    expect(loadMilestoneState(ws, 'other')).toBeNull();
  });

  it('runs command checks and refuses to adjudicate manual ones', async () => {
    const ok = await runMilestoneCheck({ kind: 'command', command: 'true' }, '.', async () => 'exit_code: 0\nstdout:\nok');
    expect(ok.passed).toBe(true);
    const bad = await runMilestoneCheck({ kind: 'command', command: 'false' }, '.', async () => 'exit_code: 1');
    expect(bad.passed).toBe(false);
    const manual = await runMilestoneCheck({ kind: 'manual' }, '.', async () => 'exit_code: 0');
    expect(manual.passed).toBe(false);
  });

  it('parses only milestones that carry a check', () => {
    const parsed = parseMilestonePlan('[{"title":"a","check":"echo a"},{"title":"b"},{"title":"c","check":"echo c","optional":true}]');
    expect(parsed?.map((m) => m.title)).toEqual(['a', 'c']);
    expect(parseMilestonePlan('not json')).toBeNull();
  });

  it('asks the provider for a plan and returns null on unusable output', async () => {
    const good = await planMilestonesWithChat(
      { title: 'fix', description: 'do it' },
      async () => ({ content: '[{"title":"step","check":"echo ok"}]' }),
    );
    expect(good).toHaveLength(1);
    const bad = await planMilestonesWithChat({ title: 'fix' }, async () => ({ content: 'sorry, no' }));
    expect(bad).toBeNull();
  });

  it('resolves flags with kill switches', () => {
    const prev = process.env.MOCHI_LONGTASK;
    process.env.MOCHI_LONGTASK = '0';
    try {
      expect(resolveLongtaskFlags()).toEqual({ enabled: false, pacing: false });
    } finally {
      if (prev === undefined) delete process.env.MOCHI_LONGTASK;
      else process.env.MOCHI_LONGTASK = prev;
    }
    expect(resolveLongtaskFlags()).toEqual({ enabled: true, pacing: true });
  });
});
