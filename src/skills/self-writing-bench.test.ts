// Self-writing skills bench (item 16 proof metric): repeated-pattern tasks
// with source tasks + a held-out task each, run through the real gate
// pipeline (runSelfWritingPass), with per-pattern verdicts and a negative
// control that MUST be rejected.
//
// Honesty notes (also in the campaign report):
//   - The held-out "runner" is a deterministic simulated executor standing in
//     for the real agent runner (the HeldOutRunner seam). Success is decided
//     ONLY by comparing what the executed procedure produced against the
//     task's declared requirement — never by which pattern the task is from.
//   - The bench asserts the exact verdict table below, so it doubles as a
//     regression test for the adoption metric.
//   - Caps: the bench overrides the default caps (2 drafts / 2 installs per
//     24h) to exercise every pattern in one pass; cap behavior itself is
//     pinned by self-writing.test.ts.
//
// Set MOCHI_SELFWRITING_BENCH_OUT=<path> to emit the machine-readable results
// (the campaign evidence file).
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { argShapeOf } from '../core/tool-sequence.js';
import { runSelfWritingPass, loadProposalLedger, listSelfWrittenSkills, renderSelfWritingListing, type HeldOutRunner } from './self-writing.js';
import { discoverSkills } from './skills.js';
import type { TrajectoryRecord, TrajectoryStep } from '../observability/trajectory.js';

// ─── Bench task fixtures ───────────────────────────────────────────────────

let clock = 1_000;
function step(tool: string, args: unknown, i: number): TrajectoryStep {
  return { index: i, tool, args, argShape: argShapeOf(args), ok: true, outputSnippet: '' };
}
function traj(runId: string, title: string, taskKind: string, steps: Array<[string, unknown]>, endedAt?: number): TrajectoryRecord {
  return {
    schemaVersion: 2, runId, taskKind, verified: true, cost: null,
    startedAt: 1_000_000, endedAt: endedAt ?? ++clock, durationMs: 1_000,
    task: { title },
    steps: steps.map(([tool, args], i) => step(tool, args, i)),
    skills: [],
    verification: { status: 'PASS', verdict: 'pass' },
    outcome: { completed: true, stopReason: 'done' },
    usage: null, failureTaxonomy: [],
  };
}

/** Pattern 1 — regenerate a report: read source, write report, verify. */
const reportSteps = (id: string): Array<[string, unknown]> => [
  ['read_file', { path: `src/data-${id}.csv` }],
  ['write_file', { path: `reports/summary-${id}.txt`, content: `summary of ${id}` }],
  ['run', { cmd: `node verify-report.js summary-${id}.txt` }],
];

/** Pattern 2 — set up a test fixture: init, write config, check. */
const fixtureSteps = (id: string): Array<[string, unknown]> => [
  ['run', { cmd: `init-fixture ${id}` }],
  ['write_file', { path: `fixtures/case-${id}.json`, content: `{"case": ${id}}` }],
  ['run', { cmd: `check-fixture case-${id}.json` }],
];

/** Pattern 3 — NEGATIVE CONTROL: export with a pinned format. The three
 *  source tasks all used --format=csv; the held-out task requires json. The
 *  draft carries the recorded csv invocation verbatim, so following it on the
 *  held-out task produces the wrong artifact. */
const exportSteps = (id: string, format: string): Array<[string, unknown]> => [
  ['list_dir', { path: 'db' }],
  ['write_file', { path: `exports/q-${id}.out`, content: `exported ${id}` }],
  ['run', { cmd: `export-tool --format=${format} out-${id}.bin` }],
];

/** Pattern 5 — NEGATIVE CONTROL (cost side): a trivial task class where the
 *  unaided path is already minimal; loading any skill can only add overhead. */
const trivialSteps = (id: string): Array<[string, unknown]> => [
  ['write_file', { path: `tmp/note-${id}.txt`, content: `note ${id}` }],
  ['run', { cmd: `touch note-${id}.done` }],
  ['read_file', { path: `tmp/note-${id}.txt` }],
];

/** Pattern 6 — a repeated pattern with NO held-out task available. */
const orphanSteps = (id: string): Array<[string, unknown]> => [
  ['edit_file', { path: `cfg/${id}.yaml` }],
  ['run', { cmd: `reload ${id}` }],
  ['read_file', { path: `cfg/${id}.yaml` }],
];

