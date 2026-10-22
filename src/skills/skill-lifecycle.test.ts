// Evidence-based skill lifecycle (B1): probation birth, verifier-gated
// promotion, evidence-based demotion, curator signals, and the trajectory
// skill-attribution join. The anti-self-grading regression test is (a): a
// structurally PERFECT skill (rubric 100) about an unproven procedure must
// never reach active on its score alone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import {
  loadSkillUsage, saveSkillUsage, recordSkillOutcome, recordSkillKindOutcome,
  loadSkillKindStats, skillKindStatsPath, resolveSkillsSettings, advertiseGateFloors,
  type SkillUsage,
} from './skills.js';
import { writeSkill, loadUsage, saveUsage, assessSkillQuality } from './skill-manager.js';
import {
  evaluateSkillLifecycle, computeSkillSignals, checkSkillReplay, runCurator, defaultCuratorConfig,
} from './skill-curator.js';
import { selectRelevantSkills } from '../context.js';
import { buildTrajectory } from '../observability/trajectory.js';
import type { TraceEntry } from '../observability/trace.js';
import type { Skill } from './skills.js';

/** Same 100-point fixture shape as skill-manager.test.ts. */
function procedureFixture(detail: string): string {
  return [
    '## When to use',
    'Use when maintaining a project workflow after a reproducible failure.',
    '## Procedure',
    '1. Reproduce the failure and record the exact diagnostic.',
    '2. Inspect the affected implementation and its callers.',
    '3. Apply a minimal repair while preserving existing behavior.',
    detail,
    '## Pitfalls',
    'Do not suppress diagnostics or remove assertions to conceal failures.',
    '## Verification',
    'Run `npm run typecheck` and the focused regression tests; require successful exits.',
  ].join('\n');
}
const DESC = 'Reusable procedure for repairing the worker deployment pipeline safely';

let proj: string;
let savedEnv: string | undefined;

function seedRecord(name: string, patch: Partial<SkillUsage>): void {
  const all = loadSkillUsage(proj);
  const cur = all.get(name) ?? { loads: 0, wins: 0 };
  all.set(name, { ...cur, ...patch });
  saveSkillUsage(proj, all);
}

function seedKindStats(stats: Record<string, { runs: number; passes: number }>): void {
  writeFileSync(skillKindStatsPath(proj), JSON.stringify(stats));
}

function addSnippet(name: string, snippet: string): void {
  // Locate the written SKILL.md via a fresh discovery-free path: writeSkill
  // puts uncategorized skills at .mochi/skills/<slug>/SKILL.md.
  const p = join(proj, '.mochi', 'skills', name, 'SKILL.md');
  appendFileSync(p, `\n<!-- mochi:verify\n${snippet}\n-->\n`);
}

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mchi-lifecycle-'));
  savedEnv = process.env.MOCHI_SKILLS_PROBATION;
  delete process.env.MOCHI_SKILLS_PROBATION;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOCHI_SKILLS_PROBATION;
  else process.env.MOCHI_SKILLS_PROBATION = savedEnv;
  rmSync(proj, { recursive: true, force: true });
});

describe('probation birth (replaces self-grading)', () => {
  it('(a) a rubric-100 skill is born on probation and never activates on score alone', () => {
    const body = procedureFixture('4. Confirm the repair with the recorded diagnostic.');
    expect(assessSkillQuality(DESC, body).score).toBe(100);
    const r = writeSkill(proj, { name: 'perfect-but-unproven', description: DESC, body });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('probation');
    const rec = loadSkillUsage(proj).get('perfect-but-unproven');
    expect(rec?.state).toBe('probation');
    expect(rec?.agentCreated).toBe(true);
    // No verified runs: the curator must not promote it, whatever its score.
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.promoted).not.toContain('perfect-but-unproven');
    expect(loadSkillUsage(proj).get('perfect-but-unproven')?.state).toBe('probation');
  });

  it('probation expiry flags the skill stale without ever activating it', () => {
    writeSkill(proj, { name: 'slow-skill', description: DESC, body: procedureFixture('Detail.') });
    seedRecord('slow-skill', { probationSince: Date.now() - 15 * 24 * 3600_000 });
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.probationStale).toContain('slow-skill');
    expect(loadSkillUsage(proj).get('slow-skill')?.state).toBe('probation');
  });

  it('a material rewrite of an active skill re-enters probation', () => {
    writeSkill(proj, { name: 'evolving-skill', description: DESC, body: procedureFixture('v1.') });
    seedRecord('evolving-skill', { state: 'active', passesInState: 5 });
    const r = writeSkill(proj, { name: 'evolving-skill', description: DESC, body: procedureFixture('v2, rewritten.') });
    expect(r.state).toBe('probation');
    expect(loadSkillUsage(proj).get('evolving-skill')?.passesInState).toBe(0);
  });
});

