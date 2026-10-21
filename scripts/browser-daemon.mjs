#!/usr/bin/env node
// Mochi persistent browser daemon — stateful, Cline-grade browser automation
// WITHOUT adding a runtime dependency to the agent bundle.
//
// Mochi ships as a Bun-compiled binary with ZERO runtime deps, so it cannot
// `import 'playwright'` at bundle time. This driver runs under plain node and
// loads the GLOBALLY-installed playwright. One process owns one browser for a
// whole session, so `navigate` -> `click` -> `type` -> `snapshot` operate on
// the SAME page instead of relaunching a browser on every tool call.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   request : {"id":1,"cmd":"navigate","args":{"url":"https://example.com"}}
//   response: {"id":1,"ok":true,"title":"…","url":"…","elements":[…]}
// A response is ALWAYS emitted (ok:false on error) so the caller never hangs.
//
// Commands: init, probe, navigate, back, forward, reload, snapshot, click,
// type, fill, press, scroll, hover, select, focus, blur, tabs, evaluate,
// extract, text, html, links, inputs, screenshot, pdf, waitFor, cookies,
// console, network, upload, downloads, status, close.
//
// One-shot mode: `node browser-daemon.mjs --once '<json>'` runs a single
// command and exits (used by `mochi doctor` and by tests).
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';

const MAX_TEXT = 8000;
const MAX_ELEMENTS = 400;
const RING = 250;

function globalRoot() {
  const env = process.env.MOCHI_BROWSER_NODE_MODULES;
  if (env) return env;
  try {
    const out = execSync('npm root -g', { encoding: 'utf8', timeout: 4000 }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return path.join(os.homedir(), '.npm-global', 'lib', 'node_modules');
}

function playwrightCandidates() {
  const roots = [globalRoot()];
  // A local install (`npm i playwright`) is just as valid.
  roots.push(path.join(process.cwd(), 'node_modules'));
  return roots.map((r) => path.join(r, 'playwright', 'index.mjs'));
}

let pw = null;
let pwError = null;
async function loadPlaywright() {
  if (pw || pwError) return pw;
  for (const candidate of playwrightCandidates()) {
    try {
      pw = await import(candidate);
      return pw;
    } catch { /* try next */ }
  }
  pwError = new Error(
    'playwright unavailable. Install: npm i -g playwright && npx playwright install chromium',
  );
  return null;
}

const state = {
  browser: null,
  context: null,
  pages: [],
  active: 0,
  consoleLog: [],
  networkLog: [],
  downloads: [],
  statePath: null,
  downloadDir: null,
  profileDir: null,
  executablePath: null,
  persistent: false,
  headless: true,
  browserName: 'chromium',
  viewport: { width: 1280, height: 900 },
  idleTimer: null,
  idleMs: 0,
};

function now() { return Date.now(); }
function pushRing(arr, entry) {
  arr.push(entry);
  while (arr.length > RING) arr.shift();
}

function log(...args) {
  try { process.stderr.write(args.map(String).join(' ') + '\n'); } catch { /* ignore */ }
}

function pickBrowser(pwMod, desired) {
  if (desired && pwMod[desired]) return { name: desired, type: pwMod[desired] };
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    if (fs.existsSync(cache)) {
      const names = fs.readdirSync(cache);
      for (const candidate of ['chromium', 'firefox', 'webkit']) {
        if (names.some((n) => n.startsWith(candidate)) && pwMod[candidate]) {
          return { name: candidate, type: pwMod[candidate] };
        }
      }
    }
  } catch { /* ignore */ }
  const fallback = pwMod.chromium ? 'chromium' : Object.keys(pwMod).find((k) => ['firefox', 'webkit'].includes(k));
  return fallback ? { name: fallback, type: pwMod[fallback] } : null;
}

function attachPage(page) {
  page.on('console', (msg) => {
    pushRing(state.consoleLog, { type: msg.type(), text: msg.text().slice(0, 2000), at: now() });
  });
  page.on('pageerror', (err) => {
    pushRing(state.consoleLog, { type: 'pageerror', text: String(err && err.message ? err.message : err).slice(0, 2000), at: now() });
  });
  page.on('response', (res) => {
    pushRing(state.networkLog, {
      method: res.request().method(),
      url: res.url().slice(0, 500),
      status: res.status(),
      type: res.request().resourceType(),
      at: now(),
    });
  });
  page.on('requestfailed', (req) => {
    pushRing(state.networkLog, {
      method: req.method(),
      url: req.url().slice(0, 500),
      status: 0,
      failed: (req.failure() && req.failure().errorText) || 'failed',
      type: req.resourceType(),
      at: now(),
    });
  });
  page.on('download', async (download) => {
    const suggested = download.suggestedFilename() || `download-${Date.now()}`;
    const safe = suggested.replace(/[^\w.\-]+/g, '_').slice(0, 120);
    let saved = null;
    if (state.downloadDir) {
      try {
        fs.mkdirSync(state.downloadDir, { recursive: true });
        saved = path.join(state.downloadDir, safe);
        await download.saveAs(saved);
      } catch (e) {
        log('download save failed:', e.message);
        saved = null;
      }
    }
    state.downloads.push({ name: safe, url: download.url().slice(0, 500), saved, at: now() });
  });
  page.on('close', () => {
    state.pages = state.pages.filter((p) => p !== page);
    if (state.active >= state.pages.length) state.active = Math.max(0, state.pages.length - 1);
  });
}

async function saveState() {
  if (!state.statePath || !state.context) return;
  try {
    fs.mkdirSync(path.dirname(state.statePath), { recursive: true });
    await state.context.storageState({ path: state.statePath });
  } catch (e) {
    log('storageState save failed:', e.message);
  }
}

async function loadState() {
  if (!state.statePath) return undefined;
  try {
    if (fs.existsSync(state.statePath)) {
      const parsed = JSON.parse(fs.readFileSync(state.statePath, 'utf8'));
      if (parsed && Array.isArray(parsed.cookies)) return parsed;
    }
  } catch { /* a corrupt state file must not block browsing */ }
  return undefined;
}

async function ensureBrowser() {
  if (state.browser && state.context) return;
  const mod = await loadPlaywright();
  if (!mod) throw new Error(pwError ? pwError.message : 'playwright unavailable');
  const picked = pickBrowser(mod, state.browserName);
  if (!picked) throw new Error(`no usable playwright browser (wanted ${state.browserName})`);
  state.browserName = picked.name;
  const launchArgs = picked.name === 'chromium'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    : [];

  // Persistent profile: logins (Google, GitHub, company SSO) survive browser
  // restarts and Mochi processes. `mochi browser login` writes this profile.
  if (state.profileDir && typeof picked.type.launchPersistentContext === 'function') {
    try {
      fs.mkdirSync(state.profileDir, { recursive: true });
      state.context = await picked.type.launchPersistentContext(state.profileDir, {
        headless: state.headless,
        viewport: state.viewport,
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        args: launchArgs,
        ...(state.executablePath ? { executablePath: state.executablePath } : {}),
      });
      state.browser = state.context;
      state.persistent = true;
      for (const p of state.context.pages()) {
        if (!state.pages.includes(p)) { state.pages.push(p); attachPage(p); }
      }
      if (state.pages.length === 0) {
        const p = await state.context.newPage();
        state.pages.push(p);
        attachPage(p);
      }
      state.active = state.pages.length - 1;
      return;
    } catch (e) {
      // A profile can be locked by another running browser. Falling back to an
      // ephemeral context keeps automation working (just logged out) instead
      // of failing every command.
      log('persistent profile unavailable, using ephemeral:', e.message);
      state.context = null;
      state.browser = null;
      state.persistent = false;
    }
  }

  state.browser = await picked.type.launch({
    headless: state.headless,
    args: launchArgs,
    ...(state.executablePath ? { executablePath: state.executablePath } : {}),
  });
  const storageState = await loadState();
  state.context = await state.browser.newContext({
    viewport: state.viewport,
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    ...(storageState ? { storageState } : {}),
  });
  state.context.on('page', (page) => {
    if (!state.pages.includes(page)) {
      state.pages.push(page);
      attachPage(page);
    }
  });
  const page = await state.context.newPage();
  // NOTE: the context 'page' listener above normally registers this page; only
  // add it when the event has not fired yet (double-pushing duplicated tabs).
  if (!state.pages.includes(page)) {
    state.pages.push(page);
    attachPage(page);
  }
  state.active = Math.max(0, state.pages.indexOf(page));
}

function activePage() {
  const page = state.pages[state.active];
  if (!page) throw new Error('no open page (run navigate first)');
  return page;
}

async function settle(page, ms) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(15000, ms || 8000) }); } catch { /* no nav */ }
  if (ms && ms > 0) await new Promise((r) => setTimeout(r, ms));
}

