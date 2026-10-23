// Wave S4 — effort calibration units: the thresholds ARE the safety
// property, so they are pinned exactly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  calibratedBaseTier,
  recordEffortOutcome,
  loadEffortStats,
  effortStatsPath,
  EFFORT_MIN_SAMPLES,
  type EffortStats,
} from './effort-calibration.js';

let dir: string;

function seed(stats: EffortStats) {
  const p = effortStatsPath(dir);
  mkdirSync(resolve(dir, '.mochi/state'), { recursive: true });
  writeFileSync(p, JSON.stringify(stats));
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-effort-'));
  delete process.env.MOCHI_EFFORT_CALIBRATION;
});
afterEach(() => {
  delete process.env.MOCHI_EFFORT_CALIBRATION;
  rmSync(dir, { recursive: true, force: true });
});

describe('calibratedBaseTier', () => {
  it('no history -> the static tier stands', () => {
    expect(calibratedBaseTier(dir, 'fix', 'high')).toEqual({ tier: 'high' });
  });

  it('lowers ONE rung when the rung below is proven (>=8 runs, >=80% solved)', () => {
    seed({ version: 1, kinds: { fix: { tiers: { medium: { runs: 10, solved: 9 } } } } });
    const out = calibratedBaseTier(dir, 'fix', 'high');
    expect(out.tier).toBe('medium');
    expect(out.reason).toContain('9/10');
  });

  it('does NOT lower below the sample threshold (7 proven runs is not proof)', () => {
    seed({ version: 1, kinds: { fix: { tiers: { medium: { runs: EFFORT_MIN_SAMPLES - 1, solved: EFFORT_MIN_SAMPLES - 1 } } } } });
    expect(calibratedBaseTier(dir, 'fix', 'high').tier).toBe('high');
  });

  it('does NOT lower below the solve-rate threshold (75% < 80%)', () => {
    seed({ version: 1, kinds: { fix: { tiers: { medium: { runs: 8, solved: 6 } } } } });
    expect(calibratedBaseTier(dir, 'fix', 'high').tier).toBe('high');
  });

  it('raises ONE rung when the static tier is starved (>=8 runs, <50% solved)', () => {
    seed({ version: 1, kinds: { fix: { tiers: { high: { runs: 10, solved: 3 } } } } });
    const out = calibratedBaseTier(dir, 'fix', 'high');
    expect(out.tier).toBe('max');
    expect(out.reason).toContain('3/10');
  });

  it('does NOT raise at exactly 50% (the bar is strictly below)', () => {
    seed({ version: 1, kinds: { fix: { tiers: { high: { runs: 10, solved: 5 } } } } });
    expect(calibratedBaseTier(dir, 'fix', 'high').tier).toBe('high');
  });

  it('never moves more than one rung, and clamps at the ladder ends', () => {
    // Lowering requires the IMMEDIATELY lower rung to be proven: low and
    // medium both proven does nothing for a max default (high is unproven),
    // and a proven high lowers max by exactly one rung — never two.
    seed({ version: 1, kinds: { implement: { tiers: { low: { runs: 50, solved: 50 }, medium: { runs: 50, solved: 50 } } } } });
    expect(calibratedBaseTier(dir, 'implement', 'max').tier).toBe('max');
    seed({ version: 1, kinds: { implement: { tiers: { high: { runs: 50, solved: 50 } } } } });
    expect(calibratedBaseTier(dir, 'implement', 'max').tier).toBe('high');
    seed({ version: 1, kinds: { fix: { tiers: { max: { runs: 10, solved: 0 } } } } });
    expect(calibratedBaseTier(dir, 'fix', 'max').tier).toBe('max');
    seed({ version: 1, kinds: { fix: { tiers: { low: { runs: 10, solved: 0 } } } } });
    expect(calibratedBaseTier(dir, 'fix', 'low').tier).toBe('medium');
  });

  it('lowering is evaluated before raising (proven-below wins)', () => {
    seed({ version: 1, kinds: { fix: { tiers: { medium: { runs: 10, solved: 10 }, high: { runs: 10, solved: 2 } } } } });
    expect(calibratedBaseTier(dir, 'fix', 'high').tier).toBe('medium');
  });

  it('the kill-switch restores the static tier regardless of history', () => {
    seed({ version: 1, kinds: { fix: { tiers: { medium: { runs: 10, solved: 10 } } } } });
    process.env.MOCHI_EFFORT_CALIBRATION = '0';
    expect(calibratedBaseTier(dir, 'fix', 'high').tier).toBe('high');
  });

  it('a corrupt stats file is treated as empty, never throws', () => {
    const p = effortStatsPath(dir);
    mkdirSync(resolve(dir, '.mochi/state'), { recursive: true });
    writeFileSync(p, '{not json');
    expect(calibratedBaseTier(dir, 'fix', 'high').tier).toBe('high');
  });
});

describe('recordEffortOutcome', () => {
  it('round-trips: records accumulate per kind x tier and drive calibration', () => {
    for (let i = 0; i < 10; i++) recordEffortOutcome(dir, 'fix', 'medium', i < 9);
    const stats = loadEffortStats(dir);
    expect(stats.kinds.fix.tiers.medium).toEqual({ runs: 10, solved: 9 });
    expect(existsSync(effortStatsPath(dir))).toBe(true);
    expect(calibratedBaseTier(dir, 'fix', 'high').tier).toBe('medium');
    // And the file on disk is valid JSON of the same shape.
    const onDisk = JSON.parse(readFileSync(effortStatsPath(dir), 'utf8')) as EffortStats;
    expect(onDisk.kinds.fix.tiers.medium?.runs).toBe(10);
  });

  it('ignores non-rung tiers and empty kinds', () => {
    recordEffortOutcome(dir, 'fix', 'off', true);
    recordEffortOutcome(dir, '', 'high', true);
    expect(loadEffortStats(dir).kinds).toEqual({});
  });
});
