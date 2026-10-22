// Phase C6 rails: the safety properties around the durable run journal —
//   (b) a fingerprint mismatch mid-journal executes that step live,
//   (c) a corrupted journal file degrades to a clean live run, no crash,
//   (d) workspace divergence (a recorded file touched, or git HEAD moved
//       outside the run) stops replay journal-wide,
// plus the persistence house rules: redaction before write, version skew
// never served, truncated outputs audit-only, usage never double-counted,
// and trace-style retention pruning of the journals directory.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RunJournal,
  journalFilePath,
  pruneRunJournals,
  JOURNAL_MAX_STORED_CHARS,
} from './run-journal.js';

/** Project layout the loop produces: base = <proj>/.mochi, root = <proj>. */
function tmpProject(): { base: string; root: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'mochi-journal-rails-'));
  const base = resolve(root, '.mochi');
  mkdirSync(base, { recursive: true });
  return { base, root };
}

function tmpBase(): string {
  return mkdtempSync(resolve(tmpdir(), 'mochi-journal-rails-flat-'));
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function initRepo(root: string): void {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@mochi.agent']);
  git(root, ['config', 'user.name', 'Mochi Test']);
  writeFileSync(resolve(root, 'seed.txt'), 'seed\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
}

describe('(d) workspace divergence stops replay', () => {
  it('a recorded file touched outside the run invalidates the whole journal', () => {
    const { base, root } = tmpProject();
    try {
      writeFileSync(resolve(root, 'note.txt'), 'v1\n');
      writeFileSync(resolve(root, 'other.txt'), 'other\n');
      const s1 = RunJournal.open({ baseDir: base, runId: 'div-file' });
      s1.recordToolResult({ toolCallId: 'w1', toolName: 'write', args: { path: 'note.txt', content: 'v1\n' }, output: 'wrote note.txt' });
      s1.recordToolResult({ toolCallId: 'r1', toolName: 'read', args: { path: 'other.txt' }, output: 'other body' });

      // Control: untouched workspace — both steps replay.
      const control = RunJournal.open({ baseDir: base, runId: 'div-file' });
      expect(control.claim({ stepId: 'w1', toolName: 'write', args: { path: 'note.txt', content: 'v1\n' } })?.output).toBe('wrote note.txt');
      expect(control.claim({ stepId: 'r1', toolName: 'read', args: { path: 'other.txt' } })?.output).toBe('other body');
      expect(control.stats().diverged).toBeUndefined();

      // External edit to the recorded file, then resume: nothing serves.
      writeFileSync(resolve(root, 'note.txt'), 'tampered by the user\n');
      const s2 = RunJournal.open({ baseDir: base, runId: 'div-file' });
      expect(s2.claim({ stepId: 'w1', toolName: 'write', args: { path: 'note.txt', content: 'v1\n' } })).toBeUndefined();
      expect(s2.stats().diverged).toBe(true);
      expect(s2.stats().divergenceReason).toContain('note.txt');
      // ...and replay stays stopped for later, unrelated entries too.
      expect(s2.claim({ stepId: 'r1', toolName: 'read', args: { path: 'other.txt' } })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a file rewritten by the run\'s own later steps is explained, not divergence', () => {
    const { base, root } = tmpProject();
    try {
      const s1 = RunJournal.open({ baseDir: base, runId: 'div-self' });
      writeFileSync(resolve(root, 'note.txt'), 'first\n');
      s1.recordToolResult({ toolCallId: 'w1', toolName: 'write', args: { path: 'note.txt', content: 'first\n' }, output: 'wrote first' });
      writeFileSync(resolve(root, 'note.txt'), 'second\n');
      s1.recordToolResult({ toolCallId: 'w2', toolName: 'write', args: { path: 'note.txt', content: 'second\n' }, output: 'wrote second' });

      // Resume finds the file at v2: claiming the v1 step must still work —
      // v2 is a state the journal itself recorded.
      const s2 = RunJournal.open({ baseDir: base, runId: 'div-self' });
      expect(s2.claim({ stepId: 'w1', toolName: 'write', args: { path: 'note.txt', content: 'first\n' } })?.output).toBe('wrote first');
      expect(s2.claim({ stepId: 'w2', toolName: 'write', args: { path: 'note.txt', content: 'second\n' } })?.output).toBe('wrote second');
      expect(s2.stats().diverged).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('git HEAD moved by an outside commit invalidates replay; an unmoved HEAD replays', () => {
    const { base, root } = tmpProject();
    try {
      initRepo(root);
      const s1 = RunJournal.open({ baseDir: base, runId: 'div-git' });
      s1.recordToolResult({ toolCallId: 'sh1', toolName: 'shell', args: { command: 'ls' }, output: 'seed.txt' });

      // Control: HEAD untouched — the step replays.
      const control = RunJournal.open({ baseDir: base, runId: 'div-git' });
      expect(control.claim({ stepId: 'sh1', toolName: 'shell', args: { command: 'ls' } })?.output).toBe('seed.txt');

      // An outside commit moves HEAD: replay must stop.
      writeFileSync(resolve(root, 'seed.txt'), 'changed outside\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', 'outside work']);
      const s2 = RunJournal.open({ baseDir: base, runId: 'div-git' });
      expect(s2.claim({ stepId: 'sh1', toolName: 'shell', args: { command: 'ls' } })).toBeUndefined();
      expect(s2.stats().diverged).toBe(true);
      expect(s2.stats().divergenceReason).toContain('git HEAD');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('(b) fingerprint mismatch mid-journal', () => {
  it('the mismatched step executes live; matching neighbours still replay', async () => {
    const base = tmpBase();
    try {
      const counters = { a: 0, b: 0, c: 0 };
      const s1 = RunJournal.open({ baseDir: base, runId: 'mismatch' });
      await s1.executeStep({ stepId: 'a', toolName: 'tool', args: { n: 1 }, execute: () => { counters.a++; return 'A'; } });
      await s1.executeStep({ stepId: 'b', toolName: 'tool', args: { n: 2 }, execute: () => { counters.b++; return 'B'; } });
      await s1.executeStep({ stepId: 'c', toolName: 'tool', args: { n: 3 }, execute: () => { counters.c++; return 'C'; } });
      expect(counters).toEqual({ a: 1, b: 1, c: 1 });

      const s2 = RunJournal.open({ baseDir: base, runId: 'mismatch' });
      const ra = await s2.executeStep({ stepId: 'a2', toolName: 'tool', args: { n: 1 }, execute: () => { counters.a++; return 'A-live'; } });
      expect(ra.replayed).toBe(true);
      // Step b with CHANGED args: no fingerprint match — runs live.
      const rb = await s2.executeStep({ stepId: 'b2', toolName: 'tool', args: { n: 22 }, execute: () => { counters.b++; return 'B-live'; } });
      expect(rb.replayed).toBe(false);
      expect(rb.result).toBe('B-live');
      // Step c is untouched by b's detour: still served from the journal.
      const rc = await s2.executeStep({ stepId: 'c2', toolName: 'tool', args: { n: 3 }, execute: () => { counters.c++; return 'C-live'; } });
      expect(rc.replayed).toBe(true);
      expect(counters).toEqual({ a: 1, b: 2, c: 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('(c) corrupted journal degrades to a clean live run', () => {
  it('a fully corrupted file: no crash, steps execute live, journal recovers', async () => {
    const base = tmpBase();
    try {
      const file = journalFilePath(base, 'corrupt');
      mkdirSync(resolve(base, 'journals'), { recursive: true });
      writeFileSync(file, ' ��� not json at all {{{{\nmore garbage\n');

      let calls = 0;
      const j = RunJournal.open({ baseDir: base, runId: 'corrupt' });
      expect(j.completedCount).toBe(0);
      expect(j.stats().corruptLines).toBeGreaterThan(0);
      const r = await j.executeStep({ stepId: 's1', execute: () => { calls++; return 'fresh'; } });
      expect(r.replayed).toBe(false);
      expect(r.result).toBe('fresh');
      expect(calls).toBe(1);

      // The journal recovers: steps recorded after the corruption load and
      // replay on the next open (bad lines are skipped, not fatal).
      const resumed = RunJournal.open({ baseDir: base, runId: 'corrupt' });
      const r2 = await resumed.executeStep({ stepId: 's1', execute: () => { calls++; return 'fresh-2'; } });
      expect(r2.replayed).toBe(true);
      expect(calls).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('persistence house rules', () => {
  it('secrets in output, error and args are redacted before they reach disk', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'redact' });
      j.recordToolResult({
        toolCallId: 'c1',
        toolName: 'shell',
        args: { command: 'deploy', apiKey: 'hunter2-secret-value' },
        output: 'deployed with OPENAI_API_KEY=sk-live-abcdef1234567890',
        durationMs: 1,
      });
      const raw = readFileSync(journalFilePath(base, 'redact'), 'utf8');
      expect(raw).not.toContain('hunter2-secret-value');
      expect(raw).not.toContain('sk-live-abcdef1234567890');
      expect(raw).toContain('[secret-redacted]');

      // And the replayed text is the redacted text, never the secret.
      const resumed = RunJournal.open({ baseDir: base, runId: 'redact' });
      const claimed = resumed.claim({ stepId: 'c1', toolName: 'shell', args: { command: 'deploy', apiKey: 'hunter2-secret-value' } });
      expect(claimed?.output).toContain('[secret-redacted]');
      expect(claimed?.output).not.toContain('sk-live');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a step line from a newer format version is never served (version skew)', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'skew' });
      j.recordToolResult({ toolCallId: 'c1', toolName: 'read', args: { path: 'x' }, output: 'X' });
      // Simulate a future build's entry in the same file.
      const future = JSON.stringify({
        kind: 'step', v: 99, seq: 99, runId: 'skew', stepId: 'c2', stepKind: 'tool_call',
        signature: 'read deadbeef', toolName: 'read', argsHash: 'deadbeef',
        status: 'completed', output: 'FROM THE FUTURE', sessionId: 'future', completedAt: Date.now(),
      });
      appendFileSync(journalFilePath(base, 'skew'), future + '\n', 'utf8');

      const resumed = RunJournal.open({ baseDir: base, runId: 'skew' });
      expect(resumed.stats().versionSkew).toBe(true);
      expect(resumed.claim({ stepId: 'c1', toolName: 'read', args: { path: 'x' } })).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('an output-truncated entry is audit-only — recorded, never replayed', () => {
    const base = tmpBase();
    try {
      const big = 'x'.repeat(JOURNAL_MAX_STORED_CHARS + 1000);
      const j = RunJournal.open({ baseDir: base, runId: 'big-output' });
      const entry = j.recordToolResult({ toolCallId: 'c1', toolName: 'shell', args: { command: 'spam' }, output: big });
      expect(entry.outputTruncated).toBe(true);
      expect(entry.outputHash).toBeTruthy();
      expect(entry.summary).toHaveLength(300);

      const resumed = RunJournal.open({ baseDir: base, runId: 'big-output' });
      expect(resumed.entries()).toHaveLength(1);
      expect(resumed.claim({ stepId: 'c1', toolName: 'shell', args: { command: 'spam' } })).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('step kinds + usage: model turns and verify steps are first-class, usage never double-counts', () => {
    const base = tmpBase();
    try {
      const j = RunJournal.open({ baseDir: base, runId: 'kinds' });
      j.recordModelTurn({ stepId: 'turn-1', output: 'thinking…', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, durationMs: 5 });
      j.recordToolResult({ toolCallId: 'v1', toolName: 'verify', args: { command: 'npm test' }, output: 'PASS', durationMs: 7 });

      const kinds = j.entries().map((e) => [e.toolName, e.stepKind]);
      expect(kinds).toEqual([['model_turn', 'model_turn'], ['verify', 'verify']]);
      expect(j.stats().usage).toEqual({ durationMs: 12, inputTokens: 100, outputTokens: 50 });

      // Resume: identical totals — replay adds nothing to the bill.
      const resumed = RunJournal.open({ baseDir: base, runId: 'kinds' });
      expect(resumed.stats().usage).toEqual({ durationMs: 12, inputTokens: 100, outputTokens: 50 });
      const turn = resumed.claim({ stepId: 'turn-1', toolName: 'model_turn', args: {} });
      expect(turn?.usage).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
      expect(resumed.stats().usage).toEqual({ durationMs: 12, inputTokens: 100, outputTokens: 50 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('retention pruning bounds the journals directory, oldest first, sparing the kept file', () => {
    const base = tmpBase();
    try {
      const dir = resolve(base, 'journals');
      mkdirSync(dir, { recursive: true });
      const old = new Date(Date.now() - 86_400_000);
      for (let i = 0; i < 105; i++) {
        const p = resolve(dir, `run-${String(i).padStart(3, '0')}.jsonl`);
        writeFileSync(p, '{"kind":"run_started"}\n');
        utimesSync(p, old, old);
      }
      const keep = resolve(dir, 'run-keep.jsonl');
      writeFileSync(keep, '{"kind":"run_started"}\n');
      utimesSync(keep, old, old);

      const removed = pruneRunJournals(base, { keepFile: keep, maxFiles: 100 });
      expect(removed).toBeGreaterThanOrEqual(5);
      expect(existsSync(keep)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
