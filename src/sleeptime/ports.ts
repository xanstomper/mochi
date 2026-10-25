// Real ports for the sleep-time pipeline (D11 wiring, audit L-01).
//
// The orchestrator was written against small port interfaces so the pipeline
// could land before the D8/D10 engines did. It shipped with a STUB repair port
// (labelled as such in every report) and a no-op curriculum port, and
// `src/sleeptime/cli.ts` never injected anything else — so the nightly
// pipeline's two most valuable steps did nothing in production. This module is
// the missing adapter layer:
//
//   repair      → src/skills/skill-repair.ts (D8): demoted skills are patched
//                 from their own failure trajectories and ALWAYS re-enter via
//                 probation (promotion still requires gate passes + doctor).
//   curriculum  → src/curriculum/curriculum.ts (D10): a validated practice task
//                 is generated from a file touched by a FAILING exported run.
//                 Validation = baseline green, mutation red, restore green, in
//                 a scratch copy; nothing in the real tree is mutated.
//
// Both ports are model-free and cost $0; the curriculum port runs test suites,
// which is why the orchestrator's wall-clock budget exists. Neither port may
// throw for an ordinary negative outcome: a refusal is data, not a crash.
//
// Selection rules for curriculum candidates are deliberately narrow:
//   - only files touched by a run whose verifier verdict FAILED/PARTIAL/BLOCKED;
//   - only source files that still exist and are inside the repo;
//   - never test files, generated trees, or the scratch copy itself;
//   - at most `CURRICULUM_PLAN_CAP` per night, newest failure first.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  attemptSkillRepair,
  loadExportedTrajectories,
} from '../skills/skill-repair.js';
import { loadSkillUsage } from '../skills/skills.js';
import {
  CurriculumError,
  generateCurriculumTask,
  saveCurriculumTask,
} from '../curriculum/curriculum.js';
import { detectTestCommand } from '../health/health-scan.js';
import type { TrajectoryRecord } from '../observability/trajectory.js';
import type {
  CurriculumPort,
  CurriculumTaskSpec,
  RepairCandidate,
  SkillRepairPort,
  SleeptimeStepContext,
  UnitOutcome,
} from './orchestrator.js';

/** Hard cap on practice tasks planned per night (the step may cap lower). */
export const CURRICULUM_PLAN_CAP = 3;
/** Only failures this recent may seed a practice task. */
export const CURRICULUM_MAX_AGE_DAYS = 14;

const FAILING_VERDICTS: ReadonlySet<string> = new Set(['FAIL', 'PARTIAL', 'BLOCKED']);
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|c|cc|cpp|cs)$/;
const NON_SOURCE_DIR = /(?:^|[/\\])(?:node_modules|dist|build|out|target|vendor|coverage|\.git|\.mochi|tests?|__tests__|__mocks__|fixtures?|testdata)(?:[/\\]|$)/i;
const TEST_FILE = /(?:\.(?:test|spec)\.|(?:^|[/\\])test_[^/\\]+\.py$)/i;

/** Demoted skills, oldest demotion first (the longest-waiting repair runs first). */
export function createRealSkillRepairPort(): SkillRepairPort {
  return {
    emptyNote: () => 'no demoted skills — nothing to repair (skill usage shows none in the demoted state)',
    listCandidates(projectDir: string): RepairCandidate[] {
      const usage = loadSkillUsage(projectDir);
      const out: RepairCandidate[] = [];
      for (const [name, rec] of usage) {
        if (rec.state !== 'demoted') continue;
        out.push({
          name,
          reason: rec.lastDemotionReason?.trim() || 'demoted by the evidence lifecycle (no reason recorded)',
          ...(typeof rec.stateAt === 'number' ? { stateAt: rec.stateAt } : {}),
        });
      }
      out.sort((a, b) => (a.stateAt ?? 0) - (b.stateAt ?? 0) || a.name.localeCompare(b.name));
      return out;
    },

    repairOne(projectDir: string, candidate: RepairCandidate, _ctx: SleeptimeStepContext): UnitOutcome {
      // D8 owns the patch: failure evidence comes from this skill's own
      // failing exported runs, never from a generic repo failure.
      const trajectories = loadExportedTrajectories(projectDir);
      const result = attemptSkillRepair(projectDir, candidate.name, trajectories);
      if (result.status === 'failed') {
        // A genuine write/patch failure must fail the unit so the morning
        // report surfaces it — a refusal is a legitimate outcome instead.
        throw new Error(`repair of '${candidate.name}' failed: ${result.reason}`);
      }
      const detail = result.status === 'repaired'
        ? `repaired '${result.skillName}' (attempt ${result.attempt ?? '?'} of ${result.repairAttempts}, `
          + `evidence runs: ${result.evidenceRuns}); re-entered probation — promotion still requires gate passes + doctor`
        : `repair refused for '${result.skillName}': ${result.reason}`;
      return { detail };
    },
  };
}

