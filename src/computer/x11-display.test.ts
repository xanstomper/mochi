// X11 display backend tests (computer bridge, Phase E12).
//
// Unit tests (display parsing, Xauthority cookie extraction) always run.
// The live suite spawns a real Xvfb server and drives the actual wire
// protocol end-to-end — connect, capture the root window, warp the
// pointer and read it back, inject buttons/keys via XTEST. It is skipped
// (not failed) when no Xvfb binary exists on the machine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { X11DisplayBackend, parseDisplay, readXAuthorityCookie } from './x11-display.js';
import { encodePngRgba, decodePngRgba } from './png.js';

describe('parseDisplay', () => {
  it('parses local display forms', () => {
    expect(parseDisplay(':99')).toMatchObject({ number: 99, screen: 0, socketPath: '/tmp/.X11-unix/X99' });
    expect(parseDisplay(':0.1')).toMatchObject({ number: 0, screen: 1 });
    expect(parseDisplay('unix:2')).toMatchObject({ number: 2, screen: 0 });
  });

  it('rejects remote displays (v1 is local-socket only)', () => {
    expect(() => parseDisplay('otherhost:10')).toThrow(/local displays only/);
    expect(() => parseDisplay('not-a-display')).toThrow(/local displays only/);
  });
});

describe('readXAuthorityCookie', () => {
  it('extracts the MIT-MAGIC-COOKIE-1 for the matching display number', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-xauth-'));
    try {
      const entry = (num: string, name: string, secret: Buffer) => {
        const parts: Buffer[] = [];
        const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); parts.push(b); };
        const bytes = (b: Buffer) => { u16(b.length); parts.push(b); };
        u16(256); // FamilyLocal
        bytes(Buffer.from('myhost'));
        bytes(Buffer.from(num, 'ascii'));
        bytes(Buffer.from(name, 'ascii'));
        bytes(secret);
        return Buffer.concat(parts);
      };
      const cookie = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
      const file = resolve(dir, 'Xauthority');
      writeFileSync(file, Buffer.concat([
        entry('98', 'MIT-MAGIC-COOKIE-1', Buffer.alloc(16, 9)),
        entry('99', 'MIT-MAGIC-COOKIE-1', cookie),
        entry('99', 'XDM-AUTHORIZATION-1', Buffer.alloc(16, 7)),
      ]));
      expect(readXAuthorityCookie(file, 99)?.equals(cookie)).toBe(true);
      expect(readXAuthorityCookie(file, 42)).toBeNull();
      expect(readXAuthorityCookie(resolve(dir, 'missing'), 99)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live Xvfb suite
// ---------------------------------------------------------------------------

function findXvfb(): string | null {
  try {
    return execFileSync('which', ['Xvfb'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const XVFB = findXvfb();
const live = XVFB ? describe : describe.skip;

live('x11 backend against a real Xvfb server', () => {
  let proc: ChildProcess | null = null;
  let backend: X11DisplayBackend;
  let displayNum = 0;

  /** A display is usable when nothing live owns it. Stale socket/lock
   *  files from killed Xvfb processes (SIGKILL leaves them behind) refuse
   *  connections — reclaim those; a socket that ACCEPTS a connection has
   *  a live owner and is skipped. */
  async function claimFreeDisplay(): Promise<number> {
    for (let n = 90; n < 120; n++) {
      const socketPath = `/tmp/.X11-unix/X${n}`;
      const lockPath = `/tmp/.X${n}-lock`;
      if (!existsSync(socketPath) && !existsSync(lockPath)) return n;
      const live = await new Promise<boolean>((res) => {
        const s = connect(socketPath);
        s.once('connect', () => { s.destroy(); res(true); });
        s.once('error', () => res(false));
        setTimeout(() => { s.destroy(); res(false); }, 500);
      });
      if (live) continue;
      try { unlinkSync(socketPath); } catch { /* already gone */ }
      try { unlinkSync(lockPath); } catch { /* already gone */ }
      return n;
    }
    throw new Error('no free display number for Xvfb test');
  }

  beforeAll(async () => {
    displayNum = await claimFreeDisplay();
    proc = spawn(XVFB!, [`:${displayNum}`, '-screen', '0', '1024x768x24', '-ac', '-nolisten', 'tcp'], { stdio: 'ignore' });
    const socketPath = `/tmp/.X11-unix/X${displayNum}`;
    const deadline = Date.now() + 8000;
    while (!existsSync(socketPath)) {
      if (Date.now() > deadline) throw new Error('Xvfb did not create its socket in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    backend = new X11DisplayBackend(`:${displayNum}`);
  }, 20000);

  afterAll(async () => {
    await backend?.close();
    proc?.kill('SIGTERM');
    proc?.kill('SIGKILL');
  });

  it('reports the real display geometry', async () => {
    const info = await backend.info();
    expect(info.width).toBe(1024);
    expect(info.height).toBe(768);
    expect(info.label).toContain(`:${displayNum}`);
  }, 20000);

  it('captures the root window (fresh Xvfb root is black)', async () => {
    const rgba = await backend.captureRgba();
    expect(rgba.length).toBe(1024 * 768 * 4);
    let nonBlack = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] > 8 || rgba[i + 1] > 8 || rgba[i + 2] > 8) nonBlack++;
    }
    expect(nonBlack / (1024 * 768)).toBeLessThan(0.01);
    // And the frame encodes to a valid PNG of the same geometry.
    const decoded = decodePngRgba(encodePngRgba(1024, 768, rgba));
    expect(decoded.width).toBe(1024);
    expect(decoded.rgba.equals(rgba)).toBe(true);
  }, 20000);

  it('warps the pointer and reads the new position back', async () => {
    await backend.movePointer(300, 200);
    const p = await backend.pointer();
    expect(p.x).toBe(300);
    expect(p.y).toBe(200);
    await backend.movePointer(0, 0);
    const p2 = await backend.pointer();
    expect(p2.x).toBe(0);
    expect(p2.y).toBe(0);
  }, 20000);

  it('injects button presses visible in the pointer mask', async () => {
    await backend.movePointer(100, 100);
    await backend.button(1, true);
    const held = await backend.pointer();
    expect(held.mask & 0x100).toBe(0x100); // Button1Mask
    await backend.button(1, false);
    const released = await backend.pointer();
    expect(released.mask & 0x100).toBe(0);
  }, 20000);

  it('injects keys, including the shifted level via the keymap', async () => {
    await backend.key('a', true);
    await backend.key('a', false);
    await backend.key('A', true); // shift-level keysym on the same keycode
    await backend.key('A', false);
    await backend.key('Return', true);
    await backend.key('Return', false);
    await expect(backend.key('definitely-not-a-key', true)).rejects.toThrow(/unknown key/);
  }, 20000);
});
