// Verification-first critic (src/agent/verification-critic.ts) — pure-core
// unit tests. The critic re-derives a completion claim from the recorded
// reproduction evidence alone: a failing observation of the reproduction
// before the fix, a green run of the SAME command after it. A conclusion
// the evidence does not support is blocked with the gap named.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Workspace } from '../workspace.js';
import {
  deriveCriticVerdict, loadReproLedger, parseToolExit, pickReproCandidates,
  reproObservationCommand, saveReproLedgerRecord, verificationFirstEnabled,
  type ReproLedgerRecord, type ReproObservation,
} from './verification-critic.js';

function obs(partial: Partial<ReproObservation>): ReproObservation {
  return { tool: 'shell', command: 'node repro.js', code: 1, failed: true, at: Date.now(), phase: 'pre', origin: 'model', ...partial };
}

const SUPPORTED_INPUT = {
  exemption: null,
  vetoFired: true,
  bypassed: false,
  observations: [] as ReproObservation[],
  gateGreenChecks: [] as string[],
};

describe('verificationFirstEnabled', () => {
  const cfg = (safety: Record<string, unknown>) => ({ safety } as never);
  it('defaults ON', () => {
    expect(verificationFirstEnabled(cfg({}), {})).toBe(true);
  });
  it('MOCHI_REPRO_FIRST=0 disables', () => {
    expect(verificationFirstEnabled(cfg({}), { MOCHI_REPRO_FIRST: '0' })).toBe(false);
  });
  it('safety.verificationFirst=false disables', () => {
    expect(verificationFirstEnabled(cfg({ verificationFirst: false }), {})).toBe(false);
  });
  it('the scripted-e2e seam disables', () => {
    expect(verificationFirstEnabled(cfg({ skipReproGate: true }), {})).toBe(false);
  });
});

describe('parseToolExit', () => {
  it('reads the shell exit_code envelope', () => {
    expect(parseToolExit('shell', 'exit_code: 0\nOK', false)).toEqual({ code: 0, failed: false });
    expect(parseToolExit('shell', 'exit_code: 1\nWRONG', false)).toEqual({ code: 1, failed: true });
  });
  it('falls back to the tool error flag when no envelope exists', () => {
    expect(parseToolExit('shell', 'no envelope', true).failed).toBe(true);
    expect(parseToolExit('shell', 'no envelope', false).failed).toBe(false);
  });
  it('reads the verify tool PASS/FAIL markers', () => {
    expect(parseToolExit('verify', '[PASS] Verification PASSED (1s)', false)).toEqual({ code: 0, failed: false });
    expect(parseToolExit('verify', '[FAIL] Verification FAILED (exit 2)', false)).toEqual({ code: null, failed: true });
  });
});

describe('reproObservationCommand', () => {
  it('records shell commands raw', () => {
    expect(reproObservationCommand('shell', { command: 'node repro.js' })).toBe('node repro.js');
  });
  it('records verify keyword commands in wrapped form (not re-runnable)', () => {
    expect(reproObservationCommand('verify', {})).toBe('verify(auto)');
    expect(reproObservationCommand('verify', { command: 'test' })).toBe('verify(test)');
  });
  it('records verify raw commands re-runnable', () => {
    expect(reproObservationCommand('verify', { command: 'node repro.js' })).toBe('node repro.js');
  });
  it('wraps bg_task commands', () => {
    expect(reproObservationCommand('bg_task', { command: 'node repro.js' })).toBe('bg_task(node repro.js)');
  });
});

describe('pickReproCandidates', () => {
  it('keeps distinct failing pre-phase shell commands, most recent first', () => {
    const list: ReproObservation[] = [
      obs({ command: 'node repro.js', at: 1 }),
      obs({ command: 'grep foo bar.js', at: 2 }),
      obs({ command: 'node repro.js', at: 3 }), // duplicate command
      obs({ command: 'node fixed.js', failed: false, at: 4 }), // passing
      obs({ command: 'verify(test)', at: 5 }), // not re-runnable
      obs({ command: 'node post.js', at: 6, phase: 'post' }), // post-phase
    ];
    expect(pickReproCandidates(list)).toEqual(['node repro.js', 'grep foo bar.js']);
  });
  it('caps the candidate list', () => {
    const list: ReproObservation[] = [1, 2, 3, 4].map((i) => obs({ command: `cmd${i}`, at: i }));
    expect(pickReproCandidates(list, 2)).toEqual(['cmd4', 'cmd3']);
  });
});