describe('promotion gate', () => {
  it('(b) 3 verifier-PASS runs + passing replays promote to active', () => {
    writeSkill(proj, { name: 'rising-skill', description: DESC, body: procedureFixture('Detail.') });
    addSnippet('rising-skill', 'exit 0');
    for (let i = 0; i < 3; i++) recordSkillOutcome(proj, 'rising-skill', 'pass', 'fix');
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.promoted).toContain('rising-skill');
    const rec = loadSkillUsage(proj).get('rising-skill');
    expect(rec?.state).toBe('active');
    expect(rec?.verifiedPasses).toBe(3);
    expect(rec?.demotionStrikes).toBe(0);
  });

  it('(b) two PASS runs are not enough', () => {
    writeSkill(proj, { name: 'almost-skill', description: DESC, body: procedureFixture('Detail.') });
    recordSkillOutcome(proj, 'almost-skill', 'pass', 'fix');
    recordSkillOutcome(proj, 'almost-skill', 'pass', 'fix');
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.promoted).not.toContain('almost-skill');
    expect(loadSkillUsage(proj).get('almost-skill')?.state).toBe('probation');
  });

  it('(b) failing Skill Doctor replays block promotion despite 3 PASS runs', () => {
    writeSkill(proj, { name: 'blocked-skill', description: DESC, body: procedureFixture('Detail.') });
    addSnippet('blocked-skill', 'exit 1');
    for (let i = 0; i < 3; i++) recordSkillOutcome(proj, 'blocked-skill', 'pass', 'fix');
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.promoted).not.toContain('blocked-skill');
    expect(loadSkillUsage(proj).get('blocked-skill')?.state).toBe('probation');
    // And the replay checker itself reports the failure faithfully.
    const chk = checkSkillReplay(proj, join(proj, '.mochi', 'skills', 'blocked-skill', 'SKILL.md'));
    expect(chk.hasSnippet).toBe(true);
    expect(chk.ok).toBe(false);
  });

  it('a demoted skill re-promotes only on 3 FRESH passes, clearing its strike', () => {
    writeSkill(proj, { name: 'comeback-skill', description: DESC, body: procedureFixture('Detail.') });
    seedRecord('comeback-skill', { state: 'demoted', demotionStrikes: 1, passesInState: 0, verifiedPasses: 9 });
    recordSkillOutcome(proj, 'comeback-skill', 'pass', 'fix');
    recordSkillOutcome(proj, 'comeback-skill', 'pass', 'fix');
    expect(evaluateSkillLifecycle(proj).promoted).not.toContain('comeback-skill');
    recordSkillOutcome(proj, 'comeback-skill', 'pass', 'fix');
    expect(evaluateSkillLifecycle(proj).promoted).toContain('comeback-skill');
    expect(loadSkillUsage(proj).get('comeback-skill')?.demotionStrikes).toBe(0);
  });
});

