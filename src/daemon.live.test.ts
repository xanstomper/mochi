// Live integration test for the daemon: a real goal sent over HTTP runs
// through the real provider, the goal survives a daemon restart, and a
// fresh daemon instance resumes it from the persisted workspace state.
//
// Skipped automatically when FREEINFERENCE_API_KEY is missing. Run explicitly
// with:
//
//   FREEINFERENCE_API_KEY=... npx vitest run src/daemon.live.test.ts
//
// Slow by design (the goals deepseek-v4-flash run takes 30-90s).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { MochiConfig } from './types.js';

const HAS_KEY = Boolean(process.env.FREEINFERENCE_API_KEY);
const suite = HAS_KEY ? describe : describe.skip;

function makeConfig(): MochiConfig {
  return {
    model: {
      provider: 'openai',
      baseUrl: 'https://freeinference.org/v1',
      model: 'deepseek-v4-flash',
      apiKey: process.env.FREEINFERENCE_API_KEY,
    },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 30,
      maxIterations: 4,
      maxRuntimeMinutes: 3,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 8000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    quiet: true,
    verbose: false,
    debug: false,
  };
}

function api(port: number, token: string, path: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

suite('daemon live round-trip', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-daemon-live-'));
  const outFile = resolve(dir, 'dt.ts');

  it('sends a real goal, survives restart, resumes from disk', async () => {
    const { startDaemonInProcess } = await import('./daemon.js');

    // 1. First daemon instance writes+runs a goal with the real provider.
    const h1 = await startDaemonInProcess({ cwd: dir, token: 'sek', config: makeConfig() });
    let res = await api(h1.info.port, 'sek', '/api/goal', {
      objective: `Write ${outFile} exporting function dt() returning "daemon-ok". Do NOT run tests or build. Stop immediately after writing the file.`,
    });
    const first = (await res.json()) as { ok?: boolean; out?: string; error?: string };
    expect(res.status).toBe(200);
    expect(first.ok).toBe(true);
    // The real model should reach a terminal state (it may sometimes also
    // run extra verification, so 'completed' is not guaranteed).
    expect(first.out).toMatch(/completed|failed/);
    const goalId = h1.runtime.workspace.listGoals()[0]?.replace(/\.json$/, '') ?? '';
    expect(goalId).toBeTruthy();

    // 2 = simulated shutdown: close the daemon, workspace state stays.
    await h1.close();
    expect(existsSync(outFile)).toBe(true);
    const content = readFileSync(outFile, 'utf8');
    expect(content).toContain('daemon-ok');
    expect(existsSync(resolve(dir, '.mochi', 'state', `${goalId}.tasks.json`))).toBe(true);

    // 3 = fresh daemon on the SAME workspace resumes from persisted state.
    const h2 = await startDaemonInProcess({ cwd: dir, token: 'live', config: makeConfig() });
    try {
      res = await api(h2.info.port, 'live', '/api/resume', { goalId });
      const resumed = (await res.json()) as { ok?: boolean; out?: string; error?: string };
      expect(res.status).toBe(200);
      expect(resumed.ok).toBe(true);
      expect(resumed.out).toMatch(/completed|failed|resumed/);
    } finally {
      await h2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
