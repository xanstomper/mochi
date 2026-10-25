// Persistent agent daemon. Runs a Runtime over localhost HTTP so a phone,
// dashboard, or script can hand Mochi goals without holding a TTY open. This is
// the long-lived "phone in to the agent" surface the CLI's single-shot mode
// can't provide.
//
// Security: binds to 127.0.0.1 only, and every request must carry a bearer
// token generated on start and written to `<workspace>/.mochi/daemon/info.json`
// (0600). The info file carries port + token + pid so clients can discover both
// from the workspace without scanning.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import type { MochiConfig } from '../types.js';
import { Runtime } from '../runtime.js';
import { addJob, listJobs, removeJob, getJob, setJobPaused, setJobEnabled, runJobNow, runDueCronJobs } from './cron.js';
import { truncateMiddle } from '../util.js';

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  /** Epoch ms the current token was issued. Older files predate the field (0). */
  createdAt: number;
  /** Epoch ms after which the token is rejected. Null = no expiry. */
  expiresAt: number | null;
}

/** Default bearer-token lifetime: 30 days. Rotation (`mochi daemon rotate`
 *  / POST /api/rotate) issues a fresh token with a fresh deadline. */
export const DAEMON_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

/** Server version for the unauthenticated /api/health probe. Resolved once
 *  at module load (package.json next to the source tree, or baked fallback). */
let cachedVersion: string | null = null;
export function daemonVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    cachedVersion = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown');
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

/** Mutable auth holder shared by the HTTP handler: rotation swaps the token
 *  in place so a live server never needs a restart. */
export interface DaemonAuth {
  token: string;
  expiresAt: number | null;
}

export function isTokenExpired(auth: Pick<DaemonAuth, 'expiresAt'>, now = Date.now()): boolean {
  return auth.expiresAt !== null && now > auth.expiresAt;
}

/** Rotate to a fresh token with a fresh deadline. Returns the new credentials. */
export function rotateAuth(auth: DaemonAuth, now = Date.now()): { token: string; expiresAt: number } {
  auth.token = randomBytes(24).toString('hex');
  auth.expiresAt = now + DAEMON_TOKEN_TTL_MS;
  return { token: auth.token, expiresAt: auth.expiresAt };
}

export function daemonInfoPath(workspaceDir: string): string {
  return resolve(workspaceDir, 'daemon', 'info.json');
}

export function readDaemonInfo(workspaceDir: string): DaemonInfo | undefined {
  const p = daemonInfoPath(workspaceDir);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<DaemonInfo>;
    if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || typeof raw.pid !== 'number') return undefined;
    return {
      port: raw.port,
      token: raw.token,
      pid: raw.pid,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date(0).toISOString(),
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : null,
    };
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Constant-time token comparison so auth timing doesn't leak the token. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when a daemon is running for this workspace (info file + live pid). */
export function daemonRunning(workspaceDir: string): boolean {
  const info = readDaemonInfo(workspaceDir);
  return Boolean(info && pidAlive(info.pid));
}

function writeInfo(workspaceDir: string, info: DaemonInfo): void {
  const p = daemonInfoPath(workspaceDir);
  mkdirSync(dirname(p), { recursive: true });
  // Atomic (B29) + forced 0600: the file carries the daemon's bearer token —
  // the tmp sibling must be 0600 BEFORE the content lands, never briefly
  // world-readable in flight, and a crash mid-write must not tear the JSON
  // that clients read for discovery.
  atomicWriteFileSync(p, JSON.stringify(info), { mode: 0o600 });
}

/**
 * Spawn the daemon as a detached background process and wait for it to listen.
 * The child is `dist/daemon-server.mjs <port> <token> <cwd>`.
 */
