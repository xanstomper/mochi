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
//
// Flags: --browser <firefox|chromium|webkit> (default autodetect from cache),
//        --headed (default off), --wait/-w <ms>, --timeout <ms> (nav, dflt 30s).
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
const FLAG_NAMES = new Set(['--browser', '--wait', '-w', '--timeout', '--headless', '--headed', '--url', '-u']);
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
  const name = pickBrowser();
  const type = pw[name] || pw.firefox;
  let browser;
  try {
    browser = await type.launch({ headless: !has('--headed'), args: ['--no-sandbox'] });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `failed to launch ${name}: ${e.message}` }));
    return;
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', () => {});
  page.on('console', () => {});
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
  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: `driver error: ${e.message}` }));
  process.exit(0);
});