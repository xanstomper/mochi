// Sleep-time consolidation orchestrator (D11): hard spend cap, per-night
// idempotency, structured morning report, and the D8/D10 stub ports.
// The two falsifiable criteria from the brief are (a) and (b):
//   (a) a dry run with a tiny cap stops at the cap and reports it;
//   (b) a second run the same night performs no duplicate repairs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import {
  runSleeptime, nightKeyFor, loadSleeptimeLedger, sleeptimeLedgerPath,
  createRepairStep, createGateStep, createCuratorStubRepairPort, createCurriculumStep,
  estimateUsageCostUsd, renderSleeptimeReportMd,
  type SleeptimeStep, type PlannedUnit, type SleeptimeReport,
} from './orchestrator.js';
import { loadSkillUsage, saveSkillUsage, type SkillUsage } from '../skills/skills.js';
import { writeSkill } from '../skills/skill-manager.js';
import { REPAIR_SECTION_HEADING } from '../skills/skill-repair.js';
import { sleeptimeCronPrompt, trainCronPrompt } from '../self-train-schedule.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_FROZEN = join(REPO, 'bench', 'frozen');
const NIGHT = '2026-10-22';
const NOW = new Date(2026, 9, 22, 3, 0, 0); // local 03:00 on NIGHT

// gpt-4o list price: $2.50 / 1M input → 100k input tokens = exactly $0.25.
const QUARTER: PlannedUnit['estimatedUsage'] = { model: 'gpt-4o', inputTokens: 100_000, outputTokens: 0 };

let proj: string;
beforeEach(() => { proj = mkdtempSync(join(tmpdir(), 'mochi-sleeptime-')); });
afterEach(() => { rmSync(proj, { recursive: true, force: true }); });

function fakeStep(id: string, units: PlannedUnit[], onExecute?: (u: PlannedUnit) => void): SleeptimeStep {
  return {
    id,
    title: `Fake ${id}`,
    plan: () => ({ units }),
    execute: (u) => {
      onExecute?.(u);
      return { detail: `did ${u.key}` };
    },
  };
}

const pricedUnits = (n: number): PlannedUnit[] =>
  Array.from({ length: n }, (_, i) => ({ key: `work:${i}`, title: `unit ${i}`, estimatedUsage: QUARTER }));

