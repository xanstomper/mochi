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
//   waitfor response:<url-part>   wait until a response whose URL contains
//                                 <url-part> has been captured (checks the
//                                 network log first — it may already have
//                                 happened — then polls until timeout)
//   waitfor <sel>::state:<state>  wait for element state: visible|hidden|
//                                 attached|detached|enabled|disabled
//   waitfor <sel>::text:<substr>  wait until the element's text contains
//                                 <substr> (SPA render completion signal)
//   a11y [selector]               accessibility-tree snapshot of the page
//                                 (or element) as indented role/name lines —
//                                 the observation mode that survives DOM
//                                 churn and works without vision models
//   netlog [n|clear]              the session network request log (method,
//                                 url, status, resource type, failures),
//                                 persisted in the profile next to the tab
//                                 state so it spans invocations; `clear`
//                                 empties it. Every result also reports
//                                 `net` counts for the current invocation.
//   batch <json>                  run a SEQUENCE of commands in ONE
//                                 browser session: [{command, args:[...]}].
//                                 This is the only way multi-action flows
//                                 (fill a form, then submit it) work: each
//                                 driver process re-opens pages from the
//                                 persisted tab URLs, so unsubmitted page
//                                 state does NOT survive across processes
//                                 — but everything inside one batch shares
//                                 the live page. Stops at the first failed
//                                 step (a transient navigation race on a
//                                 step is retried once); the result holds
//                                 every step's output plus the final
//                                 step's snapshot fields.
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
// Network log state: same persistence discipline as the tab set — a ring
// buffer in the profile dir, loaded at launch and saved at exit, so a
// multi-call flow can inspect requests made by earlier invocations.
const netlogPath = () => path.join(profileDir, 'mochi-netlog.json');
// Saved Playwright storageState (cookies + localStorage) for the profile.
// Chromium does NOT restore SESSION cookies (no Expires) from the
// userDataDir on relaunch — verified empirically: a fresh persistent
// context on a logged-in profile starts with zero cookies. Since most
// auth cookies are session cookies, profile persistence is broken
// without this bridge: snapshot the live context's storage state at
// exit, re-apply it at launch (cookies via addCookies before any
// navigation; localStorage per-origin after that origin's first load).
const storageStatePath = () => path.join(profileDir, 'mochi-storage.json');
function loadStorageState() {
  try {
    const st = JSON.parse(fs.readFileSync(storageStatePath(), 'utf8'));
    if (st && Array.isArray(st.cookies)) return st;
  } catch { /* no saved state yet */ }
  return null;
}
const NETLOG_CAP = 300;
function loadNetlog() {
  try {
    const arr = JSON.parse(fs.readFileSync(netlogPath(), 'utf8'));
    if (Array.isArray(arr)) return arr.filter((e) => e && typeof e === 'object').slice(-NETLOG_CAP);
  } catch { /* no log yet */ }
  return [];
}
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

// Accessibility-tree flattening: take Playwright's aria snapshot YAML or
// the legacy accessibility.snapshot() object (or the in-page fallback
// walker's tree) and render indented `role "name" [states]` lines — the
// compact, model-readable observation form. Caps bound the output.
const A11Y_MAX_LINES = 400;
const A11Y_MAX_CHARS = 12_000;
function flattenA11yNode(node, depth, lines) {
  if (!node || lines.length >= A11Y_MAX_LINES) return;
  const role = String(node.role || 'generic');
  const name = String(node.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const states = [];
  for (const k of ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'level', 'required', 'invalid']) {
    if (node[k] !== undefined && node[k] !== false && node[k] !== '') states.push(k === 'level' ? `level=${node[k]}` : k);
  }
  if (node.value !== undefined && node.value !== '') states.push(`value=${String(node.value).slice(0, 60)}`);
  lines.push(`${'  '.repeat(Math.min(depth, 12))}${role}${name ? ` "${name}"` : ''}${states.length ? ` [${states.join(' ')}]` : ''}`);
  for (const child of node.children || []) flattenA11yNode(child, depth + 1, lines);
}
function flattenA11yTree(root) {
  const lines = [];
  flattenA11yNode(root, 0, lines);
  return lines.join('\n').slice(0, A11Y_MAX_CHARS);
}

