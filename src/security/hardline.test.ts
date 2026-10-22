// Hardline floor: catastrophic shell commands are refused under EVERY
// policy (yolo/unattended included); normal destructive-ish dev work is not.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { matchHardline } from './hardline.js';
import { runShellString } from '../exec.js';
import { shellTool } from '../tools/shell.js';

describe('matchHardline (pure)', () => {
  it('matches the catastrophic set', () => {
    const bad: Array<[string, string]> = [
      ['rm -rf /', 'rm-recursive-on-root-or-home'],
      ['rm -rf /*', 'rm-recursive-on-root-or-home'],
      ['rm -rf ~', 'rm-recursive-on-root-or-home'],
      ['rm -rf ~/*', 'rm-recursive-on-root-or-home'],
      ['rm -rf $HOME', 'rm-recursive-on-root-or-home'],
      ['sudo rm -rf /', 'rm-recursive-on-root-or-home'],
      ['cd /tmp && rm -rf /', 'rm-recursive-on-root-or-home'],
      ['rm -rf --no-preserve-root /', 'rm-recursive-on-root-or-home'],
      ['mkfs.ext4 /dev/sda1', 'mkfs'],
      ['mkfs /dev/sda', 'mkfs'],
      ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd-to-block-device'],
      ['dd if=img.raw of=/dev/nvme0n1', 'dd-to-block-device'],
      [':(){ :|:& };:', 'fork-bomb'],
      ['bomb(){ bomb|bomb& };bomb', 'fork-bomb'],
      ['shutdown -h now', 'host-poweroff'],
      ['reboot', 'host-poweroff'],
      ['sudo poweroff', 'host-poweroff'],
      ['chmod -R 777 /', 'chmod-recursive-777-root'],
      ['echo pwned > /etc/passwd', 'overwrite-etc-passwd-shadow'],
      ['echo pwned >> /etc/shadow', 'overwrite-etc-passwd-shadow'],
      ['cp /tmp/x /etc/passwd', 'overwrite-etc-passwd-shadow'],
    ];
    for (const [cmd, label] of bad) {
      expect(matchHardline(cmd), cmd).toBe(label);
    }
  });

  it('does NOT match normal dev commands', () => {
    const ok = [
      'rm -rf node_modules',
      'rm -rf ./dist',
      'rm -rf dist build .next',
      'rm -rf /tmp/mochi-build-cache',
      'rm -rf ~/project/dist',
      'rm file.txt',
      'rm -r build',
      'git rm -r --cached .',
      'dd if=input.img of=./disk.img bs=1M',
      'dd if=/dev/zero of=/dev/null count=1',
      'chmod -R 755 .',
      'chmod 777 script.sh',
      'chmod -R 777 /tmp/scratch',
      'npm run build',
      'echo shutdown > notes.txt',
      'grep -r reboot src/',
      'cat /etc/passwd',
      'node server.js',
      '',
    ];
    for (const cmd of ok) {
      expect(matchHardline(cmd), cmd).toBeNull();
    }
  });
});

describe('hardline enforcement at the shell chokepoints', () => {
  it('runShellString refuses a hardline command without executing it (even though nothing else gates this path)', async () => {
    // dd to a NON-EXISTENT block device: harmless if it ever slipped through
    // (dd fails with "no such device"), catastrophic class by pattern.
    const r = await runShellString('dd if=/dev/zero of=/dev/sdz9 bs=1 count=1', { timeoutMs: 5000 });
    expect(r.code).toBe(126);
    expect(r.stderr).toContain('hardline');
    expect(r.stderr).toContain('dd-to-block-device');
  }, 20_000);

  it('runShellString still runs rm -rf on a normal relative dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-hardline-ok-'));
    const nm = join(dir, 'node_modules');
    mkdirSync(nm, { recursive: true });
    try {
      const r = await runShellString('rm -rf node_modules', { cwd: dir, timeoutMs: 10_000 });
      expect(r.code).toBe(0);
      expect(existsSync(nm)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('shell tool throws on a hardline command before any spawn (background path included)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-hardline-tool-'));
    try {
      const ctx = { cwd: dir, config: { safety: { mode: 'auto', commandTimeoutSeconds: 10 } } } as never;
      const fg = await shellTool.execute({ command: 'mkfs.ext4 /dev/null' }, ctx).then(() => null, (e: Error) => e);
      expect(fg).toBeInstanceOf(Error);
      expect((fg as Error).message).toContain('hardline');
      // Background commands bypass exec.ts (direct spawn in
      // background-tasks.ts) — the tool gate must catch them too.
      const bg = await shellTool.execute({ command: 'mkfs.ext4 /dev/null', background: true }, ctx).then(() => null, (e: Error) => e);
      expect(bg).toBeInstanceOf(Error);
      expect((bg as Error).message).toContain('hardline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('shell tool runs rm -rf node_modules normally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-hardline-tool-ok-'));
    const nm = join(dir, 'node_modules');
    mkdirSync(nm, { recursive: true });
    try {
      const out = await shellTool.execute(
        { command: 'rm -rf node_modules' },
        { cwd: dir, config: { safety: { mode: 'auto', commandTimeoutSeconds: 10 } } } as never,
      );
      expect(out).toContain('exit_code: 0');
      expect(existsSync(resolve(dir, 'node_modules'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
