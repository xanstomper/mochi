// Cost-per-solve routing table (B22): the measured counterpart to the model
// router's static tiers. The router knows what models COST per token; this
// table knows what they cost PER SOLVED TASK, per task kind, computed from
// the run traces the harness already records — total recorded cost of every
// run that STARTED on a model (failures burn money too; that spend is the
// point of the metric) divided by the runs the verifier actually passed.
// Same convention as the regression gate's costPerSolve().
//
// Honesty rules (the C5 standard, applied to routing):
//  - a cell's dollar figure exists only when at least one run SOLVED and
//    every solved run's cost coverage is complete; a solved run that cannot
//    be priced refuses the figure (null), never a flattering partial sum.
//    (Unsolved runs with incomplete coverage still count as runs — their
//    solve outcome is known — but contribute no dollars, and the cell is
//    flagged costIncomplete so nobody mistakes the total for the full spend.)
//  - a cell below the sample threshold is INSUFFICIENT-DATA: it is stored
//    and shown, but the policy functions below never route on it. Routing on
//    three lucky runs is guessing with extra steps.
//  - an unpriced model (price table resolves null) can hold a cell — its
//    provider may report real costs — but is never an escalation TARGET and
//    never a start candidate unless its cell carries a measured figure:
//    you cannot claim a cost win for a model you cannot price.
//  - runs are attributed to their STARTING model (the first usage record's
//    model, owner-agent filtered like buildTrajectory's attribution): the
//    start is the decision routing controls, and escalation spend lands in
//    the starter's cell — which is correct, because "start cheap, escalate
//    on evidence" must be judged on its TOTAL cost, escalation included.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTrajectory } from './trajectory.js';
import { costFromTraceEntries } from './trace-cost.js';
import { resolvePrice, type PriceOverrides } from '../pricing.js';
import type { TraceEntry } from './trace.js';
import type { RoutingConfig } from '../types.js';

/** Workspace-state path (relative to the .mochi dir) of the stored table. */
export const ROUTING_TABLE_STATE_PATH = 'state/routing-table.json';

/** Default minimum runs per (kind × model) cell before the cell may steer
 *  routing. Below this the cell is INSUFFICIENT-DATA — visible, never used. */
export const DEFAULT_MIN_ROUTING_SAMPLES = 5;

/** Hard cap on routing escalations within one run: the ladder is finite and
 *  every escalation must be bought with FRESH failure evidence (the loop
 *  resets its streak counters on each escalation), but a pathological ladder
 *  must not turn a failing run into a model tour. */
export const MAX_ROUTING_ESCALATIONS_PER_RUN = 3;

/** Evidence classes that may trigger a routing escalation. Nothing else —
 *  notably not elapsed time, not token counts, not vibes. */
export type RoutingTrigger = 'verify_failures' | 'same_failure' | 'complexity_escalation';

export const ROUTING_TRIGGERS: readonly RoutingTrigger[] = [
  'verify_failures',
  'same_failure',
  'complexity_escalation',
];

export interface RoutingCell {
  kind: string;
  model: string;
  /** Runs attributed to this cell (started on `model` for `kind`). */
  runs: number;
  /** Runs the verifier passed (PASS / FLAKY-PASS — cost-per-solve's word). */
  solvedRuns: number;
  /** Total recorded $ across ALL runs in the cell (provider + estimated,
   *  summed only after each run's own coverage check — see header). */
  totalCostUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  /** totalCostUsd / solvedRuns; null when nothing solved, or when any
   *  SOLVED run's cost coverage was incomplete (refusal, not a guess). */
  costPerSolveUsd: number | null;
  solveRate: number;
  /** Runs that used more than one model (any escalation/failover switch). */
  escalatedRuns: number;
  /** routing:escalated events recorded inside this cell's runs. */
  routingEscalations: number;
  /** Escalation events by trigger, as recorded in the traces. */
  triggers: Partial<Record<RoutingTrigger, number>>;
  /** runs >= the table's minSamples. INSUFFICIENT-DATA when false. */
  sufficient: boolean;
  /** The price table can price this model id (resolvePrice non-null). */
  priced: boolean;
  /** Some run in the cell had incomplete cost coverage; totals understate
   *  the true spend by an unknown amount. */
  costIncomplete: boolean;
}

export interface RoutingTable {
  version: 1;
  /** Unix ms when this table was derived. */
  derivedAt: number;
  minSamples: number;
  /** Trace files that yielded an attributable run. */
  runsConsidered: number;
  /** Trace files skipped (no usage records → no starting model). */
  runsSkipped: number;
  cells: RoutingCell[];
}

// ─── Per-run fact extraction ─────────────────────────────────────────────

