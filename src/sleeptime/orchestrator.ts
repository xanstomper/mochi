// Sleep-time consolidation orchestrator (D11) — the real nightly pipeline
// that replaces the old self-train cron PROMPT (a paragraph of instructions
// an agent was asked to improvise from; see self-train-schedule.ts). This
// module is code, not a prompt: it runs a fixed sequence of steps, enforces
// a HARD spend cap, remembers what it already did tonight, and leaves a
// structured morning report.
//
// Steps (in order):
//   1. repair     — demoted skills get a repair attempt and ALWAYS re-enter
//                   via the probation path. Driven through the SkillRepairPort
//                   contract: `mochi sleeptime` injects the real D8 repair
//                   port (src/sleeptime/ports.ts → skill-repair.ts); when no
//                   port is injected (SDK embedders), the default is a
//                   clearly-labelled STUB against the current curator/
//                   probation APIs (stampSkillBirth) — createCuratorStubRepairPort.
//   2. curator    — the existing skill curator pass (lifecycle transitions,
//                   lesson promotion, dedup, age archival). Model-free, $0.
//   3. gate       — the frozen regression gate's trust anchor: the frozen
//                   set's hash integrity is verified (loadFrozenSet). A full
//                   gate RUN needs a task runner + baseline discipline, so it
//                   stays injectable via GatePort; the default port is the
//                   integrity check runGate itself performs first.
//   4. health     — proactive repo health scan (Wave O3): read-only checks
//                   (tests on HEAD, deps, TODOs, dead code, hotspots) whose
//                   ranked digest rides in this report. Model-free, $0.
//   5. induction  — D9 workflow induction: mine VERIFIED exported
//                   trajectories for winning tool spines + recovery
//                   sequences, drafting each hit as a probation skill the
//                   curator later promotes. Model-free, $0.
//   6. curriculum — failure-curriculum practice tasks (D10). Default port
//                   plans nothing and says so; inject a real CurriculumPort
//                   when needed.
//
// HARD spend cap: every unit of work declares an estimated usage up front.
// The estimate is priced through the Phase C price table (pricing.ts),
// checked against a BudgetEngine whose maxCostUsd IS the cap BEFORE the
// unit runs — a unit whose estimate exceeds the remaining cap never starts,
// and once the cap stops one unit it stops the rest of the night — and then
// COMMITTED to the budget when the unit starts. Committing at start (with
// no refund path) is what makes the cap hard across a whole night of units
// whose individual actuals are only known afterwards; a provider-reported
// actual above the reservation charges its overrun additionally, so the
// only overshoot possible is one unit's own under-declared overrun. The
// report carries BudgetEngine's costSource / provider-vs-estimated split,
// so a committed estimate is never presented as a provider measurement.
//
// Idempotency: a per-night ledger (.mochi/sleeptime/ledger.json) records
// every completed unit under a deterministic key (step + subject + the
// evidence that made it eligible). Re-running the same night skips ledgered
// units as duplicates — no duplicate repairs, no duplicate gate runs. A
// dry run reads the ledger (so its simulation is honest about what is left)
// but writes NOTHING: no ledger entries, no report files, no side effects
// beyond the steps' own planning.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetEngine } from '../budget.js';
import { estimateCostUsd, type PriceOverrides } from '../pricing.js';
import type { SafetyConfig } from '../types.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import { loadSkillUsage } from '../skills/skills.js';
import { stampSkillBirth } from '../skills/skill-manager.js';
import { defaultCuratorConfig, runCurator } from '../skills/skill-curator.js';
import { loadFrozenSet } from '../evals/regression-gate.js';
import { createHealthScanStep } from '../health/health-step.js';
import { createInductionStep } from '../observability/induction-step.js';

export class SleeptimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SleeptimeError';
  }
}

/** Default nightly spend cap when neither the caller nor the env sets one. */
export const DEFAULT_SLEEPTIME_CAP_USD = 5;

/** Local-calendar night key (YYYY-MM-DD) a run belongs to. Idempotency is
 *  scoped to this key: same key + same unit key = already done. */
export function nightKeyFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ─── Usage + step contracts ──────────────────────────────────────────────

/** One model-call-shaped usage charge, priced via pricing.ts. `costUsd`
 *  is a PROVIDER-REPORTED figure when set (it wins over the table, exactly
 *  as in BudgetEngine); without it the table estimates from the token split. */
