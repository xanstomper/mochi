// Sleeptime wiring for self-writing skills (item 16): the step must be
// INERT without an injected held-out runner (no manufactured rejections), and
// when armed it must run the full draft → prove → gated-install pipeline and
// report the per-pattern outcome.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createSelfWritingStep } from './self-writing-step.js';
import { defaultSleeptimeSteps } from './orchestrator.js';
import { discoverSkills } from '../skills/skills.js';
import type { TrajectoryRecord, TrajectoryStep } from '../observability/trajectory.js';
import { argShapeOf } from '../core/tool-sequence.js';
import type { PlannedUnit, SleeptimeStepContext } from './orchestrator.js';

let clock = 1_000;
function st(tool: string, args: unknown, i: number): TrajectoryStep {
  return { index: i, tool, args, argShape: argShapeOf(args), ok: true, outputSnippet: '' };
}
function traj(runId: string, title: string, taskKind: string, steps: Array<[string, unknown]>, endedAt?: number): TrajectoryRecord {
  return {
    schemaVersion: 2, runId, taskKind, verified: true, cost: null,
    startedAt: 1_000_000, endedAt: endedAt ?? ++clock, durationMs: 1_000,
    task: { title },
    steps: steps.map(([tool, args], i) => st(tool, args, i)),
    skills: [], verification: { status: 'PASS', verdict: 'pass' },
    outcome: { completed: true, stopReason: 'done' }, usage: null, failureTaxonomy: [],
  };
}
const reportSteps = (id: string): Array<[string, unknown]> => [
  ['read_file', { path: `src/report-${id}.txt` }],
  ['write_file', { path: `report-${id}.txt`, content: `report ${id}` }],
  ['run', { cmd: `verify ${id}` }],
];

let proj: string;
const ctx = (): SleeptimeStepContext => ({
  projectDir: proj, nightKey: 'test-night', dryRun: false, now: new Date(),
  budget: {} as never, frozenDir: join(proj, 'bench', 'frozen'),
});

beforeEach(() => { proj = mkdtempSync(join(tmpdir(), 'mchi-swstep-')); });
afterEach(() => { rmSync(proj, { recursive: true, force: true }); });

function seedExports(): void {
  mkdirSync(join(proj, 'exports'), { recursive: true });
  const records = [
    traj('run-1', 'R1', 'report', reportSteps('1'), 1),
    traj('run-2', 'R2', 'report', reportSteps('2'), 2),
    traj('run-3', 'R3', 'report', reportSteps('3'), 3),
    traj('run-4', 'R4 held-out', 'report', reportSteps('4'), 4),
  ];
  for (const r of records) {
    writeFileSync(join(proj, 'exports', `trajectory-${r.runId}.jsonl`), JSON.stringify(r) + '\n', 'utf8');
  }
}
function mkdirExports(p: string): void {
  mkdirSync(join(p, 'exports'), { recursive: true });
}

describe('self-writing sleeptime step', () => {
  it('is inert without a runner — no units, honest note', async () => {
    seedExports();
    const step = createSelfWritingStep();
    const planned = await step.plan(ctx());
    expect(planned.units).toEqual([]);
    expect(planned.note).toContain('no held-out runner configured');
  });

  it('is in the default pipeline, after induction and before curriculum', () => {
    const ids = defaultSleeptimeSteps().map((s) => s.id);
    expect(ids).toContain('self-writing');
    expect(ids.indexOf('self-writing')).toBeGreaterThan(ids.indexOf('induction'));
    expect(ids.indexOf('self-writing')).toBeLessThan(ids.indexOf('curriculum'));
  });

  it('armed with a runner: plans one unit per undrafted pattern and installs on held-out pass', async () => {
    seedExports();
    const step = createSelfWritingStep({
      runner: (_task, skill) => skill
        ? { success: true, timeMs: 400, costUsd: 0.01 }
        : { success: true, timeMs: 800, costUsd: 0.03 },
      config: { maxPatternsPerPass: 4 },
    });
    const planned = await step.plan(ctx());
    expect(planned.units.length).toBe(1);
    expect(planned.units[0].key).toContain('selfwriting:');
    const outcome = await step.execute(planned.units[0] as PlannedUnit, ctx());
    expect(outcome.detail).toContain('[installed]');
    const names = discoverSkills(join(proj, '.mochi', 'skills')).skills.map((s) => s.name);
    expect(names.length).toBe(1);
    expect(outcome.detail).toContain(names[0]);
  });
});