export interface RunRoutingFacts {
  runId: string;
  kind: string;
  startModel: string;
  modelsUsed: string[];
  verified: boolean;
  /** Effective run cost; null when coverage is incomplete or no usage. */
  costUsd: number | null;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  routingEscalations: number;
  triggers: Partial<Record<RoutingTrigger, number>>;
}

function isTrigger(v: unknown): v is RoutingTrigger {
  return typeof v === 'string' && (ROUTING_TRIGGERS as readonly string[]).includes(v);
}

/** Fold one run's trace entries into routing facts. Returns null when the
 *  trace carries no usage records at all (no model ever billed → nothing to
 *  attribute). Kind and verdict come from buildTrajectory (the loop's own
 *  attribution entry), cost from costFromTraceEntries — the same joins every
 *  other consumer uses, so the table can never disagree with the exports. */
export function extractRunRoutingFacts(entries: readonly TraceEntry[], runId: string): RunRoutingFacts | null {
  // Owner agent: subagent finishes share the bus, and a child's calls must
  // not be attributed to the parent run (buildTrajectory's rule, same here).
  const started = entries.find((e) => e.kind === 'task:started');
  const owner = typeof started?.agentId === 'string' ? started.agentId : undefined;
  const own = (e: TraceEntry): boolean => !owner || typeof e.agentId !== 'string' || e.agentId === owner;

  const modelsUsed: string[] = [];
  let sawUsage = false;
  const noteModel = (m: unknown): void => {
    if (typeof m !== 'string' || !m) return;
    sawUsage = true;
    if (!modelsUsed.includes(m)) modelsUsed.push(m);
  };
  const triggers: Partial<Record<RoutingTrigger, number>> = {};
  let routingEscalations = 0;
  for (const e of entries) {
    if (e.kind === 'usage:updated' && own(e)) noteModel(e.model);
    const nested = e.usage;
    if (nested && typeof nested === 'object' && own(e)) {
      const u = nested as Record<string, unknown>;
      noteModel(typeof e.model === 'string' ? e.model : u.model);
    }
    if (e.kind === 'routing:escalated' && own(e)) {
      routingEscalations++;
      if (isTrigger(e.trigger)) triggers[e.trigger] = (triggers[e.trigger] ?? 0) + 1;
    }
  }
  if (!sawUsage || modelsUsed.length === 0) return null;

  const record = buildTrajectory(entries as TraceEntry[], { runId });
  const cost = costFromTraceEntries(entries as unknown as Array<Record<string, unknown>>);
  return {
    runId,
    kind: record.taskKind ?? 'unknown',
    startModel: modelsUsed[0],
    modelsUsed,
    verified: record.verified === true,
    costUsd: cost.effectiveCostUsd,
    reportedCostUsd: cost.providerCostUsd,
    estimatedCostUsd: cost.estimatedCostUsd,
    routingEscalations,
    triggers,
  };
}

// ─── Stats pass ──────────────────────────────────────────────────────────

