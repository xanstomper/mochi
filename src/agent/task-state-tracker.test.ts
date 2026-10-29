import { describe, it, expect } from 'vitest';
import { TaskStateTracker } from './task-state-tracker.js';

describe('TaskStateTracker', () => {
  it('maps action classes to states', () => {
    const t = new TaskStateTracker();
    expect(t.current).toBe('INITIALIZE');
    t.observe('read');
    expect(t.current).toBe('INSPECT');
    t.observe('write');
    expect(t.current).toBe('EXECUTE');
    t.observe('plan');
    expect(t.current).toBe('PLAN');
    t.observe('verify');
    expect(t.current).toBe('VERIFY');
    t.observe('struggle');
    expect(t.current).toBe('RECOVER');
    t.observe('finish-success');
    expect(t.current).toBe('COMPLETE');
    const t2 = new TaskStateTracker();
    t2.observe('finish-failure');
    expect(t2.current).toBe('FAILED');
  });

  it('flags INSPECT → PLAN → INSPECT without EXECUTE, once per phase', () => {
    const t = new TaskStateTracker();
    t.observe('read');
    t.observe('plan');
    expect(t.checkCycle()).toBeNull();
    t.observe('read');
    const c = t.checkCycle();
    expect(c?.kind).toBe('inspect-plan-loop');
    expect(c?.message).toContain('INSPECT → PLAN → INSPECT');
    // Reported once until an EXECUTE resets it.
    expect(t.checkCycle()).toBeNull();
    t.observe('write');
    t.observe('read');
    t.observe('plan');
    t.observe('read');
    expect(t.checkCycle()?.kind).toBe('inspect-plan-loop');
  });

  it('does not flag reads/plans that never complete the loop', () => {
    const t = new TaskStateTracker();
    t.observe('read');
    t.observe('read');
    t.observe('plan');
    expect(t.checkCycle()).toBeNull();
    t.observe('plan');
    expect(t.checkCycle()).toBeNull();
    // EXECUTE between breaks the pattern.
    const t2 = new TaskStateTracker();
    t2.observe('read');
    t2.observe('write');
    t2.observe('plan');
    t2.observe('read');
    expect(t2.checkCycle()).toBeNull();
  });

  it('flags the same failure detail across consecutive RECOVER observations', () => {
    const t = new TaskStateTracker();
    t.observe('struggle', 'ENOENT: missing file');
    expect(t.checkCycle()).toBeNull();
    t.observe('struggle', 'ENOENT: missing file');
    const c = t.checkCycle();
    expect(c?.kind).toBe('same-failure-retry');
    expect(c?.message).toContain('2 times');
    // A different detail resets the streak.
    const t2 = new TaskStateTracker();
    t2.observe('struggle', 'error A');
    t2.observe('struggle', 'error B');
    expect(t2.checkCycle()).toBeNull();
    t2.observe('struggle', 'error B');
    expect(t2.checkCycle()?.kind).toBe('same-failure-retry');
  });

  it('ignores empty failure details for the same-failure cycle', () => {
    const t = new TaskStateTracker();
    t.observe('struggle', '');
    t.observe('struggle', '');
    expect(t.checkCycle()).toBeNull();
  });

  it('reports exhaustion after three cycles', () => {
    const t = new TaskStateTracker();
    expect(t.exhausted).toBe(false);
    for (let n = 0; n < 3; n++) {
      t.observe('read');
      t.observe('plan');
      t.observe('read');
      expect(t.checkCycle()?.kind).toBe('inspect-plan-loop');
      t.observe('write');
    }
    expect(t.exhausted).toBe(true);
    expect(t.stats.cycleCount).toBe(3);
  });

  it('returns pending cycles one at a time', () => {
    const t = new TaskStateTracker();
    t.observe('read');
    t.observe('plan');
    t.observe('read');
    t.observe('struggle', 'boom');
    t.observe('struggle', 'boom');
    expect(t.checkCycle()?.kind).toBe('inspect-plan-loop');
    expect(t.checkCycle()?.kind).toBe('same-failure-retry');
    expect(t.checkCycle()).toBeNull();
  });
});
