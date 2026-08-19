import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  loadOrCreateAutopsy,
  appendAttempt,
  finalizeAutopsy,
  autopsyOneLine,
} from './autopsy.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-autopsy-'));
});

describe('autopsy persistence', () => {
  it('creates and reloads an autopsy round-tripped from disk', () => {
    const taskId = '11111111-2222-3333-4444-555555555555';
    const initial = loadOrCreateAutopsy(dir, taskId, 'agent-1', 'Fix regression');
    expect(initial.outcome).toBe('unresolved');
    expect(initial.attempts).toEqual([]);

    const withAttempt = appendAttempt(dir, initial, {
      attempt: 1,
      hypothesisId: 'logic_off_by_one',
      hypothesisText: 'off by one in the changed loop',
      confidenceBefore: 0.4,
      action: 'read diff',
      evidence: 'looped over 3 items, expected 4',
      outcome: 'still_failing',
      confidenceAfter: 0.55,
      statusAfter: 'evidence_for',
      atMs: Date.now(),
    });
    expect(withAttempt.attempts).toHaveLength(1);

    // Round-trip: the file on disk should match what we wrote.
    const reloaded = loadOrCreateAutopsy(dir, taskId, 'agent-1', 'Fix regression');
    expect(reloaded.attempts).toHaveLength(1);
    expect(reloaded.attempts[0].hypothesisId).toBe('logic_off_by_one');

    const final = finalizeAutopsy(dir, reloaded, { outcome: 'resolved', rootCauseHypothesis: 'logic_off_by_one', fixApplied: 'src/x.ts' });
    expect(final.outcome).toBe('resolved');
    expect(final.finalizedAtMs).toBeDefined();
    expect(existsSync(resolve(dir, 'autopsies', `${taskId}.json`))).toBe(true);
  });

  it('appends attempts in order and produces a one-line summary', () => {
    const taskId = 'autopsy-append';
    let a = loadOrCreateAutopsy(dir, taskId, 'a', 'task');
    a = appendAttempt(dir, a, { attempt: 1, hypothesisId: 'h1', hypothesisText: 'one', confidenceBefore: 0.3, action: '?', evidence: 'e1', outcome: 'still_failing', confidenceAfter: 0.3, statusAfter: 'pending', atMs: 0 });
    a = appendAttempt(dir, a, { attempt: 2, hypothesisId: 'h2', hypothesisText: 'two', confidenceBefore: 0.7, action: '?', evidence: 'e2', outcome: 'resolved', confidenceAfter: 0.9, statusAfter: 'confirmed', atMs: 0 });
    expect(a.attempts[0].hypothesisId).toBe('h1');
    expect(a.attempts[1].hypothesisId).toBe('h2');
    const summary = autopsyOneLine(a);
    expect(summary).toContain('attempts=2');
    expect(summary).toContain('confirmed=1');
  });

  it('scopes autopsies per-taskId under <workspace>/autopsies', () => {
    const id1 = 'task-aaa';
    const id2 = 'task-bbb';
    const a = loadOrCreateAutopsy(dir, id1, 'agent', 'first');
    appendAttempt(dir, a, { attempt: 1, hypothesisId: 'h', hypothesisText: 't', confidenceBefore: 0, action: '', evidence: '', outcome: 'neutral', confidenceAfter: 0, statusAfter: 'pending', atMs: 0 });
    // Touch the second autopsy's file (loadOrCreateAutopsy is lazy; force a
    // write by appending a no-op attempt).
    const b = loadOrCreateAutopsy(dir, id2, 'agent', 'second');
    appendAttempt(dir, b, { attempt: 0, hypothesisId: 'init', hypothesisText: 'init', confidenceBefore: 0, action: '', evidence: '', outcome: 'neutral', confidenceAfter: 0, statusAfter: 'pending', atMs: 0 });
    const paths = [`autopsies/${id1}.json`, `autopsies/${id2}.json`].map((p) => existsSync(resolve(dir, p)));
    expect(paths).toEqual([true, true]);
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});