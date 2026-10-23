/**
 * Long-task strategy — milestone decomposition with verified checkpoints
 * and budget pacing.
 *
 * The gap this module closes: Mochi's harness is built for long tasks
 * (durable journal, verified compaction, subagents), but the STRATEGY for
 * a multi-hour run was implicit — the loop planned in prose, spent budget
 * wherever the model wandered, and discovered budget exhaustion only when
 * the well ran dry mid-work. This module makes the strategy a designed
 * system, in the same shape as the reasoning-discipline layer
 * (src/agent/discipline.ts): a pure, unit-testable state machine the loop
 * consults; the loop owns every side effect (context messages, journal
 * writes, checkpoints, finishes).
 *
 * The system, end to end:
 *
 *  1. DECOMPOSITION — a complex/long task is decomposed up front into
 *     milestones. Every milestone carries (a) a VERIFIABLE check (a
 *     command whose exit code decides, or an artifact assertion — never
 *     "the model says it's done"), (b) a budget slice (output tokens +
 *     turns) derived by weight from the run's total budget, and (c)
 *     dependencies on earlier milestones.
 *  2. VERIFIED CHECKPOINTS — a milestone closes only when its check
 *     passes, executed harness-side (the same evidence standard as the
 *     verification gate: a real command really run, strict exit code).
 *     Closing journals a checkpoint entry and writes the workspace
 *     checkpoint, so a resume restarts AT the milestone boundary with
 *     earlier milestones closed — never mid-milestone mush.
 *  3. BUDGET PACING — the tracker compares burn (spend vs total budget)
 *     against progress (passed weight vs total weight) every iteration.
 *     Sustained over-burn gets explicit responses IN ORDER: tighten
 *     (drop optional scope), re-plan (re-decompose the remaining
 *     milestones — evidence-gated, see 4), escalate (stop with a precise
 *     state summary + checkpoint, resumable). The run never dies silently
 *     mid-milestone from budget exhaustion it could see coming.
 *  4. RE-PLAN DISCIPLINE — re-plans require NEW evidence (a failed
 *     milestone check, a discovered dependency): the same anti-thrash
 *     rule the discipline layer applies to in-run reconsiderations,
 *     applied to plans. Every re-plan is journaled with its trigger.
 *
 * The plan state is plain JSON, persisted by the loop at
 * `state/milestones-<taskId>.json` in the workspace (alongside the goal /
 * checkpoint state the resume flow already reads), so a fresh process
 * reconstructs the strategy exactly where the killed one left it.
 *
 * Kill-switches (house style, see resolveLongtaskFlags):
 *   MOCHI_LONGTASK=0         — the whole layer off
 *   MOCHI_LONGTASK_PACING=0  — milestones + checkpoints stay, pacing off
 *   config.longtask.enabled / config.longtask.pacing — same, per config
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LongTaskConfig, Task } from '../types.js';
import { failureClassOf } from './discipline.js';
import { sanitizeRunId } from './run-journal.js';

// ── Types ────────────────────────────────────────────────────────────────

/** A milestone's completion check. `command` is decided by exit code,
 *  executed harness-side; `artifact` asserts a file exists (and optionally
 *  contains a string). Neither is satisfiable by a model claim. */
export type MilestoneCheckSpec =
  | { kind: 'command'; command: string }
  | { kind: 'artifact'; path: string; contains?: string };

/** One milestone as a planner (model, host, or test) supplies it, before
 *  budget slices are derived. */
export interface MilestoneInput {
  id?: string;
  title: string;
  detail?: string;
  check: MilestoneCheckSpec;
  /** Relative budget weight (default 1). Slices are proportional. */
  weight?: number;
  /** Optional milestones are the tightening valve: pacing drops them
   *  first when the run over-burns. */
  optional?: boolean;
  /** Ids of milestones that must pass before this one starts. */
  dependsOn?: string[];
}

export type MilestoneStatus = 'pending' | 'active' | 'passed' | 'dropped';

export interface Milestone {
  id: string;
  title: string;
  detail: string;
  check: MilestoneCheckSpec;
  weight: number;
  optional: boolean;
  dependsOn: string[];
  /** Derived budget slice (0 = that dimension is unbounded). */
  budgetTokens: number;
  budgetTurns: number;
  status: MilestoneStatus;
  /** Harness check executions against this milestone. */
  attempts: number;
  spentTokens: number;
  spentTurns: number;
  lastCheckOutput?: string;
  passedAt?: number;
}

export interface ReplanRecord {
  at: number;
  /** Why the re-plan happened — the evidence that justified it. */
  trigger: string;
  replacedIds: string[];
  addedIds: string[];
}

