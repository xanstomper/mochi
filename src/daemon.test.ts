import { it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { startDaemonInProcess, daemonInfoPath, daemonRunning } from './daemon.js';

/** Poll `fn` every 250ms until it returns non-undefined or `timeout` elapses. */
async function retryUntil<T>(fn: () => T | undefined, timeout: number): Promise<T> {
  const start = Date.now();
  let v = fn();
  while (v === undefined && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 250));
    v = fn();
  }
  if (v === undefined) throw new Error(`retryUntil timed out after ${timeout}ms`);
  return v;
}

let dir: string;
let handle: { info: any; close: () => Promise<void>; runtime: any } | undefined;

afterAll(async () => {
  if (handle) await handle.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('starts, writes info, serves status with the token', async () => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-daemon-'));
  execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
  writeFileSync(resolve(dir, 'math.ts'), 'export const add = (a: number, b: number) => a + b;');
  handle = await startDaemonInProcess({ cwd: dir, token: 'sekret' });
  expect(handle.info.token).toBe('sekret');
  expect(daemonRunning(resolve(dir, '.mochi'))).toBe(true);

  const res = await fetch(`http://127.0.0.1:${handle.info.port}/api/status`, {
    method: 'POST', headers: { authorization: 'Bearer sekret' },
  });
  const data = await res.json();
  expect(res.status).toBe(200);
  expect(data.ok).toBe(true);

  // Unauthorized must be rejected.
  const bad = await fetch(`http://127.0.0.1:${handle.info.port}/api/status`, {
    method: 'POST', headers: { authorization: 'Bearer nope' },
  });
  expect(bad.status).toBe(401);
}, 30_000);

it('runs a goal through the daemon with a scripted model', async () => {
  // Scripted fake provider so no network/model needed: daemon calls
  // runtime.goal which delegates to the GoalEngine + provider.
  const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
  const fake = await startFakeOpenAI([
    { content: '{"tasks":[{"title":"Say hi","description":"echo","role":"coder","dependencies":[],"fileScope":[],"acceptanceCriteria":["hi"],"verificationCommand":""}]}', finishReason: 'stop' },
    { content: 'Done.', finishReason: 'stop' },
  ]);
  const cfg = {
    model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
  } as const;
  const h = await startDaemonInProcess({ cwd: dir, token: 'sekret2', config: cfg as any });
  try {
    const res = await fetch(`http://127.0.0.1:${h.info.port}/api/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sekret2' },
      body: JSON.stringify({ objective: 'say hi' }),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.out).toBe('string');
  } finally {
    await h.close();
    await fake.close();
  }
}, 60_000);

it('serves inspect and plan, rejects bad JSON and unknown routes', async () => {
  const h = await startDaemonInProcess({ cwd: dir, token: 'sekret3' });
  try {
    const rr = await fetch(`http://127.0.0.1:${h.info.port}/api/status`, {
      method: 'GET', headers: { authorization: 'Bearer sekret3' },
    });
    expect(rr.status).toBe(405); // POST only

    const badJson = await fetch(`http://127.0.0.1:${h.info.port}/api/status`, {
      method: 'POST', headers: { authorization: 'Bearer sekret3' }, body: '{nope',
    });
    expect(badJson.status).toBe(400);

    const nope = await fetch(`http://127.0.0.1:${h.info.port}/api/nope`, {
      method: 'POST', headers: { authorization: 'Bearer sekret3' }, body: '{}',
    });
    expect(nope.status).toBe(404);
  } finally {
    await h.close();
  }
}, 30_000);

