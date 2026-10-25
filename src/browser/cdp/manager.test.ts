import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  CdpBrowserManager,
  buildCdpArgs,
  buildLightpandaArgs,
  cdpCacheRoot,
  cdpEndpointFromLog,
  cachedShellInstalls,
  getCdpSession,
  launchCdpBrowser,
  lightpandaAssetKey,
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

// ---------------------------------------------------------------------------
// Lightpanda: the OPT-IN second engine. Same lifecycle rules, different
// argv + endpoint format, and a HARD single-page scope (tabs refuse — they
// are never faked into a degraded multi-page story).

describe('lightpanda engine — argv shape (pure)', () => {
  it('is a CDP server invocation: serve + port, no chromium flags', () => {
    expect(buildLightpandaArgs({})).toEqual(['serve', '--port', '0']);
    expect(buildLightpandaArgs({ port: 9333 })).toEqual(['serve', '--port', '9333']);
    const args = buildLightpandaArgs({});
    expect(args).not.toContain('--headless=new');
    expect(args.join(' ')).not.toMatch(/--user-data-dir/);
    expect(args.join(' ')).not.toMatch(/sandbox/);
  });

  it('asset key covers the upstream matrix and refuses win32 with the gap named', () => {
    expect(lightpandaAssetKey('linux', 'x64')).toBe('x86_64-linux');
    expect(lightpandaAssetKey('linux', 'arm64')).toBe('aarch64-linux');
    expect(lightpandaAssetKey('darwin', 'arm64')).toBe('aarch64-macos');
    expect(lightpandaAssetKey('darwin', 'x64')).toBe('x86_64-macos');
    expect(() => lightpandaAssetKey('win32', 'x64')).toThrow(/win32.*no prebuilt Lightpanda|no prebuilt Lightpanda.*win32/i);
  });
});

describe('cdpEndpointFromLog — per-engine endpoint parsing (pure)', () => {
  it('parses the chromium DevTools line', () => {
    const line = '[123:456] DevTools listening on ws://127.0.0.1:9222/devtools/browser/x';
    expect(cdpEndpointFromLog('chromium', line)).toBe('ws://127.0.0.1:9222/devtools/browser/x');
  });

  it('parses the lightpanda logfmt note line and roots the ws url', () => {
    const line = '$time=1792854929945 $scope=app $level=note $msg="server running" address=127.0.0.1:40709';
    expect(cdpEndpointFromLog('lightpanda', line)).toBe('ws://127.0.0.1:40709/');
  });

  it('returns undefined while the endpoint has not appeared', () => {
    expect(cdpEndpointFromLog('chromium', 'starting up…')).toBeUndefined();
    expect(cdpEndpointFromLog('lightpanda', 'starting up…')).toBeUndefined();
  });
});

describe('lightpanda engine — binary resolution', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mochi-cdp-lp-res-'));
  const envBin = join(tmp, 'lp-env');
  const envChromeBin = join(tmp, 'chrome-env');
  const cacheBin = join(tmp, 'cache', 'lightpanda-0.3.7', 'lightpanda');
  for (const p of [envBin, envChromeBin, cacheBin]) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('MOCHI_CDP_LIGHTPANDA wins, then the pinned cache install; both carry engine=lightpanda', () => {
    withEnv({ MOCHI_CDP_LIGHTPANDA: envBin, MOCHI_CDP_CACHE_DIR: join(tmp, 'cache') }, () => {
      expect(resolveCdpBrowserBinary(undefined, 'lightpanda')).toMatchObject({ path: envBin, source: 'env', engine: 'lightpanda' });
    });
    withEnv({ MOCHI_CDP_LIGHTPANDA: undefined, MOCHI_CDP_CACHE_DIR: join(tmp, 'cache') }, () => {
      expect(resolveCdpBrowserBinary(undefined, 'lightpanda')).toMatchObject({ path: cacheBin, source: 'cache', engine: 'lightpanda' });
    });
  });

  it('names the explicit fetch step when nothing is installed', () => {
    withEnv({ MOCHI_CDP_LIGHTPANDA: undefined, MOCHI_CDP_CACHE_DIR: join(tmp, 'empty') }, () => {
      expect(() => resolveCdpBrowserBinary(undefined, 'lightpanda')).toThrow(/fetch-lightpanda/);
    });
  });

  it('the chromium chain is untouched by the lightpanda branch', () => {
    withEnv({ MOCHI_CDP_LIGHTPANDA: envBin, MOCHI_CDP_BROWSER: envChromeBin, MOCHI_CDP_CACHE_DIR: join(tmp, 'cache') }, () => {
      // engine defaults to chromium: the lightpanda env var must NOT leak in
      const r = resolveCdpBrowserBinary();
      expect(r.engine).toBe('chromium');
      expect(r.path).toBe(envChromeBin);
    });
  });
});

