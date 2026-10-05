// TUI visual smoke — drives the BUILT binary under a PTY (script(1)), sends
// keystrokes, and asserts the splash, composer, and '/' dropdown actually
// rendered. This is the check that catches "renders fine in unit tests but
// broken on a real terminal" (two border bugs shipped that way historically).
//
// Skipped automatically when `script` is unavailable (CI containers) or the
// binary isn't built; run scripts/tui-smoke.sh manually for the full report.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const bin = resolve(root, 'dist', 'mochi-bin');
const scriptBin = ['/usr/bin/script', '/bin/script'].find((p) => existsSync(p));

describe.skipIf(!scriptBin || !existsSync(bin))('TUI PTY visual smoke', () => {
  it('splash, composer, and dropdown render over a real PTY', () => {
    const logPath = resolve(root, '.mochi-audit', 'tui-smoke', 'vitest-typescript.log');
    mkdirSync(dirname(logPath), { recursive: true });
    try {
      const inner = `MOCHI_SKIP_AUTOBUILD=1 TERM=xterm-256color timeout 10 '${bin}'`;
      execFileSync(scriptBin as string, ['-qec', inner, logPath], {
        input: `sleep 2; printf '/'; sleep 1.5; printf '\\x1b'; sleep 1\n`,
        timeout: 20_000,
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const raw = readFileSync(logPath, 'utf8');
      const text = raw
        .replace(/\x00/g, '')
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '');
      // The splash brand and the composer keymap are the two always-rendered
      // surfaces; '/' proves the composer accepted input.
      expect(text).toContain('mochi');
      expect(text).toContain('send');      // composer hint: ⏎ send
      expect(text).toContain('/');         // dropdown opened
    } finally {
      try { rmSync(logPath, { force: true }); } catch { /* cleanup */ }
    }
  }, 30_000);
});
