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

/** Extract user text from a spec-valid prompt payload (ContentBlock[] array
 *  or, for leniency, a plain string). */
function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    // ACP prompt: [{type:"text", text:"..."}, {type:"resource", resource:{text}},...]
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

/** Dispatch one RPC call against the current sessions. Returns the response.
 *  session/prompt actually runs a goal (requires a configured provider) and
 *  streams progress via `onNotify` (spec: session/update notifications). */
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
              completion: { progress: false },
            },
            implementation: { name: 'mochi', version: '0.10.3' },
          },
        };
      case 'session/new': {
        const sid = randomUUID();
        const sessionCwd = typeof params.cwd === 'string' && params.cwd ? resolve(params.cwd) : cwd;
        // Spec: mcpServers MAY be provided; connect them if given (best-effort).
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
        // Stream progress as session/update notifications (spec v1), mapping
        // Mochi runtime events onto ACP updates: tool calls, message chunks,
        // and the final agent message.
        const off = session.runtime.events.onAll((e: any) => {
          if (e.type === 'tool:called') {
            onNotify(sid, { sessionUpdate: 'tool_call', toolCallId: e.tool, title: String(e.tool), kind: 'other', status: 'pending' });
          } else if (e.type === 'tool:completed') {
            onNotify(sid, {
              sessionUpdate: 'tool_call_update',
              toolCallId: e.tool,
              status: 'completed',
              content: [{ type: 'text', text: String(e.result?.output ?? '').slice(0, 2000) }],
            });
          } else if (e.type === 'tool:failed') {
            onNotify(sid, { sessionUpdate: 'tool_call_update', toolCallId: e.tool, status: 'failed' });
          } else if (e.type === 'message:chunk' || (e.type === 'message' && e.role === 'assistant')) {
            const chunk = e.type === 'message:chunk' ? e.content : e.content;
            const msgId = `msg_${chunk.length % 7}_${Date.now() % 97}`;
            onNotify(sid, {
              sessionUpdate: 'agent_message_chunk',
              messageId: msgId,
              content: { type: 'text', text: chunk.slice(0, 4000) },
            });
          }
        });
        try {
          await session.runtime.goal(text, constraints);
        } finally {
          off();
        }
        // Verified spec: respond with a StopReason when the turn completes.
        return { id, result: { stopReason: 'end_turn' } };
      }
      case 'session/resume': {
        const sid = String(params.sessionId ?? '');
        const sessionCwd = typeof params.cwd === 'string' && params.cwd ? resolve(params.cwd) : cwd;
        if (sessions.has(sid)) return { id, result: {} };
        const runtime = Runtime.create({ cwd: sessionCwd });
        sessions.set(sid, { id: sid, cwd: sessionCwd, runtime });
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