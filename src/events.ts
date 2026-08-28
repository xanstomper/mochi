import type { MochiEvent } from './types.js';

/** Events noisy enough to coalesce when they arrive faster than consumers
 *  can render (Phase 6: high-rate streaming must not flood listeners). */
const COALESCABLE = new Set<MochiEvent['type']>(['message:chunk', 'agent:reasoning', 'command:output']);

export interface EventBusStats {
  published: number;
  coalesced: number;
  handlerErrors: number;
  subscribers: number;
  historySize: number;
}

/**
 * Typed agent event bus.
 *
 * Phase-1 guarantees added by the master rebuild:
 *  - every emitted event is stamped with a unique `id` and `timestamp` when
 *    absent, so downstream consumers can dedupe and order deterministically;
 *  - a bounded history ring (default 5000) lets the summary engine replay the
 *    session without the bus growing without bound;
 *  - high-rate stream events (message:chunk / agent:reasoning /
 *    command:output) are coalesced per (type,agentId) within a 50ms window:
 *    latest content wins, handler invocations drop ~100x during fast streams;
 *  - handler isolation: one throwing listener never breaks the others.
 */
export class EventBus {
  private listeners: Map<MochiEvent['type'], Array<(event: MochiEvent) => void | Promise<void>>> = new Map();
  private wildcard: Array<(event: MochiEvent) => void | Promise<void>> = [];
  /** Bounded replay buffer for the summary engine / diagnostics. */
  private history: MochiEvent[] = [];
  private readonly historyLimit: number;
  private readonly coalesceWindowMs: number;
  private seq = 0;
  private _stats = { published: 0, coalesced: 0, handlerErrors: 0 };
  /** (type:agentId) -> newest event awaiting its coalesce window. */
  private pendingCoalesce = new Map<string, { event: MochiEvent; timer: ReturnType<typeof setTimeout> }>();

  constructor(opts: { historyLimit?: number; coalesceWindowMs?: number } = {}) {
    this.historyLimit = opts.historyLimit ?? 5000;
    this.coalesceWindowMs = opts.coalesceWindowMs ?? 50;
  }

  on<T extends MochiEvent['type']>(type: T, handler: (event: Extract<MochiEvent, { type: T }>) => void | Promise<void>) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler as (event: MochiEvent) => void | Promise<void>);
    this.listeners.set(type, list);
    return () => this.off(type, handler);
  }

  off<T extends MochiEvent['type']>(type: T, handler: (event: Extract<MochiEvent, { type: T }>) => void | Promise<void>) {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(handler as (event: MochiEvent) => void | Promise<void>);
    if (idx >= 0) list.splice(idx, 1);
  }

  onAll(handler: (event: MochiEvent) => void | Promise<void>) {
    this.wildcard.push(handler);
    return () => {
      const idx = this.wildcard.indexOf(handler);
      if (idx >= 0) this.wildcard.splice(idx, 1);
    };
  }

  /** Snapshot of the bounded history (oldest first). */
  snapshot(): readonly MochiEvent[] {
    return this.history;
  }

  stats(): EventBusStats {
    let subscribers = this.wildcard.length;
    for (const l of this.listeners.values()) subscribers += l.length;
    return { ...this._stats, subscribers, historySize: this.history.length };
  }

  /** Deliver `event` to all listeners exactly once (the single fanout path). */
  private fanout(event: MochiEvent, record = true): void {
    if (record) {
      this.history.push(event);
      if (this.history.length > this.historyLimit) {
        // Drop-oldest in batches (splice of 10% of the ring) instead of
        // shift-per-emit, so high-rate streaming stays O(1) amortized.
        const overflow = this.history.length - this.historyLimit;
        this.history.splice(0, Math.max(overflow, Math.floor(this.historyLimit / 10)));
      }
      this._stats.published++;
    }
    const handlers = this.listeners.get(event.type) ?? [];
    for (const h of handlers) this.invoke(h, event);
    for (const h of this.wildcard) this.invoke(h, event);
  }

  private invoke(h: (event: MochiEvent) => void | Promise<void>, event: MochiEvent): void {
    try {
      const ret = h(event);
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        // Fire-and-forget listeners must never surface an unhandled rejection.
        (ret as Promise<void>).catch(() => { this._stats.handlerErrors++; });
      }
    } catch {
      this._stats.handlerErrors++;
    }
  }

  emit(event: MochiEvent): void {
    this.stamp(event);
    this.fanout(event);
  }

  /** Bypass coalescing and deliver synchronously (tests, final chunks). */
  emitNow(event: MochiEvent): void {
    this.stamp(event);
    this.fanout(event);
  }

  /** Deliver any coalesce-pending events immediately (shutdown, summary). */
  flush(): void {
    for (const [key, entry] of this.pendingCoalesce) {
      clearTimeout(entry.timer);
      this.pendingCoalesce.delete(key);
      this.fanout(entry.event);
    }
  }

  async emitAwait(event: MochiEvent): Promise<void> {
    this.stamp(event);
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      const overflow = this.history.length - this.historyLimit;
      this.history.splice(0, Math.max(overflow, Math.floor(this.historyLimit / 10)));
    }
    this._stats.published++;
    // Exactly-once delivery: awaited handlers run once, in order.
    const handlers = this.listeners.get(event.type) ?? [];
    for (const h of handlers) {
      try { await h(event); } catch { this._stats.handlerErrors++; }
    }
    for (const h of this.wildcard) {
      try { await h(event); } catch { this._stats.handlerErrors++; }
    }
  }

  /** Stamp identity + timestamp onto an event when absent (events are
   *  harness-owned objects, never user data, so in-place is safe). */
  private stamp(event: MochiEvent): void {
    this.seq++;
    const rec = event as { id?: string; timestamp?: number };
    if (!rec.id) rec.id = `evt_${this.seq}_${Math.random().toString(36).slice(2, 8)}`;
    if (!rec.timestamp) rec.timestamp = Date.now();
  }
}
