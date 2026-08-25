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
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MochiConfig } from './types.js';
import { Runtime } from './runtime.js';
import { addJob, listJobs, removeJob, dueJobs, bumpJob, updateJob, notifyJobResult } from './cron.js';
import { truncateMiddle } from './util.js';

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

const here = dirname(fileURLToPath(import.meta.url));

export function daemonInfoPath(workspaceDir: string): string {
  return resolve(workspaceDir, 'daemon', 'info.json');
}

export function readDaemonInfo(workspaceDir: string): DaemonInfo | undefined {
  const p = daemonInfoPath(workspaceDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonInfo;
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
  writeFileSync(p, JSON.stringify(info), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // best effort (some platforms ignore mode on write)
  }
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
  const serverModule = resolve(here, '..', 'dist', 'daemon-server.js');
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
}): Promise<{ info: DaemonInfo; close: () => Promise<void>; runtime: Runtime }> {
  const port = opts.port ?? 0;
  const token = opts.token ?? randomBytes(24).toString('hex');
  const wsDir = resolve(opts.cwd, '.mochi');
  const runtime = Runtime.create({ cwd: opts.cwd, config: opts.config });

  const server = createServer(async (req, res) => {
    await handleRequest(req, res, token, runtime);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const info: DaemonInfo = {
    port: addr.port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeInfo(wsDir, info);

  // Cron ticker: run any due recurring jobs serially (never overlapping), so
  // a scheduled prompt is executed by the same goal engine over HTTP.
  let processing = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const cwd = opts.cwd;
  const runDue = async () => {
    if (processing) return;
    processing = true;
    try {
      const due = await dueJobs(cwd);
      for (const job of due) {
        let summary = 'Goal ran.';
        try {
          summary = await runtime.goal(job.prompt);
        } catch { /* job failures are non-fatal */ }
        await notifyJobResult(job, summary);
        updateJob(cwd, bumpJob(job)); // persist nextRun+runs so it won't re-fire
      }
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
      const p = daemonInfoPath(wsDir);
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* already gone */ }
      }
    },
    runtime,
  };
}

function getDashboardHtml(token: string): string {
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
  token: string,
  runtime: Runtime,
): Promise<void> {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = parsedUrl.pathname;
  const queryToken = parsedUrl.searchParams.get('token') ?? '';
  const authHeader = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const reqToken = authHeader || queryToken;

  // Serve Web UI Dashboard on GET / or /dashboard
  if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
    if (reqToken && !timingSafeEqualStr(reqToken, token)) {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<h1>401 Unauthorized</h1><p>Invalid daemon token.</p>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml(reqToken || token));
    return;
  }

  if (!reqToken || !timingSafeEqualStr(reqToken, token)) {
    send(401, { error: 'unauthorized' });
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
        const r = addJob(cwd, prompt, schedule, notify);
        send(r.error ? 400 : 200, r.error ? { ok: false, error: r.error } : { ok: true, id: r.id });
        return;
      }
      if (action === 'listed-up') {
        const jobs = listJobs(cwd).map((j) => ({ id: j.id, prompt: j.prompt, schedule: j.schedule, enabled: j.enabled, runs: j.runs, lastRun: j.lastRun, nextRun: j.nextRun, notify: j.notify ?? null }));
        send(200, { ok: true, jobs });
        return;
      }
      if (action === 'remove') {
        const id = String(body.id ?? '');
        removeJob(cwd, id);
        send(200, { ok: true });
        return;
      }
      send(400, { ok: false, error: 'action must be added|listed-up|remove' });
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
  const server = createServer(async (req, res) => {
    await handleRequest(req, res, token, rt);
  });
  // Cron ticker for the detached server too.
  let processing = false;
  setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      const due = await dueJobs(cwd);
      for (const job of due) {
        let out = 'Goal ran.';
        try { out = await rt.goal(job.prompt); } catch { /* best-effort */ }
        await notifyJobResult(job, out);
        updateJob(cwd, bumpJob(job)); // persist so the same job doesn't re-fire
      }
    } finally { processing = false; }
  }, 10_000);
  server.listen(Number(port), host, () => {
    const addr = server.address() as { port: number };
    writeInfo(resolve(cwd, '.mochi'), { port: addr.port, token, pid: process.pid, startedAt: new Date().toISOString() });
  });
}

// Daemon child entrypoint (invoked by `node dist/daemon-server.js ...`).
const isChild = process.argv[1]?.endsWith('daemon-server.js');
if (isChild) {
  void serverMain(process.argv);
}