export interface SleeptimeUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface PlannedUnit {
  /** Deterministic idempotency key, unique within the night. */
  key: string;
  title: string;
  /** Declared up-front usage: priced for the hard-cap pre-flight check,
   *  then COMMITTED to the budget when the unit starts (in a dry run it is
   *  charged as simulated spend instead). Committing at start is what makes
   *  the cap hard across units: a step cannot free its reservation by
   *  under-reporting afterwards. */
  estimatedUsage?: SleeptimeUsage;
  /** Declared fixed cost when a step knows its price without a model call
   *  (flat-fee work); takes precedence over pricing estimatedUsage and is
   *  committed the same way. */
  estimatedCostUsd?: number;
  /** Opaque step data handed back to execute() (e.g. the repair candidate). */
  payload?: Record<string, unknown>;
}

export interface PlannedStep {
  units: PlannedUnit[];
  /** Why the step planned what it did (e.g. "no demoted skills"). */
  note?: string;
}

export interface UnitOutcome {
  detail: string;
  /** Actual usage, charged ONLY when the unit declared no estimate (the
   *  estimate, when declared, is committed at unit start and IS the charge
   *  — BudgetEngine has no refund path, so reservations are never released;
   *  see runSleeptime). */
  actualUsage?: SleeptimeUsage;
  /** Provider-reported actual cost. When it EXCEEDS the committed estimate
   *  the overrun is charged additionally (exact dollars, provider bucket);
   *  below-estimate actuals do not refund the reservation. When the unit
   *  declared no estimate, this is simply the charge. */
  actualCostUsd?: number;
}

export interface SleeptimeStepContext {
  projectDir: string;
  nightKey: string;
  dryRun: boolean;
  now: Date;
  budget: BudgetEngine;
  frozenDir: string;
}

export interface SleeptimeStep {
  id: string;
  title: string;
  plan(ctx: SleeptimeStepContext): Promise<PlannedStep> | PlannedStep;
  execute(unit: PlannedUnit, ctx: SleeptimeStepContext): Promise<UnitOutcome> | UnitOutcome;
}

// ─── Report ──────────────────────────────────────────────────────────────

export type SleeptimeUnitStatus = 'completed' | 'failed' | 'skipped-duplicate' | 'skipped-cap' | 'simulated';

export interface SleeptimeUnitReport {
  key: string;
  stepId: string;
  title: string;
  status: SleeptimeUnitStatus;
  detail: string;
  /** Charged cost (budget delta across the unit). Simulated units carry
   *  their estimated charge; skipped units carry 0. */
  costUsd: number;
  tokens: number;
  estimatedCostUsd: number;
}

export type SleeptimeStepStatus = 'completed' | 'partial' | 'failed' | 'skipped' | 'skipped-cap';

export interface SleeptimeStepReport {
  id: string;
  title: string;
  status: SleeptimeStepStatus;
  detail: string;
  units: SleeptimeUnitReport[];
  costUsd: number;
  tokens: number;
}

export interface SleeptimeReport {
  kind: 'mochi-sleeptime-report';
  version: 1;
  runId: string;
  nightKey: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  projectDir: string;
  cap: { maxCostUsd: number; maxTokens: number | null };
  spend: {
    usedCostUsd: number;
    usedProviderCostUsd: number;
    usedEstimatedCostUsd: number;
    /** Provenance of usedCostUsd (BudgetEngine): estimates are labelled. */
    costSource: 'provider' | 'estimated' | 'mixed' | 'none';
    usedTokens: number;
    remainingCostUsd: number;
    /** True when the cap stopped at least one unit tonight. */
    stoppedAtCap: boolean;
  };
  steps: SleeptimeStepReport[];
  /** One-paragraph morning summary (also the CLI's headline output). */
  summary: string;
  reportPaths: { md: string; json: string } | null;
}

// ─── Ledger (idempotency store) ──────────────────────────────────────────

export interface SleeptimeLedgerUnit {
  stepId: string;
  status: 'completed';
  completedAt: number;
  costUsd: number;
  tokens: number;
  detail: string;
}

export interface SleeptimeLedgerNight {
  nightKey: string;
  runCount: number;
  firstRunAt: number;
  lastRunAt: number;
  units: Record<string, SleeptimeLedgerUnit>;
}

export interface SleeptimeLedger {
  version: 1;
  nights: Record<string, SleeptimeLedgerNight>;
}

export function sleeptimeLedgerPath(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'sleeptime', 'ledger.json');
}

export function loadSleeptimeLedger(projectDir: string): SleeptimeLedger {
  try {
    const p = sleeptimeLedgerPath(projectDir);
    if (!existsSync(p)) return { version: 1, nights: {} };
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as SleeptimeLedger;
    if (parsed.version !== 1 || !parsed.nights || typeof parsed.nights !== 'object') {
      return { version: 1, nights: {} };
    }
    return parsed;
  } catch {
    return { version: 1, nights: {} };
  }
}

