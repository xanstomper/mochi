// The shared accessibility-tree seam between the two control surfaces.
//
// The CDP browser tool (src/tools/cdp-browser.ts) observes pages through the
// Chrome DevTools accessibility tree; computer control (src/tools/computer.ts)
// observes the desktop through display backends. Before this module they had
// no common representation: a task that started in the browser and finished on
// the desktop had to re-observe and re-describe the world through a different
// vocabulary. This module defines the ONE tree model both surfaces produce and
// consume — node/role/name/value/bounds, stable per-observation refs, the same
// selector vocabulary, and one canonical text rendering — WITHOUT touching
// either tool's transport (CDP stays CDP, X11/fake stays X11/fake; each
// surface adapts its own observation into this shape).
//
// Interchangeability contract:
//  - A tree built from a CDP PageSnapshot and a tree built from a display
//    backend have the same shape and render identically (modulo surface tag).
//  - Selector resolution (refs, role=, name=, text=) is producer-agnostic:
//    either surface's action path can resolve a selector against either
//    producer's tree.
//  - Acting is surface-scoped: a node carries its origin surface, and a tool
//    asked to act on a foreign-surface node refuses with guidance instead of
//    silently doing nothing (cross-surface composition goes through the
//    handoff path in handoff.ts).

export type SurfaceKind = 'browser' | 'desktop';

/** Rectangle in surface-local pixels: viewport coords for browser trees,
 *  display coords for desktop trees. Optional where the producing surface
 *  cannot know it without extra round-trips (browser nodes carry refs that
 *  resolve to rects lazily at action time; desktop nodes always carry
 *  bounds because coordinates are all a display backend understands). */
export interface AxBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One node of the shared tree. `ref` ids are stable WITHIN an observation
 *  (and within a handoff carrying it) and are namespaced per surface —
 *  browser refs look like `e12`, desktop refs like `d3` — so a carried
 *  section can never be confused with the local surface's refs. */
export interface SurfaceNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  bounds?: AxBounds;
  depth: number;
  focused?: boolean;
  origin: SurfaceKind;
}

export interface SurfaceTree {
  surface: SurfaceKind;
  /** Page title (browser) or active-app/display label (desktop). */
  title: string;
  /** Page URL (browser) or display label (desktop). */
  origin: string;
  nodes: SurfaceNode[];
  focusedRef?: string;
}

// ---------------------------------------------------------------------------
// Selectors — the shared targeting vocabulary
// ---------------------------------------------------------------------------

export interface ParsedSelector {
  kind: 'ref' | 'role' | 'name' | 'text';
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
}

/** Parse the shared selector syntax:
 *    e12 / d5            — bare ref from a tree observation
 *    role=button         — first node with that role
 *    role=button[name="Submit"] — role + exact name
 *    name="Submit"       — exact accessible name
 *    text=Sub            — substring of name or value
 *  Quoted values accept \\" and \\\\ escapes. */
export function parseSelector(raw: string): ParsedSelector {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'ref' };
  const bracket = /^role=([A-Za-z_][\w-]*)\[name="((?:[^"\\]|\\.)*)"\]$/.exec(s);
  if (bracket) return { kind: 'role', role: bracket[1].toLowerCase(), name: unescapeQuoted(bracket[2]) };
  const roleOnly = /^role=([A-Za-z_][\w-]*)$/.exec(s);
  if (roleOnly) return { kind: 'role', role: roleOnly[1].toLowerCase() };
  const quoted = /^name="((?:[^"\\]|\\.)*)"$/.exec(s);
  if (quoted) return { kind: 'name', name: unescapeQuoted(quoted[1]) };
  const text = /^text=(.+)$/.exec(s);
  if (text) return { kind: 'text', text: text[1] };
  // Bare token: a ref (e12/d5) when it matches the ref shape, else a text needle.
  if (/^[ed]\d+$/.test(s)) return { kind: 'ref', ref: s };
  return { kind: 'text', text: s };
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** Find a node by the shared selector. Throws nothing — returns undefined
 *  when nothing matches (callers render an observation-carrying error). */
export function findNode(tree: SurfaceTree, selector: string): SurfaceNode | undefined {
  const sel = parseSelector(selector);
  const nodes = tree.nodes;
  switch (sel.kind) {
    case 'ref':
      return sel.ref ? nodes.find((n) => n.ref === sel.ref) : undefined;
    case 'role':
      return nodes.find((n) =>
        n.role === sel.role && (sel.name === undefined || n.name === sel.name));
    case 'name':
      return nodes.find((n) => n.name === sel.name);
    case 'text': {
      const needle = (sel.text ?? '').toLowerCase();
      return nodes.find((n) =>
        n.name.toLowerCase().includes(needle) || (n.value ?? '').toLowerCase().includes(needle));
    }
  }
}

