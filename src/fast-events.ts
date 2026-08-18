import type { CompactEvent } from './stream-events.js';

type Handler = (event: CompactEvent) => void;

export interface EventBusStats {
  totalEvents: number;
  batches: number;
  lastDispatchMs: number;
  maxDispatchMs: number;
  averageDispatchMs: number;
}

export class FastEventBus {
  private handlers = new Map<string, Handler[]>();
  private wildcard: Handler[] = [];
  private queue: CompactEvent[] = [];
  private batching = false;
  private stats: EventBusStats = {
    totalEvents: 0,
    batches: 0,
    lastDispatchMs: 0,
    maxDispatchMs: 0,
    averageDispatchMs: 0,
  };

  on(type: CompactEvent['type'] | '*', handler: Handler): () => void {
    if (type === '*') {
      this.wildcard.push(handler);
      return () => {
        const i = this.wildcard.indexOf(handler);
        if (i >= 0) this.wildcard.splice(i, 1);
      };
    }
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type);
      if (!current) return;
      const i = current.indexOf(handler);
      if (i >= 0) current.splice(i, 1);
    };
  }

  emit(event: CompactEvent): void {
    if (this.batching) {
      this.queue.push(event);
      return;
    }
    this.dispatch(event);
  }

  batch<T>(fn: () => T): T {
    if (this.batching) return fn();
    this.batching = true;
    this.queue.length = 0;
    try {
      const result = fn();
      this.flush();
      return result;
    } finally {
      this.batching = false;
    }
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    this.stats.batches++;
    const start = performance.now();
    for (const event of events) this.dispatch(event, false);
    const elapsed = performance.now() - start;
    this.updateStats(events.length, elapsed);
  }

  private dispatch(event: CompactEvent, updateStats = true): void {
    const start = updateStats ? performance.now() : 0;
    const list = this.handlers.get(event.type);
    if (list) {
      for (let i = 0; i < list.length; i++) list[i](event);
    }
    for (let i = 0; i < this.wildcard.length; i++) this.wildcard[i](event);
    if (updateStats) this.updateStats(1, performance.now() - start);
  }

  private updateStats(count: number, elapsed: number): void {
    this.stats.totalEvents += count;
    this.stats.lastDispatchMs = elapsed;
    this.stats.maxDispatchMs = Math.max(this.stats.maxDispatchMs, elapsed);
    const totalMs = this.stats.averageDispatchMs * (this.stats.totalEvents - count) + elapsed;
    this.stats.averageDispatchMs = totalMs / this.stats.totalEvents;
  }

  getStats(): EventBusStats {
    return { ...this.stats };
  }
}