interface BenchTask { kind: string; format: string; trivial?: boolean }

function benchRecords(): { records: TrajectoryRecord[]; requirements: Map<string, BenchTask> } {
  const requirements = new Map<string, BenchTask>();
  const add = (runId: string, title: string, kind: string, steps: Array<[string, unknown]>, req: BenchTask, at: number): TrajectoryRecord => {
    requirements.set(runId, req);
    return traj(runId, title, kind, steps, at);
  };
  const records: TrajectoryRecord[] = [
    // Pattern 1: 3 sources + 1 held-out (report kind)
    add('rep-1', 'Regenerate summary 1', 'report', reportSteps('1'), { kind: 'report', format: 'plain' }, 1),
    add('rep-2', 'Regenerate summary 2', 'report', reportSteps('2'), { kind: 'report', format: 'plain' }, 2),
    add('rep-3', 'Regenerate summary 3', 'report', reportSteps('3'), { kind: 'report', format: 'plain' }, 3),
    add('rep-4', 'Regenerate summary for Q4 (held-out)', 'report', reportSteps('4'), { kind: 'report', format: 'plain' }, 4),
    // Pattern 2: 3 sources + 1 held-out (fixture kind)
    ...[5, 6, 7].map((n) => add(`fix-${n}`, `Set up fixture ${n}`, 'fixture', fixtureSteps(String(n)), { kind: 'fixture', format: 'plain' }, n)),
    add('fix-8', 'Set up fixture 8 (held-out)', 'fixture', fixtureSteps('8'), { kind: 'fixture', format: 'plain' }, 8),
    // Pattern 3: sources pin csv; held-out requires json
    ...[9, 10, 11].map((n) => add(`exp-${n}`, `Export dataset ${n} (csv)`, 'export', exportSteps(String(n), 'csv'), { kind: 'export', format: 'csv' }, n)),
    add('exp-12', 'Export dataset 12 as JSON (held-out)', 'export', exportSteps('12', 'json'), { kind: 'export', format: 'json' }, 12),
    // Pattern 4: prompt-artifact echo — only TWO distinct tasks share this
    // sequence; it must NOT be drafted at all.
    add('echo-1', 'Echo protocol alpha', 'echo', [['edit_file', { path: 'a' }], ['run', { cmd: 'b' }], ['run', { cmd: 'c' }]], { kind: 'echo', format: 'plain' }, 13),
    add('echo-2', 'Echo protocol beta', 'echo', [['edit_file', { path: 'd' }], ['run', { cmd: 'e' }], ['run', { cmd: 'f' }]], { kind: 'echo', format: 'plain' }, 14),
    // Pattern 5: trivial kind — skill can only add overhead
    ...[15, 16, 17].map((n) => add(`tri-${n}`, `Trivial note ${n}`, 'trivial', trivialSteps(String(n)), { kind: 'trivial', format: 'plain', trivial: true }, n)),
    add('tri-18', 'Trivial note 18 (held-out)', 'trivial', trivialSteps('18'), { kind: 'trivial', format: 'plain', trivial: true }, 18),
    // Pattern 6: orphan kind — no held-out task exists
    ...[19, 20, 21].map((n) => add(`orp-${n}`, `Orphan reload ${n}`, 'orphan', orphanSteps(String(n)), { kind: 'orphan', format: 'plain' }, n)),
  ];
  return { records, requirements };
}

// ─── The simulated held-out runner ─────────────────────────────────────────

const COSTS = {
  readSkillMs: 80, readSkillUsd: 0.003,
  produceMs: 300, produceUsd: 0.010,
  verifyMs: 100, verifyUsd: 0.003,
  exploreMs: 200, exploreUsd: 0.008, // ×2 when unaided
};

/** Deterministic simulated executor. Rules (identical for every pattern):
 *  - skill-off: explore ×2, produce, verify. Success = the agent solved it
 *    (bench premise: these tasks are solvable unaided). Trivial kinds skip
 *    exploration.
 *  - skill-on: read the skill, follow its recorded procedure adapted to the
 *    task, verify. Success fails ONLY when the skill's recorded procedure
 *    contradicts the task's declared requirement (a pinned --format that
 *    mismatches, detected in the skill text — the same way a real agent
 *    would copy the recorded invocation). */
