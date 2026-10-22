import { resolve, dirname } from 'node:path';
import { runArgv } from '../exec.js';
import { fileURLToPath } from 'node:url';
import type { Tool } from './types.js';

// Cline-grade browser automation for Mochi WITHOUT a runtime dependency.
//
// Mochi is a Bun-compiled binary with zero runtime deps, so it can't bundle
// playwright/puppeteer. This tool shells out to `scripts/browser-driver.mjs`
// (a plain-node script that loads the GLOBALLY-installed playwright), enforcing
// a bounded SIGTERM→SIGKILL timeout per the freeze-class sentinel (every spawn
// that waits on output needs a kill timer — shell.ts is the reference).
//
// Commands map 1:1 to the driver's subcommands; `url` can be given as the
// first positional (navigate) or via `url:` for extract/act calls so a single
// invocation does "open X, then click/type/read".

const DEFAULT_TIMEOUT_MS = 45_000;

// Module dir, resolved LAZILY: bun-compiled Windows binaries report a
// non-file import.meta.url, and fileURLToPath throws at import time — which
// used to kill every command (even `acp --check`) on Windows before any tool
// ran. Unresolvable → cwd, and runDriver reports driver-unavailable.
let cachedHere: string | undefined;
function hereDir(): string {
  if (cachedHere === undefined) {
    try { cachedHere = resolve(dirname(fileURLToPath(import.meta.url))); }
    catch { cachedHere = process.cwd(); }
  }
  return cachedHere;
}
export const driverScript = (): string => resolve(hereDir(), '../../scripts/browser-driver.mjs');

