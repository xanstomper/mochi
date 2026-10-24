// Lightpanda measurement gate (brief: lightpanda-brief.txt task 3 — "same
// discipline as scripts/cdp-gate.ts").
//
// The two ENGINES of cdp_browser against identical local fixture pages:
//   CHROMIUM  = chrome-headless-shell (the DEFAULT engine, unchanged)
//   LIGHTPANDA= the opt-in fast path (MOCHI_CDP_ENGINE=lightpanda)
// Both sides run the production tool path (src/tools/cdp-browser.ts
// execute(): manager singleton, spawn, attach, AX snapshot, evidence).
//
//   node --via tsx:  npx tsx scripts/lightpanda-gate.ts [--runs 5] [--out <file>]
//
// Metrics per brief: cold-start ms (process spawn → first snapshot), RSS MB
// after load (browser process tree), time-to-snapshot (warm, median-of-5),
// click round-trip ms (warm, median-of-5), screenshot — where Lightpanda
// cannot screenshot (no rendering engine; captureScreenshot returns a
// placeholder) the gate records UNSUPPORTED, never a fake number and never
// a DOM dump substituted for a screenshot. bench/ is frozen — this harness
// lives in scripts/ and is run explicitly, never on import.

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpBrowserTool } from '../src/tools/cdp-browser.js';
import { closeAllCdpSessions, type CdpEngine } from '../src/browser/cdp/manager.js';
import type { ToolContext } from '../src/tools/types.js';

// ------------------------------------------------------------------ fixtures
// IDENTICAL pages for both engines (brief requirement).

const PAGE_STATIC = `<!doctype html><html><head><title>Gate Static</title></head>
<body><h1>Gate Static</h1><p id="p">plain text paragraph with some content</p>
<a id="to-form" href="/form">to the form</a></body></html>`;

const PAGE_FORM = `<!doctype html><html><head><title>Gate Form</title></head>
<body><h1>Gate Form</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted ' + document.getElementById('user').value;">
  <input id="user" name="user" placeholder="User">
  <input id="email" name="email" type="email" placeholder="Email">
  <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
  <textarea id="bio"></textarea>
  <input id="pw" name="pw" type="password">
  <button id="go" type="submit">Go</button>
</form>
<div id="out"></div>
</body></html>`;

const PAGE_APP = `<!doctype html><html><head><title>Gate App</title></head>
<body><h1>Gate App</h1>
<button id="load" onclick="fetch('/api/data').then(r=>r.json()).then(d=>{document.getElementById('list').textContent = d.items.join(', ')}).catch(()=>{})">load</button>
<button id="b2" onclick="document.getElementById('list').textContent='toggled'">toggle</button>
<button id="b3" onclick="document.getElementById('list').textContent='reset'">reset</button>
<ul id="list"></ul>
</body></html>`;

async function serveFixtures(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const ok = (body: string, type = 'text/html'): void => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (url === '/') ok(PAGE_STATIC);
    else if (url === '/form') ok(PAGE_FORM);
    else if (url === '/app') ok(PAGE_APP);
    else if (url === '/api/data') ok(JSON.stringify({ items: ['alpha', 'beta', 'gamma'] }), 'application/json');
    else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

// ------------------------------------------------------------------ helpers

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Sum RSS (KB) of a process tree via /proc — the browser's real footprint.
 *  (Same measurement as scripts/cdp-gate.ts; duplicated here because bench/
 *  is frozen and scripts are standalone.) */
function treeRssKb(rootPid: number): number {
  const pageSize = 4096;
  const procs = new Map<number, number>(); // pid -> ppid
  const rss = new Map<number, number>();
  try {
    for (const pid of readdirSync('/proc').filter((d: string) => /^\d+$/.test(d))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        const fields = stat.slice(closeParen + 2).split(' ');
        const ppid = Number(fields[1]);
        const rssPages = Number(fields[21]);
        procs.set(Number(pid), ppid);
        rss.set(Number(pid), rssPages * pageSize / 1024);
      } catch { /* raced exit */ }
    }
  } catch { /* no procfs */ }
  let total = 0;
  const visit = (pid: number, seen: Set<number>): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    for (const [child, ppid] of procs) if (ppid === pid) visit(child, seen);
  };
  visit(rootPid, new Set());
  return total;
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

