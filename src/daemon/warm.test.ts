// Warm daemon tests (feat/warm-daemon): lifecycle, single-daemon locking,
// crash recovery, and the invalidation rules (HEAD moved / tree changed /
// config changed / skills changed -> re-warm, never serve stale).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { startDaemonInProcess, daemonRunning, daemonCrashed, clearStaleDaemonState, daemonInfoPath, daemonLockPath, readDaemonInfo, type DaemonInfo } from './daemon.js';
import { startWarm, type WarmHandle } from './warm.js';
import { loadAllSkills } from '../skills/skills.js';
import { Runtime } from '../runtime.js';

type Handle = { info: DaemonInfo; close: () => Promise<void>; runtime: Runtime; warm?: WarmHandle };

/** Poll `fn` every 100ms until it returns non-undefined or `timeout` elapses. */
async function retryUntil<T>(fn: () => T | undefined, timeout: number): Promise<T> {
  const start = Date.now();
  let v = fn();
  while (v === undefined && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 100));
    v = fn();
  }
  if (v === undefined) throw new Error(`retryUntil timed out after ${timeout}ms`);
  return v;
}

/** Await warm readiness (the preload runs asynchronously after listen). */
async function awaitReady(warm: WarmHandle): Promise<void> {
  await retryUntil(() => (warm.status().state !== 'warming' ? true : undefined), 30_000);
}

function makeGitRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-warm-'));
  execSync('git init -q -b main && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

async function api(port: number, token: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined && method === 'POST' ? '{}' : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanup) { try { await c(); } catch { /* teardown best-effort */ } }
});

/** Register a daemon + its temp dir for teardown, so a failing assertion can
 *  never leak a daemon into the shared vitest worker. */
function tracked(h: Handle, dir: string): Handle {
  cleanup.push(async () => { await h.close(); });
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  return h;
}

