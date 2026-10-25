import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from './types.js';
import {
  browserCall,
  browserProbe,
  closeBrowserSession,
  initBrowserSession,
  type BrowserResponse,
} from '../browser/session.js';
import { liveCall, liveStatus } from '../browser/celeste.js';
import { listProfiles } from '../browser/profiles.js';
import { browserOptions } from '../browser/options.js';

// Stateful browser automation for Mochi.
//
// v1 launched a fresh headless browser for every tool call, so `click` could
// never act on the page `navigate` had just opened — multi-step flows were
// impossible. v2 keeps ONE browser alive per workspace (src/browser/session.ts
// + scripts/browser-daemon.mjs): navigate once, then click/type/press/snapshot
// against the same live page, with tabs, cookies, localStorage, console logs,
// network history, and downloads preserved across calls.
//
// Targets are model-friendly: `e12` refs from the last snapshot, CSS, or
// text=/role=/label=/placeholder=/testid= locators. A snapshot is returned
// automatically after navigation and clicks, so the model sees the new page
// without spending an extra turn.
//
// `backend: "live"` switches to the Celeste bridge (the user's REAL logged-in
// browser over the localhost extension daemon) for sites a fresh headless
// profile can never reach.

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;

// Kept for compatibility with the v1 driver test and any external callers.
let cachedHere: string | undefined;
function hereDir(): string {
  if (cachedHere === undefined) {
    try { cachedHere = resolve(dirname(fileURLToPath(import.meta.url))); }
    catch { cachedHere = process.cwd(); }
  }
  return cachedHere;
}
export const driverScript = (): string => resolve(hereDir(), '../../scripts/browser-driver.mjs');

function flag(args: Record<string, unknown>, name: string): boolean {
  const v = args[name];
  return v === true || v === 'true' || v === 1;
}

interface Parsed {
  command: string;
  rest: string;
}

/** Accept both structured calls (`command:"navigate", url:"…"`) and the
 *  shorthand models often emit (`command:"navigate https://…"`). */
export function parseCommand(raw: unknown): Parsed {
  const text = String(raw ?? '').trim();
  if (!text) return { command: '', rest: '' };
  const m = /^([a-zA-Z]+)\s+([\s\S]*)$/.exec(text);
  if (!m) return { command: text.toLowerCase(), rest: '' };
  return { command: m[1].toLowerCase(), rest: m[2].trim() };
}

const AUTO_SNAPSHOT = new Set(['navigate', 'get', 'back', 'forward', 'reload', 'click', 'press', 'select', 'tabs']);

