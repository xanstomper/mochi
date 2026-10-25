import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrowserStatusReport, type BrowserStatusReport } from './cli.js';
import type { BrowserResponse } from './session.js';
import type { LiveStatus } from './celeste.js';

const workdir = mkdtempSync(join(tmpdir(), 'browser-cli-'));
beforeAll(() => {
  mkdirSync(join(workdir, '.mochi', 'browser'), { recursive: true });
  writeFileSync(join(workdir, '.mochi', 'browser', 'profile'), 'x');
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe('buildBrowserStatusReport', () => {
  const ok: BrowserResponse = { ok: true, browsers: ['chromium-1234'] };
  const down: BrowserResponse = { ok: false, error: 'ENOTFOUND playwright', browsers: [] };

  it('returns ok=true when headless is up and live is not applicable', () => {
    const live: LiveStatus = { available: false, base: 'http://127.0.0.1:9126' };
    const r = buildBrowserStatusReport(ok, live);
    expect(r.ok).toBe(true);
    expect(r.headless.ok).toBe(true);
    expect(r.headless.browsers).toEqual(['chromium-1234']);
    expect(r.headless.error).toBeUndefined();
    expect(r.live.available).toBe(false);
    expect(r.live.connected).toBe(false);
    expect(r.profile.path.length).toBeGreaterThan(0);
  });

  it('returns ok=false when headless is down and surfaces the error', () => {
    const live: LiveStatus = { available: false, base: 'http://127.0.0.1:9126' };
    const r = buildBrowserStatusReport(down, live);
    expect(r.ok).toBe(false);
    expect(r.headless.ok).toBe(false);
    expect(r.headless.error).toBe('ENOTFOUND playwright');
  });

  it('flags ok=false when live is reachable but disconnected', () => {
    const live: LiveStatus = { available: true, base: 'http://127.0.0.1:9126', connected: false, detail: 'no tabs' };
    const r = buildBrowserStatusReport(ok, live);
    expect(r.ok).toBe(false);
    expect(r.live.available).toBe(true);
    expect(r.live.connected).toBe(false);
    expect(r.live.detail).toBe('no tabs');
  });

  it('returns ok=true when live is reachable and connected', () => {
    const live: LiveStatus = { available: true, base: 'http://127.0.0.1:9126', connected: true };
    const r = buildBrowserStatusReport(ok, live);
    expect(r.ok).toBe(true);
    expect(r.live.connected).toBe(true);
  });

  it('coerces optional live.connected / live.detail to defaults', () => {
    const live: LiveStatus = { available: true, base: 'http://127.0.0.1:9126' };
    const r: BrowserStatusReport = buildBrowserStatusReport(ok, live);
    expect(r.live.connected).toBe(false);
    expect(r.live.detail).toBeUndefined();
  });

  it('surfaces the engine and daemonScript even when probe fails', () => {
    const live: LiveStatus = { available: false, base: 'http://127.0.0.1:9126' };
    const r = buildBrowserStatusReport(down, live);
    expect(typeof r.engine).toBe('string');
    expect(r.engine.length).toBeGreaterThan(0);
    expect(r.daemonScript.length).toBeGreaterThan(0);
  });
});
