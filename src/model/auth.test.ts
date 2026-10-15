// API-key verification probes (auth-verify) + device-flow engine (oauth-device).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyApiKey } from './auth-verify.js';
import { requestDeviceCode, pollDeviceToken } from './oauth-device.js';

// ── stub key endpoints ─────────────────────────────────────────────────────
let server: Server;
let base = '';
const seen: Array<{ url: string; auth?: string; key?: string; version?: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    // Mode is a leading path segment (/t401/…, /t400/…, /t429/…, /t500/…):
    // query strings would be mangled by the client's URL joining.
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    seen.push({
      url: u.pathname + u.search,
      auth: req.headers.authorization,
      key: u.searchParams.get('key') ?? undefined,
      version: req.headers['anthropic-version'] as string | undefined,
    });
    const mode = seg === 'models' || seg === 'v1beta' || seg === 'v1' ? '' : seg;
    if (mode === 't401') { res.statusCode = 401; res.end('{}'); return; }
    if (mode === 't400') { res.statusCode = 400; res.end('{}'); return; }
    if (mode === 't429') { res.statusCode = 429; res.end('{}'); return; }
    if (mode === 't500') { res.statusCode = 500; res.end('{}'); return; }
    res.statusCode = 200;
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('verifyApiKey (login must prove the key)', () => {
  it('accepts a working OpenAI-shape key', async () => {
    expect(await verifyApiKey({ provider: 'x', baseUrl: base, apiKey: 'k', kind: 'openai' })).toEqual({ ok: true });
    expect(seen.some((s) => s.url.startsWith('/models') && s.auth === 'Bearer k')).toBe(true);
  });

  it('rejects 401 as auth failure, never stores', async () => {
    const r = await verifyApiKey({ provider: 'x', baseUrl: `${base}/t401`, apiKey: 'bad', kind: 'openai' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('auth');
  });

  it('treats 429 as proof of auth (throttled, not rejected)', async () => {
    expect((await verifyApiKey({ provider: 'x', baseUrl: `${base}/t429`, apiKey: 'k', kind: 'openai' })).ok).toBe(true);
  });

  it('treats 500 as network (never call a good key bad)', async () => {
    const r = await verifyApiKey({ provider: 'x', baseUrl: `${base}/t500`, apiKey: 'k', kind: 'openai' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('network');
  });

  it('treats unreachable hosts as network, fast', async () => {
    const t0 = Date.now();
    const r = await verifyApiKey({ provider: 'x', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', kind: 'openai', timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('network');
    expect(Date.now() - t0).toBeLessThan(15000);
  });

  it('checks Anthropic headers and Gemini key param', async () => {
    expect((await verifyApiKey({ provider: 'a', baseUrl: base, apiKey: 'k', kind: 'anthropic' })).ok).toBe(true);
    expect(seen.some((s) => s.url.startsWith('/v1/models') && s.key === undefined)).toBe(true);
    expect(seen.some((s) => s.version === '2023-06-01')).toBe(true);
    expect((await verifyApiKey({ provider: 'g', baseUrl: base, apiKey: 'k', kind: 'gemini' })).ok).toBe(true);
    expect(seen.some((s) => s.url.includes('/v1beta/models') && s.key === 'k')).toBe(true);
    const bad = await verifyApiKey({ provider: 'g', baseUrl: `${base}/t400`, apiKey: 'k', kind: 'gemini' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('auth');
  });

  it('verifies Antigravity OAuth tokens via loadCodeAssist', async () => {
    const origFetch = globalThis.fetch;
    try {
      let authHeader = '';
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
        return new Response(JSON.stringify({ currentTier: { id: 'free-tier' } }), { status: 200 });
      }) as typeof fetch;

      const ok = await verifyApiKey({
        provider: 'antigravity',
        baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
        apiKey: 'ya29.valid-token',
        kind: 'gemini',
      });
      expect(ok.ok).toBe(true);
      expect(authHeader).toBe('Bearer ya29.valid-token');

      globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
      const bad = await verifyApiKey({
        provider: 'antigravity',
        baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
        apiKey: 'ya29.invalid-token',
        kind: 'gemini',
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.reason).toBe('auth');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
// ── stub OAuth device endpoints ────────────────────────────────────────────
describe('oauth-device engine (unwired: needs a registered client_id)', () => {
  const svc = (script: Array<Record<string, unknown>>) => {
    let i = 0;
    const fetchFn = (async (_url: string) => ({
      ok: true as const,
      status: 200,
      json: async () => script[Math.min(i++, script.length - 1)],
    })) as unknown as typeof fetch;
    return fetchFn;
  };
  const server = { deviceCodeUrl: 'https://auth.example.com/device', tokenUrl: 'https://auth.example.com/token', clientId: 'cid-123' };

  it('refuses to run without a client_id (no fake logins)', async () => {
    await expect(requestDeviceCode({ ...server, clientId: '' })).rejects.toThrow('client_id');
    await expect(pollDeviceToken({ ...server, clientId: '' }, {
      device_code: 'd', user_code: 'u', verification_uri: 'https://x', expires_in: 60, interval: 0,
    })).rejects.toThrow('client_id');
  });

  it('polls through pending to a token', async () => {
    const code = await requestDeviceCode(server, {
      fetchFn: svc([{ device_code: 'd', user_code: 'U-1', verification_uri: 'https://x/act', expires_in: 300, interval: 0 }]),
    });
    expect(code.user_code).toBe('U-1');
    const tok = await pollDeviceToken(server, code, {
      sleepFn: async () => {},
      fetchFn: svc([{ error: 'authorization_pending' }, { error: 'authorization_pending' }, { access_token: 'tok-abc', scope: 'read' }]),
    });
    expect(tok.access_token).toBe('tok-abc');
  });

  it('backs off on slow_down and fails on denial/expiry', async () => {
    const code = { device_code: 'd', user_code: 'U', verification_uri: 'https://x', expires_in: 300, interval: 0 };
    const waits: number[] = [];
    await pollDeviceToken(server, code, {
      sleepFn: async () => {},
      onWait: (w) => waits.push(w),
      fetchFn: svc([{ error: 'slow_down' }, { access_token: 't' }]),
    });
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    await expect(pollDeviceToken(server, code, {
      fetchFn: svc([{ error: 'access_denied' }]),
    })).rejects.toThrow('denied');
    await expect(pollDeviceToken(server, code, {
      fetchFn: svc([{ error: 'expired_token' }]),
    })).rejects.toThrow('expired');
  });

  it('honours cancellation and the expiry deadline', async () => {
    const code = { device_code: 'd', user_code: 'U', verification_uri: 'https://x', expires_in: 300, interval: 0 };
    const ctl = new AbortController();
    ctl.abort();
    await expect(pollDeviceToken(server, code, {
      signal: ctl.signal, fetchFn: svc([{ error: 'authorization_pending' }]),
    })).rejects.toThrow('cancelled');
    await expect(pollDeviceToken(server, code, {
      timeoutMs: 1, fetchFn: svc([{ error: 'authorization_pending' }]),
    })).rejects.toThrow('expired');
  });
});
