// INTEGRATION: the real headless shell over real CDP against local fixture
// pages (tiny static server on 127.0.0.1, no external network).
//
// If no CDP browser binary is available in the environment, the whole suite
// skips with an explicit environment-missing label (SKIP-LABELED, counted
// separately — never silently absent). On this rig the pinned
// chrome-headless-shell from `mochi browser fetch-cdp-shell` (or the
// Hermes-bundled chromium via MOCHI_CDP_BROWSER) serves the runs.

import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdpBrowserTool } from '../../tools/cdp-browser.js';
import { closeAllCdpSessions } from './manager.js';
import type { ToolContext } from '../../tools/types.js';

let binaryAvailable = false;
let binaryDetail = '';
try {
  const { resolveCdpBrowserBinary } = await import('./manager.js');
  const r = resolveCdpBrowserBinary();
  binaryAvailable = true;
  binaryDetail = `${r.path} [${r.source}]`;
} catch (err) {
  binaryDetail = (err as Error).message;
}

let server: Server | undefined;
let baseUrl = '';
let workRoot = '';
let profileDir: string | undefined;

const PAGE_STATIC = `<!doctype html><html><head><title>Static Fixture</title></head>
<body><h1>Static Fixture</h1><p id="p">plain text paragraph</p>
<a id="to-form" href="/form">to the form</a></body></html>`;

const PAGE_FORM = `<!doctype html><html><head><title>Form Fixture</title></head>
<body><h1>Form Fixture</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted ' + document.getElementById('user').value;">
  <input id="user" name="user" placeholder="User">
  <input id="pw" name="pw" type="password">
  <button id="go" type="submit">Go</button>
</form>
<div id="out"></div>
</body></html>`;

const PAGE_APP = `<!doctype html><html><head><title>App Fixture</title></head>
<body><h1>App Fixture</h1>
<button id="load" onclick="fetch('/api/data').then(r=>r.json()).then(d=>{document.getElementById('list').textContent = d.items.join(', ')}).catch(()=>{document.getElementById('list').textContent='load failed'})">load</button>
<button id="alerter" onclick="alert('blocked by default')">alert</button>
<button id="logger" onclick="console.error('console-error-evidence')">log error</button>
<button id="notfound" onclick="fetch('/api/missing')">fetch 404</button>
<ul id="list"></ul>
</body></html>`;

function serve(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const ok = (body: string, type = 'text/html'): void => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (url === '/') ok(PAGE_STATIC);
    else if (url === '/form') ok(PAGE_FORM);
    else if (url === '/app') ok(PAGE_APP);
    else if (url === '/api/data') ok(JSON.stringify({ items: ['alpha', 'beta'] }), 'application/json');
    else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  });
  return new Promise((resolvePromise) => server!.listen(0, '127.0.0.1', resolvePromise));
}

function toolCtx(workspace: string): ToolContext {
  return {
    cwd: workspace,
    workspace: {} as ToolContext['workspace'],
    config: { permissions: { read: true, write: true, shell: false } } as unknown as ToolContext['config'],
    events: { emit: () => {} } as unknown as ToolContext['events'],
    agentId: 'cdp-integration',
  };
}

let wsCounter = 0;
function freshWorkspace(): string {
  return join(workRoot, `ws-${++wsCounter}`);
}

async function run(args: Record<string, unknown>, workspace?: string): Promise<string> {
  return await cdpBrowserTool.execute(args, toolCtx(workspace ?? freshWorkspace()));
}