describe('deriveCriticVerdict', () => {
  it('is exempt when the gate does not apply (named reason rides out)', () => {
    const v = deriveCriticVerdict({ ...SUPPORTED_INPUT, exemption: 'task annotation reproExempt (operator opt-out)' });
    expect(v.verdict).toBe('exempt');
  });
  it('blocks an evidence-free conclusion after a bypass', () => {
    const v = deriveCriticVerdict({ ...SUPPORTED_INPUT, bypassed: true });
    expect(v.verdict).toBe('blocked');
    expect(v.verdict === 'blocked' && v.gaps[0]).toContain('no reproduction exists');
  });
  it('blocks when every pre-fix command passed (the failure was never observed)', () => {
    const v = deriveCriticVerdict({
      ...SUPPORTED_INPUT,
      observations: [obs({ failed: false, code: 0 })],
    });
    expect(v.verdict).toBe('blocked');
    expect(v.verdict === 'blocked' && v.gaps[0]).toContain('no failing reproduction');
  });
  it('supports a pair: same command failed pre and passed post (critic re-run)', () => {
    const v = deriveCriticVerdict({
      ...SUPPORTED_INPUT,
      observations: [obs({ command: 'node repro.js', failed: true, code: 1 }), obs({ command: 'node repro.js', phase: 'post', failed: false, code: 0 })],
    });
    expect(v.verdict).toBe('supported');
    expect(v.verdict === 'supported' && v.pairCommand).toBe('node repro.js');
  });
  it('supports a pair via the gate\u2019s green check of the same command', () => {
    const v = deriveCriticVerdict({
      ...SUPPORTED_INPUT,
      observations: [obs({ command: 'npm test', failed: true, code: 1 })],
      gateGreenChecks: ['npm test'],
    });
    expect(v.verdict).toBe('supported');
  });
  it('supports a keyword-verify pre-failure closed by a testish green gate check', () => {
    const v = deriveCriticVerdict({
      ...SUPPORTED_INPUT,
      observations: [obs({ command: 'verify(test)', tool: 'verify' })],
      gateGreenChecks: ['npm test'],
    });
    expect(v.verdict).toBe('supported');
  });
  it('supports the harness A/B pair', () => {
    const v = deriveCriticVerdict({ ...SUPPORTED_INPUT, bypassed: true, abPair: { command: 'node repro.js' } });
    expect(v.verdict).toBe('supported');
    expect(v.verdict === 'supported' && v.note).toContain('A/B');
  });
  it('blocks the false-fix class: the reproduction still fails after the fix', () => {
    const v = deriveCriticVerdict({
      ...SUPPORTED_INPUT,
      observations: [obs({ command: 'node repro.js', failed: true }), obs({ command: 'node repro.js', phase: 'post', failed: true, code: 1 })],
    });
    expect(v.verdict).toBe('blocked');
    expect(v.verdict === 'blocked' && v.gaps[0]).toContain('still fails after the fix');
  });
  it('blocks when the failing pre-fix observation was never re-run', () => {
    const v = deriveCriticVerdict({
      ...SUPPORTED_INPUT,
      observations: [obs({ command: 'node repro.js', failed: true })],
    });
    expect(v.verdict).toBe('blocked');
    expect(v.verdict === 'blocked' && v.gaps[0]).toContain('never re-run');
  });
});

describe('repro ledger persistence', () => {
  it('round-trips a per-task record and caps the task count', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-critic-ledger-'));
    try {
      // Workspace is the same store the flaky registry uses.
      const ws = new Workspace(dir, '.mochi');
      ws.ensure();
      const record: ReproLedgerRecord = {
        taskId: 't1',
        observations: [obs({})],
        vetoFired: true,
        bypassed: false,
        verdict: 'supported',
        updatedAt: 1,
      };
      saveReproLedgerRecord(ws, record);
      expect(loadReproLedger(ws).tasks.t1.verdict).toBe('supported');
      // Cap: write 60 tasks, only the most recent 50 remain (t1 evicted).
      for (let i = 0; i < 60; i++) {
        saveReproLedgerRecord(ws, { ...record, taskId: `x${i}`, updatedAt: 100 + i });
      }
      const ledger = loadReproLedger(ws);
      expect(Object.keys(ledger.tasks).length).toBe(50);
      expect(ledger.tasks.t1).toBeUndefined();
      expect(ledger.tasks.x59).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
