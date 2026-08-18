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
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Lowercase protocol version accepted; default "2024-11-05". */
  version?: string;
}

export interface McpToolInput {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private rl: ReadlineInterface;
  private requests = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private initialized = false;

  constructor(
    private config: McpServerConfig,
    private label: string = 'mcp',
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line: string) => this.handleLine(line));
    // Drain + surface server stderr without breaking the request/reply framing.
    this.child.stderr.on('data', (d: Buffer) => {
      const s = String(d).trim();
      if (s) console.warn(`[mcp:${this.label}] ${s.slice(0, 200)}`);
    });
    this.child.on('error', (err) => this.rejectAll(new Error(`mcp:${this.label} spawn failed: ${err.message}`)));
    // A server that starts and then dies (bad script, crash) never emits
    // 'error'; without this hook its pending requests would hang forever.
    this.child.on('exit', (code, signal) => {
      this.rejectAll(new Error(`mcp:${this.label} server exited (code=${code ?? 'null'} signal=${signal ?? 'none'}) before responding`));
    });
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
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.requests) p.reject(err);
    this.requests.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.requests.set(id, { resolve, reject });
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        this.child.stdin.write(body + '\n');
      } catch (err) {
        this.requests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      /* ignore notification failures after close */
    }
  }

  async initialize(): Promise<void> {
    // Server info + capabilities negotiation.
    await this.request('initialize', {
      protocolVersion: this.config.version ?? '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'mochi', version: '0.1' },
    });
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolInput[]> {
    if (!this.initialized) await this.initialize();
    const result = (await this.request('tools/list', {})) as { tools?: McpToolInput[] };
    return result?.tools ?? [];
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
    try {
      this.child.kill();
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