export interface MilestonePlanState {
  version: 1;
  taskId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Run-level budgets the slices were derived from (0 = unbounded). */
  totalBudgetTokens: number;
  totalBudgetTurns: number;
  spentTokens: number;
  spentTurns: number;
  milestones: Milestone[];
  replans: ReplanRecord[];
  /** Pacing episode memory (per milestone id): the tighten rung has fired. */
  tightenedFor: string[];
  escalatedReason?: string;
}

export type MilestoneEvent =
  | { type: 'plan'; state: MilestonePlanState }
  | { type: 'passed'; milestone: Milestone }
  | { type: 'check-failed'; milestone: Milestone; output: string }
  | { type: 'tightened'; milestoneId: string; droppedIds: string[]; reason: string }
  | { type: 'dropped'; milestone: Milestone; reason: string }
  | { type: 'replanned'; record: ReplanRecord }
  | { type: 'escalated'; reason: string };

export type MilestoneEventSink = (e: MilestoneEvent) => void;

export interface PacingAssessment {
  action: 'none' | 'tighten' | 'replan' | 'escalate';
  reason: string;
  milestoneId?: string;
}

// ── Flags ────────────────────────────────────────────────────────────────

export interface LongtaskFlags {
  enabled: boolean;
  pacing: boolean;
}

/** Resolve the effective flags: master env/config switch first, then the
 *  pacing sub-switch. Everything defaults ON (for tasks that activate the
 *  layer — see the loop's activation gate). */
export function resolveLongtaskFlags(
  cfg?: LongTaskConfig,
  env: NodeJS.ProcessEnv = process.env,
): LongtaskFlags {
  const enabled = cfg?.enabled !== false && env.MOCHI_LONGTASK !== '0';
  const pacing = enabled && cfg?.pacing !== false && env.MOCHI_LONGTASK_PACING !== '0';
  return { enabled, pacing };
}

// ── Plan construction ────────────────────────────────────────────────────

export function slugifyMilestoneId(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function validateCheck(check: unknown, where: string): MilestoneCheckSpec {
  if (!check || typeof check !== 'object') {
    throw new Error(`${where}: milestone check must be an object`);
  }
  const c = check as { kind?: unknown; command?: unknown; path?: unknown; contains?: unknown };
  if (c.kind === 'command') {
    if (typeof c.command !== 'string' || !c.command.trim()) {
      throw new Error(`${where}: command check needs a non-empty command`);
    }
    return { kind: 'command', command: c.command.trim() };
  }
  if (c.kind === 'artifact') {
    if (typeof c.path !== 'string' || !c.path.trim()) {
      throw new Error(`${where}: artifact check needs a non-empty path`);
    }
    return {
      kind: 'artifact',
      path: c.path.trim(),
      ...(typeof c.contains === 'string' && c.contains ? { contains: c.contains } : {}),
    };
  }
  throw new Error(`${where}: unknown check kind ${JSON.stringify(c.kind)} (want "command" or "artifact")`);
}

/** Validate + normalize raw milestone inputs: ids assigned/deduped, checks
 *  validated, dependencies resolved and cycle-checked, order topologically
 *  sorted (stable — input order preserved within dependency levels).
 *  Throws Error with a precise message on any structural problem; callers
 *  treat a throw as "no usable plan" and degrade to no strategy. */
export function normalizeMilestoneInputs(inputs: MilestoneInput[]): Array<{
  id: string; title: string; detail: string; check: MilestoneCheckSpec;
  weight: number; optional: boolean; dependsOn: string[];
}> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('milestone plan is empty');
  }
  const used = new Set<string>();
  const norm = inputs.map((raw, idx) => {
    if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) {
      throw new Error(`milestone ${idx + 1}: title is required`);
    }
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : slugifyMilestoneId(raw.title, `m${idx + 1}`);
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    used.add(id);
    const weight = typeof raw.weight === 'number' && Number.isFinite(raw.weight) && raw.weight > 0 ? raw.weight : 1;
    return {
      id,
      title: raw.title.trim(),
      detail: typeof raw.detail === 'string' ? raw.detail.trim() : '',
      check: validateCheck(raw.check, `milestone "${id}"`),
      weight,
      optional: raw.optional === true,
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map((d) => String(d)).filter(Boolean) : [],
    };
  });
  const byId = new Map(norm.map((m) => [m.id, m]));
  for (const m of norm) {
    for (const dep of m.dependsOn) {
      if (dep === m.id) throw new Error(`milestone "${m.id}" depends on itself`);
      if (!byId.has(dep)) throw new Error(`milestone "${m.id}" depends on unknown milestone "${dep}"`);
    }
  }
  // Stable topological sort (Kahn's, input order as the tiebreak).
  const out: typeof norm = [];
  const placed = new Set<string>();
  let rest = [...norm];
  while (rest.length > 0) {
    const ready = rest.filter((m) => m.dependsOn.every((d) => placed.has(d)));
    if (ready.length === 0) {
      throw new Error(`milestone dependencies contain a cycle involving: ${rest.map((m) => m.id).join(', ')}`);
    }
    for (const m of ready) {
      out.push(m);
      placed.add(m.id);
    }
    rest = rest.filter((m) => !placed.has(m.id));
  }
  return out;
}

