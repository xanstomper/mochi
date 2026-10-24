import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

// Minimal Model Context Protocol (MCP) stdio client. MCP is the standard cline
// / jcode / pi use to connect external tool + memory servers. A server is a
// spawned subprocess speaking JSON-RPC 2.0 over newline-delimited JSON on
// stdin/stdout. This client:
//   - runs `initialize` + `notifications/initialized` handshake
//   - lists tools via `tools/list`
//   - invokes tools via `tools/call`, returning their text content
//   - never parses provider/model data; it's pure transport
// It intentionally has no server binary; tests use a tiny node server written
// inline so the whole flow is verified without any external dependency.

export interface McpServerConfig {
  /** Subprocess to spawn for stdio transport. Required unless `url` is set. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Lowercase protocol version accepted; default "2024-11-05". */
  version?: string;
  /** Streamable-HTTP endpoint. When set, the client uses HTTP POST (with SSE
   *  response parsing) instead of spawning a stdio subprocess. */
  url?: string;
  /** Extra headers for HTTP transport (e.g. Authorization). */
  headers?: Record<string, string>;
  /** OAuth client configuration for HTTP servers needing bearer tokens. */
  oauth?: import('./oauth.js').McpOAuthConfig;
  /** Reconnect policy for the stdio transport when the server process dies
   *  mid-connection. Default: 3 attempts with exponential backoff (250ms
   *  initial, 4s cap). `false` disables reconnecting. HTTP transports are
   *  stateless (per-request failures) and never reconnect. */
  reconnect?: { attempts?: number; initialDelayMs?: number; maxDelayMs?: number } | false;
}

export interface McpToolInput {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpResourceInput {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInput {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpPromptMessage {
  role?: string;
  content?: { type?: string; text?: string };
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Cache metadata a server may attach to a list response (2026-07-28
 *  cacheable-list revision; honored here as an additive field regardless of
 *  the negotiated revision, so servers that provide it benefit early).
 *  `cacheScope` semantics implemented by McpClient:
 *   - 'connection' (default): the cache lives on this client instance and
 *     dies with the connection (close, reconnect).
 *   - 'process': the cache is keyed by server identity and shared across
 *     every client this process opens to the same server — reconnects and
 *     new connections within ttlMs skip the tools/list round trip. Servers
 *     that serve per-auth tool lists must not send 'process'. */
export interface McpListCacheMeta {
  ttlMs?: number;
  cacheScope?: 'connection' | 'process';
}

/** Transport seam: newline-delimited JSON-RPC frames out, parsed lines back.
 *  stdio (subprocess) and Streamable-HTTP share the exact framing contract,
 *  so McpClient never knows which one it talks to. */
export interface McpTransport {
  /** Send one JSON-RPC frame (request with id, or id-less notification). */
  send(frame: string): void;
  onMessage(cb: (line: string) => void): void;
  onFatal(cb: (err: Error) => void): void;
  close(): void;
}

/** Subprocess transport: `command args…` speaking JSON-RPC over stdio. */
export class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams;
  private rl: ReadlineInterface;
  private msgCb: (line: string) => void = () => {};
  private fatalCb: (err: Error) => void = () => {};
  private readonly label: string;

  constructor(config: McpServerConfig, label = 'mcp') {
    if (!config.command) {
      throw new Error(`mcp:${label} stdio transport needs config.command (or use url for HTTP)`);
    }
    this.label = label;
    this.child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line: string) => this.msgCb(line));
    // Drain server stderr without polluting the terminal/UI.
    this.child.stderr.on('data', () => {});
    this.child.on('error', (err) => this.fatalCb(new Error(`mcp:${label} spawn failed: ${err.message}`)));
    // A server that starts and then dies (bad script, crash) never emits
    // 'error'; without this hook its pending requests would hang forever.
    this.child.on('exit', (code, signal) => {
      this.fatalCb(new Error(`mcp:${label} server exited (code=${code ?? 'null'} signal=${signal ?? 'none'}) before responding`));
    });
  }

  send(frame: string): void {
    // Health check: a dead server must fail its callers FAST, not after the
    // 10s request timeout — write() into a dead child's stdin buffers
    // silently and the request would hang until the timeout. exitCode is
    // set on normal/exit-event reaping, signalCode on signal kills; either
    // means the server is gone.
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error(`mcp:${this.label} server is not running (already exited)`);
    }
    this.child.stdin.write(frame + '\n');
  }

