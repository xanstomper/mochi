// Reasoning discipline — unit tests for the pure state machines in
// discipline.ts. The loop-level scripted scenarios live in
// discipline-loop.test.ts; these pin the mechanisms themselves:
// evidence keys are single-use, deliberation escalates commit -> force,
// the same failure + same approach is switched then refused, drift needs
// 3 unrelated edits, and effort moves only on evidence.
import { describe, it, expect } from 'vitest';
import {
  DisciplineTracker,
  resolveDisciplineFlags,
  failureClassOf,
  verifySummaryEvidenced,
  type DisciplineFlags,
} from './discipline.js';

const ALL_ON: DisciplineFlags = {
  replanGate: true,
  progressForcing: true,
  driftSnapback: true,
  decisiveFinish: true,
  sameFailureSwitch: true,
  adaptiveEffort: true,
};

function tracker(contract?: Partial<{ goal: string; checklist: string[]; scopeFiles: string[] }>): DisciplineTracker {
  return new DisciplineTracker(ALL_ON, {
    goal: contract?.goal ?? 'Fix the bug in math.js: add() returns the wrong result',
    checklist: contract?.checklist ?? ['The existing test suite still passes'],
    scopeFiles: contract?.scopeFiles ?? [],
  });
}

describe('resolveDisciplineFlags', () => {
  it('defaults everything on', () => {
    const f = resolveDisciplineFlags(undefined, {});
    expect(f).toEqual(ALL_ON);
  });

  it('MOCHI_DISCIPLINE=0 is the master kill-switch', () => {
    const f = resolveDisciplineFlags(undefined, { MOCHI_DISCIPLINE: '0' });
    expect(Object.values(f).every((v) => v === false)).toBe(true);
  });

  it('config enabled=false is the master switch; per-mechanism flags and envs compose', () => {
    expect(Object.values(resolveDisciplineFlags({ enabled: false }, {})).every((v) => v === false)).toBe(true);
    const f = resolveDisciplineFlags({ replanGate: false }, { MOCHI_DISCIPLINE_DRIFT_SNAPBACK: '0' });
    expect(f.replanGate).toBe(false);
    expect(f.driftSnapback).toBe(false);
    expect(f.progressForcing).toBe(true);
    expect(f.adaptiveEffort).toBe(true);
  });
});

describe('failureClassOf', () => {
  it('collapses value differences: same root failure, same class', () => {
    const a = failureClassOf('Check failed: npm test\nWRONG: add(2,3)=6');
    const b = failureClassOf('Check failed: npm test\nWRONG: add(2,3)=-1');
    expect(a).toBe(b);
  });

  it('distinguishes different failures', () => {
    const a = failureClassOf('Check failed: npm test\nTypeError: x is not a function');
    const b = failureClassOf('Check failed: npm test\nAssertionError: expected 5 to equal 6');
    expect(a).not.toBe(b);
  });

  it('normalizes absolute paths and line numbers', () => {
    const a = failureClassOf('Error at /home/user/proj/src/math.ts:42:7 blew up');
    const b = failureClassOf('Error at /other/checkout/src/math.ts:9:1 blew up');
    expect(a).toBe(b);
  });
});

describe('verifySummaryEvidenced', () => {
  it('a real check command passing is evidenced', () => {
    expect(verifySummaryEvidenced('All checks passed: npm test, npx tsc --noEmit')).toBe(true);
    expect(verifySummaryEvidenced('Manual check passed: `npm test` (exit 0)')).toBe(true);
  });

  it('vacuous passes are not evidence', () => {
    expect(verifySummaryEvidenced('All checks passed: true')).toBe(false);
    expect(verifySummaryEvidenced('No verification configured.')).toBe(false);
    expect(verifySummaryEvidenced('No changes made to verify.')).toBe(false);
    expect(verifySummaryEvidenced('Greenfield build: files created, no repo suite applicable (skipped by design).')).toBe(false);
    expect(verifySummaryEvidenced('Verification skipped by profile.')).toBe(false);
  });
});

describe('replan gate (mechanism 1)', () => {
  it('first reconsideration with evidence is allowed, the repeat is suppressed', () => {
    const t = tracker();
    t.noteEvidence('verify-failure:class-a');
    expect(t.gateReconsideration('verify-failure')).toMatchObject({ allowed: true });
    // Same failure again: the key is already seen, so it is NOT new evidence.
    t.noteEvidence('verify-failure:class-a');
    expect(t.gateReconsideration('verify-failure')).toMatchObject({ allowed: false });
    expect(t.stats.replansSuppressed).toBe(1);
  });

  it('a new failure class or a user steer re-opens the gate', () => {
    const t = tracker();
    t.noteEvidence('verify-failure:class-a');
    expect(t.gateReconsideration('x').allowed).toBe(true);
    t.noteEvidence('verify-failure:class-b');
    expect(t.gateReconsideration('x').allowed).toBe(true);
    t.noteEvidence('steer:use the other endpoint');
    expect(t.gateReconsideration('x').allowed).toBe(true);
    expect(t.gateReconsideration('x').allowed).toBe(false);
  });

  it('verify failures register their own evidence key (new class only)', () => {
    const t = tracker();
    t.noteVerifyFailure('Check failed: npm test\nWRONG: add(2,3)=6', ['math.js']);
    expect(t.peekReconsideration()).toBe(true);
    expect(t.gateReconsideration('x').allowed).toBe(true);
    t.noteVerifyFailure('Check failed: npm test\nWRONG: add(2,3)=0', ['math.js']);
    expect(t.peekReconsideration()).toBe(false);
  });
});

