// Per-run usage/cost telemetry sidecar (D1): every goal run that produces a
// rig result file also writes ONE JSON usage file next to its trace —
// tokens (input / output / cache-read where the provider reports them),
// api_calls, exit reason, per-aux breakdown (subagents / tools / other
// harness-tracked aux work), plus model, provider, start/end timestamps and
// duration. This is the fuel cost-per-solve and token-overhead measurement
// run on (the Hermes distillation Phase 3 fix, ported to Mochi).
//
// Design rules (same honesty standard as trace-cost.ts / budget.ts):
//  - The sidecar is built from per-call `usage:updated` events the loop
//    already emits on the shared EventBus (every Agent — main task agents,
//    review agents, subagent children — emits under its own agentId), plus
//    the run's terminal event. No new accounting channel: extending the
//    TraceRecorder pattern, not duplicating it.
//  - A field the provider/path genuinely did not report is recorded as
//    explicitly unavailable — { unavailable: true, reason } — never silently
//    omitted and never invented as a 0. A sum over observed events that
//    happens to be 0 is a measurement and stays a number.
//  - Secret redaction reuses security.redact() over the serialized JSON
//    (the same call UsageStore.save makes), so credential-shaped values
//    never reach the file.
//  - Writes are best-effort and local-only under <workspace>/usage/ (the
//    .mochi tree is gitignored): telemetry must never break a run and
//    sidecars never leave the machine through this code path.
//  - Consumers that never read a sidecar are unaffected: the write is one
//    small file at run end, off the hot path.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact } from '../security/security.js';
import { costFromTraceEntries } from './trace-cost.js';
import type { EventBus } from '../events.js';
import type { MochiEvent } from '../types.js';

/** A field that could not be measured on this path, with the reason why. */
export interface Unavailable { unavailable: true; reason: string }

/** A measured quantity: a number, or an explicit unavailability record. */
export type Measured = number | Unavailable;

/** A descriptive field: a string, or an explicit unavailability record. */
export type Described = string | Unavailable;

const unavailable = (reason: string): Unavailable => ({ unavailable: true, reason });

export interface SubagentUsageRow {
  agentId: string;
  role?: string;
  /** Billed model calls by this child that reported a usage object. */
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  /** False when this child emitted no per-call usage events at all — its
   *  zeros mean "nothing reported", not "nothing spent". */
  usageReported: boolean;
}

export interface SidecarCost {
  /** Provider-REPORTED dollars summed over the run's billed calls. */
  reported: number;
  /** Offline price-table estimate for calls the provider reported $0/no
   *  billing on (ledgered separately — never presented as reported). */
  estimated: number;
  source: 'provider' | 'estimated' | 'mixed' | 'none';
  /** False when some call could be neither reported nor priced. */
  complete: boolean;
}

export interface UsageSidecar {
  kind: 'mochi-usage-sidecar';
  version: 1;
  runId: string;
  model: Described;
  provider: Described;
  /** ISO timestamps bracketing the observed run (first/last event seen). */
  startedAt: Described;
  endedAt: Described;
  durationMs: Measured;
  /** Why the run ended: goal status (+ first failed task's failure reason),
   *  the loop's stop reason, or an explicit unavailability. */
  exitReason: Described;
  success: boolean | Unavailable;
  usage: {
    apiCalls: Measured;
    inputTokens: Measured;
    outputTokens: Measured;
    cacheReadTokens: Measured;
    totalTokens: Measured;
    costUsd: SidecarCost | Unavailable;
  };
  auxiliary: {
    subagents: {
      count: number;
      apiCalls: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
      costUsd: number;
      children: SubagentUsageRow[];
    } | Unavailable;
    tools: { calls: number; byTool: Record<string, number> } | Unavailable;
    /** Billed model calls the budget ledger recorded that never surfaced a
     *  per-call usage event (decompose/analysis work, calls that failed
     *  before the provider returned usage). Count only — their token split
     *  is genuinely unknown. */
    other: { apiCalls: number; note: string } | Unavailable;
  };
  /** Main + subagent usage combined (what one solve actually cost). */
  totalIncludingAuxiliary: {
    apiCalls: Measured;
    inputTokens: Measured;
    outputTokens: Measured;
    cacheReadTokens: Measured;
    totalTokens: Measured;
    costUsd: SidecarCost | Unavailable;
  };
  notes: string[];
}

/** The subset of GoalResult the sidecar needs (structural, so tests and the
 *  endurance runner can pass shapes without importing the goal engine). */