describe('demotion + curator signals', () => {
  it('(c) window pass-rate far below the matched baseline demotes, with evidence', () => {
    writeSkill(proj, { name: 'weak-skill', description: DESC, body: procedureFixture('Detail.') });
    seedRecord('weak-skill', {
      state: 'active',
      // 3/10 passes = 30%; deliberately does NOT end in two fails, so only
      // the baseline-window rule can fire (not the consecutive-fail rule).
      recentOutcomes: ['pass', 'fail', 'fail', 'fail', 'pass', 'fail', 'fail', 'fail', 'pass', 'fail'],
      kindLoads: { fix: 10 }, kindPasses: { fix: 3 }, helpful: 3, harmful: 7,
    });
    seedKindStats({ fix: { runs: 30, passes: 21 } }); // baseline (21-3)/(30-10) = 90%
    const ev = evaluateSkillLifecycle(proj);
    const hit = ev.demoted.find((d) => d.name === 'weak-skill');
    expect(hit).toBeDefined();
    expect(hit!.reason).toContain('30%');
    expect(hit!.reason).toContain('90%');
    const rec = loadSkillUsage(proj).get('weak-skill');
    expect(rec?.state).toBe('demoted');
    expect(rec?.demotionStrikes).toBe(1);
    expect(rec?.lastDemotionReason).toContain('window pass-rate');
  });

  it('(c) two consecutive verified failures demote immediately', () => {
    writeSkill(proj, { name: 'fragile-skill', description: DESC, body: procedureFixture('Detail.') });
    seedRecord('fragile-skill', { state: 'active', recentOutcomes: ['pass', 'fail', 'fail'], helpful: 1, harmful: 2, verifiedFails: 2 });
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.demoted.map((d) => d.name)).toContain('fragile-skill');
    expect(ev.demoted.find((d) => d.name === 'fragile-skill')!.reason).toContain('last two verified');
  });

  it('(c) a strong active skill is untouched, and sparse baselines never demote', () => {
    writeSkill(proj, { name: 'strong-skill', description: DESC, body: procedureFixture('Detail.') });
    seedRecord('strong-skill', {
      state: 'active',
      recentOutcomes: ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail', 'pass'],
      kindLoads: { fix: 5 }, kindPasses: { fix: 5 },
    });
    writeSkill(proj, { name: 'sparse-skill', description: DESC, body: procedureFixture('Detail.') });
    seedRecord('sparse-skill', {
      state: 'active',
      // Bad window (40%) and no two-fail ending — but kind 'obscure' has NO
      // baseline data, so the baseline rule must not fire on vibes.
      recentOutcomes: ['fail', 'pass', 'fail', 'fail', 'pass', 'fail', 'fail', 'pass', 'fail', 'pass'],
      kindLoads: { obscure: 10 }, kindPasses: { obscure: 4 },
    });
    seedKindStats({ fix: { runs: 30, passes: 21 } }); // no 'obscure' baseline at all
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.demoted.map((d) => d.name)).not.toContain('strong-skill');
    expect(ev.demoted.map((d) => d.name)).not.toContain('sparse-skill');
  });

  it('signals carry fix-rate, verified rate, ACE counters, and the matched baseline', () => {
    seedRecord('sig-skill', {
      loads: 10, wins: 7, verifiedPasses: 3, verifiedFails: 1, helpful: 3, harmful: 1,
      kindLoads: { fix: 4 }, kindPasses: { fix: 3 },
    });
    seedKindStats({ fix: { runs: 14, passes: 10 } });
    const sig = computeSkillSignals(proj).find((s) => s.name === 'sig-skill');
    expect(sig).toBeDefined();
    expect(sig!.fixRate).toBeCloseTo(0.7);
    expect(sig!.verifiedRate).toBeCloseTo(0.75);
    expect(sig!.helpful).toBe(3);
    expect(sig!.harmful).toBe(1);
    expect(sig!.baselineRate).toBeCloseTo(0.7); // (10-3)/(14-4)
    expect(sig!.baselineRuns).toBe(10);
    expect(sig!.kindRates.fix.rate).toBeCloseTo(0.75);
  });

  it('(c) runCurator: a high-fix-rate old skill is NOT archived by age; a dead one is', () => {
    writeSkill(proj, { name: 'proven-old', description: DESC, body: procedureFixture('Detail A.') });
    writeSkill(proj, { name: 'dead-old', description: DESC, body: procedureFixture('Detail B.') });
    const old = Date.now() - 100 * 24 * 3600_000;
    seedRecord('proven-old', { loads: 20, wins: 15, lastUsedAt: old });
    seedRecord('dead-old', { loads: 2, wins: 0, lastUsedAt: old });
    const out = runCurator(proj, { ...defaultCuratorConfig(), consolidate: false });
    expect(out.archiveProtected).toContain('proven-old');
    expect(out.archived).not.toContain('proven-old');
    expect(out.archived).toContain('dead-old');
    expect(existsSync(join(proj, '.mochi', 'skills', 'proven-old', 'SKILL.md'))).toBe(true);
    const report = readFileSync(out.reportPath, 'utf8');
    expect(report).toContain('Archive-protected by evidence');
    expect(report).toContain('proven-old');
    expect(report).toContain('fix-rate');
  });
});