export async function startDaemon(opts: {
  cwd: string;
  port?: number;
  config?: Partial<MochiConfig>;
  token?: string;
  host?: string;
}): Promise<{ ok: boolean; port: number; token: string; error?: string }> {
  const port = opts.port ?? 9470;
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(24).toString('hex');
  const wsDir = resolve(opts.cwd, '.mochi');
  const { spawn } = await import('node:child_process');
  // Module dir resolved HERE (not at module top): fileURLToPath throws inside
  // bun-compiled Windows binaries, which must not break unrelated commands at
  // import time. Fall back to cwd — startDaemon then fails with a clear
  // spawn error instead of a cryptic URL crash.
  let daemonHere: string;
  try { daemonHere = dirname(fileURLToPath(import.meta.url)); }
  catch { daemonHere = process.cwd(); }
  const serverModule = resolve(daemonHere, '..', '..', 'dist', 'daemon', 'daemon-server.js');
  const child = spawn(process.execPath, [serverModule, String(port), token, opts.cwd, host], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { ok: false, port, token, error: `Daemon exited early (code ${child.exitCode}).` };
    }
    const info = readDaemonInfo(wsDir);
    if (info && info.port === port && pidAlive(info.pid)) return { ok: true, port, token };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, port, token, error: 'Timed out waiting for daemon to listen.' };
}

/** In-process entry used by tests and by the server module itself: no fork. */
export async function startDaemonInProcess(opts: {
  cwd: string;
  port?: number;
  config?: Partial<MochiConfig>;
  token?: string;
  /** Override the token deadline (tests). Null/undefined = default TTL. */
  expiresAt?: number | null;
  /** Bind address. Defaults to 127.0.0.1; containers set '0.0.0.0'. */
  host?: string;
}): Promise<{ info: DaemonInfo; close: () => Promise<void>; runtime: Runtime }> {
  const port = opts.port ?? 0;
  const token = opts.token ?? randomBytes(24).toString('hex');
  const now = Date.now();
  const auth: DaemonAuth = { token, expiresAt: opts.expiresAt === undefined ? now + DAEMON_TOKEN_TTL_MS : opts.expiresAt };
  const wsDir = resolve(opts.cwd, '.mochi');
  const runtime = Runtime.create({ cwd: opts.cwd, config: opts.config });

  const persist = () => {
    const info: DaemonInfo = {
      port: addr.port,
      token: auth.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      createdAt: now,
      expiresAt: auth.expiresAt,
    };
    writeInfo(wsDir, info);
  };
  const server = createServer(async (req, res) => {
    await handleRequest(req, res, auth, runtime, { onRotate: persist });
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const addr = server.address() as { port: number };
  const info: DaemonInfo = {
    port: addr.port,
    token: auth.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    createdAt: now,
    expiresAt: auth.expiresAt,
  };
  writeInfo(wsDir, info);

  // Cron ticker: run any due recurring jobs serially (never overlapping), so
  // a scheduled prompt is executed by the same goal engine over HTTP.
  let processing = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const cwd = opts.cwd;
  // MCH-212: self-improvement tick. On daemon start, ensure ONE recurring
  // cron job exists whose prompt drives the full improvement flywheel
  // (pitfall mining, lesson graduation, self-patch, report) even when no
  // user task is running. Idempotent: detected by a reserved marker, and
  // opted out via config.selfImprovement === false. Skipped under vitest
  // (tests assert exact job lists) — same convention as update-check.
  try {
    const cfg = runtime.config as { selfImprovement?: boolean };
    if (cfg.selfImprovement !== false && !process.env.VITEST) {
      const { listJobs, addJob } = await import('./cron.js');
      const MARKER = '[self-improvement tick]';
      const jobs = listJobs(resolve(cwd, '.mochi'));
      if (!jobs.some((j) => j.prompt.includes(MARKER))) {
        addJob(
          resolve(cwd, '.mochi'),
          `${MARKER} Run the skill self-improvement flywheel for this workspace: (1) call the skill curator so pitfall mining, lesson graduation, and self-patching of repeatedly-failing skills execute; (2) run \`mochi skills report\` and record one line summarizing the league table (total skills, avg score, needs-attention count) in the run output. Keep the whole run under 20 tool calls; do not modify source files.`,
          'every 6h',
        );
      }
    }
  } catch { /* bootstrap must never block daemon start */ }
  const runDue = async () => {
    if (processing) return;
    processing = true;
    try {
      // Serial, timeout-aware, and persisted: a crashing/timing-out job can
      // never wedge the scheduler or re-fire immediately.
      await runDueCronJobs(cwd, (prompt, signal) => runtime.goal(prompt, [], undefined, signal));
    } finally {
      processing = false;
    }
  };
  ticker = setInterval(runDue, 1_000);

  return {
    info,
    close: async () => {
      if (ticker) clearInterval(ticker);
      server.close();
      // Release process-owned resources (open SQLite session handles lock the
      // workspace dir on Windows) before unlinking the daemon info file.
      try { runtime.close(); } catch { /* best-effort */ }
      const p = daemonInfoPath(wsDir);
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* already gone */ }
      }
    },
    runtime,
  };
}

