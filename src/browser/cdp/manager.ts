// CDP browser manager: process lifecycle for the headless-shell Chromium.
//
// Responsibilities (one module, so the lifecycle rules stay in one place):
//  - BINARY RESOLUTION, in order: explicit config path -> MOCHI_CDP_BROWSER
//    env -> Mochi's cache dir (a PINNED chrome-headless-shell download with
//    checksum verification — the fetch is a separate explicit step, never a
//    silent download at first tool call) -> system chromium/chrome fallback
//    (reuses options.browserExecutable()'s candidates).
//  - LAUNCH: ephemeral debugging port (--remote-debugging-port=0), the ws
//    endpoint is read from the browser's own "DevTools listening on" stderr
//    line; profile dir under Mochi's state dir. SANDBOX POLICY: the browser
//    keeps Chromium's own layer-1 sandbox — --no-sandbox is NEVER passed
//    unless the caller explicitly allows it (env/config), and when it is
//    used it is a logged, labeled decision surfaced in tool results.
//  - IDLE REAP: the browser shuts down after idleMs with no activity.
//  - CRASH DETECTION + ONE RESTART: a dead browser is detected via the
//    transport drop; the next call relaunches once and the restart (state
//    loss: tabs/history open at crash time) is surfaced in the tool result.
//  - LAZY SINGLETON per workspace+profile (same keyFor shape as session.ts),
//    pages tracked by target id.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CdpClient } from './client.js';
import { CdpPage } from './page.js';

// ---------------------------------------------------------------------------
// Binary resolution

export type BinarySource = 'config' | 'env' | 'cache' | 'system';

export interface ResolvedBrowser {
  path: string;
  source: BinarySource;
  /** True when the binary is chrome-headless-shell (no --headless flag). */
  isHeadlessShell: boolean;
}

/** The pinned chrome-headless-shell build this stack downloads (checked
 *  against the upstream chrome-for-testing artifact's sha256 at install). */
export const PINNED_SHELL = {
  version: '156.0.8078.47',
  url: 'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux64/chrome-headless-shell-linux64.zip',
  sha256: '0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa',
  bytes: 125_799_226,
} as const;

/** Cache root for the pinned download (override: MOCHI_CDP_CACHE_DIR). */
export function cdpCacheRoot(): string {
  const env = process.env.MOCHI_CDP_CACHE_DIR;
  if (env && env.trim()) return resolve(env.trim());
  return resolve(homedir(), '.cache', 'mochi', 'cdp');
}

function cacheBinaryPath(version: string): string {
  return resolve(cdpCacheRoot(), `chrome-headless-shell-${version}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}

/** Installed pinned shells in the cache dir (newest version first). */
export function cachedShellInstalls(): string[] {
  const root = cdpCacheRoot();
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith('chrome-headless-shell-'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const out: string[] = [];
  for (const d of dirs) {
    const bin = cacheBinaryPath(d.replace('chrome-headless-shell-', ''));
    if (existsSync(bin)) out.push(bin);
  }
  return out;
}

const SYSTEM_CANDIDATES = process.platform === 'darwin'
  ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ]
  : process.platform === 'win32'
    ? [
      join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    ]
    : [
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/brave-browser', '/usr/bin/brave',
    ];

/**
 * Resolution order (brief): explicit config path -> MOCHI_CDP_BROWSER ->
 * pinned cache download -> system fallback. Throws only when NOTHING is
 * found, with the fetch instruction (the download is an explicit step, never
 * performed here).
 */
export function resolveCdpBrowserBinary(configPath?: string): ResolvedBrowser {
  const check = (p: string, source: BinarySource): ResolvedBrowser | undefined =>
    p && existsSync(p) ? { path: p, source, isHeadlessShell: /headless-shell/i.test(basename(p)) } : undefined;

  const configHit = configPath ? check(configPath, 'config') : undefined;
  if (configHit) return configHit;
  const env = process.env.MOCHI_CDP_BROWSER;
  const envHit = env && env.trim() ? check(env.trim(), 'env') : undefined;
  if (envHit) return envHit;
  const cacheHit = cachedShellInstalls()[0];
  const cache = cacheHit ? check(cacheHit, 'cache') : undefined;
  if (cache) return cache;
  for (const c of SYSTEM_CANDIDATES) {
    const sys = check(c, 'system');
    if (sys) return sys;
  }
  throw new Error(
    'no CDP browser binary found. Install one explicitly: `mochi browser fetch-cdp-shell` ' +
    `(downloads the pinned chrome-headless-shell ${PINNED_SHELL.version}, checksum-verified), ` +
    'or set MOCHI_CDP_BROWSER to a chromium/chrome binary.',
  );
}

// ---------------------------------------------------------------------------
// Launch

export interface LaunchOptions {
  executablePath: string;
  isHeadlessShell?: boolean;
  profileDir: string;
  /** Debugging port; 0 (default) = ephemeral. */
  port?: number;
  endpointTimeoutMs?: number;
  /** Relaunch permission for --no-sandbox when Chromium's own sandbox cannot
   *  engage (e.g. restricted container). NEVER default-on. */
  allowNoSandbox?: boolean;
}

export interface LaunchResult {
  child: ChildProcess;
  wsUrl: string;
  port: number;
  args: string[];
  /** Set when the launch needed --no-sandbox (labeled decision, logged). */
  sandboxNote?: string;
}

/** Build the chromium argv. Pure + exported for the sandbox-policy unit test:
 *  --no-sandbox appears ONLY when explicitly allowed. */
export function buildCdpArgs(opts: { executablePath: string; isHeadlessShell?: boolean; profileDir: string; port?: number; noSandbox?: boolean }): string[] {
  const args = [
    // chrome-headless-shell IS headless; a full chrome binary needs the flag.
    ...(opts.isHeadlessShell ? [] : ['--headless=new']),
    `--remote-debugging-port=${opts.port ?? 0}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-sync',
    'about:blank',
  ];
  if (opts.noSandbox) args.unshift('--no-sandbox');
  return args;
}

