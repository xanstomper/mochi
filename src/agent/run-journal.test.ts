// Phase C6: durable run journal — falsifiable kill/resume tests.
//
// The core assertion: a run killed mid-way (journal instance abandoned with
// no finish marker, exactly what SIGKILL leaves behind) resumes from the
// on-disk journal and does NOT re-execute completed steps — proven with
// side-effect counters — while the run still completes.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  RunJournal,
  runJournaledSteps,
  readJournalEntries,
  listRunJournals,
  journalFilePath,
  hashArgs,
  stepSignature,
  isJournalableTool,
  type JournaledStep,
} from './run-journal.js';

function tmpBase(): string {
  return mkdtempSync(resolve(tmpdir(), 'mochi-journal-'));
}

describe('RunJournal durability', () => {
  it('records steps to disk as JSONL as they complete', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'run-1', taskId: 'task-1' });
      j.beginRun({ taskId: 'task-1', title: 'Demo' });
      j.recordToolResult({ toolCallId: 'call-1', toolName: 'read', args: { path: 'a.ts' }, output: 'file body', durationMs: 3 });
      j.recordToolResult({ toolCallId: 'call-2', toolName: 'shell', args: { command: 'npm test' }, output: 'exit_code: 1', error: 'shell command exited with code 1', durationMs: 9 });

      const file = journalFilePath(base, 'run-1');
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(lines[0].kind).toBe('run_started');
      const steps = lines.filter((l) => l.kind === 'step');
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ stepId: 'call-1', toolName: 'read', status: 'completed', output: 'file body' });
      expect(steps[1]).toMatchObject({ stepId: 'call-2', status: 'failed' });

      const entries = readJournalEntries(base, 'run-1');
      expect(entries.filter((e) => e.kind === 'step')).toHaveLength(2);
      expect(listRunJournals(base)).toContain('run-1');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('hashArgs is key-order stable and value sensitive', () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: 3 } })).toBe(hashArgs({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(stepSignature('read', { path: 'x' })).not.toBe(stepSignature('write', { path: 'x' }));
  });

  it('tolerates a torn final line (crash mid-append) and still loads prior steps', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'torn' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'a' }, output: 'A' });
      // Simulate SIGKILL halfway through the next append.
      appendFileSync(journalFilePath(base, 'torn'), '{"kind":"step","stepId":"c2","outp', 'utf8');

      const resumed = RunJournal.open({ baseDir: base, runId: 'torn' });
      expect(resumed.completedCount).toBe(1);
      expect(resumed.claimById('c1')?.output).toBe('A');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('journals are isolated by runId', () => {
    const base = tmpBase();
    try {
      const a = RunJournal.open({ baseDir: base, runId: 'run-a' });
      a.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'x' }, output: 'A' });
      const b = RunJournal.open({ baseDir: base, runId: 'run-b' });
      expect(b.completedCount).toBe(0);
      expect(b.claim({ toolName: 'read', args: { path: 'x' } })).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('failed steps are journaled for audit but never replayed — resume retries them', async () => {
    const base = tmpBase();
    try {
      let attempts = 0;
      const flaky = async () => {
        attempts++;
        if (attempts === 1) throw new Error('boom');
        return 'ok';
      };
      const first = RunJournal.open({ baseDir: base, runId: 'flaky' });
      await expect(first.executeStep({ stepId: 's1', execute: flaky })).rejects.toThrow('boom');
      expect(first.entries().filter((e) => e.status === 'failed')).toHaveLength(1);

      const resumed = RunJournal.open({ baseDir: base, runId: 'flaky' });
      const out = await resumed.executeStep({ stepId: 's1', execute: flaky });
      expect(out.replayed).toBe(false);
      expect(out.result).toBe('ok');
      expect(attempts).toBe(2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('steps recorded by the SAME session are not claimable until the journal is reopened', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'session-boundary' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'x' }, output: 'X' });
      // Same live session: the in-process ExecutionRegistry owns dedupe;
      // the journal must not serve its own just-written steps.
      expect(j.claim({ stepId: 'c1', toolName: 'read', args: { path: 'x' } })).toBeUndefined();
      expect(j.isCompleted('c1')).toBe(true);
      // Reopen (resume): now claimable.
      const resumed = RunJournal.open({ baseDir: base, runId: 'session-boundary' });
      expect(resumed.claim({ stepId: 'c1', toolName: 'read', args: { path: 'x' } })?.output).toBe('X');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('signature claims are FIFO: identical calls replay in order, then execute fresh', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'fifo' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'same' }, output: 'first' });
      j.recordToolResult({ toolCallId: 'c2', toolName: 'read', args: { path: 'same' }, output: 'second' });

      const resumed = RunJournal.open({ baseDir: base, runId: 'fifo' });
      // Resumed model regenerates tool_call_ids — signature must still hit.
      expect(resumed.claim({ stepId: 'new-1', toolName: 'read', args: { path: 'same' } })?.output).toBe('first');
      expect(resumed.claim({ stepId: 'new-2', toolName: 'read', args: { path: 'same' } })?.output).toBe('second');
      // No third journaled call: a further identical call executes for real.
      expect(resumed.claim({ stepId: 'new-3', toolName: 'read', args: { path: 'same' } })).toBeUndefined();
      // Different args never replay.
      expect(resumed.claim({ toolName: 'read', args: { path: 'other' } })).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('session-local / interactive tools are excluded from journaling', () => {
    expect(isJournalableTool('load_tools')).toBe(false);
    expect(isJournalableTool('ask_question')).toBe(false);
    expect(isJournalableTool('write')).toBe(true);
    expect(isJournalableTool('shell')).toBe(true);
  });
});