function roundUsd(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/** Pure aggregation: run facts → routing table. Deterministic cell order
 *  (kind, then cost-per-solve with nulls last, then model id). */
export function computeRoutingTableFromFacts(
  facts: readonly RunRoutingFacts[],
  opts: { minSamples?: number; pricing?: PriceOverrides; now?: number; runsSkipped?: number } = {},
): RoutingTable {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_ROUTING_SAMPLES;
  const byCell = new Map<string, {
    kind: string; model: string; runs: number; solvedRuns: number;
    total: number; reported: number; estimated: number;
    solvedUnpriced: boolean; costIncomplete: boolean;
    escalatedRuns: number; routingEscalations: number;
    triggers: Partial<Record<RoutingTrigger, number>>;
  }>();
  for (const f of facts) {
    const key = `${f.kind}\u0000${f.startModel}`;
    let c = byCell.get(key);
    if (!c) {
      c = {
        kind: f.kind, model: f.startModel, runs: 0, solvedRuns: 0,
        total: 0, reported: 0, estimated: 0,
        solvedUnpriced: false, costIncomplete: false,
        escalatedRuns: 0, routingEscalations: 0, triggers: {},
      };
      byCell.set(key, c);
    }
    c.runs++;
    if (f.verified) {
      c.solvedRuns++;
      if (f.costUsd === null) c.solvedUnpriced = true;
    }
    if (f.costUsd === null) c.costIncomplete = true;
    else {
      c.total += f.costUsd;
      c.reported += f.reportedCostUsd;
      c.estimated += f.estimatedCostUsd;
    }
    if (f.modelsUsed.length > 1) c.escalatedRuns++;
    c.routingEscalations += f.routingEscalations;
    for (const [t, n] of Object.entries(f.triggers)) {
      const k = t as RoutingTrigger;
      c.triggers[k] = (c.triggers[k] ?? 0) + (n ?? 0);
    }
  }
  const cells: RoutingCell[] = [...byCell.values()].map((c) => ({
    kind: c.kind,
    model: c.model,
    runs: c.runs,
    solvedRuns: c.solvedRuns,
    totalCostUsd: roundUsd(c.total),
    reportedCostUsd: roundUsd(c.reported),
    estimatedCostUsd: roundUsd(c.estimated),
    costPerSolveUsd: c.solvedRuns > 0 && !c.solvedUnpriced ? roundUsd(c.total / c.solvedRuns) : null,
    solveRate: c.runs > 0 ? c.solvedRuns / c.runs : 0,
    escalatedRuns: c.escalatedRuns,
    routingEscalations: c.routingEscalations,
    triggers: c.triggers,
    sufficient: c.runs >= minSamples,
    priced: resolvePrice(c.model, opts.pricing) !== null,
    costIncomplete: c.costIncomplete,
  }));
  cells.sort((a, b) =>
    a.kind.localeCompare(b.kind)
    || (a.costPerSolveUsd === null ? 1 : 0) - (b.costPerSolveUsd === null ? 1 : 0)
    || (a.costPerSolveUsd ?? 0) - (b.costPerSolveUsd ?? 0)
    || a.model.localeCompare(b.model));
  return {
    version: 1,
    derivedAt: opts.now ?? Date.now(),
    minSamples,
    runsConsidered: facts.length,
    runsSkipped: opts.runsSkipped ?? 0,
    cells,
  };
}

/** Read every trace under <stateDir>/traces and extract routing facts.
 *  Bad lines/files are skipped — a corrupt trace must never break the pass. */
export function collectRoutingFacts(stateDir: string): { facts: RunRoutingFacts[]; skipped: number } {
  const facts: RunRoutingFacts[] = [];
  let skipped = 0;
  const dir = resolve(stateDir, 'traces');
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch { /* no traces yet: an empty history, not an error */ }
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, '');
    const entries: TraceEntry[] = [];
    try {
      for (const line of readFileSync(resolve(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as TraceEntry;
          if (e && typeof e === 'object' && typeof e.kind === 'string') entries.push(e);
        } catch { /* skip bad line */ }
      }
    } catch { skipped++; continue; }
    const fact = entries.length ? extractRunRoutingFacts(entries, runId) : null;
    if (fact) facts.push(fact);
    else skipped++;
  }
  return { facts, skipped };
}

/** The stats pass: derive the table from a workspace's recorded history.
 *  Pure read — pair with saveRoutingTable (refreshRoutingTable does both). */
export function computeRoutingTable(
  stateDir: string,
  opts: { minSamples?: number; pricing?: PriceOverrides; now?: number } = {},
): RoutingTable {
  const { facts, skipped } = collectRoutingFacts(stateDir);
  return computeRoutingTableFromFacts(facts, { ...opts, runsSkipped: skipped });
}

// ─── Storage ─────────────────────────────────────────────────────────────

export function routingTablePath(stateDir: string): string {
  return resolve(stateDir, ROUTING_TABLE_STATE_PATH);
}

/** Load the stored table; null when absent or malformed (cold start is a
 *  normal state, not an error — routing simply has nothing to say yet). */
export function loadRoutingTable(stateDir: string): RoutingTable | null {
  try {
    const p = routingTablePath(stateDir);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as RoutingTable;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.cells)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveRoutingTable(stateDir: string, table: RoutingTable): void {
  const p = routingTablePath(stateDir);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(table, null, 2) + '\n', 'utf8');
}

/** Derive + persist. This is what the sleep-time pass and
 *  `mochi costs routing --rebuild` run. */
export function refreshRoutingTable(
  stateDir: string,
  opts: { minSamples?: number; pricing?: PriceOverrides; now?: number } = {},
): RoutingTable {
  const table = computeRoutingTable(stateDir, opts);
  saveRoutingTable(stateDir, table);
  return table;
}

// ─── Policy (pure) ───────────────────────────────────────────────────────

/** A cell the policy may act on: enough samples, a measured dollar figure,
 *  and a priceable model. Everything else is display-only data. */
export function isProvenCell(cell: RoutingCell): boolean {
  return cell.sufficient && cell.priced && cell.costPerSolveUsd !== null;
}

export function provenCellsForKind(table: RoutingTable, kind: string): RoutingCell[] {
  return table.cells.filter((c) => c.kind === kind && isProvenCell(c));
}

export interface StartChoice {
  model: string;
  cell: RoutingCell;
}

/** Cheapest PROVEN model for the kind, restricted to models this install
 *  can actually run (the caller's candidate set). Ties break toward the
 *  higher solve rate, then the model id — deterministic, so two runs with
 *  the same table always make the same choice. Null when no candidate has
 *  a proven cell: the caller keeps its configured default. That is the
 *  cold-start contract — no data, no opinion. */
