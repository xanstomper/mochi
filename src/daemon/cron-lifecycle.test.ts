import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addJob, listJobs, dueJobs, setJobPaused, runJobNow, getJob,
  runDueCronJobs, removeJob,
} from './cron.js';

const dir = () => mkdtempSync(join(tmpdir(), 'mochi-cron-life-'));

describe('cron lifecycle', () => {
  it('persists pause/resume and run-now', () => {
    const d = dir();
    const r = addJob(d, 'check the build', 'every 1h');
    expect(r.id).toBeTruthy();
    expect(setJobPaused(d, r.id!, true)).toBe(true);
    expect(dueJobs(d)).toHaveLength(0);
    expect(getJob(d, r.id!)?.paused).toBe(true);
    setJobPaused(d, r.id!, false);
    expect(getJob(d, r.id!)?.paused).toBe(false);
    runJobNow(d, r.id!);
    expect(dueJobs(d).map((j) => j.id)).toContain(r.id);
  });

  it('records success output, duration, and advances nextRun', async () => {
    const d = dir();
    const r = addJob(d, 'say hi', 'every 1m');
    runJobNow(d, r.id!);
    const out = await runDueCronJobs(d, async () => 'hello from the job');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: r.id, ok: true, status: 'ok', output: 'hello from the job' });
    const job = listJobs(d)[0];
    expect(job.runs).toBe(1);
    expect(job.lastStatus).toBe('ok');
    expect(job.lastOutput).toBe('hello from the job');
    expect(job.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(job.nextRun).toBeGreaterThan(Date.now() - 1000);
    expect(dueJobs(d)).toHaveLength(0);
  });

  it('records failures without wedging the scheduler', async () => {
    const d = dir();
    const r = addJob(d, 'explode', 'every 1m');
    runJobNow(d, r.id!);
    const out = await runDueCronJobs(d, async () => { throw new Error('tool exploded'); });
    expect(out[0]).toMatchObject({ ok: false, status: 'error', error: 'tool exploded' });
    const job = getJob(d, r.id!)!;
    expect(job.lastStatus).toBe('error');
    expect(job.lastError).toContain('tool exploded');
    expect(job.runs).toBe(1);
  });

  it('removeJob deletes by id', () => {
    const d = dir();
    const r = addJob(d, 'x', 'every 5m');
    removeJob(d, r.id!);
    expect(listJobs(d)).toHaveLength(0);
  });
});
