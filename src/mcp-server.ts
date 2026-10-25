// MCP (Model Context Protocol) server over stdio for editor ubiquity.
// VS Code (Copilot Chat MCP), Cursor, JetBrains, Neovim (via clients), Claude
// Desktop and any MCP client can spawn Mochi as a child and drive its agent
// runtime as MCP tools:
//
//   mochi_run    — run a goal to completion in the workspace cwd
//   mochi_plan   — ask for a plan without executing (plan mode)
//   mochi_status — list workspace sessions/goals
//
// Framing: MCP stdio transport = newline-delimited JSON-RPC 2.0 on
// stdin/stdout (same framing as our ACP server; MCP spec allows both
// Content-Length framing and line-delimited, all major clients accept line-
// delimited). The protocol core (handleMcp) is pure and unit-testable; the
// stdio loop is a thin adapter.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Runtime } from './runtime.js';
import { SessionStore } from './state/session-store.js';
import { loadAllSkills } from './skills/skills.js';
import { loadFacts } from './memory/memory-store.js';

export interface McpCall {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ServerState {
  cwd: string;
  runtime: Runtime | null;
}

/** P2 speed (streaming + progress): out-of-band progress notifications, in
 *  the protocol the server verifiably speaks — MCP 2024-11-05, utilities/
 *  progress: a client that passes params._meta.progressToken (string or
 *  integer, unique across active requests) MAY receive notifications/progress
 *  {progressToken, progress (MUST increase), total? (MAY be omitted when
 *  unknown)}. Requirements honored here: only active-request tokens are
 *  referenced; emissions are rate-limited; notifications stop when the tool
 *  call completes. No unverified protocol extension is used. */
export interface McpProgressNotify {
  (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number } }): void;
}

export interface McpHandleOpts {
  /** Out-of-band notifier (the stdio loop writes these frames to stdout). */
  notify?: McpProgressNotify;
  /** Minimum interval between progress emissions (rate limiting — spec
   *  SHOULD). Default 250ms. */
  progressIntervalMs?: number;
}

/** Subscribe to the runtime's event stream and emit rate-limited progress
 *  notifications for the duration of ONE tool call. Returns stop(). */
function trackProgress(
  rt: Runtime,
  progressToken: string | number,
  opts: McpHandleOpts,
): () => void {
  const notify = opts.notify;
  if (!notify) return () => {};
  const intervalMs = opts.progressIntervalMs ?? 250;
  let count = 0;
  let lastSentAt = 0;
  let lastSentProgress = -1;
  // progress MUST increase with each notification — the monotonic guard also
  // makes the final tick a no-op when the throttled loop already sent the
  // closing count.
  const emit = () => {
    if (count <= lastSentProgress) return;
    lastSentProgress = count;
    // No total: the goal engine cannot predict its own task count honestly.
    notify({ method: 'notifications/progress', params: { progressToken, progress: count } });
  };
  // Immediate first tick: the client learns the call is live at once.
  emit();
  const unsub = rt.events.onAll(() => {
    count++;
    const now = Date.now();
    if (now - lastSentAt < intervalMs) return;
    lastSentAt = now;
    emit();
  });
  return () => {
    unsub();
    // Final emission (if unseen progress remains), then stop (spec: progress
    // notifications MUST stop after completion).
    emit();
  };
}

/** Extract a progress token from a tools/call request's _meta. */
function progressTokenOf(call: McpCall): string | number | undefined {
  const meta = call.params?._meta as { progressToken?: unknown } | undefined;
  const t = meta?.progressToken;
  return (typeof t === 'string' || typeof t === 'number') ? t : undefined;
}

/** Track progress when THIS request carries a progress token; no-op otherwise
 *  (spec: notifications reference only tokens provided in an active request). */
function trackOnToken(rt: Runtime, call: McpCall, opts: McpHandleOpts): () => void {
  const token = progressTokenOf(call);
  if (token === undefined) return () => {};
  return trackProgress(rt, token, opts);
}