/** The dashboard HTML may embed the real bearer token ONLY when the request
 *  itself proved possession of it (tokenOk). An unauthenticated request must
 *  never receive the token — previously `getDashboardHtml(reqToken ||
 *  auth.token)` handed the real token to anyone who could reach 127.0.0.1,
 *  including any website the user visited. Returns '' when not proven. */
export function dashboardResponseToken(_reqToken: string, tokenOk: boolean, realToken: string): string {
  return tokenOk ? realToken : '';
}

const LOCALHOST_ORIGIN_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True only for http(s) origins on a loopback host (any local port, so
 *  local tools like Open WebUI on another port keep working). */
export function isLocalhostOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCALHOST_ORIGIN_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

/** CORS headers for a request: reflect the Origin ONLY when it is a
 *  localhost origin; otherwise no CORS grant at all. Never '*': with '*',
 *  any website could read authenticated API responses cross-origin. */
export function corsHeadersForOrigin(origin: string | undefined): Record<string, string> {
  if (!isLocalhostOrigin(origin)) return {};
  return {
    'access-control-allow-origin': origin as string,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    vary: 'Origin',
  };
}

/** Token-free login page served for unauthenticated dashboard requests.
 *  Contains NO token: the user pastes one (stored in localStorage, then the
 *  browser reloads via /?token=... so the server can verify it), and a
 *  returning browser with a saved token is auto-redirected through the
 *  same verified path. */