/** Distribute a finite total across weights; 0 total = unbounded (0 slices). */
function distribute(total: number, weights: number[]): number[] {
  if (!(total > 0)) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((v) => Math.floor(v));
  let remainder = total - out.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0 && out.length > 0; i = (i + 1) % out.length) {
    out[i]++;
    remainder--;
  }
  return out;
}

/** Build a fresh plan state from planner inputs + the run's budgets. */
export function buildMilestonePlan(
  taskId: string,
  title: string,
  inputs: MilestoneInput[],
  budget: { tokens: number; turns: number },
  now = Date.now(),
): MilestonePlanState {
  const norm = normalizeMilestoneInputs(inputs);
  const tokenSlices = distribute(Math.max(0, Math.floor(budget.tokens) || 0), norm.map((m) => m.weight));
  const turnSlices = distribute(Math.max(0, Math.floor(budget.turns) || 0), norm.map((m) => m.weight));
  return {
    version: 1,
    taskId,
    title,
    createdAt: now,
    updatedAt: now,
    totalBudgetTokens: Math.max(0, Math.floor(budget.tokens) || 0),
    totalBudgetTurns: Math.max(0, Math.floor(budget.turns) || 0),
    spentTokens: 0,
    spentTurns: 0,
    milestones: norm.map((m, i) => ({
      ...m,
      budgetTokens: tokenSlices[i],
      budgetTurns: turnSlices[i],
      status: 'pending' as MilestoneStatus,
      attempts: 0,
      spentTokens: 0,
      spentTurns: 0,
    })),
    replans: [],
    tightenedFor: [],
  };
}

/** Tolerant parse of a planner model's reply into milestone inputs (same
 *  cleaning discipline as GoalEngine.decompose: strip fences, take the
 *  outermost JSON array). Returns null when the reply carries no valid
 *  plan — the caller degrades to no strategy rather than guessing. */
