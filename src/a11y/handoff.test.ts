// Unit tests for the handoff path (src/a11y/handoff.ts): stashing a task's
// observation (tree + focused node) for the other surface, take-once
// semantics, and the carried-context rendering the destination embeds.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  stashHandoff,
  takeHandoff,
  peekHandoff,
  clearHandoff,
  clearAllHandoffs,
  carriedSection,
  type SurfaceHandoff,
} from './handoff.js';
import { treeFromPageSnapshot, treeFromDesktopNodes, type SurfaceTree } from './tree.js';
import type { PageSnapshot } from '../browser/cdp/page.js';

function browserHandoff(focusedRef?: string): SurfaceHandoff {
  const snap: PageSnapshot = {
    url: 'http://127.0.0.1:1234/form',
    title: 'Form',
    elements: [
      { ref: 'e1', role: 'textbox', name: 'User', value: 'CODE-7351', depth: 2, ...(focusedRef === 'e1' ? { focused: true } : {}) },
      { ref: 'e2', role: 'button', name: 'Go', depth: 2 },
    ],
    refMap: new Map([['e1', 11], ['e2', 12]]),
    text: 'Sign up',
  };
  const tree = treeFromPageSnapshot(snap);
  return { from: 'browser', tree, ...(focusedRef ? { focusedRef } : {}), handedAt: Date.now() };
}

function desktopHandoff(focusedRef?: string): SurfaceHandoff {
  const tree = treeFromDesktopNodes(
    [
      { role: 'textbox', name: 'Code', value: '', bounds: { x: 60, y: 284, width: 220, height: 28 }, ...(focusedRef === 'd1' ? { focused: true } : {}) },
      { role: 'button', name: 'Submit', bounds: { x: 60, y: 324, width: 120, height: 32 } },
    ],
    'fake 800x600',
  );
  return { from: 'desktop', tree, ...(focusedRef ? { focusedRef } : {}), handedAt: Date.now() };
}

beforeEach(() => clearAllHandoffs());

describe('handoff stash', () => {
  it('stashes and takes once (take-once: no stale context leaks)', () => {
    stashHandoff('/ws/a', browserHandoff('e1'));
    expect(peekHandoff('/ws/a')?.from).toBe('browser');
    const taken = takeHandoff('/ws/a');
    expect(taken?.focusedRef).toBe('e1');
    expect(taken?.tree.nodes.map((n) => n.ref)).toEqual(['e1', 'e2']);
    expect(takeHandoff('/ws/a')).toBeUndefined();
    expect(peekHandoff('/ws/a')).toBeUndefined();
  });

  it('a new stash replaces the previous one (latest observation wins)', () => {
    stashHandoff('/ws/a', browserHandoff());
    stashHandoff('/ws/a', desktopHandoff('d1'));
    const taken = takeHandoff('/ws/a')!;
    expect(taken.from).toBe('desktop');
    expect(taken.focusedRef).toBe('d1');
  });

  it('workspaces are isolated keys', () => {
    stashHandoff('/ws/a', browserHandoff());
    expect(peekHandoff('/ws/b')).toBeUndefined();
    clearHandoff('/ws/a');
    expect(peekHandoff('/ws/a')).toBeUndefined();
  });
});

describe('carried section — the destination renders the carried tree without re-observing', () => {
  it('renders the tree with carried marking, focus note, and surface-acting guidance', () => {
    const out = carriedSection(browserHandoff('e1'));
    expect(out).toContain('[carried from browser — 2 node(s), focused e1]');
    expect(out).toContain('[carried surface: browser — http://127.0.0.1:1234/form — Form]');
    expect(out).toMatch(/e1 textbox "User" value="CODE-7351".*\[focused\]/);
    expect(out).toContain('act only on this surface\'s nodes');
    expect(out).toContain('cdp_browser');
  });

  it('desktop handoffs point back at computer', () => {
    const out = carriedSection(desktopHandoff());
    expect(out).toContain('[carried from desktop — 2 node(s)]');
    expect(out).toContain('computer');
    expect(out).toMatch(/d1 textbox "Code"/);
  });
});

describe('focused node carries across (tree.focusedRef → handoff.focusedRef)', () => {
  it('browser focus lands in the stash', () => {
    stashHandoff('/ws/f', browserHandoff('e1'));
    const h = takeHandoff('/ws/f')!;
    expect(h.tree.focusedRef).toBe('e1');
    expect(h.focusedRef).toBe('e1');
  });

  it('a tree without focus carries no focusedRef', () => {
    const h = browserHandoff(); // no focused flag passed
    expect(h.tree.focusedRef).toBeUndefined();
    expect(h.focusedRef).toBeUndefined();
    expect(carriedSection(h)).not.toContain('focused');
  });
});
