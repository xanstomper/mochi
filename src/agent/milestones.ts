// Long-task milestone strategy.
//
// A "complex" run that dies at 90% has nothing to show for it. This module
// decomposes such a run into milestones that each carry a HARNESS-RUN check,
// checkpoints at every passed boundary, and paces budget against verified
// progress instead of hope.
//
// The loop owns every side effect (journal, checkpoint file, system messages);
// MilestoneTracker owns only the decisions and the plan state. The split keeps
// the strategy testable without a model or a workspace.
//
// Honesty rules:
//   - a milestone passes only when its own check command exits 0 under the
//     harness — never on the model's claim;
//   - a milestone with no adjudicable check is rejected at plan time, not
//     silently auto-passed;
//   - budget pacing can only tighten, re-plan, or STOP the run with an
//     explicit checkpointed escalation — never quietly drop work without a
//     'dropped' event.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import type { ChatMessage, Task } from '../types.js';
import type { Workspace } from '../workspace.js';

export type MilestoneStatus = 'pending' | 'active' | 'passed' | 'dropped';

export type MilestoneCheck =
  | { kind: 'command'; command: string }
  /** Kept for state compatibility; a manual check is NEVER adjudicated as a
   *  pass by the harness (runMilestoneCheck returns false with a reason). */
  | { kind: 'manual'; description?: string };

export interface MilestoneInput {
  title: string;
  /** Required. A bare string is normalized to a command check. */
  check?: MilestoneCheck | string;
  /** Optional milestones are the first thing budget pacing drops. */
  optional?: boolean;
  detail?: string;
}

export interface Milestone {
  id: string;
  title: string;
  detail?: string;
  optional: boolean;
  status: MilestoneStatus;
  check: MilestoneCheck;
  attempts: number;
  lastCheckOutput?: string;
  /** Token slice this milestone was planned against (0 = unbudgeted). */
  estTokens: number;
}

export interface MilestoneReplanRecord {
  at: number;
  trigger: string;
  replacedIds: string[];
  addedIds: string[];
}

export interface MilestoneState {
  version: 1;
  taskId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  milestones: Milestone[];
  budget: { tokens: number; turns: number };
  spend: { tokens: number; turns: number };
  replans: MilestoneReplanRecord[];
  escalated?: { reason: string; at: number };
}

export type MilestoneEvent =
  | { type: 'plan'; state: MilestoneState }
  | { type: 'passed'; milestone: Milestone }
  | { type: 'check-failed'; milestone: Milestone; output: string }
  | { type: 'tightened'; reason: string; droppedIds: string[]; milestoneId: string }
  | { type: 'dropped'; milestone: Milestone; reason: string }
  | { type: 'replanned'; record: MilestoneReplanRecord }
  | { type: 'escalated'; reason: string };

export interface PacingVerdict {
  action: 'none' | 'tighten' | 'replan' | 'escalate';
  reason: string;
}

const MAX_MILESTONES = 8;
const MAX_REPLANS = 3;
const REPLAN_COOLDOWN_MS = 60_000;

export interface LongtaskFlags {
  enabled: boolean;
  pacing: boolean;
}

/** Config/env resolution. Default ON (the layer is inert unless the task is
 *  classified complex or a host supplied a plan). `pacing` defaults ON;
 *  MOCHI_LONGTASK=0 / MOCHI_LONGTASK_PACING=0 disable. */
export function resolveLongtaskFlags(config?: { enabled?: boolean; pacing?: boolean } | boolean): LongtaskFlags {
  if (process.env.MOCHI_LONGTASK === '0') return { enabled: false, pacing: false };
  const base = typeof config === 'boolean' ? { enabled: config } : (config ?? {});
  return {
    enabled: base.enabled ?? true,
    pacing: process.env.MOCHI_LONGTASK_PACING === '0' ? false : (base.pacing ?? true),
  };
}

function normalizeCheck(check: MilestoneInput['check']): MilestoneCheck | null {
  if (typeof check === 'string') {
    const command = check.trim();
    return command ? { kind: 'command', command } : null;
  }
  if (check && typeof check === 'object') {
    if (check.kind === 'command' && typeof check.command === 'string' && check.command.trim()) {
      return { kind: 'command', command: check.command.trim() };
    }
    if (check.kind === 'manual') return { kind: 'manual', ...(check.description ? { description: check.description } : {}) };
  }
  return null;
}

/**
 * Build a plan from host/provider-decomposed inputs. Throws when the plan is
 * unusable (empty, or any milestone lacks an adjudicable check) so the loop
 * can fall back to a normal, unwrapped run instead of adopting a plan whose
 * evidence is a model claim.
 */