const TOOLS = [
  {
    name: 'mochi_run',
    description: 'Run Mochi agent on a goal in the current workspace and return the final result. Executes real tools (read/write files, shell, git) with the configured model provider.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The task for Mochi to execute' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'mochi_plan',
    description: 'Ask Mochi for a plan for the given task WITHOUT executing any changes (plan mode). Returns the decomposed task list.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to plan' },
      },
      required: ['task'],
    },
  },
  {
    name: 'mochi_status',
    description: 'List Mochi goals/sessions in the workspace with their status.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Agent-to-agent collaboration (MCH-A2A) ─────────────────────────────────
  // Let EXTERNAL agents (Hermes, Claude Code, Cursor, …) collaborate WITH
  // Mochi mid-run: delegate a scoped subtask, review work, steer the active
  // run, and read the fleet roster. Same tools Mochi's own subagent machinery
  // uses, exposed over MCP so any client is a peer.
  {
    name: 'mochi_delegate',
    description: 'Delegate a scoped subtask to a Mochi subagent (leaf worker). Returns the subagent result when it finishes. Use for parallel independent workstreams.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The subtask goal — self-contained, no conversation context' },
        context: { type: 'string', description: 'Background info: file paths, constraints, error messages' },
        cwd: { type: 'string', description: 'Working directory for the subagent (defaults to server cwd)' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'mochi_review',
    description: 'Ask Mochi to review a diff, file, or code snippet with the read-only Reviewer role. Returns structured findings ([SEVERITY] file:line message).',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Diff / crash log / code snippet to review (max 120k chars)' },
      },
      required: ['input'],
    },
  },
  {
    name: 'mochi_answer',
    description: 'Ask Mochi a quick question (read-only Q&A turn, no file changes). Cheapest collab verb — for facts, explanations, decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question' },
      },
      required: ['question'],
    },
  },
];

function getRuntime(state: ServerState): Runtime {
  if (!state.runtime) state.runtime = Runtime.create({ cwd: state.cwd });
  return state.runtime;
}

// ── Resources (MCP parity with tools: read-only workspace/session state) ────

const RESOURCES = [
  { uri: 'mochi://goals', name: 'Mochi goals', description: 'Persisted goals/sessions with status', mimeType: 'application/json' },
  { uri: 'mochi://sessions', name: 'Mochi sessions', description: 'Recent sessions (id, objective, updated)', mimeType: 'application/json' },
  { uri: 'mochi://skills', name: 'Mochi skills', description: 'Available skills (name + description)', mimeType: 'application/json' },
  { uri: 'mochi://memory', name: 'Mochi memory', description: 'Durable memory facts', mimeType: 'application/json' },
];

const RESOURCE_TEMPLATES = [
  { uriTemplate: 'mochi://goal/{id}', name: 'Mochi goal', description: 'A single persisted goal by id', mimeType: 'application/json' },
];

interface ResourceContent { uri: string; mimeType: string; text: string }

/** Resolve a resource URI to its contents, or null when unknown. */
function readResource(uri: string, state: ServerState): ResourceContent[] | null {
  const rt = getRuntime(state);
  if (uri === 'mochi://goals') {
    const files = rt.workspace.listGoals?.() ?? [];
    const goals = files.map((f) => {
      const id = f.endsWith('.json') ? f.slice(0, -'.json'.length) : f;
      const g = rt.workspace.loadGoal(id);
      return g ? { id: g.id, objective: g.objective, status: g.status } : { id };
    });
    return [{ uri, mimeType: 'application/json', text: JSON.stringify({ goals }, null, 2) }];
  }
  if (uri === 'mochi://sessions') {
    const store = new SessionStore(rt.cwd);
    try {
      const sessions = store.list(20).map((s) => ({ id: s.id, objective: s.objective, updated: s.updatedAt }));
      return [{ uri, mimeType: 'application/json', text: JSON.stringify({ sessions }, null, 2) }];
    } finally {
      // Windows locks an open SQLite file — release it before the dir can be removed.
      try { store.close(); } catch { /* best-effort */ }
    }
  }
  if (uri === 'mochi://skills') {
    const { skills } = loadAllSkills(rt.cwd);
    const list = skills.map((s) => ({ name: s.name, description: s.description }));
    return [{ uri, mimeType: 'application/json', text: JSON.stringify({ skills: list }, null, 2) }];
  }
  if (uri === 'mochi://memory') {
    const facts = loadFacts().map((f) => ({ statement: f.statement, category: f.category }));
    return [{ uri, mimeType: 'application/json', text: JSON.stringify({ facts }, null, 2) }];
  }
  const m = /^mochi:\/\/goal\/(.+)$/.exec(uri);
  if (m) {
    const g = rt.workspace.loadGoal(decodeURIComponent(m[1]));
    if (!g) return null;
    return [{ uri, mimeType: 'application/json', text: JSON.stringify(g, null, 2) }];
  }
  return null;
}

