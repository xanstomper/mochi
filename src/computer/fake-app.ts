// Interactive fake application for the deterministic display backend.
//
// The plain FakeDisplayBackend is a passive pixel surface: it records
// clicks/keys but has no widgets, so desktop observations have no
// accessibility tree and desktop-only steps have nothing to act ON by name.
// This module adds an OPT-IN fake app (constructor option on
// FakeDisplayBackend) with a fixed, deterministic widget layout:
//
//   ┌ Fake App ────────────────────────────────┐
//   │ Confirmation code                        │
//   │ [ Code textbox          ]                │
//   │ [ Submit ]  [ Copy URL ]                 │
//   │ status: <message>                        │
//   └──────────────────────────────────────────┘
//
// Pointer clicks hit-test the widgets (clicking the textbox focuses it;
// clicking Submit submits the typed value; Copy URL reports a URL as the
// status message); keyboard input routes into the focused textbox. The app
// exposes its widgets through a11y() — the raw nodes for the shared a11y
// tree (src/a11y/tree.ts) — and draws itself deterministically (pure
// function of state, same discipline as the base backend). This is TEST
// infrastructure: it stands in for a real desktop app where no live X11
// desktop is available, and it is enabled only when asked for.

import type { DesktopAxNode } from '../a11y/tree.js';

export interface Rect { x: number; y: number; width: number; height: number }

export interface FakeAppState {
  focused: 'code' | null;
  value: string;
  status: string;
}

/** Fixed widget geometry (an 800x600 fake display leaves room around it). */
export const FAKE_APP_WIDGETS = {
  label: { x: 60, y: 260, width: 180, height: 16 } as Rect,
  code: { x: 60, y: 284, width: 220, height: 28 } as Rect,
  submit: { x: 60, y: 324, width: 120, height: 32 } as Rect,
  copyUrl: { x: 200, y: 324, width: 120, height: 32 } as Rect,
  status: { x: 60, y: 372, width: 280, height: 20 } as Rect,
} as const;

function inside(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

export class FakeAppWidgets {
  /** URL the Copy URL button reports (settable by tests/harnesses). */
  receiptUrl: string;
  private focus: 'code' | null = null;
  private value = '';
  private status = 'ready';

  constructor(opts: { receiptUrl?: string } = {}) {
    this.receiptUrl = opts.receiptUrl ?? 'https://example.invalid/receipt/0042';
  }

  get state(): FakeAppState {
    return { focused: this.focus, value: this.value, status: this.status };
  }

  /** Pointer press at (x, y): hit-test the widgets. Returns true when the
   *  app consumed the click (a widget swallows it; nothing else reacts). */
  pointerDown(x: number, y: number): boolean {
    if (inside(x, y, FAKE_APP_WIDGETS.code)) {
      this.focus = 'code';
      return true;
    }
    if (inside(x, y, FAKE_APP_WIDGETS.submit)) {
      this.status = this.value.trim() ? `ok: ${this.value}` : 'error: empty';
      return true;
    }
    if (inside(x, y, FAKE_APP_WIDGETS.copyUrl)) {
      this.status = `url: ${this.receiptUrl}`;
      return true;
    }
    this.focus = null;
    return false;
  }

  /** Key press while the textbox has focus. Returns true when consumed
   *  (printable chars append; Backspace deletes; named keys pass through). */
  keyDown(name: string): boolean {
    if (this.focus !== 'code') return false;
    if (name.length === 1) {
      this.value += name;
      return true;
    }
    const lower = name.toLowerCase();
    if (lower === 'backspace' || lower === 'back_space' || lower === 'delete') {
      if (lower === 'backspace' || lower === 'back_space') this.value = this.value.slice(0, -1);
      return true;
    }
    if (lower === 'space') {
      this.value += ' ';
      return true;
    }
    return false;
  }

  /** The desktop a11y nodes (raw input for treeFromDesktopNodes). */
  a11y(): DesktopAxNode[] {
    return [
      { role: 'statictext', name: 'Confirmation code', bounds: { ...FAKE_APP_WIDGETS.label } },
      {
        role: 'textbox', name: 'Code', value: this.value, bounds: { ...FAKE_APP_WIDGETS.code },
        ...(this.focus === 'code' ? { focused: true } : {}),
      },
      { role: 'button', name: 'Submit', bounds: { ...FAKE_APP_WIDGETS.submit } },
      { role: 'button', name: 'Copy URL', bounds: { ...FAKE_APP_WIDGETS.copyUrl } },
      { role: 'status', name: 'Status', value: this.status, bounds: { ...FAKE_APP_WIDGETS.status } },
    ];
  }

  /** Deterministic render: pure function of app state onto the RGBA frame
   *  (called by the backend BEFORE the pointer crosshair). */
  draw(frame: Buffer, w: number, h: number): void {
    const W = FAKE_APP_WIDGETS;
    outlineRect(frame, w, h, { x: 40, y: 240, width: 320, height: 180 }, 200, 200, 200);
    outlineRect(frame, w, h, W.code, this.focus === 'code' ? 255 : 160, this.focus === 'code' ? 220 : 160, 90);
    outlineRect(frame, w, h, W.submit, 160, 220, 160);
    outlineRect(frame, w, h, W.copyUrl, 160, 200, 240);
    drawText(frame, w, h, W.label.x + 2, W.label.y + 4, 'Confirmation code');
    drawText(frame, w, h, W.code.x + 4, W.code.y + 9, this.value);
    drawText(frame, w, h, W.submit.x + 8, W.submit.y + 12, 'Submit');
    drawText(frame, w, h, W.copyUrl.x + 8, W.copyUrl.y + 12, 'Copy URL');
    drawText(frame, w, h, W.status.x + 2, W.status.y + 5, `status: ${this.status}`);
  }
}

function outlineRect(frame: Buffer, w: number, h: number, r: Rect, cr: number, cg: number, cb: number): void {
  const set = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    frame[i] = cr; frame[i + 1] = cg; frame[i + 2] = cb; frame[i + 3] = 255;
  };
  for (let x = r.x; x < r.x + r.width; x++) {
    set(x, r.y);
    set(x, r.y + r.height - 1);
  }
  for (let y = r.y; y < r.y + r.height; y++) {
    set(r.x, y);
    set(r.x + r.width - 1, y);
  }
}

/** Draw a string as 5x7 glyph cells (same cell algorithm as the base
 *  backend's typed-text strip: unique deterministic pattern per char). */
function drawText(frame: Buffer, w: number, h: number, x0: number, y0: number, text: string): void {
  let x = x0;
  for (const ch of text) {
    drawGlyph(frame, w, h, x, y0, ch);
    x += 8;
    if (x + 8 > w - 8) break;
  }
}

function drawGlyph(frame: Buffer, w: number, h: number, x0: number, y0: number, ch: string): void {
  const code = ch.codePointAt(0) ?? 0;
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
      frame[i] = 235; frame[i + 1] = 235; frame[i + 2] = 235; frame[i + 3] = 255;
    }
  }
}