export function buildMilestonePlan(
  taskId: string,
  title: string,
  inputs: readonly MilestoneInput[],
  budget: { tokens: number; turns: number },
): MilestoneState {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('milestone plan is empty');
  if (inputs.length > MAX_MILESTONES) throw new Error(`milestone plan has ${inputs.length} entries (max ${MAX_MILESTONES})`);
  const slice = budget.tokens > 0 && Number.isFinite(budget.tokens) ? Math.floor(budget.tokens / inputs.length) : 0;
  const milestones: Milestone[] = inputs.map((input, i) => {
    const t = typeof input?.title === 'string' ? input.title.trim() : '';
    if (!t) throw new Error(`milestone ${i + 1} has no title`);
    const check = normalizeCheck(input.check);
    if (!check) throw new Error(`milestone "${t}" has no adjudicable check`);
    if (check.kind === 'manual') throw new Error(`milestone "${t}" uses a manual check, which the harness cannot adjudicate`);
    return {
      id: `ms-${i + 1}`,
      title: t,
      ...(input.detail ? { detail: input.detail } : {}),
      optional: input.optional === true,
      status: 'pending',
      check,
      attempts: 0,
      estTokens: slice,
    };
  });
  const now = Date.now();
  return {
    version: 1,
    taskId,
    title,
    createdAt: now,
    updatedAt: now,
    milestones,
    budget: { tokens: Math.max(0, budget.tokens || 0), turns: Math.max(0, budget.turns || 0) },
    spend: { tokens: 0, turns: 0 },
    replans: [],
  };
}

function milestonesDir(workspace: Pick<Workspace, 'stateDir'>): string {
  return join(workspace.stateDir, 'milestones');
}

function statePath(workspace: Pick<Workspace, 'stateDir'>, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'task';
  return join(milestonesDir(workspace), `${safe}.json`);
}

/** Restore a persisted plan for this task, or null. */
export function loadMilestoneState(workspace: Pick<Workspace, 'stateDir'>, taskId: string): MilestoneState | null {
  const p = statePath(workspace, taskId);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as MilestoneState;
    if (!raw || !Array.isArray(raw.milestones) || raw.milestones.length === 0) return null;
    return {
      ...raw,
      version: 1,
      budget: { tokens: raw.budget?.tokens ?? 0, turns: raw.budget?.turns ?? 0 },
      spend: { tokens: raw.spend?.tokens ?? 0, turns: raw.spend?.turns ?? 0 },
      replans: Array.isArray(raw.replans) ? raw.replans : [],
    };
  } catch {
    return null;
  }
}

