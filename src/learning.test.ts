import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LearningStore, classifyFailure } from './learning.js';

describe('LearningStore', () => {
  it('classifies common engineering failures', () => {
    const r = classifyFailure('error TS2345: Argument of type string is not assignable');
    expect(r?.pattern).toBe('TS2345');
    expect(r?.strategy).toContain('interface');
  });

  it('records recovery outcomes and ranks strategies', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-learning-'));
    const store = new LearningStore(dir);
    store.record('TS2345', 'inspect types', true);
    store.record('TS2345', 'inspect types', true);
    store.record('TS2345', 'blind retry', false);
    expect(store.successRate('TS2345', 'inspect types')).toBe(1);
    expect(store.successRate('TS2345', 'blind retry')).toBe(0);
    expect(store.bestStrategy('TS2345')?.strategy).toBe('inspect types');
    const raw = JSON.parse(readFileSync(resolve(dir, 'state/learning.json'), 'utf8'));
    expect(raw.records).toHaveLength(2);
  });
});