// ── Locator resolution ────────────────────────────────────────────────────
// LLM-friendly targets: e12 (snapshot ref), CSS, text=…, role=button[name=…],
// label=…, placeholder=…, testid=…, alt=…, title=….
export function resolveLocator(page, target) {
  const raw = String(target == null ? '' : target).trim();
  if (!raw) throw new Error('target required (ref like e3, CSS selector, or text=/role=/label=/placeholder= prefix)');
  if (/^e\d+$/i.test(raw)) return page.locator(`[data-mochi-ref="${raw.toLowerCase()}"]`).first();
  const at = raw.indexOf('=');
  const prefix = at > 0 ? raw.slice(0, at).toLowerCase() : '';
  const value = at > 0 ? raw.slice(at + 1).trim() : '';
  const unquote = (s) => {
    const m = /^"(.*)"$/.exec(s) || /^'(.*)'$/.exec(s);
    return m ? m[1] : s;
  };
  if (prefix === 'text' && value) return page.getByText(unquote(value), { exact: false }).first();
  if (prefix === 'label' && value) return page.getByLabel(unquote(value), { exact: false }).first();
  if (prefix === 'placeholder' && value) return page.getByPlaceholder(unquote(value), { exact: false }).first();
  if (prefix === 'testid' && value) return page.getByTestId(unquote(value)).first();
  if (prefix === 'alt' && value) return page.getByAltText(unquote(value), { exact: false }).first();
  if (prefix === 'title' && value) return page.getByTitle(unquote(value), { exact: false }).first();
  if (prefix === 'role' && value) {
    const m = /^([a-zA-Z]+)\s*(?:\[name\s*=\s*(.+)\])?$/.exec(value);
    if (!m) throw new Error(`bad role target "${raw}" — expected role=button[name="Sign in"]`);
    const role = m[1];
    if (m[2]) return page.getByRole(role, { name: unquote(m[2].trim()), exact: false }).first();
    return page.getByRole(role).first();
  }
  return page.locator(raw).first();
}

