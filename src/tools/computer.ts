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
import {
  findNode,
  nodeCenter,
  renderTree,
  treeFromDesktopNodes,
  type SurfaceTree,
} from '../a11y/tree.js';
import {
  stashHandoff,
  takeHandoff,
  peekHandoff,
  carriedSection,
} from '../a11y/handoff.js';

const ACTIONS = ['screenshot', 'pointer', 'move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'wait', 'tree', 'handoff'] as const;
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

/** Wave H3 side-channel: the most recent capture per workspace state dir.
 *  Tool results are plain strings, so the PNG bytes travel out-of-band: the
 *  agent loop takes (reads + clears) the entry right after a computer call
 *  and, for vision-capable models, attaches the frame to the tool message as
 *  an inline image part next to the path text. Take-once semantics mean a
 *  frame is attached at most once and can never go stale across calls. */
export interface LastComputerScreenshot {
  path: string;
  png: Buffer;
  width: number;
  height: number;
}

const lastScreenshots = new Map<string, LastComputerScreenshot>();

export function takeLastComputerScreenshot(stateDir: string): LastComputerScreenshot | null {
  const shot = lastScreenshots.get(stateDir);
  if (shot) lastScreenshots.delete(stateDir);
  return shot ?? null;
}

// -----------------------------------------------------------------------
// Shared a11y-tree seam (src/a11y/tree.ts): the desktop observation and
// targeting helpers. Same tree shape, same selectors, same action vocabulary
// as the CDP browser surface — see handoff() and tree() below for the
// cross-surface path.
// -----------------------------------------------------------------------

/** The CURRENT desktop state as a shared tree. Backends without an a11y
 *  source (real X11 today) produce an empty tree — reported honestly,
 *  never invented. */
function desktopTree(backend: DisplayBackend, info: { label: string }): { tree: SurfaceTree; hasSource: boolean } {
  const hasSource = typeof backend.a11y === 'function';
  const tree = treeFromDesktopNodes(hasSource ? backend.a11y!() : [], info.label);
  return { tree, hasSource };
}

/** Resolve a shared selector (refs, role=, name=, text=) against the live
 *  desktop tree. On a miss the error text carries the observed tree, so the
 *  model can pick a valid target without a separate observation call. */
async function resolveTargetOnDesktop(
  backend: DisplayBackend,
  target: string,
): Promise<{ x: number; y: number; ref: string } | string> {
  const info = await backend.info();
  const { tree } = desktopTree(backend, info);
  const node = findNode(tree, target);
  if (!node) {
    const foreign = /^e\d+$/.test(target)
      ? `\n"${target}" is a BROWSER-surface ref — act on it with cdp_browser, or observe this desktop with action=tree.`
      : '';
    return `computer: no desktop node matches target="${target}" — observed tree:\n${renderTree(tree)}${foreign}`;
  }
  const center = nodeCenter(node);
  if (!center) return `computer: node ${node.ref} has no bounds on this backend`;
  return { ...center, ref: node.ref };
}

/** Adopt a pending BROWSER handoff into this observation's result (renders
 *  the carried tree as context and consumes the stash). Empty when none is
 *  pending — the common desktop-only case, zero output change. */
function adoptCarriedBrowser(ctx: ToolContext): string[] {
  const h = peekHandoff(ctx.cwd);
  if (!h || h.from !== 'browser') return [];
  takeHandoff(ctx.cwd);
  return [carriedSection(h)];
}

/** The tree / handoff actions: observe the desktop as the shared tree, and
 *  (handoff) stash it for the browser side. Both keep the screenshot-after-
 *  action contract — the frame rides under the tree text. */
async function treeAction(
  ctx: ToolContext,
  backend: DisplayBackend,
  action: 'tree' | 'handoff',
): Promise<string> {
  const info = await backend.info();
  const { tree, hasSource } = desktopTree(backend, info);
  const focus = tree.focusedRef ? `, focused ${tree.focusedRef}` : '';
  let head: string;
  if (action === 'handoff') {
    stashHandoff(ctx.cwd, {
      from: 'desktop',
      tree,
      ...(tree.focusedRef ? { focusedRef: tree.focusedRef } : {}),
      handedAt: Date.now(),
    });
    head = `observed ${tree.nodes.length} node(s)${focus} — stashed; the next cdp_browser open/snapshot adopts this context (no re-observation needed)`;
  } else {
    head = hasSource
      ? `observed ${tree.nodes.length} node(s)${focus}`
      : 'no a11y source on this backend — no interactive nodes reported (coordinates only)';
  }
  const carried = action === 'tree' ? adoptCarriedBrowser(ctx) : [];
  const report = await captureAndReport(ctx, backend, action, head);
  const [first, ...rest] = report.split('\n');
  return [[first, ...carried, renderTree(tree)].join('\n'), ...rest].join('\n');
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
  lastScreenshots.set(ctx.workspace.stateDir, { path, png, width: info.width, height: info.height });
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
    case 'tree':
    case 'handoff':
      // Unreachable: execute() routes these to treeAction() before
      // performAction (they observe/carry the tree, not pixels).
      throw new Error(`${action}: handled by the a11y seam, not the input path`);
  }
}