function saveSleeptimeLedger(projectDir: string, ledger: SleeptimeLedger): void {
  const p = sleeptimeLedgerPath(projectDir);
  mkdirSync(join(mochiStateDir(projectDir), 'sleeptime'), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(ledger, null, 2) + '\n');
}

// ─── Budget helpers ──────────────────────────────────────────────────────

function safetyFor(opts: SleeptimeOptions, capUsd: number): SafetyConfig {
  return {
    mode: 'auto',
    commandTimeoutSeconds: 120,
    maxIterations: 80,
    maxRuntimeMinutes: opts.maxRuntimeMinutes ?? 120,
    maxConcurrentAgents: 1,
    contextBudgetTokens: 400_000,
    maxCostUsd: capUsd,
    ...(opts.spendCapTokens !== undefined ? { maxTokens: opts.spendCapTokens } : {}),
    ...(opts.safety?.pricing ? { pricing: opts.safety.pricing } : {}),
  };
}

/** Price a declared usage through the Phase C table. A declared provider
 *  cost is taken at face value; an unpriceable model with no declared cost
 *  estimates to $0 (it cannot be reserved against — the step author's
 *  contract is to declare priceable usage). */
export function estimateUsageCostUsd(u: SleeptimeUsage, overrides?: PriceOverrides): number {
  if (u.costUsd !== undefined && u.costUsd > 0) return u.costUsd;
  const est = estimateCostUsd(u.model, {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    inputIncludesCache: false,
  }, overrides);
  if (est) return est.costUsd;
  return u.costUsd ?? 0;
}

export function estimatedUnitCostUsd(unit: PlannedUnit, overrides?: PriceOverrides): number {
  if (unit.estimatedCostUsd !== undefined) return unit.estimatedCostUsd;
  if (unit.estimatedUsage) return estimateUsageCostUsd(unit.estimatedUsage, overrides);
  return 0;
}

function chargeUsage(budget: BudgetEngine, u: SleeptimeUsage): void {
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  budget.recordUsage(
    {
      promptTokens: input > 0 ? input : undefined,
      completionTokens: output,
      totalTokens: input + output > 0 ? input + output : undefined,
      cachedTokens: u.cacheReadTokens,
      costUsd: u.costUsd,
    },
    u.model,
    '',
  );
}

const fmtUsd = (n: number): string => `$${n.toFixed(4)}`;

// ─── Ports: repair (D8), gate, curriculum (D10) ──────────────────────────

export interface RepairCandidate {
  name: string;
  /** The curator's recorded demotion evidence for this skill. */
  reason: string;
  /** When the skill entered its current (demoted) state, ms epoch. Part of
   *  the unit key: a skill demoted AGAIN after a repair is new work, while
   *  the same demotion spell re-planned tonight is a duplicate. */
  stateAt?: number;
}

export interface SkillRepairPort {
  /** Why the step had nothing to plan (shown in the morning report). Absent →
   *  the step's own generic wording. A real port must state the actual reason
   *  ("no demoted skills"), never claim the module is unwired. */
  emptyNote?(): string;
  listCandidates(projectDir: string): Promise<RepairCandidate[]> | RepairCandidate[];
  repairOne(
    projectDir: string,
    candidate: RepairCandidate,
    ctx: SleeptimeStepContext,
  ): Promise<UnitOutcome> | UnitOutcome;
}

/** STUB repair port against the CURRENT curator/probation APIs, used until
 *  D8's skill-repair module lands. Candidates are registry records in the
 *  'demoted' state (the curator's evidence-based demotion). The stub applies
 *  NO body patch — D8 owns patching from failure trajectories — it only
 *  re-enters the skill via the existing probation path (stampSkillBirth),
 *  which is the safety-critical half of the D8 contract: a repaired skill is
 *  NEVER returned straight to active; promotion still requires 3 verified
 *  gate passes plus the doctor replay, enforced by the curator. Every
 *  outcome detail is labelled STUB so the morning report never presents
 *  this as a real patch. */
