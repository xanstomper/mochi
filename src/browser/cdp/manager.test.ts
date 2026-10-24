import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  CdpBrowserManager,
  buildCdpArgs,
  cdpCacheRoot,
  cachedShellInstalls,
  launchCdpBrowser,
  resolveCdpBrowserBinary,
  type LaunchOptions,
  type LaunchResult,
} from './manager.js';
import { FakeCdpEndpoint } from '../../testutil/fake-cdp-endpoint.js';

// Unit tests for the manager: binary resolution order, the sandbox argument
// policy (a --no-sandbox launch is a labeled, explicitly-allowed decision —
// never a default), and crash detection + one restart with the state loss
// surfaced. A fake launcher + the fake CDP endpoint stand in for the real
// browser process; the real process is exercised by the integration suite.

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('resolveCdpBrowserBinary — resolution order', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mochi-cdp-mgr-'));
  const configBin = join(tmp, 'config-browser');
  const envBin = join(tmp, 'env-browser');
  const cacheBin = join(tmp, 'cache', 'chrome-headless-shell-156.0.8078.47', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  for (const p of [configBin, envBin, cacheBin]) {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('config path wins, then env, then the pinned cache install', () => {
    expect(resolveCdpBrowserBinary(configBin)).toMatchObject({ path: configBin, source: 'config' });
    withEnv({ MOCHI_CDP_BROWSER: envBin, MOCHI_CDP_CACHE_DIR: join(tmp, 'cache') }, () => {
      expect(resolveCdpBrowserBinary()).toMatchObject({ path: envBin, source: 'env' });
      expect(resolveCdpBrowserBinary(join(tmp, 'missing'))).toMatchObject({ path: envBin, source: 'env' });
    });
    withEnv({ MOCHI_CDP_BROWSER: undefined, MOCHI_CDP_CACHE_DIR: join(tmp, 'cache') }, () => {
      expect(resolveCdpBrowserBinary()).toMatchObject({ path: cacheBin, source: 'cache', isHeadlessShell: true });
    });
  });

  it('names the explicit fetch step when nothing is installed', () => {
    const hasSystem = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/brave-browser', '/usr/bin/brave'].some((p) => existsSync(p));
    withEnv({ MOCHI_CDP_BROWSER: undefined, MOCHI_CDP_CACHE_DIR: join(tmp, 'empty-cache') }, () => {
      if (hasSystem) {
        expect(resolveCdpBrowserBinary().source).toBe('system');
      } else {
        expect(() => resolveCdpBrowserBinary()).toThrow(/fetch-cdp-shell/);
      }
    });
  });
});

describe('buildCdpArgs — sandbox policy + launch shape', () => {
  it('never passes --no-sandbox by default, uses an ephemeral port, and isolates the profile', () => {
    const args = buildCdpArgs({ executablePath: '/x/chrome', profileDir: '/profiles/p' });
    expect(args).not.toContain('--no-sandbox');
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--user-data-dir=/profiles/p');
    expect(args).toContain('--headless=new'); // full chrome needs the flag
  });

  it('adds --no-sandbox ONLY when explicitly allowed, and skips --headless for the shell binary', () => {
    const shell = buildCdpArgs({ executablePath: '/x/chrome-headless-shell', isHeadlessShell: true, profileDir: '/p', noSandbox: true });
    expect(shell).toContain('--no-sandbox');
    expect(shell).not.toContain('--headless=new');
  });
});

describe('launchCdpBrowser — labeled sandbox fallback', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mochi-cdp-sandbox-'));
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  /** Shell "browser": with --no-sandbox it serves a DevTools line and stays
   *  alive; without it, it dies with the canonical sandbox failure. */
  const fakeBrowser = () => {
    const p = join(tmp, 'fake-browser');
    writeFileSync(p, [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = "--no-sandbox" ]; then',
      '    echo "DevTools listening on ws://127.0.0.1:9333/devtools/browser/fake-id"',
      '    sleep 60',
      '    exit 0',
      '  fi',
      'done',
      'echo "[12345:12345:ERROR:zygote_host_impl_linux.cc(100)] No usable sandbox! Update your kernel" >&2',
      'exit 1',
    ].join('\n'));
    chmodSync(p, 0o755);
    return p;
  };

  it('surfaces instructions when the sandbox cannot engage and the fallback is not allowed', async () => {
    await expect(launchCdpBrowser({ executablePath: fakeBrowser(), profileDir: tmp, endpointTimeoutMs: 3000 }))
      .rejects.toThrow(/MOCHI_CDP_ALLOW_NO_SANDBOX/);
  });

  it('relaunches with --no-sandbox ONLY when explicitly allowed — and labels it', async () => {
    const res = await launchCdpBrowser({ executablePath: fakeBrowser(), profileDir: tmp, endpointTimeoutMs: 3000, allowNoSandbox: true });
    expect(res.wsUrl).toContain('ws://127.0.0.1:9333');
    expect(res.sandboxNote).toMatch(/--no-sandbox/);
    expect(res.sandboxNote).toMatch(/NOT active/);
    expect(res.args).toContain('--no-sandbox');
    res.child.kill('SIGTERM');
  });
});

