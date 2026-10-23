// Display backend selection for the computer tool (Phase E12).
//
// Resolution order:
//   1. an explicitly injected backend (tests),
//   2. MOCHI_COMPUTER_BACKEND=fake  → the deterministic fake display,
//   3. MOCHI_COMPUTER_BACKEND=x11   → X11 on $DISPLAY (or MOCHI_DISPLAY),
//   4. default: X11 when a local DISPLAY is set, otherwise an error at
//      first use — never a silent fake fallback on a real run.

import type { DisplayBackend } from './display.js';
import { FakeDisplayBackend } from './fake-display.js';
import { X11DisplayBackend } from './x11-display.js';

let injected: DisplayBackend | null = null;
let cached: DisplayBackend | null = null;

/** Test hook: force the backend returned by getDisplayBackend(). */
export function setDisplayBackendForTests(backend: DisplayBackend | null): void {
  injected = backend;
  cached = null;
}

export function getDisplayBackend(): DisplayBackend {
  if (injected) return injected;
  if (cached) return cached;
  const choice = (process.env.MOCHI_COMPUTER_BACKEND ?? '').trim().toLowerCase();
  if (choice === 'fake') {
    cached = new FakeDisplayBackend();
    return cached;
  }
  const display = process.env.MOCHI_DISPLAY || process.env.DISPLAY || '';
  if (choice === 'x11' || display) {
    if (!display) throw new Error('computer: MOCHI_COMPUTER_BACKEND=x11 but neither MOCHI_DISPLAY nor DISPLAY is set');
    cached = new X11DisplayBackend(display);
    return cached;
  }
  throw new Error(
    'computer: no display available — DISPLAY is unset and no backend was configured. ' +
    'Run under an X session (or Xvfb), or set MOCHI_COMPUTER_BACKEND=fake for the simulated display.',
  );
}
