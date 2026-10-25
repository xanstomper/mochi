// Persistent browser session broker.
//
// The `browser` tool speaks to ONE long-lived node process per workspace that
// owns a single Playwright browser. That is the difference between "open a
// page, read it, close everything" and real browser automation: navigate once,
// then click/type/snapshot against the same live page, with cookies, tabs,
// console logs, network history and downloads preserved across tool calls.
//
// The daemon is plain JavaScript (scripts/browser-daemon.mjs) so the compiled
// agent binary never has to bundle playwright. It speaks newline-delimited
// JSON over stdio. This module owns the process lifecycle, request/response
// correlation, timeouts, crash recovery, and idle shutdown.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runArgv } from '../exec.js';

export interface BrowserResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface BrowserSessionOptions {
  workspaceDir: string;
  /** Persist cookies/localStorage here so logins survive across processes. */
  statePath?: string;
  /** Where downloads are saved. */
  downloadDir?: string;
  /** Persistent Chromium profile dir (keeps site logins across runs). */
  profileDir?: string;
  /** Optional real browser binary (Brave/Chrome) for the profile. */
  executablePath?: string;
  headless?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
  viewport?: { width: number; height: number };
  /** Kill the browser after this long with no calls (default: 15 min). */
  idleMs?: number;
}