describe('CdpBrowserManager — pages, crash detection, one labeled restart', () => {
  const endpoints: FakeCdpEndpoint[] = [];
  const children: Array<{ kill: (sig?: string) => void; killed: boolean; exitCode: null }> = [];
  afterEach(async () => {
    for (const e of endpoints.splice(0)) await e.close();
  });

  function makeEndpoint(): Promise<FakeCdpEndpoint> {
    const endpoint = new FakeCdpEndpoint();
    endpoint.onMessage = (msg, reply) => {
      switch (msg.method) {
        case 'Target.getTargets':
          reply({ targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] });
          break;
        case 'Target.attachToTarget':
          reply({ sessionId: 's1' });
          break;
        case 'Target.createTarget':
          reply({ targetId: 't-new' });
          break;
        default:
          reply({}); // Page.enable / Runtime.enable / Network.enable / ...
      }
    };
    endpoints.push(endpoint);
    return endpoint.listen().then(() => endpoint);
  }

  function fakeChild(): { kill: (sig?: string) => void; killed: boolean; exitCode: null } {
    const c = { kill: (_sig?: string): void => { c.killed = true; }, killed: false, exitCode: null };
    children.push(c);
    return c;
  }

  function manager(endpointUrl: string, launches: Array<{ wsUrl?: string; failWith?: Error }>): CdpBrowserManager {
    let i = 0;
    return new CdpBrowserManager({
      workspaceDir: '/tmp',
      profileDir: '/tmp/profile',
      idleMs: 60_000,
      launchFn: async (): Promise<LaunchResult> => {
        const spec = launches[Math.min(i++, launches.length - 1)];
        if (spec.failWith) throw spec.failWith;
        return { child: fakeChild() as never, wsUrl: spec.wsUrl ?? endpointUrl, port: 0, args: [] };
      },
    });
  }

  it('attaches lazily, lists pages, and tracks the active target', async () => {
    const endpoint = await makeEndpoint();
    const m = manager(endpoint.url ?? 'ws://unset', [{}]);
    const page = await m.ensurePage();
    expect(page.sessionId).toBe('s1');
    const pages = await m.listPages();
    expect(pages).toEqual([{ targetId: 't1', url: 'about:blank', active: true }]);
    await m.shutdown('test');
    expect(children.every((c) => c.killed)).toBe(true);
  });

  it('detects a transport drop as a crash and relaunches ONCE with the state loss surfaced', async () => {
    const endpoint = await makeEndpoint();
    const m = manager(endpoint.url ?? 'ws://unset', [{}, {}]);
    await m.ensurePage();
    expect(m.status).toBe('running');

    // The browser dies: the socket drops without a close from our side.
    endpoint.destroySocket();
    await new Promise((r) => setTimeout(r, 20));
    expect(m.status).toBe('crashed');

    // The next call relaunches; the restart note names the lost state.
    await m.ensurePage();
    expect(m.status).toBe('running');
    expect(m.restartNote).toMatch(/crashed and was restarted/i);
    expect(m.restartNote).toMatch(/lost/i);

    // And the note stays surfaced in results until shutdown clears it.
    await m.shutdown('test');
    expect(m.restartNote).toBeUndefined();
  });

  it('shutdown is idempotent and reaps the idle browser', async () => {
    const endpoint = await makeEndpoint();
    const m = manager(endpoint.url ?? 'ws://unset', [{}]);
    await m.ensurePage();
    await m.shutdown('first');
    await m.shutdown('second'); // no throw
    expect(m.status).toBe('closed');
  });
});

describe('cache install discovery', () => {
  it('cdpCacheRoot honors the env override', () => {
    withEnv({ MOCHI_CDP_CACHE_DIR: '/tmp/custom-cdp-cache' }, () => {
      expect(cdpCacheRoot()).toBe('/tmp/custom-cdp-cache');
    });
  });

  it('lists only real installs, newest version first', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mochi-cdp-cache-'));
    try {
    const mk = (v: string): void => {
      const bin = join(tmp, `chrome-headless-shell-${v}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, '#!/bin/sh\n');
    };
    mkdirSync(join(tmp, 'chrome-headless-shell-155.0.0.0', 'chrome-headless-shell-linux64'), { recursive: true }); // no binary — not an install
    mk('156.0.8078.47');
    mk('154.0.0.0');
    withEnv({ MOCHI_CDP_CACHE_DIR: tmp }, () => {
      const found = cachedShellInstalls();
      expect(found).toHaveLength(2);
      expect(found[0]).toContain('156.0.8078.47');
    });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
