// Measured model routing (long-task routing tables).
//
// The loop can change models mid-run in two directions:
//   - at run start, pick the model with the best MEASURED cost-per-solve for
//     this task kind (applyRoutingStart);
//   - after repeated failures, escalate UP the measured ladder (a weaker model
//     never takes over a transcript written by a stronger one).
//
// Both decisions read a table derived from this workspace's own exported
// trajectories — no heuristics about which model "should" be better. A cell
// with fewer than `minSamples` runs is never acted on, and a model that is
// not in the run's candidate pool (primary + configured profiles + same-
// provider failovers) is never chosen.
//
// The table is a snapshot, written by `deriveRoutingTable` (CLI:
// `mochi routing derive`) to `<workspace>/state/routing-table.json`. Loading
// is read-only: a cold start with no table simply keeps the configured model.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import { readTrace } from './trace.js';
import { parseTrajectoryJsonl, type TrajectoryRecord } from './trajectory.js';
import { isSolvedRecord } from './cost-per-solve.js';

export type RoutingTrigger = 'verify_failures' | 'same_failure' | 'complexity_escalation';

/** One (kind, model) evidence cell. */
export interface RoutingCell {
  taskKind: string;
  model: string;
  runs: number;
  solved: number;
  /** solved / runs. */
  solveRate: number;
  /** Summed dollars across runs with cost coverage, reported + estimated. */
  totalCostUsd: number;
  /** totalCostUsd / solved; null when nothing was solved or cost is unknown. */
  costPerSolveUsd: number | null;
  /** True when `runs >= minSamples` at derivation time. */
  sufficient: boolean;
}

export interface RoutingTable {
  version: 1;
  derivedAt: number;
  minSamples: number;
  cells: RoutingCell[];
}

export interface RoutingSettings {
  /** Master switch. Default ON; only acts when a table exists. */
  enabled: boolean;
  /** Minimum runs per cell before it can steer a decision. */
  minSamples: number;
}

export interface RoutingConfigLike {
  enabled?: boolean;
  minSamples?: number;
}

export const DEFAULT_ROUTING_MIN_SAMPLES = 5;
export const MAX_ROUTING_ESCALATIONS_PER_RUN = 2;

/** Resolve config + env. MOCHI_ROUTING=0 disables routing outright. */
export function resolveRoutingSettings(config?: RoutingConfigLike): RoutingSettings {
  const envOff = process.env.MOCHI_ROUTING === '0';
  const minSamplesRaw = config?.minSamples ?? Number(process.env.MOCHI_ROUTING_MIN_SAMPLES);
  const minSamples = Number.isFinite(minSamplesRaw) && (minSamplesRaw as number) > 0
    ? Math.floor(minSamplesRaw as number)
    : DEFAULT_ROUTING_MIN_SAMPLES;
  return {
    enabled: !envOff && (config?.enabled ?? true),
    minSamples,
  };
}

export function routingTablePath(workspaceDir: string): string {
  return join(workspaceDir, 'state', 'routing-table.json');
}

function isCell(raw: unknown): raw is RoutingCell {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return typeof c.taskKind === 'string'
    && typeof c.model === 'string'
    && typeof c.runs === 'number' && Number.isFinite(c.runs)
    && typeof c.solved === 'number' && Number.isFinite(c.solved)
    && typeof c.solveRate === 'number' && Number.isFinite(c.solveRate);
}

/** Load the stored table, or null when absent/corrupt (cold start). */
export function loadRoutingTable(workspaceDir: string): RoutingTable | null {
  const p = routingTablePath(workspaceDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (!Array.isArray(raw.cells)) return null;
    const cells = raw.cells.filter(isCell).map((c) => ({
      ...c,
      totalCostUsd: typeof c.totalCostUsd === 'number' ? c.totalCostUsd : 0,
      costPerSolveUsd: typeof c.costPerSolveUsd === 'number' ? c.costPerSolveUsd : null,
      sufficient: c.sufficient === true,
    }));
    if (cells.length === 0) return null;
    return {
      version: 1,
      derivedAt: typeof raw.derivedAt === 'number' ? raw.derivedAt : 0,
      minSamples: typeof raw.minSamples === 'number' ? raw.minSamples : DEFAULT_ROUTING_MIN_SAMPLES,
      cells,
    };
  } catch {
    return null;
  }
}

/**
 * Derive a routing table from exported trajectories + per-run traces.
 *
 * Attribution rules:
 *   - task kind comes from the trajectory record (`taskKind`);
 *   - the model is the LAST model the run's own trace reports in a
 *     usage:updated entry — the model that actually finished the run;
 *   - solved means the verifier gate said PASS / FLAKY-PASS (cost-per-solve's
 *     isSolvedRecord — never an outcome flag);
 *   - cost sums provider-reported and price-table-estimated dollars ONLY for
 *     runs whose usage carries a figure; a run with neither is counted in
 *     `runs` but contributes no cost, and if it was solved the cell's
 *     cost-per-solve stays honest (null) rather than averaging a partial sum.
 */
