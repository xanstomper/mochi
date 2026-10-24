import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient, type McpServerConfig } from './index.js';

// W3-3 connection health/reconnect with backoff: the fixture server counts
// its own boots into a marker file (passed via env BOOT_MARKER) and can be
// told to die after a tool call ("die") or immediately on boot when the boot
// count has not yet reached BOOT_OK (simulating a server that keeps crashing
// until its Nth start).

const SERVER = `
const fs = require('node:fs');
const marker = process.env.BOOT_MARKER || '';
if (marker) fs.appendFileSync(marker, 'boot\\n');
const boots = marker && fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\\n').length : 1;
const bootOkAfter = Number(process.env.BOOT_OK_AFTER || '0');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (bootOkAfter > 0 && boots < bootOkAfter) {
  // Keep crashing until the boot count reaches BOOT_OK_AFTER.
  setTimeout(() => process.exit(1), 5);
} else {
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let body; try { body = JSON.parse(line); } catch { return; }
    if (body.method === 'initialize') {
      send({ jsonrpc:'2.0', id: body.id, result: { protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'reconnect-fixture',version:'1'} } });
    } else if (body.method === 'notifications/initialized') {
      // no reply
    } else if (body.method === 'tools/list') {
      send({ jsonrpc:'2.0', id: body.id, result: { tools: [{ name:'uppercase', description:'Uppercase a string', inputSchema:{ type:'object', properties:{ text:{ type:'string' } }, required:['text'] } }] } });
    } else if (body.method === 'tools/call') {
      const name = (body.params || {}).name || '';
      if (name === 'die') {
        send({ jsonrpc:'2.0', id: body.id, result: { content: [{ type: 'text', text: 'die ok' }] } });
        setTimeout(() => process.exit(0), 10);
      } else {
        const text = String(((body.params || {}).arguments || {}).text || '');
        send({ jsonrpc:'2.0', id: body.id, result: { content: [{ type:'text', text: text.toUpperCase() }] } });
      }
    }
  });
}
setTimeout(() => {}, 60_000);
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('McpClient reconnect with backoff (fixture server)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-mcp-reconnect-'));
    writeFileSync(join(dir, 'reconnect-server.cjs'), SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function config(extra: Record<string, string> = {}, reconnect: McpServerConfig['reconnect'] = undefined): McpServerConfig {
    return {
      command: process.execPath,
      args: [join(dir, 'reconnect-server.cjs')],
      env: { BOOT_MARKER: join(dir, 'boots.log'), ...extra },
      reconnect,
    };
  }

  function bootCount(): number {
    const p = join(dir, 'boots.log');
    return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  }

  it('transparently respawns a dead server on the next request (default policy)', async () => {
    const marker = join(dir, `boots-default-${Date.now()}.log`);
    const client = new McpClient(config({ BOOT_MARKER: marker }), 'reconnect-default');
    try {
      expect(await client.callTool('die', {})).toBe('die ok'); // server answers, then exits
      await sleep(200); // exit event → fatal → reconnect cycle starts
      expect(client.state).toBe('reconnecting');
      const out = await client.callTool('uppercase', { text: 'back again' }); // awaits the cycle
      expect(out).toBe('BACK AGAIN');
      expect(client.state).toBe('ready');
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2); // one respawn
    } finally {
      client.close();
    }
  });

  it('recovers through crashing restarts with backoff until the server stays up', async () => {
    const marker = join(dir, `boots-crashy-${Date.now()}.log`);
    // Server crashes on boots 1-2 of THIS marker file, stays up from boot 3.
    const client = new McpClient(config({ BOOT_MARKER: marker, BOOT_OK_AFTER: '3' }, { attempts: 3, initialDelayMs: 20, maxDelayMs: 100 }), 'reconnect-crashy');
    try {
      // Boot 1 crashes before initialize is answered → the initial listTools
      // fails; the reconnect cycle must already be running (backoff, not a hang).
      await expect(client.listTools()).rejects.toThrow();
      expect(client.state).toBe('reconnecting');
      // The cycle retries with backoff through the boot-2 crash; boot 3 sticks.
      await sleep(400);
      expect(client.state).toBe('ready');
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(3);
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['uppercase']);
    } finally {
      client.close();
    }
  });

  it('reconnect: false keeps the old fail-slow behavior disabled and fails fast on dead sends', async () => {
    const marker = join(dir, `boots-off-${Date.now()}.log`);
    const client = new McpClient(config({ BOOT_MARKER: marker }, false), 'reconnect-off');
    try {
      expect(await client.callTool('die', {})).toBe('die ok');
      await sleep(200);
      expect(client.state).toBe('failed'); // no policy → no respawn
      // Sends into the dead server fail FAST (transport health check), not
      // after the 10s request timeout.
      await expect(client.callTool('uppercase', { text: 'x' })).rejects.toThrow(/not running|reconnect failed/);
    } finally {
      client.close();
    }
  });
});