describe('outcome recording (registry evidence)', () => {
  it('recordSkillOutcome accumulates counters, kind stats, and the rolling window', () => {
    writeSkill(proj, { name: 'tracked-skill', description: DESC, body: procedureFixture('Detail.') });
    recordSkillOutcome(proj, 'tracked-skill', 'pass', 'fix');
    let rec = loadSkillUsage(proj).get('tracked-skill');
    expect(rec?.verifiedPasses).toBe(1);
    expect(rec?.helpful).toBe(1);
    expect(rec?.passesInState).toBe(1); // probation: passes count toward promotion
    expect(rec?.kindLoads).toEqual({ fix: 1 });
    expect(rec?.kindPasses).toEqual({ fix: 1 });
    expect(rec?.lastVerdict).toBe('pass');
    recordSkillOutcome(proj, 'tracked-skill', 'blocked', 'fix');
    rec = loadSkillUsage(proj).get('tracked-skill');
    expect(rec?.verifiedFails).toBe(1); // BLOCKED folds into the fail bucket
    expect(rec?.harmful).toBe(1);
    expect(rec?.recentOutcomes).toEqual(['pass', 'fail']);
    recordSkillOutcome(proj, 'tracked-skill', 'partial', 'test');
    rec = loadSkillUsage(proj).get('tracked-skill');
    expect(rec?.verifiedPartials).toBe(1);
    expect(rec?.recentOutcomes).toEqual(['pass', 'fail', 'partial']);
  });

  it("a 'none' verdict records nothing — unverified runs are not evidence", () => {
    recordSkillOutcome(proj, 'ghost-skill', 'none', 'fix');
    expect(loadSkillUsage(proj).has('ghost-skill')).toBe(false);
  });

  it('the rolling window caps at 10 outcomes', () => {
    seedRecord('window-skill', { state: 'active' });
    for (let i = 0; i < 12; i++) recordSkillOutcome(proj, 'window-skill', i % 2 ? 'fail' : 'pass', 'fix');
    const rec = loadSkillUsage(proj).get('window-skill');
    expect(rec?.recentOutcomes).toHaveLength(10);
    expect(rec?.verifiedPasses).toBe(6);
    expect(rec?.verifiedFails).toBe(6);
  });

  it('kind baseline totals round-trip through record/load', () => {
    recordSkillKindOutcome(proj, 'fix', true);
    recordSkillKindOutcome(proj, 'fix', false);
    recordSkillKindOutcome(proj, 'test', true);
    expect(loadSkillKindStats(proj)).toEqual({ fix: { runs: 2, passes: 1 }, test: { runs: 1, passes: 1 } });
  });

  it('lifecycle fields survive the UsageRecord round-trip (loadUsage/saveUsage)', () => {
    seedRecord('round-trip', {
      state: 'demoted', demotionStrikes: 2, verifiedPasses: 4, helpful: 4, harmful: 3,
      recentOutcomes: ['pass', 'fail'], kindLoads: { fix: 2 }, lastVerdict: 'fail',
    });
    const db = loadUsage(proj);
    expect(db.byName['round-trip'].state).toBe('demoted');
    saveUsage(proj, db);
    const rec = loadSkillUsage(proj).get('round-trip');
    expect(rec?.state).toBe('demoted');
    expect(rec?.demotionStrikes).toBe(2);
    expect(rec?.verifiedPasses).toBe(4);
    expect(rec?.recentOutcomes).toEqual(['pass', 'fail']);
    expect(rec?.kindLoads).toEqual({ fix: 2 });
  });
});

describe('advertising gate (probation = strong matches only)', () => {
  const skill: Skill = {
    name: 'deploy-helper',
    description: 'Deploy worker service to production safely with checks',
    path: '/unused',
  };
  // Base overlap with the weak task is 2/6 = 0.33 (above the 0.25 floor,
  // below the 0.5 probation floor); with the strong task it is 1.0.
  const weakTask = 'worker deployment pipeline fails in production repo';
  const strongTask = 'deploy worker production service';

  it('ungated skills advertise on the normal floor', () => {
    expect(selectRelevantSkills([skill], weakTask, 6).map((s) => s.name)).toContain('deploy-helper');
  });

  it('probation gates weak matches out but lets strong matches through', () => {
    const gates = new Map([['deploy-helper', 0.5]]);
    expect(selectRelevantSkills([skill], weakTask, 6, undefined, gates)).toHaveLength(0);
    expect(selectRelevantSkills([skill], strongTask, 6, undefined, gates).map((s) => s.name)).toContain('deploy-helper');
  });

  it('advertiseGateFloors derives floors from registry state only when enforcement is on', () => {
    seedRecord('deploy-helper', { state: 'probation' });
    seedRecord('other-skill', { state: 'demoted' });
    seedRecord('free-skill', { state: 'active' });
    const usage = loadSkillUsage(proj);
    const on = advertiseGateFloors(usage, { probationEnabled: true });
    expect(on.get('deploy-helper')).toBe(0.5);
    expect(on.get('other-skill')).toBe(0.6);
    expect(on.has('free-skill')).toBe(false);
    expect(advertiseGateFloors(usage, { probationEnabled: false }).size).toBe(0);
  });
});

