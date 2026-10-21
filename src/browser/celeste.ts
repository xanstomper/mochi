// Live-browser backend (Celeste bridge).
//
// Headless Playwright is great for clean-room testing, but it is logged out of
// everything. Celeste (https://github.com/…/celeste, local daemon on :9126)
// drives the user's REAL browser through an extension, so Mochi can operate a
// logged-in session: dashboards, email, internal tools — the places where a
// fresh headless profile can never reach.
//
// This adapter speaks Celeste's documented HTTP surface. Only commands that
// surface actually supports are exposed; the rest report an honest
// unsupported-backend error instead of pretending. Everything else (CSS refs,
// tabs, screenshots) maps 1:1.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BrowserResponse } from './session.js';

export interface LiveStatus {
  available: boolean;
  base: string;
  connected?: boolean;
  detail?: string;
}

const DEFAULT_BASE = 'http://127.0.0.1:9126';

function baseUrl(): string {
  return (process.env.MOCHI_LIVE_BROWSER_URL || process.env.CELESTE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

let cache: { at: number; status: LiveStatus } | undefined;

/** Probe the Celeste daemon (cheap, cached for 2s). Never throws. */
export async function liveStatus(timeoutMs = 1500): Promise<LiveStatus> {
  const now = Date.now();
  const base = baseUrl();
  if (cache && cache.status.base === base && now - cache.at < 2000) return cache.status;
  const result: LiveStatus = { available: false, base };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/api/browser/status`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json() as { connected?: boolean; info?: unknown };
      result.available = true;
      result.connected = body.connected !== false;
      result.detail = result.connected ? 'extension connected' : 'daemon up, extension disconnected';
    } else {
      result.detail = `daemon returned HTTP ${res.status}`;
    }
  } catch (err) {
    result.detail = err instanceof Error ? err.message : String(err);
  }
  cache = { at: now, status: result };
  return result;
}

async function request(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<BrowserResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { raw: text.slice(0, 2000) }; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: String(body.error ?? body.message ?? `HTTP ${res.status}`) };
    }
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, error: `live browser: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

interface LiveElement {
  ref?: string;
  role?: string;
  name?: string;
  tag?: string;
  children?: LiveElement[];
  href?: string;
  attrs?: Record<string, unknown>;
}

/** Flatten Celeste's nested snapshot tree into Mochi's flat ref list. */
export function flattenLiveSnapshot(snap: unknown, limit = 200): {
  url?: string; title?: string; text?: string; elements: Array<Record<string, unknown>>;
} {
  const out: Array<Record<string, unknown>> = [];
  const root = (snap ?? {}) as { url?: string; title?: string; text?: string; elements?: LiveElement[] };
  const walk = (nodes: LiveElement[] | undefined) => {
    for (const n of nodes ?? []) {
      if (out.length >= limit) return;
      if (n && n.ref) {
        const item: Record<string, unknown> = {
          ref: n.ref,
          role: n.role ?? (n.tag === 'a' ? 'link' : n.tag === 'button' ? 'button' : n.tag ?? 'generic'),
          name: (n.name ?? '').slice(0, 120),
          tag: n.tag ?? '',
        };
        const href = n.href ?? (n.attrs && typeof n.attrs.href === 'string' ? n.attrs.href : undefined);
        if (href) item.href = href;
        out.push(item);
      }
      walk(n.children);
    }
  };
  walk(root.elements);
  return { url: root.url, title: root.title, text: root.text?.slice(0, 8000), elements: out };
}

function unsupported(command: string): BrowserResponse {
  return {
    ok: false,
    error: `live browser backend does not expose "${command}". Use backend:"headless" for full command coverage.`,
  };
}

/** Snapshot refs are the only stable target live pages expose (CSS selectors
 *  can match a different node after a re-render). */
function refOf(args: Record<string, unknown>): string | undefined {
  const raw = args.ref ?? args.target;
  return typeof raw === 'string' && /^e\d+$/i.test(raw.trim()) ? raw.trim().toLowerCase() : undefined;
}

/** Split Playwright-style chords ("Control+A") into Celeste's key+modifiers. */
function splitChord(raw: string): { key: string; modifiers: string[] } {
  const parts = raw.split('+').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return { key: raw, modifiers: [] };
  const modifiers = new Set<string>();
  let key = parts.pop() as string;
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === 'ctrl' || p === 'control') modifiers.add('Control');
    else if (p === 'alt' || p === 'option') modifiers.add('Alt');
    else if (p === 'shift') modifiers.add('Shift');
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') modifiers.add('Meta');
    else key = `${part}+${key}`;
  }
  return { key, modifiers: [...modifiers] };
}

function canonicalModifiers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const m of raw) {
    const p = String(m).toLowerCase();
    if (p === 'ctrl' || p === 'control') out.add('Control');
    else if (p === 'alt' || p === 'option') out.add('Alt');
    else if (p === 'shift') out.add('Shift');
    else if (p === 'meta' || p === 'cmd' || p === 'command') out.add('Meta');
  }
  return [...out];
}