function commandArgs(command: string, args: Record<string, unknown>, rest: string): Record<string, unknown> {
  const target = args.target ?? args.ref ?? args.selector;
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== '') out[k] = v; };

  const timeoutMs = Number(args.timeoutMs ?? 0) || undefined;
  put('timeoutMs', timeoutMs);
  put('waitMs', Number(args.waitMs ?? 0) || undefined);

  switch (command) {
    case 'navigate':
    case 'get':
      put('url', args.url ?? rest);
      put('waitUntil', args.waitUntil);
      put('timeoutMs', timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS);
      break;
    case 'snapshot':
    case 'snap':
      put('selector', args.selector);
      put('maxElements', args.maxElements);
      break;
    case 'click':
      put('target', target ?? rest);
      put('text', args.text);
      put('x', args.x);
      put('y', args.y);
      put('button', args.button);
      break;
    case 'type':
    case 'fill':
      put('target', target ?? rest);
      put('text', args.text);
      put('value', args.value);
      put('clear', args.clear);
      break;
    case 'press':
      put('key', args.key ?? rest);
      put('target', target);
      put('modifiers', args.modifiers);
      break;
    case 'scroll':
      put('direction', args.direction ?? rest ?? 'down');
      put('amount', args.amount);
      put('target', target);
      break;
    case 'hover':
    case 'focus':
      put('target', target ?? rest);
      break;
    case 'select':
      put('target', target ?? rest);
      put('value', args.value ?? args.text);
      break;
    case 'tabs':
    case 'tab':
      put('action', args.action ?? rest ?? 'list');
      put('index', args.index ?? args.tabIndex);
      put('tabId', args.tabId);
      put('url', args.url);
      break;
    case 'eval':
    case 'evaluate':
      put('expression', args.js ?? args.expression ?? rest);
      break;
    case 'extract':
      put('selector', args.selector ?? rest);
      put('limit', args.limit);
      break;
    case 'text':
    case 'getText':
    case 'html':
    case 'links':
    case 'inputs':
      put('selector', args.selector ?? rest);
      break;
    case 'screenshot':
      put('path', args.path ?? rest);
      put('fullPage', args.fullPage);
      break;
    case 'pdf':
      put('path', args.path ?? rest);
      put('format', args.format);
      break;
    case 'wait':
    case 'waitFor':
      put('selector', args.selector);
      put('text', args.text);
      put('urlIncludes', args.urlIncludes);
      put('timeoutMs', timeoutMs);
      break;
    case 'cookies':
      put('action', args.action ?? rest ?? 'get');
      put('url', args.url);
      put('name', args.name);
      put('value', args.value);
      break;
    case 'console':
    case 'network':
      put('action', args.action ?? rest ?? 'list');
      put('filter', args.filter);
      put('limit', args.limit);
      break;
    case 'upload':
      put('target', target ?? rest);
      put('files', args.files);
      break;
    case 'downloads':
    case 'status':
    case 'close':
    case 'probe':
      break;
    default:
      // Unknown command: pass through so the daemon reports the honest error.
      put('target', target ?? rest);
      break;
  }
  return out;
}

async function headlessCall(
  ctx: { cwd: string },
  command: string,
  args: Record<string, unknown>,
  opts: { timeoutMs: number; headless: boolean; browser?: string },
): Promise<BrowserResponse> {
  const session = browserOptions(ctx.cwd, {
    headless: opts.headless,
    ...(opts.browser ? { browser: opts.browser as 'chromium' | 'firefox' | 'webkit' } : {}),
  });
  // Initialize persistence paths once per daemon (idempotent + cheap).
  await initBrowserSession(session);
  const res = await browserCall(session, command, args, opts.timeoutMs);
  return { ...res, backendUsed: res.backendUsed ?? 'headless' };
}

async function call(
  ctx: { cwd: string },
  command: string,
  args: Record<string, unknown>,
  opts: { timeoutMs: number; backend: string; headless: boolean; browser?: string },
): Promise<BrowserResponse> {
  if (opts.backend === 'live') return await liveCall(command, args, opts.timeoutMs);
  if (opts.backend === 'auto') {
    const st = await liveStatus();
    if (st.available && st.connected) {
      const live = await liveCall(command, args, opts.timeoutMs);
      if (live.ok) return { ...live, backendUsed: 'live' };
      // Falling back is only safe for read-shaped commands. Silently retargeting
      // a click/type/press to a different (logged-out) browser would report
      // success while doing something else entirely — refuse instead and let
      // the caller opt into `backend:"headless"` explicitly.
      // Only a *missing live verb* may fall back. A live selector miss,
      // timeout, or page error must not silently read/act on a different
      // browser: that is how an agent reports success while doing nothing to
      // the page the user is looking at.
      const safeFallback = new Set(['status', 'probe', 'text', 'getText', 'html', 'links', 'inputs', 'extract']);
      const unsupported = /does not expose|not exposed|unsupported|not implemented/i.test(String(live.error ?? ''));
      if (!safeFallback.has(command) || !unsupported) {
        return {
          ...live,
          error: `${String(live.error ?? 'live backend failed')} (auto did not retarget this ${command} to headless; pass backend:"headless" to use an isolated page)`,
        };
      }
      const headless = await headlessCall(ctx, command, args, opts);
      if (headless.ok) return { ...headless, backendUsed: 'headless (live failed)' };
      return {
        ...headless,
        error: `${String(headless.error ?? 'headless failed')} [live backend: ${String(live.error ?? 'unavailable')}]`,
      };
    }
  }
  return await headlessCall(ctx, command, args, opts);
}

