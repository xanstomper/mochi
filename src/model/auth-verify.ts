// API-key verification: login must PROVE a key, not just store the string.
// Previously `mochi login` persisted any input blindly — a typo'd or dead key
// then failed every request for a minute of failover burn ("fake auth").
// verifyApiKey performs the cheapest possible live check per provider kind
// (model list read, no generation cost) and distinguishes three outcomes:
//   ok            — the key is accepted (200, or 429 which also proves auth)
//   auth-failed   — the endpoint rejected the credential (401/403, 400 on
//                   Gemini) → caller must NOT store it
//   network       — timeout/DNS/reset/5xx: key MIGHT be fine; caller stores
//                   with a warning instead of refusing honestly-good keys
//                   on flaky networks.
import { getAntigravityUserAgent } from './antigravity-oauth.js';

export type KeyVerdict =
  | { ok: true }
  | { ok: false; reason: 'auth' | 'network'; message: string };

export interface VerifyKeyOpts {
  provider: string;
  baseUrl: string;
  apiKey: string;
  kind: 'openai' | 'anthropic' | 'gemini' | 'vertex';
  timeoutMs?: number;
}

function joinUrl(base: string, path: string): string {
  const qIdx = base.indexOf('?');
  if (qIdx >= 0) {
    const rawPath = base.slice(0, qIdx).replace(/\/+$/, '');
    const query = base.slice(qIdx);
    return `${rawPath}${path}${query}`;
  }
  return base.replace(/\/+$/, '') + path;
}

async function get(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyApiKey(opts: VerifyKeyOpts): Promise<KeyVerdict> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    if (opts.provider === 'antigravity' || opts.provider === 'google-antigravity') {
      let token = opts.apiKey.trim();
      if (token.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(token);
          if (parsed && typeof parsed === 'object') {
            const rec = parsed as Record<string, unknown>;
            if (typeof rec.access === 'string') token = rec.access;
            else if (typeof rec.access_token === 'string') token = rec.access_token;
          }
        } catch { /* keep raw */ }
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': getAntigravityUserAgent(),
          },
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
          signal: ctl.signal,
        });
        if (res.status === 200 || res.status === 429) return { ok: true };
        if (res.status === 401 || res.status === 403) {
          return { ok: false, reason: 'auth', message: `endpoint rejected token (HTTP ${res.status})` };
        }
        return { ok: false, reason: 'network', message: `endpoint answered HTTP ${res.status} (not a token verdict)` };
      } finally {
        clearTimeout(timer);
      }
    }
    if (opts.kind === 'anthropic') {
      const r = await get(joinUrl(opts.baseUrl, '/v1/models'), {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      }, timeoutMs);
      if (r.status === 200 || r.status === 429) return { ok: true };
      if (r.status === 401 || r.status === 403) {
        return { ok: false, reason: 'auth', message: `endpoint rejected the key (HTTP ${r.status})` };
      }
      return { ok: false, reason: 'network', message: `endpoint answered HTTP ${r.status} (not a key verdict)` };
    }
    if (opts.kind === 'vertex') {
      // Vertex uses cloud credentials, not an API key — nothing to probe here.
      return { ok: true, note: 'vertex uses cloud credentials (no key probe)' } as { ok: true };
    }
    if (opts.kind === 'gemini') {
      const target = joinUrl(opts.baseUrl, '/v1beta/models');
      const sep = target.includes('?') ? '&' : '?';
      const r = await get(`${target}${sep}key=${encodeURIComponent(opts.apiKey)}`, {}, timeoutMs);
      if (r.status === 200 || r.status === 429) return { ok: true };
      // Gemini reports a bad key as 400 API_KEY_INVALID (plus 401/403).
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        return { ok: false, reason: 'auth', message: `endpoint rejected the key (HTTP ${r.status})` };
      }
      return { ok: false, reason: 'network', message: `endpoint answered HTTP ${r.status} (not a key verdict)` };
    }
    // openai-compatible (covers all OpenAI-shape providers): model list read.
    const r = await get(joinUrl(opts.baseUrl, '/models'), { Authorization: `Bearer ${opts.apiKey}` }, timeoutMs);
    if (r.status === 200 || r.status === 429) return { ok: true };
    if (r.status === 401 || r.status === 403) {
      return { ok: false, reason: 'auth', message: `endpoint rejected the key (HTTP ${r.status})` };
    }
    return { ok: false, reason: 'network', message: `endpoint answered HTTP ${r.status} (not a key verdict)` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'network', message: msg.includes('aborted') ? `no answer within ${timeoutMs}ms` : msg.slice(0, 160) };
  }
}
