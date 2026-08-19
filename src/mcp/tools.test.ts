import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpTools } from './tools.js';
import type { EventBus } from '../events.js';

// Same minimal stdio MCP server used by the client tests: initialize,
// tools/list (one `uppercase` tool), tools/call. The integration test below
// exercises the full agent-side wiring: config -> spawned subprocess ->
// namespaced native tool -> real execute() round trip -> close() teardown.

const SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const RESOURCES = [
  { uri: 'mochi://guide', name: 'Guide', description: 'How to use this server', mimeType: 'text/plain' },
  { uri: 'mochi://notes', name: 'Notes', mimeType: 'text/plain' },
];
const PROMPTS = [
  { name: 'review', description: 'Review code for a language', arguments: [{ name: 'language', description: 'Programming language', required: true }] },
  { name: 'greet', description: 'Simple greeting prompt' },
];
rl.on('line', (line) => {
  if (!line.trim()) return;
  let body; try { body = JSON.parse(line); } catch { return; }
  if (body.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { protocolVersion:'2024-11-05', capabilities:{tools:{},resources:{},prompts:{}}, serverInfo:{name:'mini',version:'1'} } }) + '\\n');
  } else if (body.method === 'notifications/initialized') {
    return;
  } else if (body.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { tools: [{ name:'uppercase', description:'Uppercase a string', inputSchema:{ type:'object', properties:{ text:{ type:'string' } }, required:['text'] } }] } }) + '\\n');
  } else if (body.method === 'tools/call') {
    const args = body.params.arguments || {};
    const text = String(args.text || '').toUpperCase();
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result:{ content:[{type:'text', text}] } }) + '\\n');
  } else if (body.method === 'resources/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { resources: RESOURCES } }) + '\\n');
  } else if (body.method === 'resources/read') {
    const uri = body.params.uri || '';
    const found = RESOURCES.find((r) => r.uri === uri);
    const text = found ? \`Content of \${uri}: hello from the resource store\` : '';
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { contents: [{ uri, text }] } }) + '\\n');
  } else if (body.method === 'prompts/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { prompts: PROMPTS } }) + '\\n');
  } else if (body.method === 'prompts/get') {
    const name = body.params.name || '';
    const args = body.params.arguments || {};
    const text = name === 'review'
      ? \`Please review this \${args.language || 'code'} carefully.\`
      : name === 'greet' ? 'Hello from a prompt template!' : '';
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id: body.id, result: { messages: [{ role: 'user', content: { type: 'text', text } }] } }) + '\\n');
  }
});
setTimeout(() => {}, 30_000);
`;

function fakeCtx() {
  const emitted: unknown[] = [];
  const events = { emit: (e: unknown) => { emitted.push(e); } } as unknown as EventBus;
  return { emitted, events };
}

describe('buildMcpTools (real subprocess)', () => {
  let dir: string;
  let serverPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-mcp-tools-'));
    serverPath = join(dir, 'mcp-server.cjs');
    writeFileSync(serverPath, SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('wraps a remote tool as a namespaced native tool and executes it', async () => {
    const logs: string[] = [];
    const built = await buildMcpTools({ mini: { command: process.execPath, args: [serverPath] } }, (m) => logs.push(m));
    try {
      expect(built.errors).toEqual([]);
      expect(built.tools.size).toBe(5); // uppercase + resources list/read + prompts list/get
      const tool = built.tools.get('mini__uppercase');
      expect(tool).toBeDefined();
      expect(tool!.def.name).toBe('mini__uppercase');
      expect(tool!.def.description).toContain('Uppercase');
      expect(tool!.def.permission).toBe('network');
      expect(tool!.def.parameters.map((p) => p.name)).toEqual(['text']);

      const { events } = fakeCtx();
      const out = await tool!.execute({ text: 'hello mochi' }, {
        cwd: dir, workspace: {} as never, config: {} as never, events, agentId: 't',
      });
      expect(out).toBe('HELLO MOCHI');
      expect(logs.some((l) => l.includes('registered 1 tool'))).toBe(true);
    } finally {
      built.close();
    }
  });

  it('exposes resources as list + read tools', async () => {
    const built = await buildMcpTools({ mini: { command: process.execPath, args: [serverPath] } });
    try {
      expect(built.resourceCounts.mini).toBe(2);
      const listTool = built.tools.get('mini__resources_list');
      const readTool = built.tools.get('mini__resources_read');
      expect(listTool).toBeDefined();
      expect(readTool).toBeDefined();
      expect(listTool!.def.permission).toBe('read');
      expect(readTool!.def.permission).toBe('read');

      const { events } = fakeCtx();
      const ctxArgs = { cwd: dir, workspace: {} as never, config: {} as never, events, agentId: 't' };
      const listing = await listTool!.execute({}, ctxArgs);
      expect(listing).toContain('mochi://guide');
      expect(listing).toContain('Guide');
      expect(listing).toContain('mochi://notes');

      const content = await readTool!.execute({ uri: 'mochi://guide' }, ctxArgs);
      expect(content).toContain('hello from the resource store');

      await expect(readTool!.execute({ uri: '' }, ctxArgs)).rejects.toThrow('non-empty uri');
    } finally {
      built.close();
    }
  });

  it('exposes prompts as list + get tools', async () => {
    const built = await buildMcpTools({ mini: { command: process.execPath, args: [serverPath] } });
    try {
      expect(built.promptCounts.mini).toBe(2);
      const listTool = built.tools.get('mini__prompts_list');
      const getTool = built.tools.get('mini__prompts_get');
      expect(listTool).toBeDefined();
      expect(getTool).toBeDefined();
      expect(listTool!.def.permission).toBe('read');
      expect(getTool!.def.permission).toBe('read');

      const { events } = fakeCtx();
      const ctxArgs = { cwd: dir, workspace: {} as never, config: {} as never, events, agentId: 't' };
      const listing = await listTool!.execute({}, ctxArgs);
      expect(listing).toContain('review');
      expect(listing).toContain('language (required)');

      const rendered = await getTool!.execute({ name: 'review', args: '{"language":"TypeScript"}' }, ctxArgs);
      expect(rendered).toContain('Please review this TypeScript carefully.');
      expect(rendered).toContain('[user]');

      const plain = await getTool!.execute({ name: 'greet' }, ctxArgs);
      expect(plain).toContain('Hello from a prompt template!');

      await expect(getTool!.execute({ name: '' }, ctxArgs)).rejects.toThrow('non-empty prompt name');
      await expect(getTool!.execute({ name: 'review', args: 'not-json' }, ctxArgs)).rejects.toThrow('JSON object');
    } finally {
      built.close();
    }
  });

  it('collects connection failures without throwing', async () => {
    const built = await buildMcpTools({ broken: { command: process.execPath, args: [join(dir, 'does-not-exist.cjs')] } });
    try {
      expect(built.tools.size).toBe(0);
      expect(built.errors).toHaveLength(1);
      expect(built.errors[0]).toContain('broken');
    } finally {
      built.close();
    }
  });

  it('ignores entries without a command', async () => {
    const built = await buildMcpTools({ empty: {} as never });
    try {
      expect(built.tools.size).toBe(0);
      expect(built.errors).toEqual([]);
    } finally {
      built.close();
    }
  });
});
