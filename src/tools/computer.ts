// Computer-use tool (Phase E12): drive the desktop — screenshots, pointer,
// keyboard — through a display backend (real X11 on Linux, or the
// deterministic fake display used by tests).
//
// Safety shape ("computer" permission tier, stricter than shell):
//  - The tool carries permission: 'computer'. The executeTool gate denies
//    any permission kind that is not explicitly enabled in config, and
//    `computer` is in NO default set (unlike read/write/shell) — so the
//    tool is dead unless the user opts in per project/session via
//    permissions.computer=true (config) or MOCHI_PERMISSION_COMPUTER=1 /
//    MOCHI_COMPUTER=1 (session env).
//  - execute() re-checks the opt-in itself, so direct callers that bypass
//    executeTool (TUI probes, tests) hit the same wall.
//  - The approval layer never auto-allows it (PermissionManager has no
//    auto-allow path for computer), so headless runs deny it by default.
//
// Contract: EVERY action — including queries — ends by capturing a fresh
// screenshot, saved under <workspace>/state/computer/, and the result text
// reports the action outcome plus the screenshot path and geometry. The
// model always sees the consequence of its last action before deciding
// the next one (screenshot-after-action rule).

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool, ToolContext } from './types.js';
import { getDisplayBackend } from '../computer/backend.js';
import { encodePngRgba } from '../computer/png.js';
import { parseKeyCombo, type DisplayBackend } from '../computer/display.js';

