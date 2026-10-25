import type { Tool } from '../tools/types.js';
import type { ToolDefinition } from '../types.js';
import { McpClient, schemaToParameters, type McpServerConfig } from './index.js';

// Connect configured MCP servers and wrap their tools as native Mochi tools so
// the agent can call them exactly like read/write/etc. This is how cline/jcode/
// pi pull in external tool + memory servers. Servers are named by their config
// key; tools are registered under a namespaced name (`serverName__toolName`) so
// collisions across servers / native tools are avoided.
//
// Lazy tool-schema loading (W3-3): with `lazySchemas: true` a tool is
// registered with a THIN def (name + description, NO input schema) — tool
// definitions are the context bill, and every connected server's schemas
// otherwise ride every prompt. The full schema is injected on demand:
//   - `load_tools` with the tool's namespaced name (the existing deferred-tool
//     machinery in tools/index.ts), or
//   - the run start wiring in agent/loop.ts when the task text names the tool.
// `inflateMcpToolSchemas` performs the swap on a live tool map; it is
// idempotent and never throws. Thin tools stay CALLABLE either way (execute
// forwards args to tools/call verbatim) — laziness shrinks schemas, not
// capability.

export interface McpToolMap {
  tools: Map<string, Tool>;
  close: () => void;
  errors: string[];
  /** Number of resources discovered per server (resources are optional). */
  resourceCounts: Record<string, number>;
  promptCounts: Record<string, number>;
  /** True when tools were registered with thin (lazy) defs. */
  lazySchemas: boolean;
}

type McpServerSpec = Record<string, McpServerConfig>;

function normalizeServerConfig(servers: Record<string, Partial<McpServerConfig>>): McpServerSpec {
  const out: McpServerSpec = {};
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (typeof cfg.command === 'string') {
      out[name] = { command: cfg.command, args: cfg.args, env: cfg.env, version: cfg.version, reconnect: cfg.reconnect };
    } else if (typeof cfg.url === 'string') {
      out[name] = { url: cfg.url, headers: cfg.headers, version: cfg.version };
    }
  }
  return out;
}

/** Whether lazy MCP tool-schema loading is enabled: config knob OR env
 *  MOCHI_MCP_LAZY_SCHEMAS=1 (env wins, mirroring MOCHI_TOOLS). Default OFF. */
export function mcpLazySchemasEnabled(config?: { mcpLazySchemas?: boolean } | null): boolean {
  const env = (process.env.MOCHI_MCP_LAZY_SCHEMAS ?? '').toLowerCase();
  if (env === '1' || env === 'true') return true;
  return config?.mcpLazySchemas === true;
}

/** Full definition of a lazily-registered MCP tool, keyed by the Tool object
 *  (Tool objects move between maps by reference — the loop merges them into
 *  its live toolset — so object identity is the stable key). */
const mcpFullDefs = new WeakMap<Tool, ToolDefinition>();

/** Swap lazy (thin) MCP tool defs back to their full schemas on a live tool
 *  map. `names` selects which tools to inflate (omit = inflate every lazy
 *  tool). Idempotent: already-inflated tools are skipped. Returns the names
 *  that were inflated. Never throws. */
export function inflateMcpToolSchemas(tools: Map<string, Tool>, names?: Iterable<string>): string[] {
  const wanted = names === undefined ? null : new Set(names);
  const inflated: string[] = [];
  for (const tool of tools.values()) {
    const full = mcpFullDefs.get(tool);
    if (!full || tool.def === full) continue; // not lazy, or already inflated
    if (wanted && !wanted.has(tool.def.name)) continue;
    tool.def = full;
    inflated.push(full.name);
  }
  return inflated;
}

