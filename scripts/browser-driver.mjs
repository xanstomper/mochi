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
//   select <sel> <value>          selectOption on a <select> element
//   hover <selector>              hover first match; snapshot
//
// Flags: --browser <firefox|chromium|webkit> (default autodetect from cache),
//        --headed (default off), --wait/-w <ms>, --timeout <ms> (nav, dflt 30s),
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
const FLAG_NAMES = new Set(['--browser', '--wait', '-w', '--timeout', '--headless', '--headed', '--url', '-u', '--profile']);
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
    context = await type.launchPersistentContext(profileDir, { headless, args: ['--no-sandbox'], viewport });
    page = context.pages()[0] ?? await context.newPage();
  } catch {
    context = undefined;
    try {
      browser = await type.launch({ headless, args: ['--no-sandbox'] });
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: `failed to launch ${name}: ${e.message}` }));
      return;
    }
    page = await browser.newPage({ viewport });
  }
  // Surface page errors instead of swallowing them: collect console
  // error/warning messages + uncaught pageerrors, capped for output size.
  const consoleErrors = [];
  const MAX_CONSOLE_ERRORS = 20;
  const pushConsoleError = (type, text) => {
    if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
    consoleErrors.push({ type: String(type || 'error'), text: String(text ?? '').slice(0, 500) });
  };
  page.on('console', (msg) => {
    try {
      const t = msg.type();
      if (t === 'error' || t === 'warning') pushConsoleError(t, msg.text());
    } catch { /* a broken console event must never break the run */ }
  });
  page.on('pageerror', (err) => pushConsoleError('pageerror', err?.message ?? err));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let out = { ok: false, error: 'no command' };

  const snapshot = (sel) => page.evaluate(fn(`function(){
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
    }
    if (cmd === 'navigate' || cmd === 'get') {
      const url = argv(0);
      if (!url) throw new Error('url required');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'click') {
      const sel = argv(0);
      await page.waitForSelector(sel, { timeout: navTimeout });
      await page.click(sel);
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'type' || cmd === 'fill') {
      const sel = argv(0); const text = argv(1) ?? '';
      await page.waitForSelector(sel, { timeout: navTimeout });
      if (cmd === 'type') { await page.focus(sel); await page.type(sel, text, { delay: 5 }); }
      else await page.fill(sel, text);
      out = { ok: true, action: cmd, text: text.slice(0, 200), target: sel };
    } else if (cmd === 'text' || cmd === 'html') {
      const sel = argv(0);
      out = await page.evaluate(fn(`function(){
        const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : (cmd === 'html' ? 'document.documentElement' : 'document')};
        if(!el) return { ok:false, error:'selector not found' };
        if(${cmd === 'html' ? 'true' : 'false'}) return { ok:true, html:el.outerHTML.slice(0,20000) };
        const walk=function(n){if(n.nodeType===3)return(n.textContent||'').trim();if(n.nodeName==='SCRIPT'||n.nodeName==='STYLE'||n.nodeName==='NOSCRIPT')return'';return Array.prototype.map.call(n.childNodes,walk).join(' ')};
        return { ok:true, text:walk(el).replace(/\\s+/g,' ').trim().slice(0,8000) };
      }`));
    } else if (cmd === 'links') {
      const sel = argv(0);
      out = await page.evaluate(fn(`function(){
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
        await page.waitForSelector(arg, { timeout: navTimeout });
        await page.evaluate((sel) => {
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
      const sel = argv(0);
      if (!sel) throw new Error('selector required');
      await page.waitForSelector(sel, { timeout: navTimeout });
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'select') {
      const sel = argv(0); const value = argv(1) ?? '';
      if (!sel) throw new Error('selector required');
      await page.waitForSelector(sel, { timeout: navTimeout });
      const selected = await page.selectOption(sel, value);
      out = { ok: true, action: 'select', target: sel, text: (selected ?? []).join(',') || value };
    } else if (cmd === 'hover') {
      const sel = argv(0);
      if (!sel) throw new Error('selector required');
      await page.waitForSelector(sel, { timeout: navTimeout });
      await page.hover(sel);
      if (waitMs) await sleep(waitMs);
      out = await snapshot();
    } else if (cmd === 'eval') {
      const js = argv(0);
      try {
        const v = await page.evaluate(fn(`async function(){ return await (async()=>{${js}})(); }`));
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
  // Persistent path closes the context (which also closes its browser);
  // ephemeral path closes the browser directly.
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: `driver error: ${e.message}` }));
  process.exit(0);
});