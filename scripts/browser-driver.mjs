#!/usr/bin/env node
// Mochi browser driver — Cline-grade browser automation WITHOUT a runtime dep.
//
// Mochi ships as a Bun-compiled binary with ZERO runtime deps, so it can't
// `import 'playwright'` at bundle time. This driver runs under plain node and
// loads the GLOBALLY-installed playwright by resolving it from `npm root -g`
// (or $MOCHI_BROWSER_NODE_MODULES). The `browser` tool shells out to this
// script and parses its JSON.
//
// Subcommands (each prints one JSON object to stdout):
//   navigate <url> [--wait <ms>]  load page; return {title,url,text,inputs}
//   get <url> [--wait <ms>]       alias of navigate
//   click <selector>              click first match; node snapshot after
//   type <sel> <text>             focus + type first match
//   fill <sel> <text>             clear + type first match
//   text [sel]                    human-readable text of page or a node
//   links [sel]                   {href,text,sel}[] of page or a node
//   html [sel]                    outerHTML of node (or documentElement)
//   inputs [sel]                  interactive elements + css-path selector each
//   screenshot <path>             full-page PNG
//   eval <js>                     run JS in page; JSON-serialize the result
//   press <key>                   keyboard.press (Enter/Escape/Tab/...); snapshot
//   scroll [sel|<pixels>]         scroll element into view, or window by pixels
//   waitfor <selector>            waitForSelector with nav timeout; snapshot
//   waitfor networkidle|load|domcontentloaded
//                                 wait for that page load state instead
//   waitfor url:<glob-or-part>    waitForURL on the active page
//   select <sel> <value>          selectOption on a <select> element
//   hover <selector>              hover first match; snapshot
//   tabs                          list open tabs {index,url,title,active}
//   newtab [url]                  open a new tab (optionally at url); snapshot
//   switchtab <index|url-part>   make another tab the active page; snapshot
//   closetab [index|url-part]     close a tab (default: active); tabs after
//   download <sel> [dest]         click sel, await the download it triggers,
//                                 save to dest (file or dir) or ./downloads/
//   upload <sel> <path[,path]>    setInputFiles on a file input
//   extract [sel]                 main content as clean markdown-ish text;
//                                 also returns the largest table structured
//
// Tab sessions: pages die with each driver process, but with a persistent
// context the tab SET (URLs + active index) is stored in
// <profile>/mochi-tabs.json and restored on the next launch, so multi-tab
// workflows (compare pages, OAuth popups, download pages) survive across
// tool calls. Popups the site opens join the set automatically.
//
// Flags: --browser <firefox|chromium|webkit> (default autodetect from cache),
//        --headed (default off), --wait/-w <ms>, --timeout <ms> (nav, dflt 30s),
//        --frame <css|name> (run selector commands inside that iframe),
//        --profile <dir> (persistent profile dir; env MOCHI_BROWSER_PROFILE,
//        default ~/.cache/mochi/browser-profile). The browser launches with a
//        PERSISTENT context so cookies/localStorage/login state survive
//        across invocations, making multi-step flows (login -> navigate ->
//        act) possible. Falls back to an ephemeral launch if that fails.
// Console errors/warnings and pageerrors are collected during the run and
// included in the JSON output as `consoleErrors` (capped) so callers can use
// them as verification evidence instead of them being swallowed.
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function globalRoot() {
  const env = process.env.MOCHI_BROWSER_NODE_MODULES;
  if (env) return env;
  try {
    const out = execSync('npm root -g', { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return path.join(os.homedir(), '.npm-global', 'lib', 'node_modules');
}

let pw;
try {
  pw = await import(path.join(globalRoot(), 'playwright', 'index.mjs'));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `playwright unavailable (${e.message}). Install: npm i -g playwright && npx playwright install firefox` }));
  process.exit(0);
}