  onMessage(cb: (line: string) => void): void {
    this.msgCb = cb;
  }

  onFatal(cb: (err: Error) => void): void {
    this.fatalCb = cb;
  }

  close(): void {
    try {
      this.child.kill();
    } catch {
      /* already closed */
    }
  }
}

/** Streamable-HTTP transport: stateless JSON-RPC POSTs (mirrors the proven
 *  httpChannel semantics in tools/mcp.ts: plain-JSON or SSE responses,
 *  per-request timeouts, best-effort notifications). */
export class HttpTransport implements McpTransport {
  private msgCb: (line: string) => void = () => {};
  private closed = false;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
    private label: string = 'mcp',
    private getAuthHeaders?: () => Promise<Record<string, string>>,
  ) {}

  send(frame: string): void {
    if (this.closed) throw new Error(`mcp:${this.label} transport is closed`);
    let body: { jsonrpc: string; id?: number; method?: string; params?: unknown };
    try {
      body = JSON.parse(frame);
    } catch {
      return; // malformed frame: never send garbage at a server
    }
    const isNotification = body.id === undefined;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    void (async () => {
      const auth = this.getAuthHeaders ? await this.getAuthHeaders().catch(() => ({} as Record<string, string>)) : {};
      await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
          ...this.headers,
          ...auth,
        },
        body: frame,
        signal: ctl.signal,
      }).then(async (res) => {
      clearTimeout(timer);
      if (!res.ok) {
        if (!isNotification) this.msgCb(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `HTTP ${res.status}` } }));
        return;
      }
      const ctype = res.headers.get('content-type') ?? '';
      if (ctype.includes('text/event-stream')) {
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const msg = JSON.parse(payload) as { id?: number };
            if (isNotification || msg.id === body.id) this.msgCb(JSON.stringify(msg));
          } catch { /* skip undecodable events */ }
        }
        return;
      }
      const msg = (await res.json()) as { id?: number };
      if (isNotification || msg.id === body.id) this.msgCb(JSON.stringify(msg));
    }).catch((err) => {
      clearTimeout(timer);
      if (isNotification) return; // notifications are best-effort by contract
      // Stateless transport: a failed POST poisons only its own request, so
      // answer it as a JSON-RPC error frame (never fatalCb — there is no
      // persistent connection whose death should fail every pending call).
      const message = err instanceof Error && err.name === 'AbortError'
        ? 'HTTP request timed out after 15s'
        : err instanceof Error ? err.message : String(err);
      this.msgCb(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } }));
    });
    })();
  }

  onMessage(cb: (line: string) => void): void {
    this.msgCb = cb;
  }

  onFatal(_cb: (err: Error) => void): void {
    // Stateless POSTs have no persistent connection to die; every failure
    // answers its own request as a JSON-RPC error frame (see send/catch).
  }

  close(): void {
    this.closed = true;
  }
}

/** Connection state, for health surfaces (TUI, doctor). */
export type McpConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed';

interface ToolsCacheEntry {
  tools: McpToolInput[];
  expiresAt: number;
}

/** cacheScope 'process' cache: keyed by server identity, shared across every
 *  McpClient this process opens to the same server. Entries are removed on
 *  notifications/tools/list_changed and expire by ttlMs. */
const processToolsCache = new Map<string, ToolsCacheEntry>();

/** Stable-ish server identity for the process cache: label + transport
 *  endpoint + negotiated version. `env` is deliberately excluded (it can
 *  carry secrets; it also rarely changes a tool list). */
function serverIdentityKey(label: string, config: McpServerConfig): string {
  const endpoint = config.url
    ? `url=${config.url}`
    : `cmd=${config.command ?? ''} args=${JSON.stringify(config.args ?? [])}`;
  return `${label}::${endpoint}::v=${config.version ?? '2024-11-05'}`;
}

/** Extract cache hints from a list result: top-level `ttlMs`/`cacheScope`
 *  (2026-07-28 shape) or the same fields under `_meta` (older _meta
 *  convention). Unknown scopes degrade to 'connection'. */