export function parseMilestoneInputs(text: string): MilestoneInput[] | null {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*|\s*```/g, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  try {
    normalizeMilestoneInputs(parsed as MilestoneInput[]);
  } catch {
    return null;
  }
  return parsed as MilestoneInput[];
}

export const MILESTONE_PLAN_MARKER = 'MILESTONE DECOMPOSITION';

/** Ask a chat function to decompose a task into milestones. The chat fn is
 *  injected so the planner is unit-testable without a provider and the
 *  loop can route it through the run's own provider stack. Returns null on
 *  any failure (transport, parse, validation) — decomposition is an
 *  enhancement, never a run blocker. */
export async function planMilestonesWithChat(
  task: Pick<Task, 'title' | 'description' | 'acceptanceCriteria' | 'verificationCommand'>,
  chat: (messages: Array<{ role: string; content: string }>) => Promise<{ content?: string }>,
  opts?: { remainingTitles?: string[]; evidence?: string[] },
): Promise<MilestoneInput[] | null> {
  const remaining = opts?.remainingTitles && opts.remainingTitles.length > 0
    ? `\nThis is a RE-PLAN of the REMAINING work. Already-completed milestones (do NOT repeat them): ${opts.remainingTitles.join('; ')}.`
    : '';
  const evidence = opts?.evidence && opts.evidence.length > 0
    ? `\nNew evidence that forced this re-plan (design the new milestones AROUND it):\n${opts.evidence.map((e) => `- ${e}`).join('\n')}`
    : '';
  const prompt = `${MILESTONE_PLAN_MARKER} — decompose the task into 3–6 milestones as a JSON array. Each milestone:
{
  "title": string (short),
  "detail": string (what to do, concretely),
  "check": { "kind": "command", "command": string } OR { "kind": "artifact", "path": string, "contains": string (optional) },
  "weight": number (relative size, default 1),
  "optional": boolean (true only for scope that can be dropped under budget pressure),
  "dependsOn": string[] (titles of earlier milestones this one needs)
}
Rules: every check must be mechanically decidable (a command whose exit code decides, or a file that must exist/contain text) — never "review the code" or other judgement calls. Checks must be cheap and scoped to the milestone, not the whole repo suite, unless the milestone IS the final integration. Order milestones so each builds on the last.${remaining}${evidence}
Task: ${task.title}
${task.description ?? ''}
${task.acceptanceCriteria && task.acceptanceCriteria.length > 0 ? `Acceptance criteria: ${task.acceptanceCriteria.join('; ')}` : ''}
Return ONLY the JSON array, no markdown.`;
  try {
    const res = await chat([
      { role: 'system', content: 'You are a planning agent. Output only valid JSON.' },
      { role: 'user', content: prompt },
    ]);
    return parseMilestoneInputs(res.content ?? '');
  } catch {
    return null;
  }
}

// ── Check execution ──────────────────────────────────────────────────────

export interface MilestoneCheckResult {
  passed: boolean;
  output: string;
}

/** Execute one milestone check harness-side. Command checks go through
 *  the injected shell runner (the loop's runShell — same envelope the
 *  verification gate parses: an `exit_code: N` line decides). Artifact
 *  checks are direct filesystem assertions. The output tail is returned
 *  either way: it is the evidence a failure feeds back to the model and
 *  the re-plan gate. */
export async function runMilestoneCheck(
  check: MilestoneCheckSpec,
  cwd: string,
  runShell: (command: string, timeoutSeconds: number) => Promise<string>,
): Promise<MilestoneCheckResult> {
  if (check.kind === 'artifact') {
    const abs = resolve(cwd, check.path);
    if (!existsSync(abs)) {
      return { passed: false, output: `artifact check failed: ${check.path} does not exist` };
    }
    if (check.contains) {
      let body = '';
      try {
        body = readFileSync(abs, 'utf8');
      } catch (err) {
        return { passed: false, output: `artifact check failed: ${check.path} unreadable (${err instanceof Error ? err.message : String(err)})` };
      }
      if (!body.includes(check.contains)) {
        return {
          passed: false,
          output: `artifact check failed: ${check.path} exists but does not contain ${JSON.stringify(check.contains)} (found ${JSON.stringify(body.slice(0, 120))})`,
        };
      }
      return { passed: true, output: `artifact check passed: ${check.path} exists and contains ${JSON.stringify(check.contains)}` };
    }
    return { passed: true, output: `artifact check passed: ${check.path} exists` };
  }
  let out: string;
  try {
    out = await runShell(check.command, 120);
  } catch (err) {
    return { passed: false, output: `command check errored: ${err instanceof Error ? err.message : String(err)}` };
  }
  const exitLine = out.match(/^exit_code:\s*(\d+)\s*$/m);
  const tail = out.length > 1200 ? `…${out.slice(-1200)}` : out;
  if (!exitLine) {
    return { passed: false, output: `command check produced no exit_code envelope (treating as failed):\n${tail}` };
  }
  const code = Number(exitLine[1]);
  return {
    passed: code === 0,
    output: `command check ${code === 0 ? 'passed' : `failed (exit ${code})`}: ${check.command}\n${tail}`,
  };
}

export function describeCheck(check: MilestoneCheckSpec): string {
  return check.kind === 'command'
    ? `command exits 0: \`${check.command}\``
    : `file ${check.path} exists${check.contains ? ` and contains ${JSON.stringify(check.contains)}` : ''}`;
}

// ── Tracker ──────────────────────────────────────────────────────────────

/** Per-milestone slice burn above which the milestone is over-burning. */
export const MILESTONE_OVERBURN = 1.5;
/** Per-milestone slice burn at which pacing gives up on the milestone. */
export const MILESTONE_GIVE_UP = 2.5;
/** Global burn may lead progress by this much before pacing responds. */
export const GLOBAL_OVERBURN_LEAD = 0.3;
/** Fraction of a finite budget consumed, with milestones still open,
 *  at which pacing escalates instead of squeezing further. */
export const BUDGET_ESCALATION_FRACTION = 0.9;

/**
 * The milestone state machine. Pure (no I/O): the loop feeds it spend and
 * check results, asks it for pacing verdicts and briefs, and performs the
 * side effects (context injection, journaling, persistence, finishes)
 * itself — events are reported through the sink so the loop can journal
 * them at the moment they happen.
 */
export class MilestoneTracker {
  readonly state: MilestonePlanState;
  private sink?: MilestoneEventSink;
  readonly stats = {
    checksRun: 0,
    checksFailed: 0,
    replansAllowed: 0,
    replansSuppressed: 0,
    tightenings: 0,
    escalations: 0,
  };

  /** Evidence ledger for the re-plan gate — identical semantics to the
   *  discipline tracker's: a key is evidence only the FIRST time it is
   *  seen; allowed re-plans consume the pending set. */
  private seenEvidence = new Set<string>();
  private pendingEvidence = new Set<string>();

