// Lightpanda fidelity suite (brief: lightpanda-brief.txt task 4).
//
// Identical local fixture pages for BOTH engines; pass/fail per case per
// engine — no averaging, no invented numbers:
//   1. JS-heavy SPA page (click → fetch → render → AX snapshot sees it)
//   2. Form-fill + login-style flow (default clear chord, then clear-free)
//   3. Cookie-session login flow (POST /login → GET /profile)
//   4. Deferred hydration (late node must appear in the AX tree)
//   5. Accessibility-snapshot parity vs Chromium (same page, diff the trees:
//      normalized role/name/depth element sequences)
//   6. Evidence parity (uncaught page errors reaching the evidence buffer)
//
//   npx tsx scripts/lightpanda-fidelity.ts [--out <file>]
//
// Local fixtures only — no external network in the committed suite. (The
// Google-blocked behavior note is a one-off probe recorded in the campaign
// report, not a repeatable suite case.) bench/ is frozen — this harness
// lives in scripts/ and is run explicitly, never on import.

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpBrowserTool } from '../src/tools/cdp-browser.js';
import { closeAllCdpSessions, getCdpSession, type CdpEngine } from '../src/browser/cdp/manager.js';
import type { CdpPage, PageSnapshot } from '../src/browser/cdp/page.js';
import type { ToolContext } from '../src/tools/types.js';

// ------------------------------------------------------------------ fixtures

const PAGE_STATIC = `<!doctype html><html><head><title>Fid Static</title></head>
<body><h1>Fid Static</h1><p id="p">plain text paragraph</p>
<a id="to-form" href="/form">to the form</a></body></html>`;

const PAGE_FORM = `<!doctype html><html><head><title>Fid Form</title></head>
<body><h1>Fid Form</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted ' + document.getElementById('user').value;">
  <label for="user">Username</label><input id="user" name="user" placeholder="User">
  <label for="pw">Password</label><input id="pw" name="pw" type="password">
  <button id="go" type="submit">Go</button>
</form>
<div id="out"></div>
</body></html>`;

const PAGE_LOGIN = `<!doctype html><html><head><title>Fid Login</title></head>
<body><h1>Fid Login</h1>
<form id="f" method="POST" action="/login">
  <label for="user">Username</label><input id="user" name="user" placeholder="User">
  <label for="pw">Password</label><input id="pw" name="pw" type="password">
  <button id="go" type="submit">Sign in</button>
</form>
<div id="out"></div>
<script>
document.getElementById('f').addEventListener('submit', function() {
  // seed the form action with the typed user so the POST body is deterministic
  var u = document.getElementById('user').value;
  this.action = '/login?who=' + encodeURIComponent(u);
});
</script>
</body></html>`;

const PAGE_APP = `<!doctype html><html><head><title>Fid App</title></head>
<body><h1>Fid App</h1>
<button id="load" onclick="fetch('/api/data').then(r=>r.json()).then(d=>{document.getElementById('list').textContent = d.items.join(', ')}).catch(()=>{document.getElementById('list').textContent='load failed'})">load</button>
<button id="route" onclick="history.pushState({}, '', '/spa/route2'); document.querySelector('h1').textContent = 'Routed View'">route</button>
<ul id="list"></ul>
<script>
  // Load-time uncaught exception: measures Runtime.exceptionThrown delivery
  // (the evidence buffer's uncaught-exception line).
  setTimeout(function(){ not_defined_variable; }, 100);
</script>
</body></html>`;

const PAGE_DEFER = `<!doctype html><html><head><title>Fid Defer</title></head>
<body><h1>Fid Defer</h1><div id="late"></div>
<script>
  setTimeout(function(){
    var b = document.createElement('button');
    b.id = 'late-btn'; b.textContent = 'late button';
    document.getElementById('late').appendChild(b);
    var t = document.createElement('p');
    t.id = 'late-text'; t.textContent = 'hydration complete';
    document.getElementById('late').appendChild(t);
  }, 400);
</script></body></html>`;