describe.skipIf(!binaryAvailable)('cdp integration: real headless shell, local fixtures', () => {
  beforeAll(async () => {
    console.log(`[cdp-integration] browser: ${binaryDetail}`);
    await serve();
    const addr = server!.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    workRoot = mkdtempSync(join(tmpdir(), 'mochi-cdp-int-'));
    profileDir = mkdtempSync(join(tmpdir(), 'mochi-cdp-int-profiles-'));
    process.env.MOCHI_BROWSER_PROFILES_DIR = profileDir;
  });
  afterAll(async () => {
    closeAllCdpSessions();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    delete process.env.MOCHI_BROWSER_PROFILES_DIR;
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  });

  it('open returns the accessibility snapshot with stable refs', async () => {
    const out = await run({ action: 'open', url: `${baseUrl}/` });
    expect(out).toContain('[cdp_browser open]');
    expect(out).toContain('url:');
    expect(out).toContain('heading "Static Fixture"');
    expect(out).toMatch(/e\d+ link "to the form"/);
    expect(out).not.toMatch(/<html/); // token-light: no raw HTML dumps
  });

  it('click resolves a ref through the DOM domain and navigates', async () => {
    const ws = freshWorkspace();
    const opened = await run({ action: 'open', url: `${baseUrl}/` }, ws);
    const ref = /e(\d+) link "to the form"/.exec(opened)?.[0].split(' ')[0];
    expect(ref).toMatch(/^e\d+$/);
    await run({ action: 'click', ref }, ws);
    const snap = await run({ action: 'snapshot' }, ws);
    expect(snap).toContain('Form Fixture');
  });

  it('type + key drive the form end to end (snapshot, type, key, snapshot)', async () => {
    const ws = freshWorkspace();
    const opened = await run({ action: 'open', url: `${baseUrl}/form` }, ws);
    const userRef = /e\d+ textbox "User"/.exec(opened)?.[0].split(' ')[0];
    expect(userRef).toMatch(/^e\d+$/);
    await run({ action: 'type', ref: userRef, text: 'alice' }, ws);
    await run({ action: 'key', key: 'Enter' }, ws);
    const snap = await run({ action: 'snapshot' }, ws);
    expect(snap).toContain('submitted alice');
  });

  it('scroll scrolls the viewport', async () => {
    const ws = freshWorkspace();
    await run({ action: 'open', url: `${baseUrl}/` }, ws);
    const out = await run({ action: 'scroll', direction: 'down', amount: 120 }, ws);
    expect(out).toMatch(/\[cdp_browser scroll\] ok — 120px/);
  });

  it('eval is permission-gated at the tool layer', async () => {
    const out = await run({ action: 'eval', js: '1+1' });
    expect(out).toMatch(/permission-gated/);
  });

  it('eval runs with the session override and returns the value', async () => {
    const saved = process.env.MOCHI_CDP_ALLOW_EVAL;
    process.env.MOCHI_CDP_ALLOW_EVAL = '1';
    try {
      const out = await run({ action: 'eval', js: '({a: 40, b: 2}).a + ({a: 40, b: 2}).b' });
      expect(out).toContain('[cdp_browser eval] result: 42');
    } finally {
      if (saved === undefined) delete process.env.MOCHI_CDP_ALLOW_EVAL;
      else process.env.MOCHI_CDP_ALLOW_EVAL = saved;
    }
  });

  it('screenshot writes a real PNG (default path under the state dir)', async () => {
    const ws = freshWorkspace();
    await run({ action: 'open', url: `${baseUrl}/` }, ws);
    const out = await run({ action: 'screenshot' }, ws);
    const m = /saved: (\S+) \((\d+) bytes/.exec(out);
    expect(m).toBeTruthy();
    const bytes = readFileSync(m![1]);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('waits: selector, text, network-idle, ms', async () => {
    const ws = freshWorkspace();
    await run({ action: 'open', url: `${baseUrl}/form` }, ws);
    expect(await run({ action: 'wait', wait: 'selector', selector: '#go' }, ws)).toMatch(/selector matched: #go/);
    expect(await run({ action: 'wait', wait: 'text', text: 'Form Fixture' }, ws)).toMatch(/text found/);
    expect(await run({ action: 'wait', wait: 'network-idle' }, ws)).toMatch(/network idle/);
    expect(await run({ action: 'wait', wait: 'ms', ms: 30 }, ws)).toMatch(/waited 30ms/);
    const missed = await run({ action: 'wait', wait: 'selector', selector: '#does-not-exist', timeoutMs: 300 }, ws);
    expect(missed).toMatch(/\[cdp_browser wait\] ERROR: selector "#does-not-exist" not found within 300ms/);
  });

  it('tabs: new tab, list with active marker, switch, close-last shuts the browser down', async () => {
    const ws = freshWorkspace();
    await run({ action: 'open', url: `${baseUrl}/` }, ws);
    await run({ action: 'open', url: `${baseUrl}/form`, tab: 'new' }, ws);
    const listed = await run({ action: 'tabs' }, ws);
    expect(listed).toMatch(/2 open:/);
    // The form tab is the active one (order in Target.getTargets is not
    // insertion order — assert on content, not position).
    expect(listed).toMatch(/\[\d+\] \* http:\/\/127\.0\.0\.1:\d+\/form/);
    // Switch to the static tab by its target id (its url is baseUrl root).
    const staticId = listed
      .split('\n')
      .map((l) => /\[\d+\](?: \*)? (http:\/\/\S+) \(([0-9A-F]+)\)/.exec(l))
      .find((m) => m && m[1] === `${baseUrl}/`)
      ?.[2];
    expect(staticId).toMatch(/^[0-9A-F]+$/);
    const switched = await run({ action: 'tabs', tab: staticId }, ws);
    expect(switched).toMatch(/switched to http:\/\/127\.0\.0\.1:\d+\/( \()/);
    // Closing the last tab shuts the browser down.
    await run({ action: 'close', tab: '0' }, ws);
    const final = await run({ action: 'close' }, ws); // closes the remaining page
    expect(final).toMatch(/last page, browser shut down/);
  });

  it('dialogs are auto-dismissed and RECORDED in the next result', async () => {
    const ws = freshWorkspace();
    const opened = await run({ action: 'open', url: `${baseUrl}/app` }, ws);
    const alerterRef = /e\d+ button "alert"/.exec(opened)?.[0].split(' ')[0];
    await run({ action: 'click', ref: alerterRef }, ws);
    const snap = await run({ action: 'snapshot' }, ws);
    expect(snap).toMatch(/dialog auto-dismissed \(alert\): blocked by default/);
  });

  it('console errors and HTTP >= 400 attach to the next snapshot as evidence', async () => {
    const ws = freshWorkspace();
    const opened = await run({ action: 'open', url: `${baseUrl}/app` }, ws);
    const logRef = /e\d+ button "log error"/.exec(opened)?.[0].split(' ')[0];
    const nfRef = /e\d+ button "fetch 404"/.exec(opened)?.[0].split(' ')[0];
    await run({ action: 'click', ref: logRef }, ws);
    await run({ action: 'click', ref: nfRef }, ws);
    // The 404's responseReceived event needs a beat to land; a bounded wait
    // (which does NOT drain the evidence buffer) makes the snapshot
    // deterministic instead of racing the network round-trip.
    await run({ action: 'wait', wait: 'ms', ms: 250 }, ws);
    const snap = await run({ action: 'snapshot' }, ws);
    expect(snap).toMatch(/console error: console-error-evidence/);
    expect(snap).toMatch(/HTTP 404: http:\/\/127\.0\.0\.1:\d+\/api\/missing/);
    // Shown ONCE: the next snapshot starts clean.
    const clean = await run({ action: 'snapshot' }, ws);
    expect(clean).not.toMatch(/console-error-evidence/);
  });

  it('the JS-app shell renders fetched data after clicking load', async () => {
    const ws = freshWorkspace();
    const opened = await run({ action: 'open', url: `${baseUrl}/app` }, ws);
    const loadRef = /e\d+ button "load"/.exec(opened)?.[0].split(' ')[0];
    await run({ action: 'click', ref: loadRef }, ws);
    await run({ action: 'wait', wait: 'text', text: 'alpha, beta' }, ws);
    const snap = await run({ action: 'snapshot' }, ws);
    expect(snap).toContain('alpha, beta');
  });

  it('a killed browser is detected as a crash and the next call relaunches with the loss surfaced', async () => {
    const ws = freshWorkspace();
    await run({ action: 'open', url: `${baseUrl}/form` }, ws);
    // Reach into the singleton registry for THIS workspace and SIGKILL the browser.
    const { getCdpSession } = await import('./manager.js');
    const { mochiStateDir } = await import('../../core/mochi-dir.js');
    const { resolveProfileDir } = await import('../profiles.js');
    const mgr = getCdpSession({
      workspaceDir: ws,
      profileDir: resolveProfileDir('default').entry.dir,
    });
    const child = (mgr as unknown as { child?: { kill: (s: string) => void } }).child;
    expect(child).toBeTruthy();
    child!.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    const out = await run({ action: 'open', url: `${baseUrl}/form` }, ws);
    expect(out).toMatch(/\[restart\] browser crashed and was restarted/);
    expect(out).toMatch(/lost/);
  });

  it('profile state persists across calls (registry integration)', async () => {
    const ws = freshWorkspace();
    await run({ action: 'open', url: `${baseUrl}/form` }, ws);
    // The default profile is now registered — same registry the browser tool uses.
    const { listProfiles } = await import('../profiles.js');
    const profiles = listProfiles().filter((p) => !p.revoked);
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.find((p) => p.name === 'default')).toBeTruthy();
  });
});
