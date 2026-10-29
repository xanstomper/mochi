// Display backend contract for the computer-use bridge (Phase E12).
//
// A backend is the thinnest possible seam over a real display: report its
// geometry, hand back raw RGBA frames, and inject pointer/keyboard input.
// The X11 wire-protocol backend (x11-display.ts) is the production Linux
// implementation; the fake backend (fake-display.ts) is a deterministic
// in-memory display for tests. This interface is also where a future Rust
// native-core backend plugs in — the tool never talks to X11 directly.

import type { DesktopAxNode } from '../a11y/tree.js';

export interface DisplayInfo {
  width: number;
  height: number;
  /** Human label, e.g. "x11 :99" or "fake 800x600". */
  label: string;
}

export interface PointerState {
  x: number;
  y: number;
  /** Button/modifier mask as reported by the backend (X11 mask bits on x11). */
  mask: number;
}

export interface DisplayBackend {
  readonly kind: 'x11' | 'fake';
  info(): Promise<DisplayInfo>;
  /** Raw RGBA frame, width*height*4 bytes, row-major. */
  captureRgba(): Promise<Buffer>;
  pointer(): Promise<PointerState>;
  movePointer(x: number, y: number): Promise<void>;
  /** X11 button numbers: 1=left, 2=middle, 3=right, 4/5=wheel up/down, 6/7=wheel left/right. */
  button(button: number, pressed: boolean): Promise<void>;
  /**
   * Press/release a key by logical key name: a single printable character
   * ("a", "A", "5", "%") or a named key ("Return", "Tab", "Escape",
   * "BackSpace", "Left", "shift", "ctrl", ...). Backends resolve names to
   * their native key representation and throw on unknown keys.
   */
  key(name: string, pressed: boolean): Promise<void>;
  close(): Promise<void>;
  /** Optional accessibility source: the desktop's interactive nodes with
   *  display bounds (the raw input for the shared a11y tree,
   *  src/a11y/tree.ts). Backends without a tree source (real X11 today —
   *  no AT-SPI wiring) OMIT this method; the computer tool reports the
   *  absence honestly instead of inventing nodes. */
  a11y?(): DesktopAxNode[];
}

// ---------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------

/** Named (non-printable / modifier) keys the bridge understands, by the
 *  lowercase alias the tool accepts. Values are X keysyms. */
export const NAMED_KEYSYMS: Record<string, number> = {
  backspace: 0xff08,
  tab: 0xff09,
  return: 0xff0d,
  enter: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  delete: 0xffff,
  home: 0xff50,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  page_up: 0xff55,
  pageup: 0xff55,
  page_down: 0xff56,
  pagedown: 0xff56,
  end: 0xff57,
  space: 0x0020,
  shift: 0xffe1,
  shift_l: 0xffe1,
  shift_r: 0xffe2,
  ctrl: 0xffe3,
  control: 0xffe3,
  control_l: 0xffe3,
  control_r: 0xffe4,
  alt: 0xffe9,
  alt_l: 0xffe9,
  alt_r: 0xffea,
  super: 0xffeb,
  super_l: 0xffeb,
  meta: 0xffe7,
  f1: 0xffbe,
  f2: 0xffbf,
  f3: 0xffc0,
  f4: 0xffc1,
  f5: 0xffc2,
  f6: 0xffc3,
  f7: 0xffc4,
  f8: 0xffc5,
  f9: 0xffc6,
  f10: 0xffc7,
  f11: 0xffc8,
  f12: 0xffc9,
};

/**
 * Resolve a logical key name to an X keysym. Printable ASCII/Latin-1
 * characters map to their codepoint (the X keysym convention); named keys
 * go through NAMED_KEYSYMS. Returns null for names we cannot express.
 */
export function keysymForName(name: string): number | null {
  if (name.length === 1) {
    const code = name.codePointAt(0)!;
    return code < 0x100 ? code : null;
  }
  return NAMED_KEYSYMS[name.toLowerCase()] ?? null;
}

export interface KeyCombo {
  /** Modifier key names to hold, in press order. */
  modifiers: string[];
  /** The main key name. */
  key: string;
}

const MODIFIER_ALIASES = new Set(['ctrl', 'control', 'alt', 'shift', 'super', 'meta']);

/** Parse "ctrl+shift+t" style combos; a bare name yields no modifiers. */
export function parseKeyCombo(spec: string): KeyCombo {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('key: empty key spec');
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase();
    if (!MODIFIER_ALIASES.has(lower)) {
      throw new Error(`key: "${part}" is not a modifier (use ctrl/alt/shift/super before the main key)`);
    }
    modifiers.push(lower);
  }
  return { modifiers, key: parts[parts.length - 1] };
}