describe('kill + resume (falsifiable)', () => {
  it('completed steps are NOT re-executed after a simulated mid-run kill; the run still completes', async () => {
    const base = tmpBase();
    try {
      // Side-effect counters: the ground truth for "did this step re-run".
      const counters = { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
      const makeSteps = (): Array<JournaledStep<string>> => [
        { id: 'step-1', execute: () => { counters.s1++; return 'one'; } },
        { id: 'step-2', execute: () => { counters.s2++; return 'two'; } },
        { id: 'step-3', execute: () => { counters.s3++; return 'three'; } },
        { id: 'step-4', execute: () => { counters.s4++; return 'four'; } },
        { id: 'step-5', execute: () => { counters.s5++; return 'five'; } },
      ];

      // ── Session 1: execute steps 1–3, then "SIGKILL" ──────────────────
      // The journal instance is simply abandoned: no finishRun, no close,
      // no cleanup — exactly the on-disk state a killed process leaves.
      const killed = RunJournal.open({ baseDir: base, runId: 'kill-run', taskId: 'task-k' });
      killed.beginRun({ taskId: 'task-k' });
      const steps = makeSteps();
      for (const step of steps.slice(0, 3)) {
        const r = await killed.executeStep({ stepId: step.id, execute: step.execute });
        expect(r.replayed).toBe(false);
      }
      expect(counters).toEqual({ s1: 1, s2: 1, s3: 1, s4: 0, s5: 0 });
      // (process dies here — `killed` is never touched again)

      // ── Session 2: resume with a fresh journal over the same runId ────
      const resumed = RunJournal.open({ baseDir: base, runId: 'kill-run', taskId: 'task-k' });
      expect(resumed.completedCount).toBe(3);
      const results = await runJournaledSteps(resumed, makeSteps());

      // Completed steps replayed from the journal: counters UNCHANGED.
      expect(counters.s1).toBe(1);
      expect(counters.s2).toBe(1);
      expect(counters.s3).toBe(1);
      // Remaining steps executed exactly once...
      expect(counters.s4).toBe(1);
      expect(counters.s5).toBe(1);
      // ...and the run still completes with the full, correct result set.
      expect(results.map((r) => r.result)).toEqual(['one', 'two', 'three', 'four', 'five']);
      expect(results.map((r) => r.replayed)).toEqual([true, true, true, false, false]);
      expect(resumed.stats().replayedSteps).toBe(3);
      resumed.finishRun('completed');

      // ── Session 3: a second resume replays everything ────────────────
      const again = RunJournal.open({ baseDir: base, runId: 'kill-run', taskId: 'task-k' });
      const third = await runJournaledSteps(again, makeSteps());
      expect(third.every((r) => r.replayed)).toBe(true);
      expect(counters).toEqual({ s1: 1, s2: 1, s3: 1, s4: 1, s5: 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a step killed IN FLIGHT (executor throws) is retried on resume, completed neighbours are not', async () => {
    const base = tmpBase();
    try {
      const counters = { a: 0, b: 0, c: 0 };
      let bShouldFail = true;
      const steps = (): Array<JournaledStep<string>> => [
        { id: 'a', execute: () => { counters.a++; return 'A'; } },
        {
          id: 'b',
          execute: () => {
            counters.b++;
            if (bShouldFail) throw new Error('killed mid-step');
            return 'B';
          },
        },
        { id: 'c', execute: () => { counters.c++; return 'C'; } },
      ];

      const first = RunJournal.open({ baseDir: base, runId: 'inflight' });
      await expect(runJournaledSteps(first, steps())).rejects.toThrow('killed mid-step');
      expect(counters).toEqual({ a: 1, b: 1, c: 0 });

      bShouldFail = false;
      const resumed = RunJournal.open({ baseDir: base, runId: 'inflight' });
      const out = await runJournaledSteps(resumed, steps());
      expect(out.map((r) => r.result)).toEqual(['A', 'B', 'C']);
      expect(out.map((r) => r.replayed)).toEqual([true, false, false]);
      // 'a' never re-ran; the in-flight 'b' retried exactly once; 'c' ran once.
      expect(counters).toEqual({ a: 1, b: 2, c: 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('executeStep replays structured results via JSON round-trip in a new session', async () => {
    const base = tmpBase();
    try {
      let calls = 0;
      const exec = () => { calls++; return { files: ['a.ts', 'b.ts'], total: 42 }; };
      const first = RunJournal.open({ baseDir: base, runId: 'structured' });
      const r1 = await first.executeStep({ stepId: 'analyze', execute: exec });
      expect(r1.replayed).toBe(false);

      const resumed = RunJournal.open({ baseDir: base, runId: 'structured' });
      const r2 = await resumed.executeStep({ stepId: 'analyze', execute: exec });
      expect(r2.replayed).toBe(true);
      expect(r2.result).toEqual({ files: ['a.ts', 'b.ts'], total: 42 });
      expect(calls).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