export async function buildMcpTools(
  servers: Record<string, Partial<McpServerConfig>> | undefined,
  log = (_m: string) => void 0,
  opts: { lazySchemas?: boolean } = {},
): Promise<McpToolMap> {
  const lazySchemas = opts.lazySchemas === true;
  const tools = new Map<string, Tool>();
  const errors: string[] = [];
  const resourceCounts: Record<string, number> = {};
  const promptCounts: Record<string, number> = {};
  const clients = new Map<string, McpClient>();
  if (!servers) return { tools, close: () => void 0, errors, resourceCounts, promptCounts, lazySchemas };

  const normalized = normalizeServerConfig(servers);
  for (const [name, cfg] of Object.entries(normalized)) {
    if (!cfg?.command && !cfg?.url) continue;
    const client = McpClient.forConfig(cfg, name);
    clients.set(name, client);
    try {
      const remoteTools = await client.listTools();
      for (const rt of remoteTools) {
        const fullName = `${name}__${rt.name}`;
        if (tools.has(fullName)) continue;
        const fullDef: ToolDefinition = {
          name: fullName,
          description: rt.description ?? `MCP tool ${fullName}`,
          parameters: schemaToParameters(rt.inputSchema),
          permission: 'network',
        };
        // Lazy mode: advertise the thin def (description carries the restore
        // path), keep the full one for inflateMcpToolSchemas.
        const def = lazySchemas
          ? {
              ...fullDef,
              description: `${fullDef.description} (input schema not loaded to save context — call load_tools with ["${fullName}"] to expose its parameters)`,
              parameters: [],
            }
          : fullDef;
        const tool: Tool = {
          def,
          async execute(args, ctx) {
            try {
              const resultText = await client.callTool(rt.name, args as Record<string, unknown>);
              ctx.events.emit({ type: 'tool:completed', tool: fullName, result: { toolCallId: '', name: fullName, output: resultText, durationMs: 0 }, agentId: ctx.agentId });
              return resultText;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              const failText = `MCP tool ${fullName} failed: ${errMsg}`;
              ctx.events.emit({ type: 'tool:completed', tool: fullName, result: { toolCallId: '', name: fullName, output: failText, durationMs: 0, error: errMsg }, agentId: ctx.agentId });
              return failText;
            }
          },
        };
        if (lazySchemas) mcpFullDefs.set(tool, fullDef);
        tools.set(fullName, tool);
      }
      log(`[mcp] registered ${remoteTools.length} tool(s) from server '${name}'${lazySchemas ? ' (lazy schemas)' : ''}`);

      // Resources (optional MCP capability): expose list + read as native
      // tools so the model can pull server-provided context on demand. A
      // server that doesn't implement resources yields zero entries.
      try {
        const resources = await client.listResources();
        resourceCounts[name] = resources.length;
        if (resources.length > 0) {
          const listName = `${name}__resources_list`;
          if (!tools.has(listName)) {
            tools.set(listName, {
              def: {
                name: listName,
                description: `List resources exposed by the '${name}' MCP server (URIs, names, descriptions).`,
                parameters: [],
                permission: 'read',
              },
              async execute() {
                const rs = await client.listResources();
                return rs.map((r) => `- ${r.uri}${r.name ? ` (${r.name})` : ''}${r.description ? ` — ${r.description}` : ''}`).join('\n') || 'No resources.';
              },
            });
          }
          const readName = `${name}__resources_read`;
          if (!tools.has(readName)) {
            tools.set(readName, {
              def: {
                name: readName,
                description: `Read one resource from the '${name}' MCP server by its URI (use ${listName} to discover URIs).`,
                parameters: [{ name: 'uri', type: 'string', description: 'Resource URI to read', required: true }],
                permission: 'read',
              },
              async execute(args) {
                const uri = String(args.uri ?? '').trim();
                if (!uri) throw new Error('A non-empty uri is required');
                return (await client.readResource(uri)) || '(empty resource)';
              },
            });
          }
          log(`[mcp] registered ${resources.length} resource(s) from server '${name}' (list + read tools)`);
        }
      } catch (resErr) {
        // Resources are optional; a server rejecting resources/* is normal.
        resourceCounts[name] = 0;
        log(`[mcp] server '${name}' exposes no resources (${resErr instanceof Error ? resErr.message : String(resErr)})`);
      }

      // Prompts (optional MCP capability): expose list + get as native tools.
      // A rendered prompt returns structured messages the model can use
      // directly (role + text). A server without prompts yields zero entries.
      try {
        const prompts = await client.listPrompts();
        promptCounts[name] = prompts.length;
        if (prompts.length > 0) {
          const listName = `${name}__prompts_list`;
          if (!tools.has(listName)) {
            tools.set(listName, {
              def: {
                name: listName,
                description: `List prompt templates exposed by the '${name}' MCP server (names, descriptions, arguments).`,
                parameters: [],
                permission: 'read',
              },
              async execute() {
                const ps = await client.listPrompts();
                return ps.map((p) => {
                  const argList = (p.arguments ?? []).map((a) => `${a.name}${a.required ? ' (required)' : ''}`).join(', ');
                  return `- ${p.name}${argList ? ` [args: ${argList}]` : ''}${p.description ? ` — ${p.description}` : ''}`;
                }).join('\n') || 'No prompts.';
              },
            });
          }
          const getName = `${name}__prompts_get`;
          if (!tools.has(getName)) {
            tools.set(getName, {
              def: {
                name: getName,
                description: `Render one prompt from the '${name}' MCP server by name (use ${listName} to discover names and arguments). Pass arguments as a JSON object string.`,
                parameters: [
                  { name: 'name', type: 'string', description: 'Prompt name', required: true },
                  { name: 'args', type: 'string', description: 'JSON object of prompt arguments, e.g. "{\"topic\":\"testing\"}"', required: false },
                ],
                permission: 'read',
              },
              async execute(args) {
                const pname = String(args.name ?? '').trim();
                if (!pname) throw new Error('A non-empty prompt name is required');
                let parsed: Record<string, string> = {};
                const raw = String(args.args ?? '').trim();
                if (raw) {
                  try {
                    parsed = JSON.parse(raw);
                  } catch {
                    throw new Error('args must be a JSON object string, e.g. "{\"topic\":\"testing\"}"');
                  }
                }
                const msgs = await client.getPrompt(pname, parsed);
                const rendered = msgs.map((m) => `[${m.role ?? 'user'}] ${m.content?.text ?? ''}`.trim()).filter(Boolean).join('\n');
                return rendered || '(empty prompt)';
              },
            });
          }
          log(`[mcp] registered ${prompts.length} prompt(s) from server '${name}' (list + get tools)`);
        }
      } catch (promptErr) {
        // Prompts are optional; a server rejecting prompts/* is normal.
        promptCounts[name] = 0;
        log(`[mcp] server '${name}' exposes no prompts (${promptErr instanceof Error ? promptErr.message : String(promptErr)})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`MCP server '${name}' failed: ${msg}`);
      log(`[mcp] server '${name}' error: ${msg}`);
      client.close();
      clients.delete(name);
    }
  }

  return {
    tools,
    close: () => {
      for (const c of clients.values()) c.close();
      clients.clear();
    },
    errors,
    resourceCounts,
    promptCounts,
    lazySchemas,
  };
}