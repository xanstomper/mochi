// Ports from the Phase B heartbeat curator-signals variant, folded into the
// canonical lifecycle implementation:
//  (1) retrieval→success correlation (Pearson r of loads vs fix-rate) as a
//      registry-level health signal in the curator report;
//  (2) pinned skills are never age-archived by runCurator (previously only
//      the dedup/consolidation pass honored pins).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { loadSkillUsage, saveSkillUsage, type SkillUsage } from './skills.js';
import { writeSkill } from './skill-manager.js';
import {
  retrievalSuccessCorrelation, runCurator, defaultCuratorConfig,
  loadCuratorState, saveCuratorState, type SkillSignals,
} from './skill-curator.js';

function sig(name: string, loads: number, fixRate: number | null): SkillSignals {
  return {
    name, loads, wins: fixRate === null ? 0 : Math.round(fixRate * loads),
    fixRate, verifiedOutcomes: 0, verifiedRate: null, windowRate: null,
    helpful: 0, harmful: 0, baselineRate: null, baselineRuns: 0, kindRates: {},
  };
}

describe('retrievalSuccessCorrelation (ported)', () => {
  it('is +1 when more-loaded skills win more, -1 when they lose more', () => {
    const up = [sig('a', 2, 0.2), sig('b', 3, 0.4), sig('c', 4, 0.6), sig('d', 5, 0.8)];
    expect(retrievalSuccessCorrelation(up)).toBeCloseTo(1);
    const down = [sig('a', 2, 0.8), sig('b', 3, 0.6), sig('c', 4, 0.4), sig('d', 5, 0.2)];
    expect(retrievalSuccessCorrelation(down)).toBeCloseTo(-1);
  });

  it('is null with <3 qualifying points, zero variance, or only low-load skills', () => {
    expect(retrievalSuccessCorrelation([sig('a', 2, 0.2), sig('b', 3, 0.4)])).toBeNull();
    expect(retrievalSuccessCorrelation([sig('a', 2, 0.5), sig('b', 3, 0.5), sig('c', 4, 0.5)])).toBeNull();
    // loads = 1 skills never qualify as points:
    expect(retrievalSuccessCorrelation([sig('a', 1, 0.0), sig('b', 1, 1.0), sig('c', 5, 0.5)])).toBeNull();
    expect(retrievalSuccessCorrelation([])).toBeNull();
  });
});

const DESC = 'Reusable procedure for repairing the worker deployment pipeline safely';
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

let proj: string;
beforeEach(() => { proj = mkdtempSync(join(tmpdir(), 'mchi-ports-')); });
afterEach(() => { rmSync(proj, { recursive: true, force: true }); });

function seedRecord(name: string, patch: Partial<SkillUsage>): void {
  const all = loadSkillUsage(proj);
  const cur = all.get(name) ?? { loads: 0, wins: 0 };
  all.set(name, { ...cur, ...patch });
  saveSkillUsage(proj, all);
}

describe('runCurator pin protection (ported)', () => {
  it('a pinned old skill is NOT age-archived; an identical unpinned one is', () => {
    writeSkill(proj, { name: 'pinned-old', description: DESC, body: procedureFixture('Detail P.') });
    writeSkill(proj, { name: 'dead-old', description: DESC, body: procedureFixture('Detail D.') });
    const old = Date.now() - 100 * 24 * 3600_000;
    // Weak records: evidence protection must NOT be what saves pinned-old.
    seedRecord('pinned-old', { loads: 2, wins: 0, lastUsedAt: old });
    seedRecord('dead-old', { loads: 2, wins: 0, lastUsedAt: old });
    const st = loadCuratorState(proj);
    saveCuratorState(proj, { ...st, pinned: ['pinned-old'] });
    const out = runCurator(proj, { ...defaultCuratorConfig(), consolidate: false });
    expect(out.archived).not.toContain('pinned-old');
    expect(out.archived).toContain('dead-old');
    expect(existsSync(join(proj, '.mochi', 'skills', 'pinned-old', 'SKILL.md'))).toBe(true);
  });
});