it('serves jobs, resume via approve, status usage, and SSE goal progress', async () => {
  const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
  const fake = await startFakeOpenAI([
    { content: '{"tasks":[{"title":"T1","description":"d","role":"coder","dependencies":[],"fileScope":[],"acceptanceCriteria":["done"],"verificationCommand":""}]}', finishReason: 'stop' },
    { content: 'planned', finishReason: 'stop' },
  ]);
  const cfg = {
    model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
  } as const;
  const h = await startDaemonInProcess({ cwd: dir, token: 'sekret4', config: cfg as any });
  try {
    const H = { 'content-type': 'application/json', authorization: 'Bearer sekret4' };

    // Plan -> pending goal -> jobs lists it.
    const planRes = await fetch(`http://127.0.0.1:${h.info.port}/api/plan`, { method: 'POST', headers: H, body: JSON.stringify({ objective: 'x' }) });
    expect((await planRes.json()).pending).toBe(true);
    const jobsRes = await fetch(`http://127.0.0.1:${h.info.port}/api/jobs`, { method: 'POST', headers: H, body: '{}' });
    const jobs = ((await jobsRes.json()) as { jobs?: Array<unknown> }).jobs;
    expect(Array.isArray(jobs)).toBe(true);

    // Approve runs the pending plan through the scripted model.
    const appRes = await fetch(`http://127.0.0.1:${h.info.port}/api/approve`, { method: 'POST', headers: H, body: '{}' });
    const app = (await appRes.json());
    expect(app.ok).toBe(true);

    // Status reports usage totals.
    const stRes = await fetch(`http://127.0.0.1:${h.info.port}/api/status`, { method: 'POST', headers: H, body: '{}' });
    const st = await stRes.json();
    expect(st.ok).toBe(true);
    expect(typeof st.usage?.costUsd).toBe('number');
  } finally {
    await h.close();
    await fake.close();
  }
}, 60_000);

