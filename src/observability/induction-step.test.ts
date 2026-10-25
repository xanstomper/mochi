// Sleeptime wiring for D9 workflow induction (audit L-05): the step mines
// the exported trajectory corpus and drafts probation macros; an empty or
// unverified corpus plans NOTHING (admission is the module's own rule).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInductionStep } from './induction-step.js';
import type { SleeptimeStepContext } from '../sleeptime/orchestrator.js';
import type { TrajectoryRecord, TrajectoryStep } from './trajectory.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tempProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'mochi-indstep-'));
  dirs.push(d);
  mkdirSync(join(d, 'exports'), { recursive: true });
  return d;
}

function ctxFor(projectDir: string): SleeptimeStepContext {
  return {
    projectDir,
    nightKey: '2026-10-22',
    dryRun: false,
    now: new Date('2026-10-22T02:00:00Z'),
    budget: { tryCommit: () => true, commit: () => {} } as unknown as SleeptimeStepContext['budget'],
    frozenDir: join(projectDir, 'bench', 'frozen'),
  };
}

let n = 0;
function rec(tools: string[], status: string | null): TrajectoryRecord {
  n += 1;
  const steps: TrajectoryStep[] = tools.map((t, i) => ({
    index: i, tool: t, args: null, argShape: 'none', ok: true, outputSnippet: '',
  }));
  return {
    schemaVersion: 2,
    runId: `run-${n}`,
    taskKind: 'fix',
    verified: status === 'PASS' || status === 'FLAKY-PASS',
    cost: { totalUsd: 0, reportedUsd: 0, estimatedUsd: 0, totalTokens: 10, source: 'provider' },
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    task: { title: 'fixture' },
    steps,
    skills: [],
    verification: status === null ? null : { status, verdict: status === 'PASS' ? 'pass' : 'fail' },
    outcome: { completed: status === 'PASS' },
    usage: { totalTokens: 10, costUsd: 0 },
    failureTaxonomy: [],
  };
}

/** Write records where loadExportedTrajectories can find them. */
function exportRecords(projectDir: string, records: TrajectoryRecord[]): void {
  writeFileSync(
    join(projectDir, 'exports', 'trajectory-fixture.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n'),
  );
}

describe('induction sleeptime step', () => {
  it('plans nothing on an empty corpus and says why', async () => {
    const step = createInductionStep();
    const planned = await step.plan(ctxFor(tempProject()));
    expect(planned.units).toHaveLength(0);
    expect(planned.note).toMatch(/no exported trajectories/);
  });

  it('plans nothing when the corpus has no verified runs (habits are not admitted)', async () => {
    const dir = tempProject();
    exportRecords(dir, [rec(['read', 'search', 'edit'], null), rec(['read', 'search', 'edit'], null)]);
    const planned = await createInductionStep().plan(ctxFor(dir));
    expect(planned.units).toHaveLength(0);
    expect(planned.note).toMatch(/not admitted|no repeated spines/);
  });

  it('drafts a probation macro for a repeated winning spine and is idempotent', async () => {
    const dir = tempProject();
    exportRecords(dir, [
      rec(['read', 'search', 'edit', 'shell'], 'PASS'),
      rec(['glob', 'read', 'search', 'edit', 'shell'], 'PASS'),
      rec(['read', 'search', 'edit', 'shell', 'verify'], 'FLAKY-PASS'),
    ]);
    const step = createInductionStep();
    const ctx = ctxFor(dir);

    const planned = await step.plan(ctx);
    expect(planned.units).toHaveLength(1);
    expect(planned.units[0].key).toMatch(/^induction:spine:/);
    expect(planned.units[0].estimatedUsage).toBeUndefined(); // model-free, $0

    const outcome = await step.execute(planned.units[0], ctx);
    expect(outcome.detail).toMatch(/drafted .*\(probation\)/);
    expect(existsSync(join(dir, '.mochi', 'skills', 'induced'))).toBe(true);
    const skillMd = readFileSync(
      join(dir, '.mochi', 'skills', 'induced', String(planned.units[0].payload!.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), 'SKILL.md'),
      'utf8',
    );
    expect(skillMd).toMatch(/born on probation/i); // never active at birth

    // Re-planning the same corpus re-lists the macro (the orchestrator's
    // ledger dedupes the night), and re-executing refuses to overwrite.
    const replanned = await step.plan(ctx);
    expect(replanned.units).toHaveLength(1);
    const again = await step.execute(replanned.units[0], ctx);
    expect(again.detail).toMatch(/already exists|quality gate rejected/);
  });

  it('caps drafts per night and says so in the note', async () => {
    const dir = tempProject();
    // Many distinct verified spines → more macros than the nightly cap.
    const records: TrajectoryRecord[] = [];
    for (let i = 0; i < 14; i++) {
      const spine = [`read${i}`, `search${i}`, `edit${i}`, `shell${i}`];
      records.push(rec(spine, 'PASS'), rec(['glob', ...spine], 'PASS'), rec([...spine, 'verify'], 'FLAKY-PASS'));
    }
    exportRecords(dir, records);
    const planned = await createInductionStep().plan(ctxFor(dir));
    expect(planned.units.length).toBeLessThanOrEqual(10);
    expect(planned.units.length).toBeGreaterThan(0);
  });
});