// ------------------------------------------------------------------ tool ctx

let wsCounter = 0;
let workRoot = '';
function toolCtx(): ToolContext {
  const cwd = join(workRoot, `ws-${++wsCounter}`);
  mkdirSync(cwd, { recursive: true });
  return {
    cwd,
    workspace: {} as ToolContext['workspace'],
    config: { permissions: { read: true, write: true, shell: true } } as unknown as ToolContext['config'],
    events: { emit: () => {} } as unknown as ToolContext['events'],
    agentId: 'lightpanda-gate',
  };
}

async function run(args: Record<string, unknown>): Promise<string> {
  return await cdpBrowserTool.execute(args, toolCtx());
}

interface EngineMetrics {
  coldStart: number[];
  rssAfterLoadMb: number | undefined;
  timeToSnapshot: number[];
  clickRoundTrip: number[];
  screenshot: 'ok' | 'UNSUPPORTED';
  screenshotMs: number[];
}

async function measureEngine(engine: CdpEngine, base: string, runs: number): Promise<EngineMetrics> {
  const saved = process.env.MOCHI_CDP_ENGINE;
  process.env.MOCHI_CDP_ENGINE = engine;
  const m: EngineMetrics = { coldStart: [], rssAfterLoadMb: undefined, timeToSnapshot: [], clickRoundTrip: [], screenshot: 'UNSUPPORTED', screenshotMs: [] };
  try {
    // Cold start: every run is a FRESH workspace → a fresh manager → a real
    // process spawn + attach + navigate + first snapshot.
    for (let i = 0; i < runs; i++) {
      m.coldStart.push(await time(() => run({ action: 'open', url: `${base}/` })));
    }
    // Warm session (its own workspace so it owns its process).
    const warmWs = join(workRoot, `ws-warm-${engine}`);
    mkdirSync(warmWs, { recursive: true });
    const warmCtx = { ...toolCtx(), cwd: warmWs };
    const warm = await cdpBrowserTool.execute({ action: 'open', url: `${base}/app` }, warmCtx);
    const loadRef = /e\d+ button "load"/.exec(warm)?.[0].split(' ')[0] ?? 'e1';
    await cdpBrowserTool.execute({ action: 'click', ref: loadRef }, warmCtx); // warm the page path

    // RSS after load: the browser process tree of the warm session.
    try {
      const { resolveProfileDir } = await import('../src/browser/profiles.js');
      const { getCdpSession } = await import('../src/browser/cdp/manager.js');
      const mgr = getCdpSession({
        workspaceDir: warmWs,
        profileDir: resolveProfileDir('default').entry.dir,
        engine,
      });
      const child = (mgr as unknown as { child?: { pid?: number } }).child;
      if (child?.pid) m.rssAfterLoadMb = treeRssKb(child.pid) / 1024;
    } catch { /* report undefined */ }

    for (let i = 0; i < runs; i++) {
      m.timeToSnapshot.push(await time(() => cdpBrowserTool.execute({ action: 'snapshot' }, warmCtx)));
      m.clickRoundTrip.push(await time(() => cdpBrowserTool.execute({ action: 'click', ref: loadRef }, warmCtx)));
    }
    // Screenshot: chromium measures; lightpanda records the refusal ONCE
    // (the tool refuses before any PNG is written — assert that here so the
    // UNSUPPORTED row is grounded, not asserted from memory).
    if (engine === 'chromium') {
      m.screenshot = 'ok';
      for (let i = 0; i < runs; i++) {
        m.screenshotMs.push(await time(() => cdpBrowserTool.execute({ action: 'screenshot' }, warmCtx)));
      }
    } else {
      const refusal = await cdpBrowserTool.execute({ action: 'screenshot' }, warmCtx);
      if (!/UNSUPPORTED/.test(refusal)) throw new Error(`lightpanda screenshot did not refuse: ${refusal.slice(0, 200)}`);
      m.screenshot = 'UNSUPPORTED';
    }
  } finally {
    if (saved === undefined) delete process.env.MOCHI_CDP_ENGINE;
    else process.env.MOCHI_CDP_ENGINE = saved;
  }
  return m;
}