export interface SidecarGoalResult {
  success?: boolean;
  goal?: { id?: string; status?: string };
  tokensUsed?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  costUsd?: number;
  modelCalls?: number;
  durationMs?: number;
  failedTasks?: Array<{ attempts?: Array<{ failureReason?: string }> }>;
}

export interface SidecarFinishInfo {
  goalResult?: SidecarGoalResult | null;
  /** Direct exit-reason override (loop stopReason / team status) when no
   *  GoalResult is available on the path. */
  exitReason?: string;
  success?: boolean;
  durationMs?: number;
}

interface CallRecord {
  t: number;
  agentId: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  cacheMeasured?: boolean;
}

interface SubagentStart { agentId: string; role?: string }

/** Accumulates per-call usage off the shared EventBus and writes the sidecar
 *  JSON at run end. Attach alongside the run's TraceRecorder; call finish()
 *  with the GoalResult when the path has one (enriches exit reason, success,
 *  duration and the budget-ledger call count), close() always — a close
 *  without finish still writes the sidecar with the exit reason marked
 *  explicitly unavailable (crash/abort before the run completed). */
export class UsageSidecarRecorder {
  private readonly workspaceDir: string;
  private readonly runId: string;
  private readonly meta: { model?: string; provider?: string };
  private off: (() => void) | null = null;
  private disposed = false;
  private finished = false;
  private startedAt: number | null = null;
  private lastEventAt: number | null = null;
  private firstModel?: string;
  private mainCalls = 0;
  private mainInput = 0;
  private mainOutput = 0;
  private mainCacheRead = 0;
  private mainTotal = 0;
  private mainCost = 0;
  private mainCacheMeasured = false;
  private readonly calls: CallRecord[] = [];
  private readonly subagentStarts = new Map<string, SubagentStart>();
  private readonly childUsage = new Map<string, SubagentUsageRow>();
  private toolCalls = 0;
  private readonly byTool = new Map<string, number>();
  private observedExit: { reason: string; success: boolean | null } | null = null;

  constructor(workspaceDir: string, runId: string, meta: { model?: string; provider?: string } = {}) {
    this.workspaceDir = workspaceDir;
    this.runId = runId;
    this.meta = meta;
  }

  attach(events: EventBus): this {
    this.off = events.onAll((e: MochiEvent) => this.observe(e));
    return this;
  }

  private observe(e: MochiEvent): void {
    if (this.disposed) return;
    const now = Date.now();
    if (this.startedAt === null) this.startedAt = now;
    this.lastEventAt = now;
    const rec = e as unknown as Record<string, unknown>;
    switch (e.type) {
      case 'usage:updated': {
        if (this.firstModel === undefined && typeof rec.model === 'string') this.firstModel = rec.model;
        const row: CallRecord = {
          t: now,
          agentId: String(rec.agentId ?? ''),
          ...(typeof rec.model === 'string' ? { model: rec.model } : {}),
          ...(typeof rec.inputTokens === 'number' ? { inputTokens: rec.inputTokens } : {}),
          ...(typeof rec.outputTokens === 'number' ? { outputTokens: rec.outputTokens } : {}),
          ...(typeof rec.cacheTokens === 'number' ? { cacheTokens: rec.cacheTokens } : {}),
          ...(typeof rec.totalTokens === 'number' ? { totalTokens: rec.totalTokens } : {}),
          ...(typeof rec.costUsd === 'number' ? { costUsd: rec.costUsd } : {}),
          ...(typeof rec.cacheMeasured === 'boolean' ? { cacheMeasured: rec.cacheMeasured } : {}),
        };
        this.calls.push(row);
        if (this.subagentStarts.has(row.agentId)) {
          const agg = this.childUsage.get(row.agentId) ?? {
            agentId: row.agentId,
            role: this.subagentStarts.get(row.agentId)?.role,
            apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0, usageReported: false,
          };
          agg.apiCalls += 1;
          agg.inputTokens += row.inputTokens ?? 0;
          agg.outputTokens += row.outputTokens ?? 0;
          agg.cacheReadTokens += row.cacheTokens ?? 0;
          agg.totalTokens += row.totalTokens ?? 0;
          agg.costUsd += row.costUsd ?? 0;
          agg.usageReported = true;
          if (agg.role === undefined && this.subagentStarts.get(row.agentId)?.role !== undefined) {
            agg.role = this.subagentStarts.get(row.agentId)?.role;
          }
          this.childUsage.set(row.agentId, agg);
        } else {
          this.mainCalls += 1;
          this.mainInput += row.inputTokens ?? 0;
          this.mainOutput += row.outputTokens ?? 0;
          this.mainCacheRead += row.cacheTokens ?? 0;
          this.mainTotal += row.totalTokens ?? 0;
          this.mainCost += row.costUsd ?? 0;
          if (row.cacheMeasured) this.mainCacheMeasured = true;
        }
        break;
      }
      case 'subagent:started':
        this.subagentStarts.set(String(rec.agentId ?? ''), { agentId: String(rec.agentId ?? ''), role: typeof rec.role === 'string' ? rec.role : undefined });
        break;
      case 'tool:called': {
        this.toolCalls += 1;
        const tool = typeof rec.tool === 'string' ? rec.tool : 'unknown';
        this.byTool.set(tool, (this.byTool.get(tool) ?? 0) + 1);
        break;
      }
      case 'task:completed':
        this.observedExit = { reason: 'completed', success: true };
        break;
      case 'task:failed':
        this.observedExit = { reason: `failed: ${typeof rec.reason === 'string' ? rec.reason : 'task failed'}`.slice(0, 300), success: false };
        break;
      default:
        break;
    }
  }