export function createCuratorStubRepairPort(): SkillRepairPort {
  return {
    listCandidates(projectDir: string): RepairCandidate[] {
      const out: RepairCandidate[] = [];
      for (const [name, rec] of loadSkillUsage(projectDir)) {
        if (rec.state !== 'demoted') continue;
        out.push({
          name,
          reason: rec.lastDemotionReason ?? 'demoted by curator evidence (no reason recorded)',
          ...(rec.stateAt !== undefined ? { stateAt: rec.stateAt } : {}),
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    repairOne(projectDir: string, candidate: RepairCandidate): UnitOutcome {
      const state = stampSkillBirth(projectDir, candidate.name, 'probation');
      if (state !== 'probation') {
        throw new Error(`probation re-entry failed for '${candidate.name}' (stamp returned ${String(state)})`);
      }
      return {
        detail:
          `STUB repair (D8 patcher not yet integrated): no skill-body patch applied. ` +
          `'${candidate.name}' re-entered PROBATION via stampSkillBirth — it must re-earn activation ` +
          `with verified gate passes. Demotion evidence was: ${candidate.reason}`,
      };
    },
  };
}

export interface GatePort {
  run(ctx: SleeptimeStepContext): Promise<{ verdict: string; detail: string; usage?: SleeptimeUsage }> | { verdict: string; detail: string; usage?: SleeptimeUsage };
}

/** Default gate port: frozen-set integrity — loadFrozenSet verifies every
 *  pinned task hash and the set hash, which is the check runGate performs
 *  before anything else. A tampered set throws GateError and the unit is
 *  reported FAILED (loud in the morning report, never silently skipped).
 *  A full gate run (runner + baseline) is injected by the daemon/CLI layer
 *  when it has one; it is deliberately not improvised here. */
export function createFrozenIntegrityGatePort(): GatePort {
  return {
    run(ctx: SleeptimeStepContext) {
      const set = loadFrozenSet(ctx.frozenDir);
      return {
        verdict: 'integrity-ok',
        detail:
          `frozen set v${set.manifest.version}: ${set.tasks.length} tasks, all content hashes verified, ` +
          `set hash ${set.manifest.setHash.slice(0, 16)}… (integrity only — full gate run needs an injected runner)`,
      };
    },
  };
}

export interface CurriculumTaskSpec {
  id: string;
  title: string;
  estimatedUsage?: SleeptimeUsage;
  estimatedCostUsd?: number;
}

export interface CurriculumPort {
  /** Why the step planned nothing (shown in the morning report). Absent → the
   *  step falls back to the "default port is a no-op" wording, which is only
   *  true for the placeholder port. */
  emptyNote?(): string;
  planTasks(projectDir: string, ctx: SleeptimeStepContext): Promise<CurriculumTaskSpec[]> | CurriculumTaskSpec[];
  generateOne(
    projectDir: string,
    task: CurriculumTaskSpec,
    ctx: SleeptimeStepContext,
  ): Promise<UnitOutcome> | UnitOutcome;
}

/** Default curriculum port until D10 lands: plans nothing, and the step
 *  note in the morning report says exactly that. */
export function createUnavailableCurriculumPort(): CurriculumPort {
  return {
    planTasks(): CurriculumTaskSpec[] {
      return [];
    },
    generateOne(): UnitOutcome {
      throw new Error('curriculum port unavailable (D10 not integrated)');
    },
  };
}

// ─── Default steps ───────────────────────────────────────────────────────

/** Model + token reservation for one D8 repair attempt, priced from the
 *  Phase C table (sonnet: 8k in + 2k out ≈ $0.054). The stub makes no model
 *  calls, but the reservation is still committed when the unit runs — it is
 *  labelled ESTIMATED in the report's spend split, and it is the budget a
 *  real D8 patcher will actually consume when the port is swapped. */
export const DEFAULT_REPAIR_ESTIMATE: SleeptimeUsage = {
  model: 'claude-sonnet-4-5',
  inputTokens: 8_000,
  outputTokens: 2_000,
};

export function createRepairStep(port: SkillRepairPort = createCuratorStubRepairPort(), estimate: SleeptimeUsage = DEFAULT_REPAIR_ESTIMATE): SleeptimeStep {
  return {
    id: 'repair',
    title: 'Skill repair (demoted → probation)',
    async plan(ctx: SleeptimeStepContext): Promise<PlannedStep> {
      const candidates = await port.listCandidates(ctx.projectDir);
      const units: PlannedUnit[] = candidates.map((c) => {
        const reasonHash = createHash('sha256').update(c.reason).digest('hex').slice(0, 8);
        return {
          key: `repair:${c.name}:${c.stateAt ?? 'nostate'}:${reasonHash}`,
          title: `Repair demoted skill '${c.name}'`,
          estimatedUsage: estimate,
          payload: { name: c.name, reason: c.reason, ...(c.stateAt !== undefined ? { stateAt: c.stateAt } : {}) },
        };
      });
      return {
        units,
        note: candidates.length
          ? `${candidates.length} demoted skill(s) eligible for repair`
          : (port.emptyNote?.() ?? 'no demoted skills — nothing to repair'),
      };
    },
    async execute(unit: PlannedUnit, ctx: SleeptimeStepContext): Promise<UnitOutcome> {
      const p = unit.payload ?? {};
      const candidate: RepairCandidate = {
        name: String(p.name ?? ''),
        reason: String(p.reason ?? ''),
        ...(typeof p.stateAt === 'number' ? { stateAt: p.stateAt } : {}),
      };
      if (!candidate.name) throw new Error(`repair unit ${unit.key} carries no skill name`);
      return port.repairOne(ctx.projectDir, candidate, ctx);
    },
  };
}

export function createCuratorStep(): SleeptimeStep {
  return {
    id: 'curator',
    title: 'Skill curator pass',
    plan(): PlannedStep {
      return { units: [{ key: 'curator:pass', title: 'Run the skill curator' }] };
    },
    execute(_unit: PlannedUnit, ctx: SleeptimeStepContext): UnitOutcome {
      const out = runCurator(ctx.projectDir, defaultCuratorConfig());
      const bits = [
        `scanned ${out.scanned} skills (${out.agentCreated} agent-created)`,
        out.lifecyclePromoted.length ? `promoted ${out.lifecyclePromoted.join(', ')}` : '',
        out.demoted.length ? `demoted ${out.demoted.map((d) => d.name).join(', ')}` : '',
        out.promoted.length ? `lessons promoted: ${out.promoted.join(', ')}` : '',
        out.archived.length ? `archived ${out.archived.join(', ')}` : '',
        out.consolidated.length ? `consolidated ${out.consolidated.length}` : '',
      ].filter(Boolean);
      return { detail: `${bits.join('; ')}. Report: ${out.reportPath}` };
    },
  };
}

export function createGateStep(port: GatePort = createFrozenIntegrityGatePort()): SleeptimeStep {
  return {
    id: 'gate',
    title: 'Frozen regression gate',
    plan(ctx: SleeptimeStepContext): PlannedStep {
      if (!existsSync(join(ctx.frozenDir, 'manifest.json'))) {
        return { units: [], note: `no frozen set at ${ctx.frozenDir} — gate step skipped` };
      }
      return { units: [{ key: 'gate:frozen-integrity', title: 'Verify the frozen gate set' }] };
    },
    async execute(_unit: PlannedUnit, ctx: SleeptimeStepContext): Promise<UnitOutcome> {
      const r = await port.run(ctx);
      return { detail: `${r.verdict}: ${r.detail}`, ...(r.usage ? { actualUsage: r.usage } : {}) };
    },
  };
}

export function createCurriculumStep(port: CurriculumPort = createUnavailableCurriculumPort(), maxTasks = 3): SleeptimeStep {
  return {
    id: 'curriculum',
    title: 'Failure curriculum generation',
    async plan(ctx: SleeptimeStepContext): Promise<PlannedStep> {
      const tasks = (await port.planTasks(ctx.projectDir, ctx)).slice(0, Math.max(0, maxTasks));
      const units: PlannedUnit[] = tasks.map((t) => ({
        key: `curriculum:${t.id}`,
        title: t.title,
        ...(t.estimatedUsage ? { estimatedUsage: t.estimatedUsage } : {}),
        ...(t.estimatedCostUsd !== undefined ? { estimatedCostUsd: t.estimatedCostUsd } : {}),
        payload: { id: t.id, title: t.title },
      }));
      return {
        units,
        note: tasks.length
          ? `${tasks.length} practice task(s) planned`
          : (port.emptyNote?.() ?? 'no curriculum tasks planned (default port is a no-op — inject a real CurriculumPort)'),
      };
    },
    async execute(unit: PlannedUnit, ctx: SleeptimeStepContext): Promise<UnitOutcome> {
      const p = unit.payload ?? {};
      const task: CurriculumTaskSpec = {
        id: String(p.id ?? ''),
        title: unit.title,
        ...(unit.estimatedUsage ? { estimatedUsage: unit.estimatedUsage } : {}),
        ...(unit.estimatedCostUsd !== undefined ? { estimatedCostUsd: unit.estimatedCostUsd } : {}),
      };
      if (!task.id) throw new Error(`curriculum unit ${unit.key} carries no task id`);
      return port.generateOne(ctx.projectDir, task, ctx);
    },
  };
}

export interface SleeptimePorts {
  repair?: SkillRepairPort;
  gate?: GatePort;
  curriculum?: CurriculumPort;
}

export function defaultSleeptimeSteps(opts: SleeptimeOptions = {}): SleeptimeStep[] {
  return [
    createRepairStep(opts.ports?.repair),
    createCuratorStep(),
    createGateStep(opts.ports?.gate),
    createHealthScanStep(),
    // After the curator (which owns promotion of existing skills) and before
    // curriculum: induction drafts NEW probation macros from verified runs,
    // and the curator picks those drafts up on a following night once they
    // have evidence. Model-free, $0.
    createInductionStep(),
    createCurriculumStep(opts.ports?.curriculum, opts.maxCurriculumTasks ?? 3),
  ];
}

// ─── Orchestrator ────────────────────────────────────────────────────────

export interface SleeptimeOptions {
  /** Project/workspace root (its .mochi/ tree holds the ledger + reports). */
  projectDir?: string;
  /** HARD cap on tonight's spend, USD. Default DEFAULT_SLEEPTIME_CAP_USD. */
  spendCapUsd?: number;
  /** Optional hard cap on output tokens, enforced alongside the USD cap. */
  spendCapTokens?: number;
  /** Simulate: plan + price everything, charge estimates to a throwaway
   *  budget, persist NOTHING, and let no step execute. */
  dryRun?: boolean;
  /** Injectable clock (tests, backfills). */
  now?: Date;
  /** Override the night key (defaults to nightKeyFor(now)). */
  nightKey?: string;
  /** Wall-clock budget dimension for BudgetEngine. Default 120 minutes. */
  maxRuntimeMinutes?: number;
  /** Safety config source for pricing overrides (Phase C). */
  safety?: SafetyConfig;
  /** Frozen gate set dir. Default <projectDir>/bench/frozen. */
  frozenDir?: string;
  /** Replace the default steps entirely (tests, custom pipelines). */
  steps?: SleeptimeStep[];
  /** Ports used by the default steps (ignored when `steps` is given). */
  ports?: SleeptimePorts;
  /** Cap on curriculum tasks per night. Default 3. */
  maxCurriculumTasks?: number;
  /** Write the JSON + Markdown morning report under .mochi/reports/.
   *  Default true. The ledger is written regardless (unless dry-run). */
  writeReport?: boolean;
}

function stepStatus(units: SleeptimeUnitReport[], plannedCount: number): SleeptimeStepStatus {
  if (plannedCount === 0) return 'skipped';
  const failed = units.filter((u) => u.status === 'failed').length;
  const done = units.filter((u) => u.status === 'completed' || u.status === 'simulated' || u.status === 'skipped-duplicate').length;
  const capped = units.filter((u) => u.status === 'skipped-cap').length;
  if (failed > 0 && done > 0) return 'partial';
  if (failed > 0) return 'failed';
  if (capped > 0 && done === 0) return 'skipped-cap';
  if (capped > 0) return 'partial';
  return 'completed';
}

function buildSummary(report: Omit<SleeptimeReport, 'summary' | 'reportPaths'>): string {
  const parts: string[] = [];
  for (const s of report.steps) {
    const c = (st: SleeptimeUnitStatus) => s.units.filter((u) => u.status === st).length;
    const bits: string[] = [];
    if (c('completed')) bits.push(`${c('completed')} done`);
    if (c('simulated')) bits.push(`${c('simulated')} simulated`);
    if (c('skipped-duplicate')) bits.push(`${c('skipped-duplicate')} already done tonight`);
    if (c('skipped-cap')) bits.push(`${c('skipped-cap')} stopped by cap`);
    if (c('failed')) bits.push(`${c('failed')} FAILED`);
    parts.push(`${s.id}: ${bits.length ? bits.join(', ') : s.detail || 'nothing planned'}`);
  }
  const spend = `spent ${fmtUsd(report.spend.usedCostUsd)} of ${fmtUsd(report.cap.maxCostUsd)} cap` +
    (report.spend.costSource === 'estimated' || report.spend.costSource === 'mixed'
      ? ` (${report.spend.costSource} cost)`
      : '') +
    (report.spend.stoppedAtCap ? ' — STOPPED AT CAP' : '');
  return `Sleeptime ${report.nightKey}${report.dryRun ? ' (dry run)' : ''}: ${parts.join(' · ')} · ${spend}.`;
}

export function renderSleeptimeReportMd(report: SleeptimeReport): string {
  const lines: string[] = [];
  lines.push(`# 🌙 Sleeptime consolidation — ${report.nightKey}${report.dryRun ? ' (DRY RUN)' : ''}`);
  lines.push('');
  lines.push(report.summary);
  lines.push('');
  lines.push(`- Run: \`${report.runId}\` · ${report.startedAt} → ${report.finishedAt} (${Math.round(report.durationMs)}ms)`);
  lines.push(`- Spend: ${fmtUsd(report.spend.usedCostUsd)} of ${fmtUsd(report.cap.maxCostUsd)} cap ` +
    `(provider ${fmtUsd(report.spend.usedProviderCostUsd)}, estimated ${fmtUsd(report.spend.usedEstimatedCostUsd)}, source: ${report.spend.costSource}); ` +
    `${report.spend.usedTokens} tokens; remaining ${fmtUsd(report.spend.remainingCostUsd)}` +
    (report.spend.stoppedAtCap ? '; **STOPPED AT CAP**' : ''));
  lines.push('');
  for (const s of report.steps) {
    lines.push(`## ${s.title} — ${s.status}`);
    if (s.detail) lines.push(s.detail);
    for (const u of s.units) {
      lines.push(`- [${u.status}] ${u.title} — ${u.detail} (${fmtUsd(u.costUsd)}${u.estimatedCostUsd ? `, est. ${fmtUsd(u.estimatedCostUsd)}` : ''})`);
    }
    if (!s.units.length) lines.push('- (no units planned)');
    lines.push('');
  }
  return lines.join('\n');
}

export async function runSleeptime(opts: SleeptimeOptions = {}): Promise<SleeptimeReport> {
  const projectDir = opts.projectDir ?? process.cwd();
  const now = opts.now ?? new Date();
  const nightKey = opts.nightKey ?? nightKeyFor(now);
  const capUsd = opts.spendCapUsd ?? DEFAULT_SLEEPTIME_CAP_USD;
  if (!Number.isFinite(capUsd) || capUsd < 0) {
    throw new SleeptimeError(`spendCapUsd must be a finite number >= 0, got ${String(opts.spendCapUsd)}`);
  }
  const dryRun = !!opts.dryRun;
  const frozenDir = opts.frozenDir ?? join(projectDir, 'bench', 'frozen');
  const overrides = opts.safety?.pricing?.overrides as PriceOverrides | undefined;

  const budget = new BudgetEngine(safetyFor(opts, capUsd));
  budget.start();
  const ctx: SleeptimeStepContext = { projectDir, nightKey, dryRun, now, budget, frozenDir };

  const ledger = loadSleeptimeLedger(projectDir);
  const existingNight = ledger.nights[nightKey];
  const night: SleeptimeLedgerNight = existingNight ?? {
    nightKey, runCount: 0, firstRunAt: now.getTime(), lastRunAt: now.getTime(), units: {},
  };
  const runId = `sleeptime-${nightKey}-${night.runCount + 1}`;
  const startedAt = now;

  const steps = opts.steps ?? defaultSleeptimeSteps(opts);
  const stepReports: SleeptimeStepReport[] = [];
  let stoppedAtCap = false;

  for (const step of steps) {
    const sr: SleeptimeStepReport = { id: step.id, title: step.title, status: 'skipped', detail: '', units: [], costUsd: 0, tokens: 0 };
    let planned: PlannedStep;
    try {
      planned = await step.plan(ctx);
    } catch (e) {
      sr.status = 'failed';
      sr.detail = `plan failed: ${e instanceof Error ? e.message : String(e)}`;
      stepReports.push(sr);
      continue;
    }
    sr.detail = planned.note ?? '';
    for (const unit of planned.units) {
      const estCost = estimatedUnitCostUsd(unit, overrides);
      const ur: SleeptimeUnitReport = {
        key: unit.key, stepId: step.id, title: unit.title,
        status: 'completed', detail: '', costUsd: 0, tokens: 0, estimatedCostUsd: estCost,
      };
      const prior = night.units[unit.key];
      if (prior?.status === 'completed') {
        ur.status = 'skipped-duplicate';
        ur.detail = `already completed this night at ${new Date(prior.completedAt).toISOString()} — no duplicate work`;
        sr.units.push(ur);
        continue;
      }
      if (stoppedAtCap) {
        ur.status = 'skipped-cap';
        ur.detail = 'night already stopped at the spend cap';
        sr.units.push(ur);
        continue;
      }
      // HARD CAP pre-flight: the unit never starts if its declared estimate
      // exceeds what is left of the cap (USD, and output tokens when capped).
      const remainingUsd = budget.remainingCostUsd();
      const estOutTokens = unit.estimatedUsage?.outputTokens ?? 0;
      if (estCost > remainingUsd + 1e-9 || (estOutTokens > 0 && estOutTokens > budget.remainingTokens())) {
        stoppedAtCap = true;
        ur.status = 'skipped-cap';
        ur.detail = estCost > remainingUsd + 1e-9
          ? `estimated ${fmtUsd(estCost)} exceeds remaining cap ${fmtUsd(remainingUsd)} — unit not started`
          : `estimated ${estOutTokens} output tokens exceeds remaining token cap ${budget.remainingTokens()} — unit not started`;
        sr.units.push(ur);
        continue;
      }
      // Commit the declared estimate BEFORE the unit starts (dry runs
      // charge it to the throwaway budget as simulated spend). This is the
      // hard-cap mechanism: remaining cap only ever shrinks, so no sequence
      // of optimistic steps can spend past the cap by under-reporting.
      const before = budget.snapshot('');
      if (unit.estimatedUsage) chargeUsage(budget, unit.estimatedUsage);
      else if (estCost > 0) budget.recordTokens(0, 'sleeptime-declared', '', estCost);
      const committed = budget.snapshot('').usedCostUsd - before.usedCostUsd;
      if (dryRun) {
        const after = budget.snapshot('');
        ur.status = 'simulated';
        ur.detail = 'dry run: priced at its declared estimate; not executed, nothing persisted';
        ur.costUsd = after.usedCostUsd - before.usedCostUsd;
        ur.tokens = after.usedTokens - before.usedTokens;
        sr.units.push(ur);
        continue;
      }
      try {
        const outcome = await step.execute(unit, ctx);
        if (committed === 0 && outcome.actualUsage) {
          chargeUsage(budget, outcome.actualUsage);
        } else if (outcome.actualCostUsd !== undefined && outcome.actualCostUsd > committed + 1e-9) {
          // Provider-reported overrun above the committed reservation.
          budget.recordTokens(0, outcome.actualUsage?.model ?? unit.estimatedUsage?.model ?? 'sleeptime', '', outcome.actualCostUsd - committed);
        } else if (committed === 0 && outcome.actualCostUsd !== undefined && outcome.actualCostUsd > 0) {
          budget.recordTokens(0, 'sleeptime', '', outcome.actualCostUsd);
        }
        const after = budget.snapshot('');
        ur.status = 'completed';
        ur.detail = outcome.detail;
        ur.costUsd = after.usedCostUsd - before.usedCostUsd;
        ur.tokens = after.usedTokens - before.usedTokens;
        night.units[unit.key] = {
          stepId: step.id, status: 'completed', completedAt: Date.now(),
          costUsd: ur.costUsd, tokens: ur.tokens, detail: outcome.detail.slice(0, 500),
        };
      } catch (e) {
        // The reservation stays charged: the unit may have spent before it
        // failed, and an uncharged failure would let retries bypass the cap.
        const after = budget.snapshot('');
        ur.status = 'failed';
        ur.detail = e instanceof Error ? e.message : String(e);
        ur.costUsd = after.usedCostUsd - before.usedCostUsd;
        ur.tokens = after.usedTokens - before.usedTokens;
      }
      sr.units.push(ur);
    }
    sr.status = stepStatus(sr.units, planned.units.length);
    sr.costUsd = sr.units.reduce((s, u) => s + u.costUsd, 0);
    sr.tokens = sr.units.reduce((s, u) => s + u.tokens, 0);
    stepReports.push(sr);
  }

  const finishedAt = new Date();
  const snap = budget.snapshot('');
  const base: Omit<SleeptimeReport, 'summary' | 'reportPaths'> = {
    kind: 'mochi-sleeptime-report',
    version: 1,
    runId,
    nightKey,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    dryRun,
    projectDir,
    cap: { maxCostUsd: capUsd, maxTokens: opts.spendCapTokens ?? null },
    spend: {
      usedCostUsd: snap.usedCostUsd,
      usedProviderCostUsd: snap.usedProviderCostUsd,
      usedEstimatedCostUsd: snap.usedEstimatedCostUsd,
      costSource: snap.costSource,
      usedTokens: snap.usedTokens,
      remainingCostUsd: snap.remainingCostUsd,
      stoppedAtCap,
    },
    steps: stepReports,
  };
  const summary = buildSummary(base);
  const report: SleeptimeReport = { ...base, summary, reportPaths: null };

  if (!dryRun) {
    night.runCount += 1;
    night.lastRunAt = finishedAt.getTime();
    ledger.nights[nightKey] = night;
    saveSleeptimeLedger(projectDir, ledger);
    if (opts.writeReport !== false) {
      const reportsDir = join(mochiStateDir(projectDir), 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const jsonPath = join(reportsDir, `sleeptime-${nightKey}.json`);
      const mdPath = join(reportsDir, `sleeptime-${nightKey}.md`);
      report.reportPaths = { md: mdPath, json: jsonPath };
      atomicWriteFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
      atomicWriteFileSync(mdPath, renderSleeptimeReportMd(report));
    }
  }
  return report;
}