// ------------------------------------------------------------------ main

interface GateArgs { runs: number; out?: string }
const gateArgs: GateArgs = {
  runs: Math.max(1, Number(process.argv[process.argv.indexOf('--runs') + 1] ?? 5) || 5),
  out: process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined,
};

const { server, base } = await serveFixtures();
workRoot = mkdtempSync(join(tmpdir(), 'mochi-lightpanda-gate-'));
process.env.MOCHI_BROWSER_PROFILES_DIR = join(workRoot, 'profiles');
mkdirSync(process.env.MOCHI_BROWSER_PROFILES_DIR, { recursive: true });

console.log(`# Lightpanda measurement gate — fixtures at ${base}, ${gateArgs.runs} runs per metric, median reported`);

// Binary resolution sanity (never a silent download; a missing binary is an
// honest failure here).
const { resolveCdpBrowserBinary } = await import('../src/browser/cdp/manager.js');
const chs = resolveCdpBrowserBinary(undefined, 'chromium');
const lp = resolveCdpBrowserBinary(undefined, 'lightpanda');
console.log(`chromium  : ${chs.path} [${chs.source}]`);
console.log(`lightpanda: ${lp.path} [${lp.source}]`);

const chromium = await measureEngine('chromium', base, gateArgs.runs);
const lightpanda = await measureEngine('lightpanda', base, gateArgs.runs);

const fmt = (xs: number[]): string => (xs.length ? median(xs).toFixed(0) : '—');
const rssFmt = (v: number | undefined): string => (v !== undefined ? v.toFixed(1) : 'n/a');

const rows: Array<[string, string, string, string]> = [
  ['cold-start ms (spawn → first snapshot)', fmt(chromium.coldStart), fmt(lightpanda.coldStart), 'lower is better'],
  ['RSS MB after load (browser tree)', rssFmt(chromium.rssAfterLoadMb), rssFmt(lightpanda.rssAfterLoadMb), 'lower is better'],
  ['time-to-snapshot ms (warm, median of 5)', fmt(chromium.timeToSnapshot), fmt(lightpanda.timeToSnapshot), 'lower is better'],
  ['click round-trip ms (warm, median of 5)', fmt(chromium.clickRoundTrip), fmt(lightpanda.clickRoundTrip), 'lower is better'],
  ['screenshot', fmt(chromium.screenshotMs), lightpanda.screenshot, 'lightpanda: no rendering engine — placeholder PNG refused'],
];

console.log('\n| metric | cdp_browser (chromium, default) | cdp_browser (lightpanda, opt-in) | note |');
console.log('|---|---|---|---|');
for (const [m, c, l, note] of rows) console.log(`| ${m} | ${c} | ${l} | ${note} |`);

if (gateArgs.out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(gateArgs.out, JSON.stringify({
    base, runs: gateArgs.runs,
    chromium: {
      coldStart: chromium.coldStart, rssAfterLoadMb: chromium.rssAfterLoadMb,
      timeToSnapshot: chromium.timeToSnapshot, clickRoundTrip: chromium.clickRoundTrip,
      screenshotMs: chromium.screenshotMs,
    },
    lightpanda: {
      coldStart: lightpanda.coldStart, rssAfterLoadMb: lightpanda.rssAfterLoadMb,
      timeToSnapshot: lightpanda.timeToSnapshot, clickRoundTrip: lightpanda.clickRoundTrip,
      screenshot: lightpanda.screenshot,
    },
  }, null, 2) + '\n');
  console.log(`\nraw numbers: ${gateArgs.out}`);
}

closeAllCdpSessions();
server.close();
rmSync(workRoot, { recursive: true, force: true });
process.exit(0);