// ── Snapshot (element refs + page text) ───────────────────────────────────
// NOTE: this function is serialized into the page. Every constant must be
// declared INSIDE it — page context has no module scope.
function snapshotPage(arg) {
  const MAX = 8000;
  const max = Math.max(1, Math.min(arg && arg.max ? arg.max : 150, 400));
  const scope = arg && arg.selector ? document.querySelector(arg.selector) : (document.body || document.documentElement);
  if (!scope) return { ok: false, error: 'selector not found' };
  for (const old of document.querySelectorAll('[data-mochi-ref]')) old.removeAttribute('data-mochi-ref');
  const SEL = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="combobox"]',
    '[contenteditable="true"]', '[onclick]',
  ].join(',');
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return 'generic';
  };
  const nameOf = (el) => {
    const by = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder')
      || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('value');
    if (by && by.trim()) return by.trim().slice(0, 100);
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return txt.slice(0, 100);
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    return true;
  };
  const out = [];
  let i = 0;
  const all = scope.querySelectorAll(SEL);
  for (const el of all) {
    if (out.length >= max) break;
    if (!visible(el)) continue;
    i += 1;
    const ref = 'e' + i;
    el.setAttribute('data-mochi-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el);
    const name = nameOf(el);
    const entry = { ref, role, tag, name };
    if (tag === 'a') entry.href = (el.getAttribute('href') || '').slice(0, 300);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      entry.type = (el.getAttribute('type') || tag).toLowerCase();
      entry.value = String(el.value == null ? '' : el.value).slice(0, 80);
      if (el.checked) entry.checked = true;
      if (el.disabled) entry.disabled = true;
    }
    out.push(entry);
  }
  const text = (scope.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX);
  return {
    ok: true,
    url: location.href,
    title: document.title || '',
    text,
    elements: out,
    elementsTruncated: all.length > out.length,
  };
}

async function snapshot(args) {
  const page = activePage();
  return await page.evaluate(snapshotPage, {
    max: Number(args.maxElements || args.max || 150) || 150,
    selector: args.selector ? String(args.selector) : undefined,
  });
}


// ── High-level document / email workflows ─────────────────────────────────
// These live in the daemon (not the tool) so they can use Playwright's REAL
// keyboard: Google Docs and Gmail are canvas/rich-text editors that ignore
// synthetic DOM events, so only CDP-level typing works reliably.

function parseMarkdownBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let code = null;
  let para = [];
  let table = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', text: para.join(' ').trim() });
      para = [];
    }
  };
  const flushTable = () => {
    if (table.length) {
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{3,}/.test(r));
      blocks.push({ type: 'table', rows: rows.map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())) });
      table = [];
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line.trim())) {
      if (code === null) { flushPara(); flushTable(); code = []; }
      else { blocks.push({ type: 'code', text: code.join('\n') }); code = null; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }
    if (!line.trim()) { flushPara(); flushTable(); blocks.push({ type: 'blank' }); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flushPara(); flushTable(); blocks.push({ type: 'heading', level: heading[1].length, text: cleanInline(heading[2]) }); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) { flushPara(); flushTable(); blocks.push({ type: 'bullet', text: cleanInline(bullet[1]) }); continue; }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) { flushPara(); flushTable(); blocks.push({ type: 'number', text: cleanInline(numbered[1]) }); continue; }
    if (/^\s*>\s?/.test(line)) { flushPara(); flushTable(); blocks.push({ type: 'quote', text: cleanInline(line.replace(/^\s*>\s?/, '')) }); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line.trim())) { flushPara(); flushTable(); blocks.push({ type: 'hr' }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); table.push(line); continue; }
    para.push(cleanInline(line));
  }
  if (code !== null) blocks.push({ type: 'code', text: code.join('\n') });
  flushPara();
  flushTable();
  return blocks;
}

function cleanInline(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

async function insertChunked(page, text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 4000) {
    await page.keyboard.insertText(s.slice(i, i + 4000));
  }
}

/** Insert user-authored multi-paragraph text into a contenteditable without
 *  doubling newlines (insertText("a\n\nb") renders as four breaks in Gmail). */
async function insertMultiline(page, text) {
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await insertChunked(page, lines[i]);
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
}

async function focusDocsBody(page) {
  const candidates = [
    '.kix-appview-editor [contenteditable="true"]',
    '.kix-page-content-wrapper [contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '.kix-appview-editor',
    '.kix-page',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 4000 });
      try { await loc.click({ timeout: 4000, position: { x: 80, y: 80 } }); }
      catch { await loc.click({ timeout: 4000 }).catch(() => {}); }
      return sel;
    } catch { /* next candidate */ }
  }
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  await page.mouse.click(Math.round(vp.width / 2), Math.round(vp.height / 2));
  return 'viewport';
}

