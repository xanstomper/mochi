// `mochi browser …` CLI: login, status, probe, and session lifecycle.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserProbe, closeBrowserSessions, daemonNode, daemonScript, type BrowserResponse } from './session.js';
import { browserExecutable, browserProfilePath } from './options.js';
import { liveStatus, type LiveStatus } from './celeste.js';

/** Machine-readable shape of `mochi browser status --json`. Stable for scripts. */
export interface BrowserStatusReport {
  /** True when headless is OK AND live is either not applicable or connected. */
  ok: boolean;
  headless: {
    ok: boolean;
    browsers: string[];
    error?: string;
  };
  profile: {
    path: string;
    exists: boolean;
  };
  engine: string;
  live: LiveStatus;
  daemonScript: string;
}

/** Pure builder: assemble the structured status report from already-fetched
 *  probe + live values. Exported separately from runBrowserCli so a unit
 *  test can pin the shape without spawning the broker or hitting Celeste. */
export function buildBrowserStatusReport(pw: BrowserResponse, live: LiveStatus): BrowserStatusReport {
  return {
    ok: pw.ok && (!live.available || live.connected === true),
    headless: {
      ok: pw.ok,
      browsers: Array.isArray(pw.browsers) ? (pw.browsers as string[]) : [],
      error: pw.ok ? undefined : typeof pw.error === 'string' ? pw.error : undefined,
    },
    profile: {
      path: browserProfilePath(),
      exists: existsSync(browserProfilePath()),
    },
    engine: browserExecutable() ?? 'Playwright bundled Chromium',
    live: {
      ...live,
      connected: live.connected ?? false,
      detail: live.detail ?? undefined,
    },
    daemonScript: daemonScript(),
  };
}

let cachedHere: string | undefined;
function hereDir(): string {
  if (cachedHere === undefined) {
    try { cachedHere = resolve(dirname(fileURLToPath(import.meta.url))); }
    catch { cachedHere = process.cwd(); }
  }
  return cachedHere;
}

function loginScript(): string {
  const candidates = [
    resolve(hereDir(), '../../scripts/browser-login.mjs'),
    resolve(hereDir(), '../scripts/browser-login.mjs'),
    resolve(process.cwd(), 'scripts/browser-login.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => resolvePromise(code ?? 0));
    child.on('error', (err) => {
      console.error(`Failed to start ${cmd}: ${err.message}`);
      resolvePromise(1);
    });
  });
}

export async function runBrowserCli(positional: string[], flags: Record<string, unknown>): Promise<void> {
  const action = (positional[0] || 'status').toLowerCase();
  if (action === 'login' || action === 'auth') {
    const url = positional[1] || (typeof flags.url === 'string' ? flags.url : 'https://accounts.google.com');
    const profile = typeof flags.profile === 'string' ? flags.profile : browserProfilePath();
    console.log('Opening a real browser window for a one-time login…');
    const code = await runInteractive(daemonNode(), [loginScript(), url, profile]);
    process.exitCode = code;
    return;
  }
  if (action === 'status' || action === 'probe' || action === 'doctor') {
    const [pw, live] = await Promise.all([browserProbe(), liveStatus()]);
    const report = buildBrowserStatusReport(pw, live);
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log('Browser engines');
    console.log(`  headless playwright : ${pw.ok ? 'ready' : 'UNAVAILABLE'}${report.headless.browsers.length ? ` (${report.headless.browsers.join(', ')})` : ''}`);
    if (!pw.ok) console.log(`    ${String(pw.error ?? '')}\n    Install: npm i -g playwright && npx playwright install chromium`);
    console.log(`  persistent profile  : ${report.profile.path} (${report.profile.exists ? 'exists' : 'not created yet'})`);
    console.log(`  login/browser engine: ${report.engine}`);
    console.log(`  live (Celeste)      : ${live.available && live.connected ? `ready at ${live.base}` : `unavailable — ${live.detail ?? live.base}`}`);
    console.log(`  daemon script       : ${report.daemonScript}`);
    console.log('\nLog in once for Google Docs / Gmail: mochi browser login https://accounts.google.com');
    return;
  }
  if (action === 'close' || action === 'stop') {
    closeBrowserSessions();
    console.log('Closed Mochi browser sessions.');
    return;
  }
  if (action === 'help' || action === '--help' || action === '-h') {
    console.log('Usage: mochi browser <login [url] | status [--json] | close>');
    return;
  }
  console.error(`Unknown browser action "${action}". Use: login, status, close.`);
  process.exitCode = 1;
}
