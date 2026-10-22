// Automatic skill repair loop (D8): a demoted skill is patched from the
// failure trajectories of runs that loaded it, ALWAYS re-enters via
// probation (never straight back to active), and gets at most 3 attempts
// before it stays demoted with the exhaustion recorded.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadSkillUsage, saveSkillUsage, type SkillUsage } from './skills.js';
import { writeSkill, loadUsage, saveUsage } from './skill-manager.js';
import {
  MAX_SKILL_REPAIR_ATTEMPTS, REPAIR_SECTION_HEADING,
  attemptSkillRepair, repairDemotedSkills, extractFailureEvidence,
  buildRepairedBody, loadExportedTrajectories, type RepairTrajectoryInput,
} from './skill-repair.js';

/** Same 100-point fixture shape as skill-lifecycle.test.ts. */
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

function failedRun(runId: string, skill: string, labels: string[] = ['verification_failed']): RepairTrajectoryInput {
  return {
    runId,
    task: { title: 'Fix the worker deployment' },
    skills: [{ id: skill, verdict: 'fail' }],
    verification: { status: 'FAIL', verdict: 'fail' },
    failureTaxonomy: labels.map((label) => ({ label, count: 1 })),
    steps: [{ index: 0, tool: 'run', args: { cmd: 'npm test' }, ok: false, outputSnippet: '', error: 'tests failed: expected 200, got 500' }],
  };
}
function passedRun(runId: string, skill: string): RepairTrajectoryInput {
  return {
    runId,
    task: { title: 'Fix the worker deployment' },
    skills: [{ id: skill, verdict: 'pass' }],
    verification: { status: 'PASS', verdict: 'pass' },
    failureTaxonomy: [],
    steps: [{ index: 0, tool: 'run', args: {}, ok: true, outputSnippet: 'ok' }],
  };
}

let proj: string;
let savedEnv: string | undefined;

function seedRecord(name: string, patch: Partial<SkillUsage>): void {
  const all = loadSkillUsage(proj);
  const cur = all.get(name) ?? { loads: 0, wins: 0 };
  all.set(name, { ...cur, ...patch });
  saveSkillUsage(proj, all);
}

/** Write a fixture skill and demote it the way the curator would. */
function demotedFixture(name: string, patch: Partial<SkillUsage> = {}): void {
  const r = writeSkill(proj, { name, description: DESC, body: procedureFixture('Detail.') });
  expect(r.ok).toBe(true);
  seedRecord(name, {
    state: 'demoted', demotionStrikes: 1, passesInState: 0,
    lastDemotionReason: 'last two verified runs that loaded it failed the gate',
    ...patch,
  });
}

function skillBody(name: string): string {
  return readFileSync(join(proj, '.mochi', 'skills', name, 'SKILL.md'), 'utf8');
}

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mchi-repair-'));
  savedEnv = process.env.MOCHI_SKILLS_PROBATION;
  delete process.env.MOCHI_SKILLS_PROBATION;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOCHI_SKILLS_PROBATION;
  else process.env.MOCHI_SKILLS_PROBATION = savedEnv;
  rmSync(proj, { recursive: true, force: true });
});

