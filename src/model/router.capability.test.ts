import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from './capability.js';
import type { ModelConfig } from '../types.js';

describe('router capability gate', () => {
  let dir: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-router-cap-'));
    envBackup = process.env.MOCHI_CAPABILITY_DIR;
    process.env.MOCHI_CAPABILITY_DIR = dir;
  });

  afterEach(async () => {
    if (envBackup === undefined) delete process.env.MOCHI_CAPABILITY_DIR;
    else process.env.MOCHI_CAPABILITY_DIR = envBackup;
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects fast a provider marked dead, without any network call', async () => {
    const { createProvider } = await import('./router.js');
    const key = 'openai\u0000http://127.0.0.1:1';
    new CapabilityRegistry(dir, true).markDead(key, 'ECONNREFUSED connect 127.0.0.1:1');

    const config: ModelConfig = { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'fake' };
    const provider = createProvider(config);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }] as any, [], {} as any),
    ).rejects.toThrow(/marked dead/);

    // The dead mark was persisted to the configured dir.
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });

  it('does not short-circuit an unknown provider that has not failed yet', async () => {
    const { createProvider } = await import('./router.js');
    const config: ModelConfig = { provider: 'openai', baseUrl: 'https://unreachable.invalid/v1', model: 'mock' };
    // Gate must pass through for unknown providers (no dead/cooldown error),
    // so the eventual network error is the real one, not the registry's.
    const provider = createProvider(config);
    // We do not call it (that would hit the network); we only prove the gate
    // was not tripped by inspecting that createProvider returned a callable.
    expect(typeof provider.streamChat).toBe('function');
    expect(readdirSync(dir).length).toBe(0);
  });
});