const args = process.argv.slice(2);
const FLAG_NAMES = new Set(['--browser', '--wait', '-w', '--timeout', '--headless', '--headed', '--url', '-u', '--profile', '--frame']);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
// Positional (non-flag) args, skipping both flag names AND their values.
const positional = (() => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAG_NAMES.has(a)) { i++; continue; } // skip flag + its value
    if (a.startsWith('--') && FLAG_NAMES.has(a.split('=')[0])) { continue; }
    if (!a.startsWith('--')) out.push(a);
  }
  return out;
})();
const desired = flag('--browser') || 'firefox';
// Persistent profile dir: --profile wins, then env, then the default cache
// location. Exported shape is also used by `probe` (no browser launch).
function resolveProfileDir() {
  return flag('--profile') || process.env.MOCHI_BROWSER_PROFILE ||
    path.join(os.homedir(), '.cache', 'mochi', 'browser-profile');
}
const profileDir = resolveProfileDir();
// Tab-session state lives NEXT TO the profile's browser data so it survives
// exactly as long as the login state it complements.
const tabsStatePath = () => path.join(profileDir, 'mochi-tabs.json');
function loadTabState() {
  try {
    const st = JSON.parse(fs.readFileSync(tabsStatePath(), 'utf8'));
    if (st && Array.isArray(st.tabs)) return st;
  } catch { /* no state yet — single-page behavior */ }
  return null;
}
const waitMs = Number(flag('--wait') ?? flag('-w') ?? 0) || 0;
const navTimeout = Number(flag('--timeout') ?? 30000) || 30000;
const cmd = args[0];
const argv = (n) => positional[1 + n]; // args after the command word are positional

function pickBrowser() {
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    if (fs.existsSync(cache)) {
      const names = fs.readdirSync(cache);
      if (names.some((n) => n.startsWith('chromium'))) return 'chromium';
      if (names.some((n) => n.startsWith('firefox'))) return 'firefox';
      if (names.some((n) => n.startsWith('webkit'))) return 'webkit';
    }
  } catch { /* ignore */ }
  return desired;
}

// Prepended to every page function so DOM ops can return stable css-paths.
const HELPERS = `globalThis.__mkCss=function(el){if(!el)return'';if(el.id)return'#'+CSS.escape(el.id);let parts=[];let n=el;while(n&&n.nodeType===1&&n!==document.body&&parts.length<4){let s=n.tagName.toLowerCase();if(typeof n.className==='string'&&n.className.trim()){const c=n.className.trim().split(/\\s+/).slice(0,2).map(function(x){return'.'+CSS.escape(x)}).join('');if(c.length<30)s+=c;}const p=n.parentElement;if(p){const sib=Array.prototype.filter.call(p.children,function(c){return c.tagName===n.tagName});if(sib.length>1)s+=':nth-child('+(Array.prototype.indexOf.call(p.children,n)+1)+')';}parts.unshift(s);n=p;}return parts.join(' > ')};`;
// Statement-list wrapper: the helper assignment first, then the body function
// invoked as the final expression statement. Firefox's evaluate rejects the
// parenthesized comma/`;`-list form, so use a bare statement sequence.
const fn = (body) => `${HELPERS}\n(${body})();`;

