// ACP (Agent Client Protocol) stdio server — the Hermes-style editor-native
// integration. Editors (VS Code, Zed, JetBrains) spawn Mochi as a child and
// speak JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout:
//
//   initialize       -> {protocolVersion, clientCapabilities}
//   session/new      -> {sessionId, cwd}   (creates a runtime for a workspace)
//   session/prompt   -> runs the goal, returns the summary
//   session/close    -> closes the session
//   shutdown         -> clean exit
//
// The protocol core (handleRpc) is pure and unit-testable without spawning;
// the stdio loop (serverLoop) is the thin adapter over it.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Runtime } from './runtime.js';

export interface AcpSession {
  id: string;
  cwd: string;
  runtime: Runtime;
}

export interface RpcCall {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Dispatch one RPC call against the current sessions. Returns the response.
 *  session/prompt actually runs a goal (requires a configured provider). */
export async function handleRpc(
  call: RpcCall,
  sessions: Map<string, AcpSession>,
  cwd: string,
): Promise<RpcResponse> {
  const id = call.id ?? null;
  const method = call.method ?? '';
  const params = call.params ?? {};
  try {
    switch (method) {
      case 'initialize':
        return { id, result: { protocolVersion: 1, capabilities: ['prompt', 'sessions'], implementation: 'mochi' } };
      case 'session/new': {
        const sid = randomUUID();
        const sessionCwd = typeof params.cwd === 'string' && params.cwd ? resolve(params.cwd) : cwd;
        const runtime = Runtime.create({ cwd: sessionCwd });
        sessions.set(sid, { id: sid, cwd: sessionCwd, runtime });
        return { id, result: { sessionId: sid, cwd: sessionCwd } };
      }
      case 'session/prompt': {
        const sid = String(params.sessionId ?? '');
        const text = String(params.prompt ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        if (!text) return { id, error: { code: -32602, message: 'prompt required' } };
        const constraints: string[] = Array.isArray(params.constraints) ? (params.constraints as string[]).map(String) : [];
        const summary = await session.runtime.goal(text, constraints);
        return { id, result: { summary } };
      }
      case 'session/close': {
        const sid = String(params.sessionId ?? '');
        sessions.delete(sid);
        return { id, result: { ok: true } };
      }
      case 'shutdown':
        return { id, result: null };
      default:
        return { id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (e) {
    return { id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Run the ACP server until stdin closes. `cwd` is where sessions default. */
export async function serverLoop(cwd: string): Promise<void> {
  const sessions = new Map<string, AcpSession>();
  const rl = createInterface({ input: process.stdin });
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcCall;
    try {
      msg = JSON.parse(trimmed);
    } catch { return; }
    if (!msg.method) return;
    const res = await handleRpc(msg, sessions, cwd);
    send(res);
    if (msg.method === 'shutdown') process.exit(0);
  });
  await new Promise<void>((res) => rl.on('close', () => res()));
}

/** Note: the CLI dispatcher (`mochi acp`) is the sole entry point — no
 *  module-level auto-start here, or importing this module would spawn a
 *  competing server on the same stdin/stdout. */