export function getDashboardLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mochi Agent Dashboard — Sign in</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0f1117; color: #f8f8f2; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1a1d26; border: 1px solid #2e3346; border-radius: 10px; padding: 28px; max-width: 440px; width: 92%; }
    h1 { font-size: 1.15rem; color: #ff79c6; margin: 0 0 12px; }
    p { line-height: 1.5; font-size: 0.92rem; color: #a4b1cd; }
    code { background: #12141c; padding: 1px 5px; border-radius: 4px; }
    .row { display: flex; gap: 8px; margin-top: 16px; }
    input { flex: 1; padding: 10px 12px; background: #12141c; border: 1px solid #2e3346; border-radius: 6px; color: #f8f8f2; outline: none; }
    button { padding: 10px 18px; background: #ff79c6; border: none; border-radius: 6px; color: #000; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🍡 Mochi Dashboard — token required</h1>
    <p>This dashboard is protected by the daemon's bearer token, which is never
    sent to unauthenticated browsers. Open it with the signed-in link from
    <code>mochi dashboard</code> in the workspace, or paste the token from
    <code>.mochi/daemon/info.json</code> below.</p>
    <div class="row">
      <input type="password" id="token-input" placeholder="Daemon token" autocomplete="off" />
      <button id="token-go">Open</button>
    </div>
  </div>
  <script>
    // Returning browser: a previously saved token goes through the normal
    // server-verified /?token= path (the dashboard scrubs it from the URL
    // and re-saves it). An invalid saved token lands on the 401 page, not
    // in a redirect loop, because this page is only served with NO token.
    try {
      const saved = localStorage.getItem('mochi_token');
      if (saved) window.location.replace('/?token=' + encodeURIComponent(saved));
    } catch { /* storage unavailable: manual entry still works */ }
    function go() {
      const v = document.getElementById('token-input').value.trim();
      if (!v) return;
      try { localStorage.setItem('mochi_token', v); } catch { /* ignore */ }
      window.location.href = '/?token=' + encodeURIComponent(v);
    }
    document.getElementById('token-go').addEventListener('click', go);
    document.getElementById('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  </script>
</body>
</html>`;
}

export function getDashboardHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mochi Agent Dashboard</title>
  <style>
    :root {
      --bg: #0f1117;
      --card: #1a1d26;
      --border: #2e3346;
      --accent: #ff79c6;
      --text: #f8f8f2;
      --green: #50fa7b;
      --code-bg: #12141c;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    header {
      background: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand { font-weight: 700; font-size: 1.2rem; color: var(--accent); display: flex; align-items: center; gap: 8px; }
    .status-badge { background: rgba(80, 250, 123, 0.15); color: var(--green); padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
    .main { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 280px; background: var(--card); border-right: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
    .chat-container { flex: 1; display: flex; flex-direction: column; background: var(--bg); }
    .messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .msg { padding: 12px 16px; border-radius: 8px; max-width: 85%; font-size: 0.95rem; line-height: 1.5; white-space: pre-wrap; }
    .msg.user { background: #282a36; align-self: flex-end; border: 1px solid var(--border); }
    .msg.agent { background: #1e2230; align-self: flex-start; border-left: 3px solid var(--accent); }
    .msg.log { background: var(--code-bg); font-family: monospace; font-size: 0.82rem; color: #a4b1cd; }
    .input-area { padding: 16px; background: var(--card); border-top: 1px solid var(--border); display: flex; gap: 12px; }
    input[type="text"] { flex: 1; padding: 12px 16px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 1rem; outline: none; }
    input[type="text"]:focus { border-color: var(--accent); }
    button { padding: 12px 24px; background: var(--accent); border: none; border-radius: 6px; color: #000; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
    button:hover { opacity: 0.9; }
    .card-title { font-size: 0.85rem; text-transform: uppercase; color: #6272a4; letter-spacing: 0.05em; margin-bottom: 8px; }
    @media (max-width: 768px) {
      .sidebar { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">🍡 Mochi Dashboard</div>
    <div class="status-badge">● Daemon Live</div>
  </header>
  <div class="main">
    <div class="sidebar">
      <div>
        <div class="card-title">Quick Actions</div>
        <button style="width:100%; margin-bottom:8px; background:#44475a; color:#fff;" onclick="sendQuick('/doctor')">🩺 Run Doctor</button>
        <button style="width:100%; background:#44475a; color:#fff;" onclick="sendQuick('/usage')">📊 Token Usage</button>
      </div>
    </div>
    <div class="chat-container">
      <div class="messages" id="messages">
        <div class="msg agent">Hello! I am Mochi. Enter a goal or coding task below to start.</div>
      </div>
      <div class="input-area">
        <input type="text" id="prompt-input" placeholder="Type a goal (e.g. 'Build a REST API endpoint')..." onkeydown="if(event.key==='Enter') sendGoal()" />
        <button id="send-btn" onclick="sendGoal()">Send</button>
      </div>
    </div>
  </div>
  <script>
    const token = '${token}' || new URLSearchParams(window.location.search).get('token') || localStorage.getItem('mochi_token') || '';
    if (token) localStorage.setItem('mochi_token', token);
    // Hygiene: a token that arrived via ?token= share link is scrubbed from
    // the address bar immediately so it never lingers in browser history,
    // proxy logs, or screenshots of the URL bar.
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.has('token')) {
        u.searchParams.delete('token');
        window.history.replaceState(null, '', u.toString());
      }
    } catch { /* non-browser context: ignore */ }

    async function sendGoal() {
      const input = document.getElementById('prompt-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMsg(text, 'user');
      const msgDiv = addMsg('Thinking and working on task...', 'agent');

      try {
        const res = await fetch('/api/goal', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (localStorage.getItem('mochi_token') || ''),
            'Accept': 'text/event-stream'
          },
          body: JSON.stringify({ objective: text })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\\n\\n');
          buf = lines.pop() || '';

          for (const chunk of lines) {
            if (chunk.startsWith('event: task:started')) {
              const data = JSON.parse(chunk.replace(/^event: .*\\ndata: /, ''));
              addMsg('▶ Started: ' + (data.task || ''), 'log');
            } else if (chunk.startsWith('event: task:completed')) {
              const data = JSON.parse(chunk.replace(/^event: .*\\ndata: /, ''));
              addMsg('✓ Completed: ' + (data.task || ''), 'log');
            } else if (chunk.startsWith('event: done')) {
              const data = JSON.parse(chunk.replace(/^event: .*\\ndata: /, ''));
              msgDiv.textContent = data.out;
            }
          }
        }
      } catch (err) {
        msgDiv.textContent = 'Error: ' + err.message;
      }
    }

    function sendQuick(cmd) {
      document.getElementById('prompt-input').value = cmd;
      sendGoal();
    }

    function addMsg(text, type) {
      const msgs = document.getElementById('messages');
      const d = document.createElement('div');
      d.className = 'msg ' + type;
      d.textContent = text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
      return d;
    }
  </script>
</body>
</html>`;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: DaemonAuth,
  runtime: Runtime,
  opts?: { onRotate?: () => void },
): Promise<void> {
  const cors = corsHeadersForOrigin(req.headers.origin);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  };

  const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = parsedUrl.pathname;
  const queryToken = parsedUrl.searchParams.get('token') ?? '';
  const authHeader = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const reqToken = authHeader || queryToken;
  const tokenOk = Boolean(reqToken) && timingSafeEqualStr(reqToken, auth.token);
  const expired = isTokenExpired(auth);

  // Serve Web UI Dashboard on GET / or /dashboard
  if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
    if (reqToken && !tokenOk) {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<h1>401 Unauthorized</h1><p>Invalid daemon token.</p>');
      return;
    }
    if (tokenOk && expired) {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<h1>401 Token expired</h1><p>Run <code>mochi daemon rotate</code> in the workspace, then reconnect with the new token.</p>');
      return;
    }
    if (!tokenOk) {
      // No token presented: serve the token-free login page. The real token
      // must NEVER be embedded here — anyone able to reach 127.0.0.1 (a
      // local process, or a website driving the user's browser) could
      // otherwise scrape it and take over the daemon API.
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(getDashboardLoginHtml());
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml(dashboardResponseToken(reqToken, tokenOk, auth.token)));
    return;
  }

  // CORS preflight (browsers / Open WebUI / AnythingLLM). Only localhost
  // origins are granted; other origins get no CORS headers at all.
  if (req.method === 'OPTIONS') {
    const preflightCors = corsHeadersForOrigin(req.headers.origin);
    res.writeHead(204, { ...preflightCors, ...(Object.keys(preflightCors).length ? { 'access-control-max-age': '86400' } : {}) });
    res.end();
    return;
  }

  // Unauthenticated health probe (containers / load balancers / CI): version
  // + uptime only, never state or secrets. Must precede the token gate.
  if (req.method === 'GET' && path === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json', ...corsHeadersForOrigin(req.headers.origin) });
    res.end(JSON.stringify({ ok: true, version: daemonVersion(), uptimeSec: Math.floor(process.uptime()) }));
    return;
  }


  if (!tokenOk) {
    send(401, { error: 'unauthorized' });
    return;
  }
  if (expired) {
    send(401, { error: 'token_expired', hint: 'run `mochi daemon rotate` in the workspace to issue a fresh token' });
    return;
  }
  // Read-only GET endpoints (authenticated): inventory for CI/tooling without
  // a POST body. Mutating/expensive calls stay POST-only below.
  if (req.method === 'GET' && (path === '/api/models' || path === '/v1/models')) {
    try {
      const m = runtime.config.model.model;
      const models = Array.isArray(runtime.modelList?.()) ? runtime.modelList() : [m];
      if (path === '/v1/models') {
        const data = (models.length ? models : [m]).map((id: string) => ({
          id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'mochi',
        }));
        send(200, { object: 'list', data });
      } else {
        send(200, { ok: true, provider: runtime.config.model.provider, models });
      }
    } catch (e) {
      send(500, { ok: false, error: (e as Error).message });
    }
    return;
  }
  if (req.method === 'GET' && path === '/api/skills') {
    try {
      const { loadAllSkills } = await import('../skills/skills.js');
      const { skills } = loadAllSkills(runtime.cwd);
      send(200, { ok: true, count: skills.length, skills: skills.map((s) => ({ name: s.name, description: s.description })) });
    } catch (e) {
      send(500, { ok: false, error: (e as Error).message });
    }
    return;
  }
  if (req.method !== 'POST') {
    send(405, { error: 'method not allowed' });
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    send(400, { error: 'invalid json' });
    return;
  }
  try {
    if (path === '/api/status') {
      const usage = runtime.usage?.total?.() as
        | { modelCalls: number; tokensIn: number; tokensOut: number; costUsd: number; toolCalls: number; durationMs: number }
        | undefined;
      send(200, {
        ok: true,
        pid: process.pid,
        cwd: runtime.cwd,
        usage: usage
          ? {
              modelCalls: usage.modelCalls,
              tokensIn: usage.tokensIn,
              tokensOut: usage.tokensOut,
              costUsd: usage.costUsd,
              toolCalls: usage.toolCalls,
              durationMs: usage.durationMs,
            }
          : undefined,
      });
    } else if (path === '/api/rotate') {
      // Zero-downtime credential rotation: the caller proves the CURRENT
      // token, we swap in a fresh one (new deadline) and persist it. The old
      // token stops working on the very next request.
      const next = rotateAuth(auth);
      try { opts?.onRotate?.(); } catch { /* persist is best-effort */ }
      send(200, { ok: true, token: next.token, expiresAt: next.expiresAt });
    } else if (path === '/api/jobs') {
      const ids = runtime.workspace.listGoals();
      const jobs: Array<{ id: string; status: string; objective?: string; progress?: number }> = [];
      for (const f of ids.slice(-20)) {
        const id = f.replace(/\.json$/, '');
        try {
          const g = runtime.workspace.loadGoal(id);
          if (g && typeof g.id === 'string' && typeof g.status === 'string') {
            jobs.push({
              id: g.id.slice(0, 8),
              status: g.status,
              objective: truncateMiddle(g.objective ?? '', 60),
              progress: g.progress,
            });
          }
        } catch {
          // Non-goal state files (usage, pending-goal, checkpoints) are skipped.
        }
      }
      send(200, { ok: true, jobs });
    } else if (path === '/api/inspect') {
      const out = await runtime.inspect(String(body.query ?? ''));
      send(200, { ok: true, out });
    } else if (path === '/api/plan') {
      const out = await runtime.plan(String(body.objective ?? ''));
      send(200, { ok: true, out, pending: true });
    } else if (path === '/api/approve') {
      const out = await runtime.approvePlan();
      send(200, { ok: true, out });
    } else if (path === '/api/cron') {
      const action = String(body.action ?? '');
      const cwd = runtime.cwd || runtime.workspace.dir;
      if (action === 'add') {
        const prompt = String(body.prompt ?? '');
        const schedule = String(body.schedule ?? '');
        const notify = body.notify ? String(body.notify) : undefined;
        if (!prompt || !schedule) { send(400, { ok: false, error: 'prompt and schedule required' }); return; }
        const timeoutMs = body.timeoutMs !== undefined ? Number(body.timeoutMs) : undefined;
        const r = addJob(cwd, prompt, schedule, { notify, timeoutMs, paused: body.paused === true });
        send(r.error ? 400 : 200, r.error ? { ok: false, error: r.error } : { ok: true, id: r.id });
        return;
      }
      if (action === 'list' || action === 'listed-up') {
        const jobs = listJobs(cwd).map((j) => ({
          id: j.id, prompt: j.prompt, schedule: j.schedule, enabled: j.enabled, paused: j.paused === true,
          runs: j.runs, lastRun: j.lastRun, nextRun: j.nextRun, notify: j.notify ?? null,
          timeoutMs: j.timeoutMs ?? null, lastStatus: j.lastStatus ?? null, lastError: j.lastError ?? null,
          lastOutput: j.lastOutput ?? null, lastDurationMs: j.lastDurationMs ?? null,
        }));
        send(200, { ok: true, jobs });
        return;
      }
      if (action === 'status') {
        const job = getJob(cwd, String(body.id ?? ''));
        send(job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: 'job not found' });
        return;
      }
      if (action === 'pause' || action === 'resume') {
        const ok = setJobPaused(cwd, String(body.id ?? ''), action === 'pause');
        send(ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'job not found' });
        return;
      }
      if (action === 'enable' || action === 'disable') {
        const ok = setJobEnabled(cwd, String(body.id ?? ''), action === 'enable');
        send(ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'job not found' });
        return;
      }
      if (action === 'run') {
        const ok = runJobNow(cwd, String(body.id ?? ''));
        send(ok ? 200 : 404, ok ? { ok: true, queued: true } : { ok: false, error: 'job not found' });
        return;
      }
      if (action === 'remove') {
        const id = String(body.id ?? '');
        removeJob(cwd, id);
        send(200, { ok: true });
        return;
      }
      send(400, { ok: false, error: 'action must be add|list|status|pause|resume|enable|disable|run|remove' });
      return;
    } else if (path === '/api/resume') {
      const goalId = String(body.goalId ?? '');
      if (!goalId) { send(400, { ok: false, error: 'goalId required' }); return; }
      const out = await runtime.resumeGoal(goalId);
      send(200, { ok: true, out });
    } else if (path === '/api/goal') {
      const objective = String(body.objective ?? '');
      const wantsStream = String(req.headers.accept ?? '').includes('text/event-stream');
      if (wantsStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const off = runtime.events.onAll((e: any) => {
          if (e.type === 'task:started') sse('task:started', { task: e.task?.title, agentId: e.agentId });
          else if (e.type === 'task:completed') sse('task:completed', { task: e.task?.title, status: e.task?.status, agentId: e.agentId });
          else if (e.type === 'agent:log') sse('log', { agentId: e.agentId, message: e.message });
        });
        const onAbort = () => off();
        req.on('close', onAbort);
        try {
          const out = await runtime.goal(objective);
          sse('done', { ok: true, out });
        } catch (e) {
          sse('error', { ok: false, error: (e as Error).message });
        } finally {
          off();
          req.off('close', onAbort);
          res.end();
        }
      } else {
        const out = await runtime.goal(objective);
        send(200, { ok: true, out });
      }
    } else if (path === '/api/prompt') {
      // One-shot prompt → full agent run → structured result (SDK remote mode).
      const task = String(body.task ?? '');
      if (!task) { send(400, { ok: false, error: 'task required' }); return; }
      const r = await runtime.runPromptDetailed(task);
      send(200, { ok: true, ...r });
    } else if (path === '/v1/chat/completions') {
      // OpenAI-compatible chat completions: map the conversation to a single
      // Mochi goal/prompt run. Supports non-streaming and basic SSE streaming.
      const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: string }> : [];
      const model = String(body.model ?? runtime.config.model.model);
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user')?.content ?? messages.map((m) => m?.content ?? '').join('\n');
      const wantsStream = body.stream === true;
      if (wantsStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...corsHeadersForOrigin(req.headers.origin) });
        const chunkId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const writeChunk = (content: string, finish = false) => {
          const choice = { index: 0, delta: finish ? {} : { role: 'assistant', content }, finish_reason: finish ? 'stop' : null };
          res.write(`data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model, choices: [choice] })}\n\n`);
        };
        try {
          const out = await runtime.goal(String(lastUser));
          // Stream in a single chunk for simplicity; OpenAI clients accept it.
          writeChunk(out);
          writeChunk('', true);
          res.write('data: [DONE]\n\n');
        } catch (e) {
          writeChunk(`\n[error] ${(e as Error).message}`, true);
          res.write('data: [DONE]\n\n');
        } finally {
          res.end();
        }
        return;
      }
      try {
        const out = await runtime.goal(String(lastUser));
        send(200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (e) {
        send(500, { error: { message: (e as Error).message, type: 'server_error' } });
      }
      return;
    } else if (path === '/api/steer') {
      // MCH-218: cross-process steering — push guidance into a RUNNING goal
      // from outside the daemon process (TUI, curl, CI). Same path the in-TUI
      // steer button uses; lands at the agents' next loop iteration.
      const text = String(body.text ?? '').trim();
      if (!text) { send(400, { ok: false, error: 'text required' }); return; }
      const reached = runtime.steer(text);
      send(200, { ok: true, reached, hint: reached === 0 ? 'no live agents in this daemon' : `delivered to ${reached} running agent(s)` });
    } else if (path === '/api/review') {
      // Authenticated CI/tooling call: review a diff without spawning a CLI.
      // Empty/absent diff falls back to the working tree's `git diff HEAD`.
      let diff = String(body.diff ?? '');
      if (!diff) {
        const { execFileSync } = await import('node:child_process');
        try {
          diff = execFileSync('git', ['diff', 'HEAD'], { cwd: runtime.cwd, encoding: 'utf8' });
        } catch {
          send(400, { ok: false, error: 'no diff given and no git diff available' });
          return;
        }
      }
      if (!diff.trim()) { send(200, { ok: true, out: 'Nothing to review (empty diff).' }); return; }
      const out = await runtime.review(diff);
      send(200, { ok: true, out });
    } else if (path === '/api/verify') {
      // Authenticated CI/tooling call: run the repo's checks (test/build/
      // typecheck/lint) and return the structured result. No shell access —
      // only the detected repo command runs, with an optional file target.
      const { detectRepo } = await import('../repo/repo.js');
      const { runShellString } = await import('../exec.js');
      const repo = detectRepo(runtime.cwd);
      const which = String(body.command ?? 'test');
      const cmd = which === 'build' ? repo.buildCommand ?? null
        : which === 'typecheck' ? repo.typecheckCommand ?? null
        : which === 'lint' ? repo.lintCommand ?? null
        : repo.testCommand ?? null;
      if (!cmd) { send(400, { ok: false, error: `no ${which} command detected for this repo` }); return; }
      const target = typeof body.target === 'string' && body.target ? ` ${body.target}` : '';
      const r = await runShellString(cmd + target, { cwd: runtime.cwd, timeoutMs: 300_000, maxOutput: 256 * 1024 });
      send(200, { ok: r.code === 0, exitCode: r.code, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().slice(-8000) });
    } else {
      send(404, { error: 'not found' });
    }
  } catch (e) {
    send(500, { ok: false, error: (e as Error).message });
  }
}

