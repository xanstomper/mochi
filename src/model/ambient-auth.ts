// Ambient OAuth ingestion: reuse the user's REAL logins from other CLIs
// (Codex, Gemini CLI, Claude Code, gcloud ADC) instead of asking for API keys.
// Nothing here fakes a client_id or invents a flow — we read the token caches
// those tools maintain on disk, check expiry, and (for Codex, whose public
// client_id is documented open source) refresh via the real token endpoint.
//
// All disk/network effects are injectable so tests run hermetically.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { refreshAntigravityToken } from './antigravity-oauth.js';

export interface AmbientToken {
  token: string;
  source: string;
  expiresAtMs?: number;
  account?: string;
  projectId?: string;
}

export interface AmbientDeps {
  fetchJson?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  execFile?: (cmd: string, args: string[], opts: { timeout?: number }) => Promise<string>;
  now?: () => number;
  readFileSync?: (p: string) => string;
  writeFileSync?: (p: string, data: string) => void;
  existsSync?: (p: string) => boolean;
  /** Override the user home dir (tests). Defaults to os.homedir(). */
  homeDir?: string;
}

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // public, from open-source codex-rs
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

function home(sub: string, homeDir?: string): string {
  return resolve(homeDir ?? homedir(), sub);
}

function readJson(path: string, read: (p: string) => string): Record<string, unknown> | null {
  try {
    const raw = read(path);
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function isFresh(expiresAtMs: number | undefined, now: number, skewMs = 60_000): boolean {
  if (!expiresAtMs) return true; // no expiry info: assume fresh (caller may still probe)
  return expiresAtMs > now + skewMs;
}

/** Codex CLI ChatGPT OAuth: ~/.codex/auth.json (tokens.access_token). */
export async function codexAmbientToken(deps: AmbientDeps = {}): Promise<AmbientToken | undefined> {
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.existsSync ?? existsSync;
  const now = deps.now ?? Date.now;
  const path = home('.codex/auth.json', deps.homeDir);
  if (!exists(path)) return undefined;
  const data = readJson(path, read);
  if (!data) return undefined;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  const access = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
  const refresh = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!access) return undefined;
  const lastRefresh = typeof data.last_refresh === 'string' ? Date.parse(data.last_refresh) : NaN;
  const ageMs = Number.isFinite(lastRefresh) ? now() - lastRefresh : Number.POSITIVE_INFINITY;
  // Codex access tokens are short-lived; refresh proactively when the cached
  // token is older than 50 minutes (or when we cannot tell).
  if (refresh && (ageMs > 50 * 60_000 || !Number.isFinite(lastRefresh))) {
    const refreshed = await refreshCodexToken(refresh, deps);
    if (refreshed) {
      try {
        const write = deps.writeFileSync ?? ((p: string, d: string) => writeFileSync(p, d));
        const updated = { ...data, tokens: { ...tokens, access_token: refreshed.access, refresh_token: refreshed.refresh ?? refresh }, last_refresh: new Date(now()).toISOString() };
        write(path, JSON.stringify(updated, null, 2));
      } catch { /* best-effort persistence */ }
      return { token: refreshed.access, source: 'codex-oauth', expiresAtMs: refreshed.expiresAtMs };
    }
    return undefined; // refresh failed — do not hand back a stale token
  }
  if (access) return { token: access, source: 'codex-oauth' };

  // Fallback to omp agent.db for openai-codex
  const dbPath = home('.omp/agent/agent.db', deps.homeDir);
  if (exists(dbPath)) {
    const execFile = deps.execFile ?? (async (cmd: string, args: string[]) => {
      const { execFile: ef } = await import('node:child_process');
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      ef(cmd, args, { timeout: 8000 }, (e, out) => (e ? reject(e) : resolve(String(out ?? '').trim())));
      return promise;
    });
    try {
      const out = await execFile('sqlite3', [
        dbPath,
        "SELECT data FROM auth_credentials WHERE provider = 'openai-codex' ORDER BY updated_at DESC LIMIT 1;",
      ], { timeout: 8000 });
      if (out) {
        const parsed: unknown = JSON.parse(out);
        if (parsed && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>;
          const tok = typeof rec.access === 'string' ? rec.access : typeof rec.access_token === 'string' ? rec.access_token : '';
          if (tok) return { token: tok, source: 'omp-codex-oauth' };
        }
      }
    } catch { /* best-effort */ }
  }
  return undefined;
}

async function refreshCodexToken(refreshToken: string, deps: AmbientDeps): Promise<{ access: string; refresh?: string; expiresAtMs?: number } | undefined> {
  if (!refreshToken) return undefined;
  const fetchJson = deps.fetchJson ?? (fetch as never);
  try {
    const res = await fetchJson(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CODEX_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!body.access_token) return undefined;
    return {
      access: body.access_token,
      refresh: body.refresh_token,
      expiresAtMs: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Gemini CLI Google OAuth: ~/.gemini/oauth_creds.json (access_token + expiry_date epoch seconds). */
export function geminiAmbientToken(deps: AmbientDeps = {}): AmbientToken | undefined {
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.existsSync ?? existsSync;
  const now = deps.now ?? Date.now;
  const path = home('.gemini/oauth_creds.json', deps.homeDir);
  if (!exists(path)) return undefined;
  const data = readJson(path, read);
  if (!data) return undefined;
  const access = typeof data.access_token === 'string' ? data.access_token : '';
  if (!access) return undefined;
  const expiry = typeof data.expiry_date === 'number' ? data.expiry_date * 1000 : undefined;
  if (!isFresh(expiry, now())) return undefined; // expired — user must re-auth in the gemini CLI
  return { token: access, source: 'gemini-cli-oauth', expiresAtMs: expiry };
}

/** Claude Code OAuth: ~/.claude/.credentials.json (claudeAiOauth.accessToken). */
export function claudeAmbientToken(deps: AmbientDeps = {}): AmbientToken | undefined {
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.existsSync ?? existsSync;
  const now = deps.now ?? Date.now;
  const path = home('.claude/.credentials.json', deps.homeDir);
  if (!exists(path)) return undefined;
  const data = readJson(path, read);
  if (!data) return undefined;
  const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
  const access = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
  if (!access) return undefined;
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
  if (!isFresh(expiresAt, now())) return undefined;
  return { token: access, source: 'claude-code-oauth', expiresAtMs: expiresAt };
}

/** Google ADC (gcloud auth application-default login): token file or `gcloud auth print-access-token`. */
export async function gcloudAmbientToken(deps: AmbientDeps = {}): Promise<AmbientToken | undefined> {
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.existsSync ?? existsSync;
  const now = deps.now ?? Date.now;
  const path = home('.config/gcloud/application_default_credentials.json', deps.homeDir);
  if (exists(path)) {
    const data = readJson(path, read);
    const access = typeof data?.access_token === 'string' ? data.access_token : '';
    const expiry = typeof data?.token_expiry === 'string' ? Date.parse(data.token_expiry) : NaN;
    if (access && (Number.isNaN(expiry) || isFresh(expiry, now()))) {
      return { token: access, source: 'gcloud-adc', expiresAtMs: Number.isNaN(expiry) ? undefined : expiry };
    }
  }
  const execFile = deps.execFile ?? (async (cmd: string, args: string[]) => {
    const { execFile: ef } = await import('node:child_process');
    return await new Promise<string>((res, rej) => ef(cmd, args, { timeout: 8000 }, (e, out) => (e ? rej(e) : res(String(out ?? '').trim()))));
  });
  try {
    const out = await execFile('gcloud', ['auth', 'print-access-token'], { timeout: 8000 });
    const token = out.trim();
    if (token) return { token, source: 'gcloud-adc' };
  } catch { /* gcloud not installed / not authed */ }
  return undefined;
}

/** Antigravity OAuth: ~/.omp/agent/agent.db or ~/.antigravity/oauth_creds.json. */
export interface AntigravityAccountInfo {
  id: number;
  email: string;
  projectId?: string;
  active: boolean;
}

export async function listAntigravityAccounts(deps: AmbientDeps = {}): Promise<AntigravityAccountInfo[]> {
  const exists = deps.existsSync ?? existsSync;
  const dbPath = home('.omp/agent/agent.db', deps.homeDir);
  if (!exists(dbPath)) return [];
  const execFile = deps.execFile ?? (async (cmd: string, args: string[]) => {
    const { execFile: ef } = await import('node:child_process');
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    ef(cmd, args, { timeout: 8000 }, (e, out) => (e ? reject(e) : resolve(String(out ?? '').trim())));
    return promise;
  });
  try {
    const out = await execFile('sqlite3', [
      dbPath,
      "SELECT id, json_extract(data, '$.email') as email, json_extract(data, '$.projectId') as projectId FROM auth_credentials WHERE provider = 'google-antigravity' ORDER BY id ASC;",
    ], { timeout: 8000 });
    if (!out) return [];
    const lines = out.split('\n').filter(Boolean);
    const list: AntigravityAccountInfo[] = [];
    for (const line of lines) {
      const parts = line.split('|');
      const id = Number(parts[0]);
      const email = parts[1] ?? '';
      const projectId = parts[2] ?? '';
      if (email) {
        list.push({ id, email, projectId, active: false });
      }
    }
    return list;
  } catch {
    return [];
  }
}

/** Antigravity OAuth: ~/.omp/agent/agent.db or ~/.antigravity/oauth_creds.json. */
export async function antigravityAmbientToken(deps: AmbientDeps = {}, accountSelector?: string): Promise<AmbientToken | undefined> {
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.existsSync ?? existsSync;
  const now = deps.now ?? Date.now;

  // 1. Check omp agent.db SQLite store
  const dbPath = home('.omp/agent/agent.db', deps.homeDir);
  if (exists(dbPath)) {
    const execFile = deps.execFile ?? (async (cmd: string, args: string[]) => {
      const { execFile: ef } = await import('node:child_process');
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      ef(cmd, args, { timeout: 8000 }, (e, out) => (e ? reject(e) : resolve(String(out ?? '').trim())));
      return promise;
    });
    try {
      const query = accountSelector
        ? `SELECT data FROM auth_credentials WHERE provider = 'google-antigravity' AND (json_extract(data, '$.email') = '${accountSelector.replace(/'/g, "''")}' OR id = '${accountSelector.replace(/'/g, "''")}') LIMIT 1;`
        : "SELECT data FROM auth_credentials WHERE provider = 'google-antigravity' ORDER BY updated_at DESC LIMIT 1;";
      const out = await execFile('sqlite3', [dbPath, query], { timeout: 8000 });
      if (out && out.length > 0) {
        const parsed: unknown = JSON.parse(out);
        if (parsed && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>;
          const access = typeof rec.access === 'string'
            ? rec.access
            : typeof rec.access_token === 'string'
              ? rec.access_token
              : '';
          const expires = typeof rec.expires === 'number'
            ? rec.expires
            : typeof rec.expiresAtMs === 'number'
              ? rec.expiresAtMs
              : undefined;
          const refresh = typeof rec.refresh === 'string'
            ? rec.refresh
            : typeof rec.refresh_token === 'string'
              ? rec.refresh_token
              : undefined;
          const email = typeof rec.email === 'string' ? rec.email : undefined;
          const projectId = typeof rec.projectId === 'string' ? rec.projectId : undefined;
          if (access && isFresh(expires, now())) {
            return { token: access, source: 'omp-antigravity-oauth', expiresAtMs: expires, account: email, projectId };
          }
          if (refresh) {
            const refreshed = await refreshAntigravityToken(refresh, { fetchFn: deps.fetchJson as typeof fetch, now: deps.now });
            return { token: refreshed.access_token, source: 'omp-antigravity-oauth', expiresAtMs: refreshed.expiresAtMs, account: email, projectId };
          }
        }
      }
    } catch { /* omp db read is best-effort */ }
  }

  // 2. Check JSON file fallback (~/.antigravity/oauth_creds.json)
  const jsonPath = home('.antigravity/oauth_creds.json', deps.homeDir);
  if (exists(jsonPath)) {
    const data = readJson(jsonPath, read);
    if (data) {
      const access = typeof data.access_token === 'string'
        ? data.access_token
        : typeof data.access === 'string'
          ? data.access
          : '';
      const expiry = typeof data.expiry_date === 'number'
        ? data.expiry_date * 1000
        : typeof data.expires === 'number'
          ? data.expires
          : undefined;
      if (access && isFresh(expiry, now())) {
        return { token: access, source: 'antigravity-oauth', expiresAtMs: expiry };
      }
    }
  }

  return undefined;
}

/** TokenJuice API key: ~/.omp/agent/tokenjuice.key. */
export function tokenjuiceAmbientToken(deps: AmbientDeps = {}): AmbientToken | undefined {
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.existsSync ?? existsSync;
  const path = home('.omp/agent/tokenjuice.key', deps.homeDir);
  if (!exists(path)) return undefined;
  const key = read(path).trim();
  if (!key) return undefined;
  return { token: key, source: 'omp-tokenjuice-key' };
}
/** Kilo Code OAuth: ~/.omp/agent/agent.db (provider: 'kilo'). */
export async function kiloAmbientToken(deps: AmbientDeps = {}): Promise<AmbientToken | undefined> {
  const exists = deps.existsSync ?? existsSync;
  const now = deps.now ?? Date.now;
  const dbPath = home('.omp/agent/agent.db', deps.homeDir);
  if (!exists(dbPath)) return undefined;
  const execFile = deps.execFile ?? (async (cmd: string, args: string[]) => {
    const { execFile: ef } = await import('node:child_process');
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    ef(cmd, args, { timeout: 8000 }, (e, out) => (e ? reject(e) : resolve(String(out ?? '').trim())));
    return promise;
  });
  try {
    const out = await execFile('sqlite3', [
      dbPath,
      "SELECT data FROM auth_credentials WHERE provider = 'kilo' ORDER BY updated_at DESC LIMIT 1;",
    ], { timeout: 8000 });
    if (out) {
      const parsed: unknown = JSON.parse(out);
      if (parsed && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>;
        const access = typeof rec.access === 'string' ? rec.access : typeof rec.access_token === 'string' ? rec.access_token : '';
        const exp = typeof rec.expires === 'number' ? rec.expires : undefined;
        if (access && isFresh(exp, now())) {
          return { token: access, source: 'omp-kilo-oauth', expiresAtMs: exp };
        }
      }
    }
  } catch { /* best-effort */ }
  return undefined;
}


/** GitHub Models: `gh auth token` (GitHub CLI OAuth user session). */
export async function githubAmbientToken(deps: AmbientDeps = {}): Promise<AmbientToken | undefined> {
  const execFile = deps.execFile ?? (async (cmd: string, args: string[]) => {
    const { execFile: ef } = await import('node:child_process');
    return await new Promise<string>((res, rej) => ef(cmd, args, { timeout: 8000 }, (e, out) => (e ? rej(e) : res(String(out ?? '').trim()))));
  });
  try {
    const out = await execFile('gh', ['auth', 'token'], { timeout: 8000 } as { timeout?: number });
    const token = (out ?? '').trim();
    if (token) return { token, source: 'gh-cli-oauth' };
  } catch { /* gh not installed / not authed */ }
  return undefined;
}

/** Hugging Face: ~/.cache/huggingface/token or `hf auth token`. */
export function huggingfaceAmbientToken(deps: AmbientDeps = {}): AmbientToken | undefined {
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.existsSync ?? existsSync;
  const path = home('.cache/huggingface/token', deps.homeDir);
  if (exists(path)) {
    try {
      const token = read(path).trim();
      if (token) return { token, source: 'hf-cli-cache' };
    } catch { /* best-effort */ }
  }
  return undefined;
}