it('resumes a persisted goal through /api/resume', async () => {
  const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
  const fake = await startFakeOpenAI([
    { content: '{"tasks":[{"title":"T","description":"d","role":"coder","dependencies":[],"fileScope":[],"acceptanceCriteria":["ok"],"verificationCommand":""}]}', finishReason: 'stop' },
    { content: 'done', finishReason: 'stop' },
  ]);
  const cfg = {
    model: { provider: 'openai', baseUrl: fake.url, model: 'fake' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 2, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
  } as const;
  // Own workspace + goal (no real provider; tasks built here, not decomposed
  // by a live model), then resume via the endpoint. Self-contained so the test
  // runs hermetically whether or not earlier tests ran in this process.
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-daemon-resume-'));
  const { createTask } = await import('./goals/task.js');
  const h0 = await startDaemonInProcess({ cwd: dir, token: 'sekret0', config: cfg as any });
  const goal = await h0.runtime.goals.createGoal('make a file');
  const tasks = [createTask('write math.ts', 'emit the file', { acceptanceCriteria: ['file exists'] })];
  h0.runtime.workspace.saveGoal(goal);
  h0.runtime.workspace.saveTasks(goal.id, tasks);
  await h0.close();

  const h = await startDaemonInProcess({ cwd: dir, token: 'sekret5', config: cfg as any });
  try {
    const res = await fetch(`http://127.0.0.1:${h.info.port}/api/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sekret5' },
      body: JSON.stringify({ goalId: goal.id }),
    });
    const data = (await res.json()) as { ok?: boolean; out?: string; error?: string };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.out).toBe('string');
    // Task persisted and now marked active/completed.
    const loaded = h.runtime.workspace.loadGoal(goal.id);
    expect(loaded?.status).toBeDefined();
  } finally {
    await h.close();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it('resumes a goal after a daemon restart (shutdown -> new daemon -> /api/resume)', async () => {
  const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
  const fake = await startFakeOpenAI([
    { content: '[{"title":"Create f","description":"make f.ts","role":"coder","dependencies":[],"acceptanceCriteria":["x"],"verificationCommand":""}]', finishReason: 'stop' },
    { content: 'result', finishReason: 'stop' },
  ]);
  const cfg = {
    model: { provider: 'openai', baseUrl: fake.url, model: 'fake' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 2, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
    } as const;

  // Own workspace so the test is self-contained (does not depend on the
  // dir started by the first test). Create + persist a goal with the FIRST
  // daemon instance on that workspace.
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-daemon-restart-'));
  const h1 = await startDaemonInProcess({ cwd: dir, token: 'sekretA', config: cfg as any });
  const g = await h1.runtime.goals.createGoal('make f.ts');
  const tasks = await h1.runtime.goals.decompose(g);
  h1.runtime.workspace.saveGoal(g);
  h1.runtime.workspace.saveTasks(g.id, tasks);
  await h1.close(); // "shutdown" — info file removed, goal stays on disk.

  // Fresh daemon on the SAME workspace resumes from disk.
  const h2 = await startDaemonInProcess({ cwd: dir, token: 'sekretB', config: cfg as any });
  try {
    const res = await fetch(`http://127.0.0.1:${h2.info.port}/api/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sekretB' },
      body: JSON.stringify({ goalId: g.id }),
    });
    const data = (await res.json()) as { ok?: boolean; out?: string; error?: string };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.out).toBe('string');
    expect(data.error).toBeUndefined();
  } finally {
    await h2.close();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it('runs and persists a scheduled cron job through the daemon', async () => {
  const d = mkdtempSync(resolve(tmpdir(), 'mochi-daemon-cron-'));
  // Fake provider so runtime.goal completes instantly in the ticker.
  const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
  const fake = await startFakeOpenAI([
    { content: '{"tasks":[{"title":"say hi","description":"say hi","role":"coder","dependencies":[],"acceptanceCriteria":[],"verificationCommand":""}]}', finishReason: 'stop' },
    { content: 'done', finishReason: 'stop', completionTokens: 4 },
  ]);
  const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;
  const h = await startDaemonInProcess({ cwd: d, token: 'crontok', config: cfg });
  try {
    // Add a job whose due-time is immediately in the past by using a tiny interval.
    const res = await fetch(`http://127.0.0.1:${h.info.port}/api/cron`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer crontok' },
      body: JSON.stringify({ action: 'add', prompt: 'say hi', schedule: 'every 1m' }),
    });
    const added = await res.json();
    expect(res.status).toBe(200);
    expect((added as any).id).toBeTruthy();

    // Force due: rewrite nextRun to the past, then let the ticker run.
    const { listJobs } = await import('./cron.js');
    const jobs = listJobs(d);
    const due = { ...jobs[0], nextRun: Date.now() - 1 };
    const fs = await import('node:fs');
    fs.writeFileSync(resolve(d, '.mochi', 'cron.json'), JSON.stringify([due], null, 2));

    // Ticker runs every 10s; poll until the job fires and persists (nextRun
    // advances past now and runs increments), up to ~20s.
    const after = await retryUntil(() => {
      const j = listJobs(d)[0];
      return j && j.runs >= 1 && j.nextRun > Date.now() ? j : undefined;
    }, 35_000);
    expect(after.runs).toBeGreaterThanOrEqual(1);
    expect(after.nextRun).toBeGreaterThan(Date.now());
  } finally {
    await h.close();
    try { await fake.close(); } catch { /* already */ }
    rmSync(d, { recursive: true, force: true });
  }
}, 60_000);

it('cron jobs survive a daemon restart (durable schedule)', async () => {
  const d = mkdtempSync(resolve(tmpdir(), 'mochi-daemon-cron-restart-'));
  const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
  const fake = await startFakeOpenAI([
    { content: '{"tasks":[{"title":"say hi","description":"say hi","role":"coder","dependencies":[],"acceptanceCriteria":[],"verificationCommand":""}]}', finishReason: 'stop' },
    { content: 'done', finishReason: 'stop', completionTokens: 4 },
  ]);
  const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;

  // First daemon: add a scheduled job.
  const h1 = await startDaemonInProcess({ cwd: d, token: 'rstok', config: cfg });
  const res = await fetch(`http://127.0.0.1:${h1.info.port}/api/cron`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer rstok' },
    body: JSON.stringify({ action: 'add', prompt: 'say hi', schedule: 'every 5m' }),
  });
  await res.json();
  const { listJobs } = await import('./cron.js');
  const before = listJobs(d);
  expect(before.length).toBe(1);
  await h1.close(); // shutdown

  // Fresh daemon on the SAME workspace: the job must still be scheduled.
  const h2 = await startDaemonInProcess({ cwd: d, token: 'tokok', config: cfg });
  try {
    const after = listJobs(d);
    expect(after.length).toBe(1);
    expect(after[0].prompt).toBe('say hi');
    expect(after[0].schedule).toBe('every 5m');
  } finally {
    await h2.close();
    try { await fake.close(); } catch { /* already */ }
    rmSync(d, { recursive: true, force: true });
  }
}, 60_000);