// Structured extraction, run IN the page via page.evaluate(extractInPage, sel).
// Self-contained (Playwright serializes it): clones the target subtree,
// strips chrome/noise elements, renders a markdown-ish text view, and parses
// the largest <table> into {headers, rows} so data tasks get structure, not
// a wall of text.
function extractInPage(sel) {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return { ok: false, error: 'selector not found' };
  // Structured table first (from the live DOM, before any stripping).
  let table;
  const tables = Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll('table') : []);
  if (root.tagName === 'TABLE') tables.unshift(root);
  if (tables.length) {
    let best = null;
    for (const t of tables) {
      const rows = t.querySelectorAll('tr');
      if (!best || rows.length > best.querySelectorAll('tr').length) best = t;
    }
    const cellText = (c) => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const allRows = Array.prototype.slice.call(best.querySelectorAll('tr'));
    let headers = [];
    let bodyRows = allRows;
    const headCells = best.querySelectorAll('thead th, thead td');
    if (headCells.length) {
      headers = Array.prototype.map.call(headCells, cellText);
      bodyRows = allRows.filter((r) => !r.closest('thead'));
    } else if (allRows.length) {
      const first = allRows[0].querySelectorAll('th');
      if (first.length) { headers = Array.prototype.map.call(first, cellText); bodyRows = allRows.slice(1); }
    }
    const rows = bodyRows.slice(0, 200).map((r) =>
      Array.prototype.map.call(r.querySelectorAll('th,td'), cellText));
    table = { headers, rows, rowCount: bodyRows.length };
  }
  // Markdown-ish rendering of a noise-stripped clone.
  const clone = root.cloneNode(true);
  const NOISE = 'script,style,noscript,iframe,svg,nav,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';
  Array.prototype.forEach.call(clone.querySelectorAll(NOISE), (n) => n.remove());
  const inline = (node) => {
    let s = '';
    node.childNodes.forEach((c) => {
      if (c.nodeType === 3) { s += c.textContent || ''; return; }
      if (c.nodeType !== 1) return;
      const tag = c.tagName;
      if (tag === 'BR') { s += '\n'; return; }
      if (tag === 'A') { const t = inline(c).trim(); const h = c.getAttribute('href') || ''; s += h && t ? `[${t}](${h})` : t; return; }
      if (tag === 'STRONG' || tag === 'B') { s += `**${inline(c).trim()}**`; return; }
      if (tag === 'EM' || tag === 'I') { s += `*${inline(c).trim()}*`; return; }
      if (tag === 'CODE') { s += `\`${(c.textContent || '').trim()}\``; return; }
      if (tag === 'IMG') { const alt = c.getAttribute('alt'); if (alt) s += `[img: ${alt}]`; return; }
      s += inline(c);
    });
    return s;
  };
  const lines = [];
  const block = (node) => {
    node.childNodes.forEach((c) => {
      if (c.nodeType === 3) { const t = (c.textContent || '').replace(/\s+/g, ' ').trim(); if (t) lines.push(t); return; }
      if (c.nodeType !== 1) return;
      const tag = c.tagName;
      if (/^H[1-6]$/.test(tag)) { lines.push(`${'#'.repeat(Number(tag[1]))} ${inline(c).replace(/\s+/g, ' ').trim()}`); return; }
      if (tag === 'P') { const t = inline(c).replace(/\s+/g, ' ').trim(); if (t) lines.push(t); return; }
      if (tag === 'UL' || tag === 'OL') {
        Array.prototype.forEach.call(c.children, (li, i) => {
          const t = inline(li).replace(/\s+/g, ' ').trim();
          if (t) lines.push(`${tag === 'OL' ? `${i + 1}.` : '-'} ${t}`);
        });
        return;
      }
      if (tag === 'BLOCKQUOTE') { const t = inline(c).replace(/\s+/g, ' ').trim(); if (t) lines.push(`> ${t}`); return; }
      if (tag === 'PRE') { lines.push('```', (c.textContent || '').trim(), '```'); return; }
      if (tag === 'TABLE') {
        const rows = Array.prototype.map.call(c.querySelectorAll('tr'), (r) =>
          Array.prototype.map.call(r.querySelectorAll('th,td'), (x) => (x.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)));
        for (const r of rows) if (r.length) lines.push(`| ${r.join(' | ')} |`);
        return;
      }
      if (tag === 'HR') { lines.push('---'); return; }
      block(c); // div/section/article/main/span/form/... — recurse
    });
  };
  block(clone);
  const md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
  return { ok: true, extract: md, table, title: document.title, url: location.href };
}