describe('nightKeyFor', () => {
  it('formats the local calendar date, zero-padded', () => {
    expect(nightKeyFor(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(nightKeyFor(NOW)).toBe(NIGHT);
  });
});

describe('pricing of declared usage (Phase C table)', () => {
  it('prices gpt-4o input at list and prefers a declared provider cost', () => {
    expect(estimateUsageCostUsd(QUARTER!)).toBeCloseTo(0.25, 10);
    expect(estimateUsageCostUsd({ model: 'gpt-4o', inputTokens: 100_000, costUsd: 0.42 })).toBe(0.42);
    expect(estimateUsageCostUsd({ model: 'no-such-model' })).toBe(0);
  });
});

describe('(a) hard spend cap', () => {
  it('DRY RUN with a tiny cap stops at the cap and reports it — and persists nothing', async () => {
    let executed = 0;
    const step = fakeStep('work', pricedUnits(3), () => { executed++; });
    const report = await runSleeptime({
      projectDir: proj, spendCapUsd: 0.30, dryRun: true, now: NOW, steps: [step],
    });
    expect(executed).toBe(0); // dry run never executes
    expect(report.spend.stoppedAtCap).toBe(true);
    expect(report.spend.usedCostUsd).toBeCloseTo(0.25, 10); // one unit simulated at its estimate
    expect(report.spend.usedEstimatedCostUsd).toBeCloseTo(0.25, 10);
    expect(report.spend.costSource).toBe('estimated');
    const units = report.steps[0].units;
    expect(units.map((u) => u.status)).toEqual(['simulated', 'skipped-cap', 'skipped-cap']);
    expect(units[1].detail).toContain('exceeds remaining cap');
    expect(report.summary).toContain('STOPPED AT CAP');
    expect(report.reportPaths).toBeNull();
    // Nothing persisted: no ledger, no report files — a rehearsal must not
    // consume tonight's idempotency budget or fake a morning report.
    expect(existsSync(sleeptimeLedgerPath(proj))).toBe(false);
    expect(existsSync(join(proj, '.mochi', 'reports', `sleeptime-${NIGHT}.json`))).toBe(false);
  });

  it('LIVE run: the cap binds across units because estimates commit at start', async () => {
    const done: string[] = [];
    const step = fakeStep('work', pricedUnits(3), (u) => { done.push(u.key); });
    const report = await runSleeptime({
      projectDir: proj, spendCapUsd: 0.30, now: NOW, steps: [step],
    });
    // Unit 0 commits its $0.25 estimate even though the fake reports no
    // actual usage — so only $0.05 remains and units 1..2 never start.
    expect(done).toEqual(['work:0']);
    expect(report.steps[0].units.map((u) => u.status)).toEqual(['completed', 'skipped-cap', 'skipped-cap']);
    expect(report.spend.stoppedAtCap).toBe(true);
    expect(report.spend.usedCostUsd).toBeCloseTo(0.25, 10);
    expect(report.steps[0].status).toBe('partial');
  });

  it('a $0 cap still allows free (model-free) units but blocks priced ones', async () => {
    const free = fakeStep('free', [{ key: 'free:1', title: 'free unit' }]);
    const priced = fakeStep('priced', pricedUnits(1));
    const report = await runSleeptime({
      projectDir: proj, spendCapUsd: 0, now: NOW, steps: [free, priced],
    });
    expect(report.steps[0].units[0].status).toBe('completed');
    expect(report.steps[1].units[0].status).toBe('skipped-cap');
    expect(report.spend.stoppedAtCap).toBe(true);
  });

  it('provider-reported overrun above the committed estimate is charged additionally', async () => {
    const step: SleeptimeStep = {
      id: 'work', title: 'work',
      plan: () => ({ units: [{ key: 'work:0', title: 'u', estimatedUsage: QUARTER }] }),
      execute: () => ({ detail: 'done', actualCostUsd: 0.42 }),
    };
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [step] });
    expect(report.spend.usedCostUsd).toBeCloseTo(0.42, 10); // 0.25 estimated + 0.17 provider overrun
    expect(report.spend.usedEstimatedCostUsd).toBeCloseTo(0.25, 10);
    expect(report.spend.usedProviderCostUsd).toBeCloseTo(0.17, 10);
    expect(report.spend.costSource).toBe('mixed');
  });

  it('rejects a negative or non-finite cap', async () => {
    await expect(runSleeptime({ projectDir: proj, spendCapUsd: -1, steps: [] })).rejects.toThrow(/spendCapUsd/);
  });
});

describe('(b) idempotency — no duplicate work on a same-night re-run', () => {
  it('a counting repair port is invoked exactly once across two runs', async () => {
    let repairs = 0;
    const port = {
      // The candidate NEVER disappears from this port's list (e.g. its
      // state lives elsewhere), so only the LEDGER can prevent a duplicate.
      listCandidates: () => [{ name: 'fragile-skill', reason: 'last two verified runs failed', stateAt: 1234 }],
      repairOne: () => { repairs++; return { detail: 'patched + re-probationed' }; },
    };
    const steps = () => [createRepairStep(port)];
    const first = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: steps() });
    expect(repairs).toBe(1);
    expect(first.steps[0].units[0].status).toBe('completed');

    const second = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: steps() });
    expect(repairs).toBe(1); // no duplicate repair
    expect(second.steps[0].units[0].status).toBe('skipped-duplicate');
    expect(second.steps[0].units[0].detail).toContain('no duplicate work');

    const ledger = loadSleeptimeLedger(proj);
    const keys = Object.keys(ledger.nights[NIGHT].units);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^repair:fragile-skill:1234:[0-9a-f]{8}$/);
    expect(ledger.nights[NIGHT].runCount).toBe(2);
  });

  it('a dry run after a live run reports the unit as already done (ledger is read, not written)', async () => {
    const step = fakeStep('work', [{ key: 'work:0', title: 'u', estimatedUsage: QUARTER }]);
    await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [step] });
    const dry = await runSleeptime({ projectDir: proj, spendCapUsd: 5, dryRun: true, now: NOW, steps: [step] });
    expect(dry.steps[0].units[0].status).toBe('skipped-duplicate');
    expect(loadSleeptimeLedger(proj).nights[NIGHT].runCount).toBe(1); // dry run did not bump it
  });

  it('a different night is new work (ledger is scoped per night)', async () => {
    let runs = 0;
    const step = fakeStep('work', [{ key: 'work:0', title: 'u' }], () => { runs++; });
    await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [step] });
    await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: new Date(2026, 9, 23, 3, 0, 0), steps: [step] });
    expect(runs).toBe(2);
  });
});