const SANDBOX_FAILURE_RE = /(SUID sandbox|sandbox is not supported|No usable sandbox|namespace|clone.*failed|Operation not permitted.*sandbox)/i;

/**
 * Spawn the browser and wait for its "DevTools listening on ws://..." line.
 * If the process dies with a sandbox-class failure and `allowNoSandbox` is
 * set, relaunch ONCE with --no-sandbox (labeled). Without the allowance the
 * error surfaces with instructions instead.
 */
export async function launchCdpBrowser(opts: LaunchOptions): Promise<LaunchResult> {
  try {
    return await launchOnce(opts, false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!SANDBOX_FAILURE_RE.test(msg)) throw err;
    if (!opts.allowNoSandbox) {
      throw new Error(
        `chromium sandbox could not engage: ${msg} — ` +
        'run under a kernel that allows user namespaces (unprivileged_userns_clone=1), ' +
        'or explicitly allow the labeled fallback with MOCHI_CDP_ALLOW_NO_SANDBOX=1 ' +
        '(the browser then runs WITHOUT its layer-1 sandbox; every result is labeled).',
      );
    }
    const relaunched = await launchOnce(opts, true);
    relaunched.sandboxNote =
      'launched with --no-sandbox: chromium layer-1 sandbox unavailable in this environment ' +
      '(explicitly allowed via MOCHI_CDP_ALLOW_NO_SANDBOX; OS-level confinement is NOT active for the browser process)';
    return relaunched;
  }
}

async function launchOnce(opts: LaunchOptions, noSandbox: boolean): Promise<LaunchResult> {
  const args = buildCdpArgs({
    executablePath: opts.executablePath,
    isHeadlessShell: opts.isHeadlessShell,
    profileDir: opts.profileDir,
    port: opts.port,
    ...(noSandbox ? { noSandbox: true } : {}),
  });
  const child = spawn(opts.executablePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env },
  });
  const endpointTimeoutMs = opts.endpointTimeoutMs ?? 15_000;
  const wsUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
    let out = '';
    let settled = false;
    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? rejectPromise(err) : resolvePromise(url as string);
    };
    const onChunk = (d: Buffer): void => {
      out = (out + d.toString('utf8')).slice(-16_000);
      const m = out.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) finish(null, m[1]);
    };
    const timer = setTimeout(() => {
      finish(new Error(`browser produced no DevTools endpoint within ${endpointTimeoutMs}ms${out ? ` — stderr tail: ${out.slice(-300)}` : ''}`));
      child.kill('SIGTERM');
    }, endpointTimeoutMs);
    child.stderr?.on('data', onChunk);
    child.stdout?.on('data', onChunk);
    child.on('exit', (code, signal) => {
      finish(new Error(`browser exited early (code=${code ?? ''} signal=${signal ?? ''})${out ? `: ${out.slice(-400).replace(/\s+/g, ' ')}` : ''}`));
    });
    child.on('error', (err) => finish(new Error(`browser spawn failed: ${err.message}`)));
  });
  const port = Number(wsUrl.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
  return { child, wsUrl, port, args, ...(noSandbox ? { sandboxNote: 'pending' } : {}) };
}

