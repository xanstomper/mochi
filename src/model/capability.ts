import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Capability registry: the model's answer to "which endpoints can I actually
// trust?" Mirrors jcode's live-tests concept, but small, testable, and offline.
//
// Mochi's recurring failure mode was pointing at a provider that LOOKS
// configured (opencode/opencode-go) but is dead or misconfigured -- burning
// budget/retries against a brick before failing. Instead of re-hammering a
// known-bad endpoint every run, this registry persists what each provider can
// actually do and backs it off with a cooldown:
//
//   - record(ok=false) marks the provider failed with a growing cooldown.
//   - status() tells the harness whether it is mid-cooldown (skip fast) or
//     available (probe/use normally).
//   - A provider in cooldown is NOT hammered; it is reported and skipped so
//     the run falls back to a healthy provider without burning free tier.
//
// Pure state: deterministic, no network, unit-testable with a fake probe.

export type ProviderStatus = 'healthy' | 'ok' | 'cooldown' | 'dead' | 'unknown';

export interface CapabilityRecord {
  providerKey: string;
  status: ProviderStatus;
  lastOkAt?: number;
  lastFailAt?: number;
  lastError?: string;
  consecutiveFailures: number;
  retryAfterMs: number;
  cooldownUntil?: number;
  checks: Record<string, 'pass' | 'fail'>;
  updatedAt: number;
}

export type CapabilityProbe = (providerKey: string) => Promise<'ok'>;

const DEFAULT_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000; // 5m ceiling per provider, per cooldown round

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function describeError(message: string): string {
  return message.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? 'unknown error';
}

export class CapabilityRegistry {
  private memory = new Map<string, CapabilityRecord>();

  constructor(
    private registryDir: string,
    private persist = true,
  ) {}

  private path(key: string): string {
    return resolve(this.registryDir, `${safeKey(key)}.json`);
  }

  private read(key: string): CapabilityRecord | undefined {
    const cached = this.memory.get(key);
    if (cached) return cached;
    if (!this.persist) return undefined;
    const p = this.path(key);
    if (!existsSync(p)) return undefined;
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8')) as CapabilityRecord;
      this.memory.set(key, rec);
      return rec;
    } catch {
      return undefined;
    }
  }

  private write(key: string, rec: CapabilityRecord): void {
    this.memory.set(key, rec);
    if (!this.persist) return;
    if (!existsSync(this.registryDir)) mkdirSync(this.registryDir, { recursive: true });
    writeFileSync(this.path(key), JSON.stringify(rec, null, 2));
  }

  /** Current status of a provider: dead (known-broken/never worked),
   *  cooldown (backing off), unknown (no history), ok/healthy (recent success). */
  status(key: string, now = Date.now()): { status: ProviderStatus; record?: CapabilityRecord } {
    const rec = this.read(key);
    if (!rec) return { status: 'unknown' };
    if (rec.status === 'dead') return { status: 'dead', record: rec };
    if (rec.cooldownUntil && now < rec.cooldownUntil) {
      return { status: 'cooldown', record: rec };
    }
    return { status: rec.status === 'ok' || rec.status === 'healthy' ? 'ok' : 'unknown', record: rec };
  }

  /** Record a probe/request outcome. ok=false escalates a bounded cooldown;
   *  ok=true heals the record. */
  record(
    key: string,
    outcome: { ok: boolean; error?: string; check?: string },
    now = Date.now(),
  ): CapabilityRecord {
    const rec: CapabilityRecord =
      this.read(key) ?? {
        providerKey: key,
        status: 'unknown',
        consecutiveFailures: 0,
        retryAfterMs: DEFAULT_BACKOFF_MS,
        checks: {},
        updatedAt: now,
      };
    if (outcome.ok) {
      rec.status = 'ok';
      rec.lastOkAt = now;
      rec.consecutiveFailures = 0;
      rec.retryAfterMs = DEFAULT_BACKOFF_MS;
      rec.cooldownUntil = undefined;
      if (outcome.check) rec.checks[outcome.check] = 'pass';
    } else {
      rec.status = 'cooldown';
      rec.lastFailAt = now;
      rec.consecutiveFailures += 1;
      if (outcome.error) rec.lastError = describeError(outcome.error);
      if (outcome.check) rec.checks[outcome.check] = 'fail';
      rec.cooldownUntil = now + Math.min(rec.retryAfterMs * 2 ** (rec.consecutiveFailures - 1), MAX_BACKOFF_MS);
      rec.retryAfterMs = Math.min(rec.retryAfterMs * 2, MAX_BACKOFF_MS);
    }
    rec.updatedAt = now;
    this.write(key, rec);
    return rec;
  }

  /** Mark a provider as permanently broken (dead endpoint / refused
   *  connection / bad auth) with a long cooldown so it is skipped, not hit. */
  markDead(provider: string, reason: string, now = Date.now()): CapabilityRecord {
    const rec: CapabilityRecord =
      this.read(provider) ?? {
        providerKey: provider,
        status: 'unknown',
        consecutiveFailures: 0,
        retryAfterMs: DEFAULT_BACKOFF_MS,
        checks: {},
        updatedAt: now,
      };
    rec.status = 'dead';
    rec.lastError = describeError(reason);
    rec.cooldownUntil = now + 30 * 60_000; // re-probe after 30 min
    rec.consecutiveFailures = Math.max(rec.consecutiveFailures, 3);
    rec.updatedAt = now;
    this.write(provider, rec);
    return rec;
  }
}

/** Derive a stable registry key from a provider + base URL (normalizes
 *  trailing slash). */
export function providerKey(provider: string, baseUrl: string): string {
  return `${provider}\u0000${baseUrl.replace(/\/+$/, '')}`;
}

/** Run a cheap capability probe against a provider and record the outcome.
 *  Skips immediately if the provider is mid-cooldown or dead (no budget burn).
 *  The probe is injected so tests use a fake; in production it is a 1-shot
 *  non-streaming /models (or trivial completion) retried via rate-limit.ts.
 */
export async function probeAndRecord(
  registry: CapabilityRegistry,
  probe: CapabilityProbe,
  key: string,
  now = Date.now(),
): Promise<{ status: ProviderStatus; record?: CapabilityRecord }> {
  const current = registry.status(key, now);
  if (current.status === 'cooldown' || current.status === 'dead') return current;
  try {
    await probe(key);
    registry.record(key, { ok: true, check: 'probe' }, now);
  } catch (err) {
    registry.record(key, { ok: false, error: err instanceof Error ? err.message : String(err), check: 'probe' }, now);
  }
  return registry.status(key, now);
}