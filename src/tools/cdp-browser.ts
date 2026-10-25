// CDP-native headless browsing tool — the light path.
//
// One tool, action-discriminated (tool-count and schema bill stay low, same
// reasoning as the lazy-schema work). Speaks CDP DIRECTLY to a headless-shell
// Chromium through src/browser/cdp/{client,manager,page}.ts — no puppeteer,
// no playwright, no full-browser process tree. The existing `browser` tool
// (Playwright daemon) and the computer-use path stay untouched.
//
// Session semantics: lazy singleton per workspace+profile (manager.ts), pages
// tracked by target id, dialogs auto-dismissed and RECORDED, console/network
// errors attached to the next result as a labeled evidence block. Page-state
// claims come from the snapshot/evidence, not the model's beliefs.
//
// Snapshots are the token-light page representation: an accessibility-tree
// walk with stable per-snapshot ref ids (e12) mapped to backendNodeIds; the
// click/type/scroll actions resolve refs through the DOM domain. No raw HTML
// dumps by default.
//
// eval is permission-gated like other exec surfaces: the tool itself is
// permission tier 'network', but the eval action additionally requires the
// shell tier (config permissions.shell=true) or an explicit session override
// (MOCHI_CDP_ALLOW_EVAL=1). Arbitrary page JS is exec, not navigation.
//
// Navigation policy hooks reuse the shared stack: named profiles are resolved
// through browser/profiles.ts (the SAME credential registry as the Playwright
// path — a login under a profile name carries over), and the tool carries the
// standard permission tier.

import { mochiStateDir } from '../core/mochi-dir.js';
import {
  isProfileName,
  looksLikePath,
  resolveProfileDir,
} from '../browser/profiles.js';
import { resolveCdpBrowserBinary } from '../browser/cdp/manager.js';
import { getCdpSession, closeAllCdpSessions } from '../browser/cdp/manager.js';
import type { PageSnapshot } from '../browser/cdp/page.js';
import type { Tool, ToolContext } from './types.js';

export type CdpBrowserAction =
  | 'open' | 'snapshot' | 'click' | 'type' | 'key' | 'scroll'
  | 'eval' | 'screenshot' | 'wait' | 'tabs' | 'close';

const ACTIONS: readonly CdpBrowserAction[] = ['open', 'snapshot', 'click', 'type', 'key', 'scroll', 'eval', 'screenshot', 'wait', 'tabs', 'close'];

/** Render a snapshot as the model-facing token-light page view. */
export function buildSnapshotText(snap: PageSnapshot, evidence: string[]): string {
  const lines: string[] = [];
  lines.push(`url: ${snap.url || '(unknown)'}${snap.title ? ` — ${snap.title}` : ''}`);
  for (const el of snap.elements) {
    const pad = '  '.repeat(Math.min(el.depth, 8));
    const ref = el.ref ? `${el.ref} ` : '';
    const value = el.value !== undefined && el.value !== '' ? ` value="${String(el.value).slice(0, 120)}"` : '';
    lines.push(`${pad}${ref}${el.role}${el.name ? ` "${el.name.slice(0, 160)}"` : ''}${value}`);
  }
  if (snap.text) lines.push(`page text:\n${snap.text}`);
  if (evidence.length) {
    lines.push(`[evidence — observed on this page since the last action]`);
    for (const e of evidence.slice(0, 20)) lines.push(`  ${e}`);
  }
  return lines.join('\n');
}

/** The eval gate: shell-tier permission (config) or the explicit session
 *  override. Returns an error string when denied, undefined when allowed. */
export function evalGateError(ctx: Pick<ToolContext, 'config'>): string | undefined {
  if (process.env.MOCHI_CDP_ALLOW_EVAL === '1') return undefined;
  if (ctx.config?.permissions?.shell === true) return undefined;
  return (
    'cdp_browser eval is permission-gated (arbitrary page JS is an exec surface). ' +
    'Enable permissions.shell=true in config, or set MOCHI_CDP_ALLOW_EVAL=1 for this session.'
  );
}

interface SessionSetup {
  workspaceDir: string;
  profileDir: string;
  executablePath?: string;
  stateDir: string;
}

