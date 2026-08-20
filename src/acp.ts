// ACP (Agent Client Protocol) stdio server — the Hermes-style editor-native
// integration. Editors (VS Code, Zed, JetBrains) spawn Mochi as a child and
// speak JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout:
//
//   initialize          -> protocol + capabilities
//   session/new         -> {sessionId, cwd}
//   session/resume      -> reopen a session
//   session/prompt      -> runs the goal, streams session/update during
//   session/cancel      -> aborts the running prompt
//   session/close       -> close the session
//   shutdown            -> clean exit
//
// The protocol core (handleRpc) is pure and unit-testable without spawning;
// the stdio loop (serverLoop) is the thin adapter over it.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Runtime } from './runtime.js';

// Baked-in default overridden by package.json at runtime (matching the CLI);
// the baked constant keeps the compiled binary versioned correctly.
let ACP_VERSION = '0.10.4';
try {
  const pkgPath = resolve(process.cwd(), 'package.json');
  ACP_VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch { /* keep baked constant */ }

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

/** Extract user text from a spec-valid prompt payload (ContentBlock[] array
 *  or, for leniency, a plain string). */
function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    const parts = prompt.map((b: any) => {
      if (b && typeof b === 'object') {
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'resource' && b.resource && typeof b.resource.text === 'string') return b.resource.text;
        if (typeof b.text === 'string') return b.text;
      }
      return '';
    }).filter(Boolean);
    return parts.join('\n');
  }
  return String(prompt ?? '');
}

/** Notifications are pushed server→client as `session/update` per ACP v1. */
export type AcpNotify = (sessionId: string, update: Record<string, unknown>) => void;

/** Map a tool name to its ACP kind (read/edit/execute/other). */
function toolKind(toolName: string): string {
  const readTools = new Set(['read', 'glob', 'search', 'inspect', 'memory', 'git', 'skill']);
  if (readTools.has(toolName)) return 'read';
  const editTools = new Set(['write', 'edit', 'patch', 'delete', 'replace_symbol']);
  if (editTools.has(toolName)) return 'edit';
  if (toolName === 'shell') return 'execute';
  return 'other';
}

/** Dispatch one RPC call against the current sessions. Returns the response.
 *  session/prompt runs a goal (requires a configured provider) and streams
 *  progress via `onNotify` (spec: session/update notifications). */
export async function handleRpc(
  call: RpcCall,
  sessions: Map<string, AcpSession>,
  cwd: string,
  onNotify: AcpNotify = () => {},
): Promise<RpcResponse> {
  const id = call.id ?? null;
  const method = call.method ?? '';
  const params = call.params ?? {};
  try {
    switch (method) {
      case 'initialize':
        return {
          id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: { resume: {}, close: {} },
              completion: { progress: true },
            },
            implementation: { name: 'mochi', version: ACP_VERSION },
          },
        };
      case 'session/new': {
        const sid = randomUUID();
        const sessionCwd = typeof params.cwd === 'string' && params.cwd ? resolve(params.cwd) : cwd;
        const runtime = Runtime.create({ cwd: sessionCwd });
        sessions.set(sid, { id: sid, cwd: sessionCwd, runtime });
        return { id, result: { sessionId: sid } };
      }
      case 'session/prompt': {
        const sid = String(params.sessionId ?? '');
        const text = promptText(params.prompt);
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        if (!text) return { id, error: { code: -32602, message: 'prompt required' } };
        const constraints: string[] = Array.isArray(params.constraints) ? (params.constraints as string[]).map(String) : [];

        // Emit the plan BEFORE execution (ACP v1 session/update 'plan'): the
        // decomposed task DAG is the agent's execution plan for this prompt.
        const goal = await session.runtime.goals.createGoal(text, constraints);
        const tasks = await session.runtime.goals.decompose(goal);
        if (tasks.length > 0) {
          onNotify(sid, {
            sessionUpdate: 'plan',
            entries: tasks.map((t) => ({ content: t.title, priority: 'high', status: 'pending' })),
          });
        }

        // Stream progress: map Mochi runtime events onto ACP updates.
        const off = session.runtime.events.onAll((e: any) => {
          switch (e.type) {
            case 'tool:called':
              onNotify(sid, { sessionUpdate: 'tool_call', toolCallId: e.tool, title: String(e.tool), kind: toolKind(e.tool), status: 'pending' });
              break;
            case 'tool:completed':
              onNotify(sid, {
                sessionUpdate: 'tool_call_update',
                toolCallId: e.tool,
                status: 'completed',
                content: [{ type: 'text', text: String(e.result?.output ?? '').slice(0, 2000) }],
              });
              break;
            case 'tool:failed':
              onNotify(sid, { sessionUpdate: 'tool_call_update', toolCallId: e.tool, status: 'failed' });
              break;
            case 'message:chunk':
            case 'message':
              if (e.type === 'message' && e.role !== 'assistant') break;
              onNotify(sid, {
                sessionUpdate: 'agent_message_chunk',
                messageId: `msg_${Date.now() % 1e9}`,
                content: { type: 'text', text: String(e.content ?? '').slice(0, 4000) },
              });
              break;
          }
        });
        try {
          await session.runtime.goals.runGoal(goal, tasks, [], session.runtime.signal);
        } catch { /* cancellation / model error surfaces below via aborted */ } finally {
          off();
        }
        return { id, result: { stopReason: session.runtime.aborted ? 'cancelled' : 'end_turn' } };
      }
      case 'session/cancel': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        session.runtime.abort('ACP session/cancel');
        return { id, result: {} };
      }
      case 'session/list': {
        const items = [...sessions.values()].map((se) => ({ sessionId: se.id, cwd: se.cwd, path: se.cwd }));
        return { id, result: { sessions: items } };
      }
      case 'session/resume': {
        const sid = String(params.sessionId ?? '');
        const sessionCwd = typeof params.cwd === 'string' && params.cwd ? resolve(params.cwd) : cwd;
        if (sessions.has(sid)) return { id, result: {} };
        sessions.set(sid, { id: sid, cwd: sessionCwd, runtime: Runtime.create({ cwd: sessionCwd }) });
        return { id, result: {} };
      }
      case 'session/set_mode': {
        // Mode switching (plan/act) is best-effort: we accept any mode id and
        // let the next prompt run in the configured planMode. Kept spec-shaped
        // so editors don't hard-fail on the call.
        return { id, result: { modeId: String(params.modeId ?? 'act') } };
      }
      case 'session/set_config_option': {
        return { id, result: { configId: String(params.configId ?? ''), value: params.value ?? null } };
      }
      case 'session/delete': {
        const sid = String(params.sessionId ?? '');
        sessions.delete(sid);
        return { id, result: {} };
      }
      case 'session/close': {
        const sid = String(params.sessionId ?? '');
        sessions.delete(sid);
        return { id, result: {} };
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
    const res = await handleRpc(msg, sessions, cwd, (sessionId, update) => {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    });
    send(res);
    if (msg.method === 'shutdown') process.exit(0);
  });
  await new Promise<void>((res) => rl.on('close', () => res()));
}

/** Note: the CLI dispatcher (`mochi acp`) is the sole entry point — no
 *  module-level auto-start here, or importing this module would spawn a
 *  competing server on the same stdin/stdout. */