/** Same document? Ignore query/hash so re-reading an open Doc does not reload
 *  it (and risk losing the tail of an in-flight autosave). */
function sameDocUrl(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch { return false; }
}

async function writeDocument(page, args) {
  const url = String(args.url || '');
  if (url && !sameDocUrl(page.url(), url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const current = page.url();
  if (/accounts\.google\.com|\/signin/i.test(current)) {
    throw new Error('Google sign-in required. Run: mochi browser login https://docs.google.com  (then retry)');
  }
  await page.locator('.kix-appview-editor, .kix-page, div[role="textbox"][contenteditable="true"]').first()
    .waitFor({ state: 'visible', timeout: 45000 });

  const title = String(args.title || '').trim();
  if (title) {
    const titleCandidates = [
      'input.docs-title-input',
      'input[aria-label="Rename"]',
      'input[aria-label="Document title"]',
    ];
    let set = false;
    for (const sel of titleCandidates) {
      const inp = page.locator(sel).first();
      try {
        await inp.waitFor({ state: 'visible', timeout: 3000 });
        await inp.click({ timeout: 3000 });
        await inp.press('Control+A');
        await inp.fill(title, { timeout: 5000 });
        await inp.press('Enter');
        set = true;
        break;
      } catch { /* next */ }
    }
    if (!set) log('docs: title input not found; keeping default title');
  }

  const focus = await focusDocsBody(page);
  await page.keyboard.press(args.append ? 'Control+End' : 'Control+Home');
  // Appending must start a new paragraph, not continue the last one.
  if (args.append) await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 150));

  const blocks = parseMarkdownBlocks(String(args.markdown || args.content || ''));
  const maxBlocks = Math.min(Number(args.maxBlocks || 1500) || 1500, 5000);
  const mac = process.platform === 'darwin';
  const mod = mac ? 'Meta' : 'Control';
  let listMode = null;
  let written = 0;
  let chars = 0;

  const endList = async () => {
    if (!listMode) return;
    await page.keyboard.press(`${mod}+Shift+${listMode === 'bullet' ? '8' : '7'}`);
    listMode = null;
  };

  for (const block of blocks.slice(0, maxBlocks)) {
    if (block.type === 'blank') { await endList(); await page.keyboard.press('Enter'); continue; }
    if (block.type === 'heading') {
      await endList();
      const level = Math.max(1, Math.min(block.level, 6));
      await page.keyboard.press(`${mod}+Alt+${level}`);
      await insertChunked(page, block.text);
      await page.keyboard.press('Enter');
      await page.keyboard.press(`${mod}+Alt+0`);
      written++;
      chars += block.text.length;
      continue;
    }
    if (block.type === 'bullet' || block.type === 'number') {
      const want = block.type === 'bullet' ? 'bullet' : 'number';
      if (listMode !== want) {
        await endList();
        await page.keyboard.press(`${mod}+Shift+${want === 'bullet' ? '8' : '7'}`);
        listMode = want;
      }
      await insertChunked(page, block.text);
      await page.keyboard.press('Enter');
      written++;
      chars += block.text.length;
      continue;
    }
    await endList();
    await page.keyboard.press(`${mod}+Alt+0`);
    if (block.type === 'hr') {
      await page.keyboard.insertText('———');
      await page.keyboard.press('Enter');
    } else if (block.type === 'code') {
      for (const codeLine of String(block.text).split('\n')) {
        await page.keyboard.insertText('    ' + codeLine);
        await page.keyboard.press('Enter');
      }
      written++;
    } else if (block.type === 'quote') {
      await page.keyboard.insertText('“' + block.text + '”');
      await page.keyboard.press('Enter');
      written++;
      chars += block.text.length;
    } else if (block.type === 'table') {
      const rows = block.rows || [];
      for (let r = 0; r < rows.length; r++) {
        if (r === 1 && rows[0] && rows[0].every((c) => /^-+$/.test(c))) continue;
        const line = rows[r].filter(Boolean).join('  ·  ');
        if (!line) continue;
        if (r === 0) { await page.keyboard.press(`${mod}+Alt+2`); }
        await insertChunked(page, line);
        await page.keyboard.press('Enter');
        if (r === 0) await page.keyboard.press(`${mod}+Alt+0`);
      }
      written++;
    } else {
      await insertChunked(page, block.text);
      await page.keyboard.press('Enter');
      written++;
      chars += String(block.text || '').length;
    }
  }
  await endList();
  // Give Docs' autosave a moment; the URL already carries the document id.
  await new Promise((r) => setTimeout(r, Number(args.saveWaitMs || 1200) || 1200));
  return {
    ok: true,
    action: args.append ? 'appendDocument' : 'writeDocument',
    url: page.url(),
    title: title || (await page.title()),
    blocks: written,
    chars,
    focus,
    totalBlocks: blocks.length,
  };
}

