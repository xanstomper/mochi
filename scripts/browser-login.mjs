#!/usr/bin/env node
// Interactive login helper: launches a REAL window with Mochi's persistent
// browser profile so the user can sign in to Google/GitHub/SSO once. The
// profile (and therefore the session) is reused by every later headless
// browser, docs, and email call.
//
// Usage: node browser-login.mjs [url] [profileDir]
// Env: MOCHI_BROWSER_PROFILE, MOCHI_BROWSER_EXECUTABLE
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';

function globalRoot() {
  if (process.env.MOCHI_BROWSER_NODE_MODULES) return process.env.MOCHI_BROWSER_NODE_MODULES;
  try {
    const out = execSync('npm root -g', { encoding: 'utf8', timeout: 4000 }).trim();
    if (out) return out;
  } catch { /* ignore */ }
  return path.join(os.homedir(), '.npm-global', 'lib', 'node_modules');
}

let pw;
for (const candidate of [path.join(globalRoot(), 'playwright', 'index.mjs'), path.join(process.cwd(), 'node_modules/playwright/index.mjs')]) {
  try { pw = await import(candidate); break; } catch { /* next */ }
}
if (!pw) {
  console.error('playwright is not installed. Run: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

function findBrowser() {
  if (process.env.MOCHI_BROWSER_EXECUTABLE) return process.env.MOCHI_BROWSER_EXECUTABLE;
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.env.PROGRAMFILES || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    ]
    : process.platform === 'darwin'
      ? [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
      : [
        '/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      ];
  return candidates.find((p) => p && fs.existsSync(p)) || undefined;
}

const url = process.argv[2] || 'https://accounts.google.com';
const profileDir = process.argv[3] || process.env.MOCHI_BROWSER_PROFILE || path.join(os.homedir(), '.mochi', 'browser', 'profile');
fs.mkdirSync(profileDir, { recursive: true });

const executablePath = findBrowser();
console.log(`Profile: ${profileDir}`);
console.log(`Browser: ${executablePath || 'Playwright bundled Chromium'}`);
console.log('A browser window is opening. Sign in, then come back here and press Enter.\n');

let context;
try {
  context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    executablePath,
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
} catch (e) {
  console.error(`Could not launch a browser: ${e.message}`);
  console.error('If the profile is locked, close other Mochi browser sessions and retry.');
  process.exit(1);
}

const page = context.pages()[0] || await context.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.bringToFront();
} catch (e) {
  console.warn(`Could not open ${url}: ${e.message}`);
}

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Press Enter when you are done signing in… ', () => { rl.close(); resolve(); });
});

try {
  // Persist cookies/localStorage explicitly as well as the profile itself.
  const statePath = path.join(path.dirname(profileDir), 'state.json');
  await context.storageState({ path: statePath });
  console.log(`Saved session state: ${statePath}`);
} catch { /* profile itself already persists */ }
await context.close().catch(() => {});
console.log('Done. Mochi will reuse this login for browser, docs, and email.');
