// Real X11 display backend (Phase E12) — a dependency-free X11 wire
// protocol client over the local Unix socket.
//
// Why wire protocol instead of linking libX11 or shelling out to
// xdotool/scrot: the repo ships zero runtime dependencies, this machine has
// no Rust toolchain to extend the native core and no X utilities installed,
// and the protocol subset needed here is small and stable: setup +
// GetImage (capture), QueryPointer/WarpPointer (pointer), GetKeyboardMapping
// (keysym→keycode), and the XTEST extension's FakeInput (keys/buttons).
// The same subset is exercised end-to-end against Xvfb in x11-display.test.ts.
//
// v1 scope limits (deliberate): local displays only (unix socket), root
// window capture at depth 24/32, keys found at keyboard-mapping levels 0/1
// (unshifted/shifted). Anything outside that throws a precise error.

import { connect, type Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { keysymForName, type DisplayBackend, type DisplayInfo, type PointerState } from './display.js';

const OP = {
  getImage: 73,
  queryPointer: 38,
  warpPointer: 41,
  getInputFocus: 43,
  queryExtension: 98,
  getKeyboardMapping: 101,
} as const;

const EV = { keyPress: 2, keyRelease: 3, buttonPress: 4, buttonRelease: 5 } as const;

// ---------------------------------------------------------------------------
// DISPLAY parsing + Xauthority
// ---------------------------------------------------------------------------

export interface ParsedDisplay {
  /** Display number, e.g. 99 for ":99". */
  number: number;
  screen: number;
  socketPath: string;
  original: string;
}

export function parseDisplay(display: string): ParsedDisplay {
  const m = /^(?:unix|[^:]+)?:(\d+)(?:\.(\d+))?$/.exec(display.trim());
  const hostPart = display.split(':')[0];
  if (!m || (hostPart && hostPart !== 'unix' && hostPart !== 'localhost')) {
    throw new Error(`x11: unsupported DISPLAY "${display}" — v1 supports local displays only (":99", "unix:99")`);
  }
  const number = Number(m[1]);
  return {
    number,
    screen: m[2] ? Number(m[2]) : 0,
    socketPath: `/tmp/.X11-unix/X${number}`,
    original: display,
  };
}

/** Read the MIT-MAGIC-COOKIE-1 for a display from an Xauthority file. */
export function readXAuthorityCookie(file: string, displayNumber: number): Buffer | null {
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch {
    return null;
  }
  let off = 0;
  const readU16 = () => {
    if (off + 2 > data.length) throw new Error('truncated');
    const v = data.readUInt16BE(off);
    off += 2;
    return v;
  };
  const readBytes = () => {
    const len = readU16();
    if (off + len > data.length) throw new Error('truncated');
    const b = data.subarray(off, off + len);
    off += len;
    return b;
  };
  try {
    while (off < data.length) {
      readU16(); // family
      readBytes(); // address
      const num = readBytes().toString('ascii');
      const name = readBytes().toString('ascii');
      const secret = readBytes();
      if (name === 'MIT-MAGIC-COOKIE-1' && num === String(displayNumber)) return Buffer.from(secret);
    }
  } catch {
    return null;
  }
  return null;
}

function authForDisplay(parsed: ParsedDisplay): { name: string; data: Buffer } | null {
  const file = process.env.XAUTHORITY || resolve(homedir(), '.Xauthority');
  if (!existsSync(file)) return null;
  const cookie = readXAuthorityCookie(file, parsed.number);
  return cookie ? { name: 'MIT-MAGIC-COOKIE-1', data: cookie } : null;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

interface SetupInfo {
  root: number;
  rootWidth: number;
  rootHeight: number;
  rootDepth: number;
  minKeycode: number;
  maxKeycode: number;
}

interface PendingReply {
  resolve: (reply: Buffer) => void;
  reject: (err: Error) => void;
}

class X11Error extends Error {
  constructor(
    readonly code: number,
    readonly major: number,
    readonly minor: number,
    readonly badValue: number,
  ) {
    super(`X11 error code=${code} (request ${major}.${minor}, bad value ${badValue})`);
  }
}

class XConnection {
  private sock: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, PendingReply>();
  private strayErrors: X11Error[] = [];
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** False during the setup handshake (raw byte stream), true once packets
   *  are 32-byte framed and the pump may parse replies/errors/events. */
  private pumping = false;
  private readWaiters: Array<() => void> = [];

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      if (this.pumping) this.pump();
      for (const w of this.readWaiters.splice(0)) w();
    });
    sock.on('error', (e) => this.failAll(e));
    sock.on('close', () => this.failAll(new Error('x11: connection closed')));
  }

  static async connect(parsed: ParsedDisplay): Promise<{ conn: XConnection; setup: SetupInfo }> {
    const sock = connect(parsed.socketPath);
    await new Promise<void>((res, rej) => {
      const onErr = (e: Error) => rej(new Error(`x11: cannot connect to ${parsed.original} (${parsed.socketPath}): ${e.message} — is an X server running?`));
      sock.once('connect', () => { sock.off('error', onErr); res(); });
      sock.once('error', onErr);
    });
    const conn = new XConnection(sock);
    const setup = await conn.handshake(parsed);
    return { conn, setup };
  }

  private async handshake(parsed: ParsedDisplay): Promise<SetupInfo> {
    const auth = authForDisplay(parsed);
    const nameBuf = auth ? Buffer.from(auth.name, 'ascii') : Buffer.alloc(0);
    const dataBuf = auth ? auth.data : Buffer.alloc(0);
    const pad4 = (n: number) => (4 - (n % 4)) % 4;
    const req = Buffer.alloc(12 + nameBuf.length + pad4(nameBuf.length) + dataBuf.length + pad4(dataBuf.length));
    req[0] = 0x6c; // 'l' little-endian
    req.writeUInt16LE(11, 2);
    req.writeUInt16LE(0, 4);
    req.writeUInt16LE(nameBuf.length, 6);
    req.writeUInt16LE(dataBuf.length, 8);
    nameBuf.copy(req, 12);
    dataBuf.copy(req, 12 + nameBuf.length + pad4(nameBuf.length));

    this.sock.write(req);
    const head = await this.readBytes(8, 5000);
    if (head[0] === 0) {
      const reasonLen = head[1];
      const len = head.readUInt16LE(6) * 4;
      const rest = await this.readBytes(len, 5000);
      throw new Error(`x11: connection refused by server: ${rest.subarray(0, reasonLen).toString('utf8')} — check the Xauthority cookie for display ${parsed.original}`);
    }
    if (head[0] !== 1) throw new Error(`x11: unexpected setup reply byte ${head[0]}`);
    const extraLen = head.readUInt16LE(6) * 4;
    const body = await this.readBytes(extraLen, 5000);
    // Body layout: release(4) ridBase(4) ridMask(4) motionBuf(4)
    // vendorLen(2)@16 maxReqLen(2) numRoots(1)@20 numFormats(1)@21
    // imgByteOrder(1) bitmapBitOrder(1) scanUnit(1) scanPad(1)
    // minKc(1)@26 maxKc(1)@27 unused(4), vendor string @32 (4-padded),
    // then 8-byte pixmap formats, then screens.
    const vendorLen = body.readUInt16LE(16);
    const numRoots = body[20];
    const numFormats = body[21];
    const minKeycode = body[26];
    const maxKeycode = body[27];
    let off = 32 + Math.ceil(vendorLen / 4) * 4 + numFormats * 8;
    const screens: SetupInfo[] = [];
    for (let s = 0; s < numRoots; s++) {
      // Screen: root(4) colormap(4) white(4) black(4) masks(4) wPx(2)@20
      // hPx(2)@22 wMm(2) hMm(2) minMaps(2) maxMaps(2) rootVisual(4)@32
      // backing(1)@36 saveUnders(1) rootDepth(1)@38 numDepths(1)@39, depths @40.
      const root = body.readUInt32LE(off);
      const rootWidth = body.readUInt16LE(off + 20);
      const rootHeight = body.readUInt16LE(off + 22);
      const rootDepth = body[off + 38];
      const numDepths = body[off + 39];
      let dOff = off + 40;
      for (let d = 0; d < numDepths; d++) {
        const visuals = body.readUInt16LE(dOff + 2);
        dOff += 8 + visuals * 24;
      }
      screens.push({ root, rootWidth, rootHeight, rootDepth, minKeycode, maxKeycode });
      off = dOff;
    }
    const screen = screens[parsed.screen] ?? screens[0];
    if (!screen) throw new Error('x11: server reported no screens');
    this.pumping = true;
    this.pump();
    return screen;
  }

  /** Read exactly n bytes from the pre-packet stream (setup phase only). */
  private async readBytes(n: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('x11: timed out waiting for server setup reply');
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => rejectWait(new Error('x11: timed out waiting for server setup reply')), remaining);
        this.readWaiters.push(() => { clearTimeout(timer); resolveWait(); });
      });
    }
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  private pump(): void {
    for (;;) {
      if (this.buf.length < 32) return;
      const kind = this.buf[0];
      if (kind === 0) {
        const err = new X11Error(this.buf[1], this.buf[11], this.buf.readUInt16LE(8), this.buf.readUInt32LE(4));
        const seq = this.buf.readUInt16LE(2);
        const waiter = this.pending.get(seq);
        this.buf = this.buf.subarray(32);
        if (waiter) {
          this.pending.delete(seq);
          waiter.reject(err);
        } else {
          this.strayErrors.push(err);
        }
        continue;
      }
      if (kind === 1) {
        const extra = this.buf.readUInt32LE(4) * 4;
        if (this.buf.length < 32 + extra) return;
        const seq = this.buf.readUInt16LE(2);
        const reply = Buffer.from(this.buf.subarray(0, 32 + extra));
        this.buf = this.buf.subarray(32 + extra);
        const waiter = this.pending.get(seq);
        if (waiter) {
          this.pending.delete(seq);
          waiter.resolve(reply);
        }
        continue;
      }
      // Event packet: fixed 32 bytes, except generic events (35) which
      // carry a length at offset 4 (in 4-byte units, total size).
      if (kind === 35) {
        const total = this.buf.readUInt32LE(4) * 4;
        if (total < 32 || this.buf.length < total) return;
        this.buf = this.buf.subarray(total);
      } else {
        this.buf = this.buf.subarray(32);
      }
    }
  }

  private failAll(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.pending.values()) w.reject(e);
    this.pending.clear();
  }

  /** Serialize request round-trips so sequences never interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.then(() => undefined, () => undefined);
    return p;
  }

  /** Send a request that expects a 32+n-byte reply. */
  requestReply(bytes: Buffer): Promise<Buffer> {
    return this.run(() => new Promise<Buffer>((resolveReq, rejectReq) => {
      if (this.closed) { rejectReq(new Error('x11: connection closed')); return; }
      this.seq = (this.seq + 1) & 0xffff;
      const mySeq = this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(mySeq);
        rejectReq(new Error('x11: request timed out'));
      }, 15000);
      this.pending.set(mySeq, {
        resolve: (r) => { clearTimeout(timer); resolveReq(r); },
        reject: (e) => { clearTimeout(timer); rejectReq(e); },
      });
      this.sock.write(bytes);
    }));
  }

  /** Send a fire-and-forget request; errors surface at the next sync(). */
  request(bytes: Buffer): Promise<void> {
    return this.run(async () => {
      if (this.closed) throw new Error('x11: connection closed');
      this.seq = (this.seq + 1) & 0xffff;
      this.sock.write(bytes);
    });
  }

  /** Roundtrip that flushes pending errors from fire-and-forget requests. */
  async sync(): Promise<void> {
    await this.requestReply(getInputFocusRequest());
    if (this.strayErrors.length) {
      const err = this.strayErrors[0];
      this.strayErrors = [];
      throw err;
    }
  }

  close(): void {
    this.closed = true;
    try { this.sock.destroy(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function requestHeader(opcode: number, dataByte: number, lengthUnits: number, bodyLen: number): Buffer {
  const b = Buffer.alloc(bodyLen);
  b[0] = opcode;
  b[1] = dataByte;
  b.writeUInt16LE(lengthUnits, 2);
  return b;
}

function getInputFocusRequest(): Buffer {
  return requestHeader(OP.getInputFocus, 0, 1, 4);
}

function queryExtensionRequest(name: string): Buffer {
  const nameBuf = Buffer.from(name, 'ascii');
  const padded = Math.ceil(nameBuf.length / 4) * 4;
  const b = requestHeader(OP.queryExtension, 0, (8 + padded) / 4, 8 + padded);
  b.writeUInt16LE(nameBuf.length, 4);
  nameBuf.copy(b, 8);
  return b;
}

function xtestVersionRequest(xtestOpcode: number): Buffer {
  const b = requestHeader(xtestOpcode, 0, 2, 8);
  b[4] = 2; // client major version
  b.writeUInt16LE(2, 6); // client minor version
  return b;
}

function fakeInputRequest(xtestOpcode: number, type: number, detail: number, root: number, x: number, y: number): Buffer {
  const b = requestHeader(xtestOpcode, 2, 9, 36);
  b[4] = type;
  b[5] = detail;
  b.writeUInt32LE(0, 8); // time = CurrentTime
  b.writeUInt32LE(root, 12);
  b.writeInt16LE(x, 24);
  b.writeInt16LE(y, 26);
  b[35] = 0; // deviceid: core device
  return b;
}

function warpPointerRequest(root: number, x: number, y: number): Buffer {
  const b = requestHeader(OP.warpPointer, 0, 6, 24);
  b.writeUInt32LE(0, 4); // srcWindow = None
  b.writeUInt32LE(root, 8);
  b.writeInt16LE(x, 20);
  b.writeInt16LE(y, 22);
  return b;
}

function queryPointerRequest(root: number): Buffer {
  const b = requestHeader(OP.queryPointer, 0, 2, 8);
  b.writeUInt32LE(root, 4);
  return b;
}

function getImageRequest(root: number, w: number, h: number): Buffer {
  const b = requestHeader(OP.getImage, 2, 5, 20); // format 2 = ZPixmap
  b.writeUInt32LE(root, 4);
  b.writeUInt16LE(w, 12);
  b.writeUInt16LE(h, 14);
  b.writeUInt32LE(0xffffffff, 16);
  return b;
}

function getKeyboardMappingRequest(first: number, count: number): Buffer {
  const b = requestHeader(OP.getKeyboardMapping, 0, 2, 8);
  b[4] = first;
  b[5] = count;
  return b;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

interface KeyTarget {
  keycode: number;
  shift: boolean;
}

export class X11DisplayBackend implements DisplayBackend {
  readonly kind = 'x11' as const;
  private conn: XConnection | null = null;
  private setup: SetupInfo | null = null;
  private xtestOpcode = 0;
  private keymap: Map<number, KeyTarget> | null = null;
  private shiftKeycode = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(private readonly display: string) {}

  private async ensure(): Promise<{ conn: XConnection; setup: SetupInfo }> {
    if (this.conn && this.setup) return { conn: this.conn, setup: this.setup };
    const parsed = parseDisplay(this.display);
    const { conn, setup } = await XConnection.connect(parsed);
    this.conn = conn;
    this.setup = setup;
    // Resolve the XTEST extension; without it there is no input injection.
    const extReply = await conn.requestReply(queryExtensionRequest('XTEST'));
    if (extReply[8] !== 1) {
      conn.close();
      this.conn = null;
      throw new Error('x11: XTEST extension not present on this server — cannot inject input');
    }
    this.xtestOpcode = extReply[9];
    await conn.requestReply(xtestVersionRequest(this.xtestOpcode));
    const p = await this.pointer();
    this.lastX = p.x;
    this.lastY = p.y;
    return { conn, setup };
  }

  async info(): Promise<DisplayInfo> {
    const { setup } = await this.ensure();
    return { width: setup.rootWidth, height: setup.rootHeight, label: `x11 ${this.display}` };
  }

  async captureRgba(): Promise<Buffer> {
    const { conn, setup } = await this.ensure();
    const { rootWidth: w, rootHeight: h, rootDepth } = setup;
    if (rootDepth !== 24 && rootDepth !== 32) {
      throw new Error(`x11: capture requires root depth 24 or 32, server reports ${rootDepth}`);
    }
    const reply = await conn.requestReply(getImageRequest(setup.root, w, h));
    const data = reply.subarray(32);
    const stride = Math.floor(data.length / h);
    if (stride < w * 4) throw new Error(`x11: GetImage returned too little data (${data.length} bytes for ${w}x${h})`);
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      let src = y * stride;
      let dst = y * w * 4;
      for (let x = 0; x < w; x++) {
        // LSBFirst images store B,G,R,(X) per 32-bit pixel.
        rgba[dst] = data[src + 2];
        rgba[dst + 1] = data[src + 1];
        rgba[dst + 2] = data[src];
        rgba[dst + 3] = 255;
        src += 4;
        dst += 4;
      }
    }
    return rgba;
  }

  async pointer(): Promise<PointerState> {
    const { conn, setup } = await this.ensure();
    const reply = await conn.requestReply(queryPointerRequest(setup.root));
    // Reply: root@8 child@12 rootX(2)@16 rootY(2)@18 winX@20 winY@22 mask(2)@24.
    const x = reply.readInt16LE(16);
    const y = reply.readInt16LE(18);
    const mask = reply.readUInt16LE(24);
    this.lastX = x;
    this.lastY = y;
    return { x, y, mask };
  }

  async movePointer(x: number, y: number): Promise<void> {
    const { conn, setup } = await this.ensure();
    const cx = clamp(Math.round(x), 0, setup.rootWidth - 1);
    const cy = clamp(Math.round(y), 0, setup.rootHeight - 1);
    await conn.request(warpPointerRequest(setup.root, cx, cy));
    await conn.sync();
    this.lastX = cx;
    this.lastY = cy;
  }

  async button(button: number, pressed: boolean): Promise<void> {
    const { conn, setup } = await this.ensure();
    const type = pressed ? EV.buttonPress : EV.buttonRelease;
    await conn.request(fakeInputRequest(this.xtestOpcode, type, button, setup.root, this.lastX, this.lastY));
    await conn.sync();
  }

  private async loadKeymap(): Promise<Map<number, KeyTarget>> {
    if (this.keymap) return this.keymap;
    const { conn, setup } = await this.ensure();
    const count = setup.maxKeycode - setup.minKeycode + 1;
    const reply = await conn.requestReply(getKeyboardMappingRequest(setup.minKeycode, count));
    const perKeycode = reply[1];
    const map = new Map<number, KeyTarget>();
    for (let i = 0; i < count; i++) {
      const keycode = setup.minKeycode + i;
      const base = 32 + i * perKeycode * 4;
      const level0 = reply.readUInt32LE(base);
      const level1 = perKeycode > 1 ? reply.readUInt32LE(base + 4) : 0;
      if (level0 === 0xffe1 || level0 === 0xffe2) this.shiftKeycode = keycode;
      if (level0 && !map.has(level0)) map.set(level0, { keycode, shift: false });
      if (level1 && !map.has(level1)) map.set(level1, { keycode, shift: true });
    }
    this.keymap = map;
    return map;
  }

  async key(name: string, pressed: boolean): Promise<void> {
    const { conn, setup } = await this.ensure();
    const keysym = keysymForName(name);
    if (keysym === null) throw new Error(`x11: unknown key "${name}"`);
    const keymap = await this.loadKeymap();
    const target = keymap.get(keysym);
    if (!target) throw new Error(`x11: no keycode maps to keysym 0x${keysym.toString(16)} (key "${name}") on this layout`);
    if (target.shift && this.shiftKeycode) {
      if (pressed) await conn.request(fakeInputRequest(this.xtestOpcode, EV.keyPress, this.shiftKeycode, setup.root, this.lastX, this.lastY));
      await conn.request(fakeInputRequest(this.xtestOpcode, pressed ? EV.keyPress : EV.keyRelease, target.keycode, setup.root, this.lastX, this.lastY));
      if (!pressed) await conn.request(fakeInputRequest(this.xtestOpcode, EV.keyRelease, this.shiftKeycode, setup.root, this.lastX, this.lastY));
    } else {
      await conn.request(fakeInputRequest(this.xtestOpcode, pressed ? EV.keyPress : EV.keyRelease, target.keycode, setup.root, this.lastX, this.lastY));
    }
    await conn.sync();
  }

  async close(): Promise<void> {
    this.conn?.close();
    this.conn = null;
    this.setup = null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