/** Turn the daemon's JSON into a compact, model-friendly text summary. */
export function summarizeResult(command: string, raw: string): string {
  if (!raw.trim()) return 'browser: no output (driver likely timed out).';
  let data: Record<string, unknown> | null = null;
  try { data = JSON.parse(raw) as Record<string, unknown>; } catch { /* not JSON — pass through */ }
  if (!data) return raw.slice(0, 4000);
  return summarizeData(command, data);
}

/** Same as summarizeResult but for an already-parsed response. */
export function summarizeData(command: string, data: Record<string, unknown>): string {
  if (data.ok === false) return `[browser ${command}] ERROR: ${String(data.error ?? data.detail ?? 'unknown error').slice(0, 1200)}`;
  const parts: string[] = [`[browser ${command}] ok`];
  const title = typeof data.title === 'string' ? data.title : '';
  const url = typeof data.url === 'string' ? data.url : '';
  if (title || url) parts.push(`page: ${title || '(untitled)'}${url ? ` — ${url}` : ''}`);
  if (typeof data.action === 'string') {
    const target = data.target !== undefined ? ` target=${String(data.target)}` : '';
    const key = data.key !== undefined ? ` key=${String(data.key)}` : '';
    const action = String(data.action);
    const typed = action === 'type' || action === 'fill' || action === 'select' || action === 'upload';
    const text = typed && data.text !== undefined ? ` text=${String(data.text).slice(0, 120)}` : '';
    const dir = data.direction !== undefined ? ` ${String(data.direction)} ${String(data.amount ?? '')}` : '';
    parts.push(`action: ${action}${target}${key}${text}${dir}`.trim());
  }
  if (typeof data.selected !== 'undefined') parts.push(`selected: ${JSON.stringify(data.selected)}`);
  if (typeof data.status !== 'undefined' && data.status !== null) parts.push(`http: ${String(data.status)}`);
  if (typeof data.saved === 'string') {
    parts.push(`saved: ${data.saved}${typeof data.bytes === 'number' ? ` (${data.bytes} bytes)` : ''}`);
  }
  if (Array.isArray(data.tabs)) {
    const tabs = data.tabs as Array<{ index?: number; active?: boolean; title?: string; url?: string }>;
    parts.push(`tabs (${tabs.length}):`);
    for (const t of tabs.slice(0, 20)) {
      parts.push(`  ${t.active ? '*' : ' '}${t.index}  ${t.title ?? ''} — ${t.url ?? ''}`);
    }
  }
  if (Array.isArray(data.elements) && data.elements.length) {
    const els = data.elements as Array<{ ref?: string; role?: string; name?: string; tag?: string; href?: string; value?: string; checked?: boolean; disabled?: boolean }>;
    parts.push(`interactive elements (${els.length}${data.elementsTruncated ? '+' : ''}):`);
    for (const e of els.slice(0, 80)) {
      const bits = [e.ref ?? '', e.role ?? e.tag ?? ''];
      let line = `  ${bits.join(' ')}`;
      if (e.name) line += ` "${String(e.name).slice(0, 80)}"`;
      if (e.value) line += ` value="${String(e.value).slice(0, 50)}"`;
      if (e.checked) line += ' [checked]';
      if (e.disabled) line += ' [disabled]';
      if (e.href) line += ` -> ${String(e.href).slice(0, 160)}`;
      parts.push(line);
    }
    if (els.length > 80) parts.push(`  … ${els.length - 80} more (call snapshot with a selector to narrow)`);
  }
  if (Array.isArray(data.inputs) && data.inputs.length) {
    parts.push(`inputs (${data.inputs.length}):`);
    for (const i of (data.inputs as Array<{ ref?: string; sel?: string; tag?: string; name?: string; type?: string; val?: string; value?: string }>).slice(0, 40)) {
      parts.push(`  ${i.ref ?? i.sel ?? ''} <${i.tag ?? ''}> name=${i.name ?? ''} type=${i.type ?? ''} val=${i.value ?? i.val ?? ''}`.trim());
    }
  }
  if (Array.isArray(data.links) && data.links.length) {
    const links = data.links as Array<{ href?: string; text?: string; sel?: string }>;
    parts.push(`links (${links.length}):`);
    for (const l of links.slice(0, 40)) parts.push(`  ${l.sel ?? ''} ${l.text ?? ''} -> ${l.href ?? ''}`.trim());
  }
  if (Array.isArray(data.items)) {
    const items = data.items as Array<{ text?: string; href?: string; src?: string; tag?: string }>;
    parts.push(`extracted ${items.length} item(s):`);
    for (const it of items.slice(0, 50)) {
      parts.push(`  ${it.tag ? `<${it.tag}> ` : ''}${String(it.text ?? '').slice(0, 200)}${it.href ? ` -> ${it.href}` : ''}${it.src ? ` [${it.src.slice(0, 100)}]` : ''}`.trim());
    }
  }
  if (Array.isArray(data.entries)) {
    const entries = data.entries as Array<Record<string, unknown>>;
    parts.push(`log entries (${entries.length}):`);
    for (const e of entries.slice(-30)) {
      if (e.status !== undefined) parts.push(`  ${String(e.method ?? '')} ${String(e.status ?? '')} ${String(e.url ?? '')}${e.failed ? ` FAILED ${String(e.failed)}` : ''}`.trim());
      else parts.push(`  [${String(e.type ?? '')}] ${String(e.text ?? '').slice(0, 300)}`);
    }
  }
  if (Array.isArray(data.downloads) && data.downloads.length) {
    const dls = data.downloads as Array<{ name?: string; saved?: string | null; url?: string }>;
    parts.push(`downloads (${dls.length}):`);
    for (const d of dls.slice(-10)) parts.push(`  ${d.name ?? ''}${d.saved ? ` -> ${d.saved}` : ''}`);
  }
  if (typeof data.text === 'string' && data.text.trim()) {
    const text = data.text.trim();
    parts.push(`text:\n${text.slice(0, 5000)}${text.length > 5000 ? `\n… (${text.length - 5000} chars truncated; use text with a selector)` : ''}`);
  }
  if (typeof data.html === 'string' && data.html.trim()) parts.push(`html:\n${data.html.slice(0, 12000)}`);
  if (typeof data.result !== 'undefined') parts.push(`result: ${typeof data.result === 'string' ? data.result.slice(0, 3000) : JSON.stringify(data.result).slice(0, 3000)}`);
  if (typeof data.elementsTruncated !== 'undefined' && data.elementsTruncated) parts.push('(element list truncated — narrow with snapshot selector)');
  if (typeof data.browser === 'string') parts.push(`engine: ${data.browser}${data.headless === false ? ' (headed)' : ' (headless)'}`);
  if (typeof data.backendUsed === 'string') parts.push(`backend: ${data.backendUsed}`);
  if (typeof data.backend === 'string') parts.push(`backend: ${data.backend}`);
  if (typeof data.statePath === 'string') parts.push(`session state: ${data.statePath}`);
  if (typeof data.persistent === 'boolean') {
    parts.push(`profile: ${data.persistent ? 'persistent' : 'ephemeral (profile locked or unavailable)'}${typeof data.profileDir === 'string' ? ` — ${data.profileDir}` : ''}`);
  }
  if (typeof data.note === 'string') parts.push(`note: ${data.note}`);
  return parts.join('\n');
}