describe('legacy stub repair port (explicit use only — no longer a default)', () => {
  function seedDemoted(name: string): void {
    const all = loadSkillUsage(proj);
    const rec: SkillUsage = {
      loads: 6, wins: 1, state: 'demoted', stateAt: 999, verifiedFails: 3,
      lastDemotionReason: 'last two verified runs that loaded it failed the gate',
    };
    all.set(name, rec);
    saveSkillUsage(proj, all);
  }

  it('re-enters a demoted skill via probation (never straight to active), labelled STUB', async () => {
    seedDemoted('wobbly-skill');
    const report = await runSleeptime({
      projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createRepairStep(createCuratorStubRepairPort())],
    });
    const unit = report.steps[0].units[0];
    expect(unit.status).toBe('completed');
    expect(unit.detail).toContain('STUB repair');
    expect(unit.detail).toContain('PROBATION');
    const rec = loadSkillUsage(proj).get('wobbly-skill');
    expect(rec?.state).toBe('probation');
    expect(rec?.passesInState).toBe(0);
    // The stub port declares no cost shape, so the step reserves the
    // DEFAULT_REPAIR_ESTIMATE fallback — committed, labelled ESTIMATED.
    expect(report.spend.usedEstimatedCostUsd).toBeGreaterThan(0);
    expect(report.spend.usedProviderCostUsd).toBe(0);
  });

  it('second run plans nothing: the skill left the demoted pool', async () => {
    seedDemoted('wobbly-skill');
    const stubSteps = () => [createRepairStep(createCuratorStubRepairPort())];
    await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: stubSteps() });
    const second = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: stubSteps() });
    expect(second.steps[0].units).toEqual([]);
    expect(second.steps[0].status).toBe('skipped');
    expect(second.steps[0].detail).toContain('no demoted skills');
  });

  it('the stub port lists only demoted skills, with their demotion evidence', () => {
    seedDemoted('wobbly-skill');
    const all = loadSkillUsage(proj);
    all.set('healthy-skill', { loads: 3, wins: 3, state: 'active' });
    saveSkillUsage(proj, all);
    const candidates = createCuratorStubRepairPort().listCandidates(proj);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('wobbly-skill');
    expect(candidates[0].reason).toContain('failed the gate');
  });
});

