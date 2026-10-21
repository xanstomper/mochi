// Broker lifecycle against a fake NDJSON daemon (no Playwright needed).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCall, initBrowserSession, closeBrowserSessions } from './session.js';

const fake = `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const out = { id: req.id, ok: true };
  if (req.cmd === 'init') { out.initialized = true; out.headless = req.args.headless; out.profileDir = req.args.profileDir; }
  if (req.cmd === 'navigate') { out.url = req.args.url; out.title = 'Fake page'; out.status = 200; }
  if (req.cmd === 'snapshot') { out.elements = [{ ref: 'e1', role: 'link', name: 'Go' }]; out.text = 'hello'; }
  if (req.cmd === 'boom') { out.ok = false; out.error = 'kaboom'; }
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

afterEach(() => closeBrowserSessions());

describe('browser session broker', () => {
  it('initializes once and reuses the same daemon across calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-broker-'));
    const script = join(dir, 'fake-daemon.mjs');
    writeFileSync(script, fake);
    process.env.MOCHI_BROWSER_DAEMON = script;
    const opts = { workspaceDir: dir, headless: true, profileDir: join(dir, 'profile') };
    const init = await initBrowserSession(opts);
    expect(init.ok).toBe(true);
    expect(init.initialized).toBe(true);
    expect(init.profileDir).toBe(opts.profileDir);
    const nav = await browserCall(opts, 'navigate', { url: 'https://example.com' });
    expect(nav.title).toBe('Fake page');
    const snap = await browserCall(opts, 'snapshot', {});
    expect(Array.isArray(snap.elements)).toBe(true);
    const err = await browserCall(opts, 'boom', {});
    expect(err.ok).toBe(false);
    expect(err.error).toBe('kaboom');
    delete process.env.MOCHI_BROWSER_DAEMON;
  }, 20_000);
});
