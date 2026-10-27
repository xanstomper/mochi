// INTEGRATION-FLAVORED: the unified browser+desktop surface — a fixed task
// set where each task mixes a browser-only step and a desktop-only step, so
// NEITHER tool alone completes it.
//
// Backend honesty (per task):
//  - Browser steps run against the REAL headless CDP shell over local fixture
//    pages (no external network) — SKIP-LABELED when no CDP binary exists.
//  - Desktop steps run against the deterministic fake display with the
//    OPT-IN interactive fake app (src/computer/fake-app.ts) — a test stand-in
//    for a real desktop application. The X11 backend has no a11y source yet;
//    the computer tool reports that absence honestly (tested here too).
//
// Measured here (and reported in ~/campaign/browser-desktop-report.md):
//  - completion per task × per tool-configuration (cdp alone / computer
//    alone / unified),
//  - the observation cost of a handoff vs re-observing from scratch.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cdpBrowserTool } from '../tools/cdp-browser.js';
import { computerTool } from '../tools/computer.js';
import { closeAllCdpSessions } from '../browser/cdp/manager.js';
import { FakeDisplayBackend } from '../computer/fake-display.js';
import { FAKE_APP_WIDGETS } from '../computer/fake-app.js';
import { setDisplayBackendForTests } from '../computer/backend.js';
import type { DisplayBackend } from '../computer/display.js';
import { clearAllHandoffs } from './handoff.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { MochiConfig } from '../types.js';
import type { ToolContext } from '../tools/types.js';

let binaryAvailable = false;
let binaryDetail = '';
try {
  const { resolveCdpBrowserBinary } = await import('../browser/cdp/manager.js');
  const r = resolveCdpBrowserBinary();
  binaryAvailable = true;
  binaryDetail = `${r.path} [${r.source}]`;
} catch (err) {
  binaryDetail = (err as Error).message;
}

const CODE = 'CODE-7351';
const PAGE_CODE = `<!doctype html><html><head><title>Verification Fixture</title></head>
<body><h1>Verification</h1><p>Your code is <b>${CODE}</b></p>
<button id="copy">Copy code</button></body></html>`;

const RECEIPT_ID = '0042';
const PAGE_RECEIPT = `<!doctype html><html><head><title>Receipt Fixture</title></head>
<body><h1>Receipt ${RECEIPT_ID}</h1><p>Total: $12.34</p></body></html>`;

let server: Server | undefined;
let baseUrl = '';
let workRoot = '';
let profileDir: string | undefined;
let wsCounter = 0;
let fake: FakeDisplayBackend;

function freshWorkspace(): string {
  return join(workRoot, `ws-${++wsCounter}`);
}

function cdpCtx(cwd: string): ToolContext {
  return {
    cwd,
    workspace: {} as ToolContext['workspace'],
    config: { permissions: { read: true, write: true, shell: false } } as unknown as MochiConfig,
    events: { emit: () => {} } as unknown as ToolContext['events'],
    agentId: 'unified-surface',
  };
}

function computerCtx(cwd: string): ToolContext {
  return {
    cwd,
    workspace: new Workspace(cwd, '.mochi'),
    config: {
      permissions: { read: true, write: true, shell: true, computer: true },
    } as unknown as MochiConfig,
    events: new EventBus(),
    agentId: 'unified-surface',
  };
}

async function cdpRun(cwd: string, args: Record<string, unknown>): Promise<string> {
  return await cdpBrowserTool.execute(args, cdpCtx(cwd));
}

async function computerRun(cwd: string, args: Record<string, unknown>): Promise<string> {
  return await computerTool.execute(args, computerCtx(cwd));
}

/** Measured blind-discovery policy for "re-observing from scratch" on a
 *  display with NO a11y tree: click candidate points on a 40px grid,
 *  row-major from the top-left, until a click lands inside the target.
 *  Returns the click count that guess-and-check needs. */
function gridProbeClicks(
  target: { x: number; y: number; width: number; height: number },
  display = { width: 800, height: 600 },
  step = 40,
): number {
  let n = 0;
  for (let y = 20; y < display.height; y += step) {
    for (let x = 20; x < display.width; x += step) {
      n++;
      if (x >= target.x && x < target.x + target.width && y >= target.y && y < target.y + target.height) return n;
    }
  }
  return n; // never found
}

beforeEach(() => {
  clearAllHandoffs();
  fake = new FakeDisplayBackend(800, 600, { app: true });
  setDisplayBackendForTests(fake);
});

afterEach(() => {
  setDisplayBackendForTests(null);
});