  constructor(state: MilestonePlanState, sink?: MilestoneEventSink) {
    this.state = state;
    this.sink = sink;
    // Rebuild the evidence ledger from recorded history: past check
    // failures were already counted as evidence by the session that saw
    // them, so a resumed run must not treat them as fresh.
    for (const m of state.milestones) {
      if (m.attempts > 0 && m.lastCheckOutput) {
        this.seenEvidence.add(`milestone-check:${m.id}:${failureClassOf(m.lastCheckOutput)}`);
      }
    }
    for (const r of state.replans) this.seenEvidence.add(`replan:${r.trigger}`);
  }

  private touch(): void {
    this.state.updatedAt = Date.now();
  }

  private emit(e: MilestoneEvent): void {
    try {
      this.sink?.(e);
    } catch { /* a broken sink must never break the strategy */ }
  }

  // ── Position ─────────────────────────────────────────────────────────

  /** The milestone the run should be working on: the first (in dependency
   *  order) not-yet-closed milestone whose dependencies are all closed.
   *  A DROPPED dependency counts as satisfied — dropping is a deliberate
   *  scope decision, and stranding its dependents would punish the run
   *  for a decision the harness itself made. */
  current(): Milestone | undefined {
    const closed = new Set(
      this.state.milestones.filter((m) => m.status === 'passed' || m.status === 'dropped').map((m) => m.id),
    );
    return this.state.milestones.find(
      (m) => (m.status === 'pending' || m.status === 'active') && m.dependsOn.every((d) => closed.has(d)),
    );
  }

  /** Mark the current milestone active (idempotent). */
  activate(): Milestone | undefined {
    const m = this.current();
    if (m && m.status === 'pending') {
      m.status = 'active';
      this.touch();
    }
    return m;
  }

  allPassed(): boolean {
    return this.state.milestones.every((m) => m.status === 'passed' || m.status === 'dropped');
  }

  passedCount(): number {
    return this.state.milestones.filter((m) => m.status === 'passed').length;
  }

  /** 1-based position of the current milestone for briefs ("3/5"). */
  position(): { index: number; total: number } {
    const cur = this.current();
    const total = this.state.milestones.length;
    if (!cur) return { index: total, total };
    return { index: this.state.milestones.indexOf(cur) + 1, total };
  }

  progressFraction(): number {
    const total = this.state.milestones.reduce((a, m) => a + m.weight, 0);
    if (total <= 0) return 1;
    const done = this.state.milestones
      .filter((m) => m.status === 'passed' || m.status === 'dropped')
      .reduce((a, m) => a + m.weight, 0);
    return done / total;
  }

  /** Burn across the finite budget dimensions (the max — the binding
   *  constraint is the one that runs out first). */
  burnFraction(): number {
    const fracs: number[] = [];
    if (this.state.totalBudgetTokens > 0) fracs.push(this.state.spentTokens / this.state.totalBudgetTokens);
    if (this.state.totalBudgetTurns > 0) fracs.push(this.state.spentTurns / this.state.totalBudgetTurns);
    return fracs.length > 0 ? Math.max(...fracs) : 0;
  }

  /** This milestone's burn of its own slice, across finite dimensions. */
  milestoneBurn(m: Milestone): number {
    const fracs: number[] = [];
    if (m.budgetTokens > 0) fracs.push(m.spentTokens / m.budgetTokens);
    if (m.budgetTurns > 0) fracs.push(m.spentTurns / m.budgetTurns);
    return fracs.length > 0 ? Math.max(...fracs) : 0;
  }

  // ── Spend + checks ───────────────────────────────────────────────────

  noteSpend(tokens: number, turns: number): void {
    if (tokens <= 0 && turns <= 0) return;
    this.state.spentTokens += Math.max(0, tokens);
    this.state.spentTurns += Math.max(0, turns);
    const m = this.current();
    if (m) {
      m.spentTokens += Math.max(0, tokens);
      m.spentTurns += Math.max(0, turns);
    }
    this.touch();
  }

  /** Record a harness check execution against the current milestone.
   *  Returns the milestone AFTER the update (status 'passed' when the
   *  check passed). A failure is noted as re-plan evidence under its
   *  failure class — the first sighting only. */
  recordCheck(passed: boolean, output: string): Milestone | undefined {
    const m = this.current();
    if (!m) return undefined;
    m.attempts++;
    m.lastCheckOutput = output.slice(0, 2000);
    this.stats.checksRun++;
    if (passed) {
      m.status = 'passed';
      m.passedAt = Date.now();
      this.touch();
      this.emit({ type: 'passed', milestone: m });
    } else {
      this.stats.checksFailed++;
      this.noteEvidence(`milestone-check:${m.id}:${failureClassOf(output)}`);
      this.touch();
      this.emit({ type: 'check-failed', milestone: m, output });
    }
    return m;
  }

  // ── Evidence gate (re-plan discipline) ───────────────────────────────

  noteEvidence(key: string): void {
    const k = key.slice(0, 240);
    if (this.seenEvidence.has(k)) return;
    this.seenEvidence.add(k);
    this.pendingEvidence.add(k);
  }

