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
import { randomBytes } from 'node:crypto';
import type { MochiConfig } from './types.js';
import { Runtime } from './runtime.js';

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
}): Promise<{ ok: boolean; port: number; token: string; error?: string }> {
  const port = opts.port ?? 9470;
  const token = opts.token ?? randomBytes(24).toString('hex');
  const wsDir = resolve(opts.cwd, '.mochi');
  const { spawn } = await import('node:child_process');
  const serverModule = resolve(here, '..', 'dist', 'daemon-server.js');
  const child = spawn(process.execPath, [serverModule, String(port), token, opts.cwd], {
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

  return {
    info,
    close: async () => {
      server.close();
      const p = daemonInfoPath(wsDir);
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* already gone */ }
      }
    },
    runtime,
  };
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

  if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
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

  const path = req.url ?? '';
  try {
    if (path === '/api/status') {
      send(200, { ok: true, pid: process.pid, cwd: runtime.cwd });
    } else if (path === '/api/inspect') {
      const out = await runtime.inspect(String(body.query ?? ''));
      send(200, { ok: true, out });
    } else if (path === '/api/plan') {
      const out = await runtime.plan(String(body.objective ?? ''));
      send(200, { ok: true, out });
    } else if (path === '/api/goal') {
      const out = await runtime.goal(String(body.objective ?? ''));
      send(200, { ok: true, out });
    } else {
      send(404, { error: 'not found' });
    }
  } catch (e) {
    send(500, { ok: false, error: (e as Error).message });
  }
}

/** The detached child entry. argv: child, module, <port> <token> <cwd> */
export async function serverMain(argv: string[]): Promise<void> {
  const [, , port, token, cwd] = argv;
  if (!port || !token || !cwd) {
    throw new Error('daemon-server <port> <token> <cwd>');
  }
  const rt = Runtime.create({ cwd, config: {} });
  const server = createServer(async (req, res) => {
    await handleRequest(req, res, token, rt);
  });
  server.listen(Number(port), '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    writeInfo(resolve(cwd, '.mochi'), { port: addr.port, token, pid: process.pid, startedAt: new Date().toISOString() });
  });
}

// Daemon child entrypoint (invoked by `node dist/daemon-server.js ...`).
const isChild = process.argv[1]?.endsWith('daemon-server.js');
if (isChild) {
  void serverMain(process.argv);
}