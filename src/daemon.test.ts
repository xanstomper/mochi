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