  /** Build the sidecar and write it. Best-effort: returns the written path
   *  or null (never throws — telemetry must not break the run). */
  finish(info: SidecarFinishInfo = {}): string | null {
    if (this.finished || this.disposed) return null;
    this.finished = true;
    const sidecar = this.build(info);
    return writeUsageSidecar(this.workspaceDir, this.runId, sidecar);
  }

  /** Detach from the bus. A close() without finish() writes the sidecar with
   *  the exit reason explicitly unavailable (the run ended without a finish
   *  record), so killed/aborted runs still leave an honest telemetry file. */
  close(): void {
    if (this.off) { this.off(); this.off = null; }
    this.disposed = true;
    if (!this.finished) {
      this.finished = true;
      try {
        const sidecar = this.build({});
        writeUsageSidecar(this.workspaceDir, this.runId, sidecar);
      } catch { /* telemetry never breaks the run */ }
    }
  }

  /** Pure assembly of the sidecar document from what was observed. */
  build(info: SidecarFinishInfo): UsageSidecar {
    const noEvents = this.calls.length === 0;
    const mainHasEvents = this.mainCalls > 0;
    const notes: string[] = [];

    const model = this.firstModel ?? this.meta.model ?? unavailable('no billed call reported a model id and no model was configured');
    const provider = this.meta.provider ?? unavailable('provider not configured on this path');

    const startedAt: Described = this.startedAt !== null ? new Date(this.startedAt).toISOString() : unavailable('no events were observed for this run');
    const endedAt: Described = this.lastEventAt !== null ? new Date(this.lastEventAt).toISOString() : unavailable('no events were observed for this run');

    // Exit reason: the explicit finish info wins (GoalResult / loop stop
    // reason), else the last terminal event seen on the bus.
    let exitReason: Described;
    if (info.exitReason !== undefined) {
      exitReason = info.exitReason;
    } else if (info.goalResult) {
      const status = info.goalResult.goal?.status;
      const failure = info.goalResult.failedTasks?.[0]?.attempts?.at(-1)?.failureReason;
      exitReason = status ?? unavailable('run result carried no goal status');
      if (failure) exitReason = `${exitReason}: ${failure}`;
    } else if (this.observedExit) {
      exitReason = this.observedExit.reason;
    } else {
      exitReason = unavailable('no terminal event and no run result reached the recorder');
    }

    let success: boolean | Unavailable;
    if (info.goalResult?.success !== undefined) success = info.goalResult.success;
    else if (info.success !== undefined) success = info.success;
    else if (this.observedExit?.success !== null && this.observedExit?.success !== undefined) success = this.observedExit.success;
    else success = unavailable('no terminal outcome was observed for this run');

    const durationMs: Measured = info.durationMs !== undefined
      ? info.durationMs
      : this.startedAt !== null && this.lastEventAt !== null
        ? Math.max(0, this.lastEventAt - this.startedAt)
        : info.goalResult?.durationMs !== undefined
          ? info.goalResult.durationMs
          : unavailable('no run duration was observable (no events, no run result)');

    // Cost: the MAIN bucket is priced from the main bucket's own calls; the
    // total (below) folds subagent calls too. Reported vs estimated stay
    // separate (trace-cost's honesty rule).
    const mainRecords = this.calls.filter((c) => !this.subagentStarts.has(c.agentId));
    const toCost = (records: CallRecord[]): SidecarCost | Unavailable => {
      if (records.length === 0) return unavailable('no billed call reported a usage object on this run');
      const s = costFromTraceEntries(records.map((c) => ({ kind: 'usage:updated' as const, ...c })));
      return { reported: s.providerCostUsd, estimated: s.estimatedCostUsd, source: s.costSource, complete: s.complete };
    };
    const usageCost = toCost(mainRecords);

    const childRows = [...this.childUsage.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    const childAgg = {
      count: this.subagentStarts.size,
      apiCalls: childRows.reduce((s, r) => s + r.apiCalls, 0),
      inputTokens: childRows.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: childRows.reduce((s, r) => s + r.outputTokens, 0),
      cacheReadTokens: childRows.reduce((s, r) => s + r.cacheReadTokens, 0),
      totalTokens: childRows.reduce((s, r) => s + r.totalTokens, 0),
      costUsd: childRows.reduce((s, r) => s + r.costUsd, 0),
      children: childRows.slice(0, 200),
    };
    if (childRows.length > 200) notes.push(`subagent children list capped at 200 rows (sums cover all ${childRows.length}); the totalIncludingAuxiliary sums are complete`);

    const subagents = noEvents
      ? unavailable('no events were observed for this run — subagent usage cannot be attributed')
      : (this.subagentStarts.size === 0
        ? { count: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0, children: [] }
        : childAgg);

    const tools = noEvents
      ? unavailable('no events were observed for this run — tool calls cannot be counted')
      : { calls: this.toolCalls, byTool: Object.fromEntries([...this.byTool.entries()].sort((a, b) => b[1] - a[1])) };

    // api_calls: the harness's own ledger count when the path supplied one,
    // else the count of billed calls that reported usage. Never fabricated
    // when neither exists. When the two disagree, both are stated.
    const billedCalls = this.calls.length;
    const ledgerCalls = info.goalResult?.modelCalls;
    let apiCalls: Measured;
    if (typeof ledgerCalls === 'number' && Number.isFinite(ledgerCalls)) {
      apiCalls = ledgerCalls;
      if (ledgerCalls !== billedCalls) {
        notes.push(`apiCalls ${ledgerCalls} is the budget-ledger count of planned model calls (main agent's engine); ${billedCalls} billed call(s) reported per-call usage on the bus`);
      }
    } else if (billedCalls > 0) {
      apiCalls = billedCalls;
      notes.push('apiCalls counts billed calls that reported usage (no budget ledger on this path)');
    } else {
      apiCalls = unavailable('no budget ledger and no billed call reported usage on this path');
    }

    const tokens = (v: number, has: boolean): Measured => (has ? v : unavailable('no billed call reported a usage object on this run (provider reported nothing, the call chain never surfaced usage, or the events were not observed)'));
    const cacheRead: Measured = noEvents
      ? unavailable('no billed call reported a usage object on this run')
      : this.mainCacheMeasured
        ? this.mainCacheRead
        : unavailable('provider did not report cache tokens on any billed call of this run');

    const usage = {
      apiCalls,
      inputTokens: tokens(this.mainInput, mainHasEvents),
      outputTokens: tokens(this.mainOutput, mainHasEvents),
      cacheReadTokens: cacheRead,
      totalTokens: tokens(this.mainTotal, mainHasEvents),
      costUsd: usageCost,
    };

    // "Other" aux: budget-ledger calls beyond the billed calls observed on
    // the bus. A count difference of two harness counters — the token split
    // of those calls is genuinely unknown and is not invented.
    let other: { apiCalls: number; note: string } | Unavailable;
    if (typeof ledgerCalls === 'number' && Number.isFinite(ledgerCalls)) {
      const mainPlusReview = this.mainCalls;
      const unattributed = ledgerCalls - mainPlusReview;
      if (unattributed >= 0) {
        other = {
          apiCalls: unattributed,
          note: 'budget-ledger model calls with no per-call usage event observed (analysis/decompose work or calls that failed before usage was returned); token split not reported by the harness for these',
        };
      } else {
        other = unavailable(`budget ledger (${ledgerCalls}) and billed usage events (${mainPlusReview}) disagree; unattributed count refused rather than invented`);
      }
    } else {
      other = unavailable('no budget ledger on this path — unattributed harness-internal calls cannot be counted');
    }

    const totalHasEvents = mainHasEvents || childAgg.apiCalls > 0;
    const totalIncludingAuxiliary = {
      apiCalls: typeof apiCalls === 'number'
        ? apiCalls + (typeof subagents === 'object' && !('unavailable' in subagents) ? subagents.apiCalls : 0)
        : unavailable('no API-call count was measurable for this run'),
      inputTokens: totalHasEvents
        ? this.mainInput + childAgg.inputTokens
        : unavailable('no billed call reported a usage object on this run'),
      outputTokens: totalHasEvents
        ? this.mainOutput + childAgg.outputTokens
        : unavailable('no billed call reported a usage object on this run'),
      cacheReadTokens: this.mainCacheMeasured || childRows.some((r) => r.cacheReadTokens > 0)
        ? this.mainCacheRead + childAgg.cacheReadTokens
        : unavailable('provider did not report cache tokens on any billed call of this run'),
      totalTokens: totalHasEvents
        ? this.mainTotal + childAgg.totalTokens
        : unavailable('no billed call reported a usage object on this run'),
      costUsd: toCost(this.calls),
    };
    if (typeof ledgerCalls === 'number' && Number.isFinite(ledgerCalls) && ledgerCalls !== this.mainCalls) {
      notes.push('totalIncludingAuxiliary token sums cover billed calls that reported usage; calls without usage events (see auxiliary.other) contribute their count but no tokens');
    }

    return {
      kind: 'mochi-usage-sidecar',
      version: 1,
      runId: this.runId,
      model,
      provider,
      startedAt,
      endedAt,
      durationMs,
      exitReason,
      success,
      usage,
      auxiliary: { subagents, tools, other },
      totalIncludingAuxiliary,
      notes,
    };
  }
}

/** Write the sidecar JSON next to the run's trace: <workspace>/usage/<runId>.json.
 *  Redacted (credential-shaped values never land), best-effort, local-only —
 *  the .mochi tree is gitignored. Returns the path written, or null. */
export function writeUsageSidecar(workspaceDir: string, runId: string, sidecar: UsageSidecar): string | null {
  try {
    const dir = resolve(workspaceDir, 'usage');
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    writeFileSync(file, redact(JSON.stringify(sidecar, null, 2)) + '\n', 'utf8');
    try { pruneUsageSidecars(workspaceDir); } catch { /* retention is best-effort */ }
    return file;
  } catch {
    return null;
  }
}

/** Read one sidecar back. Null when absent/corrupt — never throws. */
export function readUsageSidecar(workspaceDir: string, runId: string): UsageSidecar | null {
  const file = resolve(workspaceDir, 'usage', `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  return parseSidecarFile(file);
}

function parseSidecarFile(file: string): UsageSidecar | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as UsageSidecar;
    if (parsed?.kind !== 'mochi-usage-sidecar') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The newest sidecar in a workspace (by endedAt, falling back to file
 *  mtime). One spawned mochi process writes exactly one goal-run sidecar;
 *  workdirs reused across runs take the latest. Null when none. */
export function newestUsageSidecar(workspaceDir: string): UsageSidecar | null {
  const dir = resolve(workspaceDir, 'usage');
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
  let best: { sidecar: UsageSidecar; key: string } | null = null;
  for (const f of files) {
    const p = resolve(dir, f);
    const sidecar = parseSidecarFile(p);
    if (!sidecar) continue;
    const key = typeof sidecar.endedAt === 'string' ? sidecar.endedAt : String(statSync(p).mtimeMs);
    if (!best || key > best.key) best = { sidecar, key };
  }
  return best?.sidecar ?? null;
}

/** Numeric view of a sidecar field for consumers that cannot represent
 *  unavailability: a number, or null (unknown — never a fabricated 0). */
export function measuredNumber(v: Measured | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Total tokens INCLUDING auxiliary work, or null when unmeasured. */
export function sidecarTotalTokens(sidecar: UsageSidecar): number | null {
  return measuredNumber(sidecar.totalIncludingAuxiliary.totalTokens);
}

/** Effective cost (provider-reported + estimated) of the WHOLE run including
 *  auxiliary work, when the run's pricing was complete; null when unmeasured
 *  or incomplete — never a partial sum. */
export function sidecarCostUsd(sidecar: UsageSidecar): number | null {
  const c = sidecar.totalIncludingAuxiliary.costUsd ?? sidecar.usage.costUsd;
  if (!c || 'unavailable' in c || !c.complete) return null;
  return c.reported + c.estimated;
}

/** Retention for <workspace>/usage: keep the newest `maxFiles` sidecars,
 *  oldest first out. Best-effort; returns files removed. */
export function pruneUsageSidecars(workspaceDir: string, maxFiles = 200): number {
  let removed = 0;
  try {
    const dir = resolve(workspaceDir, 'usage');
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = resolve(dir, f);
        try { return { p, mtime: statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { p: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = maxFiles; i < files.length; i++) {
      try { unlinkSync(files[i].p); removed++; } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  return removed;
}
