// Credential pool: multi-key rotation for resilience against 401/429.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { nextKey, retireKey, poolKeys, inspectPool } from './credential-pool.js';

const OLD_ENV = { ...process.env };

describe('credential pool', () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('MOCHI_') || k === 'OPENCODE_ZEN_API_KEY') delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('reads multiple keys from a single env var and pools them', () => {
    process.env['OPENCODE_ZEN_API_KEY'] = 'key-A,key-B, key-C';
    const pool = poolKeys('opencode-zen');
    expect(pool).toContain('key-A');
    expect(pool).toContain('key-B');
    expect(pool).toContain('key-C');
  });

  it('round-robins different keys on successive requests', () => {
    process.env['OPENCODE_ZEN_API_KEY'] = 'pool-1,pool-2,pool-3';
    const a = nextKey('opencode-zen', null);
    const b = nextKey('opencode-zen', null);
    expect(a.key).not.toBe(b.key);
  });

  it('skips a retired key during cooldown', () => {
    process.env['OPENCODE_ZEN_API_KEY'] = 'rot-a,rot-b';
    retireKey('opencode-zen', 'rot-a', 100_000);
    const k = nextKey('opencode-zen', 'rot-a');
    expect(k.key).toBe('rot-b');
  });

  it('returns the current key when no pool is configured', () => {
    // No env set: fallback to the provided current key.
    const k = nextKey('opencode-zen', 'single-key');
    expect(k.key).toBe('single-key');
  });

  it('inspect returns masked active key + sources', async () => {
    process.env['OPENCODE_ZEN_API_KEY'] = 'sk-long-secret-123456789';
    const info = await inspectPool('opencode-zen', 'sk-long-secret-123456789');
    expect(info.sources).toContain('env');
    expect(info.active).toMatch(/^sk-l.+6789$/);
    expect(info.has).toBeGreaterThanOrEqual(1);
  });
});