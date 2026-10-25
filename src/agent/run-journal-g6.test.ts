// G6 — journal write-failure tolerance (queue item 4, first half).
//
// The defect: one transient write error latched the journal into
// in-memory-only mode for the rest of the run, and a torn tail stayed in
// the file forever (a later append could glue onto it). These tests inject
// real failures — a mocked EPERM storm, a failed fsync, a chmod'd
// read-only file, torn bytes — and prove the run is never lost: retries
// land, duplicates never appear, durability recovers, tails salvage.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync, chmodSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  RunJournal,
  runJournaledSteps,
  journalFilePath,
  type JournaledStep,
} from './run-journal.js';

// Fault-injection state, shared with the node:fs mock below. The mock
// wraps ONLY appendFileSync/fsyncSync; every other fs function is the
// real one, so these tests exercise the real write path.
const fsFaults = vi.hoisted(() => ({ appendFailures: 0, fsyncFailures: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realAppend = actual.appendFileSync as (...args: any[]) => unknown;
  const realFsync = actual.fsyncSync as (...args: any[]) => unknown;
  return {
    ...actual,
    appendFileSync: (...args: any[]) => {
      if (fsFaults.appendFailures > 0) {
        fsFaults.appendFailures--;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return realAppend(...args);
    },
    fsyncSync: (...args: any[]) => {
      if (fsFaults.fsyncFailures > 0) {
        fsFaults.fsyncFailures--;
        throw Object.assign(new Error('fsync failed'), { code: 'EIO' });
      }
      return realFsync(...args);
    },
  };
});

function tmpBase(): string {
  return mkdtempSync(resolve(tmpdir(), 'mochi-journal-g6-'));
}

function stepLines(base: string, runId: string): Array<Record<string, unknown>> {
  const file = journalFilePath(base, runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind === 'step');
}

describe('G6 journal write-failure tolerance', () => {
  beforeEach(() => {
    fsFaults.appendFailures = 0;
    fsFaults.fsyncFailures = 0;
  });

  it('transient append failures are retried and the entry still lands', () => {
    const base = tmpBase();
    try {
      fsFaults.appendFailures = 2;
      const j = RunJournal.open({ baseDir: base, runId: 'retry' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'x' }, output: 'X' });
      expect(j.isDurable).toBe(true);
      expect(j.stats().writeRetries).toBe(2);
      expect(j.stats().writeFailures).toBeUndefined();
      expect(stepLines(base, 'retry')).toHaveLength(1);

      const resumed = RunJournal.open({ baseDir: base, runId: 'retry' });
      expect(resumed.claim({ stepId: 'new', toolName: 'read', args: { path: 'x' } })?.output).toBe('X');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a write that landed but whose fsync failed is never duplicated', () => {
    const base = tmpBase();
    try {
      fsFaults.fsyncFailures = 1;
      const j = RunJournal.open({ baseDir: base, runId: 'dedup' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'x' }, output: 'X' });
      // Dedupe short-circuit: no retry was needed, no duplicate written.
      // (stats() omits zero counters — writeRetries is absent, not 0.)
      expect(j.stats().writeRetries).toBeUndefined();
      expect(j.isDurable).toBe(true);
      expect(stepLines(base, 'dedup')).toHaveLength(1);

      const resumed = RunJournal.open({ baseDir: base, runId: 'dedup' });
      expect(resumed.claim({ stepId: 'n1', toolName: 'read', args: { path: 'x' } })?.output).toBe('X');
      // Exactly one claimable entry: a duplicate would serve a second time.
      expect(resumed.claim({ stepId: 'n2', toolName: 'read', args: { path: 'x' } })).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a persistent failure degrades one append, then durability recovers', () => {
    // Root bypasses file permissions, so the chmod window cannot fail.
    if (process.getuid?.() === 0) {
      console.log('skip: running as root, chmod cannot force write failure');
      return;
    }
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'recover' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'a' }, output: 'A' });
      const file = journalFilePath(base, 'recover');
      chmodSync(file, 0o444);
      // All retries exhausted inside the failure window: this append — and
      // ONLY this append — degrades to in-memory.
      j.recordToolResult({ toolCallId: 'c2', toolName: 'read', args: { path: 'b' }, output: 'B' });
      expect(j.isDurable).toBe(false);
      expect(j.stats().writeFailures).toBe(1);
      chmodSync(file, 0o644);
      // The next append retries the file and durability is back.
      j.recordToolResult({ toolCallId: 'c3', toolName: 'read', args: { path: 'c' }, output: 'C' });
      expect(j.isDurable).toBe(true);

      const resumed = RunJournal.open({ baseDir: base, runId: 'recover' });
      expect(resumed.claim({ stepId: 'n1', toolName: 'read', args: { path: 'a' } })?.output).toBe('A');
      // The in-window step never landed: honestly absent, not fabricated.
      expect(resumed.claim({ stepId: 'n2', toolName: 'read', args: { path: 'b' } })).toBeUndefined();
      expect(resumed.claim({ stepId: 'n3', toolName: 'read', args: { path: 'c' } })?.output).toBe('C');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a torn tail is salvaged on open and later appends do not glue onto it', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'salvage' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'a' }, output: 'A' });
      j.recordToolResult({ toolCallId: 'c2', toolName: 'read', args: { path: 'b' }, output: 'B' });
      // Simulate SIGKILL halfway through the next append.
      appendFileSync(journalFilePath(base, 'salvage'), '{"kind":"step","stepId":"c3","outp', 'utf8');

      const resumed = RunJournal.open({ baseDir: base, runId: 'salvage' });
      expect(resumed.completedCount).toBe(2);
      expect(resumed.stats().tailRepaired).toBe(true);
      expect(resumed.stats().salvagedBytes).toBeGreaterThan(0);
      const raw = readFileSync(journalFilePath(base, 'salvage'), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      // The next append lands on a clean line boundary.
      resumed.recordToolResult({ toolCallId: 'c3', toolName: 'read', args: { path: 'c' }, output: 'C' });
      const again = RunJournal.open({ baseDir: base, runId: 'salvage' });
      expect(again.completedCount).toBe(3);
      expect(again.claim({ stepId: 'n3', toolName: 'read', args: { path: 'c' } })?.output).toBe('C');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a complete-but-unterminated line is normalized, not dropped', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'unterm' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'a' }, output: 'A' });
      j.recordToolResult({ toolCallId: 'c2', toolName: 'read', args: { path: 'b' }, output: 'B' });
      // The write landed the closing brace but died before the newline.
      const file = journalFilePath(base, 'unterm');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\n$/, ''), 'utf8');

      const resumed = RunJournal.open({ baseDir: base, runId: 'unterm' });
      expect(resumed.completedCount).toBe(2);
      expect(resumed.stats().tailRepaired).toBe(true);
      expect(resumed.stats().salvagedBytes).toBeUndefined();
      expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
      resumed.recordToolResult({ toolCallId: 'c3', toolName: 'read', args: { path: 'c' }, output: 'C' });
      const again = RunJournal.open({ baseDir: base, runId: 'unterm' });
      expect(again.completedCount).toBe(3);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('mid-file corruption is left alone — only the tail is salvaged', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'midcorr' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'a' }, output: 'A' });
      j.recordToolResult({ toolCallId: 'c2', toolName: 'read', args: { path: 'b' }, output: 'B' });
      j.recordToolResult({ toolCallId: 'c3', toolName: 'read', args: { path: 'c' }, output: 'C' });
      const file = journalFilePath(base, 'midcorr');
      const lines = readFileSync(file, 'utf8').split('\n');
      lines[1] = 'GARBAGE{';
      writeFileSync(file, lines.join('\n'), 'utf8');

      const resumed = RunJournal.open({ baseDir: base, runId: 'midcorr' });
      expect(resumed.completedCount).toBe(2);
      expect(resumed.stats().corruptLines).toBe(1);
      expect(resumed.stats().tailRepaired).toBeUndefined();
      // The corrupt line is still there, byte for byte — salvage never
      // rewrites anything but a torn tail.
      expect(readFileSync(file, 'utf8')).toContain('GARBAGE{');
      resumed.recordToolResult({ toolCallId: 'c4', toolName: 'read', args: { path: 'd' }, output: 'D' });
      const again = RunJournal.open({ baseDir: base, runId: 'midcorr' });
      expect(again.completedCount).toBe(3);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a run survives a failure window mid-sequence: only the in-window step re-executes', async () => {
    if (process.getuid?.() === 0) {
      console.log('skip: running as root, chmod cannot force write failure');
      return;
    }
    const base = tmpBase();
    try {
      const counters = { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
      const makeSteps = (): Array<JournaledStep<string>> => [
        { id: 'step-1', execute: () => { counters.s1++; return 'one'; } },
        { id: 'step-2', execute: () => { counters.s2++; return 'two'; } },
        { id: 'step-3', execute: () => { counters.s3++; return 'three'; } },
        { id: 'step-4', execute: () => { counters.s4++; return 'four'; } },
        { id: 'step-5', execute: () => { counters.s5++; return 'five'; } },
      ];

      // Session 1: a write-failure window opens around step 3 only.
      const first = RunJournal.open({ baseDir: base, runId: 'window' });
      const steps = makeSteps();
      for (const step of steps.slice(0, 2)) {
        await first.executeStep({ stepId: step.id, execute: step.execute });
      }
      const file = journalFilePath(base, 'window');
      chmodSync(file, 0o444);
      const r3 = await first.executeStep({ stepId: steps[2].id, execute: steps[2].execute });
      expect(r3.replayed).toBe(false); // executed, but its append failed
      expect(first.stats().writeFailures).toBe(1);
      chmodSync(file, 0o644);
      for (const step of steps.slice(3)) {
        await first.executeStep({ stepId: step.id, execute: step.execute });
      }
      expect(first.isDurable).toBe(true);
      expect(counters).toEqual({ s1: 1, s2: 1, s3: 1, s4: 1, s5: 1 });

      // Session 2 (resume): everything replays except the in-window step,
      // which re-executes exactly once — the run is NOT lost.
      const resumed = RunJournal.open({ baseDir: base, runId: 'window' });
      const results = await runJournaledSteps(resumed, makeSteps());
      expect(results.map((r) => r.result)).toEqual(['one', 'two', 'three', 'four', 'five']);
      expect(results.map((r) => r.replayed)).toEqual([true, true, false, true, true]);
      expect(counters).toEqual({ s1: 1, s2: 1, s3: 2, s4: 1, s5: 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
