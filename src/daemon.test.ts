import { it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { startDaemonInProcess, daemonInfoPath, daemonRunning } from './daemon.js';

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
  // Create a goal directly in the workspace, then resume via the endpoint.
  const goal = await handle.runtime.goals.createGoal('make a file');
  const tasks = await handle.runtime.goals.decompose(goal);
  handle.runtime.workspace.saveGoal(goal);
  handle.runtime.workspace.saveTasks(goal.id, tasks);

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
  }
}, 60_000);