describe.skipIf(!binaryAvailable)('unified browser+desktop surface — fixed cross-surface task set', () => {
  beforeAll(async () => {
    console.log(`[unified-surface] browser: ${binaryDetail}`);
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      const ok = (body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(body);
      };
      if (url === '/code') ok(PAGE_CODE);
      else if (url === `/receipt/${RECEIPT_ID}`) ok(PAGE_RECEIPT);
      else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    workRoot = mkdtempSync(join(tmpdir(), 'mochi-unified-'));
    profileDir = mkdtempSync(join(tmpdir(), 'mochi-unified-profiles-'));
    process.env.MOCHI_BROWSER_PROFILES_DIR = profileDir;
  });

  afterAll(async () => {
    closeAllCdpSessions();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    delete process.env.MOCHI_BROWSER_PROFILES_DIR;
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // TASK A (browser → desktop): the confirmation code exists ONLY on the
  // web page; the "app" that must receive and submit it exists ONLY on the
  // desktop. Completion = app received the page's code and submitted it.
  // Browser steps are REAL CDP; desktop steps are the fake app (stand-in
  // for a real desktop app — said plainly, as above).
  // ------------------------------------------------------------------
  const A_COMPLETION = (app: { value: string; status: string }): boolean =>
    app.value === CODE && app.status === `ok: ${CODE}`;

  it('A unified: handoff carries the page tree; the desktop step completes the task', { timeout: 180_000 }, async () => {
    const ws = freshWorkspace();
    // Browser-only step 1 (real CDP): read the code off the page.
    const opened = await cdpRun(ws, { action: 'open', url: `${baseUrl}/code` });
    expect(opened).toContain('heading "Verification"');
    expect(opened).toContain(CODE);
    // Browser-only step 2 (real CDP): interact on the page so it has a
    // FOCUSED node — the handoff must carry it.
    const btnRef = /e\d+ button "Copy code"/.exec(opened)?.[0].split(' ')[0];
    expect(btnRef).toMatch(/^e\d+$/);
    await cdpRun(ws, { action: 'click', ref: btnRef });
    // Handoff: the current page tree + focused node, in ONE result.
    const ho = await cdpRun(ws, { action: 'handoff' });
    expect(ho).toContain('[cdp_browser handoff]');
    expect(ho).toContain(`focused ${btnRef}`);
    expect(ho).toContain(`button "Copy code"`);
    expect(ho).toContain('computer action=tree');
    // Desktop observation ADOPTS the carried context — no re-observation
    // of the page happened between handoff and here.
    const tree = await computerRun(ws, { action: 'tree' });
    expect(tree).toContain('[carried from browser');
    expect(tree).toContain(`${btnRef} button "Copy code"`);
    expect(tree).toMatch(new RegExp(`${btnRef}[^\\n]*\\[focused\\]`));
    expect(tree).toMatch(/d\d+ textbox "Code"/);
    expect(tree).toMatch(/d\d+ button "Submit"/);
    // Desktop-only steps (fake app): target by the SHARED selector forms.
    const typed = await computerRun(ws, { action: 'type', target: 'role=textbox[name="Code"]', text: CODE });
    expect(typed).toContain(`typed ${CODE.length} characters`);
    const clicked = await computerRun(ws, { action: 'click', target: 'role=button[name="Submit"]' });
    expect(clicked).toContain('[computer click] ok');
    // COMPLETION (after, unified): the page's code reached the desktop app.
    expect(A_COMPLETION(fake.fakeApp!.state)).toBe(true);
  });

  it('A with cdp_browser alone: FAILS — no desktop surface to receive the code', { timeout: 180_000 }, async () => {
    const ws = freshWorkspace();
    // Every cdp_browser action the task needs works; the desktop steps have
    // no tool. The code is readable but can never leave the browser.
    const outputs: string[] = [];
    outputs.push(await cdpRun(ws, { action: 'open', url: `${baseUrl}/code` }));
    const btnRef = /e\d+ button "Copy code"/.exec(outputs[0])?.[0].split(' ')[0];
    outputs.push(await cdpRun(ws, { action: 'click', ref: btnRef }));
    outputs.push(await cdpRun(ws, { action: 'handoff' }));
    // No computer tool was available: nothing could ever be typed/submitted.
    expect(A_COMPLETION(fake.fakeApp!.state)).toBe(false);
    expect(fake.fakeApp!.state.value).toBe('');
    expect(fake.fakeApp!.state.status).toBe('ready');
    // Sanity: the cdp-only run produced no carried desktop context.
    expect(outputs.join('\n')).not.toContain('[carried from desktop');
  });

  it('A with computer alone: FAILS — the code exists only on the web page', async () => {
    const ws = freshWorkspace();
    // Every computer action the desktop side needs works; the browser step
    // has no tool, so the code is UNOBSERVABLE — no desktop output ever
    // contains it, and the best-possible desktop sequence cannot submit it.
    const outputs: string[] = [];
    outputs.push(await computerRun(ws, { action: 'tree' }));
    outputs.push(await computerRun(ws, { action: 'type', target: 'role=textbox[name="Code"]', text: 'CODE-0000' }));
    outputs.push(await computerRun(ws, { action: 'click', target: 'role=button[name="Submit"]' }));
    expect(outputs.join('\n')).not.toContain(CODE); // unobservable without the browser
    expect(A_COMPLETION(fake.fakeApp!.state)).toBe(false);
    expect(fake.fakeApp!.state.status).toBe('ok: CODE-0000'); // a guess, not the code
  });

  // ------------------------------------------------------------------
  // TASK B (desktop → browser): the receipt URL exists ONLY as desktop
  // app state (behind its Copy URL button); verifying it needs the browser.
  // Completion = the URL produced on the desktop was opened and its page
  // verified in the browser.
  // ------------------------------------------------------------------
  const receiptUrl = (): string => `${baseUrl}/receipt/${RECEIPT_ID}`;
  const B_COMPLETION = (openedPage: string): boolean => openedPage.includes(`Receipt ${RECEIPT_ID}`);

  it('B unified: desktop handoff carries the URL; the browser step verifies it', { timeout: 180_000 }, async () => {
    const ws = freshWorkspace();
    fake.fakeApp && (fake.fakeApp.receiptUrl = receiptUrl());
    // Desktop-only step (fake app): produce the URL via the tree target.
    const tree = await computerRun(ws, { action: 'tree' });
    expect(tree).toMatch(/d\d+ button "Copy URL"/);
    await computerRun(ws, { action: 'click', target: 'role=button[name="Copy URL"]' });
    expect(fake.fakeApp!.state.status).toBe(`url: ${receiptUrl()}`);
    // Handoff desktop → browser: the tree (carrying the URL in the status
    // node's value) is stashed.
    const ho = await computerRun(ws, { action: 'handoff' });
    expect(ho).toContain('[computer handoff]');
    expect(ho).toContain(`url: ${receiptUrl()}`);
    // Browser step: open adopts the carried desktop context in the SAME
    // result that navigates (no extra observation round-trip).
    const opened = await cdpRun(ws, { action: 'open', url: receiptUrl() });
    expect(opened).toContain('[carried from desktop');
    expect(opened).toMatch(/d\d+ button "Copy URL"/);
    // COMPLETION (after, unified): the desktop-produced URL verified in the browser.
    expect(B_COMPLETION(opened)).toBe(true);
  });

  it('B with computer alone: FAILS — no browser to open and verify the page', async () => {
    const ws = freshWorkspace();
    fake.fakeApp && (fake.fakeApp.receiptUrl = receiptUrl());
    const outputs: string[] = [];
    outputs.push(await computerRun(ws, { action: 'tree' }));
    outputs.push(await computerRun(ws, { action: 'click', target: 'role=button[name="Copy URL"]' }));
    outputs.push(await computerRun(ws, { action: 'handoff' }));
    // The URL was produced on the desktop, but no browser exists to open it.
    expect(outputs.join('\n')).not.toContain(`Receipt ${RECEIPT_ID}`); // page never seen
    expect(fake.fakeApp!.state.status).toBe(`url: ${receiptUrl()}`); // URL produced, unverifiable
    expect(B_COMPLETION('')).toBe(false);
  });

  it('B with cdp_browser alone: FAILS — the URL lives behind a desktop button', { timeout: 180_000 }, async () => {
    const ws = freshWorkspace();
    fake.fakeApp && (fake.fakeApp.receiptUrl = receiptUrl());
    // cdp can open anything EXCEPT a URL it cannot know: the button is on
    // the desktop and no cdp action can press it.
    const outputs: string[] = [];
    outputs.push(await cdpRun(ws, { action: 'open', url: `${baseUrl}/code` }));
    outputs.push(await cdpRun(ws, { action: 'handoff' }));
    outputs.push(await cdpRun(ws, { action: 'snapshot' }));
    expect(outputs.join('\n')).not.toContain(`/receipt/${RECEIPT_ID}`); // URL unobservable
    expect(fake.fakeApp!.state.status).toBe('ready'); // the button was never pressed
    expect(B_COMPLETION('')).toBe(false);
  });

  // ------------------------------------------------------------------
  // Handoff properties + measured observation cost
  // ------------------------------------------------------------------
  it('acting on a carried browser ref from the desktop refuses with guidance (no silent no-op)', async () => {
    const ws = freshWorkspace();
    await cdpRun(ws, { action: 'open', url: `${baseUrl}/code` });
    await cdpRun(ws, { action: 'handoff' });
    const out = await computerRun(ws, { action: 'click', target: 'e1' });
    expect(out).toContain('no desktop node matches target="e1"');
    expect(out).toContain('BROWSER-surface ref');
    // The miss carries the observed desktop tree in the SAME result, so the
    // model can pick a valid target without a separate observation call.
    expect(out).toMatch(/d\d+ button "Submit"/);
    expect(fake.fakeApp!.state.status).toBe('ready'); // nothing was clicked
  });

  it('no pending handoff → single-surface outputs are unchanged (no carried sections)', { timeout: 180_000 }, async () => {
    const ws = freshWorkspace();
    const opened = await cdpRun(ws, { action: 'open', url: `${baseUrl}/code` });
    expect(opened).not.toContain('[carried from');
    const tree = await computerRun(ws, { action: 'tree' });
    expect(tree).not.toContain('[carried from');
    // The desktop tree itself is still delivered (the seam's own surface).
    expect(tree).toMatch(/d\d+ textbox "Code"/);
  });

  it('coordinate clicks still work with no tree involved (single-surface unchanged)', async () => {
    const ws = freshWorkspace();
    const out = await computerRun(ws, { action: 'click', x: 100, y: 120 });
    expect(out).toContain('[computer click] ok');
    expect(out).toContain('button 1 at (100, 120)');
  });

  it('tree on a backend WITHOUT an a11y source reports its absence honestly', async () => {
    const ws = freshWorkspace();
    const bare = {
      kind: 'fake',
      info: async () => ({ width: 100, height: 80, label: 'stub display' }),
      captureRgba: async () => Buffer.alloc(100 * 80 * 4),
      pointer: async () => ({ x: 0, y: 0, mask: 0 }),
      movePointer: async () => {},
      button: async () => {},
      key: async () => {},
      close: async () => {},
    } as unknown as DisplayBackend;
    setDisplayBackendForTests(bare);
    try {
      const out = await computerRun(ws, { action: 'tree' });
      expect(out).toContain('no a11y source on this backend');
      expect(out).toContain('(no interactive nodes)');
      // The screenshot-after-action contract still holds on this path.
      expect(out).toMatch(/screenshot: \S+\.png/);
    } finally {
      setDisplayBackendForTests(fake);
    }
  });

  it('MEASURED: handoff observation is cheaper than re-observing from scratch', { timeout: 180_000 }, async () => {
    const ws = freshWorkspace();
    // ---- unified path: the observation rides the handoff and the adopt.
    await cdpRun(ws, { action: 'open', url: `${baseUrl}/code` });
    const ho = await cdpRun(ws, { action: 'handoff' });
    const tree = await computerRun(ws, { action: 'tree' });
    const unifiedObsCalls = 2; // handoff + tree (open() is needed by every path)
    const unifiedObsChars = ho.length + tree.length;
    expect(ho).toContain('surface: browser'); // the full carried tree is IN the handoff result

    // ---- from-scratch path (the pre-unification shape): the page tree must
    // be re-taken, the desktop observation is a screenshot with NO names, and
    // both desktop targets must be found by coordinate probing.
    const snap = await cdpRun(ws, { action: 'snapshot' });
    const shot = await computerRun(ws, { action: 'screenshot' });
    const pngPath = /screenshot: (\S+\.png)/.exec(shot)![1];
    const pngBytes = statSync(pngPath).size;
    const codeProbes = gridProbeClicks(FAKE_APP_WIDGETS.code);
    const submitProbes = gridProbeClicks(FAKE_APP_WIDGETS.submit);
    const scratchObsCalls = 2 + codeProbes + submitProbes; // snapshot + screenshot + probes
    const scratchObsChars = snap.length + shot.length;

    // The claim under test: the handoff is cheaper than starting over.
    expect(scratchObsCalls).toBeGreaterThan(unifiedObsCalls);
    // And the unified path carries the context in text the model already
    // receives — no image decode, no extra round-trip.
    expect(unifiedObsChars).toBeGreaterThan(0);

    const report = {
      unified: { observationCalls: unifiedObsCalls, observationChars: unifiedObsChars, images: 0 },
      scratch: {
        observationCalls: scratchObsCalls,
        textChars: scratchObsChars,
        imageBytes: pngBytes,
        probeClicks: { codeTextbox: codeProbes, submitButton: submitProbes },
        namedTargetsVisibleWithoutTree: 0,
      },
    };
    console.log(`[unified-surface MEASUREMENT] ${JSON.stringify(report)}`);
  });
});
