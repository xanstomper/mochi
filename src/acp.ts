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

export const ACP_PROTOCOL_VERSION = 1;

// Baked-in default overridden by the package.json version at runtime (matching
// the CLI); the baked constant keeps the compiled binary versioned correctly.
let ACP_AGENT_VERSION = '0.32.0';
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

/** Host hooks for the RPC core. `clientRequest` lets the agent send a request
 *  TO the client and await its answer (used for real permission gating and
 *  elicitation). `state` carries per-connection state the initialize handler
 *  fills in (the client's advertised capabilities) so later calls can gate
 *  client-dependent behaviour. When absent (headless/tests), the agent runs
 *  under mochi's own policy and never contacts the client. */
export interface AcpRpcOptions {
  clientRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  state?: AcpConnectionState;
}

/** The client capabilities ACP v1 lets us act on. Everything defaults to
 *  false ("unsupported") when initialize arrives without capabilities. */
export interface AcpClientCapabilities {
  /** clientCapabilities.elicitation.form — agent may send elicitation/create
   *  (form mode) and the client will render it to the user. */
  elicitationForm: boolean;
  fsReadTextFile: boolean;
  fsWriteTextFile: boolean;
  terminal: boolean;
  /** Verbatim capability object, for diagnostics and future gates. */
  raw: Record<string, unknown>;
}

export interface AcpConnectionState {
  clientCapabilities: AcpClientCapabilities;
}

function truthy(v: unknown): boolean {
  return v === true || (v !== null && typeof v === 'object');
}

/** Parse the initialize params' clientCapabilities into the gates we use.
 *  Lenient by design: an absent/unknown shape means "unsupported defaults". */
export function parseClientCapabilities(raw: unknown): AcpClientCapabilities {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fs = (r.fs !== null && typeof r.fs === 'object' ? r.fs : {}) as Record<string, unknown>;
  const el = (r.elicitation !== null && typeof r.elicitation === 'object' ? r.elicitation : {}) as Record<string, unknown>;
  return {
    elicitationForm: truthy(r.elicitation) && truthy(el.form),
    fsReadTextFile: fs.readTextFile === true,
    fsWriteTextFile: fs.writeTextFile === true,
    terminal: r.terminal === true,
    raw: r,
  };
}

/** Bridge one ask_question round to the client via elicitation/create (form
 *  mode). Accept → the answered labels (or free text); decline/cancel → a
 *  skipped answer; client error → skipped (fail-closed, never hang). */
async function elicitAnswer(
  clientRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
  q: import('./tools/user-prompt.js').UserPromptQuestion,
): Promise<import('./tools/user-prompt.js').UserPromptAnswer> {
  const base = { question: q.question, header: q.header };
  try {
    const res = await clientRequest('elicitation/create', {
      sessionId,
      mode: 'form',
      message: q.question,
      fields: [{
        type: 'option',
        name: q.header || 'answer',
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
        multiSelect: q.multiSelect === true,
      }],
    });
    const r = (res !== null && typeof res === 'object' ? res : {}) as Record<string, unknown>;
    const action = typeof r.action === 'string' ? r.action : 'cancel';
    if (action !== 'accept') return { ...base, selected: [], skipped: true };
    const labels = q.options.map((o) => o.label);
    const picked: string[] = [];
    let freeText: string | undefined;
    const take = (v: unknown) => {
      const s = String(v ?? '').trim();
      if (!s) return;
      if (labels.includes(s)) picked.push(s);
      else freeText = s;
    };
    if (Array.isArray(r.content)) r.content.forEach(take);
    else take(r.content);
    return { ...base, selected: picked, freeText };
  } catch {
    return { ...base, selected: [], skipped: true };
  }
}

/** PromptUserFn over the ACP client: each question becomes one
 *  elicitation/create (form mode) round-trip. Installed on the session
 *  runtime only when the client advertised elicitation.form. */
