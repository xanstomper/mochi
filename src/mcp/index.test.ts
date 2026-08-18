import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient, schemaToParameters, type McpServerConfig } from './index.js';

// Minimal MCP stdio server that supports initialize, tools/list and tools/call
// for one tool `echo`. Written to a temp file and spawned with the current
// node, so the test exercises the real subprocess transport.
const SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let initialized = false;
rl.on('line', (line) => {
  if (!line.trim()) return;
  let body; try { body = JSON.parse(line); } catch { return; }
  if (body.method === 'initialize') {
    initialized = true;
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'mini',version:'1'} } }) + '\\n');
  } else if (body.method === 'notifications/initialized') {
    return; // no reply
  } else if (body.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { tools: [{ name:'uppercase', description:'Uppercase a string', inputSchema:{ type:'object', properties:{ text:{ type:'string' } }, required:['text'] } }] } }) + '\\n');
  } else if (body.method === 'tools/call') {
    const args = body.params.arguments || {};
    const text = String(args.text || '').toUpperCase();
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result:{ content:[{type:'text', text}] } }) + '\\n');
  }
});
setTimeout(() => {}, 30_000);
`;

describe('McpClient (stdio, real subprocess)', () => {
  let dir: string;
  let serverPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-mcp-'));
    serverPath = join(dir, 'mcp-server.cjs');
    writeFileSync(serverPath, SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('handshakes, lists tools, and calls a tool', async () => {
    const cfg: McpServerConfig = { command: process.execPath, args: [serverPath] };
    const client = new McpClient(cfg, 'mini');
    try {
      await client.initialize();
      const tools = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('uppercase');

      const out = await client.callTool('uppercase', { text: 'hello world' });
      expect(out).toBe('HELLO WORLD');
    } finally {
      client.close();
    }
  });

  it('maps an MCP input schema to Mochi parameters', () => {
    const params = schemaToParameters({
      type: 'object',
      properties: { text: { type: 'string' }, count: { type: 'integer' } },
      required: ['text'],
    });
    expect(params).toHaveLength(2);
    expect(params[0].name).toBe('text');
    expect(params[0].required).toBe(true);
    expect(params[1].type).toBe('integer');
  });
});