function targetHint(args: Record<string, unknown>): string {
  const raw = args.ref ?? args.target;
  return raw === undefined
    ? ''
    : ` (got "${String(raw).slice(0, 80)}"; snapshot first and use its e12 ref, or pass backend:"headless")`;
}

/** Celeste >= the generic-action patch exposes /api/browser/action, which
 *  unlocks bridge verbs (fill/press/select/evaluate/waitFor/…) that predate
 *  the bespoke REST routes. Old daemons return 404; callers can then fall
 *  back to a specific route or report an honest unsupported error. */
async function liveAction(action: string, params: Record<string, unknown>, timeoutMs: number, tabId?: number): Promise<BrowserResponse> {
  const res = await request('/api/browser/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, params, timeoutMs, ...(tabId !== undefined ? { tabId } : {}) }),
  }, Math.max(5_000, timeoutMs + 2_000));
  if (!res.ok && Number(res.status) === 404) {
    return {
      ...res,
      error: `live Celeste daemon does not expose /api/browser/action (${action}); restart/update Celeste, or pass backend:"headless"`,
    };
  }
  if (!res.ok) return res;
  const result = res.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ok: true, action, ...(result as Record<string, unknown>) };
  }
  return { ok: true, action, result };
}

function normalizeTabs(raw: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { tabs?: unknown }).tabs)
      ? (raw as { tabs: unknown[] }).tabs
      : []);
  return (arr as Array<Record<string, unknown>>).map((t, index) => ({ index, ...t }));
}

async function activeTab(timeoutMs = 5_000): Promise<Record<string, unknown> | undefined> {
  const list = await request('/api/browser/tabs', {}, timeoutMs);
  if (!list.ok) return undefined;
  return normalizeTabs(list.tabs).find((t) => t.active === true);
}