export function deriveRoutingTable(
  workspaceDir: string,
  opts?: { minSamples?: number; write?: boolean },
): RoutingTable {
  const minSamples = opts?.minSamples ?? DEFAULT_ROUTING_MIN_SAMPLES;
  const records = readTrajectoryRecords(workspaceDir);
  const acc = new Map<string, { taskKind: string; model: string; runs: number; solved: number; cost: number; anyCost: boolean; costComplete: boolean }>();

  for (const rec of records) {
    const kind = rec.taskKind && rec.taskKind.trim() ? rec.taskKind : 'unknown';
    const model = finalModelForRun(workspaceDir, rec.runId);
    if (!model) continue;
    const key = `${kind}\u0000${model}`;
    const cell = acc.get(key) ?? { taskKind: kind, model, runs: 0, solved: 0, cost: 0, anyCost: false, costComplete: true };
    cell.runs++;
    const solved = isSolvedRecord(rec);
    if (solved) cell.solved++;
    const u = rec.usage;
    if (u) {
      const reported = u.costUsd ?? 0;
      const estimated = u.estimatedCostUsd ?? 0;
      if (reported > 0 || estimated > 0) {
        cell.cost += reported + estimated;
        cell.anyCost = true;
      }
      if (solved && reported === 0 && estimated === 0) cell.costComplete = false;
    } else if (solved) {
      cell.costComplete = false;
    }
    acc.set(key, cell);
  }

  const cells: RoutingCell[] = [...acc.values()]
    .map((c) => ({
      taskKind: c.taskKind,
      model: c.model,
      runs: c.runs,
      solved: c.solved,
      solveRate: c.runs > 0 ? c.solved / c.runs : 0,
      totalCostUsd: round6(c.cost),
      costPerSolveUsd: c.solved > 0 && c.anyCost && c.costComplete ? round6(c.cost / c.solved) : null,
      sufficient: c.runs >= minSamples,
    }))
    .sort((a, b) => a.taskKind.localeCompare(b.taskKind) || a.model.localeCompare(b.model));

  const table: RoutingTable = { version: 1, derivedAt: Date.now(), minSamples, cells };
  if (opts?.write !== false) {
    try {
      atomicWriteFileSync(routingTablePath(workspaceDir), JSON.stringify(table, null, 2));
    } catch {
      /* persistence is best-effort; the caller still gets the table */
    }
  }
  return table;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function readTrajectoryRecords(workspaceDir: string): TrajectoryRecord[] {
  const dir = join(workspaceDir, 'exports');
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('trajectory-') && n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: TrajectoryRecord[] = [];
  for (const name of names) {
    try {
      const text = readFileSync(join(dir, name), 'utf8');
      out.push(...parseTrajectoryJsonl(text));
    } catch {
      /* a corrupt export never poisons the table */
    }
  }
  return out;
}

/** Last model id a run's trace reports, or null when the trace is gone. */
function finalModelForRun(workspaceDir: string, runId: string): string | null {
  let entries;
  try {
    entries = readTrace(workspaceDir, runId);
  } catch {
    return null;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Record<string, unknown>;
    if (e.kind === 'usage:updated' && typeof e.model === 'string' && e.model.trim()) return e.model;
  }
  return null;
}

function inPool(model: string, pool: readonly string[]): boolean {
  if (pool.length === 0) return true;
  return pool.some((p) => p === model || p.toLowerCase() === model.toLowerCase());
}

export interface RoutingChoice {
  model: string;
  cell: RoutingCell;
}

/**
 * Best measured model for a task kind among the candidate pool: lowest
 * expected cost per SOLVE (costPerSolve / solveRate), with solve rate as the
 * tie-break. Only sufficient cells with at least one solve and a known price
 * participate — an unpriced model cannot be shown to be cheaper.
 */
export function chooseStartModel(
  table: RoutingTable,
  taskKind: string,
  pool: readonly string[],
  _overrides?: unknown,
): RoutingChoice | null {
  const candidates = table.cells.filter((c) =>
    c.taskKind === taskKind
    && c.sufficient
    && c.solved > 0
    && c.solveRate > 0
    && c.costPerSolveUsd !== null
    && inPool(c.model, pool));
  if (candidates.length === 0) return null;
  const expected = (c: RoutingCell): number => (c.costPerSolveUsd as number) / Math.max(c.solveRate, 0.05);
  candidates.sort((a, b) => expected(a) - expected(b) || b.solveRate - a.solveRate);
  const cell = candidates[0];
  return { model: cell.model, cell };
}

/**
 * Next model UP the measured ladder: sufficient, in pool, not yet attempted,
 * and measurably better than the current model's cell (when one exists).
 * Highest solve rate wins, then lowest cost-per-solve.
 */
export function chooseEscalationTarget(
  table: RoutingTable,
  taskKind: string,
  currentModel: string,
  pool: readonly string[],
  attempted: ReadonlySet<string>,
  _overrides?: unknown,
): RoutingChoice | null {
  const current = table.cells.find((c) =>
    c.taskKind === taskKind && (c.model === currentModel || c.model.toLowerCase() === currentModel.toLowerCase()));
  const floor = current ? current.solveRate + 0.05 : 0;
  const candidates = table.cells.filter((c) =>
    c.taskKind === taskKind
    && c.sufficient
    && c.solved > 0
    && c.solveRate > floor
    && c.model !== currentModel
    && !attempted.has(c.model)
    && inPool(c.model, pool));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.solveRate - a.solveRate || (a.costPerSolveUsd ?? Infinity) - (b.costPerSolveUsd ?? Infinity));
  const cell = candidates[0];
  return { model: cell.model, cell };
}

/**
 * Why switching to a stronger model is forbidden right now, or null when the
 * run can afford it. Escalation is never silent: the caller emits an event
 * and tells the model when this returns a reason.
 */
export function escalationBudgetBlock(budget?: {
  phase(): string;
  ratio(): number;
  remainingCostUsd(): number;
}): string | null {
  if (!budget) return null;
  const phase = budget.phase();
  if (phase === 'exhausted') return 'the run budget is exhausted';
  const spent = budget.ratio();
  if (Number.isFinite(spent) && spent >= 0.85) {
    return `the run budget is ${Math.min(100, Math.round(spent * 100))}% spent`;
  }
  if (budget.remainingCostUsd() < 0.10) return 'less than $0.10 of run budget remains';
  if (phase === 'cheap' || phase === 'verify') return `the run budget is in its ${phase} phase`;
  return null;
}