/** Persist the plan. Best-effort at call sites, atomic on disk. */
export function saveMilestoneState(workspace: Pick<Workspace, 'stateDir'>, state: MilestoneState): void {
  const dir = milestonesDir(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.updatedAt = Date.now();
  atomicWriteFileSync(statePath(workspace, state.taskId), JSON.stringify(state, null, 2));
}

function idList(ms: readonly Milestone[]): string {
  return ms.length ? ms.map((m) => m.title).join(' → ') : 'none';
}

/** The tracker: decisions over one persisted plan. */
export class MilestoneTracker {
  state: MilestoneState;
  private onEvent: (e: MilestoneEvent) => void;

  constructor(state: MilestoneState, onEvent: (e: MilestoneEvent) => void = () => {}) {
    this.state = state;
    this.onEvent = onEvent;
  }

  private emit(e: MilestoneEvent): void {
    this.state.updatedAt = Date.now();
    try {
      this.onEvent(e);
    } catch {
      /* event sinks never break pacing */
    }
  }

  /** The active milestone, else the first pending one, else null. */
  current(): Milestone | null {
    return this.state.milestones.find((m) => m.status === 'active')
      ?? this.state.milestones.find((m) => m.status === 'pending')
      ?? null;
  }

  /** Make the current milestone active and return it. */
  activate(): Milestone | null {
    const active = this.state.milestones.find((m) => m.status === 'active');
    if (active) return active;
    const next = this.state.milestones.find((m) => m.status === 'pending');
    if (!next) return null;
    next.status = 'active';
    this.state.updatedAt = Date.now();
    return next;
  }

  /** 1-based position of the current milestone among all milestones. */
  position(): { index: number; total: number } {
    const total = this.state.milestones.length;
    const cur = this.current();
    if (!cur) return { index: total, total };
    return { index: this.state.milestones.indexOf(cur) + 1, total };
  }

  passedCount(): number {
    return this.state.milestones.filter((m) => m.status === 'passed').length;
  }

  closedCount(): number {
    return this.state.milestones.filter((m) => m.status === 'passed' || m.status === 'dropped').length;
  }

  allPassed(): boolean {
    return this.state.milestones.every((m) => m.status === 'passed' || m.status === 'dropped');
  }

  /** Human-readable plan, one line per milestone. */
  planOverview(): string {
    const marks: Record<MilestoneStatus, string> = { pending: '·', active: '▶', passed: '✓', dropped: '✗' };
    const lines = this.state.milestones.map((m, i) => {
      const opt = m.optional ? ' (optional)' : '';
      return `${i + 1}. ${marks[m.status]} ${m.title}${opt} — check: ${m.check.kind === 'command' ? m.check.command : 'manual'}`;
    });
    const p = this.position();
    return `Milestone plan (${this.passedCount()}/${this.state.milestones.length} passed, at ${p.index}/${p.total}):\n${lines.join('\n')}`;
  }

  /** Working brief for the model: where it is and what closes this step. */
  brief(resume = false): string {
    const cur = this.current();
    if (!cur) {
      return `MILESTONE PLAN COMPLETE — every milestone is passed or dropped. Proceed to the task-level verification gate.`;
    }
    const remaining = this.state.milestones.filter((m) => m.status === 'pending' && m.id !== cur.id).map((m) => m.title);
    const check = cur.check.kind === 'command' ? cur.check.command : 'manual check';
    return [
      `${resume ? 'RESUMING' : 'CURRENT'} MILESTONE ${cur.id} (${this.position().index}/${this.state.milestones.length}): ${cur.title}`,
      cur.detail ? `Why: ${cur.detail}` : '',
      `Closes when this command exits 0 (the harness runs it — a claim is not evidence): ${check}`,
      remaining.length ? `After that: ${remaining.join(' → ')}` : 'After that: the task-level verification gate.',
      cur.attempts > 0 ? `Previous check attempts for this milestone: ${cur.attempts} — change approach, do not repeat the last one.` : '',
    ].filter(Boolean).join('\n');
  }

  /** Checkpoint text; the resume injection looks for the `Next:` line. */
  checkpointText(note: string): string {
    const passed = this.state.milestones.filter((m) => m.status === 'passed');
    const dropped = this.state.milestones.filter((m) => m.status === 'dropped');
    const cur = this.current();
    return [
      `Long task: ${this.state.title}`,
      note ? `Note: ${note}` : '',
      `Passed: ${idList(passed)}`,
      dropped.length ? `Dropped under pacing: ${idList(dropped)}` : '',
      `Next: ${cur ? `${cur.title}${cur.check.kind === 'command' ? ` — run \`${cur.check.command}\`` : ''}` : 'task-level verification'}`,
      this.planOverview(),
    ].filter(Boolean).join('\n');
  }

  /** Attribute this iteration's spend to the plan. */
  noteSpend(tokens: number, turns: number): void {
    this.state.spend.tokens += Math.max(0, Math.floor(tokens));
    this.state.spend.turns += Math.max(0, Math.floor(turns));
  }

  /**
   * Burn-vs-progress verdict.
   *
   * Progress counts passed+dropped milestones (a dropped optional is settled
   * work, not open work). Burn is the worse of token and turn consumption.
   * Pacing only acts once burn outruns progress by a clear margin, so a
   * well-behaved plan is never interrupted.
   */
  assessPacing(): PacingVerdict {
    if (this.state.escalated) return { action: 'none', reason: 'already escalated' };
    const total = this.state.milestones.length;
    if (total === 0) return { action: 'none', reason: 'no plan' };
    const { tokens: budgetTokens, turns: budgetTurns } = this.state.budget;
    const { tokens: spentTokens, turns: spentTurns } = this.state.spend;

    if (budgetTokens > 0 && spentTokens >= budgetTokens) {
      return { action: 'escalate', reason: `token budget exhausted (${spentTokens}/${budgetTokens})` };
    }
    if (budgetTurns > 0 && spentTurns >= budgetTurns) {
      return { action: 'escalate', reason: `turn budget exhausted (${spentTurns}/${budgetTurns})` };
    }
    const tokenBurn = budgetTokens > 0 ? spentTokens / budgetTokens : 0;
    const turnBurn = budgetTurns > 0 ? spentTurns / budgetTurns : 0;
    const burn = Math.max(tokenBurn, turnBurn);
    const progress = this.closedCount() / total;
    if (burn < progress + 0.35) return { action: 'none', reason: 'burn in line with progress' };

    const optionalOpen = this.state.milestones.some((m) => m.status === 'pending' && m.optional);
    const pct = Math.round(burn * 100);
    if (optionalOpen) {
      return {
        action: 'tighten',
        reason: `${pct}% of budget spent at ${Math.round(progress * 100)}% of milestones closed — dropping optional milestones`,
      };
    }
    const gate = this.gateReplan('pacing');
    if (gate.allowed) {
      return {
        action: 'replan',
        reason: `${pct}% of budget spent at ${Math.round(progress * 100)}% of milestones closed — remaining scope must be re-decomposed`,
      };
    }
    if (burn >= 0.9) {
      return { action: 'escalate', reason: `${pct}% of budget spent with ${total - this.closedCount()} milestone(s) still open` };
    }
    return { action: 'none', reason: 'burn high but no safe adjustment available' };
  }

  /** Drop optional pending milestones. Returns the dropped ids. */
  applyTightening(reason: string): string[] {
    const dropped: Milestone[] = [];
    for (const m of this.state.milestones) {
      if (m.status === 'pending' && m.optional) {
        m.status = 'dropped';
        dropped.push(m);
      }
    }
    const droppedIds = dropped.map((m) => m.id);
    this.emit({ type: 'tightened', reason, droppedIds, milestoneId: this.current()?.id ?? '' });
    for (const m of dropped) this.emit({ type: 'dropped', milestone: m, reason });
    return droppedIds;
  }

  tightenMessage(reason: string, droppedIds: string[]): string {
    const dropped = droppedIds.length
      ? this.state.milestones.filter((m) => droppedIds.includes(m.id)).map((m) => m.title)
      : [];
    return [
      `BUDGET PACING — ${reason}.`,
      dropped.length ? `Dropped optional milestones: ${dropped.join(', ')}.` : 'No optional milestones were left to drop.',
      'Focus every remaining turn on the CURRENT milestone\'s check. Do not start new scope.',
      this.brief(),
    ].join('\n');
  }

  /** Directive injected when the current milestone's check failed. */
  checkFailedMessage(m: Milestone, output: string): string {
    const check = m.check.kind === 'command' ? `\`${m.check.command}\`` : 'manual check';
    return [
      `MILESTONE CHECK FAILED — "${m.title}" did not pass (attempt ${m.attempts}).`,
      `The harness ran ${check} and it did not exit 0. The model's claim of completion is not evidence; this command is.`,
      output.trim() ? `Output (tail):\n${output.trim().slice(-1500)}` : '',
      m.attempts >= 2
        ? 'This check has failed repeatedly. If the check itself encodes a wrong assumption about the task, the plan needs re-decomposition — otherwise change approach rather than repeating the last edit.'
        : 'Read the failure output, fix the actual cause, and run the check again.',
      this.brief(),
    ].filter(Boolean).join('\n\n');
  }

  /** Record a harness-run check result. Returns the milestone when it closed. */
  recordCheck(passed: boolean, output: string): Milestone | null {
    const m = this.current();
    if (!m) return null;
    m.attempts++;
    m.lastCheckOutput = output.slice(0, 4_000);
    this.state.updatedAt = Date.now();
    if (passed) {
      m.status = 'passed';
      this.emit({ type: 'passed', milestone: m });
      return m;
    }
    this.emit({ type: 'check-failed', milestone: m, output: output.slice(0, 2_000) });
    return null;
  }

  /** Evidence-gated re-plan: at most MAX_REPLANS, one per cooldown window. */
  gateReplan(source: string): { allowed: boolean; reason: string } {
    if (this.state.replans.length >= MAX_REPLANS) {
      return { allowed: false, reason: `re-plan budget exhausted (${MAX_REPLANS})` };
    }
    const last = this.state.replans[this.state.replans.length - 1];
    if (last && Date.now() - last.at < REPLAN_COOLDOWN_MS) {
      return { allowed: false, reason: 're-plan cooldown still active' };
    }
    if (!this.state.milestones.some((m) => m.status === 'pending' || m.status === 'active')) {
      return { allowed: false, reason: 'no open milestones to re-plan' };
    }
    return { allowed: true, reason: `${source} (re-plan ${this.state.replans.length + 1}/${MAX_REPLANS})` };
  }

  /** Replace the open tail of the plan with `inputs`, preserving closed work. */
  applyReplan(inputs: readonly MilestoneInput[], source: string): void {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('re-plan is empty');
    if (inputs.length > MAX_MILESTONES) throw new Error(`re-plan has ${inputs.length} entries (max ${MAX_MILESTONES})`);
    const replaced = this.state.milestones.filter((m) => m.status === 'pending' || m.status === 'active');
    if (replaced.length === 0) throw new Error('no open milestones to replace');
    const closed = this.state.milestones.filter((m) => m.status === 'passed' || m.status === 'dropped');
    const rebuilt = buildMilestonePlan(this.state.taskId, this.state.title, inputs, this.state.budget);
    // Renumber so ids stay unique across the whole plan.
    const start = closed.length;
    const added = rebuilt.milestones.map((m, i) => ({ ...m, id: `ms-${start + i + 1}` }));
    this.state.milestones = [...closed, ...added];
    const record: MilestoneReplanRecord = {
      at: Date.now(),
      trigger: source,
      replacedIds: replaced.map((m) => m.id),
      addedIds: added.map((m) => m.id),
    };
    this.state.replans.push(record);
    this.state.updatedAt = record.at;
    this.emit({ type: 'replanned', record });
  }

  /** Mark the run stopped by pacing. */
  markEscalated(reason: string): void {
    this.state.escalated = { reason, at: Date.now() };
    this.emit({ type: 'escalated', reason });
  }

  /** Final summary handed to the model/user when the run stops early. */
  stateSummary(message: string): string {
    const p = this.position();
    return [
      message,
      `Progress: ${this.passedCount()}/${this.state.milestones.length} milestones passed (at ${p.index}/${p.total}).`,
      this.planOverview(),
      this.checkpointText(message),
    ].join('\n\n');
  }
}

/** Run one milestone check harness-side. */
export async function runMilestoneCheck(
  check: MilestoneCheck,
  _cwd: string,
  runShell: (command: string, timeoutSecs?: number) => Promise<string>,
): Promise<{ passed: boolean; output: string }> {
  if (check.kind !== 'command') {
    return {
      passed: false,
      output: 'This milestone has a manual check, which the harness cannot adjudicate. Something is wrong with the plan — the task-level verification gate remains the judge.',
    };
  }
  let output = '';
  try {
    output = await runShell(check.command, 120);
  } catch (e) {
    return { passed: false, output: e instanceof Error ? e.message : String(e) };
  }
  const exit = /(?:^|\n)exit_code:\s*(-?\d+)/.exec(output);
  const passed = exit !== null && Number(exit[1]) === 0 && !/\[command timed out/i.test(output);
  return { passed, output };
}

// ── Provider decomposition ────────────────────────────────────────────────

/** Extract the first JSON array of milestone objects from model output. */
export function parseMilestonePlan(text: string): MilestoneInput[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: MilestoneInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    const check = typeof e.check === 'string'
      ? e.check
      : (e.check && typeof e.check === 'object' ? (e.check as MilestoneCheck) : undefined);
    if (!check) continue; // unverifiable milestone: refuse the whole entry
    out.push({
      title,
      check,
      optional: e.optional === true,
      ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
    });
    if (out.length >= MAX_MILESTONES) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Ask the configured model to decompose the task into milestones. Returns
 * null on any failure or unusable output; the caller then runs unwrapped.
 */
export async function planMilestonesWithChat(
  task: Pick<Task, 'title' | 'description'>,
  chat: (messages: ChatMessage[]) => Promise<{ content?: string }>,
  opts?: { remainingTitles?: string[]; evidence?: string[] },
): Promise<MilestoneInput[] | null> {
  const system = [
    'You decompose a coding task into a short milestone plan.',
    'Each milestone MUST carry a shell `check` command that exits 0 only when that milestone is genuinely done.',
    'Checks are run by a harness in the repo root; they must be fast (< 120s), deterministic, and non-interactive.',
    'Prefer 3-6 milestones. Mark speculative or nice-to-have milestones "optional": true.',
    'Do NOT include a final "run the whole test suite" milestone unless the task asks for it.',
    'Reply with ONLY a JSON array. Each element: {"title": string, "check": string, "optional"?: boolean, "detail"?: string}.',
  ].join('\n');
  const user = [
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
    opts?.remainingTitles?.length ? `Already completed in a previous session: ${opts.remainingTitles.join(', ')}` : '',
    opts?.evidence?.length ? `Evidence to account for:\n- ${opts.evidence.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
  try {
    const res = await chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ] as ChatMessage[]);
    return parseMilestonePlan(res.content ?? '');
  } catch {
    return null;
  }
}