function makeBenchRunner(requirements: Map<string, BenchTask>): HeldOutRunner {
  return (task, skill) => {
    const req = requirements.get(task.runId);
    if (!req) return { success: false, timeMs: 0, costUsd: 0, notes: 'no requirement registered (bench bug)' };
    if (!skill) {
      const explores = req.trivial ? 0 : 2;
      return {
        success: true,
        timeMs: explores * COSTS.exploreMs + COSTS.produceMs + COSTS.verifyMs,
        costUsd: +(explores * COSTS.exploreUsd + COSTS.produceUsd + COSTS.verifyUsd).toFixed(4),
        notes: req.trivial ? 'solved unaided (trivial: no exploration)' : 'solved unaided (explored, produced, verified)',
      };
    }
    // What does the skill's recorded procedure pin? (Example invocations are
    // quoted verbatim in the draft body's Procedure section.)
    const pinnedFormat = /--format=([a-z0-9]+)/.exec(skill.body)?.[1];
    const contradicts = pinnedFormat !== undefined && pinnedFormat !== req.format;
    const timeMs = COSTS.readSkillMs + COSTS.produceMs + COSTS.verifyMs; // 480
    const costUsd = +(COSTS.readSkillUsd + COSTS.produceUsd + COSTS.verifyUsd).toFixed(4); // 0.016
    if (contradicts) {
      return {
        success: false, timeMs, costUsd,
        notes: `skill pins --format=${pinnedFormat} but task ${task.runId} requires --format=${req.format} — following the skill produced the wrong artifact`,
      };
    }
    return { success: true, timeMs, costUsd, notes: 'followed the skill procedure (adapted), verified' };
  };
}

// ─── The bench ─────────────────────────────────────────────────────────────

const BENCH_CONFIG = { minSupport: 3, minSteps: 3, maxDraftsPerWindow: 8, maxInstallsPerWindow: 8, maxPatternsPerPass: 8, windowMs: 24 * 3600_000 };

