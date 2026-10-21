import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { liveCall } from './celeste.js';

let server: ReturnType<typeof createServer>;
let base = '';
let lastAction: Record<string, unknown> = {};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return {}; }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/api/browser/status') return send(res, 200, { connected: true });
    if (req.url === '/api/browser/tabs') {
      return send(res, 200, {
        ok: true,
        // Older Celeste daemons nested this object; the adapter flattens both.
        tabs: { tabs: [{ id: 7, title: 'Example', url: 'https://example.com/', active: true }] },
      });
    }
    if (req.url === '/api/browser/action' && req.method === 'POST') {
      const body = await readBody(req);
      lastAction = body;
      const action = String(body.action ?? '');
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (action === 'blur') return send(res, 404, { error: 'not found' });
      if (action === 'fill') return send(res, 200, { ok: true, result: { typed: params.value, ref: params.ref } });
      if (action === 'press') return send(res, 200, { ok: true, result: { ok: true, key: params.key, modifiers: params.modifiers ?? [] } });
      if (action === 'evaluate') return send(res, 200, { ok: true, result: { value: 42 } });
      if (action === 'cookies') return send(res, 200, { ok: true, result: { cookies: [], count: 0 } });
      if (action === 'tabs') return send(res, 200, { ok: true, result: { ok: true, tabId: params.tabId ?? 7 } });
      return send(res, 200, { ok: true, result: { ok: true } });
    }
    return send(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
  process.env.MOCHI_LIVE_BROWSER_URL = base;
});

afterAll(async () => {
  delete process.env.MOCHI_LIVE_BROWSER_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('live browser adapter', () => {
  it('fills and presses via the generic action route', async () => {
    const fill = await liveCall('fill', { target: 'e2', value: 'Mochi' });
    expect(fill.ok).toBe(true);
    expect(fill.action).toBe('fill');
    expect(fill.typed).toBe('Mochi');
    expect(fill.ref).toBe('e2');
    const press = await liveCall('press', { target: 'e2', key: 'Control+A' });
    expect(press.ok).toBe(true);
    expect(press.key).toBe('A');
    expect(press.modifiers).toEqual(['Control']);
  });

  it('maps evaluate values and lists/closes tabs with normalized indexes', async () => {
    const evalRes = await liveCall('evaluate', { expression: '6*7' });
    expect(evalRes.ok).toBe(true);
    expect(evalRes.result).toBe(42);
    const list = await liveCall('tabs', { action: 'list' });
    expect(list.ok).toBe(true);
    expect(Array.isArray(list.tabs)).toBe(true);
    expect((list.tabs as Array<Record<string, unknown>>)[0]?.index).toBe(0);
    const closed = await liveCall('tabs', { action: 'close', index: 0 });
    expect(closed.ok).toBe(true);
    expect(closed.action).toBe('tabs close');
  });

  it('scopes live cookies to the active tab instead of dumping every domain', async () => {
    const res = await liveCall('cookies', {});
    expect(res.ok).toBe(true);
    expect((lastAction.params as Record<string, unknown>).url).toBe('https://example.com/');
    const consoleRes = await liveCall('console', {});
    expect(consoleRes.ok).toBe(true);
    expect(lastAction.tabId).toBe(7);
  });

  it('reports an actionable error when the daemon lacks the generic route', async () => {
    const res = await liveCall('blur', { target: 'e2' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('does not expose /api/browser/action');
  });
});