// In-page fallback walker: computes a role/name/state tree from the DOM
// when neither ariaSnapshot nor accessibility.snapshot exists (Firefox on
// some Playwright versions). Self-contained (serialized into the page).
function a11yWalkInPage(sel) {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return { ok: false, error: 'selector not found' };
  const nameOf = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((n) => (n.textContent || '').trim()).join(' ');
      if (t) return t;
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return (lab.textContent || '').trim();
    }
    const wrapLab = el.closest ? el.closest('label') : null;
    if (wrapLab) return (wrapLab.textContent || '').trim();
    if (el.getAttribute && el.getAttribute('alt')) return el.getAttribute('alt').trim();
    return '';
  };
  const textName = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'IMG') return 'img';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'MAIN') return 'main';
    if (tag === 'HEADER') return 'banner';
    if (tag === 'FOOTER') return 'contentinfo';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'listitem';
    if (tag === 'TABLE') return 'table';
    if (tag === 'TR') return 'row';
    if (tag === 'TD') return 'cell';
    if (tag === 'TH') return 'columnheader';
    if (tag === 'FORM') return 'form';
    if (tag === 'DIALOG') return 'dialog';
    if (tag === 'ARTICLE') return 'article';
    if (tag === 'SECTION' && nameOf(el)) return 'region';
    return 'generic';
  };
  const NAME_FROM_TEXT = new Set(['button', 'link', 'heading', 'listitem', 'cell', 'columnheader', 'option', 'tab', 'menuitem']);
  const build = (el, depth) => {
    if (depth > 14) return null;
    const role = roleOf(el);
    if (role === null) return null;
    let name = nameOf(el);
    if (!name && NAME_FROM_TEXT.has(role)) name = textName(el);
    if (!name && (role === 'textbox' || role === 'combobox' || role === 'searchbox')) {
      name = (el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('name') || '')) || '';
    }
    const node = { role, name };
    if (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')) node.disabled = true;
    if (el.checked) node.checked = true;
    if (el.getAttribute && el.getAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded') === 'true';
    if (/^H[1-6]$/.test(el.tagName)) node.level = Number(el.tagName[1]);
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.value) node.value = String(el.value).slice(0, 60);
    const kids = [];
    for (const child of el.children || []) {
      const k = build(child, depth + 1);
      if (k) kids.push(k);
    }
    // Prune nameless generic wrappers with a single child (layout noise).
    if (role === 'generic' && !name && kids.length === 1) return kids[0];
    if (role === 'generic' && !name && kids.length === 0) return null;
    if (kids.length) node.children = kids;
    return node;
  };
  const tree = build(root, 0);
  if (!tree) return { ok: false, error: 'empty accessibility tree' };
  return { ok: true, tree };
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
  let profileMode = 'persistent';
  let profileWarning;
  try {
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* launch will surface real errors */ }
    context = await type.launchPersistentContext(profileDir, { headless, args: ['--no-sandbox'], viewport, acceptDownloads: true });
    page = context.pages()[0] ?? await context.newPage();
  } catch (e) {
    // Ephemeral fallback: the run proceeds, but NOTHING persists — and
    // that must never be silent. A login made in an ephemeral session
    // looks successful and is gone next call; report the mode (and why)
    // in every result so the caller can see persistence is off.
    profileMode = 'ephemeral-fallback';
    profileWarning = `persistent profile unavailable (${String(e?.message ?? e).slice(0, 160)}) — running ephemeral: cookies/logins will NOT persist after this call`;
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
  // Re-apply the saved storage state BEFORE any navigation (the tab
  // restore below loads pages that may check auth immediately). Cookies
  // go in via addCookies; localStorage is applied per-origin after that
  // origin's first navigation (tracked in lsApplied).
  const savedState = context ? loadStorageState() : null;
  const lsByOrigin = new Map();
  if (savedState) {
    if (savedState.cookies.length) {
      try { await context.addCookies(savedState.cookies); } catch { /* stale cookies must not break launch */ }
    }
    for (const o of savedState.origins ?? []) {
      if (o && typeof o.origin === 'string' && Array.isArray(o.localStorage)) lsByOrigin.set(o.origin, o.localStorage);
    }
  }
  const lsApplied = new Set();
  const applyLocalStorage = async (p) => {
    try {
      const origin = new URL(p.url()).origin;
      if (!lsByOrigin.has(origin) || lsApplied.has(origin)) return;
      lsApplied.add(origin);
      const entries = lsByOrigin.get(origin);
      await p.evaluate((items) => {
        for (const { name, value } of items) { try { localStorage.setItem(name, value); } catch { /* storage disabled */ } }
      }, entries);
    } catch { /* non-http pages / raced navigation — best effort */ }
  };
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
    for (const p of context.pages()) await applyLocalStorage(p);
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
  // Network request log: context-level listeners cover every page (incl.
  // popups and restored tabs). The buffer persists in the profile (loaded
  // above, saved at exit) so a flow can inspect earlier invocations'
  // traffic; `netThisRun` scopes the counts reported in each result.
  const netlog = loadNetlog();
  let netThisRun = 0;
  let netFailedThisRun = 0;
  let netlogCleared = false;
  try {
    const bctx = ctx();
    bctx.on('request', (req) => {
      try {
        netlog.push({ ts: Date.now(), method: req.method(), url: req.url().slice(0, 300), type: req.resourceType() });
        if (netlog.length > NETLOG_CAP) netlog.splice(0, netlog.length - NETLOG_CAP);
        netThisRun++;
      } catch { /* logging must never break the run */ }
    });
    bctx.on('response', (res) => {
      try {
        const u = res.url();
        // Back-fill the status onto the most recent matching request entry.
        for (let i = netlog.length - 1; i >= 0; i--) {
          if (netlog[i].url === u.slice(0, 300) && netlog[i].status === undefined) { netlog[i].status = res.status(); break; }
        }
      } catch { /* ignore */ }
    });
    bctx.on('requestfailed', (req) => {
      try {
        netFailedThisRun++;
        const u = req.url().slice(0, 300);
        for (let i = netlog.length - 1; i >= 0; i--) {
          if (netlog[i].url === u && netlog[i].failed === undefined) { netlog[i].failed = req.failure()?.errorText?.slice(0, 120) || 'failed'; break; }
        }
      } catch { /* ignore */ }
    });
  } catch { /* context event surface unavailable — netlog stays empty */ }
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

  // Optional `--url` prefix: navigate to it before running the action, so a
  // single invocation can "open X then click/type/extract" (an LLM tool
  // call is one intent, not a two-step session). If absent, the command
  // runs against whatever the current page is (only useful for a fresh
  // navigate). Hoisted out of dispatch: it applies to the OUTER call only,
  // never to individual batch steps.
  const openUrl = flag('--url') ?? flag('-u');
  let openFailed = false;
  if (openUrl && cmd !== 'navigate' && cmd !== 'get' && cmd !== 'batch') {
    try {
      await page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      await applyLocalStorage(page);
      if (waitMs) await sleep(waitMs);
      // The iframe only exists after navigation — re-resolve the scope.
      await resolveFrame();
    } catch (e) {
      out = { ok: false, error: `navigate: ${e.message}` };
      openFailed = true;
    }
  }
  // dispatch(c, argAt) runs ONE command against the live page and returns
  // its result object. The main call dispatches once; `batch` dispatches a
  // sequence in the same session. The body below is the original command
  // chain — `cmd`/`argv` are the dispatch parameters, and tab commands
  // reassign the shared page/scope so later steps (and later batch steps)
  // act on the new active tab.
  const dispatch = async (c, argAt) => {
    const cmd = c;
    const argv = argAt;
    try {
    if (frameMissing) {
      out = { ok: false, error: `frame not found: ${frameMissing}` };
    } else if (cmd === 'navigate' || cmd === 'get') {
      const url = argv(0);
      if (!url) throw new Error('url required');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      await applyLocalStorage(page);
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
      if (!target) throw new Error('selector, load state, url:<part>, response:<part>, or <sel>::state:/::text: required');
      let waited = target;
      if (target === 'networkidle' || target === 'load' || target === 'domcontentloaded') {
        // Robust-wait conditions: page-level load states (SPAs settle on
        // networkidle; route changes surface as url: waits below).
        await page.waitForLoadState(target, { timeout: navTimeout });
      } else if (target.startsWith('url:')) {
        const part = target.slice(4);
        // Documented semantics are url:<glob-or-part>: a value with a
        // scheme or a glob star goes to waitForURL as-is; anything else
        // is a SUBSTRING match (the common case: waitfor url:home after
        // a login redirect). A bare substring passed as a waitForURL
        // string never matches — it is treated as an exact URL/glob.
        if (/^https?:\/\//.test(part) || part.includes('*')) {
          await page.waitForURL(part, { timeout: navTimeout });
        } else {
          await page.waitForURL((u) => u.href.includes(part), { timeout: navTimeout });
        }
      } else if (target.startsWith('response:')) {
        // Wait on the NETWORK, not the DOM: the response may already have
        // arrived (check the log first), else poll the log until timeout.
        const part = target.slice('response:'.length);
        if (!part) throw new Error('response:<url-part> requires a URL fragment');
        const deadline = Date.now() + navTimeout;
        const seen = () => netlog.some((e) => e.url.includes(part) && e.status !== undefined);
        while (!seen()) {
          if (Date.now() > deadline) throw new Error(`waitfor response timeout: no response matching "${part}" within ${navTimeout}ms`);
          await sleep(100);
        }
        waited = `response:${part}`;
      } else if (target.includes('::state:') || target.includes('::text:')) {
        // Selector-state waits: <sel>::state:visible|hidden|enabled|
        // disabled and <sel>::text:<substr> — the signals multi-step
        // forms actually block on (button enables, label flips to Done).
        const m = target.match(/^(.*)::(state|text):(.*)$/);
        const sel = m[1]; const kind = m[2]; const want = m[3];
        if (!sel || !want) throw new Error(`malformed waitfor target: ${target}`);
        if (kind === 'state' && ['visible', 'hidden', 'attached', 'detached'].includes(want)) {
          await scopeRef.waitForSelector(sel, { state: want, timeout: navTimeout });
        } else if (kind === 'state' && (want === 'enabled' || want === 'disabled')) {
          const deadline = Date.now() + navTimeout;
          for (;;) {
            const state = await scopeRef.evaluate((s) => {
              const el = document.querySelector(s);
              if (!el) return 'missing';
              return el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled';
            }, sel).catch(() => 'missing');
            if (state === want) break;
            if (Date.now() > deadline) throw new Error(`waitfor state timeout: ${sel} never became ${want} (last: ${state})`);
            await sleep(100);
          }
        } else if (kind === 'text') {
          const deadline = Date.now() + navTimeout;
          for (;;) {
            const txt = await scopeRef.evaluate((s) => {
              const el = document.querySelector(s);
              return el ? (el.textContent || '') : null;
            }, sel).catch(() => null);
            if (txt !== null && txt.includes(want)) break;
            if (Date.now() > deadline) throw new Error(`waitfor text timeout: ${sel} never contained "${want}"`);
            await sleep(100);
          }
        } else {
          throw new Error(`unknown waitfor state: ${want} (visible|hidden|attached|detached|enabled|disabled)`);
        }
        waited = target;
      } else {
        await scopeRef.waitForSelector(target, { timeout: navTimeout });
      }
      if (waitMs) await sleep(waitMs);
      out = { ...(await snapshot()), waited };
    } else if (cmd === 'a11y') {
      // Accessibility-tree observation. Preference order: Playwright's
      // ariaSnapshot (structured YAML, best fidelity), the legacy
      // accessibility.snapshot() object, then the in-page DOM walker
      // (works on every browser/version). All render to the same
      // indented role/name line form.
      const sel = argv(0);
      let a11yText = null;
      let a11ySource = null;
      if (typeof page.locator === 'function') {
        try {
          const yaml = await (sel ? page.locator(sel) : page.locator('body')).ariaSnapshot({ timeout: 5000 });
          if (yaml && String(yaml).trim()) { a11yText = String(yaml).slice(0, A11Y_MAX_CHARS); a11ySource = 'aria'; }
        } catch { /* fall through */ }
      }
      if (!a11yText && page.accessibility && typeof page.accessibility.snapshot === 'function') {
        try {
          const tree = await page.accessibility.snapshot({ interestingOnly: true });
          if (tree) { a11yText = flattenA11yTree(tree); a11ySource = 'accessibility'; }
        } catch { /* fall through */ }
      }
      if (!a11yText) {
        const walked = await scopeRef.evaluate(a11yWalkInPage, sel ?? null).catch((e) => ({ ok: false, error: e.message }));
        if (!walked.ok) { out = { ok: false, error: `a11y: ${walked.error ?? 'snapshot failed'}` }; }
        else { a11yText = flattenA11yTree(walked.tree); a11ySource = 'dom-walk'; }
      }
      if (a11yText !== null) {
        out = { ok: true, a11y: a11yText, a11ySource, title: await page.title().catch(() => ''), url: page.url() };
      }
    } else if (cmd === 'netlog') {
      const arg = argv(0);
      if (arg === 'clear') {
        netlog.length = 0;
        netlogCleared = true;
        out = { ok: true, netlog: [], netlogTotal: 0, cleared: true };
      } else {
        const n = Math.min(Math.max(Number(arg ?? 50) || 50, 1), NETLOG_CAP);
        out = { ok: true, netlog: netlog.slice(-n), netlogTotal: netlog.length };
      }
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
    return out;
  };
  if (!openFailed) {
    if (cmd === 'batch') {
      // A sequence of commands in THIS session — the only way multi-action
      // flows work, since page state does not survive across processes.
      let steps = null;
      try { steps = JSON.parse(argv(0) ?? ''); } catch { /* handled below */ }
      if (!Array.isArray(steps) || steps.length === 0) {
        out = { ok: false, error: 'batch requires a JSON array of {command, args} steps' };
      } else {
        const results = [];
        let allOk = true;
        for (const step of steps.slice(0, 30)) {
          const sc = String(step?.command ?? '');
          const sargs = Array.isArray(step?.args) ? step.args.map((a) => String(a ?? '')) : [];
          let r = await dispatch(sc, (n) => sargs[n]);
          // A click that submits a form races its own post-click
          // snapshot (navigation destroys the execution context). That
          // one transient failure is retried once after the navigation
          // settles; any other failure stops the batch. Matched tightly:
          // a waitForURL timeout's log also mentions "navigation" and
          // must NOT be retried.
          if (!r.ok && /execution context was destroyed/i.test(String(r.error ?? ''))) {
            await sleep(250);
            r = await dispatch(sc, (n) => sargs[n]);
          }
          results.push({ command: sc, ...r });
          if (!r.ok) { allOk = false; break; }
        }
        const last = results[results.length - 1] ?? {};
        out = {
          ok: allOk, batch: results,
          ...(last.title !== undefined ? { title: last.title } : {}),
          ...(last.url !== undefined ? { url: last.url } : {}),
          ...(last.text !== undefined ? { text: last.text } : {}),
          ...(last.inputs !== undefined ? { inputs: last.inputs } : {}),
        };
      }
    } else {
      out = await dispatch(cmd, argv);
    }
  }
  if (consoleErrors.length) out = { ...out, consoleErrors };
  if (profileMode !== 'persistent') out = { ...out, profileMode, ...(profileWarning ? { profileWarning } : {}) };
  if (netThisRun > 0 || netFailedThisRun > 0) out = { ...out, net: { captured: netThisRun, failed: netFailedThisRun } };
  console.log(JSON.stringify(out, null, 2));
  // Persist the network log next to the tab state so the NEXT driver
  // process in this profile sees this session's traffic (netlog command).
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(netlogPath(), JSON.stringify(netlog.slice(-NETLOG_CAP)));
  } catch { /* netlog persistence is best-effort */ }
  // Persist the tab set (URLs + active index) so the NEXT driver process
  // restores this session's tabs — see loadTabState / the restore block.
  if (context) {
    try {
      const pages = context.pages();
      const urls = pages.map((p) => { try { return p.url(); } catch { return ''; } });
      fs.writeFileSync(tabsStatePath(), JSON.stringify({ tabs: urls, active: Math.max(0, pages.indexOf(page)) }));
    } catch { /* tab state is best-effort */ }
  }
  // Snapshot the storage state BEFORE closing (persistent path only):
  // this is what makes session cookies + localStorage survive into the
  // next process (see loadStorageState). Written with owner-only perms —
  // the file IS credential material. Always rewritten, even when empty:
  // a logout during this run must persist as logged-out, not resurrect.
  if (context) {
    try {
      const state = await context.storageState();
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(storageStatePath(), JSON.stringify(state), { mode: 0o600 });
    } catch { /* state snapshot is best-effort; the run's result stands */ }
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