function runDriver(args: string[], timeoutMs: number): Promise<string> {
  // Central exec path (src/exec.ts): bounded SIGTERM→SIGKILL via killGraceMs,
  // per-stream output caps, and spawn-error rejection handled below so the
  // tool's never-throw contract holds.
  return runArgv(process.execPath, [driverScript(), ...args], {
    timeoutMs,
    killGraceMs: 3000,
  })
    .then((res) =>
      res.stdout.trim().slice(-60_000) ||
      (res.code !== 0 ? `[browser exit ${res.code}] ${res.stderr.trim().slice(0, 500)}` : ''),
    )
    .catch((e: unknown) => `[browser exit 1] ${(e as Error).message.trim().slice(0, 500)}`);
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

export const browserTool: Tool = {
  def: {
    name: 'browser',
    description:
      'Drive a real headless browser (navigate, read text/DOM/links, click, type/fill, press keys, scroll, hover, select options, wait for elements, eval JS, screenshot). ' +
      'For testing web apps, dynamic pages, and UI verification. State (cookies/localStorage/login) persists across calls via a persistent browser profile, and the open tab set (URLs + active tab) persists too, so multi-step and multi-tab flows work. Page console errors are reported in the result. ' +
      'Commands: navigate <url> | click <css> | type <css> <text> | fill <css> <text> | press <key> | scroll [css|pixels] | waitfor <css|networkidle|url:<part>> | select <css> <value> | hover <css> | ' +
      'text [css] | links [css] | html [css] | inputs [css] | extract [css] | eval <js> | screenshot <path> | ' +
      'tabs | newtab [url] | switchtab <index|url-part> | closetab [index|url-part] | download <css> [dest] | upload <css> <file-path>. ' +
      'extract returns the page (or element) main content as clean markdown-ish text plus the largest table as structured rows. ' +
      'Pass `frame` (iframe CSS selector or frame name) to run click/type/fill/select/hover/waitfor/text/extract inside an iframe. ' +
      'Prefix `url:` to open a page and act in one call.',
    parameters: [
      { name: 'command', type: 'string', description: 'Action: navigate|get|click|type|fill|press|scroll|waitfor|select|hover|text|links|html|inputs|extract|eval|screenshot|snap|tabs|newtab|switchtab|closetab|download|upload', required: true },
      { name: 'selector', type: 'string', description: 'CSS selector for click/type/fill/select/waitfor/hover/text/links/html/inputs/extract/download/upload; for scroll, a CSS selector or a numeric pixel amount; for waitfor, also a load state (networkidle|load|domcontentloaded) or url:<part>; for switchtab/closetab, a tab index or URL substring', required: false },
      { name: 'text', type: 'string', description: 'Text to type/fill (for type/fill); fallback for press key / select value / tab target', required: false },
      { name: 'key', type: 'string', description: 'Key for press (e.g. Enter, Escape, Tab, ArrowDown)', required: false },
      { name: 'value', type: 'string', description: 'Option value for select', required: false },
      { name: 'url', type: 'string', description: 'URL to navigate to (for navigate/get/newtab, or prefix before acting)', required: false },
      { name: 'path', type: 'string', description: 'Screenshot: output path. download: destination file or directory. upload: file path to attach (comma-separate for multiple)', required: false },
      { name: 'js', type: 'string', description: 'JavaScript to eval (returns JSON result)', required: false },
      { name: 'frame', type: 'string', description: 'Iframe CSS selector or frame name: run selector commands inside that frame', required: false },
      { name: 'profile', type: 'string', description: 'Persistent browser profile dir (cookies/login state + tab session); default ~/.cache/mochi/browser-profile', required: false },
      { name: 'waitMs', type: 'integer', description: 'Milliseconds to wait after navigating/clicking before returning', required: false },
      { name: 'timeoutMs', type: 'integer', description: 'Navigation timeout ms (default 30000)', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    if (!command) return 'browser: command required (navigate, click, type, fill, press, scroll, waitfor, select, hover, text, links, html, inputs, extract, eval, screenshot, tabs, newtab, switchtab, closetab, download, upload)';
    const url = args.url ? String(args.url) : undefined;
    const timeoutMs = Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

    const driverArgs = buildDriverArgs({
      command,
      url,
      selector: args.selector ? String(args.selector) : undefined,
      text: args.text !== undefined ? String(args.text) : undefined,
      js: args.js !== undefined ? String(args.js) : undefined,
      path: args.path ? String(args.path) : undefined,
      key: args.key ? String(args.key) : undefined,
      value: args.value !== undefined ? String(args.value) : undefined,
      frame: args.frame ? String(args.frame) : undefined,
      profile: args.profile ? String(args.profile) : undefined,
      waitMs: Number(args.waitMs ?? 0) || 0,
      timeoutMs,
    });

    ctx.events.emit({
      type: 'tool:called', tool: 'browser', args: { command, url }, agentId: ctx.agentId,
    });

    const raw = await runDriver(driverArgs, timeoutMs + 4000).catch(() => '');
    const summary = summarizeResult(command, raw);
    ctx.events.emit({
      type: 'tool:completed', tool: 'browser', agentId: ctx.agentId,
      result: { toolCallId: '', name: 'browser', output: summary, durationMs: 0 },
    });
    return summary;
  },
};

/** Format the driver's collected console/page errors as compact lines. */
export function consoleErrorLines(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.consoleErrors) || data.consoleErrors.length === 0) return [];
  const lines: string[] = [`console errors (${data.consoleErrors.length}):`];
  for (const e of (data.consoleErrors as Array<{ type?: string; text?: string }>).slice(0, 20)) {
    lines.push(`  [${e?.type ?? 'error'}] ${String(e?.text ?? '').slice(0, 300)}`.trimEnd());
  }
  return lines;
}

/** Turn the driver's JSON into a compact, model-friendly text summary. */
export function summarizeResult(command: string, raw: string): string {
  if (!raw.trim()) return 'browser: no output (driver likely timed out).';
  let data: Record<string, unknown> | null = null;
  try { data = JSON.parse(raw); } catch { /* not JSON — pass through */ }
  if (!data) return raw.slice(0, 4000);
  if (data.ok === false) {
    const base = `[browser ${command}] ERROR: ${data.error ?? 'unknown'}`;
    const errs = consoleErrorLines(data);
    return errs.length ? [base, ...errs].join('\n') : base;
  }
  const parts: string[] = [`[browser ${command}] ok`];
  if (data.title) parts.push(`title: ${data.title}`);
  if (data.url) parts.push(`url: ${data.url}`);
  if (data.text) parts.push(`text: ${data.text}`);
  if (Array.isArray(data.links)) {
    parts.push(`links (${data.links.length}):`);
    for (const l of (data.links as Array<{ href?: string; text?: string; sel?: string }>).slice(0, 30)) {
      parts.push(`  ${l.sel ?? ''} ${l.href ?? ''} ${l.text ?? ''}`.trim());
    }
  }
  if (Array.isArray(data.inputs) && (data.inputs as unknown[]).length) {
    parts.push(`inputs (${(data.inputs as unknown[]).length}):`);
    for (const i of (data.inputs as Array<{ sel?: string; tag?: string; name?: string; type?: string; val?: string }>).slice(0, 30)) {
      parts.push(`  ${i.sel ?? ''} <${i.tag ?? ''}> name=${i.name ?? ''} type=${i.type ?? ''} val=${i.val ?? ''}`.trim());
    }
  }
  if (Array.isArray(data.tabs)) {
    parts.push(`tabs (${(data.tabs as unknown[]).length}):`);
    for (const t of data.tabs as Array<{ index?: number; url?: string; title?: string; active?: boolean }>) {
      parts.push(`  [${t.index ?? ''}]${t.active ? ' *' : ''} ${t.url ?? ''}${t.title ? ` — ${t.title}` : ''}`.trimEnd());
    }
  }
  if (data.extract) parts.push(`extract:\n${String(data.extract).slice(0, 12000)}`);
  if (data.table && typeof data.table === 'object') {
    const t = data.table as { headers?: string[]; rows?: string[][]; rowCount?: number };
    const rows = Array.isArray(t.rows) ? t.rows : [];
    parts.push(`table (${t.rowCount ?? rows.length} rows)${t.headers?.length ? `: ${t.headers.join(' | ')}` : ''}`);
    for (const r of rows.slice(0, 20)) {
      parts.push(`  ${r.map((c) => String(c ?? '').slice(0, 60)).join(' | ')}`);
    }
  }
  if (data.html) parts.push(`html: ${data.html}`);
  if (data.filename !== undefined && data.saved) {
    parts.push(`downloaded: ${data.saved} (${data.size ?? 0} bytes, filename=${data.filename})`);
  } else if (data.saved) parts.push(`saved: ${data.saved}`);
  if (data.action) parts.push(`action: ${data.action} target=${(data as { target?: string }).target ?? ''} text=${data.text ?? ''}`);
  if (data.result !== undefined) parts.push(`result: ${String(data.result)}`);
  // Page errors are verification evidence — surface them last so the model
  // sees them even when the action itself "succeeded".
  parts.push(...consoleErrorLines(data));
  return parts.join('\n');
}