describe('kill-switch (e)', () => {
  it('settings resolution: default on, config off, env beats config', () => {
    expect(resolveSkillsSettings().probationEnabled).toBe(true);
    expect(resolveSkillsSettings({ skills: { probation: false } }).probationEnabled).toBe(false);
    process.env.MOCHI_SKILLS_PROBATION = '0';
    expect(resolveSkillsSettings({ skills: { probation: true } }).probationEnabled).toBe(false);
    process.env.MOCHI_SKILLS_PROBATION = '1';
    expect(resolveSkillsSettings({ skills: { probation: false } }).probationEnabled).toBe(true);
    delete process.env.MOCHI_SKILLS_PROBATION;
  });

  it('env off: no birth stamp, no lifecycle transitions — legacy behavior', () => {
    process.env.MOCHI_SKILLS_PROBATION = '0';
    const r = writeSkill(proj, { name: 'legacy-skill', description: DESC, body: procedureFixture('Detail.') });
    expect(r.ok).toBe(true);
    expect(r.state).toBeUndefined();
    expect(loadSkillUsage(proj).get('legacy-skill')?.state).toBeUndefined();
    // Even a fully-qualified record does not transition while off.
    seedRecord('legacy-skill', { state: 'probation', passesInState: 5 });
    const ev = evaluateSkillLifecycle(proj);
    expect(ev.promoted).toHaveLength(0);
    expect(loadSkillUsage(proj).get('legacy-skill')?.state).toBe('probation');
  });
});

describe('trajectory attribution join (d, unit level)', () => {
  it('lifts skills[] + verification from the finish attribution entry', () => {
    const entries: TraceEntry[] = [
      { t: 1, kind: 'task:started', agentId: 'a1', task: { title: 'Fix it' } },
      { t: 2, kind: 'tool:called', tool: 'skill', args: { name: 'fix-math' } },
      { t: 3, kind: 'skills:attributed', agentId: 'a1', skills: [{ id: 'fix-math', verdict: 'pass' }], verifyStatus: 'PASS', taskKind: 'fix' },
      { t: 4, kind: 'task:completed', stopReason: 'completed' },
    ];
    const rec = buildTrajectory(entries, { runId: 'r1' });
    expect(rec.skills).toEqual([{ id: 'fix-math', verdict: 'pass' }]);
    expect(rec.verification).toEqual({ status: 'PASS', verdict: 'pass' });
  });

  it("a subagent's attribution never overwrites the parent run's join", () => {
    const entries: TraceEntry[] = [
      { t: 1, kind: 'task:started', agentId: 'parent', task: { title: 'Parent task' } },
      { t: 2, kind: 'skills:attributed', agentId: 'parent', skills: [{ id: 'parent-skill', verdict: 'pass' }], verifyStatus: 'PASS' },
      { t: 3, kind: 'skills:attributed', agentId: 'child', skills: [{ id: 'child-skill', verdict: 'fail' }], verifyStatus: 'FAIL' },
    ];
    const rec = buildTrajectory(entries, { runId: 'r2' });
    expect(rec.skills).toEqual([{ id: 'parent-skill', verdict: 'pass' }]);
    expect(rec.verification?.status).toBe('PASS');
  });

  it('legacy traces (no attribution entry) export skills [] and verification null', () => {
    const rec = buildTrajectory([{ t: 1, kind: 'task:completed', stopReason: 'completed' }], { runId: 'r3' });
    expect(rec.skills).toEqual([]);
    expect(rec.verification).toBeNull();
  });

  it('an unverified run still exports its verification as NONE/none', () => {
    const entries: TraceEntry[] = [
      { t: 1, kind: 'task:started', agentId: 'a1', task: { title: 'Chat' } },
      { t: 2, kind: 'skills:attributed', agentId: 'a1', skills: [{ id: 'chat-skill', verdict: 'none' }], verifyStatus: 'NONE' },
    ];
    const rec = buildTrajectory(entries, { runId: 'r4' });
    expect(rec.skills).toEqual([{ id: 'chat-skill', verdict: 'none' }]);
    expect(rec.verification).toEqual({ status: 'NONE', verdict: 'none' });
  });
});
