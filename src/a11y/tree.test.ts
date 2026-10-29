// Unit tests for the shared a11y-tree seam (src/a11y/tree.ts).
//
// The interchangeability contract under test:
//  1. both producers (CDP PageSnapshot adapter, desktop backend adapter) emit
//     the SAME SurfaceTree shape;
//  2. the shared selector vocabulary resolves against EITHER producer's tree;
//  3. a tree built from one producer is consumable by the other's action
//     path (selection + center resolution are producer-agnostic), and nodes
//     remember their origin so acting stays surface-scoped.

import { describe, it, expect } from 'vitest';
import {
  parseSelector,
  findNode,
  nodeCenter,
  renderTree,
  treeFromPageSnapshot,
  treeFromDesktopNodes,
  type SurfaceTree,
} from './tree.js';
import type { PageSnapshot } from '../browser/cdp/page.js';

function pageSnapshotFixture(): PageSnapshot {
  return {
    url: 'http://127.0.0.1:1234/form',
    title: 'Form',
    elements: [
      { role: 'heading', name: 'Sign up', depth: 1 },
      { ref: 'e1', role: 'textbox', name: 'User', value: '', depth: 2 },
      { ref: 'e2', role: 'button', name: 'Go', depth: 2, focused: true },
      { ref: 'e3', role: 'link', name: 'Terms', depth: 3 },
    ],
    refMap: new Map([['e1', 11], ['e2', 12], ['e3', 13]]),
    text: 'Sign up\nUser\nGo',
  };
}

function desktopNodesFixture(): Parameters<typeof treeFromDesktopNodes>[0] {
  return [
    { role: 'statictext', name: 'Confirmation code', bounds: { x: 60, y: 260, width: 180, height: 16 } },
    { role: 'textbox', name: 'Code', value: '', bounds: { x: 60, y: 284, width: 220, height: 28 }, focused: true },
    { role: 'button', name: 'Go', bounds: { x: 60, y: 324, width: 120, height: 32 } },
    { role: 'button', name: 'Copy URL', bounds: { x: 200, y: 324, width: 120, height: 32 } },
  ];
}

describe('shared tree model — both producers emit the same shape', () => {
  it('the browser producer adapts a PageSnapshot into a SurfaceTree', () => {
    const tree = treeFromPageSnapshot(pageSnapshotFixture());
    expect(tree.surface).toBe('browser');
    expect(tree.origin).toBe('http://127.0.0.1:1234/form');
    expect(tree.title).toBe('Form');
    // Ref-bearing elements only (the heading is context, no ref).
    expect(tree.nodes.map((n) => n.ref)).toEqual(['e1', 'e2', 'e3']);
    expect(tree.nodes[1]).toMatchObject({ role: 'button', name: 'Go', depth: 2, origin: 'browser' });
    // Focus carried from the snapshot's focused flag.
    expect(tree.focusedRef).toBe('e2');
    expect(tree.nodes[1].focused).toBe(true);
  });

  it('the desktop producer adapts backend nodes into the same SurfaceTree shape', () => {
    const tree = treeFromDesktopNodes(desktopNodesFixture(), 'fake 800x600');
    expect(tree.surface).toBe('desktop');
    expect(tree.origin).toBe('fake 800x600');
    // Same node fields as the browser producer, plus bounds (a display's
    // only coordinate system) and namespaced refs.
    for (const n of tree.nodes) {
      const expected = ['bounds', 'depth', 'name', 'origin', 'ref', 'role'];
      if (n.value !== undefined && n.value !== '') expected.push('value');
      if (n.focused) expected.push('focused');
      expect(Object.keys(n).sort()).toEqual(expected.sort());
      expect(n.ref).toMatch(/^d\d+$/);
      expect(n.origin).toBe('desktop');
      expect(n.bounds).toBeDefined();
      expect(n.depth).toBe(1);
    }
    expect(tree.focusedRef).toBe('d2');
    expect(tree.nodes[1]).toMatchObject({ role: 'textbox', name: 'Code', focused: true });
  });

  it('node field sets match between producers (same model, modulo surface data)', () => {
    const b = treeFromPageSnapshot(pageSnapshotFixture()).nodes[1];
    const d = treeFromDesktopNodes(desktopNodesFixture(), 'fake').nodes[1];
    // A browser node is a desktop node minus bounds (refs resolve to rects
    // lazily through the DOM domain — no extra CDP round-trips upfront).
    expect(new Set(Object.keys(d))).toEqual(new Set([...Object.keys(b), 'bounds']));
  });
});

