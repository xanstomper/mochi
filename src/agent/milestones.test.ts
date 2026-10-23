// Long-task milestone strategy — unit tests for the pure core
// (src/agent/milestones.ts): plan construction + validation, the pacing
// ladder (tighten → re-plan → escalate), the evidence gate on re-plans,
// verified-checkpoint state transitions, and persistence round-trips.
// Loop-level behavior (claims judged by checks, kill/resume at a
// boundary, wrong-assumption re-plans) lives in longtask.test.ts.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  MilestoneTracker,
  buildMilestonePlan,
  loadMilestoneState,
  normalizeMilestoneInputs,
  parseMilestoneInputs,
  planMilestonesWithChat,
  resolveLongtaskFlags,
  runMilestoneCheck,
  saveMilestoneState,
  type MilestoneInput,
} from './milestones.js';

const cmd = (command: string) => ({ kind: 'command' as const, command });
const art = (path: string, contains?: string) => ({ kind: 'artifact' as const, path, ...(contains ? { contains } : {}) });

function inputs(n: number, extra?: Partial<MilestoneInput>): MilestoneInput[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    title: `Milestone ${i + 1}`,
    detail: `Do step ${i + 1}`,
    check: cmd(`check-${i + 1}`),
    ...extra,
  }));
}

describe('plan construction', () => {
  it('distributes finite budgets by weight and leaves unbounded dimensions at 0', () => {
    const plan = buildMilestonePlan('t1', 'Task', [
      { id: 'a', title: 'A', check: cmd('a'), weight: 1 },
      { id: 'b', title: 'B', check: cmd('b'), weight: 1 },
      { id: 'c', title: 'C', check: cmd('c'), weight: 2 },
    ], { tokens: 0, turns: 40 });
    expect(plan.milestones.map((m) => m.budgetTurns)).toEqual([10, 10, 20]);
    expect(plan.milestones.map((m) => m.budgetTokens)).toEqual([0, 0, 0]);
    expect(plan.totalBudgetTurns).toBe(40);
  });

  it('derives unique slug ids from titles when ids are absent', () => {
    const norm = normalizeMilestoneInputs([
      { title: 'Write the code', check: cmd('x') },
      { title: 'Write the code', check: cmd('y') },
    ]);
    expect(norm[0].id).toBe('write-the-code');
    expect(norm[1].id).toBe('write-the-code-2');
  });

  it('topologically sorts by dependsOn (titles resolve through ids)', () => {
    const norm = normalizeMilestoneInputs([
      { id: 'c', title: 'C', check: cmd('c'), dependsOn: ['b'] },
      { id: 'a', title: 'A', check: cmd('a') },
      { id: 'b', title: 'B', check: cmd('b'), dependsOn: ['a'] },
    ]);
    expect(norm.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects empty plans, unknown deps, self-deps, cycles, and bad checks', () => {
    expect(() => normalizeMilestoneInputs([])).toThrow(/empty/);
    expect(() => normalizeMilestoneInputs([{ id: 'a', title: 'A', check: cmd('x'), dependsOn: ['ghost'] }])).toThrow(/unknown milestone/);
    expect(() => normalizeMilestoneInputs([{ id: 'a', title: 'A', check: cmd('x'), dependsOn: ['a'] }])).toThrow(/itself/);
    expect(() => normalizeMilestoneInputs([
      { id: 'a', title: 'A', check: cmd('x'), dependsOn: ['b'] },
      { id: 'b', title: 'B', check: cmd('y'), dependsOn: ['a'] },
    ])).toThrow(/cycle/);
    expect(() => normalizeMilestoneInputs([{ title: 'A', check: { kind: 'command', command: ' ' } as never }])).toThrow(/non-empty command/);
    expect(() => normalizeMilestoneInputs([{ title: 'A', check: { kind: 'vibes' } as never }])).toThrow(/unknown check kind/);
  });
});

describe('plan parsing + provider planner', () => {
  it('parses fenced JSON and returns null on garbage or invalid entries', () => {
    const good = parseMilestoneInputs('```json\n[{"title":"A","check":{"kind":"artifact","path":"a.txt"}}]\n```');
    expect(good).toHaveLength(1);
    expect(parseMilestoneInputs('no json here')).toBeNull();
    expect(parseMilestoneInputs('[{"title":"A","check":{"kind":"nope"}}]')).toBeNull();
    expect(parseMilestoneInputs('[]')).toBeNull();
  });

  it('planMilestonesWithChat round-trips through an injected chat fn and swallows failures', async () => {
    const ok = await planMilestonesWithChat(
      { title: 'Build it', description: 'stages' },
      async () => ({ content: '[{"title":"One","detail":"d","check":{"kind":"command","command":"true"}}]' }),
    );
    expect(ok).toHaveLength(1);
    const bad = await planMilestonesWithChat({ title: 'X' }, async () => ({ content: 'I cannot' }));
    expect(bad).toBeNull();
    const boom = await planMilestonesWithChat({ title: 'X' }, async () => { throw new Error('down'); });
    expect(boom).toBeNull();
  });
});

describe('tracker lifecycle', () => {
  it('closes milestones in order, only on passing checks, and reports position', () => {
    const events: string[] = [];
    const t = new MilestoneTracker(buildMilestonePlan('t', 'T', inputs(3), { tokens: 0, turns: 30 }), (e) => events.push(e.type));
    expect(t.current()?.id).toBe('m1');
    t.activate();
    expect(t.current()?.status).toBe('active');
    t.recordCheck(false, 'exit_code: 1\nnope');
    expect(t.current()?.id).toBe('m1');
    expect(t.current()?.attempts).toBe(1);
    t.recordCheck(true, 'exit_code: 0\nok');
    expect(t.current()?.id).toBe('m2');
    expect(t.passedCount()).toBe(1);
    expect(t.position()).toEqual({ index: 2, total: 3 });
    expect(events).toEqual(['check-failed', 'passed']);
  });

  it('a dropped dependency counts as satisfied for its dependents', () => {
    const plan = buildMilestonePlan('t', 'T', [
      { id: 'opt', title: 'Optional base', check: cmd('x'), optional: true },
      { id: 'dep', title: 'Dependent', check: cmd('y'), dependsOn: ['opt'] },
    ], { tokens: 0, turns: 10 });
    const t = new MilestoneTracker(plan);
    t.activate();
    t.state.milestones[0].status = 'dropped';
    expect(t.current()?.id).toBe('dep');
  });

  it('the evidence gate admits a re-plan only on first-sighting evidence', () => {
    const t = new MilestoneTracker(buildMilestonePlan('t', 'T', inputs(2), { tokens: 0, turns: 20 }));
    t.activate();
    expect(t.gateReplan('x').allowed).toBe(false);
    t.recordCheck(false, 'AssertionError: expected 5 to be 6');
    expect(t.hasPendingEvidence()).toBe(true);
    expect(t.gateReplan('x').allowed).toBe(true);
    // Same failure again: same class, already seen — NOT new evidence.
    t.recordCheck(false, 'AssertionError: expected 5 to be 6');
    expect(t.gateReplan('x').allowed).toBe(false);
    // A different failure class is new evidence.
    t.recordCheck(false, 'TypeError: cannot read property x of undefined');
    expect(t.gateReplan('x').allowed).toBe(true);
  });
});

describe('pacing ladder', () => {
  function overburnedTracker() {
    // 2 milestones, 20 turns total → slices of 10. Burn 16 turns on m1.
    const t = new MilestoneTracker(buildMilestonePlan('t', 'T', inputs(2), { tokens: 0, turns: 20 }));
    t.activate();
    t.noteSpend(0, 16);
    return t;
  }

  it('tighten fires first on over-burn and drops unstarted optional scope', () => {
    const plan = buildMilestonePlan('t', 'T', [
      { id: 'core', title: 'Core', check: cmd('core') },
      { id: 'extra', title: 'Extra polish', check: cmd('extra'), optional: true },
      { id: 'final', title: 'Final', check: cmd('final'), dependsOn: ['core'] },
    ], { tokens: 0, turns: 30 });
    const t = new MilestoneTracker(plan);
    t.activate();
    t.noteSpend(0, 16); // core slice is 10 → 1.6× over-burn
    const a = t.assessPacing();
    expect(a.action).toBe('tighten');
    const dropped = t.applyTightening(a.reason);
    expect(dropped).toEqual(['extra']);
    expect(t.state.milestones.find((m) => m.id === 'extra')?.status).toBe('dropped');
    // After tightening, with no new evidence, pacing does not demand a re-plan.
    expect(t.assessPacing().action).toBe('none');
  });

  it('re-plan is recommended after tightening when new evidence is pending', () => {
    const t = overburnedTracker();
    expect(t.assessPacing().action).toBe('tighten');
    t.applyTightening('test');
    t.recordCheck(false, 'boom: totally new failure mode');
    const a = t.assessPacing();
    expect(a.action).toBe('replan');
  });

  it('escalates when a finite budget is nearly gone with milestones open', () => {
    const t = new MilestoneTracker(buildMilestonePlan('t', 'T', inputs(3), { tokens: 0, turns: 30 }));
    t.activate();
    t.noteSpend(0, 28); // 93% of the turn budget, nothing passed
    expect(t.assessPacing().action).toBe('escalate');
  });

  it('escalates past the give-up line for a single milestone', () => {
    const t = new MilestoneTracker(buildMilestonePlan('t', 'T', inputs(4), { tokens: 0, turns: 40 }));
    t.activate();
    t.noteSpend(0, 26); // m1 slice is 10 → 2.6× — past give-up, under the 90% global line
    expect(t.assessPacing().action).toBe('escalate');
  });

  it('healthy burn yields no pacing action', () => {
    const t = new MilestoneTracker(buildMilestonePlan('t', 'T', inputs(2), { tokens: 0, turns: 20 }));
    t.activate();
    t.noteSpend(0, 4);
    expect(t.assessPacing().action).toBe('none');
  });
});

describe('re-plans', () => {
  it('preserve passed milestones, journal the trigger, and re-derive slices from the remaining budget', () => {
    const t = new MilestoneTracker(buildMilestonePlan('t', 'T', inputs(3), { tokens: 0, turns: 30 }));
    t.activate();
    t.noteSpend(0, 5);
    t.recordCheck(true, 'ok');
    t.activate();
    t.noteSpend(0, 4); // spent 9 total; 21 turns remain
    const rec = t.applyReplan([
      { id: 'm2', title: 'Milestone 2 (revised)', check: cmd('check-2b') },
      { id: 'm3', title: 'Milestone 3', check: cmd('check-3') },
    ], 'milestone check failed 2x: m2; new evidence: ...');
    expect(rec.replacedIds).toEqual(['m2', 'm3']);
    expect(t.state.milestones.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(t.state.milestones[0].status).toBe('passed');
    // Same-id replacement carries its spend over (4 turns on old m2).
    expect(t.state.milestones[1].spentTurns).toBe(4);
    // Remaining 21 turns split evenly across the two fresh milestones.
    expect(t.state.milestones[1].budgetTurns + t.state.milestones[2].budgetTurns).toBe(21);
    expect(t.state.replans).toHaveLength(1);
    expect(t.state.replans[0].trigger).toContain('milestone check failed 2x');
    expect(t.current()?.id).toBe('m2');
  });
});

describe('check execution', () => {
  it('command checks are decided by the exit_code envelope', async () => {
    const runShell = async (command: string) => (command === 'good' ? 'exit_code: 0\nfine' : 'exit_code: 3\nbad');
    expect((await runMilestoneCheck(cmd('good'), '/tmp', runShell)).passed).toBe(true);
    const bad = await runMilestoneCheck(cmd('bad'), '/tmp', runShell);
    expect(bad.passed).toBe(false);
    expect(bad.output).toContain('exit 3');
    const noEnvelope = await runMilestoneCheck(cmd('x'), '/tmp', async () => 'just text');
    expect(noEnvelope.passed).toBe(false);
  });

  it('artifact checks assert existence and content', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ms-check-'));
    try {
      writeFileSync(resolve(dir, 'a.txt'), 'hello world');
      const shell = async () => 'exit_code: 0';
      expect((await runMilestoneCheck(art('a.txt'), dir, shell)).passed).toBe(true);
      expect((await runMilestoneCheck(art('a.txt', 'world'), dir, shell)).passed).toBe(true);
      expect((await runMilestoneCheck(art('a.txt', 'mars'), dir, shell)).passed).toBe(false);
      expect((await runMilestoneCheck(art('missing.txt'), dir, shell)).passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('persistence', () => {
  it('state round-trips through the workspace JSON store and resumes at the open boundary', () => {
    const store = new Map<string, unknown>();
    const ws = {
      readJson<T>(path: string, fallback?: T): T {
        return (store.has(path) ? store.get(path) : fallback) as T;
      },
      writeJson(path: string, value: unknown) { store.set(path, value); },
    };
    const t = new MilestoneTracker(buildMilestonePlan('task-9', 'T', inputs(3), { tokens: 0, turns: 30 }));
    t.activate();
    t.recordCheck(true, 'ok');
    t.recordCheck(false, 'AssertionError: expected 5 to be 6');
    saveMilestoneState(ws, t.state);
    const loaded = loadMilestoneState(ws, 'task-9');
    expect(loaded).not.toBeNull();
    const t2 = new MilestoneTracker(JSON.parse(JSON.stringify(loaded)) as never);
    expect(t2.passedCount()).toBe(1);
    expect(t2.current()?.id).toBe('m2');
    // The pre-kill failure was already evidence once — a resumed tracker
    // must not treat its repeat as fresh grounds for a re-plan.
    expect(t2.gateReplan('resume').allowed).toBe(false);
    expect(loadMilestoneState(ws, 'other-task')).toBeNull();
  });
});

describe('flags', () => {
  it('env kill-switches win over config, config wins over defaults', () => {
    expect(resolveLongtaskFlags(undefined, {} as NodeJS.ProcessEnv)).toEqual({ enabled: true, pacing: true });
    expect(resolveLongtaskFlags(undefined, { MOCHI_LONGTASK: '0' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveLongtaskFlags({ enabled: false }, {} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveLongtaskFlags({ pacing: false }, {} as NodeJS.ProcessEnv).pacing).toBe(false);
    expect(resolveLongtaskFlags(undefined, { MOCHI_LONGTASK_PACING: '0' } as NodeJS.ProcessEnv).pacing).toBe(false);
  });
});

describe('briefs + summaries', () => {
  it('the escalation summary names open milestones, spend, and re-plan triggers', () => {
    const t = new MilestoneTracker(buildMilestonePlan('t', 'Big Task', inputs(2), { tokens: 5000, turns: 20 }));
    t.activate();
    t.noteSpend(400, 6);
    t.recordCheck(false, 'nope');
    const s = t.stateSummary('HEADER');
    expect(s).toContain('HEADER');
    expect(s).toContain('Big Task');
    expect(s).toContain('0 passed');
    expect(s).toContain('400');
    const cp = t.checkpointText('note');
    expect(cp).toContain('Next: Resume at milestone "Milestone 1"');
  });
});