  hasPendingEvidence(): boolean {
    return this.pendingEvidence.size > 0;
  }

  pendingEvidenceKeys(): string[] {
    return [...this.pendingEvidence];
  }

  /** A re-plan is allowed only when evidence arrived since the last
   *  allowed re-plan. Peeking (hasPendingEvidence) does not consume. */
  gateReplan(_source: string): { allowed: boolean; reason: string } {
    if (this.pendingEvidence.size > 0) {
      const reason = `new evidence: ${[...this.pendingEvidence].slice(0, 3).join('; ')}`;
      this.pendingEvidence.clear();
      this.stats.replansAllowed++;
      return { allowed: true, reason };
    }
    this.stats.replansSuppressed++;
    return { allowed: false, reason: 'no new evidence since the last re-plan' };
  }

  // ── Pacing ───────────────────────────────────────────────────────────

  /**
   * Assess burn vs progress. The response ladder, in order:
   *   tighten — first over-burn episode for the current milestone (or a
   *     global burn/progress gap): drop optional scope.
   *   replan  — still over-burning after tightening AND new evidence is
   *     pending (the loop still has to pass gateReplan; this verdict is
   *     the pacing layer's recommendation).
   *   escalate — the finite budget is nearly gone with milestones open,
   *     or one milestone has burned 2.5× its slice without passing:
   *     squeezing further is how runs die silently; stop loudly instead.
   */
  assessPacing(): PacingAssessment {
    const m = this.current();
    if (!m || this.allPassed()) return { action: 'none', reason: 'no open milestone' };
    const burn = this.burnFraction();
    const progress = this.progressFraction();
    const anyFinite = this.state.totalBudgetTokens > 0 || this.state.totalBudgetTurns > 0;
    if (anyFinite && burn >= BUDGET_ESCALATION_FRACTION && progress < 1) {
      return {
        action: 'escalate',
        reason: `budget ${Math.round(burn * 100)}% consumed with ${this.state.milestones.length - this.passedCount()} of ${this.state.milestones.length} milestones still open`,
        milestoneId: m.id,
      };
    }
    const mb = this.milestoneBurn(m);
    const globalOverburn = burn > progress + GLOBAL_OVERBURN_LEAD && this.state.spentTurns >= 3;
    const overburning = mb > MILESTONE_OVERBURN || globalOverburn;
    if (!overburning) return { action: 'none', reason: 'burn is proportionate to progress' };
    const why = mb > MILESTONE_OVERBURN
      ? `milestone "${m.id}" has burned ${mb.toFixed(1)}× its budget slice without passing`
      : `run burn (${Math.round(burn * 100)}%) is far ahead of milestone progress (${Math.round(progress * 100)}%)`;
    if (mb > MILESTONE_GIVE_UP) {
      return { action: 'escalate', reason: `${why} — past the ${MILESTONE_GIVE_UP}× give-up line`, milestoneId: m.id };
    }
    if (!this.state.tightenedFor.includes(m.id)) {
      return { action: 'tighten', reason: why, milestoneId: m.id };
    }
    if (this.hasPendingEvidence()) {
      return { action: 'replan', reason: why, milestoneId: m.id };
    }
    return { action: 'none', reason: `${why}, already tightened and no new evidence for a re-plan`, milestoneId: m.id };
  }

  /** The tighten response: drop every not-yet-started OPTIONAL milestone;
   *  drop the current milestone too when it is itself optional and
   *  over-burning (its dependents treat the drop as satisfied). Returns
   *  the dropped ids. Marks the episode so the ladder advances. */
  applyTightening(reason: string): string[] {
    const m = this.current();
    const dropped: string[] = [];
    for (const ms of this.state.milestones) {
      if (ms.status === 'pending' && ms.optional) {
        ms.status = 'dropped';
        dropped.push(ms.id);
        this.emit({ type: 'dropped', milestone: ms, reason });
      }
    }
    if (m && m.optional && m.status === 'active' && this.milestoneBurn(m) > 1) {
      m.status = 'dropped';
      dropped.push(m.id);
      this.emit({ type: 'dropped', milestone: m, reason });
    }
    if (m && !this.state.tightenedFor.includes(m.id)) this.state.tightenedFor.push(m.id);
    this.stats.tightenings++;
    this.touch();
    this.emit({ type: 'tightened', milestoneId: m?.id ?? '', droppedIds: dropped, reason });
    return dropped;
  }

