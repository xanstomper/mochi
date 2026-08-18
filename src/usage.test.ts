import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { UsageStore } from './usage.js';

describe('UsageStore', () => {
  it('records and aggregates usage', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-usage-'));
    const store = new UsageStore(dir);
    store.record('gpt-4o', 'fix auth', { tokensOut: 3000, modelCalls: 2, toolCalls: 4, durationMs: 5000 });
    store.record('gpt-4o', 'add tests', { tokensOut: 1000, modelCalls: 1, toolCalls: 2, durationMs: 3000 });

    const total = store.total();
    expect(total.modelCalls).toBe(3);
    expect(total.toolCalls).toBe(6);
    expect(total.tokensOut).toBe(4000);
    expect(total.durationMs).toBe(8000);
    expect(total.costUsd).toBeGreaterThan(0);
    expect(store.summary()).toContain('cost');
    expect(store.recent()).toContain('fix auth');
  });

  it('persists across instances', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-usage-'));
    const a = new UsageStore(dir);
    a.record('models/mock', 'task one', { tokensOut: 10, modelCalls: 1 });
    const b = new UsageStore(dir);
    expect(b.total().modelCalls).toBe(1);
  });
});