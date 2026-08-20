// Cron scheduler: interval + 5-field cron parsing and job persistence.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { everyInterval, nextRunFor, addJob, listJobs, dueJobs, removeJob, bumpJob, isRunnable, updateJob, notifyJobResult } from './cron.js';

let dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(resolve(tmpdir(), 'mochi-cron-')); dirs.push(d); return d; };

describe('everyInterval', () => {
  it('parses unit forms', () => {
    expect(everyInterval('every 30m')).toBe(30 * 60_000);
    expect(everyInterval('every 2 hours')).toBe(2 * 3_600_000);
    expect(everyInterval('every day')).toBe(86_400_000);
    expect(everyInterval('every week')).toBe(7 * 86_400_000);
    expect(everyInterval('every 9h')).toBe(9 * 3_600_000);
  });
  it('rejects junk', () => {
    expect(everyInterval('0 9 * * 1-5')).toBeNull();
    expect(everyInterval('whenever')).toBeNull();
  });
});

describe('nextRunFor', () => {
  it('interval: from now + interval', () => {
    const from = Date.now();
    expect(nextRunFor('every 10m', from)).toBe(from + 600_000);
  });
  it('cron: returns a time at/after from', () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0); // Jan 1 00:00
    const n = nextRunFor('0 9 * * 1-5', from);
    expect(n).toBeGreaterThanOrEqual(from);
  });
});

describe('job persistence', () => {
  it('adds, lists, and removes jobs', () => {
    const dir = tmp();
    const r = addJob(dir, 'run the test suite', 'every 5m');
    expect(r.id).toBeTruthy();
    expect(isRunnable('every 5m')).toBe(true);
    const jobs = listJobs(dir);
    expect(jobs.length).toBe(1);
    expect(jobs[0].prompt).toBe('run the test suite');
    expect(removeJob(dir, jobs[0].id)).toBe(true);
    expect(listJobs(dir).length).toBe(0);
  });

  it('rejects an unparseable schedule', () => {
    const dir = tmp();
    const r = addJob(dir, 'x', 'not a schedule');
    expect(r.error).toBeTruthy();
    expect(r.id).toBeUndefined();
  });

  it('dueJobs returns jobs whose time has come', () => {
    const dir = tmp();
    addJob(dir, 'every-minute task', 'every 1m');
    // manually set nextRun in the past
    const jobs = listJobs(dir);
    const past = { ...jobs[0], nextRun: Date.now() - 1 };
    // rewrite file by direct manipulation
    const fs = require('node:fs');
    require('node:fs').writeFileSync(resolve(dir, '.mochi', 'cron.json'), JSON.stringify([past], null, 2));
    const due = dueJobs(dir);
    expect(due.length).toBe(1);
  });

  it('bumpJob advances nextRun and counts runs', () => {
    const dir = tmp();
    addJob(dir, 'tick', 'every 1m');
    const job = { ...listJobs(dir)[0], runs: 4 };
    const bumped = bumpJob(job);
    expect(bumped.runs).toBe(5);
    expect(bumped.nextRun).toBeGreaterThan(bumped.lastRun ?? 0);
    expect(bumped.nextRun).toBeGreaterThan(Date.now());
  });
});


describe('updateJob persistence', () => {
  it('persists nextRun advance so a due job does not re-fire', () => {
    const dir = tmp();
    addJob(dir, 'tick once', 'every 1m');
    const before = listJobs(dir)[0];
    // simulate a run: bump + persist (what the daemon ticker does)
    updateJob(dir, bumpJob(before));
    const after = listJobs(dir)[0];
    expect(after.runs).toBe(before.runs + 1);
    expect(after.nextRun).toBeGreaterThan(Date.now());
    // now it should no longer be due immediately
    expect(dueJobs(dir).some((j) => j.id === after.id)).toBe(false);
  });
});


describe('notifyJobResult', () => {
  it('POSTs to a webhook URL with the summary', async () => {
    const { createServer } = await import('node:http');
    let received: unknown = null;
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { received = JSON.parse(b); res.writeHead(200); res.end(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const job = { id: 'job1', prompt: 'run tests', schedule: 'every 1m', lastRun: null, nextRun: 0, createdAt: 0, enabled: true, runs: 0, notify: `http://127.0.0.1:${addr.port}/hook` };
    await notifyJobResult(job, 'Goal completed. 1 done, 0 failed.');
    expect((received as any)?.summary).toContain('1 done');
    expect((received as any)?.prompt).toBe('run tests');
    await new Promise<void>((r) => server.close(() => r()));
  }, 15_000);

  it('runs a shell command with the summary in an env var', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-notify-'));
    const out = resolve(dir, 'got.txt');
    const job = { id: 'job2', prompt: 'x', schedule: 'every 1m', lastRun: null, nextRun: 0, createdAt: 0, enabled: true, runs: 0, notify: `echo "$MOCHI_JOB_SUMMARY" > ${out}` };
    await notifyJobResult(job, 'the summary text');
    expect(readFileSync(out, 'utf8').trim()).toBe('the summary text');
  }, 15_000);
});

