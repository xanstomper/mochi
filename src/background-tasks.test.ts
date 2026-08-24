// Background tasks: async shell execution with result delivery.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startBackgroundTask, getTask, listTasks, describeTask } from './background-tasks.js';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('background tasks', () => {
  it('starts a task and captures completion + output', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('echo hello-from-bg', dir);
    expect(t.status).toBe('running');
    for (let i = 0; i < 50 && t.status === 'running'; i++) await sleep(100);
    expect(t.status).toBe('completed');
    expect(t.output).toContain('hello-from-bg');
    expect(describeTask(t)).toContain('[bg:');
    expect(describeTask(t)).toContain('completed');
  }, 15_000);

  it('captures non-zero exit as failed', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('exit 3', dir);
    for (let i = 0; i < 50 && t.status === 'running'; i++) await sleep(100);
    expect(t.status).toBe('failed');
    expect(t.exitCode).toBe(3);
  }, 15_000);

  it('listTasks includes started tasks; getTask round-trips', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('true', dir);
    expect(getTask(t.id)?.id).toBe(t.id);
    expect(listTasks().some((x) => x.id === t.id)).toBe(true);
    for (let i = 0; i < 50 && t.status === 'running'; i++) await sleep(100);
  }, 15_000);

  it('truncates describeTask output', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('seq 1 100000', dir, { description: 'big output' });
    for (let i = 0; i < 100 && t.status === 'running'; i++) await sleep(100);
    const d = describeTask(t, 500);
    expect(d.length).toBeLessThan(1000);
  }, 30_000);

  it('kills a long-running background task with killTask', async () => {
    const { killTask } = await import('./background-tasks.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('sleep 60', dir, { description: 'long sleeper' });
    expect(t.status).toBe('running');
    const killed = killTask(t.id);
    expect(killed).toBe(true);
    expect(t.status).toBe('failed');
    expect(t.output).toContain('task killed');
  });

  it('manages tasks via bgTaskTool', async () => {
    const { bgTaskTool } = await import('./tools/bg-task.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('sleep 30', dir, { description: 'test tool sleep' });

    const listRes = await bgTaskTool.execute({ action: 'list' }, {} as never);
    expect(listRes).toContain(t.id);

    const statusRes = await bgTaskTool.execute({ action: 'status', task_id: t.id }, {} as never);
    expect(statusRes).toContain(t.id);

    const killRes = await bgTaskTool.execute({ action: 'kill', task_id: t.id }, {} as never);
    expect(killRes).toContain('terminated successfully');
  });
});
