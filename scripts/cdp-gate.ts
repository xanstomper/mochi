// CDP measurement gate (brief: cdp-browser-brief.txt "Measurement gate").
//
// Fixed local fixture set (3 pages: static, form-heavy, JS-app shell), same
// machine, median of 5 per metric, CDP-native tool vs the existing browser
// path. Reports measured numbers whatever they are.
//
//   node --via tsx:  npx tsx scripts/cdp-gate.ts [--runs 5] [--out <file>]
//
// Sides:
//   CDP     = src/tools/cdp-browser.ts execute() (the production tool path:
//             singleton manager, spawn, attach, AX snapshot, evidence).
//   LEGACY  = src/browser/session.ts browserCall() against the playwright
//             daemon (the persistent path canvas/docs tools use) + the
//             one-shot driver for cold-start shape. Playwright must be
//             installed (npm i -g playwright && npx playwright install
//             chromium); if it is not, the legacy columns report SKIP and
//             the table says so — no invented numbers.
//
// Metrics per brief: cold-start ms (process spawn → first snapshot),
// RSS MB after load (browser process tree), time-to-snapshot, time-to-
// screenshot, click round-trip ms. bench/ is frozen — this harness lives in
// scripts/ and is run explicitly, never on import.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpBrowserTool } from '../src/tools/cdp-browser.js';
import { closeAllCdpSessions } from '../src/browser/cdp/manager.js';
import { closeBrowserSessions, browserCall, initBrowserSession, type BrowserSessionOptions } from '../src/browser/session.js';
import type { ToolContext } from '../src/tools/types.js';

// ------------------------------------------------------------------ fixtures

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

/** Sum RSS (KB) of a process tree via /proc — the browser's real footprint. */
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

// ------------------------------------------------------------------ CDP side

let wsCounter = 0;
let workRoot = '';
function toolCtx(): ToolContext {
  const cwd = join(workRoot, `cdp-ws-${++wsCounter}`);
  mkdirSync(cwd, { recursive: true });
  return {
    cwd,
    workspace: {} as ToolContext['workspace'],
    config: { permissions: { read: true, write: true, shell: true } } as unknown as ToolContext['config'],
    events: { emit: () => {} } as unknown as ToolContext['events'],
    agentId: 'cdp-gate',
  };
}

async function cdpRun(args: Record<string, unknown>): Promise<string> {
  return await cdpBrowserTool.execute(args, toolCtx());
}

interface SideMetrics {
  coldStart: number[];
  rssAfterLoadMb: number | undefined;
  timeToSnapshot: number[];
  timeToScreenshot: number[];
  clickRoundTrip: number[];
}

// ------------------------------------------------------------------ legacy side

function legacySessionOpts(profileDir: string): BrowserSessionOptions {
  return {
    workspaceDir: workRoot,
    profileDir,
    headless: true,
    browser: 'chromium',
  };
}

function legacyPidOf(opts: BrowserSessionOptions): number | undefined {
  // session.ts keeps brokers private; find the daemon via the state dir
  // sibling naming instead: the daemon is the node child of THIS process
  // running browser-daemon.mjs. Scan /proc for it.
  try {
    const entries = readdirSync('/proc').filter((d: string) => /^\d+$/.test(d));
    for (const pid of entries) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes('browser-daemon.mjs')) return Number(pid);
      } catch { /* raced */ }
    }
  } catch { /* no procfs */ }
  return undefined;
}

// ------------------------------------------------------------------ main

interface GateArgs { runs: number; out?: string }
const gateArgs: GateArgs = {
  runs: Math.max(1, Number(process.argv[process.argv.indexOf('--runs') + 1] ?? 5) || 5),
  out: process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined,
};

const { server, base } = await serveFixtures();
workRoot = mkdtempSync(join(tmpdir(), 'mochi-cdp-gate-'));
process.env.MOCHI_BROWSER_PROFILES_DIR = join(workRoot, 'profiles');
mkdirSync(process.env.MOCHI_BROWSER_PROFILES_DIR, { recursive: true });

