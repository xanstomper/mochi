#!/usr/bin/env node
// DeepWiki MCP Server — standalone JSON-RPC 2.0 stdio MCP server.
// Exposes a single tool: wiki_lookup(query, lang?)
// Run via: node dist/mcp/deepwiki-server.js
// Or add to mochi config as an MCP server with command: "node" and args pointing to the compiled file.
//
// Test mode: set MOCHI_TEST_WIKI=mock to return a canned response (no real network).

import { createInterface } from 'node:readline';

const TOOL_SCHEMA = {
  name: 'wiki_lookup',
  description: 'Look up a topic on Wikipedia and return a concise summary (title + extract, up to 2000 chars).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term or Wikipedia article title' },
      lang: { type: 'string', description: 'Wikipedia language code (default: "en")' },
    },
    required: ['query'],
  },
};

async function wikiSummary(query: string, lang: string): Promise<string> {
  // Test mode: return canned response
  if (process.env.MOCHI_TEST_WIKI === 'mock') {
    return `**${query}** (mocked)\n\nThis is a mocked Wikipedia summary for testing purposes. Query: "${query}", lang: "${lang}".`;
  }
  const encoded = encodeURIComponent(query.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'mochi-deepwiki-mcp/1.0' },
  });
  if (res.ok) {
    const data = (await res.json()) as { title?: string; extract?: string };
    return `**${data.title ?? query}**\n\n${(data.extract ?? '').slice(0, 2000)}`;
  }
  // Search fallback
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
  const sr = await fetch(searchUrl, { headers: { 'User-Agent': 'mochi-deepwiki-mcp/1.0' } });
  if (!sr.ok) return `No result found for: ${query}`;
  const sd = (await sr.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
  const top = sd?.query?.search?.[0];
  if (!top) return `No result found for: ${query}`;
  const snippet = (top.snippet ?? '').replace(/<[^>]*>/g, '');
  return `**${top.title ?? query}** (search)\n\n${snippet}`;
}

function respond(id: number | string | null, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id: number | string | null, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const id = msg.id ?? null;
  const method = msg.method ?? '';
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const isNotification = msg.id === undefined;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'deepwiki-mcp', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      // Notification — no response
      break;

    case 'tools/list':
      respond(id, { tools: [TOOL_SCHEMA] });
      break;

    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      if (toolName !== 'wiki_lookup') {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        break;
      }
      const query = String(toolArgs.query ?? '').trim();
      if (!query) {
        respondError(id, -32602, 'query is required');
        break;
      }
      const lang = String(toolArgs.lang ?? 'en').replace(/[^a-z-]/gi, '') || 'en';
      try {
        const text = await wikiSummary(query, lang);
        respond(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        respond(id, {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
      break;
    }

    case 'shutdown':
      respond(id, null);
      process.exit(0);
      break;

    default:
      if (!isNotification) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
});

rl.on('close', () => process.exit(0));