// ---------------------------------------------------------------------------
// Manager (process + connection + pages)

export interface CdpManagerOptions {
  workspaceDir: string;
  /** Named-profile dir under Mochi's state dir (profiles.ts resolves it). */
  profileDir: string;
  executablePath?: string;
  isHeadlessShell?: boolean;
  idleMs?: number;
  /** Pass through for tests. */
  allowNoSandbox?: boolean;
  /** Test seam: override the process launcher (a labelled test double keeps
   *  crash/restart semantics unit-testable without a real browser binary). */
  launchFn?: (opts: LaunchOptions) => Promise<LaunchResult>;
}

export type ManagerStatus = 'running' | 'crashed' | 'closed';

export class CdpBrowserManager {
  status: ManagerStatus = 'closed';
  /** Surfaced in tool results after a crash-restart (state loss is real). */
  restartNote: string | undefined;
  sandboxNote: string | undefined;
  binarySource: BinarySource = 'env';
  private child: ChildProcess | undefined;
  private client: CdpClient | undefined;
  private pages = new Map<string, CdpPage>();
  private activeTargetId: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleMs: number;
  private crashedDetail = '';
  private shuttingDown = false;

  constructor(private readonly opts: CdpManagerOptions) {
    this.idleMs = opts.idleMs ?? 10 * 60 * 1000;
  }

  /** Bring the browser up (or up again after a crash). */
  async connect(): Promise<CdpClient> {
    if (this.client && this.status === 'running') return this.client;
    if (this.status === 'crashed') {
      // ONE restart — this is the second launch after the crash. The old
      // profile dir SURVIVES (it is on disk); in-flight page state does not.
      this.restartNote =
        `browser crashed and was restarted — tabs/page state from before the crash were lost${this.crashedDetail ? ` (crash: ${this.crashedDetail})` : ''}`;
    }
    await this.launchAndConnect();
    return this.client as CdpClient;
  }

  private async launchAndConnect(): Promise<void> {
    // A test-double launcher also replaces binary resolution: the double IS
    // the browser under test.
    const launcher = this.opts.launchFn;
    const resolved = launcher
      ? { path: 'test-double', source: 'env' as BinarySource, isHeadlessShell: true }
      : resolveCdpBrowserBinary(this.opts.executablePath);
    this.binarySource = resolved.source;
    const launched = await (launcher ?? launchCdpBrowser)({
      executablePath: resolved.path,
      isHeadlessShell: resolved.isHeadlessShell,
      profileDir: this.opts.profileDir,
      ...(this.opts.allowNoSandbox !== undefined ? { allowNoSandbox: this.opts.allowNoSandbox } : {}),
    });
    if (launched.sandboxNote) this.sandboxNote = launched.sandboxNote;
    this.child = launched.child;
    this.status = 'running';
    this.crashedDetail = '';
    const client = new CdpClient({
      url: launched.wsUrl,
      onDisconnect: (err) => this.onDisconnect(err),
    });
    await client.ready;
    this.client = client;
    this.touch();
  }

  private onDisconnect(err: Error): void {
    if (this.status === 'closed' || this.shuttingDown) return;
    this.status = 'crashed';
    this.crashedDetail = err.message.slice(0, 200);
    this.pages.clear();
    this.activeTargetId = undefined;
  }

  /** Idle reap: shutdown after idleMs with no calls. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.shutdown('idle');
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** The page tool actions operate on: the active target, attached lazily. */
  async ensurePage(): Promise<CdpPage> {
    const client = await this.connect();
    if (this.activeTargetId) {
      const existing = this.pages.get(this.activeTargetId);
      if (existing?.alive) return existing;
    }
    // Pick a live page target (or open one on a fresh browser).
    const targets = await client.send('Target.getTargets', {}, { timeoutMs: 10_000 });
    const infos = (Array.isArray(targets.targetInfos) ? targets.targetInfos : []) as Array<{ targetId?: unknown; type?: unknown; url?: unknown }>;
    let info = infos.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
    if (!info) {
      const created = await client.send('Target.createTarget', { url: 'about:blank' }, { timeoutMs: 10_000 });
      info = { targetId: created.targetId, type: 'page' };
    }
    const targetId = String(info.targetId);
    const page = await CdpPage.attach(client, targetId);
    this.pages.set(targetId, page);
    this.activeTargetId = targetId;
    this.touch();
    return page;
  }