console.log(`# CDP measurement gate — fixtures at ${base}, ${gateArgs.runs} runs per metric, median reported`);

// Playwright availability probe (legacy side).
let legacyAvailable = false;
let legacyDetail = '';
try {
  // The driver's command word must be argv[0]; flags come after.
  const driverPath = new URL('./browser-driver.mjs', import.meta.url).pathname;
  const probe = await import('../src/exec.js').then((m) => m.runArgv(process.execPath, [driverPath, 'navigate', `${base}/`, '--browser', 'chromium', '--profile', join(workRoot, 'probe-profile')], { timeoutMs: 90_000, killGraceMs: 3000 }));
  legacyAvailable = probe.code === 0 && /"ok"\s*:\s*true/.test(probe.stdout);
  legacyDetail = probe.code === 0 ? (probe.stdout.match(/"error":"([^"]{0,160})/)?.[1] ?? 'ok') : (probe.stderr.slice(0, 160) || `exit ${probe.code}`);
} catch (err) {
  legacyDetail = (err as Error).message.slice(0, 160);
}
console.log(`legacy (playwright daemon) available: ${legacyAvailable}${legacyAvailable ? '' : ` — ${legacyDetail}`}`);

// ---------------- CDP measurements ----------------
const cdp: SideMetrics = { coldStart: [], rssAfterLoadMb: undefined, timeToSnapshot: [], timeToScreenshot: [], clickRoundTrip: [] };

for (let i = 0; i < gateArgs.runs; i++) {
  cdp.coldStart.push(await time(() => cdpRun({ action: 'open', url: `${base}/` })));
}
// Warm browser for the warm metrics (last cold-start's browser).
const cdpCtx = toolCtx();
const warm = await cdpBrowserTool.execute({ action: 'open', url: `${base}/app` }, cdpCtx);
const loadRef = /e\d+ button "load"/.exec(warm)?.[0].split(' ')[0] ?? 'e1';
await cdpBrowserTool.execute({ action: 'click', ref: loadRef }, cdpCtx); // warm the page

// RSS after load: the browser tree of the warm session.
try {
  const { resolveProfileDir } = await import('../src/browser/profiles.js');
  const { mochiStateDir } = await import('../src/core/mochi-dir.js');
  const { getCdpSession } = await import('../src/browser/cdp/manager.js');
  const mgr = getCdpSession({
    workspaceDir: cdpCtx.cwd,
    profileDir: resolveProfileDir('default').entry.dir,
  });
  const child = (mgr as unknown as { child?: ChildProcess }).child;
  if (child?.pid) cdp.rssAfterLoadMb = treeRssKb(child.pid) / 1024;
} catch { /* report undefined */ }

for (let i = 0; i < gateArgs.runs; i++) {
  cdp.timeToSnapshot.push(await time(() => cdpBrowserTool.execute({ action: 'snapshot' }, cdpCtx)));
  cdp.timeToScreenshot.push(await time(() => cdpBrowserTool.execute({ action: 'screenshot' }, cdpCtx)));
  cdp.clickRoundTrip.push(await time(() => cdpBrowserTool.execute({ action: 'click', ref: loadRef }, cdpCtx)));
}

// ---------------- legacy measurements ----------------
const legacy: SideMetrics = { coldStart: [], rssAfterLoadMb: undefined, timeToSnapshot: [], timeToScreenshot: [], clickRoundTrip: [] };