describe('morning report', () => {
  it('writes structured JSON + Markdown under .mochi/reports and returns both paths', async () => {
    const step = fakeStep('work', [{ key: 'work:0', title: 'u', estimatedUsage: QUARTER }]);
    const report: SleeptimeReport = await runSleeptime({
      projectDir: proj, spendCapUsd: 2, now: NOW, steps: [step],
    });
    expect(report.kind).toBe('mochi-sleeptime-report');
    expect(report.nightKey).toBe(NIGHT);
    expect(report.cap.maxCostUsd).toBe(2);
    expect(report.reportPaths).not.toBeNull();
    const onDisk = JSON.parse(readFileSync(report.reportPaths!.json, 'utf8')) as SleeptimeReport;
    expect(onDisk.summary).toBe(report.summary);
    expect(onDisk.steps[0].units[0].key).toBe('work:0');
    const md = readFileSync(report.reportPaths!.md, 'utf8');
    expect(md).toContain('# 🌙 Sleeptime consolidation');
    expect(md).toContain(report.summary);
    expect(renderSleeptimeReportMd(report)).toContain('Spend:');
  });

  it('a failed unit is reported, charged its reservation, and does not kill the night', async () => {
    const bad: SleeptimeStep = {
      id: 'bad', title: 'bad',
      plan: () => ({ units: [{ key: 'bad:0', title: 'boom', estimatedUsage: QUARTER }] }),
      execute: () => { throw new Error('patcher exploded'); },
    };
    const good = fakeStep('good', [{ key: 'good:0', title: 'fine' }]);
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [bad, good] });
    expect(report.steps[0].status).toBe('failed');
    expect(report.steps[0].units[0].detail).toContain('patcher exploded');
    expect(report.steps[0].units[0].costUsd).toBeCloseTo(0.25, 10); // reservation stays charged
    expect(report.steps[1].units[0].status).toBe('completed');
    // Failed units are NOT ledgered — tomorrow (or a re-run) may retry them.
    expect(loadSleeptimeLedger(proj).nights[NIGHT].units['bad:0']).toBeUndefined();
    expect(loadSleeptimeLedger(proj).nights[NIGHT].units['good:0']).toBeDefined();
  });
});

describe('gate step (default integrity port)', () => {
  it('verifies the real frozen set hashes', async () => {
    const report = await runSleeptime({
      projectDir: proj, spendCapUsd: 5, now: NOW, frozenDir: REAL_FROZEN,
      steps: [createGateStep()],
    });
    expect(report.steps[0].units[0].status).toBe('completed');
    expect(report.steps[0].units[0].detail).toContain('integrity-ok');
    expect(report.steps[0].units[0].detail).toContain('hashes verified');
  });

  it('skips cleanly when no frozen set exists', async () => {
    const report = await runSleeptime({
      projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createGateStep()],
    });
    expect(report.steps[0].status).toBe('skipped');
    expect(report.steps[0].detail).toContain('no frozen set');
  });
});

describe('default pipeline shape', () => {
  it('runs repair → curator → gate → health → induction → self-writing → curriculum on an empty project without failing', async () => {
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, frozenDir: REAL_FROZEN });
    expect(report.steps.map((s) => s.id)).toEqual(['repair', 'curator', 'gate', 'health', 'induction', 'self-writing', 'curriculum', 'routing-stats']);
    expect(report.steps.map((s) => s.status)).toEqual(['skipped', 'completed', 'completed', 'completed', 'skipped', 'skipped', 'skipped', 'completed']);
    // The self-writing step is inert without an injected held-out runner:
    expect(report.steps[5].detail).toContain('no held-out runner configured');
    expect(report.steps[6].detail).toContain('default port is a no-op');
    expect(report.spend.usedCostUsd).toBe(0);
  });
});

describe('cron wiring (self-train --schedule now installs the orchestrator)', () => {
  it('sleeptimeCronPrompt invokes `mochi sleeptime` with the cap and forbids improvisation', () => {
    const p = sleeptimeCronPrompt();
    expect(p).toContain('mochi sleeptime --cap 5');
    expect(p).toContain('idempotently');
    expect(p).toContain('Do not improvise');
    expect(sleeptimeCronPrompt('auth', 2.5)).toContain('mochi sleeptime --cap 2.5');
    expect(sleeptimeCronPrompt('auth').split('\n')[0]).toContain('auth');
  });

  it('the legacy free-form prompt is unchanged for existing installs', () => {
    expect(trainCronPrompt()).toContain('single most valuable');
  });
});