  /** Replace every not-closed milestone with a fresh decomposition of the
   *  remaining work. Passed and dropped milestones are history and are
   *  never rewritten. New slices are derived from the REMAINING budget;
   *  when a replacement reuses the active milestone's id, its spend
   *  carries over (burn accounting stays honest across the re-plan). */
  applyReplan(inputs: MilestoneInput[], trigger: string): ReplanRecord {
    const kept = this.state.milestones.filter((m) => m.status === 'passed' || m.status === 'dropped');
    const replaced = this.state.milestones.filter((m) => m.status !== 'passed' && m.status !== 'dropped');
    const remainingTokens = Math.max(0, this.state.totalBudgetTokens - this.state.spentTokens);
    const remainingTurns = Math.max(0, this.state.totalBudgetTurns - this.state.spentTurns);
    const norm = normalizeMilestoneInputs(inputs);
    const tokenSlices = distribute(remainingTokens, norm.map((x) => x.weight));
    const turnSlices = distribute(remainingTurns, norm.map((x) => x.weight));
    const carried = new Map(replaced.map((m) => [m.id, m]));
    const fresh: Milestone[] = norm.map((x, i) => {
      const prior = carried.get(x.id);
      return {
        ...x,
        budgetTokens: tokenSlices[i],
        budgetTurns: turnSlices[i],
        status: 'pending' as MilestoneStatus,
        attempts: prior?.attempts ?? 0,
        spentTokens: prior?.spentTokens ?? 0,
        spentTurns: prior?.spentTurns ?? 0,
        ...(prior?.lastCheckOutput ? { lastCheckOutput: prior.lastCheckOutput } : {}),
      };
    });
    this.state.milestones = [...kept, ...fresh];
    const record: ReplanRecord = {
      at: Date.now(),
      trigger,
      replacedIds: replaced.map((m) => m.id),
      addedIds: fresh.map((m) => m.id),
    };
    this.state.replans.push(record);
    this.noteEvidence(`replan:${trigger}`);
    this.touch();
    this.emit({ type: 'replanned', record });
    return record;
  }

  markEscalated(reason: string): void {
    this.state.escalatedReason = reason;
    this.stats.escalations++;
    this.touch();
    this.emit({ type: 'escalated', reason });
  }

  // ── Briefs + summaries (the loop injects these verbatim) ─────────────

  private sliceText(m: Milestone): string {
    const parts: string[] = [];
    if (m.budgetTurns > 0) parts.push(`~${m.budgetTurns} turns`);
    if (m.budgetTokens > 0) parts.push(`~${m.budgetTokens} output tokens`);
    return parts.length > 0 ? parts.join(' / ') : 'no fixed slice';
  }

  planOverview(): string {
    const lines = [
      `LONG-TASK PLAN — this task runs under a milestone strategy (${this.state.milestones.length} milestones, each closed by a harness-run check, not by your say-so):`,
      ...this.state.milestones.map((m, i) => {
        const tag = m.status === 'passed' ? ' [PASSED]' : m.status === 'dropped' ? ' [DROPPED]' : m.optional ? ' [optional]' : '';
        return `${i + 1}. ${m.title}${tag} — check: ${describeCheck(m.check)}`;
      }),
      'Rules: work ONE milestone at a time (the current one is briefed below). When you believe the current milestone is complete, end your turn with a plain completion claim and NO tool calls — the harness runs the milestone check itself. A failed check returns its output to you: fix the WORK, not the check. Milestones already PASSED are closed permanently — never redo them.',
    ];
    return lines.join('\n');
  }

  brief(resumed = false): string {
    const m = this.current();
    if (!m) return 'LONG-TASK PLAN: all milestones are closed. Finish the task now.';
    const { index, total } = this.position();
    const lines = [
      `${resumed ? 'RESUMED AT ' : 'CURRENT '}MILESTONE ${index}/${total} — ${m.title}`,
    ];
    if (resumed) {
      const passed = this.state.milestones.filter((x) => x.status === 'passed').map((x) => x.title);
      if (passed.length > 0) {
        lines.push(`Closed in earlier sessions (checkpointed + journaled — do NOT redo): ${passed.join('; ')}.`);
      }
    }
    if (m.detail) lines.push(m.detail);
    lines.push(`Done means this check passes: ${describeCheck(m.check)}.`);
    lines.push(`Budget slice for this milestone: ${this.sliceText(m)} (run so far: ${this.state.spentTurns} turns / ${this.state.spentTokens} output tokens spent).`);
    if (m.attempts > 0 && m.lastCheckOutput) {
      lines.push(`This milestone's check has failed ${m.attempts} time(s). Last output:\n${m.lastCheckOutput.slice(0, 600)}`);
    }
    return lines.join('\n');
  }

  checkFailedMessage(m: Milestone, output: string): string {
    const { index, total } = this.position();
    return (
      `MILESTONE CHECK FAILED — milestone ${index}/${total} ("${m.title}") is NOT closed. The harness ran its check and it failed:\n${output.slice(0, 1200)}\n` +
      'Fix the work so the check passes, then claim completion again. Do not move on to later milestones, and do not edit the check itself — if the check contradicts the task, say so in one line and keep fixing what the TASK requires.'
    );
  }