describe('shared selector vocabulary — producer-agnostic resolution', () => {
  const browserTree = treeFromPageSnapshot(pageSnapshotFixture());
  const desktopTree = treeFromDesktopNodes(desktopNodesFixture(), 'fake 800x600');

  it('parses every selector form', () => {
    expect(parseSelector('e12')).toEqual({ kind: 'ref', ref: 'e12' });
    expect(parseSelector('d5')).toEqual({ kind: 'ref', ref: 'd5' });
    expect(parseSelector('role=button')).toEqual({ kind: 'role', role: 'button' });
    expect(parseSelector('role=button[name="Go"]')).toEqual({ kind: 'role', role: 'button', name: 'Go' });
    expect(parseSelector('role=button[name="say \\"hi\\""]')).toEqual({ kind: 'role', role: 'button', name: 'say "hi"' });
    expect(parseSelector('name="Go"')).toEqual({ kind: 'name', name: 'Go' });
    expect(parseSelector('text=go')).toEqual({ kind: 'text', text: 'go' });
    expect(parseSelector('Copy code')).toEqual({ kind: 'text', text: 'Copy code' });
    expect(parseSelector('')).toEqual({ kind: 'ref' });
  });

  it('the SAME selector forms resolve against both trees', () => {
    // Per-surface ref of the matching node: browser textbox/button are e1/e2,
    // desktop textbox/button are d2/d3 (the desktop fixture has a label node).
    for (const [tree, textboxRef, buttonRef] of [
      [browserTree, 'e1', 'e2'],
      [desktopTree, 'd2', 'd3'],
    ] as Array<[SurfaceTree, string, string]>) {
      expect(findNode(tree, textboxRef)?.ref).toBe(textboxRef);
      expect(findNode(tree, 'role=textbox')?.ref).toBe(textboxRef);
      expect(findNode(tree, `role=textbox[name="${textboxRef === 'e1' ? 'User' : 'Code'}"]`)?.ref).toBe(textboxRef);
      expect(findNode(tree, buttonRef)?.ref).toBe(buttonRef);
      expect(findNode(tree, 'role=button')?.ref).toBe(buttonRef);
      expect(findNode(tree, 'role=button[name="Go"]')?.ref).toBe(buttonRef);
      expect(findNode(tree, 'name="Go"')?.ref).toBe(buttonRef);
      expect(findNode(tree, 'text=go')?.ref).toBe(buttonRef);
      expect(findNode(tree, 'role=nosuchrole')).toBeUndefined();
    }
    // A role+name selector only matches the tree that actually has the node.
    expect(findNode(browserTree, 'role=textbox[name="User"]')?.ref).toBe('e1');
    expect(findNode(desktopTree, 'role=textbox[name="User"]')).toBeUndefined();
    expect(findNode(browserTree, 'role=textbox[name="Code"]')).toBeUndefined();
    expect(findNode(desktopTree, 'role=textbox[name="Code"]')?.ref).toBe('d2');
  });

  it('text= matches values too, refs are per-tree', () => {
    const withValue = treeFromDesktopNodes(
      [{ role: 'status', name: 'Status', value: 'url: http://x/receipt/0042', bounds: { x: 0, y: 0, width: 10, height: 10 } }],
      'fake',
    );
    expect(findNode(withValue, 'text=receipt')?.ref).toBe('d1');
    expect(findNode(browserTree, 'd2')).toBeUndefined();
    expect(findNode(desktopTree, 'e2')).toBeUndefined();
  });
});

describe('cross-consumability — one tree is consumable by the other surface\'s action path', () => {
  it('the desktop action path (center-of-bounds) consumes any producer\'s tree; origin scopes acting', () => {
    const browserTree = treeFromPageSnapshot(pageSnapshotFixture());
    const desktopTree = treeFromDesktopNodes(desktopNodesFixture(), 'fake 800x600');
    for (const tree of [browserTree, desktopTree]) {
      const node = findNode(tree, 'role=button[name="Go"]');
      expect(node).toBeDefined();
      // The desktop action path: nodeCenter → pointer coordinates. Browser
      // nodes carry no bounds (their action path resolves refs through the
      // DOM domain instead) — the shape is shared, the actuation is honest.
      if (node?.bounds) {
        expect(nodeCenter(node)).toEqual({ x: 120, y: 340 });
      } else {
        expect(nodeCenter(node!)).toBeUndefined();
      }
      // Acting stays surface-scoped: the node remembers where it came from.
      expect(node!.origin).toBe(tree.surface);
    }
  });

  it('the browser action path resolves its own refs and refuses foreign ones by shape', () => {
    // Browser refs resolve through the page's refMap (cdp/page.ts); a
    // desktop ref is simply absent there — the seam guarantees the SHAPES
    // match, not that a desktop node is silently actuated in a browser.
    const snap = pageSnapshotFixture();
    const desktopTree = treeFromDesktopNodes(desktopNodesFixture(), 'fake');
    expect(snap.refMap.get('e2')).toBe(12);
    expect(snap.refMap.get(findNode(desktopTree, 'role=button[name="Go"]')!.ref)).toBeUndefined();
  });
});

describe('renderTree — one canonical observation text for both surfaces', () => {
  it('renders browser and desktop trees in the same format', () => {
    const b = renderTree(treeFromPageSnapshot(pageSnapshotFixture()));
    const d = renderTree(treeFromDesktopNodes(desktopNodesFixture(), 'fake 800x600'));
    for (const text of [b, d]) {
      expect(text).toMatch(/^surface: /m);
      expect(text).toMatch(/e\d+ textbox|d\d+ textbox/);
      expect(text).toMatch(/button "Go"/);
      expect(text).toMatch(/\[focused\]/);
    }
    expect(b).toContain('surface: browser — http://127.0.0.1:1234/form — Form');
    expect(d).toContain('surface: desktop — fake 800x600');
    // Desktop lines carry bounds; browser lines carry no invented bounds.
    expect(d).toMatch(/d2 textbox "Code" @60,284 220x28/);
    expect(b).not.toMatch(/@\d+,\d+/);
  });

  it('marks carried trees and caps node count', () => {
    const tree = treeFromDesktopNodes(desktopNodesFixture(), 'fake');
    const out = renderTree(tree, { carried: true, maxNodes: 2 });
    expect(out).toContain('[carried surface: desktop — fake]');
    expect(out).toContain('… 2 more');
  });

  it('an empty tree renders honestly', () => {
    const out = renderTree(treeFromDesktopNodes([], 'x11 :99'));
    expect(out).toContain('surface: desktop — x11 :99');
    expect(out).toContain('(no interactive nodes)');
  });
});