if (legacyAvailable) {
  const profilesRoot = process.env.MOCHI_BROWSER_PROFILES_DIR as string;
  const runCold = async (): Promise<void> => {
    const opts = legacySessionOpts(join(profilesRoot, `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`));
    const t0 = performance.now();
    await initBrowserSession(opts);
    await browserCall(opts, 'navigate', { url: `${base}/` }, 60_000);
    await browserCall(opts, 'snapshot', {}, 60_000);
    legacy.coldStart.push(performance.now() - t0);
    await closeBrowserSessions();
  };
  for (let i = 0; i < gateArgs.runs; i++) await runCold();

  const warmOpts = legacySessionOpts(join(profilesRoot, 'legacy-warm'));
  await initBrowserSession(warmOpts);
  await browserCall(warmOpts, 'navigate', { url: `${base}/app` }, 60_000);
  await browserCall(warmOpts, 'click', { ref: '#load' }, 60_000);
  try {
    const daemonPid = legacyPidOf(warmOpts);
    if (daemonPid) legacy.rssAfterLoadMb = treeRssKb(daemonPid) / 1024;
  } catch { /* report undefined */ }
  for (let i = 0; i < gateArgs.runs; i++) {
    legacy.timeToSnapshot.push(await time(() => browserCall(warmOpts, 'snapshot', {}, 60_000)));
    legacy.timeToScreenshot.push(await time(() => browserCall(warmOpts, 'screenshot', { path: join(workRoot, `legacy-shot-${i}.png`) }, 60_000)));
    legacy.clickRoundTrip.push(await time(() => browserCall(warmOpts, 'click', { ref: '#b2' }, 60_000)));
  }
  await closeBrowserSessions();
}

// ---------------- report ----------------
const fmt = (xs: number[]): string => (xs.length ? `${median(xs).toFixed(0)}` : 'SKIP');
const rssFmt = (v: number | undefined): string => (v !== undefined ? v.toFixed(1) : 'n/a');

const rows: Array<[string, string, string, string]> = [
  ['cold-start ms (spawn → first snapshot)', fmt(cdp.coldStart), legacyAvailable ? fmt(legacy.coldStart) : 'SKIP', 'lower is better'],
  ['RSS MB after load (browser tree)', rssFmt(cdp.rssAfterLoadMb), legacyAvailable ? rssFmt(legacy.rssAfterLoadMb) : 'SKIP', 'lower is better'],
  ['time-to-snapshot ms (warm, median of 5)', fmt(cdp.timeToSnapshot), legacyAvailable ? fmt(legacy.timeToSnapshot) : 'SKIP', 'lower is better'],
  ['time-to-screenshot ms (warm, median of 5)', fmt(cdp.timeToScreenshot), legacyAvailable ? fmt(legacy.timeToScreenshot) : 'SKIP', 'lower is better'],
  ['click round-trip ms (warm, median of 5)', fmt(cdp.clickRoundTrip), legacyAvailable ? fmt(legacy.clickRoundTrip) : 'SKIP', 'lower is better'],
];

console.log('\n| metric | cdp_browser | legacy (playwright) | note |');
console.log('|---|---|---|---|');
for (const [m, c, l, note] of rows) console.log(`| ${m} | ${c} | ${l} | ${note} |`);

if (gateArgs.out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(gateArgs.out, JSON.stringify({
    base, runs: gateArgs.runs, legacyAvailable,
    cdp: {
      coldStart: cdp.coldStart, rssAfterLoadMb: cdp.rssAfterLoadMb,
      timeToSnapshot: cdp.timeToSnapshot, timeToScreenshot: cdp.timeToScreenshot,
      clickRoundTrip: cdp.clickRoundTrip,
    },
    legacy: legacyAvailable ? {
      coldStart: legacy.coldStart, rssAfterLoadMb: legacy.rssAfterLoadMb,
      timeToSnapshot: legacy.timeToSnapshot, timeToScreenshot: legacy.timeToScreenshot,
      clickRoundTrip: legacy.clickRoundTrip,
    } : undefined,
  }, null, 2) + '\n');
  console.log(`\nraw numbers: ${gateArgs.out}`);
}

closeAllCdpSessions();
closeBrowserSessions();
server.close();
rmSync(workRoot, { recursive: true, force: true });
process.exit(0);
