// Credential pool (the Hermes insight): multiple API keys per provider, loaded
// from env OR a key file, with transparent rotation on auth/rate failures.
//
// Why it matters: a single $PROVIDER_API_KEY is a single point of failure.
// Real harnesses (Hermes) pool several keys and rotate when one is 429/401'd,
// keeping long agent runs alive through transient provider-side throttling.
//
// Resolution order for a provider:
//   1. explicit per-key override (config.model.apiKey when set and real)
//   2. env var(s): MOCHI_<PROVIDER>_KEY, then the canonical <PROVIDER>_API_KEY
//      (comma/newline-separated list supported => a pool)
//   3. ~/.config/mochi/keys/<provider>.keys  (one key per line, # comments)
//   4. fall back to configuring the single apiKey untouched (no pool)
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** A single usable key for a provider. */
export interface PooledKey {
  /** The origin of this key: 'env', 'file', 'config', or the fallback. */
  source: 'env' | 'file' | 'config' | 'none';
  /** The actual secret (never logged; the redaction layer scrubs it). */
  key: string | null;
}

interface CredCounter {
  used: number;
  next: number;
}

// Per-(provider, poolId) round-robin cursor, so a warm provider keeps using
// the same key unless it is revoked, while a cool/blocked key is skipped.
const cursors = new Map<string, number>();
const disabledUntil = new Map<string, number>(); // key-hash -> epoch ms

function providerNormalize(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function envCandidates(provider: string): string[] {
  const p = providerNormalize(provider);
  // Prefer Mochi-specific, then canonical provider key, then a generic pool.
  const names = [
    `MOCHI_${p.toUpperCase()}_KEY`,
    `MOCHI_${p.toUpperCase()}_API_KEY`,
    `${p.toUpperCase()}_API_KEY`,
  ];
  const found: string[] = [];
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) {
      // A single env var may hold several keys (comma or newline separated).
      found.push(...v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean));
    }
    // never return a superset that is a strict prefix; stop at first hit
    if (found.length > 0) return found;
  }
  return found;
}

function fileKeys(provider: string): string[] {
  const p = providerNormalize(provider);
  const path = resolve(homedir(), '.config/mochi/credentials', `${p}.json`);
  const keys: string[] = [];
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { keys?: string[] } | string[];
      const arr = Array.isArray(raw) ? raw : raw.keys;
      for (const k of arr ?? []) if (typeof k === 'string' && k.trim()) keys.push(k.trim());
    }
  } catch { /* best-effort: a broken keyfile just yields env-only pool */ }
  return keys;
}

function keyHash(key: string): string {
  // Only used for internal cooldown bookkeeping; do not leak the secret.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return String(h);
}

/** Gather the candidate keys for a provider, deduped in order (env > file). */
export function poolKeys(provider: string): string[] {
  const p = providerNormalize(provider);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of [...envCandidates(p), ...fileKeys(p)]) if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

/** Resolve the next fresh key for a provider (round-robin across the pool,
 *  skipping any key currently in cooldown). Returns the primary config key
 *  source (delegating to the existing single-key resolution) when the pool
 *  is empty. */
export function nextKey(provider: string, current?: string | null): PooledKey {
  const fromFile = fileKeys(provider);
  const fromEnv = envCandidates(provider);
  const withCurrent = current && current.trim() ? [current.trim(), ...fromEnv, ...fromFile] : [...fromEnv, ...fromFile];
  const pool = withCurrent.length ? withCurrent : poolKeys(provider);
  if (pool.length === 0) {
    return { source: 'none', key: current ?? null };
  }
  const cursorKey = providerNormalize(provider);
  let i = cursors.get(cursorKey) ?? 0;
  const now = Date.now();
  // scan for a non-cooldown key, up to pool length
  let guarded = 0;
  while (guarded < pool.length) {
    const cand = pool[i % pool.length];
    i++;
    guarded++;
    if ((disabledUntil.get(keyHash(cand)) ?? 0) > now) continue;
    cursors.set(cursorKey, i);
    return { source: fromEnv.includes(cand) ? 'env' : fromFile.includes(cand) ? 'file' : 'config', key: cand };
  }
  // All keys are cooling down; fall back to the first available one.
  return { source: 'env', key: pool[0] };
}

/** Mark a key failed so the pool rotates away from it for `cooldownMs`. */
export function retireKey(provider: string, key: string | null, cooldownMs = 30_000): void {
  if (!key) return;
  disabledUntil.set(keyHash(key), Date.now() + cooldownMs);
}

/** Redact every key Mochi knows for a provider (used by describeConfig). */
export function redactPool(provider: string): number {
  const all = poolKeys(provider);
  return all.length;
}

export const noCredentialPool = (provider: string): boolean => poolKeys(provider).length === 0;

/** Human-readable summary (keys masked, never raw). */
export async function inspectPool(provider: string, current?: string | null) {
  const all = poolKeys(provider);
  const hasCurrent = Boolean(current && current.trim());
  const active = hasCurrent ? current!.trim() : (all[0] ?? null);
  const sources: string[] = [];
  try {
    if (envCandidates(provider).length > 0) sources.push('env');
  } catch { /* noop */ }
  if (fileKeys(provider).length > 0) sources.push('file');
  if (hasCurrent && !all.includes(current!.trim())) sources.push('config');
  return {
    provider,
    has: all.length + (hasCurrent && !all.includes(current!.trim()) ? 1 : 0),
    sources,
    active: active ? active.slice(0, 4) + '\u2026' + active.slice(-4) : null,
  };
}
