/**
 * P1 bench: the discipline escapes.
 *
 * - thrash-with-edits: a mutating turn skips the deliberation block
 *   entirely (noteTurn only evaluates non-mutating turns), and the loop
 *   clears the force arm on mutating turns — so thrash escalates through
 *   noteEdit (past the guidance cap) instead of noteTurn.
 * - interleaved debate: the streak needs CONSECUTIVE deliberative turns,
 *   so debate/edit/debate/edit never reaches force.
 * - drift cap: snap-back fires at most twice per run, guidance-only.
 * - relevance over-broadness: addPathTokens adds every scope-file segment
 *   (including 'src'), so ANY src/ path counts as on-contract and resets
 *   the drift streak.
 *
 * Tests 1-2 assert the fixed behavior (thrash escalates, interleaved
 * debate forces); they failed on pre-fix code. Test 3 documents the
 * guidance cap (snap-backs still cap at 2; escalation carries past it).
 * Test 6 asserts tightened relevance. Tests 4-5 are controls that must
 * keep passing (productive work and pure debate). Test 7 asserts
 * convergence resets escalation.
 */
import { describe, expect, it } from 'vitest';
import { DisciplineTracker } from './discipline.js';

const FLAGS = {
  replanGate: true,
  progressForcing: true,
  driftSnapback: true,
  decisiveFinish: true,
  sameFailureSwitch: true,
  adaptiveEffort: true,
};
const CONTRACT = {
  goal: 'Fix the login timeout bug',
  checklist: ['login completes within 5s', 'no regression in auth tests'],
  scopeFiles: ['src/auth/login.ts'],
};
// Paths with no segment in the contract's relevance tokens and no
// >=4-char token as a substring: genuinely off-contract.
const STRAY = ['docs/notes.md', 'tools/deploy.sh', 'scripts/cleanup.py'];

function tracker() {
  return new DisciplineTracker(FLAGS, CONTRACT);
}

describe('P1 discipline escapes', () => {
  it('thrash-with-edits: stray edits past the guidance cap escalate', () => {
    const t = tracker();
    const edits = [];
    for (let i = 0; i < 8; i++) {
      t.noteTurn({
        hasToolCalls: true,
        mutating: true,
        workTool: false,
        progress: true,
        content: `edit number ${i} changing something different`,
      });
      edits.push(t.noteEdit(STRAY[i % STRAY.length]));
    }
    // Two snap-backs fire (3rd and 6th stray edits); the 6th also escalates:
    // guidance ignored twice, so the loop must finish decisively. A force
    // verdict on a mutating turn would be swallowed by the loop (it clears
    // the force arm on mutating turns), which is why thrash escalates
    // through noteEdit, not noteTurn.
    expect(edits.some((e) => e.escalate)).toBe(true);
    expect(t.stats.snapbacks).toBe(2);
  });

  it('interleaved debate: deliberative turns separated by edits still force', () => {
    const t = tracker();
    const verdicts = [];
    for (let i = 0; i < 3; i++) {
      verdicts.push(
        t.noteTurn({
          hasToolCalls: false,
          mutating: false,
          workTool: false,
          progress: false,
          content: 'still weighing the approach before acting',
        }),
      );
      verdicts.push(
        t.noteTurn({
          hasToolCalls: true,
          mutating: true,
          workTool: false,
          progress: true,
          content: `trivial tweak ${i}`,
        }),
      );
    }
    expect(verdicts.some((v) => v.action === 'force')).toBe(true);
  });

  it('drift cap: after two snap-backs, further stray edits get nothing', () => {
    const t = tracker();
    const results = [];
    for (let i = 0; i < 9; i++) results.push(t.noteEdit(STRAY[i % STRAY.length]));
    expect(t.stats.snapbacks).toBe(2);
    expect(results[2].snapback).toBe(true);
    expect(results[5].snapback).toBe(true);
    expect(results[8].snapback).toBe(false);
  });

  it('productive work: relevant edits plus verify passes never force', () => {
    const t = tracker();
    const verdicts = [];
    for (let i = 0; i < 4; i++) {
      t.noteEdit('src/auth/login.ts');
      verdicts.push(
        t.noteTurn({
          hasToolCalls: true,
          mutating: true,
          workTool: true,
          progress: true,
          content: `implement fix part ${i}`,
        }),
      );
      t.noteVerifyPass();
    }
    expect(verdicts.some((v) => v.action === 'force')).toBe(false);
  });

  it('pure debate: three consecutive deliberative turns force', () => {
    const t = tracker();
    const verdicts = [];
    for (let i = 0; i < 3; i++) {
      verdicts.push(
        t.noteTurn({
          hasToolCalls: false,
          mutating: false,
          workTool: false,
          progress: false,
          content: 'still weighing the approach before acting',
        }),
      );
    }
    expect(verdicts[2].action).toBe('force');
  });

  it('relevance is tightened: a src/ path outside the contract is stray', () => {
    const t = tracker();
    const r = t.noteEdit('src/billing/invoice.ts');
    expect(r.streak).toBe(1);
    expect(r.snapback).toBe(false);
  });

  it('convergence resets escalation: a relevant edit clears the stray count', () => {
    const t = tracker();
    const edits = [];
    for (let i = 0; i < 6; i++) edits.push(t.noteEdit(STRAY[i % STRAY.length]));
    expect(edits[5].escalate).toBe(true);
    const rel = t.noteEdit('src/auth/login.ts');
    expect(rel.streak).toBe(0);
    expect(rel.escalate).toBe(false);
    const after = t.noteEdit(STRAY[0]);
    expect(after.streak).toBe(1);
    expect(after.escalate).toBe(false);
  });
});