describe('self-writing skills bench (3+ patterns, negative controls)', () => {
  it('runs the full gate pipeline and produces the verdict table', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'mchi-selfwriting-bench-'));
    try {
      const { records, requirements } = benchRecords();
      const t0 = Date.now();
      const out = await runSelfWritingPass(proj, {
        records, runner: makeBenchRunner(requirements), config: BENCH_CONFIG, skipCatalogDedup: true,
      });
      const passMs = Date.now() - t0;

      // Detection: 5 patterns qualify (support ≥3); the echo (2 tasks) does not.
      expect(out.patternsDetected).toBe(5);
      expect(out.recordsScanned).toBe(21);

      const byKind = (kind: string) => loadProposalLedger(proj).find((p) => p.pattern.taskKinds.includes(kind));
      const pReport = byKind('report');
      const pFixture = byKind('fixture');
      const pExport = byKind('export');
      const pTrivial = byKind('trivial');
      const pOrphan = byKind('orphan');

      // Pattern 1 (report): drafted, held-out PASS faster/cheaper → INSTALLED.
      expect(pReport?.status).toBe('installed');
      expect(pReport?.evaluation?.skillOn.success).toBe(true);
      expect(pReport?.evaluation?.skillOff.success).toBe(true);
      expect(pReport?.evaluation?.skillOn.timeMs).toBeLessThan(pReport!.evaluation!.skillOff.timeMs);
      expect(pReport?.evaluation?.heldOutRunId).toBe('rep-4');
      expect(pReport?.pattern.additionalVerifiedOccurrences).toBe(1);

      // Pattern 2 (fixture): drafted, held-out PASS → INSTALLED.
      expect(pFixture?.status).toBe('installed');
      expect(pFixture?.evaluation?.heldOutRunId).toBe('fix-8');

      // Pattern 3 (export): NEGATIVE CONTROL — held-out FAILS with the skill,
      // skill-off succeeds → REJECTED, not installed.
      expect(pExport?.status).toBe('rejected');
      expect(pExport?.evaluation?.skillOn.success).toBe(false);
      expect(pExport?.evaluation?.skillOff.success).toBe(true);
      expect(pExport?.reason).toContain('held-out gate failed');
      expect(existsSync(pExport!.draftPath)).toBe(true);
      expect(discoveredNames(proj)).not.toContain(pExport!.name);

      // Pattern 5 (trivial): NEGATIVE CONTROL — succeeds but is slower/costlier
      // than skill-off → REJECTED (time regression), not installed.
      expect(pTrivial?.status).toBe('rejected');
      expect(pTrivial?.evaluation?.skillOn.success).toBe(true);
      expect(pTrivial?.evaluation?.skillOn.timeMs).toBeGreaterThan(pTrivial!.evaluation!.skillOff.timeMs);
      expect(pTrivial?.reason).toContain('time regression');

      // Pattern 6 (orphan): drafted but no held-out task exists → REJECTED.
      expect(pOrphan?.status).toBe('rejected');
      expect(pOrphan?.reason).toContain('no held-out task');

      // Adoption: 5 drafts produced (report, fixture, export, trivial,
      // orphan), 2 installed; the echo (2 tasks < 3) was never drafted.
      const ledger = loadProposalLedger(proj);
      const drafted = ledger.length;
      const installed = ledger.filter((p) => p.status === 'installed').length;
      expect(drafted).toBe(5);
      expect(installed).toBe(2);
      expect(ledger.filter((p) => p.status === 'rejected').length).toBe(3);

      // Emit machine-readable evidence when asked.
      if (process.env.MOCHI_SELFWRITING_BENCH_OUT) {
        const rows = ledger.map((p) => ({
          pattern: p.pattern.spine.join(' → '),
          taskKinds: p.pattern.taskKinds,
          sourceTasks: p.pattern.sourceRunIds,
          heldOutTask: p.evaluation?.heldOutRunId ?? null,
          drafted: true,
          skillOn: p.evaluation ? { success: p.evaluation.skillOn.success, timeMs: p.evaluation.skillOn.timeMs, costUsd: p.evaluation.skillOn.costUsd } : null,
          skillOff: p.evaluation ? { success: p.evaluation.skillOff.success, timeMs: p.evaluation.skillOff.timeMs, costUsd: p.evaluation.skillOff.costUsd } : null,
          verdict: p.status,
          reason: p.reason ?? null,
          note: p.pattern.additionalVerifiedOccurrences
            ? `${p.pattern.additionalVerifiedOccurrences} later verified task(s) kept held-out`
            : undefined,
        }));
        const evidence = {
          generatedAt: new Date().toISOString(),
          config: BENCH_CONFIG,
          recordsScanned: out.recordsScanned,
          patternsDetected: out.patternsDetected,
          notDrafted: [{
            pattern: 'edit_file → run → run',
            taskKinds: ['echo'],
            sourceTasks: ['echo-1', 'echo-2'],
            drafted: false,
            verdict: 'not-drafted',
            reason: 'evidence gate: only 2 distinct source tasks (needs ≥3) — the "pattern" only looks repeated because the two tasks share a prompt artifact',
          }],
          rows,
          adoptionRate: { drafted, installed, rate: `${installed}/${drafted}` },
          curatorCost: { ...out.cost, benchPassMs: passMs },
          caps: out.caps,
          listing: renderSelfWritingListing(listSelfWrittenSkills(proj)),
          honestyNotes: [
            'held-out runner is a deterministic simulated executor behind the HeldOutRunner seam; a real agent runner plugs into the same seam',
            'success is decided only against the task requirement, never against pattern membership',
            'bench overrides the default caps (2 drafts / 2 installs per 24h) to cover all patterns in one pass; caps are pinned separately by unit tests',
            'two negative controls: export-format (skill hurts the held-out task) and trivial-fast (skill adds pure overhead)',
          ],
        };
        mkdirSync(dirname(process.env.MOCHI_SELFWRITING_BENCH_OUT), { recursive: true });
        writeFileSync(process.env.MOCHI_SELFWRITING_BENCH_OUT, JSON.stringify(evidence, null, 2), 'utf8');
      }
      console.log(`\n=== self-writing bench ===\n${renderSelfWritingListing(listSelfWrittenSkills(proj))}\ncurator pass: ${out.cost.durationMs}ms wall, 0 model tokens (bench total ${passMs}ms)\n`);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

function discoveredNames(proj: string): string[] {
  return discoverSkills(join(proj, '.mochi', 'skills')).skills.map((s) => s.name);
}
