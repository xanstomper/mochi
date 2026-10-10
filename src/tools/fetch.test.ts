import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { fetchTool } from './fetch.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

function makeCtx(cwd: string) {
  const workspace = new Workspace(cwd, '.mochi');
  const events = new EventBus();
  return {
    cwd,
    workspace,
    events,
    config: {
      permissions: { network: true },
      safety: { mode: 'auto' as const },
    } as any,
    agentId: 'test',
  };
}

let server: http.Server;
let baseUrl: string;

function startServer() {
  return new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(`echo:${body}`);
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('hello from test server');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

afterAll(() => { server?.close(); });

describe('fetchTool', () => {
  it('performs a GET request and returns response body', async () => {
    await startServer();
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-fetch-'));
    const ctx = makeCtx(dir);
    const result = await fetchTool.execute({ url: `${baseUrl}/`, allow_private: true }, ctx);
    expect(result).toContain('hello from test server');
    expect(result).toContain('HTTP 200');
  });

  it('performs a POST request with body', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-fetch-'));
    const ctx = makeCtx(dir);
    const result = await fetchTool.execute({ url: `${baseUrl}/post`, method: 'POST', body: 'payload123', allow_private: true }, ctx);
    expect(result).toContain('echo:payload123');
  });

  it('blocks private/loopback hosts by default (SSRF guard)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-fetch-'));
    const ctx = makeCtx(dir);
    for (const bad of ['http://127.0.0.1:9/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x']) {
      let threw = false;
      try {
        await fetchTool.execute({ url: bad }, ctx);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });

  it('blocks non-http protocols', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-fetch-'));
    const ctx = makeCtx(dir);
    let threw = false;
    try {
      await fetchTool.execute({ url: 'file:///etc/passwd' }, ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
