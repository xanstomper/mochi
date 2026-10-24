import { describe, it, expect } from 'vitest';
import { DisciplineTracker, ALL_DISCIPLINE_OFF } from './discipline.js';

// Dataset port #4 (SWE-agent action_sampler.py): a landed EDIT action is
// itself the high-stakes signal — the agent's effort rises the moment real
// mutation begins, exactly once, not on every subsequent edit. The loop
// guards the call with a once-per-run flag; these tests pin the tracker
// side of that contract.

const FLAGS = { ...ALL_DISCIPLINE_OFF, adaptiveEffort: true };

describe('mutation effort escalation (SWE-agent #4)', () => {
  it('first mutation fires one hard signal; later mutations do not re-fire', () => {
    const t = new DisciplineTracker(FLAGS, { goal: 'fix math.js', checklist: [], scopeFiles: [] });
    let fired = false;
    for (let i = 0; i < 3; i++) {
      if (!fired) {
        fired = true;
        t.noteHardSignal();
      }
    }
    expect(fired).toBe(true);
    expect(t.effortOffset).toBe(1);
  });

  it('hard signals cap at +2 and clean turns decay the offset', () => {
    const t = new DisciplineTracker(FLAGS, { goal: 'fix math.js', checklist: [], scopeFiles: [] });
    t.noteHardSignal(); // first mutation
    t.noteHardSignal(); // e.g. mid-run complexity escalation
    t.noteHardSignal(); // capped
    expect(t.effortOffset).toBe(2);
    t.noteCleanTurn();
    t.noteCleanTurn();
    expect(t.effortOffset).toBeLessThan(2);
  });
});
