import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshotText, cdpBrowserTool, evalGateError, type CdpBrowserAction } from './cdp-browser.js';
import type { PageSnapshot } from '../browser/cdp/page.js';
import type { ToolContext } from './types.js';

// Unit tests for the tool layer's pure pieces (snapshot rendering, the eval
// permission gate, action discrimination). The full wiring against a REAL
// headless shell lives in cdp/integration.test.ts — SKIP-LABELED when no
// binary is installed.

function snapFixture(): PageSnapshot {
  return {
    url: 'http://127.0.0.1:1234/form',
    title: 'Form',
    elements: [
      { role: 'heading', name: 'Sign up', depth: 1 },
      { ref: 'e1', role: 'textbox', name: 'User', value: '', depth: 2 },
      { ref: 'e2', role: 'button', name: 'Go', depth: 2 },
    ],
    refMap: new Map([['e1', 11], ['e2', 12]]),
    text: 'Sign up\nUser\nGo',
  };
}

describe('buildSnapshotText — token-light page representation', () => {
  it('renders refs for interactive elements only, with depth indentation and evidence block', () => {
    const out = buildSnapshotText(snapFixture(), ['console error: boom']);
    expect(out).toContain('url: http://127.0.0.1:1234/form — Form');
    expect(out).toMatch(/e1 textbox "User"/);
    expect(out).toMatch(/e2 button "Go"/);
    expect(out).toMatch(/^ {2}heading "Sign up"/m); // heading: context, NO ref
    expect(out).not.toMatch(/e\d+ heading/);
    expect(out).toContain('[evidence — observed on this page since the last action]');
    expect(out).toContain('console error: boom');
  });

  it('caps the evidence block at 20 lines', () => {
    const evidence = Array.from({ length: 30 }, (_, i) => `console error: e${i}`);
    const out = buildSnapshotText({ ...snapFixture(), text: '' }, evidence);
    expect(out.match(/console error: e\d+/g)).toHaveLength(20);
  });
});

describe('eval gate — permission-gated like other exec surfaces', () => {
  const ctx = (permissions: unknown): ToolContext =>
    ({ config: { permissions } }) as unknown as ToolContext;

  it('denied by default (no shell tier, no override)', () => {
    expect(evalGateError(ctx({ read: true, write: true, shell: false }))).toMatch(/permission-gated/);
    expect(evalGateError(ctx({ read: true, write: true }))).toMatch(/permission-gated/);
  });

  it('allowed with the shell tier in config', () => {
    expect(evalGateError(ctx({ read: true, write: true, shell: true }))).toBeUndefined();
  });

  it('allowed with the explicit session override', () => {
    const saved = process.env.MOCHI_CDP_ALLOW_EVAL;
    process.env.MOCHI_CDP_ALLOW_EVAL = '1';
    try {
      expect(evalGateError(ctx({}))).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.MOCHI_CDP_ALLOW_EVAL;
      else process.env.MOCHI_CDP_ALLOW_EVAL = saved;
    }
  });
});

describe('cdp_browser tool — action discrimination and arg validation (no browser needed)', () => {
  let profilesDir: string;
  beforeAll(() => {
    profilesDir = mkdtempSync(join(tmpdir(), 'mochi-cdp-tool-'));
    process.env.MOCHI_BROWSER_PROFILES_DIR = profilesDir;
  });
  afterAll(() => {
    if (profilesDir) rmSync(profilesDir, { recursive: true, force: true });
    delete process.env.MOCHI_BROWSER_PROFILES_DIR;
  });

  const ctx: ToolContext = {
    cwd: tmpdir(),
    workspace: {} as ToolContext['workspace'],
    config: { permissions: { read: true, write: true, shell: false } } as ToolContext['config'],
    events: { emit: () => {} } as unknown as ToolContext['events'],
    agentId: 'test',
  };

  it('refuses unknown actions before touching any browser state', async () => {
    const out = await cdpBrowserTool.execute({ action: 'reboot' }, ctx);
    expect(out).toMatch(/unknown action "reboot"/);
    expect(out).toContain('open, snapshot, click');
  });

  it('refuses path-like profile arguments (credential safety, shared with profiles.ts)', async () => {
    const out = await cdpBrowserTool.execute({ action: 'snapshot', profile: '/home/user/.chrome' }, ctx);
    expect(out).toMatch(/profile must be a NAME/);
  });

  it('eval is denied BEFORE any browser launch when unpermitted', async () => {
    const out = await cdpBrowserTool.execute({ action: 'eval', js: '1+1' }, ctx);
    expect(out).toMatch(/permission-gated/);
  });
});

// The action union stays honest: adding a member without a case is a
// compile-time error in the tool's switch (default returns unimplemented).
export type { CdpBrowserAction };