// ── Prompts (reusable Mochi workflows surfaced to MCP clients) ──────────────

const PROMPTS = [
  { name: 'fix-tests', description: 'Find and fix failing tests, verifying with the project test command.' },
  { name: 'review', description: 'Review the current uncommitted diff for correctness, security, and style.' },
  {
    name: 'implement', description: 'Implement a feature end-to-end and verify it.',
    arguments: [{ name: 'feature', description: 'What to build', required: true }],
  },
  {
    name: 'explain', description: 'Explain how a file or symbol works.',
    arguments: [{ name: 'target', description: 'File path or symbol to explain', required: true }],
  },
  {
    name: 'a2a-brief', description: 'Agent-to-agent collaboration: another AI agent hands Mochi a self-contained task brief.',
    arguments: [{ name: 'brief', description: 'The task brief from the external agent', required: true }],
  },
];

interface PromptResult { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> }

function buildPrompt(name: string, args: Record<string, unknown>): PromptResult | null {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const msg = (t: string): PromptResult['messages'] => [{ role: 'user', content: { type: 'text', text: t } }];
  switch (name) {
    case 'fix-tests':
      return { description: 'Fix failing tests', messages: msg('Find the failing tests in this workspace, fix them, and verify by running the project\'s test command. Do not silence tests by deleting them.') };
    case 'review':
      return { description: 'Review the working diff', messages: msg('Review the current uncommitted diff (git diff HEAD). Report correctness, security, and style issues with concrete file:line references and suggested fixes.') };
    case 'implement': {
      const feature = text(args.feature);
      if (!feature) return null;
      return { description: `Implement: ${feature}`, messages: msg(`Implement the following feature end-to-end and verify it with the project's own tests/build: ${feature}`) };
    }
    case 'explain': {
      const target = text(args.target);
      if (!target) return null;
      return { description: `Explain: ${target}`, messages: msg(`Explain how ${target} works: its role, key functions, and how it fits into the surrounding code.`) };
    }
    case 'a2a-brief': {
      // Agent-to-agent handoff prompt: an external agent briefing Mochi on a
      // collaborative task gets a self-contained working brief.
      const brief = text(args.brief);
      if (!brief) return null;
      return { description: 'Agent-to-agent collaboration brief', messages: msg(`Another AI agent is handing you a collaborative task. Treat this brief as authoritative — no other conversation context exists.\n\n${brief.slice(0, 40_000)}`) };
    }
    default:
      return null;
  }
}