export function elicitationPromptUser(
  clientRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
): import('./tools/user-prompt.js').PromptUserFn {
  return async (req) => {
    const answers = [];
    for (const q of req.questions) {
      answers.push(await elicitAnswer(clientRequest, sessionId, q));
    }
    return { answers };
  };
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
  opts: AcpRpcOptions = {},
): Promise<RpcResponse> {
  const id = call.id ?? null;
  const method = call.method ?? '';
  const params = call.params ?? {};
  try {
    switch (method) {
      case 'initialize':
        // Record what the client can do; later calls gate on it (parse is
        // lenient — omitted/unknown shapes store "unsupported" defaults).
        // v1-clean negotiation: whatever version the client asks for, we
        // answer with OUR protocol version (ACP v2 is DRAFT and is neither
        // implemented nor advertised).
        if (opts.state) opts.state.clientCapabilities = parseClientCapabilities(params.clientCapabilities);
        return {
          id,
          result: {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {}, resume: {}, close: {} },
              promptCapabilities: { image: false, audio: false, embeddedContext: true },
              // mcpCapabilities deliberately omitted: params.mcpServers is
              // not wired yet, and we advertise only what works.
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
          ? params.additionalDirectories.map((d: unknown) => resolve(String(d)))
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
            // Key by tool name: tool:completed carries no args to correlate
            // with (the old args-keyed map never matched its tool-keyed
            // lookups, so every update fell back to the bare tool name).
            emitToolCallIds.set(e.tool, tcId);
            onNotify(sid, { sessionUpdate: 'tool_call', toolCallId: tcId, title: e.tool, kind: toolKind(e.tool), status: 'pending', rawInput: e.args });
          } else if (e.type === 'tool:completed') {
            const tcId = emitToolCallIds.get(e.tool) ?? e.tool;
            onNotify(sid, { sessionUpdate: 'tool_call_update', toolCallId: tcId, status: 'completed', content: [{ type: 'text', text: String(e.result?.output ?? '').slice(0, 4000) }] });
          } else if (e.type === 'tool:failed') {
            const tcId = emitToolCallIds.get(e.tool) ?? e.tool;
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
        // Real permission gate: when the client can answer permission requests,
        // route mochi's approval prompts (shell / non-idempotent writes under a
        // stricter policy) to the editor instead of silently running them. The
        // loop calls this only for tools its policy does not auto-allow.
        let setGate = false;
        if (opts.clientRequest) {
          const requestPermission = opts.clientRequest;
          session.runtime.setApprovalHandler(async (req) => {
            try {
              const res = await requestPermission('session/request_permission', {
                sessionId: sid,
                toolCall: {
                  toolCallId: `perm_${randomUUID().slice(0, 8)}`,
                  title: req.summary,
                  kind: toolKind(req.tool),
                  rawInput: { tool: req.tool, risk: req.risk },
                },
                options: [
                  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
                  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
                ],
              });
              const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
              const nested = r.outcome && typeof r.outcome === 'object' ? (r.outcome as Record<string, unknown>) : undefined;
              const optionId = typeof r.optionId === 'string'
                ? (r.optionId as string)
                : typeof nested?.optionId === 'string'
                  ? (nested.optionId as string)
                  : '';
              if (optionId === 'allow_once') return 'allow-once';
              if (optionId === 'allow_always') return 'allow-always';
              return 'deny';
            } catch {
              return 'deny'; // no answer / broken client → fail closed, never hang
            }
          });
          setGate = true;
        }
        // Elicitation bridge (ACP v1): when the client advertises
        // elicitation.form, route the agent's ask_question prompts to the
        // editor as elicitation/create (form mode) instead of falling back
        // to headless defaults. Without the capability nothing is sent —
        // the run stays headless-deterministic.
        let setPromptUser = false;
        if (opts.clientRequest && opts.state?.clientCapabilities.elicitationForm) {
          session.runtime.setPromptUser(elicitationPromptUser(opts.clientRequest, sid));
          setPromptUser = true;
        }
        let stopReason = 'end_turn';
        try {
          if (session.loadedGoal) {
            // Resume a loaded goal (session/load): reuse its persisted task
            // decomposition so the work continues, not restarts.
            const goal = session.runtime.workspace.loadGoal(session.loadedGoal.goalId);
            const tasks = session.runtime.workspace.loadTasks(session.loadedGoal.goalId);
            if (goal && tasks.length > 0) {
              await session.runtime.ensureGoals();
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
        } finally {
          off();
          if (setGate) session.runtime.setApprovalHandler(undefined);
          if (setPromptUser) session.runtime.setPromptUser(undefined);
        }
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
        // additionalDirectories is supported on all session-setup requests
        // (new/load/resume); v1 spec carries absolute paths — resolve() keeps
        // us honest if a client sends a relative one.
        if (Array.isArray(params.additionalDirectories)) {
          session.additionalDirectories = params.additionalDirectories.map((d: unknown) => resolve(String(d)));
        }
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
        // First page also surfaces persisted goals (session/load-able) so a
        // client can discover prior work that has no live in-memory session.
        // Opt-in: keep the default session list to live sessions only.
        if (!rawCursor && params.includePersisted === true) {
          const seen = new Set(sessionInfos.map((i) => i.sessionId));
          for (const se of sessions.values()) {
            try {
              for (const file of se.runtime.workspace.listGoals?.() ?? []) {
                // listGoals yields file names ("<id>.json"); the goal id is bare.
                const gid = file.endsWith('.json') ? file.slice(0, -'.json'.length) : file;
                if (seen.has(gid) || sessionInfos.length >= limit) continue;
                const g = se.runtime.workspace.loadGoal(gid);
                if (!g) continue;
                seen.add(gid);
                sessionInfos.push({ sessionId: gid, cwd: se.cwd, title: g.objective, updatedAt: Date.now(), persisted: true });
              }
            } catch { /* best-effort */ }
          }
        }
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
        const additionalDirectories = Array.isArray(params.additionalDirectories)
          ? params.additionalDirectories.map((d: unknown) => resolve(String(d)))
          : undefined;
        if (sessions.has(sid)) {
          // Resume of a live session also refreshes its extra workspace roots.
          if (additionalDirectories) sessions.get(sid)!.additionalDirectories = additionalDirectories;
          return { id, result: {} };
        }
        const runtime = Runtime.create({ cwd: sessionCwd });
        const session: AcpSession = { id: sid, cwd: sessionCwd, runtime, additionalDirectories };
        // Reconnect to a persisted goal (not a blank runtime): the next
        // session/prompt then continues the goal's task decomposition instead
        // of silently restarting from scratch, which is what resume means.
        const goalId = typeof params.goalId === 'string' ? params.goalId : '';
        if (goalId) {
          const goal = runtime.workspace.loadGoal(goalId);
          if (goal) { session.loadedGoal = { goalId: goal.id, objective: goal.objective }; session.goalId = goal.id; }
        }
        sessions.set(sid, session);
        return { id, result: {} };
      }
      case 'session/close': {
        const sid = String(params.sessionId ?? '');
        const closed = sessions.get(sid);
        sessions.delete(sid);
        // Release the session's SQLite handles — on Windows an open
        // sessions.sqlite keeps the workspace directory locked forever.
        try { closed?.runtime.close(); } catch { /* best-effort */ }
        return { id, result: {} };
      }
      case 'session/set_mode': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        const modeId = typeof params.modeId === 'string' ? params.modeId : 'act';
        session.runtime.setPlanMode(modeId === 'plan');
        onNotify(sid, { sessionUpdate: 'current_mode_update', currentModeId: modeId });
        return { id, result: { modeId } };
      }
      case 'session/set_config_option': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        const configId = String(params.configId ?? '');
        const value = params.value;
        if (configId === 'plan_mode') {
          session.runtime.setPlanMode(Boolean(value));
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
        return { id, result: { outcome: 'allowed' } };
      }
      case 'authenticate': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        // We only support the built-in 'agent' auth method which requires no action
        const methodId = String(params.methodId ?? 'agent');
        if (methodId !== 'agent') {
          return { id, error: { code: -32602, message: `Unknown auth method: ${methodId}` } };
        }
        return { id, result: {} };
      }
      case 'logout': {
        const sid = String(params.sessionId ?? '');
        const session = sessions.get(sid);
        if (!session) return { id, error: { code: -32602, message: `Unknown session ${sid}` } };
        // No-op for built-in auth; just acknowledge
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
  // Per-connection state: initialize records the client's advertised
  // capabilities here; session/prompt gates elicitation on it.
  const state: AcpConnectionState = { clientCapabilities: parseClientCapabilities(undefined) };
  // Per-session prompt queue: ACP clients (VS Code, JetBrains) send
  // session/prompt while a previous prompt is still streaming. Overlapping
  // Runtime.goals runs on one session corrupt abort state + transcript, so
  // prompts for the SAME session serialize; different sessions run in parallel.
  const promptChains = new Map<string, Promise<unknown>>();
  const rl = createInterface({ input: process.stdin, terminal: false });
  const send = (msg: unknown) => {
    try {
      const ok = process.stdout.write(JSON.stringify(msg) + '\n');
      if (!ok) process.stdout.once('drain', () => {});
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (code === 'EPIPE' || code === 'EIO') process.exit(0);
      throw err;
    }
  };

  // Server→client requests (session/request_permission): send with an id and
  // resolve when the client's matching response line arrives. Without this the
  // agent had no way to ask the editor for permission.
  const pendingClient = new Map<string | number, { resolve: (v: unknown) => void }>();
  let clientReqSeq = 0;
  const clientRequest = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const rid = `srv-${++clientReqSeq}`;
    return new Promise((resolve) => {
      pendingClient.set(rid, { resolve });
      send({ jsonrpc: '2.0', id: rid, method, params });
    });
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcCall;
    try {
      msg = JSON.parse(trimmed);
    } catch { return; }
    if (!msg.method) {
      // A response to one of OUR requests (id present, no method).
      const entry = pendingClient.get(msg.id as string | number);
      if (entry) {
        pendingClient.delete(msg.id as string | number);
        const m = msg as unknown as { result?: unknown; error?: unknown };
        entry.resolve(m.result ?? m.error);
      }
      return;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    // session/cancel is spec'd as a notification (no id). Some clients send
    // it as a request; handle both, but never reply to a notification.
    if (msg.method === 'session/prompt' && typeof msg.params?.sessionId === 'string') {
      const sid = String(msg.params.sessionId);
      const prev = promptChains.get(sid) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(async () => {
        const res = await handleRpc(msg, sessions, cwd, (sessionId, update) => {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
        }, { clientRequest, state });
        if (!isNotification) send({ jsonrpc: '2.0', ...res });
        if (msg.method === 'shutdown') process.exit(0);
      });
      promptChains.set(sid, run);
      void run.catch(() => {}).finally(() => {
        if (promptChains.get(sid) === run) promptChains.delete(sid);
      });
      return;
    }
    void (async () => {
      const res = await handleRpc(msg, sessions, cwd, (sessionId, update) => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
      }, { clientRequest, state });
      if (!isNotification) send({ jsonrpc: '2.0', ...res });
      if (msg.method === 'shutdown') process.exit(0);
    })();
  });
  await new Promise<void>((res) => rl.on('close', () => res()));
}

/** Lightweight health probe for `mochi acp --check` / `mochi doctor`:
 *  spawns the ACP server in-process (no child), runs initialize + session/new
 *  + session/close, and returns a human-readable report. Pure logic, no I/O
 *  beyond the Runtime it constructs (which touches .mochi state). */
export async function acpCheck(cwd: string): Promise<{ ok: boolean; report: string }> {
  const sessions = new Map<string, AcpSession>();
  try {
    const hello = await handleRpc({ id: 1, method: 'initialize', params: {} }, sessions, cwd);
    const res = hello.result as { protocolVersion?: number; implementation?: { version?: string } } | undefined;
    if (!res || res.protocolVersion !== ACP_PROTOCOL_VERSION) {
      return { ok: false, report: `ACP initialize returned unexpected protocol version (want ${ACP_PROTOCOL_VERSION})` };
    }
    const created = await handleRpc({ id: 2, method: 'session/new', params: { cwd } }, sessions, cwd);
    const sid = (created.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sid) return { ok: false, report: 'ACP session/new did not return a sessionId' };
    await handleRpc({ id: 3, method: 'session/close', params: { sessionId: sid } }, sessions, cwd);
    return { ok: true, report: `ACP ok (protocol v${ACP_PROTOCOL_VERSION}, agent v${res.implementation?.version ?? 'unknown'}, session lifecycle verified)` };
  } catch (e) {
    return { ok: false, report: `ACP check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Note: the CLI dispatcher (`mochi acp`) is the sole entry point — no
 *  module-level auto-start here, or importing this module would spawn a
 *  competing server on the same stdin/stdout. */