const ACTIONS = ['screenshot', 'pointer', 'move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'wait'] as const;
type ComputerAction = (typeof ACTIONS)[number];

const MAX_SCREENSHOTS_KEPT = 20;
const SETTLE_MS = 50;

/** Returns a denial message when computer use has not been opted into,
 *  or null when it is allowed. Exported for tests. */
export function computerOptInError(ctx: ToolContext): string | null {
  const optedIn =
    ctx.config?.permissions?.computer === true ||
    process.env.MOCHI_COMPUTER === '1' ||
    /^(1|true|yes)$/i.test((process.env.MOCHI_PERMISSION_COMPUTER ?? '').trim());
  if (optedIn) return null;
  return (
    'computer: permission denied — desktop control is opt-in only (permission tier "computer", stricter than shell). ' +
    'Enable it for this session with MOCHI_COMPUTER=1 (or MOCHI_PERMISSION_COMPUTER=1), or set permissions.computer=true in config. ' +
    'It is never auto-approved, and headless runs deny it by default.'
  );
}

let shotSeq = 0;

function saveScreenshot(ctx: ToolContext, png: Buffer): string {
  const dir = resolve(ctx.workspace.stateDir, 'computer');
  mkdirSync(dir, { recursive: true });
  shotSeq += 1;
  const path = resolve(dir, `shot-${String(shotSeq).padStart(4, '0')}.png`);
  writeFileSync(path, png);
  // Prune to the newest MAX_SCREENSHOTS_KEPT captures.
  try {
    const files = readdirSync(dir)
      .filter((f) => /^shot-\d+\.png$/.test(f))
      .map((f) => ({ f, mtime: statSync(resolve(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(MAX_SCREENSHOTS_KEPT)) {
      try { unlinkSync(resolve(dir, f)); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
  return path;
}

async function captureAndReport(
  ctx: ToolContext,
  backend: DisplayBackend,
  action: ComputerAction,
  detail: string,
): Promise<string> {
  const info = await backend.info();
  const rgba = await backend.captureRgba();
  const png = encodePngRgba(info.width, info.height, rgba);
  const path = saveScreenshot(ctx, png);
  const pointer = await backend.pointer();
  return (
    `[computer ${action}] ok — ${detail} on ${info.label} (${info.width}x${info.height}), ` +
    `pointer at (${pointer.x}, ${pointer.y})\n` +
    `screenshot: ${path} (${info.width}x${info.height})`
  );
}

function numArg(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function requireCoords(args: Record<string, unknown>, xName: string, yName: string): { x: number; y: number } {
  const x = numArg(args, xName);
  const y = numArg(args, yName);
  if (x === undefined || y === undefined || x < 0 || y < 0) {
    throw new Error(`${xName}/${yName} must be non-negative numbers`);
  }
  return { x, y };
}

async function settle(backend: DisplayBackend): Promise<void> {
  if (backend.kind === 'x11') await new Promise((r) => setTimeout(r, SETTLE_MS));
}

async function pressKey(backend: DisplayBackend, name: string): Promise<void> {
  await backend.key(name, true);
  await backend.key(name, false);
}

async function doType(backend: DisplayBackend, text: string): Promise<void> {
  for (const ch of text) {
    if (ch === '\n') await pressKey(backend, 'Return');
    else if (ch === '\t') await pressKey(backend, 'Tab');
    else if (ch === '\r') continue;
    else {
      try {
        await pressKey(backend, ch);
      } catch {
        throw new Error(`type: cannot express character ${JSON.stringify(ch)} on this keyboard layout`);
      }
    }
  }
}

async function performAction(backend: DisplayBackend, action: ComputerAction, args: Record<string, unknown>): Promise<string> {
  switch (action) {
    case 'screenshot':
      return 'captured screen';
    case 'pointer': {
      const p = await backend.pointer();
      return `pointer position (${p.x}, ${p.y})`;
    }
    case 'move': {
      const { x, y } = requireCoords(args, 'x', 'y');
      await backend.movePointer(x, y);
      return `moved pointer to (${Math.round(x)}, ${Math.round(y)})`;
    }
    case 'click':
    case 'double_click':
    case 'right_click': {
      const button = action === 'right_click' ? 3 : Math.max(1, Math.min(7, Math.round(numArg(args, 'button') ?? 1)));
      if (args.x !== undefined || args.y !== undefined) {
        const { x, y } = requireCoords(args, 'x', 'y');
        await backend.movePointer(x, y);
      }
      const clicks = action === 'double_click' ? 2 : 1;
      for (let i = 0; i < clicks; i++) {
        await backend.button(button, true);
        await backend.button(button, false);
      }
      const p = await backend.pointer();
      return `${action === 'double_click' ? 'double-clicked' : 'clicked'} button ${button} at (${p.x}, ${p.y})`;
    }
    case 'drag': {
      const from = requireCoords(args, 'x', 'y');
      const to = requireCoords(args, 'x2', 'y2');
      await backend.movePointer(from.x, from.y);
      await backend.button(1, true);
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        await backend.movePointer(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      }
      await backend.button(1, false);
      return `dragged from (${Math.round(from.x)}, ${Math.round(from.y)}) to (${Math.round(to.x)}, ${Math.round(to.y)})`;
    }
    case 'scroll': {
      const dy = Math.round(numArg(args, 'dy') ?? 0);
      const dx = Math.round(numArg(args, 'dx') ?? 0);
      if (!dx && !dy) throw new Error('scroll: provide dx and/or dy (in wheel clicks; positive dy scrolls down)');
      const doClicks = async (button: number, count: number) => {
        for (let i = 0; i < Math.min(count, 20); i++) {
          await backend.button(button, true);
          await backend.button(button, false);
        }
      };
      if (dy > 0) await doClicks(5, dy);
      if (dy < 0) await doClicks(4, -dy);
      if (dx > 0) await doClicks(7, dx);
      if (dx < 0) await doClicks(6, -dx);
      return `scrolled dx=${dx} dy=${dy}`;
    }
    case 'type': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) throw new Error('type: text required');
      if (text.length > 4000) throw new Error('type: text too long (max 4000 chars)');
      await doType(backend, text);
      return `typed ${text.length} character${text.length === 1 ? '' : 's'}`;
    }
    case 'key': {
      const spec = typeof args.key === 'string' ? args.key.trim() : '';
      if (!spec) throw new Error('key: key spec required (e.g. "Return", "Tab", "ctrl+a", "alt+F4")');
      const combo = parseKeyCombo(spec);
      for (const mod of combo.modifiers) await backend.key(mod, true);
      try {
        await pressKey(backend, combo.key);
      } finally {
        for (const mod of [...combo.modifiers].reverse()) await backend.key(mod, false);
      }
      return `pressed ${spec}`;
    }
    case 'wait': {
      const ms = Math.max(0, Math.min(5000, Math.round(numArg(args, 'ms') ?? 500)));
      await new Promise((r) => setTimeout(r, ms));
      return `waited ${ms}ms`;
    }
  }
}

export const computerTool: Tool = {
  def: {
    name: 'computer',
    description:
      'Control the desktop (Linux/X11): take screenshots, move/click/drag the pointer, scroll, type text, and press keys. ' +
      `Actions: ${ACTIONS.join(', ')}. EVERY action returns a fresh screenshot (saved to the workspace state dir) so you can see the result before acting again. ` +
      'Requires explicit opt-in (permission tier "computer", stricter than shell): permissions.computer=true in config or MOCHI_COMPUTER=1 for the session; denied by default, never auto-approved headless. ' +
      'Coordinates are absolute pixels with (0,0) at the top-left.',
    parameters: [
      { name: 'action', type: 'string', description: `Action: ${ACTIONS.join('|')}`, required: true },
      { name: 'x', type: 'number', description: 'Target X pixel (move/click/drag start)', required: false },
      { name: 'y', type: 'number', description: 'Target Y pixel (move/click/drag start)', required: false },
      { name: 'x2', type: 'number', description: 'Drag end X pixel', required: false },
      { name: 'y2', type: 'number', description: 'Drag end Y pixel', required: false },
      { name: 'button', type: 'number', description: 'Mouse button for click (1=left, 2=middle, 3=right; default 1)', required: false },
      { name: 'text', type: 'string', description: 'Text to type (action=type)', required: false },
      { name: 'key', type: 'string', description: 'Key or combo to press (action=key), e.g. "Return", "ctrl+a", "alt+Tab"', required: false },
      { name: 'dx', type: 'number', description: 'Horizontal scroll in wheel clicks (action=scroll)', required: false },
      { name: 'dy', type: 'number', description: 'Vertical scroll in wheel clicks (action=scroll; positive = down)', required: false },
      { name: 'ms', type: 'number', description: 'Milliseconds to wait (action=wait, max 5000)', required: false },
    ],
    dangerous: true,
    permission: 'computer',
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const denial = computerOptInError(ctx);
    if (denial) return denial;
    const action = typeof args.action === 'string' ? (args.action as ComputerAction) : ('' as ComputerAction);
    if (!ACTIONS.includes(action)) {
      return `computer: action required — one of ${ACTIONS.join(', ')}`;
    }
    let backend: DisplayBackend;
    try {
      backend = getDisplayBackend();
    } catch (err) {
      return `computer: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      const detail = await performAction(backend, action, args);
      await settle(backend);
      return await captureAndReport(ctx, backend, action, detail);
    } catch (err) {
      return `computer: ${action} failed — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