describe('production adapters — real D8 repair + D10 curriculum (audit L-01)', () => {
  const DESC = 'Reusable procedure for repairing the worker deployment pipeline safely';
  const BODY = [
    '## When to use',
    'Use when maintaining a project workflow after a reproducible failure.',
    '## Procedure',
    '1. Reproduce the failure and record the exact diagnostic.',
    '2. Inspect the affected implementation and its callers.',
    '3. Apply a minimal repair while preserving existing behavior.',
    'Detail.',
    '## Pitfalls',
    'Do not suppress diagnostics or remove assertions to conceal failures.',
    '## Verification',
    'Run the focused regression tests; require successful exits.',
  ].join('\n');

  function seedSkill(name: string): void {
    const r = writeSkill(proj, { name, description: DESC, body: BODY });
    expect(r.ok).toBe(true);
    const all = loadSkillUsage(proj);
    const cur = all.get(name) ?? { loads: 0, wins: 0 };
    all.set(name, {
      ...cur, state: 'demoted', stateAt: 999, demotionStrikes: 1, passesInState: 0,
      lastDemotionReason: 'last two verified runs that loaded it failed the gate',
    });
    saveSkillUsage(proj, all);
  }

  function writeTrajectory(file: string, rec: Record<string, unknown>): void {
    const dir = join(proj, 'exports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(rec) + '\n');
  }

  it('the DEFAULT repair step patches a demoted skill from its failure trajectories — no STUB, no reservation', async () => {
    delete process.env.MOCHI_SKILLS_PROBATION;
    seedSkill('broken-deploy');
    writeTrajectory('trajectory-exp-repair-1.jsonl', {
      schemaVersion: 1, runId: 'exp-repair-1', startedAt: 1, endedAt: 2, durationMs: 1,
      task: { title: 'Fix the worker deployment' },
      steps: [{ index: 0, tool: 'run', args: { cmd: 'npm test' }, ok: false, outputSnippet: '', error: 'tests failed: expected 200, got 500' }],
      skills: [{ id: 'broken-deploy', verdict: 'fail' }],
      verification: { status: 'FAIL', verdict: 'fail' },
      outcome: { completed: false }, usage: null,
      failureTaxonomy: [{ label: 'verification_failed', count: 1 }],
    });
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createRepairStep()] });
    const unit = report.steps[0].units[0];
    expect(unit.status).toBe('completed');
    expect(unit.detail).toContain('D8 repair applied');
    expect(unit.detail).not.toContain('STUB');
    // The skill body was really patched, and the skill re-entered via
    // probation with its attempt counter incremented — never to active.
    const body = readFileSync(join(proj, '.mochi', 'skills', 'broken-deploy', 'SKILL.md'), 'utf8');
    expect(body).toContain(REPAIR_SECTION_HEADING);
    const rec = loadSkillUsage(proj).get('broken-deploy');
    expect(rec?.state).toBe('probation');
    expect(rec?.repairAttempts).toBe(1);
    // D8 repair is model-free: nothing reserved, nothing spent.
    expect(report.spend.usedCostUsd).toBe(0);
    expect(report.spend.usedEstimatedCostUsd).toBe(0);
  });

  it('the DEFAULT repair step refuses honestly when there is no failure evidence', async () => {
    delete process.env.MOCHI_SKILLS_PROBATION;
    seedSkill('blind-skill');
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createRepairStep()] });
    const unit = report.steps[0].units[0];
    expect(unit.status).toBe('completed');
    expect(unit.detail).toContain('repair refused');
    expect(unit.detail).toContain('no failure trajectories');
    expect(loadSkillUsage(proj).get('blind-skill')?.state).toBe('demoted');
  });

  it('repairs run even at a $0 cap — they are model-free', async () => {
    delete process.env.MOCHI_SKILLS_PROBATION;
    seedSkill('free-repair');
    writeTrajectory('trajectory-exp-repair-2.jsonl', {
      schemaVersion: 1, runId: 'exp-repair-2', startedAt: 1, endedAt: 2, durationMs: 1,
      task: { title: 'Fix the worker deployment' },
      steps: [{ index: 0, tool: 'run', args: { cmd: 'npm test' }, ok: false, outputSnippet: '', error: 'boom' }],
      skills: [{ id: 'free-repair', verdict: 'fail' }],
      verification: { status: 'FAIL', verdict: 'fail' },
      outcome: { completed: false }, usage: null,
      failureTaxonomy: [{ label: 'tool_errors', count: 1 }],
    });
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 0, now: NOW, steps: [createRepairStep()] });
    expect(report.steps[0].units[0].status).toBe('completed');
    expect(report.spend.stoppedAtCap).toBe(false);
    expect(loadSkillUsage(proj).get('free-repair')?.state).toBe('probation');
  });

  // A tiny Python project: pyproject.toml makes detectRepo resolve the
  // test command `python3 -m pytest -q`, and the fixture's own pytest.py
  // shim (real pytest is not installed in every environment) runs the
  // test_* functions in test_calc.py, printing PASS/FAIL lines and
  // exiting non-zero on failure — all the D10 shell runner needs.
  function curriculumFixture(implicate: boolean): void {
    writeFileSync(join(proj, 'pyproject.toml'), '[project]\nname = "curr-fixture"\nversion = "1.0.0"\n');
    writeFileSync(join(proj, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    writeFileSync(join(proj, 'test_calc.py'), 'from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n');
    writeFileSync(join(proj, 'pytest.py'), [
      'import importlib',
      'import sys',
      'import traceback',
      '',
      '',
      'def main():',
      '    failures = 0',
      '    total = 0',
      '    mod = importlib.import_module("test_calc")',
      '    for name in sorted(dir(mod)):',
      '        if not name.startswith("test_"):',
      '            continue',
      '        total += 1',
      '        try:',
      '            getattr(mod, name)()',
      '            print(f"PASS test_calc.{name}")',
      '        except Exception:',
      '            failures += 1',
      '            print(f"FAIL test_calc.{name}")',
      '            traceback.print_exc()',
      '    if total == 0:',
      '        print("no tests collected")',
      '        return 1',
      '    return 1 if failures else 0',
      '',
      '',
      'if __name__ == "__main__":',
      '    sys.exit(main())',
      '',
    ].join('\n'));
    writeTrajectory('trajectory-exp-curr-1.jsonl', {
      schemaVersion: 1, runId: 'exp-curr-1', startedAt: 1, endedAt: 2, durationMs: 1,
      task: { title: 'Fix the calculator' },
      steps: [implicate
        ? { index: 0, tool: 'edit', args: { path: 'calc.py' }, ok: false, outputSnippet: '', error: 'edit conflict' }
        : { index: 0, tool: 'run', args: { cmd: 'python3 -m pytest -q' }, ok: false, outputSnippet: '', error: 'tests failed' }],
      skills: [],
      verification: { status: 'FAIL', verdict: 'fail' },
      outcome: { completed: false }, usage: null,
      failureTaxonomy: [{ label: 'verification_failed', count: 1 }],
    });
  }

  it('the DEFAULT curriculum step plans from failed runs and generates a VALIDATED task', async () => {
    curriculumFixture(true);
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createCurriculumStep()] });
    const step = report.steps[0];
    expect(step.units).toHaveLength(1);
    const unit = step.units[0];
    expect(unit.status).toBe('completed');
    expect(unit.detail).toContain('generated validated practice task');
    expect(unit.detail).toContain('calc.py');
    expect(unit.detail).not.toContain('not integrated');
    const saved = readdirSync(join(proj, '.mochi', 'curriculum'));
    expect(saved.some((f) => f.endsWith('.json'))).toBe(true);
    // Generation validated in a scratch copy: the real tree is untouched.
    expect(readFileSync(join(proj, 'calc.py'), 'utf8')).toContain('a + b');
    expect(report.spend.usedCostUsd).toBe(0);
  }, 60_000);

  it('plans nothing when failed runs implicate no source file', async () => {
    curriculumFixture(false);
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createCurriculumStep()] });
    expect(report.steps[0].units).toEqual([]);
    expect(report.steps[0].status).toBe('skipped');
    expect(report.steps[0].detail).toContain('no curriculum tasks planned');
  });
});
