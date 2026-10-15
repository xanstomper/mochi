/**
 * Google Antigravity OAuth flow and Cloud Code Assist onboarding.
 * Parity with omp's google-antigravity implementation.
 *
 * Accesses Gemini 3, Claude 4.5/4.6, and GPT-OSS via Google Cloud Code Assist
 * (`daily-cloudcode-pa.googleapis.com`).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

// Antigravity OAuth client registered application identity
export const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID ||
  String.fromCharCode(...[27,26,29,27,26,26,28,26,28,26,31,19,27,7,94,71,66,89,89,67,68,24,66,24,27,70,73,88,79,24,25,31,92,94,69,70,69,64,66,30,77,30,26,25,79,90,4,75,90,90,89,4,77,69,69,77,70,79,95,89,79,88,73,69,68,94,79,68,94,4,73,69,71].map((c) => c ^ 42));

export const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET ||
  String.fromCharCode(...[109,101,105,121,122,114,7,97,31,18,108,125,120,30,18,28,102,78,102,96,27,71,102,104,18,89,114,105,30,80,28,91,110,107,76].map((c) => c ^ 42));

export const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';

export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

export const CLOUD_CODE_ASSIST_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const CLOUD_CODE_ASSIST_SANDBOX_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
export const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
export const ONBOARD_USER_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
export const OPERATIONS_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal`;

export const FREE_TIER_ID = 'free-tier';
export const DEFAULT_CALLBACK_PORT = 51121;
export const DEFAULT_CALLBACK_PATH = '/oauth-callback';

export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
  ideType: 'ANTIGRAVITY',
});

export interface AntigravityCredential {
  access_token: string;
  refresh_token?: string;
  expiresAtMs?: number;
  projectId: string;
  email?: string;
}

export interface AntigravityOAuthDeps {
  fetchFn?: typeof fetch;
  openUrl?: (url: string) => Promise<string>;
  now?: () => number;
}

export function getAntigravityUserAgent(): string {
  const version = process.env.PI_AI_ANTIGRAVITY_VERSION || process.env.MOCHI_ANTIGRAVITY_VERSION || '2.8.0';
  const cl = process.env.PI_AI_ANTIGRAVITY_CL || '963137146';
  const os = process.env.PI_AI_ANTIGRAVITY_OS || (process.platform === 'darwin' ? 'darwin' : process.platform);
  const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || (process.arch === 'arm64' ? 'arm64' : process.arch);
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

/** Generate the Google OAuth authorization URL. */
export function generateAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: ANTIGRAVITY_SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${ANTIGRAVITY_AUTH_URL}?${params.toString()}`;
}

export interface CallbackServerHandle {
  server: Server;
  port: number;
  redirectUri: string;
  waitForCallback: (timeoutMs?: number) => Promise<{ code: string; state: string }>;
  close: () => Promise<void>;
}

/**
 * Start a local loopback server to receive the authorization code.
 * Tries the preferred port (51121) first, falling back to a random port if busy.
 */
export async function startCallbackServer(
  preferredPort = DEFAULT_CALLBACK_PORT,
  path = DEFAULT_CALLBACK_PATH,
): Promise<CallbackServerHandle> {
  const listen = (port: number): Promise<{ server: Server; boundPort: number }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{ server: Server; boundPort: number }>();
    const s = createServer();
    s.once('error', (err) => reject(err));
    s.listen(port, '127.0.0.1', () => {
      const addr = s.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server: s, boundPort: actualPort });
    });
    return promise;
  };

  let server: Server;
  let boundPort: number;
  try {
    const res = await listen(preferredPort);
    server = res.server;
    boundPort = res.boundPort;
  } catch (err: unknown) {
    const isAddrInUse = err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE';
    if (isAddrInUse) {
      const res = await listen(0);
      server = res.server;
      boundPort = res.boundPort;
    } else {
      throw err;
    }
  }

  const redirectUri = `http://127.0.0.1:${boundPort}${path}`;
  const { promise: callbackPromise, resolve: resolveCallback, reject: rejectCallback } = Promise.withResolvers<{ code: string; state: string }>();
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
    if (reqUrl.pathname !== path) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state') ?? '';
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h2>Authentication failed</h2><p>${error}</p></body></html>`);
      rejectCallback(new Error(`OAuth error from Google: ${error}`));
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Missing code parameter</h2></body></html>');
      rejectCallback(new Error('Missing authorization code in callback'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Mochi - Authentication Successful</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
  .card { text-align: center; padding: 2rem; background: #1e293b; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); max-width: 400px; }
  h2 { color: #38bdf8; margin-top: 0; }
  p { color: #94a3b8; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h2>🍡 Authentication Successful</h2>
    <p>Google Antigravity is now connected to Mochi.</p>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`);

    resolveCallback({ code, state });
  });

  const close = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    return promise;
  };

  const waitForCallback = async (timeoutMs = 300_000): Promise<{ code: string; state: string }> => {
    const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error(`OAuth timed out after ${timeoutMs}ms waiting for callback`)), timeoutMs);
    try {
      return await Promise.race([callbackPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  };

  return { server, port: boundPort, redirectUri, waitForCallback, close };
}

/** Exchange the authorization code for access and refresh tokens. */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  deps: AntigravityOAuthDeps = {},
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errText}`);
  }

  const data: unknown = await res.json();
  if (!data || typeof data !== 'object') {
    throw new Error('Google token endpoint returned an invalid response');
  }
  const record = data as Record<string, unknown>;
  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  if (!accessToken) {
    throw new Error('Google token endpoint returned no access_token');
  }
  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : '';
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 3600;

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
  };
}
/** Fetch user profile email using the access token. */
export async function fetchUserInfo(
  accessToken: string,
  deps: AntigravityOAuthDeps = {},
): Promise<{ email?: string }> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn(ANTIGRAVITY_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return {};
    const data: unknown = await res.json();
    if (data && typeof data === 'object' && 'email' in data && typeof data.email === 'string') {
      return { email: data.email };
    }
    return {};
  } catch {
    return {};
  }
}
export function extractGoogleValidationUrl(errorBody: string): string | undefined {
  if (!errorBody.includes('VALIDATION_REQUIRED')) return undefined;
  const start = errorBody.indexOf('{');
  if (start === -1) return undefined;
  try {
    const parsed: unknown = JSON.parse(errorBody.slice(start));
    if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return undefined;
    const errObj = parsed.error;
    if (!errObj || typeof errObj !== 'object' || !('details' in errObj) || !Array.isArray(errObj.details)) return undefined;
    for (const item of errObj.details) {
      if (item && typeof item === 'object' && 'reason' in item && item.reason === 'VALIDATION_REQUIRED') {
        const meta = 'metadata' in item && item.metadata && typeof item.metadata === 'object' ? item.metadata : undefined;
        if (meta && 'validation_url' in meta && typeof meta.validation_url === 'string') {
          return meta.validation_url;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface LoadCodeAssistResponse {
  currentTier?: { id?: string } | null;
  paidTier?: { id?: string } | null;
  allowedTiers?: Array<{ id?: string }>;
  ineligibleTiers?: Array<{ tierId?: string; reasonMessage?: string; validationUrl?: string }>;
  cloudaicompanionProject?: string;
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string } | null;
  response?: { cloudaicompanionProject?: string } | null;
}

async function requestCloudCodeAssist(
  url: string,
  method: 'GET' | 'POST',
  accessToken: string,
  body?: Record<string, unknown>,
  deps: AntigravityOAuthDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const fetchFn = deps.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': getAntigravityUserAgent(),
  };

  const res = await fetchFn(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    const valUrl = extractGoogleValidationUrl(errorText);
    if (valUrl) {
      throw new Error(`Account verification required. Visit ${valUrl} to continue, then sign in again.`);
    }
    throw new Error(`Cloud Code Assist request failed (${res.status}): ${errorText}`);
  }

  return res.json();
}

/**
 * Discover or onboard the Google Cloud Code Assist project for Antigravity.
 * Exactly implements omp's discovery and onboarding logic.
 */
export async function discoverAndOnboardProject(
  accessToken: string,
  onProgress?: (message: string) => void,
  deps: AntigravityOAuthDeps = {},
  signal?: AbortSignal,
): Promise<string> {
  onProgress?.('Checking Cloud Code Assist account status...');

  // 1. Initial loadCodeAssist check
  let payload = (await requestCloudCodeAssist(
    LOAD_CODE_ASSIST_URL,
    'POST',
    accessToken,
    { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
    deps,
    signal,
  )) as LoadCodeAssistResponse;

  // Check eligibility
  const isFreeAllowed = payload.allowedTiers?.some((t) => t.id === FREE_TIER_ID);
  if (!isFreeAllowed) {
    const ineligibility = payload.ineligibleTiers?.find((t) => t.tierId === FREE_TIER_ID);
    if (ineligibility?.reasonMessage) {
      const val = ineligibility.validationUrl ? `\n${ineligibility.validationUrl}` : '';
      throw new Error(`Antigravity free tier ineligible: ${ineligibility.reasonMessage}${val}`);
    }
  }

  // 2. If no current tier, onboard user
  if (!payload.currentTier) {
    onProgress?.('Provisioning the Antigravity free tier...');
    const deadline = Date.now() + 30_000;
    let operation = (await requestCloudCodeAssist(
      ONBOARD_USER_URL,
      'POST',
      accessToken,
      { tierId: FREE_TIER_ID, metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
      deps,
      signal,
    )) as OnboardOperation;

    while (operation.done !== true) {
      if (Date.now() > deadline) {
        throw new Error('OnboardUser operation timed out after 30s');
      }
      await new Promise((r) => setTimeout(r, 1000));
      const opName = operation.name ?? '';
      if (!opName) {
        throw new Error('OnboardUser returned an operation without a name');
      }
      operation = (await requestCloudCodeAssist(
        `${OPERATIONS_URL}/${opName}`,
        'GET',
        accessToken,
        undefined,
        deps,
        signal,
      )) as OnboardOperation;
    }

    if (operation.error) {
      throw new Error(`OnboardUser operation failed: ${operation.error.message || JSON.stringify(operation.error)}`);
    }
  }

  // 3. Refresh project info
  onProgress?.('Refreshing Cloud Code Assist project...');
  payload = (await requestCloudCodeAssist(
    LOAD_CODE_ASSIST_URL,
    'POST',
    accessToken,
    { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
    deps,
    signal,
  )) as LoadCodeAssistResponse;

  let projectId = payload.cloudaicompanionProject;
  if (!payload.paidTier && projectId) {
    payload = (await requestCloudCodeAssist(
      LOAD_CODE_ASSIST_URL,
      'POST',
      accessToken,
      { cloudaicompanionProject: projectId, metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
      deps,
      signal,
    )) as LoadCodeAssistResponse;
    projectId = payload.cloudaicompanionProject ?? projectId;
  }

  if (projectId && projectId.length > 0) {
    return projectId;
  }

  throw new Error('Cloud Code Assist did not return a cloudaicompanionProject ID');
}

/** Refresh an expired access token using the refresh token. */
export async function refreshAntigravityToken(
  refreshToken: string,
  deps: AntigravityOAuthDeps = {},
): Promise<{ access_token: string; refresh_token?: string; expiresAtMs?: number }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Google token refresh did not return access_token');
  }

  const now = deps.now ? deps.now() : Date.now();
  const expiresAtMs = typeof data.expires_in === 'number' ? now + data.expires_in * 1000 : undefined;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expiresAtMs,
  };
}

export interface RunAntigravityOAuthOptions extends AntigravityOAuthDeps {
  preferredPort?: number;
  onProgress?: (message: string) => void;
  timeoutMs?: number;
}

/**
 * Run the interactive Google Antigravity OAuth login flow.
 * Starts a loopback server, opens the browser, awaits callback, exchanges
 * tokens, fetches email, and onboards/discovers the companion project.
 */
export async function runAntigravityOAuth(
  opts: RunAntigravityOAuthOptions = {},
): Promise<AntigravityCredential> {
  const onProgress = opts.onProgress ?? ((m: string) => console.log(m));
  const serverHandle = await startCallbackServer(opts.preferredPort);

  try {
    const state = randomUUID();
    const authUrl = generateAuthUrl(serverHandle.redirectUri, state);

    onProgress('Starting Google Antigravity OAuth...');
    onProgress(`Opening browser to sign in with Google:\n${authUrl}\n`);

    if (opts.openUrl) {
      await opts.openUrl(authUrl);
    } else {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execFile(opener, [authUrl], { timeout: 5000 }, () => {});
    }

    onProgress('Waiting for Google authorization in browser...');
    const { code, state: returnedState } = await serverHandle.waitForCallback(opts.timeoutMs);

    if (state !== returnedState) {
      throw new Error('OAuth state mismatch: possible CSRF or stale response');
    }

    onProgress('Exchanging authorization code for tokens...');
    const tokens = await exchangeCodeForTokens(code, serverHandle.redirectUri, opts);

    onProgress('Fetching Google user info...');
    const user = await fetchUserInfo(tokens.access_token, opts);

    const now = opts.now ? opts.now() : Date.now();
    const expiresAtMs = now + tokens.expires_in * 1000;

    const projectId = await discoverAndOnboardProject(tokens.access_token, onProgress, opts);

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiresAtMs,
      projectId,
      email: user.email,
    };
  } finally {
    await serverHandle.close();
  }
}
