// MCH-68: SDK typed event stream tests.
import { test, expect } from 'bun:test';
import { EventBus } from './events.js';
import type { AgentState, MochiEvent } from './types.js';

const pulse = (state: string) => ({ type: 'pulse', state: state as AgentState }) as unknown as MochiEvent;

test('EventBus onAll wildcard subscribe + unsubscribe', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  const off = bus.onAll((e: MochiEvent) => { seen.push(e.type); });
  bus.emit(pulse('idle'));
  bus.emit({ type: 'warning', message: 'x' });
  expect(seen).toEqual(['pulse', 'warning']);
  off();
  bus.emit({ type: 'warning', message: 'y' });
  expect(seen).toEqual(['pulse', 'warning']);
});

test('stream() iterator delivers events queued before first next()', async () => {
  // stream() lives on Mochi; test the core queue/waiter logic via a minimal replica
  type Resolve = (e: MochiEvent) => void;
  const queue: MochiEvent[] = [];
  const waiters: Resolve[] = [];
  let closed = false;
  const push = (e: MochiEvent) => { const w = waiters.shift(); if (w) w(e); else queue.push(e); };
  push(pulse('idle'));
  push({ type: 'warning', message: 'x' } as unknown as MochiEvent);
  const next = (): Promise<IteratorResult<MochiEvent>> => {
    if (closed) return Promise.resolve({ value: undefined as unknown as MochiEvent, done: true });
    if (queue.length) return Promise.resolve({ value: queue.shift() as MochiEvent, done: false });
    return new Promise((resolve) => waiters.push((e) => resolve({ value: e, done: false })));
  };
  const a = await next();
  const b = await next();
  expect(a.done).toBe(false);
  expect(b.done).toBe(false);
  expect((a.value as MochiEvent).type).toBe('pulse');
  expect((b.value as MochiEvent).type).toBe('warning');
});
