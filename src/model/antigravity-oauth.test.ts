import { describe, it, expect, vi } from 'vitest';
import {
  generateAuthUrl,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_TOKEN_URL,
  LOAD_CODE_ASSIST_URL,
  ONBOARD_USER_URL,
  OPERATIONS_URL,
  startCallbackServer,
  exchangeCodeForTokens,
  fetchUserInfo,
  discoverAndOnboardProject,
  extractGoogleValidationUrl,
  refreshAntigravityToken,
  getAntigravityUserAgent,
} from './antigravity-oauth.js';

describe('antigravity-oauth', () => {
  it('generates a valid Google OAuth authorization URL matching omp parameters', () => {
    const redirectUri = 'http://127.0.0.1:51121/oauth-callback';
    const state = 'test-state-1234';
    const urlStr = generateAuthUrl(redirectUri, state);
    const parsed = new URL(urlStr);

    expect(parsed.origin + parsed.pathname).toBe(ANTIGRAVITY_AUTH_URL);
    expect(parsed.searchParams.get('client_id')).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('scope')).toBe(ANTIGRAVITY_SCOPES.join(' '));
  });

  it('formats User-Agent matching Antigravity format', () => {
    const ua = getAntigravityUserAgent();
    expect(ua).toMatch(/^antigravity\/hub\/[\d.]+ \(aidev_client; os_type=\w+; arch=\w+; cl=\d+\)$/);
  });

  it('runs local loopback callback server and receives code/state', async () => {
    const handle = await startCallbackServer(0, '/test-callback');
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.redirectUri).toBe(`http://127.0.0.1:${handle.port}/test-callback`);

      const callbackPromise = handle.waitForCallback(5000);

      const callbackUrl = `http://127.0.0.1:${handle.port}/test-callback?code=mock-auth-code&state=mock-state`;
      const res = await fetch(callbackUrl);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Authentication Successful');

      const result = await callbackPromise;
      expect(result.code).toBe('mock-auth-code');
      expect(result.state).toBe('mock-state');
    } finally {
      await handle.close();
    }
  });

  it('exchanges code for tokens via token endpoint', async () => {
    const captured: { url?: string; body?: string } = {};
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.body = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ya29.mock-access',
          refresh_token: '1//mock-refresh',
          expires_in: 3599,
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const tokens = await exchangeCodeForTokens('sample-code', 'http://127.0.0.1:51121/cb', {
      fetchFn: mockFetch,
    });

    expect(captured.url).toBe(ANTIGRAVITY_TOKEN_URL);
    expect(captured.body).toContain('grant_type=authorization_code');
    expect(captured.body).toContain('code=sample-code');
    expect(tokens.access_token).toBe('ya29.mock-access');
    expect(tokens.refresh_token).toBe('1//mock-refresh');
    expect(tokens.expires_in).toBe(3599);
  });

  it('fetches user info email', async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ email: 'engineer@google.com' }),
    })) as unknown as typeof fetch;

    const user = await fetchUserInfo('ya29.mock', { fetchFn: mockFetch });
    expect(user.email).toBe('engineer@google.com');
  });

  it('discovers project without onboarding when currentTier exists', async () => {
    const calls: string[] = [];
    const mockFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u === LOAD_CODE_ASSIST_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            currentTier: { id: 'free-tier' },
            allowedTiers: [{ id: 'free-tier' }],
            cloudaicompanionProject: 'my-companion-proj',
          }),
        };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    }) as unknown as typeof fetch;

    const projectId = await discoverAndOnboardProject('ya29.mock', undefined, {
      fetchFn: mockFetch,
    });

    expect(projectId).toBe('my-companion-proj');
    expect(calls).toEqual([LOAD_CODE_ASSIST_URL, LOAD_CODE_ASSIST_URL, LOAD_CODE_ASSIST_URL]);
  });

  it('onboards user when currentTier is missing', async () => {
    const calls: string[] = [];
    let loadCount = 0;
    const mockFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u === LOAD_CODE_ASSIST_URL) {
        loadCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            currentTier: loadCount === 1 ? null : { id: 'free-tier' },
            allowedTiers: [{ id: 'free-tier' }],
            cloudaicompanionProject: 'onboarded-companion-proj',
          }),
        };
      }
      if (u === ONBOARD_USER_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'operations/op-123',
            done: false,
          }),
        };
      }
      if (u === `${OPERATIONS_URL}/operations/op-123`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'operations/op-123',
            done: true,
            response: { cloudaicompanionProject: 'onboarded-companion-proj' },
          }),
        };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    }) as unknown as typeof fetch;

    const progress: string[] = [];
    const projectId = await discoverAndOnboardProject('ya29.mock', (m) => progress.push(m), {
      fetchFn: mockFetch,
    });

    expect(projectId).toBe('onboarded-companion-proj');
    expect(progress.some((m) => m.includes('Provisioning the Antigravity free tier'))).toBe(true);
    expect(calls).toContain(ONBOARD_USER_URL);
  });

  it('extracts Google validation required URL correctly', () => {
    const err = 'VALIDATION_REQUIRED {"error":{"details":[{"reason":"VALIDATION_REQUIRED","metadata":{"validation_url":"https://accounts.google.com/verify"}}]}}';
    const url = extractGoogleValidationUrl(err);
    expect(url).toBe('https://accounts.google.com/verify');

    expect(extractGoogleValidationUrl('plain error')).toBeUndefined();
  });

  it('refreshes token successfully', async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.new-access',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch;

    const res = await refreshAntigravityToken('1//test-refresh', {
      fetchFn: mockFetch,
      now: () => 1_000_000,
    });

    expect(res.access_token).toBe('ya29.new-access');
    expect(res.expiresAtMs).toBe(1_000_000 + 3600 * 1000);
  });
});

// ISSUES L-17: the client identity is env-overridable — like every other
// credential, the environment wins over the shipped fallback constant.
describe('antigravity-oauth env-overridable client identity', () => {
  it('ANTIGRAVITY_CLIENT_SECRET/ID env vars override the shipped fallback', async () => {
    vi.resetModules();
    process.env.ANTIGRAVITY_CLIENT_SECRET = 'env-fixture-secret';
    process.env.ANTIGRAVITY_CLIENT_ID = 'env-fixture-id.apps.googleusercontent.com';
    try {
      const mod = await import('./antigravity-oauth.js?envtest=1');
      expect(mod.ANTIGRAVITY_CLIENT_SECRET).toBe('env-fixture-secret');
      expect(mod.ANTIGRAVITY_CLIENT_ID).toBe('env-fixture-id.apps.googleusercontent.com');
    } finally {
      delete process.env.ANTIGRAVITY_CLIENT_SECRET;
      delete process.env.ANTIGRAVITY_CLIENT_ID;
      vi.resetModules();
    }
  });
});
