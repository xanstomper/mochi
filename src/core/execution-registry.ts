// Execution Registry — the single authority for "has this work already been
// done / is it already running?" (master rebuild Phases 3 & 4).
//
// Two bug classes this eliminates:
//  1. Duplicate execution: the same tool/command arriving twice in quick
//     succession (model retry, event replay, double consumer) ran twice.
//     Within a short window an identical request is recognized and the
//     original execution is reused — the command executes ONCE.
//  2. Replay after completion: a caller presenting an executionId that already
//     completed gets the cached result instead of a fresh run (idempotency).
//
// All maps are bounded (drop-oldest by insertion order) so a long-lived agent
// process cannot leak memory no matter how many tool calls it makes.

import { randomUUID } from 'node:crypto';

export interface ExecutionRequest {
  /** Logical work identity: tool name + normalized arguments. */
  toolName: string;
  args: Record<string, unknown>;
  /** Caller-supplied execution id (e.g. the model's tool_call_id). */
  executionId?: string;
}

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'canceled';

export interface ExecutionRecord {
  executionId: string;
  toolName: string;
  argsKey: string;
  status: ExecutionStatus;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  /** Cached result payload for idempotent replay of completed work. */
  result?: unknown;
  duplicate?: boolean;
}

export interface RegistryOptions {
  /** Window (ms) in which an identical (toolName,args) request is treated as
   *  a duplicate of the in-flight/recent execution. Default 1500ms. */
  dedupeWindowMs?: number;
  /** Max completed records retained for replay. Default 500. */
  completedLimit?: number;
  /** Max concurrent tracked executions before the oldest is reaped. Default 200. */
  activeLimit?: number;
}

/** Stable identity for a request's arguments: object keys are sorted
 *  recursively so key order can never change a request's identity. */
export function argsKey(args: Record<string, unknown>): string {
  try {
    return stableStringify(args);
  } catch {
    // Circular or otherwise unserializable args: fall back to a shallow key.
    return `unserializable:${Object.keys(args).sort().join(',')}`;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v !== 'function' && typeof v !== 'symbol')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export class ExecutionRegistry {
  private readonly dedupeWindowMs: number;
  private readonly completedLimit: number;
  private readonly activeLimit: number;
  private readonly active = new Map<string, ExecutionRecord>();
  private readonly completed = new Map<string, ExecutionRecord>();
  /** (toolName + argsKey) -> executionId, for duplicate detection. */
  private readonly bySignature = new Map<string, string>();
  private counters = { duplicatesPrevented: 0, replaysServed: 0, canceled: 0, registered: 0 };

  constructor(opts: RegistryOptions = {}) {
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 1500;
    this.completedLimit = opts.completedLimit ?? 500;
    this.activeLimit = opts.activeLimit ?? 200;
  }

  /**
   * Register an execution request. Returns the record to act on:
   *  - duplicate=true -> do NOT execute; reuse record.executionId / result
   *  - otherwise      -> execute, then markCompleted/markFailed/markCanceled
   */
  register(request: ExecutionRequest): ExecutionRecord {
    const key = `${request.toolName}\u0000${argsKey(request.args)}`;
    this.counters.registered++;

    // 1. Explicit replay: a completed executionId presented again serves the
    //    cached result — never re-executes (idempotency).
    if (request.executionId) {
      const done = this.completed.get(request.executionId);
      if (done) {
        this.counters.replaysServed++;
        return { ...done, duplicate: true };
      }
    }

    // 2. Dedupe: identical signature within the window (in-flight OR just
    //    finished) reuses the original execution.
    const priorId = this.bySignature.get(key);
    if (priorId) {
      const prior = this.active.get(priorId) ?? this.completed.get(priorId);
      if (prior) {
        const finishedAgo = prior.finishedAt !== undefined ? Date.now() - prior.finishedAt : 0;
        const inWindow = prior.status === 'running' || finishedAgo < this.dedupeWindowMs;
        if (inWindow) {
          this.counters.duplicatesPrevented++;
          return { ...prior, attempt: prior.attempt + 1, duplicate: true };
        }
      }
    }

    // 3. Fresh execution.
    const executionId = request.executionId ?? randomUUID();
    const rec: ExecutionRecord = {
      executionId,
      toolName: request.toolName,
      argsKey: key,
      status: 'running',
      attempt: 1,
      startedAt: Date.now(),
    };
    this.active.set(executionId, rec);
    this.bySignature.set(key, executionId);

    // Bound active executions: reap the oldest (FIFO by insertion order).
    while (this.active.size > this.activeLimit) {
      const oldest = this.active.keys().next().value;
      if (oldest === undefined) break;
      const old = this.active.get(oldest);
      this.active.delete(oldest);
      if (old && old.status === 'running') this.counters.canceled++;
    }
    return rec;
  }

  markCompleted(executionId: string, result: unknown): void {
    const rec = this.active.get(executionId);
    if (!rec) return;
    rec.status = 'completed';
    rec.finishedAt = Date.now();
    rec.result = result;
    this.active.delete(executionId);
    this.completed.set(executionId, rec);
    this.trimCompleted();
  }

  markFailed(executionId: string, error: unknown): void {
    const rec = this.active.get(executionId);
    if (!rec) return;
    rec.status = 'failed';
    rec.finishedAt = Date.now();
    rec.result = { error: error instanceof Error ? error.message : String(error) };
    this.active.delete(executionId);
    this.completed.set(executionId, rec);
    this.trimCompleted();
  }

  markCanceled(executionId: string): void {
    const rec = this.active.get(executionId);
    if (!rec) return;
    rec.status = 'canceled';
    rec.finishedAt = Date.now();
    this.active.delete(executionId);
    this.completed.set(executionId, rec);
    this.counters.canceled++;
    this.trimCompleted();
  }

  /** Cancel every in-flight execution (Phase 5: cancellation propagation).
   *  Returns how many were canceled. */
  cancelAll(reason?: string): number {
    const n = this.active.size;
    for (const [id, rec] of this.active) {
      rec.status = 'canceled';
      rec.finishedAt = Date.now();
      if (reason) rec.result = { canceled: true, reason };
      this.completed.set(id, rec);
      this.counters.canceled++;
    }
    this.active.clear();
    this.trimCompleted();
    return n;
  }

  get(executionId: string): ExecutionRecord | undefined {
    return this.active.get(executionId) ?? this.completed.get(executionId);
  }

  isRunning(executionId: string): boolean {
    return this.active.has(executionId);
  }

  stats(): { active: number; completed: number; duplicatesPrevented: number; replaysServed: number; canceled: number; registered: number } {
    return {
      active: this.active.size,
      completed: this.completed.size,
      duplicatesPrevented: this.counters.duplicatesPrevented,
      replaysServed: this.counters.replaysServed,
      canceled: this.counters.canceled,
      registered: this.counters.registered,
    };
  }

  private trimCompleted(): void {
    while (this.completed.size > this.completedLimit) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
      // Signature entries pointing at trimmed executions are dropped so a
      // trimmed signature cannot serve a stale dedupe hit.
      for (const [sig, id] of this.bySignature) {
        if (id === oldest) this.bySignature.delete(sig);
      }
    }
  }
}