/** Execute a command against the user's real, logged-in browser. */
export async function liveCall(
  command: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<BrowserResponse> {
  const status = await liveStatus();
  if (!status.available || status.connected === false) {
    return {
      ok: false,
      error: `live browser unavailable (${status.detail ?? 'Celeste daemon not running'}). Start Celeste or use backend:"headless".`,
    };
  }

  switch (command) {
    case 'navigate':
    case 'get': {
      const url = String(args.url ?? '');
      if (!url) return { ok: false, error: 'url required' };
      const nav = await request('/api/browser/navigate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
      }, timeoutMs);
      if (!nav.ok) return nav;
      const snap = await request('/api/browser/snapshot', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }, timeoutMs);
      if (snap.ok) {
        const flat = flattenLiveSnapshot(snap.snapshot);
        return { ok: true, action: 'navigate', url: flat.url ?? url, title: flat.title, elements: flat.elements, text: flat.text };
      }
      return { ok: true, action: 'navigate', url };
    }
    case 'snapshot':
    case 'snap': {
      const snap = await request('/api/browser/snapshot', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }, timeoutMs);
      if (!snap.ok) return snap;
      return { ok: true, ...flattenLiveSnapshot(snap.snapshot) };
    }
    case 'click': {
      const ref = args.ref ?? (typeof args.target === 'string' && /^e\d+$/i.test(args.target) ? args.target : undefined);
      const body: Record<string, unknown> = {};
      if (ref) body.ref = String(ref).toLowerCase();
      else if (args.x !== undefined && args.y !== undefined) { body.x = Number(args.x); body.y = Number(args.y); }
      else return { ok: false, error: 'live click needs a snapshot ref (e12) or x/y coordinates' };
      const res = await request('/api/browser/click', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }, timeoutMs);
      return res.ok ? { ...res, action: 'click', target: body.ref ?? `${body.x},${body.y}` } : res;
    }
    case 'type': {
      const ref = refOf(args);
      if (!ref) return { ok: false, error: `live type needs a snapshot ref (e12)${targetHint(args)}` };
      const text = String(args.text ?? args.value ?? '');
      if (args.clear === true) return liveAction('fill', { ref, value: text }, timeoutMs);
      const res = await request('/api/browser/type', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref, text, ...(args.clear === true ? { clear: true } : {}) }),
      }, timeoutMs);
      return res.ok ? { ...res, action: 'type', target: ref, text: text.slice(0, 200) } : res;
    }
    case 'fill': {
      const ref = refOf(args);
      if (!ref) return { ok: false, error: `live fill needs a snapshot ref (e12)${targetHint(args)}` };
      return liveAction('fill', { ref, value: String(args.value ?? args.text ?? '') }, timeoutMs);
    }
    case 'press': {
      const rawKey = String(args.key ?? args.text ?? '').trim();
      if (!rawKey) return { ok: false, error: 'live press needs a key (e.g. Enter, Escape, Control+A)' };
      const chord = splitChord(rawKey);
      const modifiers = [...new Set([...chord.modifiers, ...canonicalModifiers(args.modifiers)])];
      const params: Record<string, unknown> = { key: chord.key };
      const ref = refOf(args);
      if (ref) params.ref = ref;
      if (modifiers.length) params.modifiers = modifiers;
      return liveAction('press', params, timeoutMs);
    }
    case 'select': {
      const ref = refOf(args);
      if (!ref) return { ok: false, error: `live select needs a snapshot ref (e12)${targetHint(args)}` };
      return liveAction('select', { ref, value: String(args.value ?? args.text ?? '') }, timeoutMs);
    }
    case 'hover':
    case 'focus':
    case 'blur': {
      const ref = refOf(args);
      if (!ref && command !== 'blur') return { ok: false, error: `live ${command} needs a snapshot ref (e12)${targetHint(args)}` };
      return liveAction(command, ref ? { ref } : {}, timeoutMs);
    }
    case 'back':
    case 'forward':
    case 'reload':
      return liveAction(command, {}, timeoutMs);
    case 'scroll': {
      const direction = String(args.direction ?? 'down').toLowerCase();
      const amount = Number(args.amount ?? 500) || 500;
      const ref = refOf(args);
      const params: Record<string, unknown> = { direction, amount };
      if (ref) params.ref = ref;
      const res = await liveAction('scroll', params, timeoutMs);
      if (res.ok || Number(res.status) !== 404) return res;
      // Old Celeste: the bespoke route only understood deltaY.
      const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      const old = await request('/api/browser/scroll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaY }),
      }, timeoutMs);
      return old.ok ? { ...old, action: 'scroll', direction, amount } : old;
    }
    case 'tabs':
    case 'tab': {
      const action = String(args.action ?? 'list').toLowerCase();
      const list = await request('/api/browser/tabs', {}, timeoutMs);
      if (!list.ok) return list;
      const tabs = normalizeTabs(list.tabs);
      if (action === 'list' || action === '') return { ok: true, tabs };
      if (action === 'new' || action === 'create') {
        const res = await liveAction('tabs', { action: 'create', ...(args.url ? { url: String(args.url) } : {}) }, timeoutMs);
        if (!res.ok) return res;
        const after = await request('/api/browser/tabs', {}, timeoutMs);
        return { ...res, action: 'tabs create', tabs: after.ok ? normalizeTabs(after.tabs) : tabs };
      }
      let tabId = Number(args.tabId ?? NaN);
      const index = Number(args.index ?? args.tabIndex ?? NaN);
      if (!Number.isFinite(tabId) && Number.isFinite(index)) {
        const found = tabs[index] as Record<string, unknown> | undefined;
        if (!found) return { ok: false, error: `no live tab at index ${index} (${tabs.length} tabs)` };
        tabId = Number(found.id);
      }
      if (!Number.isFinite(tabId)) return { ok: false, error: `live tabs ${action} needs index or tabId` };
      if (action === 'switch' || action === 'activate') {
        const res = await liveAction('tabs', { action: 'activate', tabId }, timeoutMs);
        if (!res.ok) return res;
        const after = await request('/api/browser/tabs', {}, timeoutMs);
        return { ...res, action: 'tabs activate', tabs: after.ok ? normalizeTabs(after.tabs) : tabs };
      }
      if (action === 'close') {
        const res = await liveAction('tabs', { action: 'close', tabId }, timeoutMs);
        if (!res.ok) return res;
        const after = await request('/api/browser/tabs', {}, timeoutMs);
        return { ...res, action: 'tabs close', tabs: after.ok ? normalizeTabs(after.tabs) : tabs };
      }
      return { ok: false, error: `live tabs action must be list|new|close|switch, got ${action}` };
    }
    case 'eval':
    case 'evaluate': {
      const expression = String(args.expression ?? args.js ?? args.text ?? '');
      if (!expression) return { ok: false, error: 'live evaluate needs expression' };
      const res = await liveAction('evaluate', { expression }, timeoutMs);
      if (!res.ok) return res;
      return { ...res, result: res.value ?? null };
    }
    case 'extract':
      return liveAction('extract', { ...(args.selector ? { selector: String(args.selector) } : {}) }, timeoutMs);
    case 'text':
    case 'getText': {
      const res = await liveAction('getText', { ...(args.selector ? { selector: String(args.selector) } : {}) }, timeoutMs);
      if (!res.ok) return res;
      return { ...res, text: String(res.text ?? '') };
    }
    case 'html': {
      const sel = args.selector ? `document.querySelector(${JSON.stringify(String(args.selector))})` : 'document.documentElement';
      const res = await liveAction('evaluate', {
        expression: `(() => { const el = ${sel}; return el ? el.outerHTML : null; })()`,
      }, timeoutMs);
      if (!res.ok) return res;
      if (res.value === null) return { ok: false, error: 'selector not found' };
      return { ok: true, html: String(res.value ?? '') };
    }
    case 'links': {
      const root = args.selector ? `document.querySelector(${JSON.stringify(String(args.selector))})` : 'document';
      const res = await liveAction('evaluate', {
        expression: `(() => { const root = ${root}; if (!root) return []; return Array.from(root.querySelectorAll('a[href]')).slice(0, 100).map(a => ({ href: a.href, text: (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) })); })()`,
      }, timeoutMs);
      if (!res.ok) return res;
      return { ok: true, links: Array.isArray(res.value) ? res.value : [] };
    }
    case 'inputs': {
      const snap = await request('/api/browser/snapshot', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }, timeoutMs);
      if (!snap.ok) return snap;
      const flat = flattenLiveSnapshot(snap.snapshot);
      const roles = new Set(['textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'button', 'link']);
      return { ok: true, inputs: flat.elements.filter((e) => roles.has(String(e.role ?? ''))) };
    }
    case 'wait':
    case 'waitFor': {
      if (args.urlIncludes && !args.selector && !args.text) {
        return { ok: false, error: 'live waitFor needs selector/text (urlIncludes is only supported by the headless backend)' };
      }
      const res = await liveAction('waitFor', {
        ...(args.selector ? { selector: String(args.selector) } : {}),
        ...(args.text ? { text: String(args.text) } : {}),
        timeoutMs: Number(args.timeoutMs ?? 0) || timeoutMs,
      }, timeoutMs);
      return res.ok ? { ...res, action: 'waitFor' } : res;
    }
    case 'cookies': {
      const action = String(args.action ?? 'get');
      // Never dump every cookie in the user's browser (including unrelated
      // sites) into a model prompt. Default to the active tab's origin.
      let url = args.url ? String(args.url) : '';
      if (!url) url = String((await activeTab(timeoutMs))?.url ?? '');
      if (!url) return { ok: false, error: 'live cookies needs a url (no active tab URL available)' };
      return liveAction('cookies', {
        action,
        url,
        ...(args.name ? { name: String(args.name) } : {}),
        ...(args.value !== undefined ? { value: String(args.value) } : {}),
      }, timeoutMs);
    }
    case 'console':
    case 'network': {
      const tabId = Number((await activeTab(timeoutMs))?.id);
      return liveAction(command, {
        action: String(args.action ?? 'list'),
        ...(args.filter ? { filter: String(args.filter) } : {}),
      }, timeoutMs, Number.isFinite(tabId) ? tabId : undefined);
    }
    case 'download':
    case 'downloads':
      return liveAction('download', {
        action: String(args.action ?? 'list'),
        ...(args.url ? { url: String(args.url) } : {}),
        ...(args.path ? { path: String(args.path) } : {}),
      }, timeoutMs);
    case 'screenshot': {
      const pathArg = args.path ? resolve(String(args.path)) : undefined;
      let res = await liveAction('screenshot', { format: 'png', fullPage: args.fullPage === true }, timeoutMs);
      if (!res.ok && Number(res.status) === 404) {
        res = await request('/api/browser/screenshot', {}, timeoutMs);
      }
      if (!res.ok) return res;
      const data = typeof res.data === 'string' ? res.data : '';
      if (!data) return { ok: false, error: 'live screenshot returned no data (extension disconnected?)' };
      if (!pathArg) return { ok: true, base64: data.slice(0, 200) + '…', note: 'pass path to save the image' };
      try {
        mkdirSync(dirname(pathArg), { recursive: true });
        writeFileSync(pathArg, Buffer.from(data, 'base64'));
        return { ok: true, saved: pathArg, bytes: Buffer.byteLength(data, 'base64') };
      } catch (err) {
        return { ok: false, error: `could not save screenshot: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'status':
    case 'probe': {
      const st = await liveStatus();
      return { ok: true, backend: 'live', ...st };
    }
    case 'close': {
      return { ok: true, action: 'close', note: 'live backend leaves the user browser open' };
    }
    default:
      return unsupported(command);
  }
}