  tightenMessage(reason: string, droppedIds: string[]): string {
    const m = this.current();
    const parts = [
      `BUDGET PACING — TIGHTEN. ${reason}.`,
      droppedIds.length > 0
        ? `Optional scope dropped to protect the core deliverable: ${droppedIds.join(', ')}. Do not work on dropped milestones.`
        : 'No optional scope remains to drop.',
    ];
    if (m) parts.push(`Focus: finish milestone "${m.title}" — its check is ${describeCheck(m.check)}. Cut exploration and polish; take the shortest path that makes the check pass honestly.`);
    return parts.join(' ');
  }

  /** The precise state summary an escalation (or a curious user) gets:
   *  what is done, what is open, what was spent, what was re-planned and
   *  why, and exactly what remains. */
  stateSummary(header?: string): string {
    const lines: string[] = [];
    if (header) lines.push(header);
    lines.push(`Task: ${this.state.title}`);
    lines.push(
      `Milestones: ${this.passedCount()} passed, ${this.state.milestones.filter((m) => m.status === 'dropped').length} dropped, ` +
      `${this.state.milestones.filter((m) => m.status === 'pending' || m.status === 'active').length} open of ${this.state.milestones.length}.`,
    );
    lines.push(
      `Budget: ${this.state.spentTurns} turns / ${this.state.spentTokens} output tokens spent` +
      `${this.state.totalBudgetTurns > 0 ? ` of ${this.state.totalBudgetTurns} turns` : ''}` +
      `${this.state.totalBudgetTokens > 0 ? ` / ${this.state.totalBudgetTokens} tokens` : ''} budgeted.`,
    );
    for (const m of this.state.milestones) {
      const burn = this.milestoneBurn(m);
      lines.push(
        `- [${m.status}] ${m.title} — spent ${m.spentTurns} turns / ${m.spentTokens} tokens` +
        `${burn > 0 ? ` (${burn.toFixed(1)}× its slice)` : ''}, ${m.attempts} check attempt(s)` +
        `${m.status !== 'passed' && m.status !== 'dropped' ? `; check: ${describeCheck(m.check)}` : ''}`,
      );
      if ((m.status === 'active' || m.status === 'pending') && m.lastCheckOutput) {
        lines.push(`  last check output: ${m.lastCheckOutput.split('\n').slice(0, 3).join(' ').slice(0, 300)}`);
      }
    }
    for (const r of this.state.replans) {
      lines.push(`Re-plan at ${new Date(r.at).toISOString()}: ${r.trigger} (replaced: ${r.replacedIds.join(', ') || 'none'}; added: ${r.addedIds.join(', ') || 'none'}).`);
    }
    return lines.join('\n');
  }

  /** The workspace-checkpoint text written at milestone boundaries and on
   *  escalation — formatted for the existing resume injection, whose
   *  contract is "Continue from 'Next:'". */
  checkpointText(note?: string): string {
    const m = this.current();
    const done = this.state.milestones.filter((x) => x.status === 'passed').map((x) => x.title);
    const lines = [
      `Goal: ${this.state.title}`,
      `Milestone strategy: ${this.passedCount()}/${this.state.milestones.length} milestones passed${note ? ` — ${note}` : ''}.`,
      done.length > 0 ? `Completed milestones: ${done.join('; ')}.` : 'Completed milestones: none yet.',
      m
        ? `Next: Resume at milestone "${m.title}" — ${m.detail || describeCheck(m.check)} Its check: ${describeCheck(m.check)}. Earlier milestones are PASSED and journaled; do not redo them.`
        : 'Next: All milestones passed — run final verification and finish.',
    ];
    return lines.join('\n');
  }
}

// ── Persistence (workspace state dir, beside goals/checkpoints) ──────────

/** State-file path (workspace-relative) for a task's milestone plan. */
export function milestoneStateRelPath(taskId: string): string {
  return `state/milestones-${sanitizeRunId(taskId)}.json`;
}

interface JsonWorkspace {
  readJson<T>(path: string, fallback?: T): T;
  writeJson(path: string, value: unknown): void;
}

export function loadMilestoneState(ws: JsonWorkspace, taskId: string): MilestonePlanState | null {
  try {
    const raw = ws.readJson<MilestonePlanState | null>(milestoneStateRelPath(taskId), null);
    if (!raw || raw.version !== 1 || raw.taskId !== taskId || !Array.isArray(raw.milestones)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveMilestoneState(ws: JsonWorkspace, state: MilestonePlanState): void {
  ws.writeJson(milestoneStateRelPath(state.taskId), state);
}
