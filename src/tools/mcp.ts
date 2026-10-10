import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition } from '../types.js';

// MCH-33/36: minimal MCP (Model Context Protocol) client — the ecosystem
// surface Claude Code and Codex have and Mochi lacked. Speaks JSON-RPC 2.0
// over TWO transports:
//   • stdio (default): spawn `command args…`, newline-delimited JSON-RPC.
//   • streamable HTTP: server config { "url": "https://…" } — POST JSON-RPC,
//     accept either a JSON body or an SSE stream (MCP 2025-03-26 spec).
// Each MCP tool is exposed to the model as a native Mochi tool named
// `mcp_<server>_<tool>` so routing, permissions, and loop guards apply
// unchanged. Server tools declared as read-only (annotations) get read
// permission so plan-mode vetoes never block them.

/** Map a JSON-Schema property to a Mochi ToolParameter type. */
function paramType(schemaType: string | undefined): 'string' | 'number' | 'boolean' | 'integer' | 'array' {
  switch (schemaType) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string'; // array/object: model passes JSON text; we pass through as string
  }
}

/** Wire-agnostic JSON-RPC channel: exactly one call in flight at a time per
 *  connection (MCP servers are cheap; parallelism comes from many tools). */
interface RpcChannel {
  call(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  close(): void;
}

// ─── stdio transport ──────────────────────────────────────────────────────

interface StdioState {
  proc: ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  buffer: string;
}

function stdioConnect(name: string, command: string, args: string[], env?: Record<string, string>): Promise<RpcChannel> {
  return new Promise((resolveConn, rejectConn) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (err) {
      rejectConn(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const state: StdioState = { proc, nextId: 0, pending: new Map(), buffer: '' };

    const failAll = (err: Error) => {
      for (const [, p] of state.pending) p.reject(err);
      state.pending.clear();
    };

    proc.on('error', (err) => { failAll(new Error(`mcp ${name}: ${err.message}`)); rejectConn(err); });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', () => { /* server logs ignored in minimal client */ });
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      state.buffer += chunk;
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, idx).trim();
        state.buffer = state.buffer.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === 'number' && state.pending.has(msg.id)) {
          const p = state.pending.get(msg.id)!;
          state.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`mcp ${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        }
      }
    });

    const channel: RpcChannel = {
      async call(method, params, timeoutMs = 15_000) {
        const id = ++state.nextId;
        return new Promise((resolveP, rejectP) => {
          const timer = setTimeout(() => {
            state.pending.delete(id);
            rejectP(new Error(`mcp ${name}: ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          state.pending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolveP(v); },
            reject: (e) => { clearTimeout(timer); rejectP(e); },
          });
          try {
            proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          } catch (err) {
            state.pending.delete(id);
            rejectP(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
      close() {
        failAll(new Error('mcp connection closed'));
        try { proc.kill(); } catch { /* already gone */ }
      },
    };

    // handshake with exit race
    const exited = new Promise<never>((_, rej) =>
      proc.once('exit', (code) => rej(new Error(`mcp ${name}: server exited (code ${code})`))));
    const init = channel.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mochi', version: '1.0.0' },
    }).then(() => channel.call('notifications/initialized', {}));
    Promise.race([init, exited]).then(() => resolveConn(channel), (err) => { try { proc.kill(); } catch { /* noop */ } rejectConn(err); });
  });
}

// ─── streamable HTTP transport (MCP 2025-03-26) ───────────────────────────

