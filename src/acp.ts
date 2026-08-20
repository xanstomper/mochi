// ACP (Agent Client Protocol) v1 stdio server for editor-native integration.
// Editors (VS Code, Zed, JetBrains) spawn Mochi as a child and
// speak JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout.
//
//   initialize         -> { protocolVersion, clientCapabilities, agentCapabilities, ... }
//   session/new        -> { sessionId }                                      (creates a runtime for a workspace)
//   session/prompt     -> { stopReason }                                     (runs the goal, streams updates)
//   session/cancel     -> {}                                                 (notification, aborts running prompt)
//   session/load       -> { modes, configOptions }                           (loads a prior session)
//   session/list       -> { sessions: SessionInfo[], nextCursor? }           (list sessions)
//   session/delete     -> {}                                                 (delete a session)
//   session/resume     -> {}                                                 (reconnect a session)
//   session/close      -> {}                                                 (close a session)
//   session/set_mode   -> { modeId }                                         (switch plan/act mode)
//   session/set_config_option -> { configId, value, configOptions }           (set model/context/etc)
//   session/info_update -> { sessionId, title } (server→client, streamed)      (eventual title update)
//   session/update     -> { sessionId, update } (server→client)              (streaming updates)
//   shutdown           -> null                                               (clean exit)
//
// The protocol core (handleRpc) is pure and unit-testable without spawning;
// the stdio loop (serverLoop) is the thin adapter over it.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Runtime } from './runtime.js';
import type { MochiEvent } from './types.js';

const ACP_PROTOCOL_VERSION = 1;

