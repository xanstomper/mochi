// The handoff path: carry a task between the browser and the desktop
// mid-run WITH its observation, instead of starting observation over.
//
// When a run moves a task across surfaces, the source surface stashes its
// current shared tree (src/a11y/tree.ts) plus the focused node; the
// destination surface adopts the stash and renders it as carried context in
// the result of the observation/action it was already going to make — so the
// model never spends an extra round-trip re-describing a tree that is already
// in hand. Stashes are keyed by workspace cwd (both tools in one run share
// the process) and are take-once: adopting consumes the stash so stale
// context cannot leak into later observations.

import type { SurfaceKind, SurfaceTree } from './tree.js';
import { renderTree } from './tree.js';

export interface SurfaceHandoff {
  from: SurfaceKind;
  /** The observed tree at handoff time. */
  tree: SurfaceTree;
  /** The focused/selected node's ref, when the surface knew one. */
  focusedRef?: string;
  handedAt: number;
}

const stashes = new Map<string, SurfaceHandoff>();

/** Stash (replace any previous) the handoff for a workspace. */
export function stashHandoff(workspaceKey: string, handoff: SurfaceHandoff): void {
  stashes.set(workspaceKey, handoff);
}

/** Consume the handoff for a workspace (undefined when none is pending). */
export function takeHandoff(workspaceKey: string): SurfaceHandoff | undefined {
  const h = stashes.get(workspaceKey);
  if (h) stashes.delete(workspaceKey);
  return h;
}

/** Peek without consuming (used to decide whether to render a carried
 *  section; the consumer takes it once it has actually rendered). */
export function peekHandoff(workspaceKey: string): SurfaceHandoff | undefined {
  return stashes.get(workspaceKey);
}

export function clearHandoff(workspaceKey: string): void {
  stashes.delete(workspaceKey);
}

/** Test isolation hook. */
export function clearAllHandoffs(): void {
  stashes.clear();
}

/** Render a handoff as the `[carried from …]` context section the
 *  destination surface embeds in its own observation result. Same shape the
 *  source surface rendered — the tree is re-rendered, never re-observed. */
export function carriedSection(handoff: SurfaceHandoff): string {
  const focus = handoff.focusedRef ? `, focused ${handoff.focusedRef}` : '';
  const head = `[carried from ${handoff.from} — ${handoff.tree.nodes.length} node(s)${focus}] ` +
    'these refs belong to the OTHER surface: use them as context; act only on this surface\'s nodes ' +
    `(act on a carried node via its own tool — ${handoff.from === 'browser' ? 'cdp_browser' : 'computer'}).`;
  return `${head}\n${renderTree(handoff.tree, { carried: true })}`;
}