  /** List page targets (url/title). */
  async listPages(): Promise<Array<{ targetId: string; url: string; active: boolean }>> {
    const client = await this.connect();
    const targets = await client.send('Target.getTargets', {}, { timeoutMs: 10_000 });
    const infos = (Array.isArray(targets.targetInfos) ? targets.targetInfos : []) as Array<{ targetId?: unknown; type?: unknown; url?: unknown }>;
    return infos
      .filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
      .map((t) => ({
        targetId: String(t.targetId),
        url: String(t.url ?? ''),
        active: String(t.targetId) === this.activeTargetId,
      }));
  }

  /** Switch the active page by index in listPages() order (or target id). */
  async switchPage(indexOrId: string | number): Promise<{ targetId: string; url: string }> {
    const pages = await this.listPages();
    let pick: { targetId: string; url: string; active: boolean } | undefined;
    if (typeof indexOrId === 'number' || /^\d+$/.test(String(indexOrId))) {
      const idx = Number(indexOrId);
      pick = pages[idx];
      if (!pick) throw new Error(`no tab at index ${idx} (${pages.length} open)`);
    } else {
      pick = pages.find((p) => p.targetId === indexOrId);
      if (!pick) throw new Error(`no open tab with target id ${indexOrId}`);
    }
    this.activeTargetId = pick.targetId;
    this.touch();
    return pick;
  }

  /** Open a new page (tab), optionally navigated, and make it active. */
  async openPage(url?: string): Promise<CdpPage> {
    const client = await this.connect();
    const created = await client.send('Target.createTarget', { url: url ?? 'about:blank' }, { timeoutMs: 10_000 });
    const targetId = String(created.targetId);
    const page = await CdpPage.attach(client, targetId);
    this.pages.set(targetId, page);
    this.activeTargetId = targetId;
    this.touch();
    return page;
  }

  /** Close one page by index or target id; the LAST page closes the browser. */
  async closePage(indexOrId: string | number): Promise<{ closed: string; browserClosed: boolean }> {
    const pages = await this.listPages();
    let targetId: string;
    if (typeof indexOrId === 'number' || /^\d+$/.test(String(indexOrId))) {
      const idx = Number(indexOrId);
      const pick = pages[idx];
      if (!pick) throw new Error(`no tab at index ${idx} (${pages.length} open)`);
      targetId = pick.targetId;
    } else {
      targetId = indexOrId;
    }
    const page = this.pages.get(targetId);
    if (page) await page.close();
    else await (await this.connect()).send('Target.closeTarget', { targetId }, { timeoutMs: 10_000 }).catch(() => { /* gone */ });
    this.pages.delete(targetId);
    if (this.activeTargetId === targetId) this.activeTargetId = undefined;
    // Target destruction is asynchronous — poll until the target is actually
    // gone before deciding whether this was the last page.
    const deadline = Date.now() + 2000;
    let remaining = await this.listPages().catch(() => []);
    while (remaining.some((p) => p.targetId === targetId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      remaining = await this.listPages().catch(() => []);
    }
    // Closing the last page = closing the browser (a browser with no pages
    // is a zombie process tree — exactly what this stack exists to avoid).
    if (remaining.length === 0) {
      await this.shutdown('last page closed');
      return { closed: targetId, browserClosed: true };
    }
    this.touch();
    return { closed: targetId, browserClosed: false };
  }

  /** Shut the browser down (SIGTERM; the process reaps itself). */
  async shutdown(reason = 'closed'): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.status = 'closed';
    this.pages.clear();
    try { this.client?.close(); } catch { /* gone */ }
    this.client = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      // Bounded reaper: SIGKILL after 3s if it will not die.
      const force = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 3000);
      force.unref?.();
    }
    this.shuttingDown = false;
    this.restartNote = undefined;
    void reason;
  }
}

// ---------------------------------------------------------------------------
// Singleton registry (one browser per workspace+profile, like session.ts)

const SESSIONS = new Map<string, CdpBrowserManager>();

function keyFor(opts: CdpManagerOptions): string {
  return [resolve(opts.workspaceDir), resolve(opts.profileDir)].join('::');
}

/** Lazy singleton: get-or-create the manager for workspace+profile. */
export function getCdpSession(opts: CdpManagerOptions): CdpBrowserManager {
  const key = keyFor(opts);
  const existing = SESSIONS.get(key);
  if (existing && existing.status !== 'closed') return existing;
  if (existing) {
    void existing.shutdown('stale');
  }
  const manager = new CdpBrowserManager(opts);
  SESSIONS.set(key, manager);
  return manager;
}

/** Close every live CDP browser (agent shutdown / tests). */
export function closeAllCdpSessions(): void {
  for (const m of [...SESSIONS.values()]) {
    void m.shutdown('agent shutdown');
  }
  SESSIONS.clear();
}
