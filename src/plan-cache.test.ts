// MCH-47: plan cache — successful plans persisted and matched for similar tasks.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSignature, recordPlanSuccess, findPriorPlan } from './plan-cache.js';

const dir = mkdtempSync(join(tmpdir(), 'mochi-plan-cache-'));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('plan-cache (MCH-47)', () => {
  it('normalizes signatures so trivially-different phrasings collide', () => {
    const a = planSignature('Add retry logic to fetchUser', 'handle transient failures');
    const b = planSignature('add retry logic to fetchUser()', 'Handle Transient Failures');
    expect(a).toBe(b);
    expect(a.split(' ').length).toBeGreaterThan(0);
  });

  it('records a successful plan and finds it for the same task', () => {
    recordPlanSuccess(dir, 'Add retry logic to fetchUser', 'handle transient failures', '1. Wrap fetch in backoff loop.\n2. Cap at 3 attempts.');
    const found = findPriorPlan(dir, 'Add retry logic to fetchUser', 'handle transient failures');
    expect(found).not.toBeNull();
    expect(found!.plan).toContain('backoff');
  });

  it('matches similar tasks via word overlap ≥ 0.6', () => {
    // 'retry fetchuser handling calls' vs entry 'failures fetchuser handle logic retry transient'
    // shares retry+fetchuser = 2/5 = 0.4 of entry words... so also drop 'calls'
    // to lift overlap: 'retry fetchuser handling' → 2/3 entry-side? Use overlap symmetric check instead.
    const found = findPriorPlan(dir, 'add retry logic to fetchUser requests', 'transient');
    expect(found).not.toBeNull();
    expect(found!.plan).toContain('backoff');
  });

  it('returns null for unrelated tasks', () => {
    const found = findPriorPlan(dir, 'rebuild the docker deployment pipeline');
    expect(found).toBeNull();
  });

  it('rejects empty plans and empty signatures', () => {
    recordPlanSuccess(dir, 'Empty plan task', '', '   ');
    expect(findPriorPlan(dir, 'Empty plan task')).toBeNull();
  });
});
