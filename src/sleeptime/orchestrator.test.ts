// Sleep-time consolidation orchestrator (D11): hard spend cap, per-night
// idempotency, structured morning report, and the D8/D10 stub ports.
// The two falsifiable criteria from the brief are (a) and (b):
//   (a) a dry run with a tiny cap stops at the cap and reports it;
//   (b) a second run the same night performs no duplicate repairs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import {
  runSleeptime, nightKeyFor, loadSleeptimeLedger, sleeptimeLedgerPath,
  createRepairStep, createGateStep, createCuratorStubRepairPort,
  estimateUsageCostUsd, renderSleeptimeReportMd,
  type SleeptimeStep, type PlannedUnit, type SleeptimeReport,
} from './orchestrator.js';
import { loadSkillUsage, saveSkillUsage, type SkillUsage } from '../skills/skills.js';
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

describe('stub repair port against the current curator/probation APIs', () => {
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
      projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createRepairStep()],
    });
    const unit = report.steps[0].units[0];
    expect(unit.status).toBe('completed');
    expect(unit.detail).toContain('STUB repair');
    expect(unit.detail).toContain('PROBATION');
    const rec = loadSkillUsage(proj).get('wobbly-skill');
    expect(rec?.state).toBe('probation');
    expect(rec?.passesInState).toBe(0);
    // The reservation was committed and is reported as ESTIMATED spend.
    expect(report.spend.usedEstimatedCostUsd).toBeGreaterThan(0);
    expect(report.spend.usedProviderCostUsd).toBe(0);
  });

  it('second run plans nothing: the skill left the demoted pool', async () => {
    seedDemoted('wobbly-skill');
    await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createRepairStep()] });
    const second = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, steps: [createRepairStep()] });
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
  it('runs repair → curator → gate → health → curriculum on an empty project without failing', async () => {
    const report = await runSleeptime({ projectDir: proj, spendCapUsd: 5, now: NOW, frozenDir: REAL_FROZEN });
    expect(report.steps.map((s) => s.id)).toEqual(['repair', 'curator', 'gate', 'health', 'curriculum']);
    expect(report.steps.map((s) => s.status)).toEqual(['skipped', 'completed', 'completed', 'completed', 'skipped']);
    expect(report.steps[4].detail).toContain('not integrated');
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
