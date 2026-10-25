import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRICULUM_PLAN_CAP,
  createRealCurriculumPort,
  createRealSkillRepairPort,
  deriveCurriculumCandidates,
} from './ports.js';
import type { SleeptimeStepContext } from './orchestrator.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'mochi-ports-'));
}

function ctx(projectDir: string): SleeptimeStepContext {
  return {
    projectDir,
    nightKey: '2026-10-22',
    dryRun: true,
    now: new Date(),
    // Unused by these ports; a cast keeps the fixture honest about that.
    budget: {} as SleeptimeStepContext['budget'],
    frozenDir: join(projectDir, 'bench', 'frozen'),
  };
}

describe('sleeptime real ports (audit L-01)', () => {
  it('repair port lists only demoted skills (none on a fresh workspace)', () => {
    const port = createRealSkillRepairPort();
    expect(port.listCandidates(project())).toEqual([]);
  });

  it('curriculum port plans nothing without failing exported runs', () => {
    const dir = project();
    expect(deriveCurriculumCandidates(dir)).toEqual([]);
    expect(createRealCurriculumPort().planTasks(dir, ctx(dir))).toEqual([]);
  });

  it('caps the nightly practice-task plan', () => {
    expect(CURRICULUM_PLAN_CAP).toBeGreaterThan(0);
    expect(CURRICULUM_PLAN_CAP).toBeLessThanOrEqual(3);
  });
});