/** Pure MCP protocol core. Unit-testable without spawning. */
export async function handleMcp(
  call: McpCall,
  state: ServerState,
  opts: McpHandleOpts = {},
): Promise<McpResponse> {
  const id = call.id ?? null;
  const method = String(call.method ?? '');
  try {
    switch (method) {
      case 'initialize':
        return {
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'mochi', version: '1.0.0' },
          },
        };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return { id: null, result: {} };
      case 'tools/list':
        return { id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = String(call.params?.name ?? '');
        const args = (call.params?.arguments ?? {}) as Record<string, unknown>;
        let text: string;
        if (name === 'mochi_run') {
          const goal = String(args.goal ?? '');
          if (!goal) return { id, error: { code: -32602, message: 'mochi_run requires a goal' } };
          const rt = getRuntime(state);
          const stopProgress = trackOnToken(rt, call, opts);
          const constraints = Array.isArray(args.constraints) ? args.constraints.map(String) : [];
          try {
            const out = await rt.goal(goal, constraints);
            text = typeof out === 'string' ? out : JSON.stringify(out ?? { done: true });
          } finally { stopProgress(); }
        } else if (name === 'mochi_plan') {
          const task = String(args.task ?? '');
          if (!task) return { id, error: { code: -32602, message: 'mochi_plan requires a task' } };
          const rt = getRuntime(state);
          const prevPlan = rt.config.planMode;
          rt.setPlanMode(true);
          try {
            const out = await rt.goal(task, ['plan only - do not execute changes']);
            text = typeof out === 'string' ? out : JSON.stringify(out ?? { planned: true });
          } finally { rt.setPlanMode(prevPlan); }
        } else if (name === 'mochi_status') {
          const rt = getRuntime(state);
          const goals = rt.workspace.listGoals ? rt.workspace.listGoals() : [];
          text = JSON.stringify(goals, null, 2);
        } else if (name === 'mochi_delegate') {
          const goal = String(args.goal ?? '');
          if (!goal) return { id, error: { code: -32602, message: 'mochi_delegate requires a goal' } };
          const ctx = typeof args.context === 'string' ? args.context : '';
          const subCwd = typeof args.cwd === 'string' && args.cwd ? resolve(args.cwd) : state.cwd;
          const rt = subCwd === state.cwd ? getRuntime(state) : Runtime.create({ cwd: subCwd });
          const stopProgress = trackOnToken(rt, call, opts);
          const prompt = ctx ? `${goal}\n\nCONTEXT:\n${ctx.slice(0, 8_000)}` : goal;
          try {
            const out = await rt.runPrompt(prompt);
            text = out;
          } finally { stopProgress(); }
        } else if (name === 'mochi_review') {
          const input = String(args.input ?? '');
          if (!input) return { id, error: { code: -32602, message: 'mochi_review requires input' } };
          const rt = getRuntime(state);
          text = await rt.review(input.slice(0, 120_000));
        } else if (name === 'mochi_answer') {
          const question = String(args.question ?? '');
          if (!question) return { id, error: { code: -32602, message: 'mochi_answer requires a question' } };
          const rt = getRuntime(state);
          const out = await rt.runPromptDetailed(question);
          text = out.summary;
        } else {
          return { id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        return { id, result: { content: [{ type: 'text', text: String(text).slice(0, 20_000) }] } };
      }
      case 'resources/list':
        return { id, result: { resources: RESOURCES } };
      case 'resources/templates/list':
        return { id, result: { resourceTemplates: RESOURCE_TEMPLATES } };
      case 'resources/read': {
        const uri = String(call.params?.uri ?? '');
        const contents = readResource(uri, state);
        if (!contents) return { id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
        return { id, result: { contents } };
      }
      case 'prompts/list':
        return { id, result: { prompts: PROMPTS } };
      case 'prompts/get': {
        const name = String(call.params?.name ?? '');
        const args = (call.params?.arguments ?? {}) as Record<string, unknown>;
        const prompt = buildPrompt(name, args);
        if (!prompt) return { id, error: { code: -32602, message: `Unknown or incomplete prompt: ${name}` } };
        return { id, result: prompt };
      }
      case 'ping':
        return { id, result: {} };
      case 'shutdown':
        // Acknowledge BEFORE the stdio loop exits, otherwise the client sees a
        // spurious "Method not found: shutdown" frame on every graceful close.
        return { id, result: {} };
      default:
        return { id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (e) {
    return { id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
  }
}

/** stdio loop adapter. */
export async function mcpServerLoop(cwd: string): Promise<void> {
  const state: ServerState = { cwd: resolve(cwd), runtime: null };
  const rl = createInterface({ input: process.stdin });
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  // Out-of-band progress notifications (MCP 2024-11-05 utilities/progress):
  // only written when the REQUEST carried _meta.progressToken — trackOnToken
  // never invents one.
  const notify: McpProgressNotify = (n) => write({ jsonrpc: '2.0', ...n });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let call: McpCall;
    try { call = JSON.parse(trimmed); } catch { continue; }
    const res = await handleMcp(call, state, { notify });
    if (call.method === 'notifications/initialized' || call.method === 'notifications/cancelled') continue;
    write(call.id === undefined ? { jsonrpc: '2.0', method: 'rpc', params: res } : { jsonrpc: '2.0', id: res.id, ...(res.error ? { error: res.error } : { result: res.result }) });
    if (call.method === 'shutdown') process.exit(0);
  }
}
