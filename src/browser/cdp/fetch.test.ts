import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PINNED_LIGHTPANDA } from './manager.js';
import { fetchLightpanda, installedLightpandaPath, lightpandaInstallInfo } from './fetch.js';

// Unit tests for the Lightpanda fetch step's LOCAL pieces (cache layout,
// marker readback, idempotent already-installed path). The network path is
// exercised by the explicit `mochi browser fetch-lightpanda` command, never
// in tests.

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('PINNED_LIGHTPANDA — pin invariants', () => {
  it('pins one version with a checksummed asset per upstream platform', () => {
    expect(PINNED_LIGHTPANDA.version).toBe('0.3.7');
    const keys = Object.keys(PINNED_LIGHTPANDA.assets).sort();
    expect(keys).toEqual(['aarch64-linux', 'aarch64-macos', 'x86_64-linux', 'x86_64-macos']);
    for (const a of Object.values(PINNED_LIGHTPANDA.assets)) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.bytes).toBeGreaterThan(1_000_000);
      expect(a.url).toContain(`/download/${PINNED_LIGHTPANDA.version}/`);
    }
  });
});

describe('fetchLightpanda — cache layout + idempotence (no network)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mochi-cdp-lp-fetch-'));
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('installedLightpandaPath: absent when not installed, found when it is', () => {
    withEnv({ MOCHI_CDP_CACHE_DIR: join(tmp, 'empty') }, () => {
      expect(installedLightpandaPath()).toBeUndefined();
    });
    const dir = join(tmp, 'cache', `lightpanda-${PINNED_LIGHTPANDA.version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lightpanda'), '#!/bin/sh\nexit 0\n');
    withEnv({ MOCHI_CDP_CACHE_DIR: join(tmp, 'cache') }, () => {
      expect(installedLightpandaPath()).toBe(join(dir, 'lightpanda'));
    });
  });

  it('already-installed returns the verified pin without touching the network', async () => {
    const dir = join(tmp, 'cache2', `lightpanda-${PINNED_LIGHTPANDA.version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lightpanda'), 'binary');
    writeFileSync(join(dir, 'INSTALLATION_COMPLETE'), JSON.stringify({ version: PINNED_LIGHTPANDA.version, fetchedAt: 'x' }));
    withEnv({ MOCHI_CDP_CACHE_DIR: join(tmp, 'cache2') }, async () => {
      const res = await fetchLightpanda();
      expect(res.alreadyInstalled).toBe(true);
      expect(res.version).toBe(PINNED_LIGHTPANDA.version);
      expect(res.sha256).toBe(PINNED_LIGHTPANDA.assets['x86_64-linux'].sha256);
      expect(res.path.endsWith('/lightpanda')).toBe(true);
    });
  });

  it('lightpandaInstallInfo reads the marker back; undefined without one', () => {
    withEnv({ MOCHI_CDP_CACHE_DIR: join(tmp, 'cache3') }, () => {
      expect(lightpandaInstallInfo()).toBeUndefined();
    });
    const dir = join(tmp, 'cache3', `lightpanda-${PINNED_LIGHTPANDA.version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INSTALLATION_COMPLETE'), JSON.stringify({ version: PINNED_LIGHTPANDA.version, asset: 'x86_64-linux', fetchedAt: '2026-10-24T00:00:00.000Z' }));
    withEnv({ MOCHI_CDP_CACHE_DIR: join(tmp, 'cache3') }, () => {
      expect(lightpandaInstallInfo()).toMatchObject({ version: PINNED_LIGHTPANDA.version, asset: 'x86_64-linux' });
    });
  });
});
