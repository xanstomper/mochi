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
// The server is intentionally small: an editor asks for work, Mochi does it
// with the full harness (tools, verification, sessions, traces) and answers
// with the final summary. Session transcripts persist via the session store,
// so editor sessions are resumable like daemon goals.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Runtime } from './runtime.js';

export interface AcpSession {
  id: string;
  cwd: string;
  runtime: Runtime;
}

/** Run the ACP server until stdin closes. `cwd` is where sessions default. */
export async function serverLoop(cwd: string): Promise<void> {
  const sessions = new Map<string, AcpSession>();
  const rl = createInterface({ input: process.stdin });
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

  const fail = (id: number | string | null, code: number, message: string) =>
    send({ id, error: { code, message } });

  const handle = async (id: number | string | null, method: string, params: Record<string, unknown>) => {
    const respond = (result: unknown) => send({ id, result });
    try {
      switch (method) {
        case 'initialize':
          respond({ protocolVersion: 1, capabilities: ['prompt', 'sessions'], implementation: 'mochi' });
          return;
        case 'session/new': {
          const sid = randomUUID();
          const sessionCwd = typeof params.cwd === 'string' && params.cwd ? resolve(params.cwd) : cwd;
          const runtime = Runtime.create({ cwd: sessionCwd });
          sessions.set(sid, { id: sid, cwd: sessionCwd, runtime });
          respond({ sessionId: sid, cwd: sessionCwd });
          return;
        }
        case 'session/prompt': {
          const sid = String(params.sessionId ?? '');
          const text = String(params.prompt ?? '');
          const session = sessions.get(sid);
          if (!session) { fail(id, -32602, `Unknown session ${sid}`); return; }
          if (!text) { fail(id, -32602, 'prompt required'); return; }
          const constraints: string[] = Array.isArray(params.constraints) ? (params.constraints as string[]).map(String) : [];
          const summary = await session.runtime.goal(text, constraints);
          respond({ summary });
          return;
        }
        case 'session/close': {
          const sid = String(params.sessionId ?? '');
          sessions.delete(sid);
          respond({ ok: true });
          return;
        }
        case 'shutdown':
          respond(null);
          process.exit(0);
          return;
        default:
          fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      fail(id, -32603, e instanceof Error ? e.message : String(e));
    }
  };

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number | string | null; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch { return; }
    if (!msg.method) return;
    await handle(msg.id ?? null, msg.method, msg.params ?? {});
  });
  await new Promise<void>((res) => rl.on('close', () => res()));
}

/** Note: the CLI dispatcher (`mochi acp`) is the sole entry point — no
 *  module-level auto-start here, or importing this module would spawn a
 *  competing server on the same stdin/stdout. */