async function serveFixtures(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const ok = (body: string, type = 'text/html'): void => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (path === '/') ok(PAGE_STATIC);
    else if (path === '/form') ok(PAGE_FORM);
    else if (path === '/app') ok(PAGE_APP);
    else if (path === '/login') ok(PAGE_LOGIN);
    else if (path === '/defer') ok(PAGE_DEFER);
    else if (path === '/api/data') ok(JSON.stringify({ items: ['alpha', 'beta', 'gamma'] }), 'application/json');
    else if (path === '/spa/route2') ok('<!doctype html><html><head><title>Routed</title></head><body><h1>Routed View</h1></body></html>');
    else if (path === '/profile') {
      // Cookie session: only "logged in" when the session cookie round-trips.
      const cookie = req.headers.cookie ?? '';
      const who = /fid_session=([^;]+)/.exec(cookie)?.[1];
      if (who) ok(`<!doctype html><html><head><title>Profile</title></head><body><h1>Welcome, ${who}</h1><a href="/">home</a></body></html>`);
      else { res.writeHead(302, { location: '/login' }); res.end(); }
    }
    else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  });
  // /login POST: set the session cookie, redirect to /profile.
  const origListener = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.method === 'POST' && (req.url ?? '').startsWith('/login')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const who = /user=([^&]*)/.exec(body)?.[1] ?? 'user';
        res.writeHead(302, { 'set-cookie': `fid_session=${decodeURIComponent(who)}; Path=/`, location: '/profile' });
        res.end();
      });
      return;
    }
    (origListener as unknown as (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void)(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

// ------------------------------------------------------------------ helpers

let wsCounter = 0;
let workRoot = '';
function toolCtx(): ToolContext {
  const cwd = join(workRoot, `ws-${engineTag}-${++wsCounter}`);
  mkdirSync(cwd, { recursive: true });
  return {
    cwd,
    workspace: {} as ToolContext['workspace'],
    config: { permissions: { read: true, write: true, shell: true } } as unknown as ToolContext['config'],
    events: { emit: () => {} } as unknown as ToolContext['events'],
    agentId: 'lightpanda-fidelity',
  };
}

let engineTag = 'chromium';
async function run(args: Record<string, unknown>, ws?: string): Promise<string> {
  const ctx = toolCtx();
  if (ws) ctx.cwd = ws;
  const out = await cdpBrowserTool.execute(args, ctx);
  // The tool reports failures as labeled ERROR strings (it never throws past
  // the action boundary) — the suite must treat those as case failures, not
  // sail past them.
  if (/\[cdp_browser [a-z]+\] ERROR:/.test(out)) {
    throw new Error(out.split('\n')[0].slice(0, 300));
  }
  return out;
}

interface CaseResult { engine: CdpEngine; case: string; pass: boolean; detail: string }

async function check(engine: CdpEngine, name: string, fn: () => Promise<string>): Promise<CaseResult> {
  try {
    const detail = await fn();
    return { engine, case: name, pass: true, detail };
  } catch (err) {
    return { engine, case: name, pass: false, detail: (err as Error).message.slice(0, 300) };
  }
}

function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Structured AX snapshot of a page on the given engine's warm session. */
async function axSnapshot(engine: CdpEngine, ws: string): Promise<PageSnapshot> {
  const { resolveProfileDir } = await import('../src/browser/profiles.js');
  const mgr = getCdpSession({ workspaceDir: ws, profileDir: resolveProfileDir('default').entry.dir, engine });
  const page = (await mgr.ensurePage()) as CdpPage;
  return await page.snapshot();
}

/** Normalized element sequence for the parity diff: role/name/depth, refs
 *  dropped (they are per-snapshot counters), values kept (they carry state). */
function normalize(s: PageSnapshot, semanticOnly = false): string {
  // Chromium-internal layout nodes that carry no snapshot semantics (they are
  // line-box artifacts of Chromium's AX tree; Lightpanda does not emit them).
  const CHROMIUM_INTERNAL = new Set(['InlineTextBox', 'LineBreak']);
  return s.elements
    .filter((e) => !(semanticOnly && CHROMIUM_INTERNAL.has(e.role)))
    .map((e) => `${'  '.repeat(Math.min(e.depth, 8))}${e.role} "${e.name}"${e.value !== undefined && e.value !== '' ? ` = "${e.value}"` : ''}`)
    .join('\n');
}

/** Diff two normalized sequences; returns null when identical, else the note. */
function diffNote(c: string, l: string): string {
  const cl = c.split('\n');
  const ll = l.split('\n');
  const firstDiff = cl.findIndex((line, i) => line !== ll[i]);
  if (firstDiff === -1 && cl.length === ll.length) return 'identical';
  return `first divergence at line ${firstDiff + 1}: chromium="${cl[firstDiff]}" lightpanda="${ll[firstDiff]}" (chromium ${cl.length} lines vs lightpanda ${ll.length})`;
}

// ------------------------------------------------------------------ cases

async function runCases(engine: CdpEngine, base: string): Promise<CaseResult[]> {
  const saved = process.env.MOCHI_CDP_ENGINE;
  process.env.MOCHI_CDP_ENGINE = engine;
  engineTag = engine;
  const out: CaseResult[] = [];
  try {
    // ---- 1. JS-heavy SPA page
    out.push(await check(engine, 'SPA: click → fetch → rendered data in AX snapshot', async () => {
      const ws = join(workRoot, `${engine}-spa`);
      mkdirSync(ws, { recursive: true });
      const opened = await run({ action: 'open', url: `${base}/app` }, ws);
      const loadRef = /e\d+ button "load"/.exec(opened)?.[0].split(' ')[0];
      expect(loadRef, `no "load" button ref in snapshot: ${opened.slice(0, 200)}`);
      await run({ action: 'click', ref: loadRef }, ws);
      await run({ action: 'wait', wait: 'text', text: 'alpha, beta' }, ws);
      const snap = await run({ action: 'snapshot' }, ws);
      expect(snap.includes('alpha, beta, gamma'), `fetched items missing from snapshot: ${snap.slice(0, 300)}`);
      return 'fetch + render visible in snapshot';
    }));
    out.push(await check(engine, 'SPA: pushState route + DOM mutation', async () => {
      const ws = join(workRoot, `${engine}-spa-route`);
      mkdirSync(ws, { recursive: true });
      const opened = await run({ action: 'open', url: `${base}/app` }, ws);
      const routeRef = /e\d+ button "route"/.exec(opened)?.[0].split(' ')[0];
      expect(routeRef, 'no "route" button ref');
      await run({ action: 'click', ref: routeRef }, ws);
      await run({ action: 'wait', wait: 'text', text: 'Routed View' }, ws);
      const snap = await run({ action: 'snapshot' }, ws);
      expect(snap.includes('Routed View'), 'routed heading missing');
      expect(snap.includes('/spa/route2'), `pushState URL not reflected (url line): ${snap.split('\n')[0]}`);
      return 'history.pushState + mutation visible';
    }));

    // ---- 2. Form-fill + login-style flow
    out.push(await check(engine, 'form-fill with DEFAULT type (clear chord Ctrl+A+Del)', async () => {
      const ws = join(workRoot, `${engine}-form-default`);
      mkdirSync(ws, { recursive: true });
      const opened = await run({ action: 'open', url: `${base}/form` }, ws);
      const userRef = /e\d+ textbox "Username"/.exec(opened)?.[0].split(' ')[0];
      expect(userRef, `no Username textbox ref: ${opened.slice(0, 300)}`);
      // The input starts EMPTY, but the tool default still runs the clear
      // chord first — this is the production-default path, measured as-is.
      await run({ action: 'type', ref: userRef, text: 'alice' }, ws);
      const goRef = /e\d+ button "Go"/.exec(opened)?.[0].split(' ')[0];
      await run({ action: 'click', ref: goRef }, ws);
      const snap = await run({ action: 'snapshot' }, ws);
      expect(snap.includes('submitted alice'), `default-clear form submit wrong: ${snap.slice(0, 300)}`);
      return 'value === "alice" after default type';
    }));
    out.push(await check(engine, 'form-fill with clear:false (fresh field, no chord)', async () => {
      const ws = join(workRoot, `${engine}-form-noclear`);
      mkdirSync(ws, { recursive: true });
      const opened = await run({ action: 'open', url: `${base}/form` }, ws);
      const userRef = /e\d+ textbox "Username"/.exec(opened)?.[0].split(' ')[0];
      await run({ action: 'type', ref: userRef, text: 'bob', clear: false }, ws);
      const goRef = /e\d+ button "Go"/.exec(opened)?.[0].split(' ')[0];
      await run({ action: 'click', ref: goRef }, ws);
      const snap = await run({ action: 'snapshot' }, ws);
      expect(snap.includes('submitted bob'), `clear:false submit wrong: ${snap.slice(0, 300)}`);
      return 'value === "bob" with clear disabled';
    }));

    // ---- 3. Cookie-session login flow (POST → cookie → authenticated GET)
    out.push(await check(engine, 'login flow: POST form → session cookie → /profile shows user', async () => {
      const ws = join(workRoot, `${engine}-login`);
      mkdirSync(ws, { recursive: true });
      const opened = await run({ action: 'open', url: `${base}/login` }, ws);
      const userRef = /e\d+ textbox "Username"/.exec(opened)?.[0].split(' ')[0];
      const pwRef = /e\d+ textbox "Password"/.exec(opened)?.[0].split(' ')[0];
      expect(userRef && pwRef, 'login form fields missing');
      await run({ action: 'type', ref: userRef, text: 'carol', clear: false }, ws);
      await run({ action: 'type', ref: pwRef, text: 'hunter2', clear: false }, ws);
      const goRef = /e\d+ button "Sign in"/.exec(opened)?.[0].split(' ')[0];
      await run({ action: 'click', ref: goRef }, ws);
      await run({ action: 'wait', wait: 'text', text: 'Welcome, carol' }, ws);
      const snap = await run({ action: 'snapshot' }, ws);
      expect(snap.includes('Welcome, carol'), `session cookie did not round-trip: ${snap.slice(0, 300)}`);
      return 'POST → 302 → cookie → authenticated page rendered';
    }));

    // ---- 4. Deferred hydration
    out.push(await check(engine, 'deferred hydration: late node appears in AX tree', async () => {
      const ws = join(workRoot, `${engine}-defer`);
      mkdirSync(ws, { recursive: true });
      await run({ action: 'open', url: `${base}/defer` }, ws);
      await run({ action: 'wait', wait: 'text', text: 'hydration complete' }, ws);
      const snap = await run({ action: 'snapshot' }, ws);
      expect(/e\d+ button "late button"/.test(snap), `late button not interactive in snapshot: ${snap.slice(0, 300)}`);
      return 'late button interactive (ref) after 400ms';
    }));

    // ---- 5. AX parity vs chromium (recorded on BOTH engines; the diff is
    // decided at reporting time by comparing the two engines' sequences —
    // both RAW and SEMANTIC (chromium-internal roles filtered)).
    for (const page of ['/', '/form', '/app']) {
      out.push(await check(engine, `AX parity probe: ${page}`, async () => {
        const ws = join(workRoot, `${engine}-parity${page.replace('/', '-')}`);
        mkdirSync(ws, { recursive: true });
        await run({ action: 'open', url: `${base}${page}` }, ws);
        const snap = await axSnapshot(engine, ws);
        const seq = normalize(snap);
        expect(seq.length > 0, 'empty AX sequence');
        (globalThis as unknown as { __parityRaw?: Map<string, string> }).__parityRaw ??= new Map();
        (globalThis as unknown as { __parityRaw: Map<string, string> }).__parityRaw.set(`${engine}:${page}`, seq);
        (globalThis as unknown as { __paritySem?: Map<string, string> }).__paritySem ??= new Map();
        (globalThis as unknown as { __paritySem: Map<string, string> }).__paritySem.set(`${engine}:${page}`, normalize(snap, true));
        return `sequence captured (${snap.elements.length} elements)`;
      }));
    }

    // ---- 6. Evidence parity: uncaught page error reaching the buffer.
    // The open action drains the evidence buffer onto ITS result (shown
    // once) — the case asserts on the open output, not a later snapshot.
    out.push(await check(engine, 'evidence: uncaught page error appears in [evidence] block', async () => {
      const ws = join(workRoot, `${engine}-evidence`);
      mkdirSync(ws, { recursive: true });
      const opened = await run({ action: 'open', url: `${base}/app` }, ws);
      expect(/uncaught exception:/.test(opened), 'no uncaught-exception evidence on a page whose script throws 100ms after load');
      return 'uncaught exception surfaced in evidence';
    }));
  } finally {
    if (saved === undefined) delete process.env.MOCHI_CDP_ENGINE;
    else process.env.MOCHI_CDP_ENGINE = saved;
  }
  return out;
}

// ------------------------------------------------------------------ main

const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
const { server, base } = await serveFixtures();
workRoot = mkdtempSync(join(tmpdir(), 'mochi-lightpanda-fidelity-'));
process.env.MOCHI_BROWSER_PROFILES_DIR = join(workRoot, 'profiles');
mkdirSync(process.env.MOCHI_BROWSER_PROFILES_DIR, { recursive: true });

console.log(`# Lightpanda fidelity suite — fixtures at ${base}, identical pages per engine\n`);

const chromium = await runCases('chromium', base);
const lightpanda = await runCases('lightpanda', base);

// Parity verdicts: compare the two engines' normalized AX sequences — raw
// (everything) and semantic (chromium-internal layout nodes filtered).
const parityRaw = (globalThis as unknown as { __parityRaw?: Map<string, string> }).__parityRaw ?? new Map();
const paritySem = (globalThis as unknown as { __paritySem?: Map<string, string> }).__paritySem ?? new Map();
const parityRows: Array<{ page: string; rawIdentical: boolean; semanticIdentical: boolean; note: string }> = [];
for (const page of ['/', '/form', '/app']) {
  const c = parityRaw.get(`chromium:${page}`) ?? '';
  const l = parityRaw.get(`lightpanda:${page}`) ?? '';
  const cs = paritySem.get(`chromium:${page}`) ?? '';
  const ls = paritySem.get(`lightpanda:${page}`) ?? '';
  if (!c || !l) { parityRows.push({ page, rawIdentical: false, semanticIdentical: false, note: 'MISSING SEQUENCE' }); continue; }
  const rawIdentical = c === l;
  const semanticIdentical = cs === ls;
  parityRows.push({ page, rawIdentical, semanticIdentical, note: `raw: ${diffNote(c, l)} | semantic (no InlineTextBox/LineBreak): ${diffNote(cs, ls)}` });
}

const caseRow = (name: string): [string, string, string] => {
  const c = chromium.find((r) => r.case === name);
  const l = lightpanda.find((r) => r.case === name);
  return [name, c ? (c.pass ? 'PASS' : 'FAIL') : '—', l ? (l.pass ? 'PASS' : 'FAIL') : '—'];
};

console.log('| case | chromium (default) | lightpanda (opt-in) |');
console.log('|---|---|---|');
for (const name of [...new Set([...chromium, ...lightpanda].map((r) => r.case))]) {
  if (name.startsWith('AX parity probe')) continue;
  const [n, c, l] = caseRow(name);
  console.log(`| ${n} | ${c} | ${l} |`);
}
console.log('\nAX-snapshot parity (same page, diff the trees):');
for (const r of parityRows) {
  const verdict = r.rawIdentical ? 'IDENTICAL' : r.semanticIdentical ? 'SEMANTIC-IDENTICAL (raw differs)' : 'DIFF';
  console.log(`  ${verdict} ${r.page} — ${r.note}`);
}

// Failure details (the WHY, not just the verdict)
for (const [engineName, results] of [['chromium', chromium], ['lightpanda', lightpanda]] as const) {
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`\n[FAIL ${engineName}] ${r.case}\n  ${r.detail}`);
  }
}

if (outPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, JSON.stringify({ base, cases: [...chromium, ...lightpanda], parity: parityRows }, null, 2) + '\n');
  console.log(`\nraw results: ${outPath}`);
}

closeAllCdpSessions();
server.close();
rmSync(workRoot, { recursive: true, force: true });
process.exit(0);
