import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  startDaemonInProcess,
  dashboardResponseToken,
  getDashboardHtml,
  getDashboardLoginHtml,
  corsHeadersForOrigin,
  isLocalhostOrigin,
} from './daemon.js';

// Distinctive marker token: any appearance of this string in a response meant
// for an unauthenticated requester is, by definition, the leak regressing.
const REAL_TOKEN = 'REAL-TOKEN-DO-NOT-LEAK-7f3a9c';

describe('dashboard token helpers', () => {
  it('embeds the real token only when the request proved possession of it', () => {
    expect(dashboardResponseToken('', false, REAL_TOKEN)).toBe('');
    expect(dashboardResponseToken('wrong-guess', false, REAL_TOKEN)).toBe('');
    expect(dashboardResponseToken(REAL_TOKEN, true, REAL_TOKEN)).toBe(REAL_TOKEN);
  });

  it('login page is token-free and offers a token entry path', () => {
    const html = getDashboardLoginHtml();
    expect(html).not.toContain(REAL_TOKEN);
    expect(html).toContain('token-input');
    // Saved-token browsers are sent through the server-verified ?token= path.
    expect(html).toContain("localStorage.getItem('mochi_token')");
  });

  it('full dashboard still carries the token it is given (valid-token flow)', () => {
    expect(getDashboardHtml(REAL_TOKEN)).toContain(REAL_TOKEN);
    expect(getDashboardHtml('')).not.toContain(REAL_TOKEN);
  });
});

describe('CORS origin policy', () => {
  it('recognizes only http(s) loopback origins', () => {
    expect(isLocalhostOrigin('http://127.0.0.1:9470')).toBe(true);
    expect(isLocalhostOrigin('http://localhost:3000')).toBe(true);
    expect(isLocalhostOrigin('https://localhost:8443')).toBe(true);
    expect(isLocalhostOrigin('http://[::1]:8080')).toBe(true);
    expect(isLocalhostOrigin('https://evil.example')).toBe(false);
    expect(isLocalhostOrigin('http://127.0.0.1.evil.example')).toBe(false);
    expect(isLocalhostOrigin('http://localhost.evil.example')).toBe(false);
    expect(isLocalhostOrigin(undefined)).toBe(false);
    expect(isLocalhostOrigin('not a url')).toBe(false);
  });

  it('never grants * and grants nothing to non-localhost origins', () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1.evil.example', undefined]) {
      const h = corsHeadersForOrigin(origin);
      expect(h['access-control-allow-origin']).toBeUndefined();
    }
    const ok = corsHeadersForOrigin('http://localhost:3000');
    expect(ok['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok['access-control-allow-origin']).not.toBe('*');
  });
});

describe('daemon dashboard over HTTP', () => {
  let dir: string;
  let handle: { info: { port: number }; close: () => Promise<void> } | undefined;
  const base = () => `http://127.0.0.1:${handle!.info.port}`;

  beforeAll(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-daemon-dash-'));
    execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir });
    handle = await startDaemonInProcess({ cwd: dir, token: REAL_TOKEN });
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves NO token to an unauthenticated dashboard request', async () => {
    for (const path of ['/', '/dashboard']) {
      const res = await fetch(`${base()}${path}`);
      const body = await res.text();
      expect(res.status).toBe(401);
      expect(body).not.toContain(REAL_TOKEN);
      expect(body).toContain('token-input');
    }
  });

  it('serves the working dashboard when a valid token is presented', async () => {
    const viaQuery = await fetch(`${base()}/?token=${REAL_TOKEN}`);
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.text()).toContain(REAL_TOKEN);

    const viaHeader = await fetch(`${base()}/dashboard`, {
      headers: { authorization: `Bearer ${REAL_TOKEN}` },
    });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.text()).toContain(REAL_TOKEN);
  });

  it('rejects a wrong token without leaking the real one', async () => {
    const res = await fetch(`${base()}/?token=wrong-guess`);
    const body = await res.text();
    expect(res.status).toBe(401);
    expect(body).not.toContain(REAL_TOKEN);
  });

  it('does not answer non-localhost origins with CORS *', async () => {
    const health = await fetch(`${base()}/api/health`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`${base()}/api/status`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

    // Authenticated API responses (the send() path) obey the same policy.
    const api = await fetch(`${base()}/api/status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${REAL_TOKEN}`, origin: 'https://evil.example' },
      body: '{}',
    });
    expect(api.status).toBe(200);
    expect(api.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still reflects localhost origins so local tools keep working', async () => {
    const health = await fetch(`${base()}/api/health`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(health.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');

    const preflight = await fetch(`${base()}/api/status`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:9999' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:9999');
  });
});