describe('progress forcing (mechanism 2)', () => {
  const readOnlyRepeat = { hasToolCalls: true, mutating: false, workTool: false, progress: false, content: 'Let me reconsider the approach again.' };

  it('deliberation escalates: commit at 2, force at 3', () => {
    const t = tracker();
    expect(t.noteTurn(readOnlyRepeat).action).toBe('none');
    expect(t.noteTurn(readOnlyRepeat).action).toBe('commit');
    expect(t.noteTurn(readOnlyRepeat).action).toBe('force');
    expect(t.noteTurn(readOnlyRepeat).action).toBe('force');
  });

  it('a mutating turn resets the streak', () => {
    const t = tracker();
    t.noteTurn(readOnlyRepeat);
    t.noteTurn(readOnlyRepeat);
    const acted = t.noteTurn({ hasToolCalls: true, mutating: true, workTool: true, progress: true, content: 'Editing now.' });
    expect(acted).toMatchObject({ action: 'none', streak: 0, deliberative: false });
    expect(t.noteTurn(readOnlyRepeat).action).toBe('none');
  });

  it('covering new ground is not deliberation, even read-only', () => {
    const t = tracker();
    const exploring = { hasToolCalls: true, mutating: false, workTool: false, progress: true, content: 'Reading a new file.' };
    expect(t.noteTurn(exploring).deliberative).toBe(false);
    expect(t.noteTurn(exploring).deliberative).toBe(false);
  });

  it('a shell/verify turn is work, not deliberation', () => {
    const t = tracker();
    const repro = { hasToolCalls: true, mutating: false, workTool: true, progress: false, content: 'Running the repro.' };
    expect(t.noteTurn(repro).deliberative).toBe(false);
  });

  it('no-tool prose turns are deliberation; near-repeat prose is self-debate', () => {
    const t = tracker();
    expect(t.noteTurn({ hasToolCalls: false, mutating: false, workTool: false, progress: false, content: 'I should think about the design more carefully before acting on it.' }).deliberative).toBe(true);
    // Second turn: reads a NEW file (progress) but the prose is a near-copy
    // of the previous deliberation — the words are the loop.
    const again = t.noteTurn({ hasToolCalls: true, mutating: false, workTool: false, progress: true, content: 'I should think about the design more carefully before acting on it, really.' });
    expect(again.deliberative).toBe(true);
    expect(again.action).toBe('commit');
  });
});

describe('drift snap-back (mechanism 3)', () => {
  it('needs 3 consecutive unrelated edits, then fires once per streak', () => {
    const t = tracker();
    expect(t.noteEdit('src/unrelated-a.ts').snapback).toBe(false);
    expect(t.noteEdit('docs/notes-b.md').snapback).toBe(false);
    expect(t.noteEdit('tools/helper-c.js').snapback).toBe(true);
    // Streak reset by the snap-back: another single stray edit is not enough.
    expect(t.noteEdit('src/unrelated-a.ts').snapback).toBe(false);
  });

  it('edits the contract names are relevant and reset the streak', () => {
    const t = tracker();
    t.noteEdit('src/unrelated-a.ts');
    t.noteEdit('docs/notes-b.md');
    expect(t.noteEdit('math.js').snapback).toBe(false); // named in the goal
    expect(t.noteEdit('src/unrelated-a.ts').snapback).toBe(false); // streak was reset
    expect(t.noteEdit('docs/notes-b.md').snapback).toBe(false);
    expect(t.noteEdit('tools/helper-c.js').snapback).toBe(true);
  });

  it('fileScope paths are always relevant; .mochi state is exempt', () => {
    const t = tracker({ scopeFiles: ['lib/core.ts'] });
    expect(t.noteEdit('lib/core.ts').snapback).toBe(false);
    expect(t.noteEdit('.mochi/state/todo.json').snapback).toBe(false);
    expect(t.noteEdit('src/elsewhere.ts').streak).toBe(1);
  });

  it('snap-back message restates the contract and names the stray paths', () => {
    const t = tracker();
    t.noteEdit('src/unrelated-a.ts');
    t.noteEdit('docs/notes-b.md');
    t.noteEdit('tools/helper-c.js');
    const msg = t.snapbackMessage();
    expect(msg).toContain('DRIFT SNAP-BACK');
    expect(msg).toContain('tools/helper-c.js');
    expect(msg).toContain('Fix the bug in math.js');
  });
});

