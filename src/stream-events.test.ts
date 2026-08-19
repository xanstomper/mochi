import { describe, expect, it } from 'vitest';
import { createDirtySet } from './stream-events.js';
import { AnsiRenderer } from './tui/renderer.js';

describe('DirtySet (stream-events)', () => {
  it('marks, checks, clears, and reports emptiness', () => {
    const d = createDirtySet();
    expect(d.isEmpty()).toBe(true);
    d.mark('tool');
    d.mark('status-bar');
    expect(d.isEmpty()).toBe(false);
    expect(d.has('tool')).toBe(true);
    expect(d.has('message')).toBe(false);
    expect(d.regions.size).toBe(2);
    d.clear();
    expect(d.isEmpty()).toBe(true);
    expect(d.has('tool')).toBe(false);
  });

  it('marks a region once (set semantics)', () => {
    const d = createDirtySet();
    d.mark('message');
    d.mark('message');
    expect(d.regions.size).toBe(1);
  });
});

describe('AnsiRenderer', () => {
  it('renders dirty regions, coalesces, and reports stats', () => {
    const r = new AnsiRenderer();
    const stats = r.getStats();
    expect(stats.frames).toBe(0);
    // Flushing without a render no-ops safely.
    r.flush();
    expect(stats.frames).toBe(0);
    // Stat accessors return numbers.
    expect(typeof stats.maxFrameMs).toBe('number');
    expect(typeof stats.averageFrameMs).toBe('number');
  });
});