function parseListCacheMeta(result: unknown): McpListCacheMeta {
  const r = result as { ttlMs?: unknown; cacheScope?: unknown; _meta?: { ttlMs?: unknown; cacheScope?: unknown } } | null | undefined;
  if (!r || typeof r !== 'object') return {};
  const ttl = typeof r.ttlMs === 'number' ? r.ttlMs : typeof r._meta?.ttlMs === 'number' ? r._meta.ttlMs : undefined;
  const rawScope = r.cacheScope ?? r._meta?.cacheScope;
  const scope = rawScope === 'process' ? 'process' : 'connection';
  const meta: McpListCacheMeta = {};
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) meta.ttlMs = ttl;
  if (rawScope === 'process' || rawScope === 'connection') meta.cacheScope = scope;
  return meta;
}

export class McpClient {
  private transport: McpTransport;
  private requests = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private initialized = false;
  private label: string;
  private version: string;
  private config: McpServerConfig;
  /** True when WE spawned the transport from config (stdio) — only then can
   *  a respawn reconnect. Injected/HTTP transports never reconnect. */
  private readonly ownsStdio: boolean;
  private reconnectPolicy: { attempts: number; initialDelayMs: number; maxDelayMs: number } | null;
  private state_: McpConnectionState = 'connecting';
  private reconnectCycle: Promise<void> | null = null;
  private reconnectFailures = 0;
  private lastFatal: Error | null = null;
  /** Guard so the reconnect cycle's own initialize() does not await the
   *  cycle it is running (request() awaits the cycle otherwise). */
  private internalReconnecting = false;
  // tools/list cache (connection-scope) + invalidation listeners.
  private toolsCache: ToolsCacheEntry | null = null;
  private readonly identityKey: string;
  private toolsListChangedCbs = new Set<() => void>();

  constructor(
    config: McpServerConfig,
    label: string = 'mcp',
    transport?: McpTransport,
  ) {
    this.label = label;
    this.config = config;
    this.version = config.version ?? '2024-11-05';
    this.identityKey = serverIdentityKey(label, config);
    const policy = config.reconnect === false
      ? null
      : {
          attempts: Math.max(0, Math.floor(config.reconnect?.attempts ?? 3)),
          initialDelayMs: Math.max(0, config.reconnect?.initialDelayMs ?? 250),
          maxDelayMs: Math.max(0, config.reconnect?.maxDelayMs ?? 4_000),
        };
    if (transport) {
      this.transport = transport;
      this.ownsStdio = false;
    } else {
      this.transport = new StdioTransport(config, label);
      this.ownsStdio = true;
    }
    this.reconnectPolicy = policy;
    this.transport.onMessage((line) => this.handleLine(line));
    this.transport.onFatal((err) => this.onFatal(err));
  }

  /** Build a client for either transport: `url` selects Streamable-HTTP,
   *  otherwise a stdio subprocess is spawned. */
  static forConfig(config: McpServerConfig, label: string = 'mcp'): McpClient {
    if (config.url) return new McpClient(config, label, new HttpTransport(config.url, config.headers ?? {}, label));
    return new McpClient(config, label);
  }

  /** Connection health (TUI/doctor surfaces + tests). */
  get state(): McpConnectionState {
    return this.state_;
  }

  /** Register a callback fired when the server reports its tool list changed
   *  (notifications/tools/list_changed). Returns an unsubscribe function. */
  onToolsListChanged(cb: () => void): () => void {
    this.toolsListChangedCbs.add(cb);
    return () => this.toolsListChangedCbs.delete(cb);
  }

  private attachTransport(t: McpTransport): void {
    t.onMessage((line) => this.handleLine(line));
    t.onFatal((err) => this.onFatal(err));
  }

  private onFatal(err: Error): void {
    this.lastFatal = err;
    this.rejectAll(err);
    if (this.state_ === 'closed') return;
    this.startReconnectCycle();
  }