function sessionSetup(ctx: ToolContext, profileName: string): SessionSetup {
  const workspaceDir = ctx.cwd;
  const stateDir = mochiStateDir(workspaceDir);
  const resolved = resolveProfileDir(profileName); // throws on revoked/invalid
  const cfgExecutable = (ctx.config as unknown as { browser?: { cdpExecutable?: string } } | undefined)?.browser?.cdpExecutable;
  return {
    workspaceDir,
    profileDir: resolved.entry.dir,
    ...(cfgExecutable ? { executablePath: cfgExecutable } : {}),
    stateDir,
  };
}

function restartBlock(mgr: ReturnType<typeof getCdpSession>): string[] {
  if (!mgr.restartNote) return [];
  const note = mgr.restartNote;
  mgr.restartNote = undefined;
  return [`[restart] ${note}`];
}

function sandboxBlock(mgr: ReturnType<typeof getCdpSession>): string[] {
  if (!mgr.sandboxNote) return [];
  return [`[sandbox] ${mgr.sandboxNote}`];
}

/** Action results carry lifecycle blocks only; console/network/dialog
 *  evidence is intentionally NOT drained here — per the verified-evidence
 *  discipline it attaches to the NEXT SNAPSHOT (the page observation the
 *  model reasons over), where it is shown once and cleared. */
async function actionResult(mgr: ReturnType<typeof getCdpSession>, header: string): Promise<string> {
  return [header, ...restartBlock(mgr), ...sandboxBlock(mgr)].filter(Boolean).join('\n');
}