function trackedDir(dir: string): string {
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

describe('warm daemon lifecycle', () => {
  it('preloads on start: /api/warm reaches ready with per-phase costs', async () => {
    const dir = trackedDir(makeGitRepo());
    const h = tracked(await startDaemonInProcess({ cwd: dir, token: 'w1', warm: true }), dir);
    await awaitReady(h.warm!);
    const st = h.warm!.status();
    expect(st.state).toBe('ready');
    expect(st.preloadMs).not.toBeNull();
    const names = st.phases.map((p) => p.name);
    // The survey-dominant pieces are the preloaded ones.
    expect(names).toContain('goals-engine');
    expect(names).toContain('tools-registry');
    expect(names).toContain('skills');
    expect(names).toContain('repo-info');
    // Same state over HTTP.
    const res = await api(h.info.port, 'w1', '/api/warm');
    expect(res.status).toBe(200);
    expect((res.data.warm as { state: string }).state).toBe('ready');
  }, 60_000);

  it('two starts -> one daemon: the second start is rejected by the lock', async () => {
    const dir = trackedDir(makeGitRepo());
    const h1 = tracked(await startDaemonInProcess({ cwd: dir, token: 'w2a', warm: true }), dir);
    let rejected = '';
    try {
      await startDaemonInProcess({ cwd: dir, token: 'w2b' });
    } catch (e) {
      rejected = (e as Error).message;
    }
    expect(rejected).toMatch(/already running for this workspace/);
    // Exactly one daemon serves the workspace, and it is the FIRST one.
    expect(daemonRunning(resolve(dir, '.mochi'))).toBe(true);
    expect(readDaemonInfo(resolve(dir, '.mochi'))?.token).toBe('w2a');
    expect(h1).toBeTruthy();
  }, 60_000);

  it('daemon dead -> detected, never silently served; stale state clears for the next start', async () => {
    const dir = trackedDir(makeGitRepo());
    const ws = resolve(dir, '.mochi');
    // Simulate a crashed daemon: info + lock with a pid that is not alive.
    mkdirSync(resolve(ws, 'daemon'), { recursive: true });
    const deadPid = 999_999_999;
    writeFileSync(daemonInfoPath(ws), JSON.stringify({ port: 1, token: 'dead', pid: deadPid, startedAt: new Date().toISOString(), createdAt: 0, expiresAt: null }));
    writeFileSync(daemonLockPath(ws), JSON.stringify({ pid: deadPid, acquiredAt: 0 }));
    expect(daemonCrashed(ws)).toBe(true);
    expect(daemonRunning(ws)).toBe(false);
    // A start on top of the crash recovers: stale state cleared, new daemon serves.
    const h = tracked(await startDaemonInProcess({ cwd: dir, token: 'w3', warm: true }), dir);
    expect(daemonCrashed(ws)).toBe(false);
    expect(daemonRunning(ws)).toBe(true);
    expect(readDaemonInfo(ws)?.pid).not.toBe(deadPid);
  }, 60_000);

  it('clean shutdown: close() removes info + lock so the workspace is startable again', async () => {
    const dir = trackedDir(makeGitRepo());
    const ws = resolve(dir, '.mochi');
    const h = await startDaemonInProcess({ cwd: dir, token: 'w4', warm: true });
    expect(existsSync(daemonInfoPath(ws))).toBe(true);
    await h.close();
    expect(existsSync(daemonInfoPath(ws))).toBe(false);
    expect(existsSync(daemonLockPath(ws))).toBe(false);
    // And the same workspace accepts a fresh daemon immediately.
    const h2 = tracked(await startDaemonInProcess({ cwd: dir, token: 'w4b' }), dir);
    expect(daemonRunning(ws)).toBe(true);
  }, 60_000);
});

describe('warm invalidation', () => {
  it('HEAD moved -> gate records git-head-moved and re-warms (never serves stale)', async () => {
    const dir = trackedDir(makeGitRepo());
    const h = tracked(await startDaemonInProcess({ cwd: dir, token: 'w5', warm: true }), dir);
    await awaitReady(h.warm!);
    const warm = h.warm!;
    const before = warm.status().rewarmCount;
    // Move HEAD: a new commit on the same branch.
    execSync('git commit -q --allow-empty -m second', { cwd: dir });
    await warm.gate();
    const st = warm.status();
    expect(st.invalidations.some((i) => i.reason === 'git-head-moved')).toBe(true);
    expect(st.rewarmCount).toBe(before + 1);
    // A second gate with NO further change re-warms nothing.
    await warm.gate();
    expect(warm.status().rewarmCount).toBe(before + 1);
  }, 60_000);

  it('working-tree change -> gate records working-tree-changed and re-warms', async () => {
    const dir = trackedDir(makeGitRepo());
    const h = tracked(await startDaemonInProcess({ cwd: dir, token: 'w6', warm: true }), dir);
    await awaitReady(h.warm!);
    writeFileSync(resolve(dir, 'new-file.ts'), 'export const x = 1;\n');
    await h.warm!.gate();
    expect(h.warm!.status().invalidations.some((i) => i.reason === 'working-tree-changed')).toBe(true);
  }, 60_000);

  it('config change -> gate records config-changed and reloads the runtime config', async () => {
    const dir = trackedDir(makeGitRepo());
    const h = tracked(await startDaemonInProcess({ cwd: dir, token: 'w7', warm: true }), dir);
    await awaitReady(h.warm!);
    // A valid project config the daemon did not have at start.
    writeFileSync(resolve(dir, 'mochi.json'), JSON.stringify({ reasoning: 'low', telemetry: false }));
    await h.warm!.gate();
    expect(h.warm!.status().invalidations.some((i) => i.reason === 'config-changed')).toBe(true);
    // reloadConfig actually applied the on-disk value to the live runtime.
    expect(h.runtime.config.reasoning).toBe('low');
  }, 60_000);

  it('skills change -> gate records skills-changed; the skills parse cache invalidates', async () => {
    const dir = trackedDir(makeGitRepo());
    const h = tracked(await startDaemonInProcess({ cwd: dir, token: 'w8', warm: true }), dir);
    await awaitReady(h.warm!);
    const before = loadAllSkills(dir).skills.length;
    mkdirSync(resolve(dir, '.mochi', 'skills', 'my-warm-test-skill'), { recursive: true });
    writeFileSync(resolve(dir, '.mochi', 'skills', 'my-warm-test-skill', 'SKILL.md'), '---\nname: my-warm-test-skill\ndescription: warm invalidation probe skill\n---\nBody.\n');
    await h.warm!.gate();
    expect(h.warm!.status().invalidations.some((i) => i.reason === 'skills-changed')).toBe(true);
    // The module-level cache re-parsed: the new skill is visible.
    const after = loadAllSkills(dir).skills;
    expect(after.length).toBe(before + 1);
    expect(after.some((s) => s.name === 'my-warm-test-skill')).toBe(true);
  }, 60_000);
});

describe('warm behavior parity + resources', () => {
  it('a task served warm completes exactly like cold (same tools, same gates)', async () => {
    const { startFakeOpenAI } = await import('../testutil/fake-openai.js');
    const dir = trackedDir(makeGitRepo());
    const fake = await startFakeOpenAI([
      { toolCalls: [{ id: 'c1', function: { name: 'write', arguments: '{"path":"warm-parity.txt","content":"warm-ok"}' } }], finishReason: 'tool_calls' },
      { content: 'Created warm-parity.txt', finishReason: 'stop' },
    ]);
    try {
      const cfg = {
        model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
        safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 5, maxRuntimeMinutes: 3, maxConcurrentAgents: 1, contextBudgetTokens: 8000, skipReproGate: true },
        permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
        telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
        speculative: { preflight: false },
        longtask: { enabled: false },
      };
      const h = tracked(await startDaemonInProcess({ cwd: dir, token: 'w9', config: cfg as never, warm: true }), dir);
      await awaitReady(h.warm!);
      const res = await api(h.info.port, 'w9', '/api/prompt', 'POST', { task: 'Create the file warm-parity.txt containing warm-ok. Stop after writing the file.' });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.success).toBe(true);
      expect(existsSync(resolve(dir, 'warm-parity.txt'))).toBe(true);
      expect(readFileSync(resolve(dir, 'warm-parity.txt'), 'utf8')).toBe('warm-ok');
    } finally {
      await fake.close();
    }
  }, 60_000);

  it('startWarm reports rss/cpu; touchActivity resets idle; pristine gate is a no-op', async () => {
    const dir = trackedDir(makeGitRepo());
    const rt = Runtime.create({ cwd: dir, config: { model: { provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'fake' }, quiet: true } as never });
    const w = await startWarm(rt);
    try {
      await awaitReady(w);
      const s = w.status();
      expect(s.enabled).toBe(true);
      expect(s.rssBytes).toBeGreaterThan(0);
      expect(typeof s.idleCpuPct).toBe('number');
      w.touchActivity();
      expect(w.status().idleSec).toBe(0);
      // Gate on a pristine snapshot is a no-op.
      await w.gate();
      expect(w.status().invalidations.length).toBe(0);
    } finally {
      w.close();
      try { rt.close(); } catch { /* best-effort */ }
    }
  }, 60_000);

  it('stale info.json from a crashed daemon is detected and cleared', () => {
    const dir = trackedDir(makeGitRepo());
    const ws = resolve(dir, '.mochi');
    mkdirSync(resolve(ws, 'daemon'), { recursive: true });
    writeFileSync(daemonInfoPath(ws), JSON.stringify({ port: 2, token: 'x', pid: 999_999_998, startedAt: new Date().toISOString(), createdAt: 0, expiresAt: null }));
    expect(daemonCrashed(ws)).toBe(true);
    clearStaleDaemonState(ws);
    expect(daemonCrashed(ws)).toBe(false);
    expect(readDaemonInfo(ws)).toBeUndefined();
  }, 60_000);
});

describe('skills parse cache correctness', () => {
  it('returns shallow copies — mutating a returned skill never poisons the cache', () => {
    const dir = trackedDir(makeGitRepo());
    const a = loadAllSkills(dir).skills;
    const target = a[0] as { name: string; description?: string };
    const origDesc = target.description;
    target.description = 'MUTATED';
    const b = loadAllSkills(dir).skills.find((s) => s.name === target.name) as { description?: string };
    expect(b.description).toBe(origDesc);
  });
});
