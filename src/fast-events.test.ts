import { describe, it, expect } from 'vitest';
import { FastEventBus } from './fast-events.js';
import type { CompactEvent } from './stream-events.js';

describe('FastEventBus', () => {
  it('dispatches compact events directly', () => {
    const bus = new FastEventBus();
    const received: string[] = [];
    bus.on('text-delta', (e) => received.push((e as any).text));
    bus.emit({ type: 'text-delta', messageId: 'm', text: 'a' });
    bus.emit({ type: 'text-delta', messageId: 'm', text: 'b' });
    expect(received).toEqual(['a', 'b']);
    expect(bus.getStats().totalEvents).toBe(2);
  });

  it('batches events and dispatches them once', () => {
    const bus = new FastEventBus();
    let count = 0;
    bus.on('*', () => count++);
    bus.batch(() => {
      for (let i = 0; i < 100; i++) bus.emit({ type: 'text-delta', messageId: 'm', text: 'x' });
    });
    expect(count).toBe(100);
    expect(bus.getStats().batches).toBe(1);
  });

  it('supports wildcard subscriptions', () => {
    const bus = new FastEventBus();
    const types: string[] = [];
    bus.on('*', (e) => types.push(e.type));
    bus.emit({ type: 'finish', reason: 'stop' });
    bus.emit({ type: 'error', message: 'x' });
    expect(types).toEqual(['finish', 'error']);
  });
});