async function readDocument(page, args) {
  const url = String(args.url || '');
  if (!url) throw new Error('readDocument: url required');
  if (!sameDocUrl(page.url(), url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (/accounts\.google\.com|\/signin/i.test(page.url())) {
    throw new Error('Google sign-in required. Run: mochi browser login https://docs.google.com');
  }
  await page.locator('.kix-appview-editor, .kix-page').first().waitFor({ state: 'visible', timeout: 45000 });
  const text = await page.evaluate(() => {
    const el = document.querySelector('.kix-appview-editor') || document.body;
    return (el.innerText || '').replace(/\u00a0/g, ' ').trim().slice(0, 100000);
  });
  return { ok: true, action: 'readDocument', url: page.url(), title: await page.title(), text };
}

async function gmailCompose(page, args) {
  const url = String(args.url || 'https://mail.google.com/mail/u/0/#inbox?compose=new');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (/accounts\.google\.com|\/signin/i.test(page.url())) {
    throw new Error('Gmail sign-in required. Run: mochi browser login https://mail.google.com');
  }
  // New compose can take a while in a cold profile.
  const body = page.locator('div[aria-label="Message Body"], div[contenteditable="true"][aria-label*="Message"]').first();
  try {
    await body.waitFor({ state: 'visible', timeout: 45000 });
  } catch {
    throw new Error(`Could not open Gmail compose (page: ${page.url()}). Is the account signed in?`);
  }

  const first = async (selectors) => {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try { if (await loc.count() && await loc.isVisible()) return loc; } catch { /* next */ }
    }
    return null;
  };

  const toField = await first(['input[aria-label="To recipients"]', 'textarea[name="to"]', 'input[name="to"]', 'input[aria-label*="To"]']);
  if (!toField) throw new Error('Gmail compose: recipient field not found');
  const to = String(args.to || '').trim();
  if (!to) throw new Error('gmailCompose: `to` is required');
  await toField.click({ timeout: 5000 });
  await insertChunked(page, to.replace(/\s*\n\s*/g, ' '));
  await page.keyboard.press('Enter');

  if (args.cc) {
    const ccBtn = await first(['span[role="link"][aria-label*="Cc"]', 'div[aria-label="Add Cc recipients"]', 'span[data-tooltip*="Cc"]']);
    if (ccBtn) { await ccBtn.click().catch(() => {}); const cc = await first(['input[aria-label="Cc recipients"]', 'textarea[name="cc"]']); if (cc) { await cc.click(); await insertChunked(page, String(args.cc)); await page.keyboard.press('Enter'); } }
  }

  const subject = String(args.subject || '');
  if (subject) {
    const sf = await first(['input[name="subjectbox"]', 'input[aria-label="Subject"]']);
    if (sf) { await sf.click({ timeout: 5000 }); await insertChunked(page, subject); }
  }

  await body.click({ timeout: 5000 });
  await insertMultiline(page, String(args.body || ''));

  const files = Array.isArray(args.attachments) ? args.attachments.filter(Boolean) : [];
  if (files.length) {
    const input = page.locator('input[type="file"]').last();
    await input.setInputFiles(files, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, Math.min(20000, 2500 + files.length * 1500)));
  }

  if (args.send === true) {
    const sendBtn = page.locator('div[role="button"][aria-label^="Send"], button[aria-label^="Send"]').last();
    if (await sendBtn.count()) await sendBtn.click({ timeout: 8000 });
    else await page.keyboard.press('Control+Enter');
    await new Promise((r) => setTimeout(r, 1800));
    const stillOpen = await page.locator('div[aria-label="Message Body"]').first().isVisible().catch(() => false);
    // Gmail usually closes the composer, but a snackbar is a second, independent
    // signal (useful when the send animation is still in flight).
    const sentNotice = await page.getByText(/Message sent|Your message has been sent/i).count().catch(() => 0);
    return { ok: true, action: 'send', to, subject, chars: String(args.body || '').length, attachments: files.length, sent: !stillOpen || sentNotice > 0, url: page.url() };
  }

  // Draft mode: Esc closes the composer and Gmail saves it automatically.
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 1200));
  return { ok: true, action: 'draft', to, subject, chars: String(args.body || '').length, attachments: files.length, sent: false, url: page.url() };
}