/** Center point of a node's bounds (the click point for desktop actions). */
export function nodeCenter(node: SurfaceNode): { x: number; y: number } | undefined {
  if (!node.bounds) return undefined;
  return {
    x: Math.round(node.bounds.x + node.bounds.width / 2),
    y: Math.round(node.bounds.y + node.bounds.height / 2),
  };
}

// ---------------------------------------------------------------------------
// Rendering — one canonical observation text for both surfaces
// ---------------------------------------------------------------------------

export interface RenderTreeOpts {
  /** Mark the tree as carried context from a handoff (handoff.ts). */
  carried?: boolean;
  maxNodes?: number;
}

/** Canonical tree text — the same shape whether the observation came from
 *  CDP or from a display backend:
 *    d2   textbox "Code" value="" @60,290 220x28
 *  Focused nodes are marked ` [focused]`. */
export function renderTree(tree: SurfaceTree, opts: RenderTreeOpts = {}): string {
  const head = tree.surface === 'browser'
    ? `surface: browser — ${tree.origin || '(unknown url)'}${tree.title ? ` — ${tree.title}` : ''}`
    : `surface: desktop — ${tree.origin || '(unknown display)'}${tree.title ? ` — ${tree.title}` : ''}`;
  const lines = [opts.carried ? `[carried ${head}]` : head];
  const max = opts.maxNodes ?? 200;
  let shown = 0;
  for (const n of tree.nodes) {
    if (shown >= max) {
      lines.push(`  … ${tree.nodes.length - shown} more`);
      break;
    }
    shown++;
    const pad = '  '.repeat(Math.min(n.depth, 8));
    let line = `${pad}${n.ref} ${n.role}`;
    if (n.name) line += ` "${n.name.slice(0, 160)}"`;
    if (n.value !== undefined && n.value !== '') line += ` value="${n.value.slice(0, 120)}"`;
    if (n.bounds) line += ` @${n.bounds.x},${n.bounds.y} ${n.bounds.width}x${n.bounds.height}`;
    if (n.focused) line += ' [focused]';
    lines.push(line);
  }
  if (!tree.nodes.length) lines.push('  (no interactive nodes)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Producers — adapters at the representation layer (transports untouched)
// ---------------------------------------------------------------------------

/** Browser producer: adapt a CDP PageSnapshot (src/browser/cdp/page.ts) into
 *  the shared tree. Refs/roles/names/values pass through as-is; bounds are
 *  NOT fetched here — the browser resolves a ref to a rect through the DOM
 *  domain at action time, so no extra CDP round-trips are spent just to
 *  re-describe the tree. */
export function treeFromPageSnapshot(
  snap: { url: string; title: string; elements: Array<{ ref?: string; role: string; name: string; value?: string; depth: number; focused?: boolean }> },
  surface: SurfaceKind = 'browser',
): SurfaceTree {
  const nodes: SurfaceNode[] = [];
  let focusedRef: string | undefined;
  for (const el of snap.elements) {
    if (!el.ref) continue; // context nodes (headings, text) carry no refs
    const focused = el.focused === true;
    nodes.push({
      ref: el.ref,
      role: el.role,
      name: el.name,
      ...(el.value !== undefined && el.value !== '' ? { value: el.value } : {}),
      depth: el.depth,
      ...(focused ? { focused: true } : {}),
      origin: surface,
    });
    if (focused && focusedRef === undefined) focusedRef = el.ref;
  }
  return {
    surface,
    title: snap.title ?? '',
    origin: snap.url ?? '',
    nodes,
    ...(focusedRef ? { focusedRef } : {}),
  };
}

/** Raw node a display backend reports (optional a11y() on DisplayBackend). */
export interface DesktopAxNode {
  role: string;
  name: string;
  value?: string;
  bounds: AxBounds;
  focused?: boolean;
}

/** Desktop producer: adapt backend-reported desktop nodes into the shared
 *  tree, assigning namespaced refs (`d<N>` in observation order). The display
 *  is the coordinate system, so every node carries bounds. */
export function treeFromDesktopNodes(
  raw: DesktopAxNode[],
  origin: string,
  title = '',
): SurfaceTree {
  const nodes: SurfaceNode[] = [];
  let focusedRef: string | undefined;
  raw.forEach((n, i) => {
    const ref = `d${i + 1}`;
    nodes.push({
      ref,
      role: n.role,
      name: n.name,
      ...(n.value !== undefined && n.value !== '' ? { value: n.value } : {}),
      bounds: { ...n.bounds },
      depth: 1,
      ...(n.focused ? { focused: true } : {}),
      origin: 'desktop',
    });
    if (n.focused && focusedRef === undefined) focusedRef = ref;
  });
  return {
    surface: 'desktop',
    title,
    origin,
    nodes,
    ...(focusedRef ? { focusedRef } : {}),
  };
}
