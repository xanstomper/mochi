// `mochi browser …` CLI: login, status, probe, and session lifecycle.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserProbe, closeBrowserSessions, daemonNode, daemonScript } from './session.js';
import { browserExecutable, browserProfilePath } from './options.js';
import { liveStatus } from './celeste.js';
import { PINNED_SHELL, resolveCdpBrowserBinary } from './cdp/manager.js';
import { fetchCdpHeadlessShell, shellInstallInfo } from './cdp/fetch.js';

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
    const profile = browserProfilePath();
    const executable = browserExecutable();
    const [pw, live] = await Promise.all([browserProbe(), liveStatus()]);
    console.log('Browser engines');
    console.log(`  headless playwright : ${pw.ok ? 'ready' : 'UNAVAILABLE'}${Array.isArray(pw.browsers) && pw.browsers.length ? ` (${(pw.browsers as string[]).join(', ')})` : ''}`);
    if (!pw.ok) console.log(`    ${String(pw.error ?? '')}\n    Install: npm i -g playwright && npx playwright install chromium`);
    console.log(`  persistent profile  : ${profile} (${existsSync(profile) ? 'exists' : 'not created yet'})`);
    console.log(`  login/browser engine: ${executable ?? 'Playwright bundled Chromium'}`);
    console.log(`  live (Celeste)      : ${live.available && live.connected ? `ready at ${live.base}` : `unavailable — ${live.detail ?? live.base}`}`);
    // CDP-native stack: resolution only (a browser never launches here).
    try {
      const cdp = resolveCdpBrowserBinary(typeof flags.cdpExecutable === 'string' ? flags.cdpExecutable : undefined);
      const info = shellInstallInfo();
      console.log(`  cdp (headless shell): ${cdp.path} [${cdp.source}]${cdp.isHeadlessShell ? '' : ' (full chrome, --headless=new)'}`);
      if (info) console.log(`    pinned install fetched ${info.fetchedAt}`);
    } catch (err) {
      console.log(`  cdp (headless shell): UNAVAILABLE — ${(err as Error).message.split('.')[0]}.`);
      console.log(`    Install: mochi browser fetch-cdp-shell (pinned ${PINNED_SHELL.version}, checksum-verified)`);
    }
    console.log(`  daemon script       : ${daemonScript()}`);
    console.log('\nLog in once for Google Docs / Gmail: mochi browser login https://accounts.google.com');
    return;
  }
  if (action === 'fetch-cdp-shell' || action === 'fetch') {
    console.log(`Fetching pinned chrome-headless-shell ${PINNED_SHELL.version} (sha256-verified)…`);
    try {
      const res = await fetchCdpHeadlessShell({
        onProgress: (received) => console.log(`  … ${Math.round(received / (1024 * 1024))} MB`),
      });
      console.log(
        res.alreadyInstalled
          ? `already installed: ${res.path}`
          : `installed: ${res.path}\n  bytes: ${res.bytes}\n  sha256: ${res.sha256} (verified)`,
      );
    } catch (err) {
      console.error(`fetch failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (action === 'close' || action === 'stop') {
    closeBrowserSessions();
    console.log('Closed Mochi browser sessions.');
    return;
  }
  if (action === 'help' || action === '--help' || action === '-h') {
    console.log('Usage: mochi browser <login [url] | status | close | fetch-cdp-shell>');
    return;
  }
  console.error(`Unknown browser action "${action}". Use: login, status, close, fetch-cdp-shell.`);
  process.exitCode = 1;
}
