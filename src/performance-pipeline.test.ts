import { describe, it, expect } from 'vitest';
import { BatchScheduler } from './scheduler.js';
import { PerformancePipeline } from './performance-pipeline.js';

function sse(payload: object) {
  return `data: ${JSON.stringify(payload)}\n`;
}

describe('BatchScheduler', () => {
  it('batches multiple tasks into one flush', async () => {
    const scheduler = new BatchScheduler();
    const order: number[] = [];
    scheduler.schedule(() => order.push(1));
    scheduler.schedule(() => order.push(2));
    scheduler.schedule(() => order.push(3));
    await Promise.resolve();
    expect(order).toEqual([1, 2, 3]);
    expect(scheduler.getStats().flushedBatches).toBe(1);
  });
});

describe('PerformancePipeline', () => {
  it('streams model output through parser, bus, state, and renderer', () => {
    const pipeline = new PerformancePipeline('message-1');
    pipeline.write(sse({ choices: [{ delta: { content: 'Hello ' } }] }));
    pipeline.write(sse({ choices: [{ delta: { content: 'Mochi' } }] }));
    pipeline.write('data: [DONE]\n');

    expect(pipeline.store.get('message')).toBe('Hello Mochi');
    const stats = pipeline.getStats();
    expect(stats.parser.parseCount).toBe(2);
    expect(stats.bus.totalEvents).toBeGreaterThanOrEqual(3);
    expect(stats.renderer.frames).toBeGreaterThan(0);
  });
});
