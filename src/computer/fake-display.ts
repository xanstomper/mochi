// Deterministic in-memory display backend for tests (Phase E12).
//
// Renders a synthetic framebuffer with pure functions of backend state —
// no clocks, no randomness — so the same action sequence always produces
// byte-identical screenshots, and different actions (pointer move, typing,
// clicks) produce observably different frames:
//  - background: a fixed gradient + 100px grid
//  - a "window" rectangle whose color cycles with the injected-action count
//  - typed characters drawn as unique 5x7 bit-cells from their char codes
//  - the pointer drawn as a crosshair block at its current position
//
// It implements the real DisplayBackend contract, so tool-level tests
// exercise the exact action→screenshot path the X11 backend serves.

import { keysymForName, type DisplayBackend, type DisplayInfo, type PointerState } from './display.js';
import { FakeAppWidgets } from './fake-app.js';
import type { DesktopAxNode } from '../a11y/tree.js';

export interface FakeDisplayOptions {
  /** Opt-in interactive fake app (see fake-app.ts): adds a fixed widget
   *  layout with hit-tested clicks, keyboard focus, an a11y() tree, and
   *  deterministic widget rendering. Default OFF — without it this backend
   *  is byte-for-byte the passive surface it always was. */
  app?: boolean | { receiptUrl?: string };
}

export class FakeDisplayBackend implements DisplayBackend {
  readonly kind = 'fake' as const;
  readonly width: number;
  readonly height: number;

  private px = 0;
  private py = 0;
  private buttonsDown = new Set<number>();
  private actions = 0;
  private typed = '';
  private readonly app?: FakeAppWidgets;

  /** Test introspection: every key press/release as "name:down"/"name:up". */
  readonly keyLog: string[] = [];
  /** Test introspection: every button event as "b<n>:down"/"b<n>:up". */
  readonly buttonLog: string[] = [];

  constructor(width = 800, height = 600, opts: FakeDisplayOptions = {}) {
    this.width = width;
    this.height = height;
    this.px = Math.floor(width / 2);
    this.py = Math.floor(height / 2);
    if (opts.app) {
      this.app = new FakeAppWidgets(opts.app === true ? {} : opts.app);
    }
  }

  async info(): Promise<DisplayInfo> {
    return { width: this.width, height: this.height, label: `fake ${this.width}x${this.height}` };
  }

  async pointer(): Promise<PointerState> {
    let mask = 0;
    for (const b of this.buttonsDown) mask |= 1 << (7 + b); // X11 Button1Mask=0x100 …
    return { x: this.px, y: this.py, mask };
  }

  async movePointer(x: number, y: number): Promise<void> {
    this.px = clamp(Math.round(x), 0, this.width - 1);
    this.py = clamp(Math.round(y), 0, this.height - 1);
    this.actions++;
  }

  async button(button: number, pressed: boolean): Promise<void> {
    if (pressed && button === 1 && this.app) {
      this.app.pointerDown(this.px, this.py);
    }
    if (pressed) this.buttonsDown.add(button);
    else this.buttonsDown.delete(button);
    this.buttonLog.push(`b${button}:${pressed ? 'down' : 'up'}`);
    this.actions++;
  }

  async key(name: string, pressed: boolean): Promise<void> {
    const keysym = keysymForName(name);
    if (keysym === null) throw new Error(`fake-display: unknown key "${name}"`);
    this.keyLog.push(`${name}:${pressed ? 'down' : 'up'}`);
    if (pressed) {
      // The focused fake-app textbox consumes the key; without the app (or
      // focus) the key lands in the global typed buffer as before.
      if (!(this.app?.keyDown(name) ?? false)) {
        if (name.length === 1) this.typed += name;
        else if (name.toLowerCase() === 'space') this.typed += ' ';
        else if (name.toLowerCase() === 'backspace') this.typed = this.typed.slice(0, -1);
      }
    }
    this.actions++;
  }

  async close(): Promise<void> { /* nothing to release */ }

  /** Desktop a11y source (DisplayBackend.a11y?): empty without the app. */
  a11y(): DesktopAxNode[] {
    return this.app ? this.app.a11y() : [];
  }

  /** Test introspection: the fake app, when enabled. */
  get fakeApp(): FakeAppWidgets | undefined { return this.app; }

  /** What has been "typed" so far (test introspection). */
  get typedText(): string { return this.typed; }

  async captureRgba(): Promise<Buffer> {
    const { width: w, height: h } = this;
    const frame = Buffer.alloc(w * h * 4);
    // Background: diagonal gradient + grid lines every 100px.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const grid = x % 100 === 0 || y % 100 === 0;
        frame[i] = grid ? 90 : Math.floor((x / Math.max(1, w)) * 60) + 20;
        frame[i + 1] = grid ? 90 : Math.floor((y / Math.max(1, h)) * 60) + 20;
        frame[i + 2] = grid ? 90 : 70;
        frame[i + 3] = 255;
      }
    }
    // "Window" rect: color is a pure function of the action count, so any
    // injected action visibly changes the next screenshot.
    const hue = (this.actions * 47) % 360;
    const [wr, wg, wb] = hslToRgb(hue, 0.55, 0.45);
    fillRect(frame, w, h, 60, 60, 320, 200, wr, wg, wb);
    // Typed text: 5x7 bit-cells derived from char codes, strip at (16, 16).
    let cx = 16;
    let cy = 16;
    for (const ch of this.typed) {
      drawCharCell(frame, w, h, cx, cy, ch);
      cx += 8;
      if (cx + 8 > w - 8) { cx = 16; cy += 10; if (cy + 10 > h - 8) break; }
    }
    // The fake app's widgets (when enabled) render under the pointer.
    this.app?.draw(frame, w, h);
    // Pointer crosshair (drawn last so it is always visible).
    drawCrosshair(frame, w, h, this.px, this.py);
    return frame;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function fillRect(frame: Buffer, w: number, h: number, x0: number, y0: number, rw: number, rh: number, r: number, g: number, b: number): void {
  for (let y = y0; y < Math.min(h, y0 + rh); y++) {
    for (let x = x0; x < Math.min(w, x0 + rw); x++) {
      const i = (y * w + x) * 4;
      frame[i] = r; frame[i + 1] = g; frame[i + 2] = b; frame[i + 3] = 255;
    }
  }
}

/** Draw one character as a 5x7 pattern whose bits come from the char code —
 *  every character gets a unique, deterministic glyph. */
function drawCharCell(frame: Buffer, w: number, h: number, x0: number, y0: number, ch: string): void {
  const code = ch.codePointAt(0) ?? 0;
  // 35 bits of pseudo-glyph from two multiplicative hashes of the code.
  const bits = (code * 2654435761) >>> 0;
  const bits2 = (code * 40503 + 7) >>> 0;
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      const bit = row * 5 + col;
      const on = bit < 32 ? (bits >>> bit) & 1 : (bits2 >>> (bit - 32)) & 1;
      if (!on) continue;
      const x = x0 + col;
      const y = y0 + row;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      frame[i] = 255; frame[i + 1] = 240; frame[i + 2] = 180; frame[i + 3] = 255;
    }
  }
}

function drawCrosshair(frame: Buffer, w: number, h: number, cx: number, cy: number): void {
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    frame[i] = r; frame[i + 1] = g; frame[i + 2] = b; frame[i + 3] = 255;
  };
  for (let d = -7; d <= 7; d++) {
    set(cx + d, cy, 255, 255, 255);
    set(cx, cy + d, 255, 255, 255);
  }
  set(cx, cy, 255, 0, 0);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
}