async function main() {
  // probe: report driver readiness WITHOUT launching a browser (used by
  // `mochi doctor` and tests). Exits before any browser code runs.
  if (cmd === 'probe') {
    const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
    let browsers = [];
    try {
      if (fs.existsSync(cache)) browsers = fs.readdirSync(cache).filter((n) => /^(chromium|firefox|webkit)/.test(n));
    } catch {}
    console.log(JSON.stringify({ ok: true, playwright: true, browsers, command: 'probe', profile: profileDir, profileDir }));
    return;
  }
  const name = pickBrowser();
  const type = pw[name] || pw.firefox;
  const headless = !has('--headed');
  const viewport = { width: 1280, height: 900 };
  let browser;
  let context;
  let page;
  // Prefer a PERSISTENT context so cookies / localStorage / auth survive
  // across invocations. launchPersistentContext returns a BrowserContext
  // (not a Browser): reuse its first page or create one. Any failure (e.g.
  // profile locked by a concurrent run, browser without persistent support)
  // falls back to the plain ephemeral launch path.
  try {
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* launch will surface real errors */ }
    context = await type.launchPersistentContext(profileDir, { headless, args: ['--no-sandbox'], viewport, acceptDownloads: true });
    page = context.pages()[0] ?? await context.newPage();
  } catch {
    context = undefined;
    try {
      browser = await type.launch({ headless, args: ['--no-sandbox'] });
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: `failed to launch ${name}: ${e.message}` }));
      return;
    }
    page = await browser.newPage({ viewport, acceptDownloads: true });
  }
  const ctx = () => context ?? page.context();
  // Tab-session restore (persistent path only): pages died with the last
  // driver process, so rebuild the recorded tab set and re-activate the
  // tab the session was left on. Best-effort — a tab that fails to load
  // must not take the whole run down with it.
  if (context) {
    const st = loadTabState();
    if (st && st.tabs.some((u) => u && u !== 'about:blank')) {
      try {
        const pages = [page];
        for (let i = 1; i < st.tabs.length; i++) pages.push(await context.newPage());
        await Promise.all(pages.map((p, i) => (st.tabs[i] && st.tabs[i] !== 'about:blank'
          ? p.goto(st.tabs[i], { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => {})
          : Promise.resolve())));
        const ai = Math.min(Math.max(0, Number(st.active) || 0), pages.length - 1);
        page = pages[ai];
        await page.bringToFront().catch(() => {});
      } catch { /* restore is best-effort; single-page behavior still works */ }
    }
  }
  // Surface page errors instead of swallowing them: collect console
  // error/warning messages + uncaught pageerrors, capped for output size.
  const consoleErrors = [];
  const MAX_CONSOLE_ERRORS = 20;
  const pushConsoleError = (type, text) => {
    if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
    consoleErrors.push({ type: String(type || 'error'), text: String(text ?? '').slice(0, 500) });
  };
  const attachErrorHandlers = (p) => {
    p.on('console', (msg) => {
      try {
        const t = msg.type();
        if (t === 'error' || t === 'warning') pushConsoleError(t, msg.text());
      } catch { /* a broken console event must never break the run */ }
    });
    p.on('pageerror', (err) => pushConsoleError('pageerror', err?.message ?? err));
  };
  attachErrorHandlers(page);
  // Restored tabs and site-opened popups get the same error collection.
  try { for (const p of ctx().pages()) { if (p !== page) attachErrorHandlers(p); } } catch { /* */ }
  try { ctx().on('page', (p) => attachErrorHandlers(p)); } catch { /* */ }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let out = { ok: false, error: 'no command' };

  // Optional iframe scope (--frame <css-selector|frame-name>): selector
  // commands then run against the frame instead of the top page. Resolved
  // once, against the page active at launch — frame + tab-switching in one
  // call is not a supported combination.
  const frameSel = flag('--frame');
  let scopeRef = page;
  let frameMissing = null;
  const resolveFrame = async () => {
    if (!frameSel) return;
    let frame = null;
    try {
      const handle = await page.$(frameSel);
      if (handle) frame = await handle.contentFrame();
    } catch { /* fall through to the name lookup */ }
    if (!frame) { try { frame = page.frame({ name: frameSel }); } catch { /* ignore */ } }
    if (frame) { scopeRef = frame; frameMissing = null; }
    else { scopeRef = page; frameMissing = frameSel; }
  };
  await resolveFrame();

  const tabsPayload = async () => {
    const pages = ctx().pages();
    const list = [];
    for (let i = 0; i < pages.length; i++) {
      let title = '';
      try { title = await pages[i].title(); } catch { /* page may be closing */ }
      list.push({ index: i, url: pages[i].url(), title, active: pages[i] === page });
    }
    return { ok: true, tabs: list, active: pages.indexOf(page) };
  };
  // Find a tab by index or by URL/title substring; -1 when no match.
  const findTab = (pages, target) => {
    if (/^\d+$/.test(target)) {
      const i = Number(target);
      return i < pages.length ? i : -1;
    }
    return pages.findIndex((p) => p.url().includes(target));
  };

  const snapshot = (sel) => scopeRef.evaluate(fn(`function(){
    const root = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document'};
    if(!root) return { ok:false, error:'selector not found' };
    const textOf=function(n){const walk=function(x){if(x.nodeType===3)return(x.textContent||'').trim();if(x.nodeName==='SCRIPT'||x.nodeName==='STYLE'||x.nodeName==='NOSCRIPT')return'';return Array.prototype.map.call(x.childNodes,walk).join(' ')};return walk(n).replace(/\\s+/g,' ').trim()};
    const nodes=root.querySelectorAll?root.querySelectorAll('input,textarea,select,button,[contenteditable]'):[];
    const inputs=Array.prototype.slice.call(nodes,0,80).map(function(el){return{tag:el.tagName.toLowerCase(),name:el.getAttribute('name')||'',type:el.getAttribute('type')||'',ph:el.getAttribute('placeholder')||'',val:(el.value||'').slice(0,60)||'',sel:__mkCss(el)}});
    return { ok:true, title:document.title, url:location.href, text:textOf(root).slice(0,8000), inputs:inputs };
  }`));

  try {
    // Optional `--url` prefix: navigate to it before running the action, so a
    // single invocation can "open X then click/type/extract" (an LLM tool call
    // is one intent, not a two-step session). If absent, the command runs
    // against whatever the current page is (only useful for a fresh navigate).
    const openUrl = flag('--url') ?? flag('-u');
    if (openUrl && cmd !== 'navigate' && cmd !== 'get') {
      await page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      if (waitMs) await sleep(waitMs);
      // The iframe only exists after navigation — re-resolve the scope.
      await resolveFrame();
    }
    if (frameMissing) {
      out = { ok: false, error: `frame not found: ${frameMissing}` };
    } else if (cmd === 'navigate' || cmd === 'get') {
      const url = argv(0);
      if (!url) throw new Error('url required');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'click') {
      const sel = argv(0);
      await scopeRef.waitForSelector(sel, { timeout: navTimeout });
      await scopeRef.click(sel);
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'type' || cmd === 'fill') {
      const sel = argv(0); const text = argv(1) ?? '';
      await scopeRef.waitForSelector(sel, { timeout: navTimeout });
      if (cmd === 'type') { await scopeRef.focus(sel); await scopeRef.type(sel, text, { delay: 5 }); }
      else await scopeRef.fill(sel, text);
      out = { ok: true, action: cmd, text: text.slice(0, 200), target: sel };
    } else if (cmd === 'text' || cmd === 'html') {
      const sel = argv(0);
      out = await scopeRef.evaluate(fn(`function(){
        const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : (cmd === 'html' ? 'document.documentElement' : 'document')};
        if(!el) return { ok:false, error:'selector not found' };
        if(${cmd === 'html' ? 'true' : 'false'}) return { ok:true, html:el.outerHTML.slice(0,20000) };
        const walk=function(n){if(n.nodeType===3)return(n.textContent||'').trim();if(n.nodeName==='SCRIPT'||n.nodeName==='STYLE'||n.nodeName==='NOSCRIPT')return'';return Array.prototype.map.call(n.childNodes,walk).join(' ')};
        return { ok:true, text:walk(el).replace(/\\s+/g,' ').trim().slice(0,8000) };
      }`));
    } else if (cmd === 'links') {
      const sel = argv(0);
      out = await scopeRef.evaluate(fn(`function(){
        const root = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document'};
        if(!root) return { ok:false, error:'selector not found' };
        return { ok:true, links:Array.prototype.map.call(root.querySelectorAll('a[href]'),function(a){return{href:a.href,text:(a.textContent||'').trim().slice(0,60),sel:__mkCss(a)}}).slice(0,100) };
      }`));
    } else if (cmd === 'inputs') {
      const s = await snapshot(argv(0));
      out = { ok: s.ok, inputs: s.inputs || [], error: s.error };
    } else if (cmd === 'screenshot') {
      const dst = argv(0);
      if (!dst) throw new Error('path required');
      await page.screenshot({ path: dst, fullPage: true });
      out = { ok: true, saved: dst };
    } else if (cmd === 'press') {
      const key = argv(0);
      if (!key) throw new Error('key required (e.g. Enter, Escape, Tab)');
      await page.keyboard.press(key);
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'scroll') {
      const arg = argv(0);
      if (arg !== undefined && arg !== '' && !Number.isNaN(Number(arg))) {
        // Numeric arg: scroll the window by that many pixels (vertical).
        await page.evaluate((y) => window.scrollBy(0, y), Number(arg));
      } else if (arg) {
        await scopeRef.waitForSelector(arg, { timeout: navTimeout });
        await scopeRef.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
        }, arg);
      } else {
        // No arg: scroll down by one viewport.
        await page.evaluate(() => window.scrollBy(0, window.innerHeight || 800));
      }
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'waitfor') {
      const target = argv(0);
      if (!target) throw new Error('selector, load state, or url:<part> required');
      if (target === 'networkidle' || target === 'load' || target === 'domcontentloaded') {
        // Robust-wait conditions: page-level load states (SPAs settle on
        // networkidle; route changes surface as url: waits below).
        await page.waitForLoadState(target, { timeout: navTimeout });
      } else if (target.startsWith('url:')) {
        await page.waitForURL(target.slice(4), { timeout: navTimeout });
      } else {
        await scopeRef.waitForSelector(target, { timeout: navTimeout });
      }
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'select') {
      const sel = argv(0); const value = argv(1) ?? '';
      if (!sel) throw new Error('selector required');
      await scopeRef.waitForSelector(sel, { timeout: navTimeout });
      const selected = await scopeRef.selectOption(sel, value);
      out = { ok: true, action: 'select', target: sel, text: (selected ?? []).join(',') || value };
    } else if (cmd === 'hover') {
      const sel = argv(0);
      if (!sel) throw new Error('selector required');
      await scopeRef.waitForSelector(sel, { timeout: navTimeout });
      await scopeRef.hover(sel);
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'tabs') {
      out = await tabsPayload();
    } else if (cmd === 'newtab') {
      const url = argv(0);
      const np = await ctx().newPage();
      page = np;
      scopeRef = np; // tab commands re-target the scope (frame combos excluded)
      if (url) await np.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'switchtab') {
      const target = argv(0);
      if (!target) throw new Error('tab index or URL part required');
      const pages = ctx().pages();
      const i = findTab(pages, target);
      if (i < 0) throw new Error(`no tab matches: ${target}`);
      page = pages[i];
      scopeRef = page;
      await page.bringToFront().catch(() => {});
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'closetab') {
      const target = argv(0);
      const pages = ctx().pages();
      const i = target ? findTab(pages, target) : pages.indexOf(page);
      if (i < 0) throw new Error(`no tab matches: ${target}`);
      const closing = pages[i];
      const wasActive = closing === page;
      await closing.close().catch(() => {});
      const rest = ctx().pages();
      if (rest.length === 0) {
        page = await ctx().newPage();
      } else if (wasActive) {
        page = rest[Math.min(i, rest.length - 1)];
      }
      scopeRef = page;
      out = await tabsPayload();
    } else if (cmd === 'download') {
      const sel = argv(0);
      const dest = argv(1);
      // Register the wait BEFORE the triggering click — a download event
      // that fires before waitForEvent is attached is lost (classic race).
      const dlPromise = page.waitForEvent('download', { timeout: navTimeout });
      dlPromise.catch(() => {}); // rejection is consumed at the await below
      if (sel) {
        await page.waitForSelector(sel, { timeout: navTimeout });
        await page.click(sel);
      }
      const dl = await dlPromise;
      const suggested = dl.suggestedFilename();
      let targetPath = dest || path.join(process.cwd(), 'downloads', suggested);
      try {
        if (dest && (dest.endsWith('/') || (fs.existsSync(dest) && fs.statSync(dest).isDirectory()))) {
          targetPath = path.join(dest, suggested);
        }
      } catch { /* dest is a file path */ }
      try { fs.mkdirSync(path.dirname(targetPath), { recursive: true }); } catch { /* saveAs reports real errors */ }
      await dl.saveAs(targetPath);
      const size = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
      out = { ok: true, action: 'download', saved: targetPath, filename: suggested, size };
    } else if (cmd === 'upload') {
      const sel = argv(0);
      const files = (argv(1) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!sel || files.length === 0) throw new Error('selector and file path required');
      await scopeRef.waitForSelector(sel, { timeout: navTimeout });
      await scopeRef.setInputFiles(sel, files);
      out = { ok: true, action: 'upload', target: sel, text: files.map((f) => path.basename(f)).join(', ') };
    } else if (cmd === 'extract') {
      out = await page.evaluate(extractInPage, argv(0) ?? null);
    } else if (cmd === 'eval') {
      const js = argv(0);
      try {
        const v = await scopeRef.evaluate(fn(`async function(){ return await (async()=>{${js}})(); }`));
        out = { ok: true, result: JSON.parse(JSON.stringify(v ?? null)) };
      } catch (e) {
        out = { ok: false, error: `eval failed: ${e.message}` };
      }
    } else if (cmd === 'snap') {
      out = await snapshot();
    } else {
      out = { ok: false, error: `unknown command: ${cmd ?? ''}` };
    }
  } catch (e) {
    out = { ok: false, error: `${cmd ?? ''}: ${e.message}` };
  }
  if (consoleErrors.length) out = { ...out, consoleErrors };
  console.log(JSON.stringify(out, null, 2));
  // Persist the tab set (URLs + active index) so the NEXT driver process
  // restores this session's tabs — see loadTabState / the restore block.
  if (context) {
    try {
      const pages = context.pages();
      const urls = pages.map((p) => { try { return p.url(); } catch { return ''; } });
      fs.writeFileSync(tabsStatePath(), JSON.stringify({ tabs: urls, active: Math.max(0, pages.indexOf(page)) }));
    } catch { /* tab state is best-effort */ }
  }
  // Persistent path closes the context (which also closes its browser);
  // ephemeral path closes the browser directly.
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: `driver error: ${e.message}` }));
  process.exit(0);
});