// Baked-in default overridden by the package.json version at runtime (matching
// the CLI); the baked constant keeps the compiled binary versioned correctly.
let ACP_AGENT_VERSION = '0.10.4';
try {
  const pkgPath = resolve(process.cwd(), 'package.json');
  ACP_AGENT_VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch { /* keep baked constant */ }

// Supported session modes.
const SESSION_MODES = [
  { id: 'act', name: 'Act', description: 'Execute tasks directly (default)' },
  { id: 'plan', name: 'Plan', description: 'Decompose into tasks first, then act' },
];

// Current session configuration options (we delegate to Mochi's config system).
const SESSION_CONFIG_OPTIONS: Array<{ id: string; name: string; description: string }> = [
  { id: 'max_iterations', name: 'Max Iterations', description: 'Maximum agent loop iterations per task (1–50)' },
  { id: 'context_budget_tokens', name: 'Context Budget', description: 'Token budget for the context window (4000–200000)' },
  { id: 'plan_mode', name: 'Plan Mode', description: 'When enabled, generate plans instead of executing changes directly' },
];

export interface AcpSession {
  id: string;
  cwd: string;
  runtime: Runtime;
  title?: string;
  goalId?: string;
  /** When loaded from a persisted goal (session/load), the goal id + tasks. */
  loadedGoal?: { goalId: string; objective: string };
  /** Additional client workspace roots (ACP session/new). */
  additionalDirectories?: string[];
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
  const readTools = new Set(['read', 'glob', 'search', 'inspect', 'memory', 'git', 'skill', 'diff', 'tree', 'fetch', 'deepwiki']);
  if (readTools.has(toolName)) return 'read';
  const editTools = new Set(['write', 'edit', 'patch', 'delete', 'replace_symbol', 'regex_replace']);
  if (editTools.has(toolName)) return 'edit';
  if (toolName === 'shell') return 'execute';
  return 'other';
}

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
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {}, resume: {}, close: {} },
              promptCapabilities: { image: false, audio: false, embeddedContext: true },
              mcpCapabilities: { http: true, sse: true },
              authMethods: [
                { id: 'agent', name: 'Agent', description: 'Agent handles authentication internally (no external auth)' }
              ],
            },
            implementation: { name: 'mochi', version: ACP_AGENT_VERSION },
          },
        };
      case 'session/new': {
        const sid = randomUUID();
        const sessionCwd = typeof params.cwd === 'string' && params.cwd ? resolve(params.cwd) : cwd;
        const additionalDirectories = Array.isArray(params.additionalDirectories)
          ? params.additionalDirectories.map((d: unknown) => String(d))
          : [];
        const runtime = Runtime.create({ cwd: sessionCwd });
        sessions.set(sid, { id: sid, cwd: sessionCwd, runtime, additionalDirectories });
        return { id, result: { sessionId: sid, modes: SESSION_MODES, configOptions: SESSION_CONFIG_OPTIONS } };
      }
      case 'session/prompt': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        const text = promptText(params.prompt);
        const constraints = Array.isArray(params.constraints)
          ? params.constraints.map((c: unknown) => String(c))
          : [];
        const emitToolCallIds = new Map<string, string>();
        let messageIdCounter = 0;
        const genMessageId = () => `msg_${++messageIdCounter}`;

        const handleEvent = (e: MochiEvent) => {
          if (e.type === 'tool:called') {
            const tcId = `tc-${randomUUID().slice(0, 8)}`;
            emitToolCallIds.set(JSON.stringify(e.args), tcId);
            onNotify(sid, { sessionUpdate: 'tool_call', toolCallId: tcId, title: e.tool, kind: toolKind(e.tool), status: 'pending', rawInput: e.args });
          } else if (e.type === 'tool:completed') {
            const tcId = emitToolCallIds.get(JSON.stringify(e.tool)) ?? e.tool;
            onNotify(sid, { sessionUpdate: 'tool_call_update', toolCallId: tcId, status: 'completed', content: [{ type: 'text', text: String(e.result?.output ?? '').slice(0, 4000) }] });
          } else if (e.type === 'tool:failed') {
            const tcId = emitToolCallIds.get(JSON.stringify(e.tool)) ?? e.tool;
            onNotify(sid, { sessionUpdate: 'tool_call_update', toolCallId: tcId, status: 'failed', content: [{ type: 'text', text: String(e.error).slice(0, 2000) }] });
          } else if (e.type === 'file:changed') {
            onNotify(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'file:' + e.path, locations: [{ path: e.path }] });
          } else if (e.type === 'message:chunk') {
            onNotify(sid, { sessionUpdate: 'agent_message_chunk', messageId: genMessageId(), content: { type: 'text', text: String(e.content).slice(0, 4000) } });
          } else if (e.type === 'message' && e.role === 'assistant') {
            onNotify(sid, { sessionUpdate: 'agent_message_chunk', messageId: genMessageId(), content: { type: 'text', text: String(e.content).slice(0, 4000) } });
          } else if (e.type === 'pulse' && e.state) {
            const st = e.state as unknown as Record<string, unknown>;
            onNotify(sid, {
              sessionUpdate: 'usage_update',
              used: typeof st.tokensUsed === 'number' ? st.tokensUsed : 0,
              size: typeof st.totalTokens === 'number' ? st.totalTokens : 0,
            });
          }
        };

        const off = session.runtime.events.onAll(handleEvent);
        let stopReason = 'end_turn';
        try {
          if (session.loadedGoal) {
            // Resume a loaded goal (session/load): reuse its persisted task
            // decomposition so the work continues, not restarts.
            const goal = session.runtime.workspace.loadGoal(session.loadedGoal.goalId);
            const tasks = session.runtime.workspace.loadTasks(session.loadedGoal.goalId);
            if (goal && tasks.length > 0) {
              await session.runtime.goals.runGoal(goal, tasks, [], session.runtime.signal);
            } else {
              await session.runtime.goal(text, constraints);
            }
          } else {
            await session.runtime.goal(text, constraints);
          }
          onNotify(sid, { sessionUpdate: 'usage_update', used: 0, size: session.runtime.workspace.dir.length, cost: null });
        } catch (err) {
          if (session.runtime.aborted) stopReason = 'cancelled';
          else return { id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
        } finally { off(); }
        return { id, result: { stopReason } };
      }
      case 'session/cancel': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        session.runtime.abort('ACP session/cancel');
        return { id, result: {} };
      }
      case 'session/load': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        const goalId = String(params.goalId ?? '');
        if (goalId) {
          const goal = session.runtime.workspace.loadGoal(goalId);
          if (goal) {
            session.loadedGoal = { goalId: goal.id, objective: goal.objective };
            session.goalId = goal.id;
            return { id, result: { modes: SESSION_MODES, configOptions: SESSION_CONFIG_OPTIONS, goalId } };
          }
          return { id, result: { modes: SESSION_MODES, configOptions: SESSION_CONFIG_OPTIONS } };
        }
        return { id, result: { modes: SESSION_MODES, configOptions: SESSION_CONFIG_OPTIONS } };
      }
      case 'session/list': {
        const limit = typeof params.limit === 'number' ? Math.max(1, params.limit) : 10;
        const rawCursor = typeof params.cursor === 'string' ? params.cursor : '';
        const cursor = rawCursor ? Buffer.from(rawCursor, 'base64').toString('utf-8') : '';
        const allIds = Array.from(sessions.keys());
        const startIndex = cursor ? allIds.indexOf(cursor) + 1 : 0;
        if (startIndex < 0 || startIndex >= allIds.length) {
          return { id, result: { sessions: [] } };
        }
        const sessionIdSlice = allIds.slice(startIndex, startIndex + limit);
        const sessionInfos = sessionIdSlice.map((s) => {
          const se = sessions.get(s)!;
          const info: any = { sessionId: s, cwd: se.cwd, title: se.title, updatedAt: Date.now() };
          if (se.additionalDirectories && se.additionalDirectories.length) info.additionalDirectories = se.additionalDirectories;
          return info;
        });
        const nextCursor = sessionIdSlice.length < limit ? undefined : Buffer.from(sessionIdSlice[sessionIdSlice.length - 1]).toString('base64');
        return { id, result: { sessions: sessionInfos, nextCursor } };
      }
      case 'session/delete': {
        const sid = String(params.sessionId ?? '');
        const deleted = sessions.delete(sid);
        if (!deleted) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        return { id, result: {} };
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
      case 'session/set_mode': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        const modeId = typeof params.modeId === 'string' ? params.modeId : 'act';
        session.runtime.config.planMode = modeId === 'plan';
        return { id, result: { modeId } };
      }
      case 'session/set_config_option': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        const configId = String(params.configId ?? '');
        const value = params.value;
        if (configId === 'plan_mode') {
          session.runtime.config.planMode = Boolean(value);
          return { id, result: { configId, value: session.runtime.config.planMode, configOptions: SESSION_CONFIG_OPTIONS } };
        } else if (configId === 'max_iterations') {
          const parsed = Math.max(1, Math.min(50, Math.round(Number(value))));
          session.runtime.config.safety.maxIterations = parsed;
          return { id, result: { configId, value: parsed, configOptions: SESSION_CONFIG_OPTIONS } };
        } else if (configId === 'context_budget_tokens') {
          const parsed = Math.max(4000, Math.min(200_000, Math.round(Number(value))));
          session.runtime.config.safety.contextBudgetTokens = parsed;
          return { id, result: { configId, value: parsed, configOptions: SESSION_CONFIG_OPTIONS } };
        }
        return { id, error: { code: -32603, message: `Unknown config option: ${configId}` } };
      }
      case 'session/tools_list': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        const tools = session.runtime.listTools
          ? session.runtime.listTools().map((t) => ({ name: t.name, description: t.description, permission: t.permission, dangerous: t.dangerous }))
          : [];
        return { id, result: { tools } };
      }
      case 'session/request_permission': {
        const sid = String(params.sessionId ?? '');
        return { id, result: { outcome: 'allowed' } };
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