export const cdpBrowserTool: Tool = {
  def: {
    name: 'cdp_browser',
    description:
      'Drive a CDP-native headless Chromium (chrome-headless-shell over the Chrome DevTools Protocol — no puppeteer/playwright). ' +
      'One action per call. Actions: open(url) → navigates AND returns the accessibility snapshot; ' +
      'snapshot → the token-light page view: interactive elements carry stable refs (e12) mapped to DOM backend node ids; ' +
      'click(ref) / type(ref,text) / key(name) / scroll(direction,amount[,ref]) act on those refs through the DOM domain; ' +
      'eval(js) — permission-gated (permissions.shell=true or MOCHI_CDP_ALLOW_EVAL=1); ' +
      'screenshot(path?,fullPage?) saves a PNG; wait(kind: network-idle|selector|text|ms, selector|text|ms, timeoutMs); ' +
      'tabs [switch=<index>] [url=<new-tab-url>]; close([tab=<index>]) — closing the LAST tab shuts the browser down. ' +
      'State: cookies/logins persist under a NAMED profile shared with the browser tool (profile=<name>, never a path). ' +
      'Dialogs (alert/confirm) are auto-dismissed and reported; console/network errors attach to the next result as an [evidence] block. ' +
      'Binary: config browser.cdpExecutable → MOCHI_CDP_BROWSER → pinned cache install (mochi browser fetch-cdp-shell) → system chromium.',
    parameters: [
      { name: 'action', type: 'string', description: 'open|snapshot|click|type|key|scroll|eval|screenshot|wait|tabs|close', required: true },
      { name: 'url', type: 'string', description: 'URL for open (or a new tab via tabs action)', required: false },
      { name: 'ref', type: 'string', description: 'Snapshot ref (e12) for click/type/scroll', required: false },
      { name: 'text', type: 'string', description: 'Text to type; also the needle for wait kind=text', required: false },
      { name: 'key', type: 'string', description: 'Key name for key action (Enter, Escape, Tab, ArrowDown, Control+A, …)', required: false },
      { name: 'direction', type: 'string', description: 'Scroll direction: down|up|left|right (default down)', required: false },
      { name: 'amount', type: 'integer', description: 'Scroll amount in px (default 500)', required: false },
      { name: 'js', type: 'string', description: 'JavaScript for eval (permission-gated)', required: false },
      { name: 'path', type: 'string', description: 'Screenshot output path (default: under the workspace .mochi state dir)', required: false },
      { name: 'fullPage', type: 'boolean', description: 'Screenshot the whole scrollable page (default viewport only)', required: false },
      { name: 'wait', type: 'string', description: 'Wait kind: network-idle|selector|text|ms', required: false },
      { name: 'selector', type: 'string', description: 'CSS selector for wait kind=selector', required: false },
      { name: 'ms', type: 'integer', description: 'Milliseconds for wait kind=ms', required: false },
      { name: 'timeoutMs', type: 'integer', description: 'Timeout for wait/navigation (default 10000 wait / 30000 navigation)', required: false },
      { name: 'tab', type: 'string', description: 'Tab index (0-based) or target id: switch target for tabs action, close target for close', required: false },
      { name: 'switch', type: 'integer', description: 'Tab index to switch to (tabs action)', required: false },
      { name: 'profile', type: 'string', description: 'Browser profile NAME (credential store shared with the browser tool). Default "default"', required: false },
    ],
    permission: 'network',
  },

  async execute(args, ctx) {
    const action = String(args.action ?? args.command ?? '') as CdpBrowserAction;
    if (!ACTIONS.includes(action)) {
      return `cdp_browser: unknown action "${String(action)}" — use one of: ${ACTIONS.join(', ')}`;
    }

    // Profile resolution is shared with the Playwright path (profiles.ts):
    // names only, revocation respected, same registry.
    const profileName = args.profile ? String(args.profile) : 'default';
    if (looksLikePath(profileName) || !isProfileName(profileName)) {
      return `cdp_browser: profile must be a NAME (got "${profileName}"). Profiles are named credential stores — list them via the browser tool's profiles command.`;
    }
    let setup: SessionSetup;
    try {
      setup = sessionSetup(ctx, profileName);
    } catch (e) {
      return `cdp_browser: ${(e as Error).message}`;
    }

    const mgr = getCdpSession({
      workspaceDir: setup.workspaceDir,
      profileDir: setup.profileDir,
      ...(setup.executablePath ? { executablePath: setup.executablePath } : {}),
    });

    // eval gate (before any browser launch: a denied action never spawns one).
    if (action === 'eval') {
      const denied = evalGateError(ctx);
      if (denied) return `cdp_browser: ${denied}`;
    }

    const page = await mgr.ensurePage();
    const timeoutMs = Number(args.timeoutMs ?? 0) || undefined;

    try {
      switch (action) {
        case 'open': {
          const url = String(args.url ?? '');
          if (!url) return 'cdp_browser: open needs url';
          const target = args.tab === 'new' ? await mgr.openPage() : page;
          await target.navigate(url, timeoutMs ?? 30_000);
          // Settle initial page activity (bounded, best-effort) so the
          // snapshot reflects the loaded page, not a mid-load frame.
          await target.wait('network-idle', { timeoutMs: 5000 }).catch(() => { /* report what we have */ });
          const snap = await target.snapshot();
          return [
            `[cdp_browser open] ` + buildSnapshotText(snap, target.drainEvidence()),
            ...restartBlock(mgr),
            ...sandboxBlock(mgr),
          ].filter(Boolean).join('\n');
        }
        case 'snapshot': {
          const snap = await page.snapshot();
          return [
            `[cdp_browser snapshot]`,
            ...restartBlock(mgr),
            ...sandboxBlock(mgr),
            buildSnapshotText(snap, page.drainEvidence()),
          ].filter(Boolean).join('\n');
        }
        case 'click': {
          const ref = String(args.ref ?? '');
          if (!ref) return 'cdp_browser: click needs a snapshot ref (take action=snapshot first)';
          const at = await page.click(ref, { double: args.double === true });
          return await actionResult(mgr, `[cdp_browser click] ok — ${ref} clicked at ${at.x},${at.y}`);
        }
        case 'type': {
          const ref = String(args.ref ?? '');
          const text = String(args.text ?? '');
          if (!ref) return 'cdp_browser: type needs a snapshot ref (take action=snapshot first)';
          await page.type(ref, text, { clear: args.clear !== false });
          return await actionResult(mgr, `[cdp_browser type] ok — ${ref} ← "${text.slice(0, 200)}"`);
        }
        case 'key': {
          const name = String(args.key ?? args.text ?? '');
          if (!name) return 'cdp_browser: key needs a key name (e.g. Enter, Escape, Tab, Control+A)';
          await page.key(name);
          return await actionResult(mgr, `[cdp_browser key] ok — ${name}`);
        }
        case 'scroll': {
          const res = await page.scroll({
            direction: args.direction ? String(args.direction) : undefined,
            amount: args.amount !== undefined ? Number(args.amount) : undefined,
            ref: args.ref ? String(args.ref) : undefined,
          });
          return await actionResult(mgr, `[cdp_browser scroll] ok — ${res.deltaY || res.deltaX || 0}px at ${res.x},${res.y}`);
        }
        case 'eval': {
          const js = String(args.js ?? args.text ?? '');
          if (!js) return 'cdp_browser: eval needs js';
          let value: unknown;
          try {
            value = await page.evalJs(js);
          } catch (err) {
            return await actionResult(mgr, `[cdp_browser eval] ERROR: ${(err as Error).message}`);
          }
          const rendered = typeof value === 'string' ? value : JSON.stringify(value);
          return await actionResult(mgr, `[cdp_browser eval] result: ${rendered?.slice(0, 4000) ?? 'undefined'}`);
        }
        case 'screenshot': {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const path = args.path ? String(args.path) : `${setup.stateDir}/cdp/screenshots/screenshot-${ts}.png`;
          const shot = await page.screenshot({ path, fullPage: args.fullPage === true });
          return await actionResult(mgr, `[cdp_browser screenshot] saved: ${shot.path} (${shot.bytes} bytes${shot.fullPage ? ', full page' : ''})`);
        }
        case 'wait': {
          const kind = String(args.wait ?? 'ms') as 'network-idle' | 'selector' | 'text' | 'ms';
          const detail = await page.wait(kind, {
            ms: args.ms !== undefined ? Number(args.ms) : undefined,
            selector: args.selector ? String(args.selector) : undefined,
            text: args.text ? String(args.text) : undefined,
            ...(timeoutMs ? { timeoutMs } : {}),
          });
          return await actionResult(mgr, `[cdp_browser wait] ok — ${detail}`);
        }
        case 'tabs': {
          if (args.url) {
            const newPage = await mgr.openPage(String(args.url));
            const snap = await newPage.snapshot();
            return `[cdp_browser tabs] opened new tab\n` + buildSnapshotText(snap, newPage.drainEvidence());
          }
          if (args.switch !== undefined || args.tab !== undefined) {
            const switched = await mgr.switchPage(args.switch !== undefined ? Number(args.switch) : String(args.tab));
            return `[cdp_browser tabs] switched to ${switched.url} (${switched.targetId})`;
          }
          const pages = await mgr.listPages();
          const lines = [`[cdp_browser tabs] ${pages.length} open:`];
          pages.forEach((p, i) => lines.push(`  [${i}]${p.active ? ' *' : ''} ${p.url} (${p.targetId})`));
          return await actionResult(mgr, lines.join('\n'));
        }
        case 'close': {
          if (args.tab !== undefined) {
            const res = await mgr.closePage(String(args.tab));
            return `[cdp_browser close] tab closed${res.browserClosed ? ' — last tab, browser shut down' : ''}`;
          }
          const res = await mgr.closePage(page.targetId);
          return `[cdp_browser close] page closed${res.browserClosed ? ' — last page, browser shut down' : ''}`;
        }
        default:
          return `cdp_browser: unimplemented action "${action}"`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A transport drop mid-call usually means the browser crashed; the
      // manager records the crash and the NEXT call relaunches once.
      // Buffered page evidence is NOT drained here — it rides the next
      // snapshot (possibly after the restart).
      return [`[cdp_browser ${action}] ERROR: ${msg}`, ...restartBlock(mgr), ...sandboxBlock(mgr)]
        .filter(Boolean).join('\n');
    }
  },
};

/** Test/agent-shutdown hook. */
export function closeCdpBrowserSessions(): void {
  closeAllCdpSessions();
}

/** Exposed for the doctor/status surfaces: the resolved CDP binary. */
export function cdpBinaryStatus(): { path: string; source: string } | { error: string } {
  try {
    const r = resolveCdpBrowserBinary();
    return { path: r.path, source: r.source };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