describe('falsifiable contract', () => {
  it('a demoted fixture skill with failure trajectories is patched, re-probationed, and its attempt counter increments', () => {
    demotedFixture('broken-deploy');
    const trajs = [failedRun('run-1', 'broken-deploy'), failedRun('run-2', 'broken-deploy', ['tool_errors'])];
    const r = attemptSkillRepair(proj, 'broken-deploy', trajs);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('repaired');
    expect(r.attempt).toBe(1);
    expect(r.repairAttempts).toBe(1);
    expect(r.evidenceRuns).toBe(2);
    // Re-probationed — NEVER straight back to active — with a fresh
    // promotion clock (passesInState reset by the birth stamp).
    expect(r.state).toBe('probation');
    const rec = loadSkillUsage(proj).get('broken-deploy');
    expect(rec?.state).toBe('probation');
    expect(rec?.passesInState).toBe(0);
    expect(rec?.repairAttempts).toBe(1);
    expect(rec?.lastRepairReason).toContain('auto-repair attempt 1/3');
    expect(rec?.lastRepairReason).toContain('run-1');
    expect(rec?.patches).toBe(1);
    // The patch cites its evidence and preserves the original procedure.
    const body = skillBody('broken-deploy');
    expect(body).toContain(REPAIR_SECTION_HEADING);
    expect(body).toContain('attempt 1 of 3');
    expect(body).toContain('run run-1 (fail)');
    expect(body).toContain('verification_failed');
    expect(body).toContain('expected 200, got 500');
    expect(body).toContain('Reproduce the failure and record the exact diagnostic.');
    expect(body).toContain('Guardrails added by this repair');
  });

  it('a 4th attempt is refused: the skill stays demoted with the exhaustion recorded', () => {
    demotedFixture('thrice-broken', { repairAttempts: MAX_SKILL_REPAIR_ATTEMPTS });
    const r = attemptSkillRepair(proj, 'thrice-broken', [failedRun('run-9', 'thrice-broken')]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('refused');
    expect(r.reason).toContain('exhausted (3/3)');
    expect(r.repairAttempts).toBe(3);
    const rec = loadSkillUsage(proj).get('thrice-broken');
    expect(rec?.state).toBe('demoted');
    expect(rec?.repairAttempts).toBe(3);
    expect(rec?.lastRepairReason).toContain('exhausted');
    // No patch was written.
    expect(skillBody('thrice-broken')).not.toContain(REPAIR_SECTION_HEADING);
  });

  it('attempts 1-3 succeed in sequence (re-demoting between), then the cap bites', () => {
    demotedFixture('repeat-offender');
    for (let n = 1; n <= 3; n++) {
      const r = attemptSkillRepair(proj, 'repeat-offender', [failedRun(`run-${n}`, 'repeat-offender')]);
      expect(r.status).toBe('repaired');
      expect(r.repairAttempts).toBe(n);
      expect(loadSkillUsage(proj).get('repeat-offender')?.state).toBe('probation');
      // Simulate the repaired skill failing probation and being demoted again.
      seedRecord('repeat-offender', { state: 'demoted' });
    }
    const r4 = attemptSkillRepair(proj, 'repeat-offender', [failedRun('run-4', 'repeat-offender')]);
    expect(r4.status).toBe('refused');
    expect(loadSkillUsage(proj).get('repeat-offender')?.state).toBe('demoted');
  });
});

describe('eligibility + evidence gates', () => {
  it('refuses skills that are not demoted (active, probation, unknown)', () => {
    writeSkill(proj, { name: 'probationer', description: DESC, body: procedureFixture('Detail.') });
    const rp = attemptSkillRepair(proj, 'probationer', [failedRun('r1', 'probationer')]);
    expect(rp.status).toBe('refused');
    expect(rp.reason).toContain('not demoted');
    seedRecord('probationer', { state: 'active' });
    expect(attemptSkillRepair(proj, 'probationer', [failedRun('r1', 'probationer')]).status).toBe('refused');
    expect(attemptSkillRepair(proj, 'never-seen', [failedRun('r1', 'never-seen')]).status).toBe('refused');
    expect(loadSkillUsage(proj).get('probationer')?.repairAttempts ?? 0).toBe(0);
  });

  it('refuses to patch blind: passing runs and other skills\' failures are not evidence', () => {
    demotedFixture('blind-repair');
    const onlyPasses = attemptSkillRepair(proj, 'blind-repair', [passedRun('p1', 'blind-repair')]);
    expect(onlyPasses.status).toBe('refused');
    expect(onlyPasses.reason).toContain('no failure trajectories');
    const otherSkill = attemptSkillRepair(proj, 'blind-repair', [failedRun('x1', 'someone-else')]);
    expect(otherSkill.status).toBe('refused');
    const rec = loadSkillUsage(proj).get('blind-repair');
    expect(rec?.state).toBe('demoted');
    expect(rec?.repairAttempts ?? 0).toBe(0);
    expect(rec?.lastRepairReason).toContain('no failure trajectories');
  });

  it('refuses while the probation lifecycle kill-switch is off', () => {
    demotedFixture('switch-off');
    process.env.MOCHI_SKILLS_PROBATION = '0';
    const r = attemptSkillRepair(proj, 'switch-off', [failedRun('r1', 'switch-off')]);
    expect(r.status).toBe('refused');
    expect(r.reason).toContain('probation lifecycle is disabled');
    expect(loadSkillUsage(proj).get('switch-off')?.state).toBe('demoted');
  });

  it('a demoted record with no skill file fails cleanly and stays demoted', () => {
    seedRecord('ghost-skill', { state: 'demoted', loads: 3, wins: 0 });
    const r = attemptSkillRepair(proj, 'ghost-skill', [failedRun('r1', 'ghost-skill')]);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('not found');
    expect(loadSkillUsage(proj).get('ghost-skill')?.state).toBe('demoted');
  });
});

describe('patch construction (pure)', () => {
  it('extractFailureEvidence counts labels/tools and dedupes errors', () => {
    const ev = extractFailureEvidence('s', [
      failedRun('a', 's', ['tool_loop', 'repeated_tool_calls']),
      failedRun('b', 's', ['tool_loop']),
      passedRun('c', 's'),
      failedRun('d', 'other'),
    ]);
    expect(ev.runs.map((r) => r.runId)).toEqual(['a', 'b']);
    expect(ev.labelCounts).toEqual({ tool_loop: 2, repeated_tool_calls: 1 });
    expect(ev.failedToolCounts).toEqual({ run: 2 });
    expect(ev.errorSnippets).toEqual(['tests failed: expected 200, got 500']);
  });

  it('guardrails follow the dominant failure modes in the evidence', () => {
    const ev = extractFailureEvidence('s', [failedRun('a', 's', ['tool_loop', 'verification_failed'])]);
    const body = buildRepairedBody(procedureFixture('Detail.'), { attempt: 2, evidence: ev });
    expect(body).toContain('attempt 2 of 3');
    expect(body).toContain('Never repeat an identical tool call');
    expect(body).toContain('re-run the exact verifier');
  });

  it('a second repair replaces the prior repair section instead of stacking it', () => {
    demotedFixture('stacker');
    attemptSkillRepair(proj, 'stacker', [failedRun('r1', 'stacker')]);
    seedRecord('stacker', { state: 'demoted' });
    const r2 = attemptSkillRepair(proj, 'stacker', [failedRun('r2', 'stacker')]);
    expect(r2.status).toBe('repaired');
    const body = skillBody('stacker');
    expect(body.split(REPAIR_SECTION_HEADING).length - 1).toBe(1);
    expect(body).toContain('attempt 2 of 3');
    expect(body).not.toContain('attempt 1 of 3');
  });
});

describe('repair pass (batch) + exports loader', () => {
  it('repairDemotedSkills repairs eligible skills and skips exhausted ones', () => {
    demotedFixture('fixable');
    demotedFixture('spent', { repairAttempts: 3 });
    writeSkill(proj, { name: 'healthy', description: DESC, body: procedureFixture('Other.') });
    const trajs = [failedRun('r1', 'fixable'), failedRun('r2', 'spent')];
    const sum = repairDemotedSkills(proj, trajs);
    expect(sum.repaired).toEqual(['fixable']);
    expect(sum.refused.map((x) => x.name)).toEqual(['spent']);
    expect(loadSkillUsage(proj).get('fixable')?.state).toBe('probation');
    expect(loadSkillUsage(proj).get('spent')?.state).toBe('demoted');
    expect(loadSkillUsage(proj).get('healthy')?.repairAttempts ?? 0).toBe(0);
  });

  it('loads failure trajectories from exports/ when no corpus is passed', () => {
    demotedFixture('from-disk');
    const dir = join(proj, 'exports');
    mkdirSync(dir, { recursive: true });
    const rec = {
      schemaVersion: 1, runId: 'exp-1', startedAt: 1, endedAt: 2, durationMs: 1,
      task: { title: 'Fix it' }, steps: [],
      skills: [{ id: 'from-disk', verdict: 'fail' }],
      verification: { status: 'FAIL', verdict: 'fail' },
      outcome: { completed: false }, usage: null,
      failureTaxonomy: [{ label: 'tool_errors', count: 1 }],
    };
    writeFileSync(join(dir, 'trajectory-exp-1.jsonl'), JSON.stringify(rec) + '\n');
    writeFileSync(join(dir, 'trajectory-bad.jsonl'), '{not json\n');
    expect(loadExportedTrajectories(proj).map((t) => t.runId)).toEqual(['exp-1']);
    const sum = repairDemotedSkills(proj);
    expect(sum.repaired).toEqual(['from-disk']);
    expect(existsSync(join(proj, '.mochi', 'skills', 'from-disk', 'SKILL.md'))).toBe(true);
  });

  it('repair fields survive the UsageRecord round-trip (loadUsage/saveUsage)', () => {
    seedRecord('round-trip', { state: 'demoted', repairAttempts: 2, lastRepairReason: 'auto-repair attempt 2/3' });
    const db = loadUsage(proj);
    expect(db.byName['round-trip'].repairAttempts).toBe(2);
    saveUsage(proj, db);
    const rec = loadSkillUsage(proj).get('round-trip');
    expect(rec?.repairAttempts).toBe(2);
    expect(rec?.lastRepairReason).toContain('attempt 2/3');
  });
});
