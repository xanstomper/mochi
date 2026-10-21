import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleTool } from './schedule.js';
import type { ToolContext } from './types.js';
import { listJobs, getJob } from '../daemon/cron.js';

const ctx = (dir: string) => ({ cwd: dir } as ToolContext);

describe('schedule tool', () => {
  it('adds, lists, pauses, resumes, queues, and removes a job', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mochi-schedule-'));
    const add = await scheduleTool.execute({ action: 'add', prompt: 'check the build', schedule: 'every 1h' }, ctx(d));
    expect(add).toContain('[schedule add] ok');
    const id = listJobs(d)[0].id;

    const list = await scheduleTool.execute({ action: 'list' }, ctx(d));
    expect(list).toContain(id);
    expect(list).toContain('check the build');
    expect(list).toContain('active');

    expect(await scheduleTool.execute({ action: 'pause', id }, ctx(d))).toContain('paused');
    expect(getJob(d, id)?.paused).toBe(true);
    expect(await scheduleTool.execute({ action: 'resume', id }, ctx(d))).toContain('active');
    expect(await scheduleTool.execute({ action: 'run', id }, ctx(d))).toContain('queued');
    expect(await scheduleTool.execute({ action: 'status', id }, ctx(d))).toContain('runs 0');
    expect(await scheduleTool.execute({ action: 'remove', id }, ctx(d))).toContain('deleted');
    expect(listJobs(d)).toHaveLength(0);
  });

  it('rejects bad schedules and missing ids cleanly', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mochi-schedule-'));
    const bad = await scheduleTool.execute({ action: 'add', prompt: 'x', schedule: 'whenever' }, ctx(d));
    expect(bad).toContain('unparseable schedule');
    expect(await scheduleTool.execute({ action: 'remove' }, ctx(d))).toContain('id is required');
    expect(await scheduleTool.execute({ action: 'status', id: 'nope' }, ctx(d))).toContain('no job matching');
  });

  it('creates paused jobs without arming them', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mochi-schedule-'));
    await scheduleTool.execute({ action: 'add', prompt: 'x', schedule: 'every 10m', paused: true }, ctx(d));
    expect(listJobs(d)[0].paused).toBe(true);
  });
});