export function chooseStartModel(
  table: RoutingTable,
  kind: string,
  candidates: readonly string[],
  pricing?: PriceOverrides,
): StartChoice | null {
  const cand = new Set(candidates);
  const proven = provenCellsForKind(table, kind)
    .filter((c) => cand.has(c.model) && resolvePrice(c.model, pricing) !== null);
  if (!proven.length) return null;
  proven.sort((a, b) =>
    (a.costPerSolveUsd ?? Infinity) - (b.costPerSolveUsd ?? Infinity)
    || b.solveRate - a.solveRate
    || a.model.localeCompare(b.model));
  return { model: proven[0].model, cell: proven[0] };
}

/** The measured strength ladder for a kind, strongest first: higher solve
 *  rate wins; equal rates break toward the cheaper cost-per-solve (an
 *  equally reliable model that costs less IS the stronger routing choice).
 *  Only proven cells appear — an escalation target must be a model with
 *  measured solves behind it, never a rumor. */
export function escalationLadder(
  table: RoutingTable,
  kind: string,
  candidates: readonly string[],
  pricing?: PriceOverrides,
): RoutingCell[] {
  const cand = new Set(candidates);
  return provenCellsForKind(table, kind)
    .filter((c) => cand.has(c.model) && resolvePrice(c.model, pricing) !== null)
    .sort((a, b) =>
      b.solveRate - a.solveRate
      || (a.costPerSolveUsd ?? Infinity) - (b.costPerSolveUsd ?? Infinity)
      || a.model.localeCompare(b.model));
}

export interface EscalationChoice {
  model: string;
  cell: RoutingCell;
  /** The current model's cell, when one exists (for the audit record). */
  currentCell: RoutingCell | null;
}

/** Next model UP the measured ladder from `currentModel`: the strongest
 *  proven model that is demonstrably better than where the run already is.
 *  "Better" is strict — when the current model has a proven cell, the target
 *  must beat its solve rate (or match it at lower cost-per-solve); when the
 *  current model has NO proven cell (it was a default, a pin-exempt guess,
 *  or new), the ladder's top is a legitimate target because the run's own
 *  failures are the evidence against the incumbent. Models already tried
 *  this run (attempted) are never re-offered. Null = the ladder has nothing
 *  better to say; the caller falls back to its static tier ladder. */
export function chooseEscalationTarget(
  table: RoutingTable,
  kind: string,
  currentModel: string,
  candidates: readonly string[],
  attempted: ReadonlySet<string>,
  pricing?: PriceOverrides,
): EscalationChoice | null {
  const currentCell = table.cells.find((c) => c.kind === kind && c.model === currentModel) ?? null;
  const currentProven = currentCell && isProvenCell(currentCell) ? currentCell : null;
  for (const cell of escalationLadder(table, kind, candidates, pricing)) {
    if (cell.model === currentModel || attempted.has(cell.model)) continue;
    if (!currentProven) return { model: cell.model, cell, currentCell };
    const betterRate = cell.solveRate > currentProven.solveRate;
    const equalCheaper = cell.solveRate === currentProven.solveRate
      && (cell.costPerSolveUsd ?? Infinity) < (currentProven.costPerSolveUsd ?? Infinity);
    if (betterRate || equalCheaper) return { model: cell.model, cell, currentCell };
  }
  return null;
}

/** Budget gate for an escalation, as a pure decision over the budget
 *  engine's public surface. Returns the block reason, or null when the
 *  escalation may proceed. No budget engine = no budget opinion (the loop
 *  runs uncapped in plenty of harnesses; routing does not invent one). */
export function escalationBudgetBlock(
  budget: { canMakeModelCall(): boolean; remainingCostUsd(): number } | undefined,
): string | null {
  if (!budget) return null;
  if (!budget.canMakeModelCall()) return 'budget exhausted (model-call cap or phase)';
  if (budget.remainingCostUsd() <= 0) return 'budget exhausted (cost cap reached)';
  return null;
}

// ─── Settings ────────────────────────────────────────────────────────────

export interface RoutingSettings {
  enabled: boolean;
  minSamples: number;
}

/** House-style resolution (mirrors resolveDisciplineFlags): config first,
 *  MOCHI_ROUTING=0 is the kill-switch. Default ON — but with no stored
 *  table every decision is a no-op, so a fresh install behaves exactly as
 *  it did before routing existed. */
export function resolveRoutingSettings(
  cfg?: RoutingConfig,
  env: NodeJS.ProcessEnv = process.env,
): RoutingSettings {
  return {
    enabled: cfg?.enabled !== false && env.MOCHI_ROUTING !== '0',
    minSamples: cfg?.minSamples ?? DEFAULT_MIN_ROUTING_SAMPLES,
  };
}
