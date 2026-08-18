import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Termix integration. Termix is a lightweight GTK3+VTE multi-terminal workspace
// (tabs, split panes, regex search, Catppuccin dark theme) — a single Python
// file, no Electron/web runtime. Mochi launches it as the visual companion
// terminal and can seed a compatible config. Returns operational strings so the
// CLI can print exactly what happened.

const GIT_URL = process.env.TERMIX_GO_URL || 'https://github.com/xanstomper/termix.git';
const DEFAULT_DIR = resolve(homedir(), 'termix');
const CONFIG_PATH = resolve(homedir(), '.config/termix/config.json');

const DEFAULT_CONFIG = {
  theme: { bg: '#0F0F15', fg: '#E0DEF4', accent: '#F5A0C0' },
  behavior: { scrollback: 10000, cursor_blink: true },
};

function which(bin: string): Promise<boolean> {
  return new Promise((r) => execFile('sh', ['-c', `command -v ${bin}`], { timeout: 5000 }, (e) => r(!e)));
}

export interface TermixResult { launched: boolean; location?: string; message: string; }

/** Find an installed termix script on PATH. */
export async function findTermix(): Promise<string | null> {
  if (await which('termix')) return 'termix';
  if (existsSync(join(DEFAULT_DIR, 'termix'))) return join(DEFAULT_DIR, 'termix');
  return null;
}

/** Ensure a default config exists (auto-created by Termix anyway). */
export function ensureConfig(): string {
  try {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(resolve(homedir(), '.config/termix'), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return CONFIG_PATH;
    }
    return CONFIG_PATH;
  } catch {
    return CONFIG_PATH;
  }
}

async function clone(cloneDir: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile('git', ['clone', '--depth', '1', GIT_URL, cloneDir], { timeout: 120000 }, (err) =>
      err ? reject(new Error(`git clone failed: ${err.message}`)) : resolvePromise());
  });
}

function launch(loc: string): boolean {
  // Launch detached so the terminal keeps running independent of `mochi`.
  try {
    const child = execFile('sh', ['-c', `${JSON.stringify(loc)} >/dev/null 2>&1 &`]);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure Termix is available (install to ~/localix when missing and CLI passes
 * `install: true`), write a default config, then launch it.
 */
export async function termix(opts: { mode?: 'launch' | 'install'; autoInstall?: boolean } = {}): Promise<TermixResult> {
  const config = ensureConfig();
  let loc = await findTermix();

  const autoInstall = opts.autoInstall ?? (opts.mode === 'install');
  if (!loc && autoInstall) {
    try {
      await clone(DEFAULT_DIR);
      loc = join(DEFAULT_DIR, 'termix');
    } catch (e) {
      return { launched: false, message: `Termix not installed and auto-install failed: ${e instanceof Error ? e.message : e}` };
    }
  }

  if (!loc) {
    return {
      launched: false,
      message: `Termix not found on PATH. Run 'python3 -m pip install termix' or install it, then set PATH, or re-run with --install to clone it to ~/termix. Config: ${config}`,
    };
  }

  const launched = launch(loc);
  return {
    launched,
    location: loc,
    message: launched
      ? `Launched Termix (${loc}). Config: ${config}`
      : `Termix found at ${loc} but failed to launch. Config: ${config}`,
  };
}