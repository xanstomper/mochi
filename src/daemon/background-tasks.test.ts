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
  }, 60_000);

  it('captures non-zero exit as failed', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('exit 3', dir);
    for (let i = 0; i < 50 && t.status === 'running'; i++) await sleep(100);
    expect(t.status).toBe('failed');
    expect(t.exitCode).toBe(3);
  }, 60_000);

  it('listTasks includes started tasks; getTask round-trips', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('true', dir);
    expect(getTask(t.id)?.id).toBe(t.id);
    expect(listTasks().some((x) => x.id === t.id)).toBe(true);
    for (let i = 0; i < 50 && t.status === 'running'; i++) await sleep(100);
  }, 60_000);

  it('truncates describeTask output', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('seq 1 100000', dir, { description: 'big output' });
    for (let i = 0; i < 100 && t.status === 'running'; i++) await sleep(100);
    const d = describeTask(t, 500);
    expect(d.length).toBeLessThan(1000);
  }, 60_000);

  it('kills a long-running background task with killTask', async () => {
    const { killTask } = await import('./background-tasks.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('sleep 60', dir, { description: 'long sleeper' });
    expect(t.status).toBe('running');
    const killed = killTask(t.id);
    expect(killed).toBe(true);
    expect(t.status).toBe('failed');
    expect(t.output).toContain('task killed');
  }, 60_000);

  it('persists a ledger so a FRESH process can list/logs the task', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('echo ledger-roundtrip', dir);
    for (let i = 0; i < 50 && t.status === 'running'; i++) await sleep(100);
    const { listPersistedTasks, getPersistedTask } = await import('./background-tasks.js');
    const found = getPersistedTask(t.id, dir);
    expect(found?.status).toBe('completed');
    expect(found?.output).toContain('ledger-roundtrip');
    expect(listPersistedTasks(dir).some((x) => x.id === t.id)).toBe(true);
  }, 60_000);

  it('ledger: corrects stale running records (dead owner pid) and kill fails honestly', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    mkdirSync(resolve(dir, '.mochi'), { recursive: true });
    // A pid that just exited (spawnSync waits for it) — near-zero reuse risk.
    const deadPid = spawnSync('true').pid ?? 999999;
    writeFileSync(resolve(dir, '.mochi', 'bg-tasks.json'), JSON.stringify([
      { id: 'stale01', command: 'npm test', startedAt: Date.now(), status: 'running', output: '', pid: deadPid },
    ]));
    const { listPersistedTasks, killPersistedTask } = await import('./background-tasks.js');
    const list = listPersistedTasks(dir);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('failed');
    expect(list[0].output).toContain('owner process exited');
    // Already-dead task: kill reports failure (old in-process path returned
    // true-ish nothing; a CLI must not claim success for a corpse).
    expect(killPersistedTask('stale01', dir)).toBe(false);
    expect(killPersistedTask('no-such-task', dir)).toBe(false);
    // The correction was written back to the ledger.
    const raw = JSON.parse(readFileSync(resolve(dir, '.mochi', 'bg-tasks.json'), 'utf8'));
    expect(raw[0].status).toBe('failed');
  });

  it('manages tasks via bgTaskTool', async () => {
    const { bgTaskTool } = await import('../tools/bg-task.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('sleep 30', dir, { description: 'test tool sleep' });

    const listRes = await bgTaskTool.execute({ action: 'list' }, {} as never);
    expect(listRes).toContain(t.id);

    const statusRes = await bgTaskTool.execute({ action: 'status', task_id: t.id }, {} as never);
    expect(statusRes).toContain(t.id);

    const killRes = await bgTaskTool.execute({ action: 'kill', task_id: t.id }, {} as never);
    expect(killRes).toContain('terminated successfully');
  });

  it('MCH-218: steers a RUNNING interactive task via stdin', async () => {
    // `cat` echoes stdin back — the classic steerable process.
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('cat', dir, { description: 'echo server' });
    await sleep(300); // let cat start
    const { steerTask } = await import('./background-tasks.js');
    expect(steerTask(t.id, 'steered-line-42')).toBe(true);
    for (let i = 0; i < 30 && !t.output.includes('steered-line-42'); i++) await sleep(100);
    expect(t.output).toContain('steered-line-42');
    // Finished/unknown tasks refuse stdin.
    const { killTask } = await import('./background-tasks.js');
    killTask(t.id);
    expect(steerTask(t.id, 'late')).toBe(false);
    expect(steerTask('nope', 'x')).toBe(false);
  }, 60_000);

  it('MCH-218: bg_task stdin action writes to the task and errors cleanly', async () => {
    const { bgTaskTool } = await import('../tools/bg-task.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    // Line-buffered echo loop (tr/sed block-buffer on pipes and would never
    // flush a 12-byte line — this is why the cat variant passes and this one
    // needs an explicit read loop).
    const t = startBackgroundTask('while IFS= read -r l; do printf \'%s\\n\' "$l" | tr a-z A-Z; done', dir, { description: 'upper server' });
    await sleep(300);
    const ok = await bgTaskTool.execute({ action: 'stdin', task_id: t.id, text: 'make-me-loud' }, {} as never);
    expect(ok).toContain('Wrote to task');
    for (let i = 0; i < 30 && !t.output.includes('MAKE-ME-LOUD'); i++) await sleep(100);
    expect(t.output).toContain('MAKE-ME-LOUD');
    const bad = await bgTaskTool.execute({ action: 'stdin', task_id: 'ghost', text: 'x' }, {} as never);
    expect(bad).toContain('No background task found');
    const noText = await bgTaskTool.execute({ action: 'stdin', task_id: t.id }, {} as never);
    expect(noText).toContain('stdin requires');
  }, 60_000);

  it('MCH-218: cross-process steering via the stdin FIFO (external process appends)', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-'));
    const t = startBackgroundTask('while IFS= read -r l; do echo "GOT:$l"; done', dir, { description: 'fifo echo' });
    await sleep(300);
    expect(t.fifoPath).toBeTruthy();
    // A COMPLETELY EXTERNAL process (no handle, no registry entry) steers
    // the running task by appending to the FIFO — the relay feeds the child.
    execFileSync('sh', ['-c', `echo external-steer-99 >> "${t.fifoPath}"`]);
    for (let i = 0; i < 30 && !t.output.includes('GOT:external-steer-99'); i++) await sleep(100);
    expect(t.output).toContain('GOT:external-steer-99');
    // TWO writers, sequentially — proves the relay reopens after EOF.
    execFileSync('sh', ['-c', `echo second-writer >> "${t.fifoPath}"`]);
    for (let i = 0; i < 30 && !t.output.includes('GOT:second-writer'); i++) await sleep(100);
    expect(t.output).toContain('GOT:second-writer');
    // steerPersistedTask resolves from the ledger for an unknown-to-this-map id.
    const { steerPersistedTask } = await import('./background-tasks.js');
    expect(steerPersistedTask(t.id, dir, 'via-ledger')).toBe(true);
    for (let i = 0; i < 30 && !t.output.includes('GOT:via-ledger'); i++) await sleep(100);
    expect(t.output).toContain('GOT:via-ledger');
  }, 60_000);

  it('relay teardown leaves no orphaned cat/sh holding the FIFO (process-leak regression)', async () => {
    const { execSync } = await import('node:child_process');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-bg-leak-'));
    const t = startBackgroundTask('while IFS= read -r l; do echo "GOT:$l"; done', dir, { description: 'leak proof' });
    await sleep(300);
    expect(t.fifoPath).toBeTruthy();
    // Writer appears and closes → the relay's cat hits EOF and REOPENS; a
    // second writer proves a fresh cat is running (the exact process the old
    // direct-kill teardown orphaned).
    execSync(`sh -c 'echo one >> "${t.fifoPath}"'`);
    for (let i = 0; i < 30 && !t.output.includes('GOT:one'); i++) await sleep(100);
    execSync(`sh -c 'echo two >> "${t.fifoPath}"'`);
    for (let i = 0; i < 30 && !t.output.includes('GOT:two'); i++) await sleep(100);
    expect(t.output).toContain('GOT:two');
    // Count live relay processes pinned to THIS task's fifo path (walk /proc:
    // pgrep -fc would match the probe's own sh -c cmdline), then kill the
    // task, then require the count to drop to zero.
    const { readdirSync, readFileSync } = await import('node:fs');
    const needle = t.fifoPath!;
    const probe = (): number => {
      let n = 0;
      for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
        if (pid === String(process.pid)) continue;
        try {
          const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (cmd.includes(needle) && !cmd.includes('pgrep')) n++;
        } catch { /* process exited */ }
      }
      return n;
    };
    const relaysBefore = probe();
    expect(relaysBefore).toBeGreaterThan(0);
    const { killTask } = await import('./background-tasks.js');
    expect(killTask(t.id)).toBe(true);
    await sleep(500);
    expect(probe()).toBe(0);
  }, 60_000);
});