/** The detached child entry. argv: child, module, <port> <token> <cwd> */
export async function serverMain(argv: string[]): Promise<void> {
  const [, , port, token, cwd, host = '127.0.0.1'] = argv;
  if (!port || !token || !cwd) {
    throw new Error('daemon-server <port> <token> <cwd> [host]');
  }
  const rt = Runtime.create({ cwd, config: {} });
  const now = Date.now();
  const auth: DaemonAuth = { token, expiresAt: now + DAEMON_TOKEN_TTL_MS };
  const persist = (port: number) => {
    writeInfo(resolve(cwd, '.mochi'), { port, token: auth.token, pid: process.pid, startedAt: new Date().toISOString(), createdAt: now, expiresAt: auth.expiresAt });
  };
  const server = createServer(async (req, res) => {
    await handleRequest(req, res, auth, rt, { onRotate: () => persist((server.address() as { port: number }).port) });
  });
  // Cron ticker for the detached server too.
  let processing = false;
  setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      await runDueCronJobs(cwd, (prompt, signal) => rt.goal(prompt, [], undefined, signal));
    } finally { processing = false; }
  }, 10_000);
  server.listen(Number(port), host, () => {
    const addr = server.address() as { port: number };
    persist(addr.port);
  });
}

// Daemon child entrypoint (invoked by `node dist/daemon-server.js ...`).
const isChild = process.argv[1]?.endsWith('daemon-server.js');
if (isChild) {
  void serverMain(process.argv);
}