// PTY smoke harness: launch the mochi TUI, drive it with keys, capture frames.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const dir = mkdtempSync(resolve(tmpdir(), 'mochi-tui-pty-'));
const proc = spawn('script', ['-qec', `cd ${dir} && git init -q && git config user.email d@d && git config user.name d && printf 'line1\\n' > a.txt && git add -A && git commit -qm init && printf 'line1\\nline2\\nline3\\n' > a.txt && bun /home/jewboy420/mochi/src/cli.ts tui`, '/dev/null'], {
  env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '100', LINES: '30' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let out = '';
const frames = [];
proc.stdout.on('data', (d) => { out += d.toString(); });

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

await wait(2500);
frames.push(['initial', out]); out = '';
proc.stdin.write('hello from pty');
await wait(600);
frames.push(['typed', out]); out = '';
proc.stdin.write('\t');          // plan mode toggle
await wait(400);
frames.push(['tab-plan', out]); out = '';
proc.stdin.write('/');
await wait(500);
frames.push(['dropdown', out]); out = '';
proc.stdin.write('\x1b');        // esc clears
await wait(300);
proc.stdin.write('\x1b');        // esc exit attempt (not busy → needs double esc)
await wait(300);
frames.push(['esc', out]); out = '';
proc.kill('SIGKILL');
await wait(300);

for (const [name, frame] of frames) {
  const plain = frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  console.log(`===== ${name} (${plain.length} chars) =====`);
  console.log(plain.split('\n').filter((l) => l.trim()).slice(0, 22).join('\n'));
}
rmSync(dir, { recursive: true, force: true });