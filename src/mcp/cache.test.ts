import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient, type McpServerConfig } from './index.js';

// W3-3 tools/list caching: the fixture server stamps every tools/list result
// with ttlMs/cacheScope (from env, so each test tunes its own) and NAMES the
// tool after the request count (`probe_<count>`). The count lives in a FILE
// shared by every server instance of a test (each McpClient spawns its own
// server process — a per-process counter would reset per connection and make
// "fresh request" indistinguishable from "cache hit"). `tools/call` with name
// "mark_changed" makes the server emit notifications/tools/list_changed.
const SERVER = `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const TTL = Number(process.env.FIXTURE_TTL_MS || 0);
const SCOPE = process.env.FIXTURE_SCOPE || 'connection';
const countFile = process.env.FIXTURE_COUNT_FILE || '';
let count = 0;
const nextCount = () => {
  if (!countFile) return ++count;
  const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').trim() : '0') + 1;
  fs.writeFileSync(countFile, String(n));
  return n;
};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  let body; try { body = JSON.parse(line); } catch { return; }
  if (body.method === 'initialize') {
    send({ jsonrpc:'2.0', id: body.id, result: { protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'cache-fixture',version:'1'} } });
  } else if (body.method === 'notifications/initialized') {
    // no reply
  } else if (body.method === 'tools/list') {
    const n = nextCount();
    send({ jsonrpc:'2.0', id: body.id, result: { tools: [{ name: 'probe_' + n, description: 'probe', inputSchema: { type: 'object', properties: {} } }], ttlMs: TTL, cacheScope: SCOPE } });
  } else if (body.method === 'tools/call') {
    if ((body.params || {}).name === 'mark_changed') {
      send({ jsonrpc:'2.0', method:'notifications/tools/list_changed', params: {} });
    }
    send({ jsonrpc:'2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  }
});
setTimeout(() => {}, 60_000);
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fixtureConfig(dir: string, label: string, env: Record<string, string>): McpServerConfig {
  return {
    command: process.execPath,
    args: [join(dir, 'cache-server.cjs')],
    env: { ...env, FIXTURE_COUNT_FILE: join(dir, `count-${label}.json`) },
  };
}

describe('McpClient tools/list cache (fixture server)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-mcp-cache-'));
    writeFileSync(join(dir, 'cache-server.cjs'), SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a second listTools from the cache while ttlMs is live (no second round trip)', async () => {
    const client = new McpClient(fixtureConfig(dir, 'ttl-live', { FIXTURE_TTL_MS: '300', FIXTURE_SCOPE: 'connection' }), 'ttl-live');
    try {
      const first = await client.listTools();
      const second = await client.listTools();
      expect(first.map((t) => t.name)).toEqual(['probe_1']);
      expect(second.map((t) => t.name)).toEqual(['probe_1']); // cache hit: still count 1
      expect(client.state).toBe('ready');
    } finally {
      client.close();
    }
  });

  it('refetches once ttlMs has expired', async () => {
    const client = new McpClient(fixtureConfig(dir, 'ttl-expire', { FIXTURE_TTL_MS: '120', FIXTURE_SCOPE: 'connection' }), 'ttl-expire');
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual(['probe_1']);
      await sleep(300);
      expect((await client.listTools()).map((t) => t.name)).toEqual(['probe_2']); // expired → fresh request
    } finally {
      client.close();
    }
  });

  it('does not cache when the server provides no ttlMs', async () => {
    const client = new McpClient(fixtureConfig(dir, 'no-ttl', { FIXTURE_TTL_MS: '0', FIXTURE_SCOPE: 'connection' }), 'no-ttl');
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual(['probe_1']);
      expect((await client.listTools()).map((t) => t.name)).toEqual(['probe_2']); // every call is a round trip
    } finally {
      client.close();
    }
  });

  it('invalidates the cache on notifications/tools/list_changed even within ttl', async () => {
    const client = new McpClient(fixtureConfig(dir, 'list-changed', { FIXTURE_TTL_MS: '60000', FIXTURE_SCOPE: 'connection' }), 'list-changed');
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual(['probe_1']);
      let changed = 0;
      client.onToolsListChanged(() => { changed += 1; });
      await client.callTool('mark_changed', {});
      await sleep(50); // let the notification frame land
      expect(changed).toBe(1);
      expect((await client.listTools()).map((t) => t.name)).toEqual(['probe_2']); // invalidated → fresh request
    } finally {
      client.close();
    }
  });

  it('cacheScope=process shares the cache across clients of the same server', async () => {
    const cfg = fixtureConfig(dir, 'proc-scope', { FIXTURE_TTL_MS: '60000', FIXTURE_SCOPE: 'process' });
    const a = new McpClient(cfg, 'proc-scope');
    expect((await a.listTools()).map((t) => t.name)).toEqual(['probe_1']);
    a.close();
    // A NEW connection to the same server within ttl reuses the process cache.
    const b = new McpClient(cfg, 'proc-scope');
    try {
      expect((await b.listTools()).map((t) => t.name)).toEqual(['probe_1']); // no fresh round trip
      // The count file proves the server NEVER saw a second tools/list.
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(join(dir, 'count-proc-scope.json'), 'utf8').trim()).toBe('1');
    } finally {
      b.close();
    }
  });

  it('a list_changed notification on one connection also drops the process-scope cache', async () => {
    const cfg = fixtureConfig(dir, 'proc-inval', { FIXTURE_TTL_MS: '60000', FIXTURE_SCOPE: 'process' });
    const a = new McpClient(cfg, 'proc-inval');
    expect((await a.listTools()).map((t) => t.name)).toEqual(['probe_1']);
    await a.callTool('mark_changed', {});
    await sleep(50);
    const b = new McpClient(cfg, 'proc-inval');
    try {
      expect((await b.listTools()).map((t) => t.name)).toEqual(['probe_2']); // process cache invalidated
    } finally {
      b.close();
      a.close();
    }
  });
});

describe('McpListCacheMeta parsing', () => {
  // parseListCacheMeta is not exported; verify through a client against an
  // HTTP mock that puts the hints in different legal places.
  it('honors hints nested under result._meta as well as top-level', async () => {
    const http = await import('node:http');
    let calls = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method?: string };
        const reply = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') {
          reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'meta-http', version: '1' } });
        } else if (msg.method === 'tools/list') {
          calls += 1;
          reply({ tools: [{ name: 't', description: 'd' }], _meta: { ttlMs: 60_000, cacheScope: 'connection' } });
        } else {
          reply({});
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const client = McpClient.forConfig({ url: `http://127.0.0.1:${addr.port}/mcp` }, 'meta-http');
    try {
      await client.listTools();
      await client.listTools();
      expect(calls).toBe(1); // cached via _meta
    } finally {
      client.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
