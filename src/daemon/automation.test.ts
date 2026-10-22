// Durable automation: store validation, trigger evaluation (schedule /
// file-change / url-change with baselines + catch-up), and the journal-
// backed exactly-once contract — a run interrupted between steps resumes
// by REPLAYING completed steps instead of re-executing their effects.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  addAutomation,
  evaluateAutomations,
  listAutomations,
  loadAutomations,
  removeAutomation,
  runAutomation,
  runDueAutomations,
  type AutomationDeps,
} from './automation.js';
import { readJournalEntries } from '../agent/run-journal.js';
import { mochiStateDir } from '../core/mochi-dir.js';

let dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(resolve(tmpdir(), 'mochi-auto-')); dirs.push(d); return d; };

describe('automation store', () => {
  it('adds, lists, removes with validation', () => {
    const dir = tmp();
    const ok = addAutomation(dir, {
      name: 'nightly',
      trigger: { type: 'schedule', schedule: 'every 1h' },
      steps: [{ id: 'g', kind: 'goal', prompt: 'tidy the repo' }],
    });
    expect(ok.id).toBeTruthy();
    expect(listAutomations(dir)).toHaveLength(1);
    // malformed inputs are refused, not persisted
    expect(addAutomation(dir, { name: 'x', trigger: { type: 'schedule', schedule: 'whenever' }, steps: [{ id: 'g', kind: 'goal', prompt: 'p' }] }).error).toBeTruthy();
    expect(addAutomation(dir, { name: 'x', trigger: { type: 'file-change', paths: [] }, steps: [{ id: 'g', kind: 'goal', prompt: 'p' }] }).error).toBeTruthy();
    expect(addAutomation(dir, {
      name: 'dup',
      trigger: { type: 'url-change', url: 'http://x.test/' },
      steps: [
        { id: 's', kind: 'shell', command: 'true' },
        { id: 's', kind: 'shell', command: 'true' },
      ],
    }).error).toMatch(/unique/);
    expect(listAutomations(dir)).toHaveLength(1);
    expect(removeAutomation(dir, ok.id!)).toBe(true);
    expect(listAutomations(dir)).toHaveLength(0);
  });

  it('a tampered store entry with an unparseable trigger is dropped on load', () => {
    const dir = tmp();
    addAutomation(dir, { name: 'good', trigger: { type: 'schedule', schedule: 'every 5m' }, steps: [{ id: 'g', kind: 'goal', prompt: 'p' }] });
    const file = resolve(mochiStateDir(dir), 'automations.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.push({ id: 'badbad00', name: 'bad', trigger: { type: 'schedule', schedule: 'not a schedule' }, steps: [{ id: 'g', kind: 'goal', prompt: 'p' }], enabled: true, createdAt: 1, runs: 0, lastRunAt: null, lastSlot: null, activeSlot: null, activeSlotAt: null });
    writeFileSync(file, JSON.stringify(raw));
    expect(loadAutomations(dir).map((a) => a.name)).toEqual(['good']);
  });
});

describe('trigger evaluation', () => {
  const shellDeps = (over: Partial<AutomationDeps> = {}): AutomationDeps => ({
    runShell: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    ...over,
  });

  it('schedule: first evaluation only initializes nextRun; due slot is the scheduled time', async () => {
    const dir = tmp();
    const t0 = 1_700_000_000_000;
    addAutomation(dir, { name: 's', trigger: { type: 'schedule', schedule: 'every 10m' }, steps: [{ id: 'x', kind: 'shell', command: 'true' }] });
    expect(await evaluateAutomations(dir, shellDeps({ now: () => t0 }))).toEqual([]);
    const [stored] = listAutomations(dir);
    expect(stored.nextRun).toBe(t0 + 600_000);
    const due = await evaluateAutomations(dir, shellDeps({ now: () => t0 + 600_001 }));
    expect(due).toHaveLength(1);
    expect(due[0].slotId).toBe(`s${t0 + 600_000}`);
    expect(due[0].reason).toBe('schedule');
  });

  it('file-change: baseline on first sight, fires on change with a state-derived slot', async () => {
    const dir = tmp();
    const watched = resolve(dir, 'watched.txt');
    writeFileSync(watched, 'v1');
    addAutomation(dir, { name: 'f', trigger: { type: 'file-change', paths: ['watched.txt'] }, steps: [{ id: 'x', kind: 'shell', command: 'true' }] });
    expect(await evaluateAutomations(dir, shellDeps())).toEqual([]); // baseline
    writeFileSync(watched, 'v2-longer');
    const due = await evaluateAutomations(dir, shellDeps());
    expect(due).toHaveLength(1);
    expect(due[0].reason).toBe('file-change');
    expect(due[0].slotId).toMatch(/^f[0-9a-f]{16}$/);
    // Same state again: no re-fire (the change is consumed).
    expect(await evaluateAutomations(dir, shellDeps())).toEqual([]);
  });

  it('url-change: baseline, then fires when the body hash changes; unreachable is not a change', async () => {
    const dir = tmp();
    let body = 'page-v1';
    let down = false;
    const deps = shellDeps({
      fetchText: async () => { if (down) throw new Error('ECONNREFUSED'); return { status: 200, body }; },
      now: () => 5_000_000,
    });
    addAutomation(dir, { name: 'u', trigger: { type: 'url-change', url: 'http://fixture.test/page', intervalMs: 0 }, steps: [{ id: 'x', kind: 'shell', command: 'true' }] });
    expect(await evaluateAutomations(dir, deps)).toEqual([]); // baseline
    down = true;
    expect(await evaluateAutomations(dir, deps)).toEqual([]); // unreachable: no fire, baseline kept
    down = false;
    expect(await evaluateAutomations(dir, deps)).toEqual([]); // unchanged
    body = 'page-v2';
    const due = await evaluateAutomations(dir, deps);
    expect(due).toHaveLength(1);
    expect(due[0].reason).toBe('url-change');
  });
});

describe('journal-backed execution', () => {
  it('a second run of the same slot replays every step — side effects happen exactly once', async () => {
    const dir = tmp();
    let shellCalls = 0;
    const deps: AutomationDeps = {
      runShell: async () => { shellCalls++; return { code: 0, stdout: 'did it', stderr: '' }; },
      runGoal: async () => 'goal summary',
    };
    const { id } = addAutomation(dir, {
      name: 'exactly-once',
      trigger: { type: 'schedule', schedule: 'every 1h' },
      steps: [
        { id: 'effect', kind: 'shell', command: 'mutate-the-world' },
        { id: 'think', kind: 'goal', prompt: 'reflect' },
      ],
    });
    const auto = listAutomations(dir)[0];
    const r1 = await runAutomation(dir, auto, 'slot-A', deps);
    expect(r1.executed).toEqual(['effect', 'think']);
    expect(r1.replayed).toEqual([]);
    expect(shellCalls).toBe(1);
    // Simulate the crash-and-resume path: same slot, fresh call.
    const r2 = await runAutomation(dir, listAutomations(dir)[0], 'slot-A', deps);
    expect(r2.executed).toEqual([]);
    expect(r2.replayed).toEqual(['effect', 'think']);
    expect(shellCalls).toBe(1); // <- the exactly-once assertion
    const rec = listAutomations(dir).find((a) => a.id === id)!;
    expect(rec.activeSlot).toBeNull();
    expect(rec.runs).toBe(2); // both calls completed the slot
    // The journal on disk is the audit trail for the slot.
    const lines = readJournalEntries(mochiStateDir(dir), `automation-${id}-slot-A`);
    expect(lines.some((l) => l.kind === 'run_finished')).toBe(true);
  });

  it('a failed step is journaled as failed, keeps activeSlot set, and is RETRIED (not replayed) on resume', async () => {
    const dir = tmp();
    let attempts = 0;
    const deps: AutomationDeps = {
      runShell: async () => {
        attempts++;
        if (attempts === 1) return { code: 3, stdout: '', stderr: 'boom' };
        return { code: 0, stdout: 'recovered', stderr: '' };
      },
    };
    addAutomation(dir, {
      name: 'flaky',
      trigger: { type: 'schedule', schedule: 'every 1h' },
      steps: [{ id: 'only', kind: 'shell', command: 'might-fail' }],
    });
    await expect(runAutomation(dir, listAutomations(dir)[0], 'slot-B', deps)).rejects.toThrow(/exited 3/);
    expect(listAutomations(dir)[0].activeSlot).toBe('slot-B'); // resume handle survives
    // The daemon's next evaluation sees the active slot as a resume, not a new firing.
    const due = await evaluateAutomations(dir, deps);
    expect(due.map((d) => [d.slotId, d.reason])).toEqual([['slot-B', 'resume']]);
    const r = await runAutomation(dir, listAutomations(dir)[0], 'slot-B', deps);
    expect(r.executed).toEqual(['only']);
    expect(attempts).toBe(2);
    expect(listAutomations(dir)[0].activeSlot).toBeNull();
  });

  it('goal steps receive a journal runId derived from the slot (loop-level replay identity)', async () => {
    const dir = tmp();
    const seen: string[] = [];
    const deps: AutomationDeps = { runGoal: async (_p, runId) => { seen.push(runId); return 'ok'; } };
    const { id } = addAutomation(dir, {
      name: 'goaly',
      trigger: { type: 'schedule', schedule: 'every 1h' },
      steps: [{ id: 'g1', kind: 'goal', prompt: 'do the thing' }],
    });
    await runAutomation(dir, listAutomations(dir)[0], 'slot-C', deps);
    expect(seen).toEqual([`automation-${id}-slot-C:g1`]);
  });

  it('runDueAutomations fires a due schedule trigger end-to-end and advances nextRun', async () => {
    const dir = tmp();
    const t0 = 1_700_000_000_000;
    let calls = 0;
    const deps: AutomationDeps = {
      now: () => t0 + 700_000,
      runShell: async () => { calls++; return { code: 0, stdout: '', stderr: '' }; },
    };
    addAutomation(dir, { name: 'due', trigger: { type: 'schedule', schedule: 'every 10m' }, steps: [{ id: 'x', kind: 'shell', command: 'true' }] });
    // Initialize nextRun in the past by evaluating at t0, then run due at t0+700s.
    await evaluateAutomations(dir, { ...deps, now: () => t0 });
    const results = await runDueAutomations(dir, deps);
    expect(results).toHaveLength(1);
    expect(calls).toBe(1);
    const rec = listAutomations(dir)[0];
    expect(rec.runs).toBe(1);
    expect(rec.lastSlot).toBe(`s${t0 + 600_000}`);
    // Advanced from the SLOT time (not from now), +1ms: the next-fire
    // search starts just after the slot so a cron-field schedule cannot
    // re-match its own minute and re-fire the slot it just completed.
    expect(rec.nextRun).toBe(t0 + 600_000 + 600_000 + 1);
  });
});
