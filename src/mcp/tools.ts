import type { Tool } from '../tools/types.js';
import { McpClient, schemaToParameters, type McpServerConfig } from './index.js';

// Connect configured MCP servers and wrap their tools as native Mochi tools so
// the agent can call them exactly like read/write/etc. This is how cline/jcode/
// pi pull in external tool + memory servers. Servers are named by their config
// key; tools are registered under a namespaced name (`serverName__toolName`) so
// collisions across servers / native tools are avoided.

export interface McpToolMap {
  tools: Map<string, Tool>;
  close: () => void;
  errors: string[];
}

type McpServerSpec = Record<string, McpServerConfig>;

function normalizeServerConfig(servers: Record<string, Partial<McpServerConfig>>): McpServerSpec {
  const out: McpServerSpec = {};
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (cfg && typeof cfg === 'object' && typeof cfg.command === 'string') {
      out[name] = { command: cfg.command, args: cfg.args, env: cfg.env, version: cfg.version };
    }
  }
  return out;
}

export async function buildMcpTools(
  servers: Record<string, Partial<McpServerConfig>> | undefined,
  log = (m: string) => void 0,
): Promise<McpToolMap> {
  const tools = new Map<string, Tool>();
  const errors: string[] = [];
  const clients = new Map<string, McpClient>();
  if (!servers) return { tools, close: () => void 0, errors };

  const normalized = normalizeServerConfig(servers);
  for (const [name, cfg] of Object.entries(normalized)) {
    if (!cfg?.command) continue;
    const client = new McpClient(cfg, name);
    clients.set(name, client);
    try {
      const remoteTools = await client.listTools();
      for (const rt of remoteTools) {
        const fullName = `${name}__${rt.name}`;
        if (tools.has(fullName)) continue;
        tools.set(fullName, {
          def: {
            name: fullName,
            description: rt.description ?? `MCP tool ${fullName}`,
            parameters: schemaToParameters(rt.inputSchema),
            permission: 'network',
          },
          async execute(args, ctx) {
            const resultText = await client.callTool(rt.name, args as Record<string, unknown>);
            ctx.events.emit({ type: 'tool:completed', tool: fullName, result: { toolCallId: '', name: fullName, output: resultText, durationMs: 0 }, agentId: ctx.agentId });
            return resultText;
          },
        });
      }
      log(`[mcp] registered ${remoteTools.length} tool(s) from server '${name}'`);
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
  };
}