describe('same-failure strategy switch (mechanism 5)', () => {
  const FAIL = 'Check failed: npm test\nWRONG: add(2,3)=9';

  it('same class + same approach: retry, retry, switch, refuse', () => {
    const t = tracker();
    expect(t.noteVerifyFailure(FAIL, ['math.js']).action).toBe('retry');
    expect(t.noteVerifyFailure(FAIL, ['math.js']).action).toBe('retry');
    const third = t.noteVerifyFailure(FAIL, ['math.js']);
    expect(third.action).toBe('switch');
    expect(third.classCount).toBe(3);
    expect(third.sameApproachCount).toBe(3);
    expect(t.noteVerifyFailure(FAIL, ['math.js']).action).toBe('refuse');
    expect(t.stats.strategySwitches).toBe(1);
    expect(t.stats.refusals).toBe(1);
  });

  it('changing the approach after a switch demand earns fresh attempts', () => {
    const t = tracker();
    t.noteVerifyFailure(FAIL, ['math.js']);
    t.noteVerifyFailure(FAIL, ['math.js']);
    expect(t.noteVerifyFailure(FAIL, ['math.js']).action).toBe('switch');
    // Obeyed the switch: different files = different approach.
    const obeyed = t.noteVerifyFailure(FAIL, ['helper.js']);
    expect(obeyed.action).toBe('retry');
    expect(obeyed.sameApproachCount).toBe(1);
  });

  it('an empty approach (re-claiming with no new edits) never escalates', () => {
    const t = tracker();
    // The rollback-test shape: one edit, then endless identical claims.
    expect(t.noteVerifyFailure(FAIL, ['out.txt']).action).toBe('retry');
    for (let i = 0; i < 5; i++) {
      expect(t.noteVerifyFailure(FAIL, []).action).toBe('retry');
    }
    expect(t.stats.strategySwitches).toBe(0);
    expect(t.stats.refusals).toBe(0);
  });

  it('a different failure class has its own counters', () => {
    const t = tracker();
    t.noteVerifyFailure(FAIL, ['math.js']);
    t.noteVerifyFailure(FAIL, ['math.js']);
    const other = t.noteVerifyFailure('Check failed: npm test\nTypeError: boom', ['math.js']);
    expect(other.isNewClass).toBe(true);
    expect(other.classCount).toBe(1);
    expect(other.action).toBe('retry');
  });
});

describe('adaptive effort (mechanism 6)', () => {
  it('hard signals raise effort (capped at +2); a pass resets', () => {
    const t = tracker();
    expect(t.adjustEffort('medium')).toBe('medium');
    t.noteHardSignal();
    expect(t.adjustEffort('medium')).toBe('high');
    t.noteHardSignal();
    expect(t.adjustEffort('medium')).toBe('max');
    t.noteHardSignal();
    expect(t.adjustEffort('medium')).toBe('max');
    t.noteVerifyPass();
    expect(t.adjustEffort('medium')).toBe('medium');
  });

  it('sustained clean progress decays effort one rung below base, never to off', () => {
    const t = tracker();
    t.noteCleanTurn();
    expect(t.adjustEffort('high')).toBe('high'); // one clean turn is not a streak
    t.noteCleanTurn();
    expect(t.adjustEffort('high')).toBe('medium');
    t.noteCleanTurn();
    t.noteCleanTurn();
    expect(t.adjustEffort('low')).toBe('low'); // floor: adaptation never selects off
    expect(t.adjustEffort('off')).toBe('off'); // an off base is never raised
  });

  it('a hard signal breaks the clean streak', () => {
    const t = tracker();
    t.noteHardSignal(); // offset +1
    t.noteCleanTurn();
    t.noteHardSignal(); // offset +2, streak reset
    t.noteCleanTurn();
    expect(t.adjustEffort('medium')).toBe('max'); // still +2: only ONE clean turn since
  });
});

// P3 gun 6 (self-poisoning class): the PARTIAL targeted pre-check annotation
// is harness framing on the SAME failure as the full-gate header — the two
// must share a failure class, or the same-approach streak resets and the x3
// strategy switch never fires (the exact bug '(fast lane)' had before
// 9d66584).
describe('failureClassOf harness-annotation hygiene', () => {
  it('a PARTIAL targeted pre-check failure and the same full-gate failure share a class', () => {
    const full = failureClassOf('Check failed: npm test\nAssertionError: expected 5 to be 6');
    const partial = failureClassOf('Check failed: npm test (PARTIAL targeted pre-check: budget guard)\nAssertionError: expected 5 to be 6');
    expect(partial).toBe(full);
  });
});