/** Inputs for {@link buildDriverArgs} — the raw tool args, stringified. */
export interface BrowserDriverArgsInput {
  command: string;
  url?: string;
  selector?: string;
  text?: string;
  js?: string;
  path?: string;
  /** Key for `press` (e.g. Enter, Escape, Tab). Falls back to `text`/`selector`. */
  key?: string;
  /** Value for `select` (option value). Falls back to `text`. */
  value?: string;
  /** Tab target for `switchtab`/`closetab` (index or URL part). Falls back to `text`. */
  target?: string;
  /** Iframe selector or frame name (driver --frame). */
  frame?: string;
  /** Persistent browser profile dir (driver --profile). */
  profile?: string;
  waitMs?: number;
  timeoutMs?: number;
}

/**
 * Build the driver argv: `cmd positionals... --flags`. Pure (no I/O) so the
 * command plumbing is unit-testable without launching a browser.
 */
export function buildDriverArgs(input: BrowserDriverArgsInput): string[] {
  const { command, url, selector: sel, text, js, path: pathArg, key, value, target, frame, profile } = input;
  const waitMs = Number(input.waitMs ?? 0) || 0;
  // `execute` always supplies a timeoutMs (its own default is
  // DEFAULT_TIMEOUT_MS), so production argv is unchanged; the pure builder
  // only forwards a timeout flag when one was actually supplied.
  const timeoutMs = input.timeoutMs !== undefined
    ? (Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS)
    : undefined;
  const driverArgs: string[] = [];
  if (command === 'navigate' || command === 'get') {
    driverArgs.push(command, url ?? '');
  } else if (command === 'screenshot') {
    driverArgs.push('screenshot', pathArg ?? '');
  } else if (command === 'eval') {
    driverArgs.push('eval', js ?? '');
  } else if (command === 'press') {
    driverArgs.push('press', key ?? text ?? sel ?? '');
  } else if (command === 'select') {
    driverArgs.push('select', sel ?? '', value ?? text ?? '');
  } else if (command === 'type' || command === 'fill') {
    driverArgs.push(command, sel ?? '', text ?? '');
  } else if (command === 'tabs') {
    driverArgs.push('tabs');
  } else if (command === 'newtab') {
    // The URL is the positional here — the generic --url prefix must not
    // also fire (it navigates the CURRENT tab before the command runs).
    driverArgs.push('newtab', url ?? '');
  } else if (command === 'switchtab' || command === 'closetab') {
    // Tab target: index or URL substring, from `target` (or selector/text).
    driverArgs.push(command, target ?? sel ?? text ?? '');
  } else if (command === 'download') {
    // download <trigger-selector> [dest-path-or-dir]
    driverArgs.push('download', sel ?? '', pathArg ?? '');
  } else if (command === 'upload') {
    // upload <file-input-selector> <file-path[,path...]>
    driverArgs.push('upload', sel ?? '', pathArg ?? '');
  } else if (command === 'a11y') {
    // a11y [selector] — accessibility-tree snapshot of page or element.
    driverArgs.push('a11y', sel ?? '');
  } else if (command === 'batch') {
    // batch: the steps JSON rides the `js` slot — [{command, args}, ...]
    // executed in ONE browser session (see the tool description for why
    // multi-action flows require it).
    driverArgs.push('batch', js ?? '');
  } else if (command === 'netlog') {
    // netlog [count|clear] — the count/clear arg rides the selector slot.
    driverArgs.push('netlog', sel ?? text ?? '');
  } else {
    // selector-based commands (click/text/links/html/inputs/snap/waitfor/
    // hover/extract, and scroll — whose selector slot may hold a selector
    // OR a numeric pixel amount; for waitfor it may also hold a load state
    // (networkidle) or url:<part>; `value`/`text` are fallbacks for scroll).
    if (command === 'scroll') driverArgs.push(command, sel ?? value ?? text ?? '');
    else driverArgs.push(command, sel ?? '');
  }
  if (url && command !== 'navigate' && command !== 'get' && command !== 'newtab') driverArgs.push('--url', url);
  if (frame) driverArgs.push('--frame', frame);
  if (waitMs > 0) driverArgs.push('--wait', String(waitMs));
  if (timeoutMs !== undefined && timeoutMs !== 30000) driverArgs.push('--timeout', String(timeoutMs));
  if (profile) driverArgs.push('--profile', profile);
  return driverArgs;
}

