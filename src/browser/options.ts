// Shared browser session options for every browser-backed tool.
//
// Keeping this in one place means `browser`, `docs`, `email`, and `canvas`
// all share the SAME persistent profile — log into Google once and every
// workflow sees the session.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mochiStateDir } from '../core/mochi-dir.js';
import type { BrowserSessionOptions } from './session.js';

export function browserProfilePath(): string {
  return process.env.MOCHI_BROWSER_PROFILE || join(homedir(), '.mochi', 'browser', 'profile');
}

/** Prefer the same real Chromium-family browser the login helper opens, so the
 *  encrypted cookie profile it writes can actually be decrypted later. The
 *  previous daemon defaulted to Playwright's bundled Chromium while login
 *  defaulted to Brave — different OSCrypt keys, so a Google login never
 *  carried over. Env still wins. */
export function browserExecutable(): string | undefined {
  const env = process.env.MOCHI_BROWSER_EXECUTABLE;
  if (env) return env;
  const candidates = process.platform === 'win32'
    ? [
      join(process.env.PROGRAMFILES || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    ]
    : process.platform === 'darwin'
      ? [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
      : [
        '/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser',
      ];
  return candidates.find((p) => p && existsSync(p));
}

export function browserOptions(cwd: string, overrides: Partial<BrowserSessionOptions> = {}): BrowserSessionOptions {
  const root = resolve(cwd);
  const state = mochiStateDir(root);
  return {
    workspaceDir: root,
    statePath: resolve(state, 'browser', 'state.json'),
    downloadDir: resolve(state, 'browser', 'downloads'),
    profileDir: browserProfilePath(),
    ...(browserExecutable() ? { executablePath: browserExecutable() } : {}),
    headless: process.env.MOCHI_BROWSER_HEADED !== '1',
    ...overrides,
  };
}