// ── Command implementations ───────────────────────────────────────────────
async function runCommand(cmd, args) {
  args = args || {};
  if (cmd === 'probe') {
    const mod = await loadPlaywright();
    const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
    let browsers = [];
    try {
      if (fs.existsSync(cache)) browsers = fs.readdirSync(cache).filter((n) => /^(chromium|firefox|webkit)/.test(n));
    } catch { /* ignore */ }
    return { ok: !!mod, playwright: !!mod, browsers, error: mod ? undefined : (pwError ? pwError.message : 'playwright unavailable') };
  }

  await ensureBrowser();
  const page = activePage();
  const timeout = Number(args.timeoutMs || 30000) || 30000;
  const waitMs = Number(args.waitMs || 0) || 0;

  switch (cmd) {
    case 'navigate': {
      const url = String(args.url || '');
      if (!url) throw new Error('url required');
      const waitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(String(args.waitUntil))
        ? String(args.waitUntil) : 'domcontentloaded';
      const res = await page.goto(url, { waitUntil, timeout });
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      await saveState();
      return {
        ok: true, action: 'navigate', url: page.url(), title: await page.title(),
        status: res ? res.status() : undefined,
      };
    }
    case 'back': {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout });
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      return { ok: true, action: 'back', url: page.url(), title: await page.title() };
    }
    case 'forward': {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout });
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      return { ok: true, action: 'forward', url: page.url(), title: await page.title() };
    }
    case 'reload': {
      await page.reload({ waitUntil: 'domcontentloaded', timeout });
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      return { ok: true, action: 'reload', url: page.url(), title: await page.title() };
    }
    case 'snapshot': {
      return await snapshot(args);
    }
    case 'click': {
      let target = args.target || args.ref || args.selector;
      if (!target && args.text) target = 'text=' + args.text;
      if (!target && (args.x !== undefined && args.y !== undefined)) {
        await page.mouse.click(Number(args.x), Number(args.y), { button: args.button || 'left' });
      } else {
        const loc = resolveLocator(page, target);
        await loc.waitFor({ state: 'visible', timeout });
        await loc.click({ button: args.button || 'left', clickCount: Number(args.clickCount || 1) || 1, timeout });
      }
      await settle(page, waitMs || 400);
      return { ok: true, action: 'click', target: String(target || `${args.x},${args.y}`), url: page.url(), title: await page.title() };
    }
    case 'type':
    case 'fill': {
      const target = args.target || args.ref || args.selector;
      if (!target) throw new Error(`${cmd}: target required (ref or selector)`);
      const text = String(args.text ?? args.value ?? '');
      const loc = resolveLocator(page, target);
      await loc.waitFor({ state: 'visible', timeout });
      if (cmd === 'fill' || args.clear === true) {
        await loc.fill(text, { timeout });
      } else {
        await loc.click({ timeout }).catch(() => {});
        await loc.type(text, { delay: Number(args.delayMs || 8) || 8, timeout });
      }
      await settle(page, waitMs || 200);
      return { ok: true, action: cmd, target: String(target), text: text.slice(0, 200) };
    }
    case 'press': {
      let key = String(args.key || '');
      if (!key) throw new Error('key required (e.g. Enter, Control+A, Escape)');
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(String).filter(Boolean) : [];
      if (modifiers.length && !key.includes('+')) key = `${modifiers.join('+')}+${key}`;
      if (args.target || args.ref) {
        const loc = resolveLocator(page, args.target || args.ref);
        await loc.press(key, { timeout });
      } else {
        await page.keyboard.press(key);
      }
      await settle(page, waitMs || 300);
      return { ok: true, action: 'press', key, url: page.url() };
    }
    case 'scroll': {
      const direction = String(args.direction || 'down');
      const amount = Number(args.amount || 700) || 700;
      if (args.target || args.ref) {
        await resolveLocator(page, args.target || args.ref).scrollIntoViewIfNeeded({ timeout });
      } else {
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        await page.mouse.wheel(dx, dy);
      }
      await new Promise((r) => setTimeout(r, waitMs || 250));
      return { ok: true, action: 'scroll', direction, amount, url: page.url() };
    }
    case 'hover': {
      const target = args.target || args.ref || args.selector;
      if (!target) throw new Error('hover: target required');
      await resolveLocator(page, target).hover({ timeout });
      await new Promise((r) => setTimeout(r, waitMs || 200));
      return { ok: true, action: 'hover', target: String(target) };
    }
    case 'select': {
      const target = args.target || args.ref || args.selector;
      if (!target) throw new Error('select: target required');
      const value = String(args.value ?? args.text ?? '');
      const loc = resolveLocator(page, target);
      const result = await loc.selectOption(value, { timeout });
      return { ok: true, action: 'select', target: String(target), selected: result };
    }
    case 'focus': {
      await resolveLocator(page, args.target || args.ref || args.selector).focus({ timeout });
      return { ok: true, action: 'focus' };
    }
    case 'blur': {
      await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
      return { ok: true, action: 'blur' };
    }
    case 'tabs': {
      const action = String(args.action || 'list');
      if (action === 'new' || action === 'create') {
        const p = await state.context.newPage();
        if (!state.pages.includes(p)) { state.pages.push(p); attachPage(p); }
        state.active = state.pages.length - 1;
        if (args.url) await p.goto(String(args.url), { waitUntil: 'domcontentloaded', timeout });
      } else if (action === 'close') {
        const idx = Number(args.index ?? state.active) || 0;
        const victim = state.pages[idx];
        if (victim) await victim.close();
        state.active = Math.max(0, Math.min(state.active, state.pages.length - 1));
      } else if (action === 'activate' || action === 'select') {
        const idx = Number(args.index ?? 0) || 0;
        const next = state.pages[idx];
        if (!next) throw new Error(`no tab at index ${idx}`);
        state.active = idx;
        await next.bringToFront();
      }
      const out = [];
      for (let i = 0; i < state.pages.length; i++) {
        const p = state.pages[i];
        out.push({ index: i, active: i === state.active, url: p.url(), title: await p.title().catch(() => '') });
      }
      return { ok: true, action: 'tabs', tabs: out };
    }
    case 'evaluate':
    case 'eval': {
      const expression = String(args.expression ?? args.js ?? '');
      if (!expression) throw new Error('expression required');
      const value = await page.evaluate((src) => {
        // Evaluate as an async expression so await works and the result is JSON-safe.
        return (async () => {
          // eslint-disable-next-line no-new-func
          const fn = new Function('return (async () => (' + src + '))()');
          return await fn();
        })();
      }, expression);
      let json;
      try { json = JSON.parse(JSON.stringify(value ?? null)); } catch { json = String(value); }
      return { ok: true, action: 'evaluate', result: json };
    }
    case 'extract': {
      const selector = String(args.selector || 'a[href]');
      const limit = Math.max(1, Math.min(Number(args.limit || 50) || 50, 500));
      const items = await page.evaluate(({ selector: sel, limit: cap }) => {
        const nodes = Array.from(document.querySelectorAll(sel)).slice(0, cap);
        return nodes.map((el) => ({
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          href: el.getAttribute('href') ? el.href : undefined,
          src: el.getAttribute('src') ? el.src : undefined,
          tag: el.tagName.toLowerCase(),
        }));
      }, { selector, limit });
      return { ok: true, action: 'extract', selector, items, count: items.length };
    }
    case 'text':
    case 'getText': {
      const sel = args.selector ? String(args.selector) : null;
      const text = await page.evaluate(({ sel, max }) => {
        const el = sel ? document.querySelector(sel) : (document.body || document.documentElement);
        if (!el) return null;
        return (el.innerText || el.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
      }, { sel, max: MAX_TEXT });
      if (text === null) return { ok: false, error: 'selector not found' };
      return { ok: true, text, url: page.url(), title: await page.title() };
    }
    case 'html': {
      const sel = args.selector ? String(args.selector) : null;
      const html = await page.evaluate(({ sel }) => {
        const el = sel ? document.querySelector(sel) : document.documentElement;
        return el ? el.outerHTML.slice(0, 20000) : null;
      }, { sel });
      if (html === null) return { ok: false, error: 'selector not found' };
      return { ok: true, html, url: page.url() };
    }
    case 'links': {
      const sel = args.selector ? String(args.selector) : 'body';
      const links = await page.evaluate(({ sel }) => {
        const root = document.querySelector(sel) || document.body;
        return Array.from(root.querySelectorAll('a[href]')).slice(0, 100).map((a) => ({
          href: a.href,
          text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        }));
      }, { sel });
      return { ok: true, links };
    }
    case 'inputs': {
      const snap = await snapshot(args);
      return { ok: true, inputs: (snap.elements || []).filter((e) => ['textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'button', 'link'].includes(e.role)) };
    }
    case 'screenshot': {
      const dst = String(args.path || '');
      if (!dst) throw new Error('path required for screenshot');
      fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true });
      await page.screenshot({ path: dst, fullPage: args.fullPage !== false });
      const size = fs.existsSync(dst) ? fs.statSync(dst).size : 0;
      return { ok: true, saved: dst, bytes: size, url: page.url(), title: await page.title() };
    }
    case 'pdf': {
      if (state.browserName !== 'chromium') throw new Error('pdf requires the chromium engine');
      const dst = String(args.path || 'page.pdf');
      fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true });
      await page.pdf({ path: dst, format: String(args.format || 'A4'), printBackground: true });
      return { ok: true, saved: dst };
    }
    case 'waitFor': {
      const timeoutMs = Number(args.timeoutMs || args.timeout || timeout) || timeout;
      if (args.text) {
        await page.getByText(String(args.text), { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
      } else if (args.urlIncludes) {
        await page.waitForURL((u) => String(u).includes(String(args.urlIncludes)), { timeout: timeoutMs });
      } else if (args.selector) {
        await page.waitForSelector(String(args.selector), { state: 'visible', timeout: timeoutMs });
      } else {
        await page.waitForLoadState('networkidle', { timeout: timeoutMs });
      }
      return { ok: true, action: 'waitFor', url: page.url(), title: await page.title() };
    }
    case 'cookies': {
      const action = String(args.action || 'get');
      if (action === 'clear') {
        await state.context.clearCookies();
        return { ok: true, action: 'clear', cookies: [] };
      }
      if (action === 'set') {
        await state.context.addCookies([{
          name: String(args.name || ''), value: String(args.value || ''),
          url: String(args.url || page.url()),
        }]);
      }
      const cookies = await state.context.cookies(args.url ? String(args.url) : undefined);
      return { ok: true, cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, expires: c.expires })) };
    }
    case 'console': {
      if (String(args.action || 'list') === 'clear') { state.consoleLog = []; return { ok: true, entries: [] }; }
      return { ok: true, entries: state.consoleLog.slice(-Number(args.limit || 50)) };
    }
    case 'network': {
      if (String(args.action || 'list') === 'clear') { state.networkLog = []; return { ok: true, entries: [] }; }
      const filter = args.filter ? String(args.filter) : '';
      const entries = state.networkLog
        .filter((e) => !filter || e.url.includes(filter))
        .slice(-Number(args.limit || 50));
      return { ok: true, entries };
    }
    case 'upload': {
      const target = args.target || args.ref || args.selector;
      if (!target) throw new Error('upload: target required (file input selector)');
      const files = Array.isArray(args.files) ? args.files.map(String) : [String(args.files || '')].filter(Boolean);
      if (!files.length) throw new Error('upload: files[] required');
      await resolveLocator(page, target).setInputFiles(files, { timeout });
      return { ok: true, action: 'upload', files };
    }
    case 'downloads': {
      return { ok: true, downloads: state.downloads };
    }
    case 'writeDocument':
      return await writeDocument(page, args);
    case 'readDocument':
      return await readDocument(page, args);
    case 'gmailCompose':
      return await gmailCompose(page, args);
    case 'status': {
      const tabs = [];
      for (let i = 0; i < state.pages.length; i++) {
        tabs.push({ index: i, active: i === state.active, url: state.pages[i].url(), title: await state.pages[i].title().catch(() => '') });
      }
      return {
        ok: true, action: 'status', browser: state.browserName, headless: state.headless,
        persistent: state.persistent, profileDir: state.profileDir, executablePath: state.executablePath,
        url: page.url(), title: await page.title().catch(() => ''), tabs,
        consoleEntries: state.consoleLog.length, networkEntries: state.networkLog.length,
        downloads: state.downloads.length, statePath: state.statePath,
      };
    }
    case 'close': {
      try { await saveState(); } catch { /* ignore */ }
      try { await state.browser.close(); } catch { /* ignore */ }
      state.browser = null; state.context = null; state.pages = [];
      return { ok: true, action: 'close' };
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

async function handleRequest(req) {
  const id = req && req.id;
  let resp;
  try {
    const cmd = String(req && req.cmd ? req.cmd : '');
    resp = await runCommand(cmd, req && req.args ? req.args : {});
    if (resp && typeof resp === 'object') resp = { id, ...resp };
    else resp = { id, ok: true, result: resp };
  } catch (e) {
    resp = { id, ok: false, error: String(e && e.message ? e.message : e).slice(0, 800) };
  }
  try { process.stdout.write(JSON.stringify(resp) + '\n'); } catch { /* stdout gone */ }
  return resp;
}

async function init(args) {
  args = args || {};
  if (typeof args.headless === 'boolean') state.headless = args.headless;
  if (typeof args.browser === 'string' && args.browser) state.browserName = args.browser;
  if (args.viewport && typeof args.viewport === 'object') {
    const w = Number(args.viewport.width || args.viewport.w);
    const h = Number(args.viewport.height || args.viewport.h);
    if (w > 0 && h > 0) state.viewport = { width: Math.min(w, 3840), height: Math.min(h, 2160) };
  }
  if (typeof args.statePath === 'string' && args.statePath) state.statePath = args.statePath;
  if (typeof args.downloadDir === 'string' && args.downloadDir) state.downloadDir = args.downloadDir;
  if (typeof args.profileDir === 'string' && args.profileDir) state.profileDir = args.profileDir;
  if (typeof args.executablePath === 'string' && args.executablePath) state.executablePath = args.executablePath;
  if (typeof args.idleMs === 'number' && args.idleMs > 0) state.idleMs = args.idleMs;
  return {
    ok: true, initialized: true, headless: state.headless, browser: state.browserName,
    statePath: state.statePath, profileDir: state.profileDir, executablePath: state.executablePath,
  };
}

function touchIdle() {
  if (!state.idleMs) return;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(async () => {
    log('idle timeout — closing browser');
    try { await saveState(); } catch { /* ignore */ }
    try { if (state.browser) await state.browser.close(); } catch { /* ignore */ }
    process.exit(0);
  }, state.idleMs);
  state.idleTimer.unref?.();
}

async function main() {
  // One-shot: `browser-daemon.mjs --once '{"cmd":"probe"}'`
  if (process.argv[2] === '--once') {
    const raw = process.argv[3] || '{"cmd":"probe"}';
    let req;
    try { req = JSON.parse(raw); } catch { req = { cmd: 'probe' }; }
    // --once is stateless: init args may ride along.
    if (req.init) await init(req.init);
    const resp = await handleRequest(req);
    try { if (state.browser) await state.browser.close(); } catch { /* ignore */ }
    process.exit(resp && resp.ok ? 0 : 0);
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try { req = JSON.parse(trimmed); } catch { return; }
    touchIdle();
    // Serialize commands: one browser, one action at a time.
    chain = chain.then(async () => {
      if (req.cmd === 'init') {
        const resp = await init(req.args || {});
        process.stdout.write(JSON.stringify({ id: req.id, ...resp }) + '\n');
        return;
      }
      await handleRequest(req);
    });
  });
  rl.on('close', async () => {
    try { await chain; } catch { /* command errors are reported per-response */ }
    try { await saveState(); } catch { /* ignore */ }
    try { if (state.browser) await state.browser.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    try { await saveState(); } catch { /* ignore */ }
    process.exit(0);
  });
  process.on('SIGINT', () => process.exit(0));
}

main().catch(async (e) => {
  log('fatal:', e && e.stack ? e.stack : e);
  try { process.stdout.write(JSON.stringify({ ok: false, error: `daemon fatal: ${e && e.message ? e.message : e}` }) + '\n'); } catch { /* ignore */ }
  process.exit(0);
});
