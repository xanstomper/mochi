// Ambient OAuth ingestion: codex/gemini/claude/gcloud token caches.
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  codexAmbientToken, geminiAmbientToken, claudeAmbientToken, gcloudAmbientToken, antigravityAmbientToken, tokenjuiceAmbientToken, kiloAmbientToken,
  type AmbientDeps,
} from './ambient-auth.js';

const FAKE_HOME = '/home/test';

function memFs(files: Record<string, string>): { deps: AmbientDeps; reads: string[]; abs: Record<string, string> } {
  const reads: string[] = [];
  const abs: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) abs[resolve(FAKE_HOME, k)] = v;
  const deps: AmbientDeps = {
    existsSync: (p) => p in abs,
    readFileSync: (p) => { reads.push(p); return abs[p] ?? ''; },
    writeFileSync: () => {},
    homeDir: FAKE_HOME,
  };
  return { deps, reads, abs };
}

describe('ambient-auth', () => {
  it('codex: returns cached access token when fresh', async () => {
    const { deps } = memFs({
      '.codex/auth.json': JSON.stringify({
        tokens: { access_token: 'sk-codex', refresh_token: 'r1' },
        last_refresh: new Date().toISOString(),
      }),
    });
    const t = await codexAmbientToken(deps);
    expect(t?.token).toBe('sk-codex');
    expect(t?.source).toBe('codex-oauth');
  });

  it('codex: refreshes when stale and persists new tokens', async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const { deps, abs } = memFs({
      '.codex/auth.json': JSON.stringify({ tokens: { access_token: 'old', refresh_token: 'r1' }, last_refresh: stale }),
    });
    const writes: Array<[string, string]> = [];
    const merged: AmbientDeps = {
      ...deps,
      writeFileSync: (p, d) => { writes.push([p, d]); abs[p] = d; },
      fetchJson: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }) }),
    };
    const t = await codexAmbientToken(merged);
    expect(t?.token).toBe('fresh');
    expect(writes.length).toBe(1);
    expect(JSON.parse(abs[resolve(FAKE_HOME, '.codex/auth.json')]).tokens.access_token).toBe('fresh');
  });

  it('codex: no token when refresh fails', async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const { deps } = memFs({
      '.codex/auth.json': JSON.stringify({ tokens: { access_token: 'old', refresh_token: 'r1' }, last_refresh: stale }),
    });
    const t = await codexAmbientToken({ ...deps, fetchJson: async () => ({ ok: false, status: 400, json: async () => ({}) }) });
    expect(t).toBeUndefined();
  });

  it('gemini: returns token when not expired', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { deps } = memFs({ '.gemini/oauth_creds.json': JSON.stringify({ access_token: 'g', expiry_date: future }) });
    expect(geminiAmbientToken(deps)?.token).toBe('g');
  });

  it('gemini: rejects expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const { deps } = memFs({ '.gemini/oauth_creds.json': JSON.stringify({ access_token: 'g', expiry_date: past }) });
    expect(geminiAmbientToken(deps)).toBeUndefined();
  });

  it('claude: returns token when not expired', () => {
    const future = Date.now() + 3600_000;
    const { deps } = memFs({ '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'c', expiresAt: future } }) });
    expect(claudeAmbientToken(deps)?.token).toBe('c');
  });

  it('gcloud: reads ADC file when fresh', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const { deps } = memFs({ '.config/gcloud/application_default_credentials.json': JSON.stringify({ access_token: 'adc', token_expiry: future }) });
    const t = await gcloudAmbientToken(deps);
    expect(t?.token).toBe('adc');
  });

  it('gcloud: falls back to gcloud CLI', async () => {
    const deps: AmbientDeps = {
      existsSync: () => false,
      execFile: async () => 'adc-cli-token',
    };
    const t = await gcloudAmbientToken(deps);
    expect(t?.token).toBe('adc-cli-token');
  });

  it('antigravity: reads omp agent.db credential when fresh', async () => {
    const future = Date.now() + 3600_000;
    const row = JSON.stringify({
      access: 'ya29.antigravity-token',
      refresh: '1//refresh-token',
      expires: future,
      projectId: 'aicode-consumers',
      email: 'test@example.com',
    });
    const { deps } = memFs({ '.omp/agent/agent.db': 'sqlite-stub' });
    const t = await antigravityAmbientToken({
      ...deps,
      execFile: async () => row,
    });
    expect(t?.token).toBe('ya29.antigravity-token');
    expect(t?.source).toBe('omp-antigravity-oauth');
    expect(t?.expiresAtMs).toBe(future);
  });

  it('antigravity: falls back to ~/.antigravity/oauth_creds.json when fresh', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { deps } = memFs({
      '.antigravity/oauth_creds.json': JSON.stringify({ access_token: 'antigravity-json-token', expiry_date: future }),
    });
    const t = await antigravityAmbientToken(deps);
    expect(t?.token).toBe('antigravity-json-token');
    expect(t?.source).toBe('antigravity-oauth');
  });

  it('antigravity: returns undefined when absent', async () => {
    const { deps } = memFs({});
    const t = await antigravityAmbientToken(deps);
    expect(t).toBeUndefined();
  });

  it('tokenjuice: reads ~/.omp/agent/tokenjuice.key', () => {
    const { deps } = memFs({ '.omp/agent/tokenjuice.key': 'tj_secret_key_123' });
    const t = tokenjuiceAmbientToken(deps);
    expect(t?.token).toBe('tj_secret_key_123');
    expect(t?.source).toBe('omp-tokenjuice-key');
  });

  it('kilo: reads ~/.omp/agent/agent.db where provider = kilo', async () => {
    const future = Date.now() + 3600_000;
    const row = JSON.stringify({ access: 'kilo-secret-token', expires: future });
    const { deps } = memFs({ '.omp/agent/agent.db': 'sqlite-stub' });
    const t = await kiloAmbientToken({ ...deps, execFile: async () => row });
    expect(t?.token).toBe('kilo-secret-token');
    expect(t?.source).toBe('omp-kilo-oauth');
  });
});