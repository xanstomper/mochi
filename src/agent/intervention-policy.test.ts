import { describe, it, expect } from 'vitest';
import { InterventionPolicy, INTERVENTION_RUN_BUDGET } from './intervention-policy.js';

describe('InterventionPolicy', () => {
  it('flush on an empty policy returns null with zero stats', () => {
    const p = new InterventionPolicy();
    expect(p.flush()).toBeNull();
    expect(p.stats).toEqual({ fired: 0, suppressed: 0, firedByTag: {}, suppressedByTag: {} });
  });

  it('queues and flushes a single struggle nudge', () => {
    const p = new InterventionPolicy();
    expect(p.queue('struggle', 'STRUGGLE STATE', 3)).toBe('queued');
    const won = p.flush();
    expect(won?.tag).toBe('struggle');
    expect(won?.signals).toBe(3);
    expect(p.stats.fired).toBe(1);
    expect(p.stats.firedByTag.struggle).toBe(1);
    expect(p.flush()).toBeNull();
  });

  it('commit displaces a queued struggle (higher priority wins)', () => {
    const p = new InterventionPolicy();
    expect(p.queue('struggle', 'STRUGGLE STATE', 2)).toBe('queued');
    expect(p.queue('commit', 'COMMIT', 0)).toBe('queued');
    const won = p.flush();
    expect(won?.tag).toBe('commit');
    expect(p.stats.suppressed).toBe(1);
    expect(p.stats.suppressedByTag.struggle).toBe(1);
  });

  it('struggle does not displace a queued commit', () => {
    const p = new InterventionPolicy();
    expect(p.queue('commit', 'COMMIT', 0)).toBe('queued');
    expect(p.queue('struggle', 'STRUGGLE STATE', 2)).toBe('suppressed');
    expect(p.flush()?.tag).toBe('commit');
    expect(p.stats.suppressedByTag.struggle).toBe(1);
  });

  it('a second nudge of the same tag is suppressed (first wins)', () => {
    const p = new InterventionPolicy();
    expect(p.queue('struggle', 'first', 1)).toBe('queued');
    expect(p.queue('struggle', 'second', 1)).toBe('suppressed');
    expect(p.flush()?.content).toBe('first');
  });

  it('the run budget suppresses further nudges once exhausted', () => {
    const p = new InterventionPolicy();
    for (let n = 0; n < INTERVENTION_RUN_BUDGET; n++) {
      expect(p.queue('struggle', `s${n}`, 1)).toBe('queued');
      expect(p.flush()?.tag).toBe('struggle');
    }
    expect(p.stats.fired).toBe(INTERVENTION_RUN_BUDGET);
    expect(p.queue('struggle', 'over budget', 1)).toBe('suppressed');
    expect(p.stats.suppressed).toBe(1);
  });

  it('flush after a suppression still delivers the queued winner', () => {
    const p = new InterventionPolicy();
    p.queue('commit', 'COMMIT', 0);
    p.queue('struggle', 'STRUGGLE STATE', 1);
    expect(p.flush()?.tag).toBe('commit');
    expect(p.stats).toMatchObject({ fired: 1, suppressed: 1 });
  });

  it('pulse queued alone flushes', () => {
    const p = new InterventionPolicy();
    expect(p.queue('pulse', 'Pulse: 12 iterations', 0)).toBe('queued');
    const won = p.flush();
    expect(won?.tag).toBe('pulse');
    expect(p.stats.firedByTag.pulse).toBe(1);
  });

  it('struggle displaces a queued pulse', () => {
    const p = new InterventionPolicy();
    expect(p.queue('pulse', 'Pulse: 12 iterations', 0)).toBe('queued');
    expect(p.queue('struggle', 'STRUGGLE STATE', 2)).toBe('queued');
    expect(p.flush()?.tag).toBe('struggle');
    expect(p.stats.suppressedByTag.pulse).toBe(1);
  });

  it('commit displaces a queued pulse', () => {
    const p = new InterventionPolicy();
    expect(p.queue('pulse', 'Pulse: 12 iterations', 0)).toBe('queued');
    expect(p.queue('commit', 'COMMIT', 0)).toBe('queued');
    expect(p.flush()?.tag).toBe('commit');
    expect(p.stats.suppressedByTag.pulse).toBe(1);
  });

  it('pulse does not displace a queued struggle', () => {
    const p = new InterventionPolicy();
    expect(p.queue('struggle', 'STRUGGLE STATE', 2)).toBe('queued');
    expect(p.queue('pulse', 'Pulse: 12 iterations', 0)).toBe('suppressed');
    expect(p.flush()?.tag).toBe('struggle');
    expect(p.stats.suppressedByTag.pulse).toBe(1);
  });

  it('pulse does not displace a queued commit', () => {
    const p = new InterventionPolicy();
    expect(p.queue('commit', 'COMMIT', 0)).toBe('queued');
    expect(p.queue('pulse', 'Pulse: 12 iterations', 0)).toBe('suppressed');
    expect(p.flush()?.tag).toBe('commit');
    expect(p.stats.suppressedByTag.pulse).toBe(1);
  });
});
