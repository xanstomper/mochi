import type { MochiEvent } from './types.js';

export class EventBus {
  private listeners: Map<MochiEvent['type'], Array<(event: MochiEvent) => void | Promise<void>>> = new Map();
  private wildcard: Array<(event: MochiEvent) => void | Promise<void>> = [];

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

  emit(event: MochiEvent) {
    const handlers = this.listeners.get(event.type) ?? [];
    for (const h of handlers) {
      try {
        h(event);
      } catch {
        // ignore listener errors
      }
    }
    for (const h of this.wildcard) {
      try {
        h(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  async emitAwait(event: MochiEvent) {
    const handlers = this.listeners.get(event.type) ?? [];
    for (const h of handlers) {
      try {
        await h(event);
      } catch {
        // ignore listener errors
      }
    }
    for (const h of this.wildcard) {
      try {
        await h(event);
      } catch {
        // ignore listener errors
      }
    }
  }
}
