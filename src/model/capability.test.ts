import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry, providerKey, probeAndRecord } from './capability.js';

describe('CapabilityRegistry', () => {
  let dir: string;
  let reg: CapabilityRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-cap-'));
    reg = new CapabilityRegistry(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts unknown and becomes ok after a success', () => {
    const key = providerKey('freeinference', 'https://freeinference.org/v1');
    expect(reg.status(key).status).toBe('unknown');
    reg.record(key, { ok: true, check: 'models' });
    expect(reg.status(key).status).toBe('ok');
  });

  it('puts a failing provider into cooldown with growing backoff', () => {
    const key = 'p';
    const t0 = 1_000_000;
    reg.record(key, { ok: false, error: '429 rate limited', check: 'chat' }, t0);
    let st = reg.status(key, t0 + 1);
    expect(st.status).toBe('cooldown');

    // Within cooldown it stays cooldown even after more time before expiry.
    reg.record(key, { ok: false, error: 'still failing', check: 'chat' }, t0 + 100_000);
    st = reg.status(key, t0 + 100_001);
    expect(st.status).toBe('cooldown');
    expect(st.record!.consecutiveFailures).toBe(2);
    expect(st.record!.cooldownUntil!).toBeGreaterThan(st.record!.lastFailAt!);
  });

  it('is not dead and can heal once the cooldown elapses and a success lands', () => {
    const key = 'p';
    const t0 = 1_000_000;
    reg.record(key, { ok: false, check: 'chat' }, t0);
    // Shortly after the failure it is backing off.
    expect(reg.status(key, t0 + 1).status).toBe('cooldown');
    // Far past the cooldown (default 5s) it is no longer cooldown, and not dead.
    const later = t0 + 60 * 60 * 1000;
    expect(reg.status(key, later).status).toBe('unknown');
    // A fresh success heals it to ok.
    reg.record(key, { ok: true, check: 'chat' }, later + 1);
    expect(reg.status(key).status).toBe('ok');
  });

  it('marks permanently dead providers that keep failing and are explicit', () => {
    const key = 'bad';
    reg.markDead(key, 'ECONNREFUSED connect 127.0.0.1:1');
    const st = reg.status(key);
    expect(st.status).toBe('dead');
    expect(st.record!.lastError).toContain('ECONNREFUSED');
  });
});

describe('probeAndRecord', () => {
  it('does not probe a provider already in cooldown', async () => {
    let dir = mkdtempSync(join(tmpdir(), 'mochi-cap2-'));
    const reg = new CapabilityRegistry(dir);
    reg.record('p', { ok: false }, 1_000_000);
    let probed = 0;
    const res = await probeAndRecord(reg, async () => { probed++; return 'ok'; }, 'p', 1_000_001);
    expect(probed).toBe(0); // in cooldown: no budget burn
    expect(res.status).toBe('cooldown');
    rmSync(dir, { recursive: true, force: true });
  });

  it('records probe failure and success', async () => {
    let dir = mkdtempSync(join(tmpdir(), 'mochi-cap3-'));
    const reg = new CapabilityRegistry(dir);
    const t = 2_000_000;
    // failure
    await probeAndRecord(reg, async () => { throw new Error('boom'); }, 'x', t);
    expect(reg.status('x', t).status).toBe('cooldown');
    // later success
    const t2 = t + 60_000;
    await probeAndRecord(reg, async () => 'ok', 'x', t2);
    expect(reg.status('x', t2).status).toBe('ok');
    rmSync(dir, { recursive: true, force: true });
  });
});