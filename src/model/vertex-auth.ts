// Vertex AI authentication: service-account JWT → OAuth2 access-token
// exchange (the standard Google service-account flow), with fallbacks to
// ambient gcloud credentials. Tokens are cached until ~60s before expiry.
//
// Priority:
//   1. GOOGLE_APPLICATION_CREDENTIALS (service-account JSON key file)
//   2. GOOGLE_SERVICE_ACCOUNT_KEY (inline service-account JSON)
//   3. gcloud ADC / `gcloud auth print-access-token` (ambient)
//
// The client_email + private_key from the service account are signed into a
// JWT (RS256) via node:crypto, exchanged at https://oauth2.googleapis.com/token
// for an access token scoped to the AI Platform / Vertex API.

import { createSign, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gcloudAmbientToken } from './ambient-auth.js';

export interface VertexToken {
  token: string;
  expiresAtMs: number;
  source: 'service-account' | 'gcloud-adc';
}

let cache: VertexToken | undefined;
let cacheSource = '';

export function resetVertexTokenCache(): void {
  cache = undefined;
  cacheSource = '';
}

interface ServiceAccountKey {
  client_email?: unknown;
  private_key?: unknown;
  project_id?: unknown;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function loadServiceAccount(): ServiceAccountKey | undefined {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ServiceAccountKey;
    } catch { /* unreadable key file — fall through */ }
  }
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  if (inline) {
    try {
      return JSON.parse(inline) as ServiceAccountKey;
    } catch { /* malformed inline key — fall through */ }
  }
  return undefined;
}

/** Sign the JWT claim set with the service account's RSA private key. */
function signJwt(privateKey: string, header: object, payload: object): string {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(privateKey))}`;
}

export function serviceAccountProject(): string | undefined {
  const key = loadServiceAccount();
  return typeof key?.project_id === 'string' ? key.project_id : undefined;
}

async function exchangeJwt(jwt: string): Promise<{ token: string; expiresAtMs: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`Vertex token exchange failed (HTTP ${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('Vertex token exchange returned no access_token');
  return {
    token: data.access_token,
    expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

export async function vertexToken(now: () => number = Date.now): Promise<VertexToken | undefined> {
  const sa = loadServiceAccount();
  if (sa && typeof sa.client_email === 'string' && typeof sa.private_key === 'string') {
    // Cached service-account tokens are reusable across sources; the cache
    // only holds one token — SA beats gcloud, so cache keyed by source.
    if (cache && cacheSource === 'service-account' && cache.expiresAtMs - 60_000 > now()) {
      return cache;
    }
    const iat = Math.floor(now() / 1000);
    const jwt = signJwt(sa.private_key, { alg: 'RS256', typ: 'JWT' }, {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    });
    const { token, expiresAtMs } = await exchangeJwt(jwt);
    cache = { token, expiresAtMs, source: 'service-account' };
    cacheSource = 'service-account';
    return cache;
  }
  // Ambient fallback (gcloud ADC or CLI). gcloudAmbientToken returns undefined
  // when gcloud is missing; never cache ambient failures so retry re-checks.
  const ambient = await gcloudAmbientToken();
  if (ambient) {
    return { token: ambient.token, expiresAtMs: ambient.expiresAtMs ?? Date.now() + 300_000, source: 'gcloud-adc' };
  }
  return undefined;
}

/** SHA-256 fingerprint helper exposed for tests (proves the JWT is signed). */
export function jwtFingerprint(jwt: string): string {
  return createHash('sha256').update(jwt).digest('hex').slice(0, 16);
}