/** A candidate practice-task seed: one source file from a failing run. */
export interface CurriculumCandidate {
  /** Repo-relative POSIX path; doubles as the task id. */
  file: string;
  title: string;
  runId: string;
  /** When the failing run ended (ms epoch), for ordering. */
  endedAt: number;
}

function insideRepo(repoRoot: string, abs: string): string | null {
  const rel = relative(repoRoot, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Path-like strings in a tool call's args (write/edit/patch family). */
function pathsInArgs(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['path', 'file', 'filePath', 'filename', 'target']) {
    const v = a[key];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  for (const key of ['paths', 'files']) {
    const v = a[key];
    if (Array.isArray(v)) for (const p of v) if (typeof p === 'string' && p.trim()) out.push(p.trim());
  }
  return out;
}

function isTestPath(repoRel: string): boolean {
  return TEST_FILE.test(repoRel) || NON_SOURCE_DIR.test(repoRel);
}

/**
 * Seeds for tonight's practice tasks: source files touched by a FAILING
 * exported run, newest failure first, deduped by file. Pure (no writes), so
 * it is directly testable and cheap enough to run at plan time.
 */
export function deriveCurriculumCandidates(
  projectDir: string,
  opts: { now?: number; maxAgeDays?: number; cap?: number } = {},
): CurriculumCandidate[] {
  const now = opts.now ?? Date.now();
  const maxAgeMs = Math.max(1, opts.maxAgeDays ?? CURRICULUM_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const cap = Math.max(1, opts.cap ?? CURRICULUM_PLAN_CAP);
  let records: TrajectoryRecord[];
  try {
    records = loadExportedTrajectories(projectDir);
  } catch {
    return [];
  }
  const failing = records.filter((rec) => {
    const verdict = rec.verification?.verdict ?? (rec.verification?.status ?? '');
    if (!FAILING_VERDICTS.has(String(verdict))) return false;
    const ended = rec.endedAt ?? rec.startedAt ?? 0;
    return ended === 0 || now - ended <= maxAgeMs;
  });
  failing.sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0));

  const seen = new Set<string>();
  const out: CurriculumCandidate[] = [];
  for (const rec of failing) {
    for (const step of rec.steps ?? []) {
      if (!step.ok && step.tool && !/^(write|edit|patch|apply_patch|replace_symbol|move_file)$/.test(step.tool)) continue;
      for (const raw of pathsInArgs(step.args)) {
        const abs = resolve(projectDir, raw);
        if (!existsSync(abs)) continue;
        try {
          if (!statSync(abs).isFile()) continue;
        } catch {
          continue;
        }
        const rel = insideRepo(projectDir, abs);
        if (!rel || !SOURCE_EXT.test(rel) || isTestPath(rel)) continue;
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push({
          file: rel,
          title: `Practice: fix a regression in ${rel}`,
          runId: rec.runId,
          endedAt: rec.endedAt ?? rec.startedAt ?? 0,
        });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

/**
 * D10 curriculum port: plan seeds from failing runs; generate one validated
 * task per unit into `.mochi/curriculum/`. Generation copies the repo to a
 * scratch dir, so the working tree is never mutated and a failure leaves no
 * half-written task behind.
 */
export function createRealCurriculumPort(): CurriculumPort {
  return {
    emptyNote: () => 'no curriculum tasks planned — needs a test command plus a recent FAILING exported run (see .mochi/exports)',
    planTasks(projectDir: string, ctx: SleeptimeStepContext): CurriculumTaskSpec[] {
      const runner = detectTestCommand(projectDir);
      if (!runner) return [];
      return deriveCurriculumCandidates(projectDir, { now: ctx.now.getTime() }).map((c) => ({
        id: c.file,
        title: `${c.title} (seed run ${c.runId})`,
        // Local compute only: no model call, no provider spend. The
        // orchestrator still charges the unit's estimate, which defaults to
        // zero for an excluded estimate.
        estimatedCostUsd: 0,
      }));
    },

    async generateOne(projectDir: string, task: CurriculumTaskSpec, _ctx: SleeptimeStepContext): Promise<UnitOutcome> {
      const file = task.id.trim();
      if (!file || isAbsolute(file) || file.split(/[/\\]/).includes('..')) {
        throw new Error(`curriculum unit '${task.id}' is not a repo-relative source path`);
      }
      const runner = detectTestCommand(projectDir);
      if (!runner) return { detail: `no test command detected for ${projectDir} — cannot validate a practice task` };
      try {
        const generated = await generateCurriculumTask({
          repoRoot: projectDir,
          sourceFile: file,
          testCommand: runner.cmd,
        });
        const outDir = resolve(projectDir, '.mochi', 'curriculum');
        const path = saveCurriculumTask(generated, outDir);
        return {
          detail: `generated validated practice task ${generated.id} from ${file} (${runner.cmd}) → ${path}`,
          actualCostUsd: 0,
        };
      } catch (e) {
        // 'no-flip' is an ordinary property of a boring file: report, don't fail.
        if (e instanceof CurriculumError && e.code === 'no-flip') {
          return { detail: `${file}: no flippable operator — skipped` };
        }
        throw e;
      }
    },
  };
}