function httpChannel(name: string, url: string, headers?: Record<string, string>): RpcChannel {
  let nextId = 0;
  const post = async (body: unknown, timeoutMs: number): Promise<Response> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-03-26',
          ...(headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async call(method, params, timeoutMs = 20_000) {
      const id = ++nextId;
      const isNotification = params !== null && (method === 'notifications/initialized');
      const res = await post(
        isNotification ? { jsonrpc: '2.0', method, params: params ?? {} } : { jsonrpc: '2.0', id, method, params: params ?? {} },
        timeoutMs,
      );
      if (!res.ok) throw new Error(`mcp ${name}: ${method} HTTP ${res.status}`);
      const ctype = res.headers.get('content-type') ?? '';
      if (ctype.includes('text/event-stream')) {
        // SSE response: parse events for the matching result (and any
        // interleaved notifications we ignore).
        const text = await res.text();
        let result: any;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const msg = JSON.parse(payload);
            if (msg.id === id) {
              if (msg.error) throw new Error(`mcp ${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
              result = msg.result;
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith(`mcp ${name}:`)) throw err;
          }
        }
        if (result === undefined) throw new Error(`mcp ${name}: ${method} SSE stream carried no result`);
        return result;
      }
      const msg: any = await res.json();
      if (msg.error) throw new Error(`mcp ${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      return msg.result;
    },
    close() { /* stateless POSTs — nothing to tear down */ },
  };
}

// ─── shared tool wrapping ─────────────────────────────────────────────────

/** One connected server: channel + advertised tools. */
interface McpConnection {
  name: string;
  channel: RpcChannel;
  tools: Array<{ name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean } }>;
}

async function connectServer(name: string, cfg: { command?: string; args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string> }): Promise<McpConnection> {
  const channel = cfg.url
    ? httpChannel(name, cfg.url, cfg.headers)
    : await stdioConnect(name, String(cfg.command), cfg.args ?? [], cfg.env);
  const initRes = await channel.call('tools/list', {});
  return {
    name,
    channel,
    tools: Array.isArray(initRes?.tools) ? initRes.tools : [],
  };
}

/** Wrap one MCP tool as a native Mochi Tool. */
function wrapMcpTool(conn: McpConnection, t: { name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean } }): Tool {
  const mochiName = `mcp_${conn.name}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const schema = t.inputSchema ?? {};
  const props: Record<string, any> = schema.properties ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const readOnly = t.annotations?.readOnlyHint === true;
  const def: ToolDefinition = {
    name: mochiName,
    description: `[mcp:${conn.name}] ${t.description ?? t.name}`,
    parameters: Object.entries(props).map(([k, v]) => ({
      name: k,
      type: paramType((v as any).type),
      description: (v as any).description ?? '',
      required: required.includes(k),
    })),
    permission: readOnly ? 'read' : 'network',
  };
  return {
    def,
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
      const res = await conn.channel.call('tools/call', { name: t.name, arguments: args });
      if (res?.isError) {
        const errText = Array.isArray(res.content)
          ? res.content.map((c: any) => c.text ?? '').join('\n')
          : JSON.stringify(res);
        throw new Error(`mcp ${conn.name}.${t.name}: ${errText.slice(0, 400)}`);
      }
      if (Array.isArray(res?.content)) {
        return res.content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type} content]`)).join('\n').slice(0, 50_000);
      }
      return JSON.stringify(res ?? {}).slice(0, 50_000);
    },
  };
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** Collect MCP server configs from a config object. Shape:
 *  { "mcpServers": { "<name>": { "command": "…", "args": […] } | { "url": "https://…" } } }
 *  — the same convention Claude Code uses, plus HTTP via url. */
export function parseMcpServers(configJson: Record<string, unknown> | undefined): McpServerConfig[] {
  const servers = configJson?.mcpServers as Record<string, any> | undefined;
  if (!servers || typeof servers !== 'object') return [];
  const out: McpServerConfig[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (s && typeof s.command === 'string') {
      out.push({ name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env });
    } else if (s && typeof s.url === 'string') {
      out.push({ name, url: s.url, headers: s.headers });
    }
  }
  return out;
}

/**
 * Connect to every configured MCP server and return their tools wrapped as
 * native Mochi tools. A server that fails to start or handshake is skipped
 * with a warning — one broken server must never take down the run.
 */
export async function loadMcpTools(
  servers: McpServerConfig[],
  log?: (msg: string) => void,
): Promise<{ tools: Tool[]; connections: McpConnection[] }> {
  const tools: Tool[] = [];
  const connections: McpConnection[] = [];
  for (const s of servers) {
    try {
      const conn = await connectServer(s.name, s);
      connections.push(conn);
      for (const t of conn.tools) tools.push(wrapMcpTool(conn, t));
      const resTool = listServerResources(conn);
      if (resTool) tools.push(resTool);
      log?.(`[mcp] connected ${s.name}: ${conn.tools.length} tool(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`[mcp] server ${s.name} unavailable, skipping: ${msg.slice(0, 160)}`);
    }
  }
  return { tools, connections };
}

/** Close all MCP connections (best-effort, on agent finish). */
export function closeMcpConnections(connections: Array<{ channel: RpcChannel }>): void {
  for (const c of connections) {
    try { c.channel.close(); } catch { /* already gone */ }
  }
}

export { connectServer, wrapMcpTool, listServerResources };

/** MCH-36: resources/list passthrough — surface a server's exposed resources
 *  (files, data snapshots) as a text inventory the model can then read via
 *  the read_resource call. Wired as `mcp_<server>_list_resources`. */
function listServerResources(conn: McpConnection): Tool | null {
  const mochiName = `mcp_${conn.name}_list_resources`.replace(/[^a-zA-Z0-9_]/g, '_');
  return {
    def: {
      name: mochiName,
      description: `[mcp:${conn.name}] List resources exposed by this MCP server (files, data snapshots). Returns uri/name/mimeType per resource.`,
      parameters: [],
      permission: 'read',
    },
    async execute(_args, _ctx) {
      const res = await conn.channel.call('resources/list', {});
      const items = Array.isArray(res?.resources) ? res.resources : [];
      if (items.length === 0) return 'No resources exposed by this server.';
      return items.map((r: any) => `${r.uri}  ${r.name ?? ''}  ${r.mimeType ?? ''}`).join('\n').slice(0, 50_000);
    },
  };
}
