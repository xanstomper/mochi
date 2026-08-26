import { EventBus } from './events.js';
import type { MochiEvent } from './types.js';

describe('EventBus', () => {
  const logEvent: MochiEvent = { type: 'agent:log', agentId: 'test', message: 'hello' };

  it('delivers sync events to typed listeners', () => {
    const bus = new EventBus();
    const seen: MochiEvent[] = [];
    bus.on('agent:log', (e) => seen.push(e));
    bus.emit(logEvent);
    expect(seen).toEqual([logEvent]);
  });

  it('delivers events to wildcard listeners', () => {
    const bus = new EventBus();
    const seen: MochiEvent[] = [];
    bus.onAll((e) => seen.push(e));
    bus.emit(logEvent);
    expect(seen).toEqual([logEvent]);
  });

  it('swallows sync throws from a listener so one bad handler does not block the bus', () => {
    const bus = new EventBus();
    let laterFired = false;
    bus.on('agent:log', () => { throw new Error('boom'); });
    bus.on('agent:log', () => { laterFired = true; });
    expect(() => bus.emit(logEvent)).not.toThrow();
    expect(laterFired).toBe(true);
  });

  it('swallows a rejected promise returned by a listener so it never becomes unhandled', async () => {
    const bus = new EventBus();
    // Track any unhandled rejection for the listener's promise so the test
    // fails LOUDLY if the bus regresses and lets it bubble.
    const seenRejections: unknown[] = [];
    const trap = (p: Promise<unknown>) => p.catch((e) => seenRejections.push(e));
    const captured: Promise<unknown>[] = [];
    const rejectingHandler = () => trap(Promise.reject(new Error('async-boom')));
    bus.on('agent:log', () => {
      // Mimic what a real async handler does: return a promise that will
      // resolve or reject later. We capture it so the test can observe.
      const p = new Promise<void>((_res, rej) => setTimeout(() => rej(new Error('async-boom')), 5));
      captured.push(p);
      return p;
    });
    // Install a process-level unhandled-rejection trap for the test.
    const onUnhandled = (e: { reason?: unknown }) => { seenRejections.push(e.reason); e.preventDefault?.(); };
    process.on('unhandledRejection', onUnhandled);
    try {
      bus.emit(logEvent);
      // Let the captured promise settle.
      await new Promise((r) => setTimeout(r, 20));
      await Promise.allSettled(captured);
      // No unhandled rejection should have escaped.
      expect(seenRejections).toEqual([]);
      // Sanity: the bus does not store and never throws on later emits.
      let called = 0;
      bus.onAll(() => { called++; });
      bus.emit(logEvent);
      expect(called).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('off() removes the listener', () => {
    const bus = new EventBus();
    let called = 0;
    const off = bus.on('agent:log', () => called++);
    bus.emit(logEvent);
    expect(called).toBe(1);
    off();
    bus.emit(logEvent);
    expect(called).toBe(1);
  });
});