/** Render the profile registry for the `profiles` command. */
export function summarizeProfiles(): string {
  const profiles = listProfiles();
  if (profiles.length === 0) return 'browser profiles: none registered yet (the first browser call creates the "default" profile).';
  const lines = [`browser profiles (${profiles.length}) — a profile is a credential store: it holds that name's cookies/logins:`];
  for (const p of profiles) {
    const state = p.revoked ? `REVOKED ${p.revokedAt ? new Date(p.revokedAt).toISOString() : ''}` : 'active';
    const used = p.lastUsedAt ? new Date(p.lastUsedAt).toISOString() : 'never';
    lines.push(`  ${p.name} [${state}] created ${new Date(p.createdAt).toISOString()} last used ${used}${p.origins.length ? ` origins: ${p.origins.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

export const browserTool: Tool = {
  def: {
    name: 'browser',
    description:
      'Drive a real browser with a PERSISTENT session (page, tabs, cookies, and logins survive across calls). ' +
      'Commands: navigate|back|forward|reload, snapshot (page text + numbered element refs), click, type, fill, press (Enter/Control+A), ' +
      'scroll, hover, select, focus, tabs (list/new/close/activate), wait (selector/text/url), getText, html, links, inputs, ' +
      'extract (repeated nodes), eval (JS), screenshot, pdf, upload, console, network, downloads, status, close. ' +
      'Targets: `e12` ref from snapshot, CSS selector, or text=Sign in / role=button[name="Sign in"] / label=Email / placeholder=Search / testid=submit. ' +
      'Navigation and clicks auto-return a fresh snapshot. Use backend:"live" for the user\'s real logged-in browser (Celeste bridge).',
    parameters: [
      { name: 'command', type: 'string', description: 'Action (navigate, snapshot, click, type, press, scroll, tabs, extract, screenshot, …)', required: true },
      { name: 'target', type: 'string', description: 'Element target: e12 ref, CSS, or text=/role=/label=/placeholder=/testid=/alt=/title= locator', required: false },
      { name: 'ref', type: 'string', description: 'Shorthand for an element ref from the last snapshot (e.g. e12)', required: false },
      { name: 'selector', type: 'string', description: 'CSS selector (legacy alias; also scopes snapshot/text/extract)', required: false },
      { name: 'text', type: 'string', description: 'Text to type/fill, or text to click/wait for', required: false },
      { name: 'value', type: 'string', description: 'Value for fill/select', required: false },
      { name: 'url', type: 'string', description: 'URL to navigate to (or new tab URL)', required: false },
      { name: 'key', type: 'string', description: 'Key or chord for press (Enter, Escape, Control+A)', required: false },
      { name: 'modifiers', type: 'array', description: 'Modifier keys for press: Control, Alt, Shift, Meta', required: false },
      { name: 'direction', type: 'string', description: 'Scroll direction: up|down|left|right', required: false },
      { name: 'amount', type: 'integer', description: 'Scroll distance in pixels (default 700)', required: false },
      { name: 'js', type: 'string', description: 'JavaScript expression for eval (await is supported)', required: false },
      { name: 'path', type: 'string', description: 'Output path for screenshot/pdf', required: false },
      { name: 'action', type: 'string', description: 'Sub-action for tabs (list|new|close|activate), console/network (list|clear), cookies (get|set|clear)', required: false },
      { name: 'index', type: 'integer', description: 'Tab index for tabs close/activate', required: false },
      { name: 'tabId', type: 'integer', description: 'Exact browser tab id for tabs close/activate', required: false },
      { name: 'files', type: 'array', description: 'File paths for upload (file input)', required: false },
      { name: 'maxElements', type: 'integer', description: 'Max elements in snapshot (default 150)', required: false },
      { name: 'waitMs', type: 'integer', description: 'Extra settle time after an action (ms)', required: false },
      { name: 'timeoutMs', type: 'integer', description: 'Command timeout ms (navigation default 30000)', required: false },
      { name: 'fullPage', type: 'boolean', description: 'Full-page screenshot (default true)', required: false },
      { name: 'backend', type: 'string', description: 'auto (default: live when connected, headless fallback for reads) | live (real logged-in browser via Celeste) | headless (isolated)', required: false },
      { name: 'headed', type: 'boolean', description: 'Show a visible headless-engine window (default false)', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const parsed = parseCommand(args.command);
    const command = parsed.command;
    if (!command) {
      return 'browser: command required (navigate, snapshot, click, type, fill, press, scroll, tabs, eval, extract, screenshot, status)';
    }
    if (command === 'probe') {
      const [pw, live] = await Promise.all([browserProbe(), liveStatus()]);
      const lines = [
        `[browser probe] headless: ${pw.ok ? 'ready' : 'unavailable'}${pw.ok ? ` (${(pw.browsers as string[] | undefined)?.join(', ') || 'no browsers cached'})` : ` — ${String(pw.error ?? '')}`}`,
        `[browser probe] live: ${live.available && live.connected ? `ready at ${live.base}` : `unavailable — ${live.detail ?? live.base}`}`,
      ];
      if (!pw.ok) lines.push('Install: npm i -g playwright && npx playwright install chromium');
      return lines.join('\n');
    }

    const backend = String(args.backend ?? process.env.MOCHI_BROWSER_BACKEND ?? 'auto').toLowerCase();
    const headless = !flag(args, 'headed');
    const engine = args.browser ? String(args.browser) : process.env.MOCHI_BROWSER_ENGINE;
    const timeoutMs = Number(args.timeoutMs ?? 0) || (command === 'navigate' || command === 'get' ? DEFAULT_NAV_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const callArgs = commandArgs(command, args, parsed.rest);

    ctx.events.emit({
      type: 'tool:called', tool: 'browser', args: { command, url: callArgs.url, target: callArgs.target, backend }, agentId: ctx.agentId,
    });

    let result: BrowserResponse;
    try {
      result = await call(ctx, command, callArgs, {
        timeoutMs: timeoutMs + 5000,
        backend,
        headless,
        ...(engine ? { browser: engine } : {}),
      });

      // Auto-snapshot: the model should SEE the page it just acted on, not
      // spend another round-trip asking for it. Skipped when the caller asked
      // for a specific extraction or disabled it.
      const wantsSnapshot = AUTO_SNAPSHOT.has(command) && process.env.MOCHI_BROWSER_SNAPSHOT !== '0'
        && args.snapshot !== false && !args.selector && !args.js && result.elements === undefined;
      if (result.ok && wantsSnapshot) {
        try {
          // Snapshot the SAME backend that performed the action. Re-resolving
          // auto here could read a different browser after a live failure.
          const snapBackend = backend === 'auto'
            ? (result.backendUsed === 'live' ? 'live' : 'headless')
            : backend;
          const snap = await call(ctx, 'snapshot', { maxElements: Number(args.maxElements ?? 120) || 120 }, {
            timeoutMs: 20_000, backend: snapBackend, headless,
            ...(engine ? { browser: engine } : {}),
          });
          if (snap.ok) {
            for (const k of ['text', 'title', 'url', 'elements', 'elementsTruncated']) {
              if (snap[k] !== undefined) result[k] = snap[k];
            }
          }
        } catch { /* a failed snapshot must not fail the action */ }
      }
      if (command === 'close') closeBrowserSession(ctx.cwd);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const summary = summarizeData(command, result);
    ctx.events.emit({
      type: 'tool:completed', tool: 'browser', agentId: ctx.agentId,
      result: { toolCallId: '', name: 'browser', output: summary, durationMs: 0 },
    });
    return summary;
  },
};