interface Pending {
  resolve: (value: BrowserResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Broker {
  child: ChildProcess;
  nextId: number;
  pending: Map<number, Pending>;
  stderr: string;
  closed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleMs: number;
  workspaceDir: string;
}

const SESSIONS = new Map<string, Broker>();
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

// Module dir resolved lazily: bun-compiled Windows binaries report a non-file
// import.meta.url, and fileURLToPath throws at import time (the old browser
// tool learned this the hard way — every command died before any tool ran).
let cachedHere: string | undefined;
function hereDir(): string {
  if (cachedHere === undefined) {
    try { cachedHere = resolve(dirname(fileURLToPath(import.meta.url))); }
    catch { cachedHere = process.cwd(); }
  }
  return cachedHere;
}

/** Locate the daemon script across source, dist, global-install, and packaged
 *  layouts. `MOCHI_BROWSER_DAEMON` wins (tests use it to inject a fake). */
export function daemonScript(): string {
  const env = process.env.MOCHI_BROWSER_DAEMON;
  if (env) return resolve(env);
  const here = hereDir();
  const candidates = [
    resolve(here, '../../scripts/browser-daemon.mjs'),   // src/browser or dist/browser
    resolve(here, '../scripts/browser-daemon.mjs'),
    resolve(here, 'scripts/browser-daemon.mjs'),
    resolve(process.cwd(), 'scripts/browser-daemon.mjs'),
    resolve(homedir(), 'mochi/scripts/browser-daemon.mjs'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

/** The Node binary used to run the daemon. Under the Bun-compiled binary
 *  `process.execPath` is bun; playwright is a node package, so prefer real
 *  node when we can detect it. `MOCHI_BROWSER_NODE` overrides. */
export function daemonNode(): string {
  const env = process.env.MOCHI_BROWSER_NODE;
  if (env) return env;
  const bun = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
  return bun ? 'node' : process.execPath;
}

function keyFor(opts: BrowserSessionOptions): string {
  // Engine/profile are part of the identity: a Firefox session must never be
  // reused for Google Docs, and a changed profile means a different login.
  return [
    resolve(opts.workspaceDir),
    opts.headless === false ? 'headed' : 'headless',
    opts.browser ?? 'chromium',
    resolve(opts.profileDir ?? ''),
  ].join('::');
}

function rejectAll(broker: Broker, reason: string): void {
  for (const [, p] of broker.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  broker.pending.clear();
}

function shutdown(key: string, opts: { graceful?: boolean } = {}): void {
  const broker = SESSIONS.get(key);
  if (!broker) return;
  SESSIONS.delete(key);
  broker.closed = true;
  if (broker.idleTimer) clearTimeout(broker.idleTimer);
  rejectAll(broker, 'browser session closed');
  try {
    if (opts.graceful) broker.child.stdin?.end();
    broker.child.kill('SIGTERM');
  } catch { /* already gone */ }
}

/** Close every live browser (called on agent shutdown / tests). */
export function closeBrowserSessions(): void {
  for (const key of [...SESSIONS.keys()]) shutdown(key, { graceful: true });
}

/** Close only the browser sessions owned by one workspace. */
export function closeBrowserSession(workspaceDir: string): void {
  const prefix = `${resolve(workspaceDir)}::`;
  for (const key of [...SESSIONS.keys()]) {
    if (key.startsWith(prefix)) shutdown(key, { graceful: true });
  }
}

function ensureBroker(opts: BrowserSessionOptions): Broker {
  const key = keyFor(opts);
  const existing = SESSIONS.get(key);
  if (existing && !existing.closed) return existing;
  if (existing) SESSIONS.delete(key);

  const script = daemonScript();
  const child = spawn(daemonNode(), [script], {
    cwd: opts.workspaceDir,
    env: {
      ...process.env,
      MOCHI_BROWSER_WORKSPACE: opts.workspaceDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const broker: Broker = {
    child,
    nextId: 1,
    pending: new Map(),
    stderr: '',
    closed: false,
    idleMs: opts.idleMs ?? DEFAULT_IDLE_MS,
    workspaceDir: opts.workspaceDir,
  };

  // Line-delimited JSON responses.
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: BrowserResponse & { id?: number };
      try { parsed = JSON.parse(line) as BrowserResponse & { id?: number }; }
      catch { continue; }
      const id = typeof parsed.id === 'number' ? parsed.id : undefined;
      if (id === undefined) continue;
      const pending = broker.pending.get(id);
      if (!pending) continue;
      broker.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(parsed);
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    broker.stderr = (broker.stderr + chunk).slice(-8000);
  });
  child.on('error', (err) => {
    broker.closed = true;
    SESSIONS.delete(key);
    rejectAll(broker, `browser daemon failed to start: ${err.message} (is node installed?)`);
  });
  child.on('exit', (code) => {
    broker.closed = true;
    SESSIONS.delete(key);
    const tail = broker.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400);
    rejectAll(broker, `browser daemon exited (${code ?? 'signal'})${tail ? `: ${tail}` : ''}`);
  });

  SESSIONS.set(key, broker);
  return broker;
}

function touch(broker: Broker): void {
  if (broker.idleTimer) clearTimeout(broker.idleTimer);
  broker.idleTimer = setTimeout(() => {
    const entry = [...SESSIONS.entries()].find(([, b]) => b === broker);
    if (entry) shutdown(entry[0], { graceful: true });
  }, broker.idleMs);
  broker.idleTimer.unref?.();
}

/** Send one command to the workspace's browser daemon and await its result.
 *  Never throws for normal browser errors (they come back as `ok:false`);
 *  transport failures reject so callers can decide to fall back/retry. */
export async function browserCall(
  opts: BrowserSessionOptions,
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<BrowserResponse> {
  const broker = ensureBroker(opts);
  if (broker.closed) throw new Error('browser daemon is not running');
  touch(broker);
  const id = broker.nextId++;
  const request = JSON.stringify({ id, cmd: command, args }) + '\n';
  return await new Promise<BrowserResponse>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      broker.pending.delete(id);
      // A command that never returns means the browser is wedged; drop the
      // whole session so the next call starts clean instead of queueing
      // behind a dead page forever.
      const entry = [...SESSIONS.entries()].find(([, b]) => b === broker);
      if (entry) shutdown(entry[0]);
      rejectPromise(new Error(`browser ${command} timed out after ${timeoutMs}ms (session reset)`));
    }, Math.max(1000, timeoutMs));
    timer.unref?.();
    broker.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    broker.child.stdin?.write(request, (err) => {
      if (!err) return;
      broker.pending.delete(id);
      clearTimeout(timer);
      rejectPromise(new Error(`browser daemon stdin closed: ${err.message}`));
    });
  });
}

/** Initialize persistence paths on an existing/new daemon. */
export async function initBrowserSession(opts: BrowserSessionOptions): Promise<BrowserResponse> {
  return await browserCall(opts, 'init', {
    headless: opts.headless !== false,
    browser: opts.browser ?? 'chromium',
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    statePath: opts.statePath,
    downloadDir: opts.downloadDir,
    profileDir: opts.profileDir,
    executablePath: opts.executablePath,
    idleMs: opts.idleMs ?? DEFAULT_IDLE_MS,
  }, 60_000);
}

/** Probe playwright availability without launching a browser. */
export async function browserProbe(timeoutMs = 15_000): Promise<BrowserResponse> {
  try {
    const res = await runArgv(daemonNode(), [daemonScript(), '--once', JSON.stringify({ id: 1, cmd: 'probe' })], {
      timeoutMs,
      killGraceMs: 2000,
      maxOutput: 64 * 1024,
    });
    const last = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    const parsed = JSON.parse(last) as BrowserResponse;
    return { ...parsed, ok: parsed.ok !== false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