describe('launchCdpBrowser — lightpanda endpoint from its own log line', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mochi-cdp-lp-launch-'));
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  const fakeLightpanda = (): string => {
    const p = join(tmp, 'fake-lightpanda');
    writeFileSync(p, [
      '#!/bin/sh',
      'echo \'$time=0 $scope=app $level=note $msg="server running" address=127.0.0.1:9444\' >&2',
      'sleep 60',
    ].join('\n'));
    chmodSync(p, 0o755);
    return p;
  };

  it('spawns `serve --port 0` and resolves the ws url from the address= log', async () => {
    const res = await launchCdpBrowser({ engine: 'lightpanda', executablePath: fakeLightpanda(), profileDir: tmp, endpointTimeoutMs: 4000 });
    expect(res.wsUrl).toBe('ws://127.0.0.1:9444/');
    expect(res.args).toEqual(['serve', '--port', '0']);
    expect(res.sandboxNote).toBeUndefined(); // no sandbox fallback exists for lightpanda
    res.child.kill('SIGTERM');
  });
});

describe('lightpanda engine — single-page scope in the manager', () => {
  const endpoints: FakeCdpEndpoint[] = [];
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
        default:
          reply({});
      }
    };
    endpoints.push(endpoint);
    return endpoint.listen().then(() => endpoint);
  }

  function manager(endpointUrl: string, engine: 'chromium' | 'lightpanda'): CdpBrowserManager {
    return new CdpBrowserManager({
      workspaceDir: '/tmp',
      profileDir: '/tmp/profile',
      engine,
      idleMs: 60_000,
      launchFn: async (): Promise<LaunchResult> =>
        ({ child: { kill: (): void => {}, killed: false, exitCode: null } as never, wsUrl: endpointUrl, port: 0, args: [] }),
    });
  }

  it('open/switch tabs refuse with the labeled single-page limit; close shuts down', async () => {
    const endpoint = await makeEndpoint();
    const m = manager(endpoint.url ?? 'ws://unset', 'lightpanda');
    // single-page lifecycle works end to end
    const page = await m.ensurePage();
    expect(page.sessionId).toBe('s1');
    await expect(m.openPage('http://x/')).rejects.toThrow(/ONE page per process/);
    await expect(m.switchPage(0)).rejects.toThrow(/ONE page per process/);
    const res = await m.closePage(page.targetId);
    expect(res).toEqual({ closed: page.targetId, browserClosed: true });
    expect(m.status).toBe('closed');
  });

  it('the same workspace+profile gets DIFFERENT sessions per engine', () => {
    const a = getCdpSession({ workspaceDir: '/tmp/lp-key-ws', profileDir: '/tmp/lp-key-p', engine: 'chromium' });
    const b = getCdpSession({ workspaceDir: '/tmp/lp-key-ws', profileDir: '/tmp/lp-key-p', engine: 'lightpanda' });
    expect(b).not.toBe(a);
    expect(b.engine).toBe('lightpanda');
    void a.shutdown('test');
    void b.shutdown('test');
  });
});