export const computerTool: Tool = {
  def: {
    name: 'computer',
    description:
      'Control the desktop (Linux/X11): take screenshots, move/click/drag the pointer, scroll, type text, and press keys. ' +
      `Actions: ${ACTIONS.join(', ')}. EVERY action returns a fresh screenshot (saved to the workspace state dir) so you can see the result before acting again. ` +
      'tree — observe the desktop as an accessibility tree (stable d<N> refs with role/name/bounds, the same shape as cdp_browser snapshots) and adopt any context handed off from the browser; ' +
      'handoff — stash the desktop tree (and focused node) for the browser surface so a task can move between desktop and browser without re-observation; ' +
      'click/type accept target=<ref|role=...|name="..."|text=...> resolved against the live tree (coordinates still work). ' +
      'Requires explicit opt-in (permission tier "computer", stricter than shell): permissions.computer=true in config or MOCHI_COMPUTER=1 for the session; denied by default, never auto-approved headless. ' +
      'Coordinates are absolute pixels with (0,0) at the top-left.',
    parameters: [
      { name: 'action', type: 'string', description: `Action: ${ACTIONS.join('|')}`, required: true },
      { name: 'target', type: 'string', description: 'Node target for click/type: d<N> ref from action=tree, role=button, role=button[name="Submit"], name="...", or text=needle', required: false },
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
      // Tree / handoff: observe or carry the shared a11y tree (the
      // cross-surface seam). Everything else acts on pixels/keys.
      if (action === 'tree' || action === 'handoff') {
        return await treeAction(ctx, backend, action);
      }

      // Shared-selector targeting: `target` resolves against the LIVE desktop
      // tree to concrete coordinates (refs, role=, name=, text= — the same
      // vocabulary cdp_browser refs come from). Coordinate args stay exactly
      // as before; `target` is purely additive.
      const targetSel = typeof args.target === 'string' ? args.target.trim() : '';
      let effectiveArgs = args;
      if (targetSel && (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'type')) {
        const resolved = await resolveTargetOnDesktop(backend, targetSel);
        if (typeof resolved === 'string') return resolved; // observation-carrying miss
        if (action === 'type') {
          // Focus the node with a real click at its center, then type below.
          await backend.movePointer(resolved.x, resolved.y);
          await backend.button(1, true);
          await backend.button(1, false);
        } else {
          effectiveArgs = { ...args, x: resolved.x, y: resolved.y };
        }
      }

      const detail = await performAction(backend, action, effectiveArgs);
      await settle(backend);
      return await captureAndReport(ctx, backend, action, detail);
    } catch (err) {
      return `computer: ${action} failed — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