  private startReconnectCycle(): void {
    if (this.state_ === 'closed') return;
    if (!this.reconnectPolicy || !this.ownsStdio) {
      // No reconnecting (disabled, or a transport we did not spawn): the
      // connection is dead and stays dead — reflect that in the state.
      this.state_ = 'failed';
      return;
    }
    if (this.reconnectCycle) return; // a cycle is already running
    if (this.reconnectFailures >= this.reconnectPolicy.attempts) {
      this.state_ = 'failed';
      return;
    }
    this.state_ = 'reconnecting';
    this.reconnectCycle = this.runReconnectCycle().then((ok) => {
      this.reconnectCycle = null;
      if (this.state_ === 'closed') return;
      if (ok) {
        this.reconnectFailures = 0;
        this.state_ = 'ready';
      } else {
        this.state_ = 'failed';
      }
    });
  }

  private async runReconnectCycle(): Promise<boolean> {
    const policy = this.reconnectPolicy!;
    let ok = false;
    for (let attempt = this.reconnectFailures; attempt < policy.attempts && !ok; attempt++) {
      const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** this.reconnectFailures);
      await new Promise((r) => setTimeout(r, delay));
      if (this.state_ === 'closed') return false;
      this.reconnectFailures += 1;
      try {
        this.transport.close(); // the dead transport (best-effort)
        this.transport = new StdioTransport(this.config, this.label);
        this.attachTransport(this.transport);
        this.initialized = false;
        this.internalReconnecting = true;
        try {
          await this.initialize();
        } finally {
          this.internalReconnecting = false;
        }
        ok = true;
      } catch { /* respawn/initialize failed — back off and retry */ }
    }
    return ok;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore malformed frames
    }
    if (typeof msg.id === 'number') {
      const pending = this.requests.get(msg.id);
      if (!pending) return;
      this.requests.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    // Server-initiated notification (no id). The one the client MUST honor:
    // notifications/tools/list_changed invalidates cached tools/list results.
    if (typeof msg.method === 'string') this.handleNotification(msg.method);
  }

  private handleNotification(method: string): void {
    if (method !== 'notifications/tools/list_changed') return;
    this.toolsCache = null;
    processToolsCache.delete(this.identityKey);
    for (const cb of this.toolsListChangedCbs) {
      try { cb(); } catch { /* listener failures never break the client */ }
    }
  }

  /** Drop any cached tools/list results (connection + process scope). */
  invalidateToolsCache(): void {
    this.toolsCache = null;
    processToolsCache.delete(this.identityKey);
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.requests) p.reject(err);
    this.requests.clear();
  }

  /** Wait for a running reconnect cycle, bounded: a caller must not hang on
   *  a cycle that keeps failing (the cycle itself retries with backoff). */
  private async awaitReconnectCycle(): Promise<void> {
    if (!this.reconnectCycle) return;
    const cap = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`mcp:${this.label} reconnect still in progress after 15s`)), 15_000);
      (t as unknown as { unref?: () => void }).unref?.();
    });
    await Promise.race([this.reconnectCycle, cap]);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    // Requests issued while a reconnect cycle runs wait for it to settle
    // (ready → proceed on the fresh transport; failed → clear fast error).
    if (this.state_ === 'reconnecting' && this.reconnectCycle && !this.internalReconnecting) {
      await this.awaitReconnectCycle();
      const st = this.state_ as McpConnectionState; // state changes across the await
      if (st === 'closed') throw new Error(`mcp:${this.label} closed while reconnecting`);
      if (st === 'failed') throw new Error(`mcp:${this.label} reconnect failed: ${this.lastFatal?.message ?? 'server unreachable'}`);
    } else if (this.state_ === 'failed' && this.reconnectPolicy && this.ownsStdio && !this.internalReconnecting) {
      // Exhausted earlier: budget ONE fresh cycle per request so a server
      // that came back (or was restarted) heals without a client rebuild.
      this.reconnectFailures = 0;
      this.startReconnectCycle();
      await this.awaitReconnectCycle();
      if ((this.state_ as McpConnectionState) !== 'ready') {
        throw new Error(`mcp:${this.label} reconnect failed: ${this.lastFatal?.message ?? 'server unreachable'}`);
      }
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // A server that silently ignores a method (not an error response — just
      // no response at all) must not hang the caller forever. Optional
      // capabilities (resources/prompts) are probed, so servers implementing
      // only tools may hit this; the caller treats it as "absent".
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`mcp:${this.label}: '${method}' timed out after 10s (server may not implement it)`));
      }, 10_000);
      this.requests.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        this.transport.send(body);
      } catch (err) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch {
      /* ignore notification failures after close */
    }
  }

  async initialize(): Promise<void> {
    // Server info + capabilities negotiation.
    await this.request('initialize', {
      protocolVersion: this.version,
      capabilities: { tools: {} },
      clientInfo: { name: 'mochi', version: '0.1' },
    });
    this.notify('notifications/initialized', {});
    this.initialized = true;
    if (this.state_ !== 'closed') this.state_ = 'ready';
  }

  async listTools(): Promise<McpToolInput[]> {
    // Cacheable list responses: when the server provides ttlMs/cacheScope we
    // serve the cached list until expiry (process scope is shared across
    // clients of the same server), and drop it on list_changed notifications.
    const cached = this.toolsCache ?? processToolsCache.get(this.identityKey);
    if (cached && cached.expiresAt > Date.now()) return cached.tools;
    if (!this.initialized) await this.initialize();
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolInput[];
      ttlMs?: unknown;
      cacheScope?: unknown;
      _meta?: { ttlMs?: unknown; cacheScope?: unknown };
    };
    const tools = result?.tools ?? [];
    const meta = parseListCacheMeta(result);
    if (meta.ttlMs) {
      const entry: ToolsCacheEntry = { tools, expiresAt: Date.now() + meta.ttlMs };
      if (meta.cacheScope === 'process') processToolsCache.set(this.identityKey, entry);
      else this.toolsCache = entry;
    }
    return tools;
  }

  /** List resources the server exposes (optional capability). Servers that do
   *  not implement resources return an error, which we surface as an empty
   *  list so callers can treat it as "nothing to read". */
  async listResources(): Promise<McpResourceInput[]> {
    if (!this.initialized) await this.initialize();
    const result = (await this.request('resources/list', {})) as { resources?: McpResourceInput[] };
    return result?.resources ?? [];
  }

  /** Read a resource by URI; returns the concatenated text content. */
  async readResource(uri: string): Promise<string> {
    if (!this.initialized) await this.initialize();
    const result = (await this.request('resources/read', { uri })) as {
      contents?: { uri?: string; text?: string }[];
    };
    const parts = (result?.contents ?? []).map((c) => c?.text ?? '').filter(Boolean);
    return parts.join('\n');
  }

  /** List prompts the server exposes (optional capability). Servers that do
   *  not implement prompts return an error, which we surface as an empty
   *  list so callers can treat it as "no prompts". */
  async listPrompts(): Promise<McpPromptInput[]> {
    if (!this.initialized) await this.initialize();
    const result = (await this.request('prompts/list', {})) as { prompts?: McpPromptInput[] };
    return result?.prompts ?? [];
  }

  /** Get a prompt by name; returns its rendered messages. */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptMessage[]> {
    if (!this.initialized) await this.initialize();
    const result = (await this.request('prompts/get', { name, arguments: args })) as {
      messages?: McpPromptMessage[];
    };
    return result?.messages ?? [];
  }

  /** Call a tool; returns the concatenated text content of the result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.initialize();
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const parts = (result?.content ?? []).map((c) => c?.text ?? '').filter(Boolean);
    const text = parts.join('\n');
    if (result?.isError) throw new Error(text || `MCP tool ${name} returned an error`);
    return text;
  }

  close(): void {
    // Mark closed BEFORE killing the transport: the child 'exit' event fires
    // into onFatal, which must release pending requests but never schedule a
    // reconnect for an intentionally closed client.
    this.state_ = 'closed';
    this.toolsCache = null; // connection-scope cache dies with the connection
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
  }
}

// Helper: turn an MCP input schema into Mochi's ToolParameter list.
export function schemaToParameters(schema?: McpToolInput['inputSchema']): import('../types.js').ToolParameter[] {
  const props = (schema?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set(schema?.required ?? []);
  const out: import('../types.js').ToolParameter[] = [];
  for (const [name, p] of Object.entries(props)) {
    out.push({
      name,
      type: (['string', 'number', 'integer', 'boolean', 'array'].includes(p?.type ?? '') ? p.type : 'string') as import('../types.js').ToolParameter['type'],
      description: p?.description ?? '',
      required: required.has(name),
    });
  }
  return out;
}