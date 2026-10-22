// Sandbox layer: backend builders, tier policy, env scrub (unit) and
// HERMETIC live escape tests against whichever OS backend this host
// actually has. The live tests gate on the capability probe: on a host
// with no OS backend they skip LOUDLY (console warning + RESULT.md), and
// the soft-jail tests take over — a skip here must never read as a pass
// for OS confinement that was never exercised.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { resolve, join } from 'node:path';
import {
  buildBubblewrapArgs,
  buildUnshareArgs,
  buildUnshareSetupScript,
  sensitivePaths,
  scrubEnv,
  wrapWithSandbox,
  probeSandboxCapabilities,
  resolveShellSandboxPolicy,
  resetSandboxProbeCache,
} from './sandbox.js';
import { runArgv, runShellString } from '../exec.js';
import { rmTmp } from '../testutil/rm-tmp.js';

const CANARY = 'CANARY-SECRET-DO-NOT-LEAK';

// Fixture layout — deliberately NOT under os.tmpdir(): the sandbox binds
// the process tmpdir writable (bwrap parity), so an "outside the
// workspace" target under /tmp would be inside a sanctioned writable and
// the escape assertion would prove nothing. The fixture root lives under
// this copy's cwd, which the sandbox sees read-only except the workspace
// subdir.
// Shared-host hygiene (integrator directive): TMPDIR is redirected into
// the fixture for the whole file, so every bind the backend performs
// during these tests targets THIS fixture's own tmp — never the shared
// /tmp the other agents use. Combined with the backend's propagation
// privatisation (--propagation private + make-rprivate first), the test
// mounts cannot leak into the parent namespace or mask shared paths.
let root: string;
let workspace: string;
let fakeHome: string;
let prevTmpdir: string | undefined;
beforeAll(() => {
  root = mkdtempSync(resolve(process.cwd(), 'mochi-sbx-test-'));
  workspace = join(root, 'ws');
  fakeHome = join(root, 'home');
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
  writeFileSync(join(fakeHome, '.ssh', 'id_rsa'), CANARY);
  mkdirSync(workspace, { recursive: true });
  const fixtureTmp = join(root, 'tmp');
  mkdirSync(fixtureTmp, { recursive: true });
  prevTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = fixtureTmp;
});
afterAll(() => {
  if (prevTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmpdir;
  rmTmp(root);
});

const sandboxOpts = (network: boolean) => ({
  mode: 'auto' as const,
  network,
  workspaceDir: workspace,
  envScrub: true,
});
const fixtureEnv = () => ({ ...process.env, HOME: fakeHome });

describe('sensitivePaths + scrubEnv (unit)', () => {
  it('finds existing credential dirs/files only', () => {
    const s = sensitivePaths(fakeHome);
    expect(s.dirs).toContain(join(fakeHome, '.ssh'));
    expect(s.dirs).not.toContain(join(fakeHome, '.aws')); // does not exist here
  });

  it('scrubs secret-bearing vars, keeps identifiers and harness vars', () => {
    const { env, removed } = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      OPENAI_API_KEY: 'sk-x',
      AWS_SECRET_ACCESS_KEY: 's',
      AWS_SESSION_TOKEN: 't',
      AWS_ACCESS_KEY_ID: 'AKID',
      AWS_REGION: 'us-east-1',
      GH_TOKEN: 'g',
      GOOGLE_APPLICATION_CREDENTIALS: '/keys.json',
      MOCHI_CWD: '/ws',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKID'); // identifier, not a secret
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.MOCHI_CWD).toBe('/ws');
    expect(removed).toContain('OPENAI_API_KEY');
  });
});

describe('backend argv builders (unit)', () => {
  it('bubblewrap: masks credentials AFTER the writable binds, dies with parent', () => {
    const argv = buildBubblewrapArgs('/usr/bin/bwrap', 'npm', ['test'], { cwd: workspace, home: fakeHome });
    expect(argv[0]).toBe('/usr/bin/bwrap');
    expect(argv).toContain('--die-with-parent');
    const sshMask = argv.indexOf(join(fakeHome, '.ssh'));
    expect(argv[sshMask - 1]).toBe('--tmpfs');
    const bindIdx = argv.indexOf('--bind');
    expect(sshMask).toBeGreaterThan(bindIdx); // mask wins over binds
    expect(argv.slice(-2)).toEqual(['npm', 'test']);
    expect(argv).not.toContain('--unshare-net');
    expect(buildBubblewrapArgs('/usr/bin/bwrap', 'x', [], { cwd: workspace, network: false })).toContain('--unshare-net');
  });

  it('unshare: setup script sweeps ALL mounts read-only with a fail-closed verify, masks credentials, execs last', () => {
    const script = buildUnshareSetupScript({
      cwd: workspace,
      writable: [workspace],
      sensitive: { dirs: [join(fakeHome, '.ssh')], files: [] },
    });
    const bindIdx = script.indexOf(`mount --bind '${workspace}'`);
    const maskIdx = script.indexOf(`mount -t tmpfs tmpfs '${join(fakeHome, '.ssh')}'`);
    expect(bindIdx).toBeGreaterThan(-1);
    expect(maskIdx).toBeGreaterThan(bindIdx); // masks land after the writable binds
    // The sweep + verify are what make confinement real on multi-mount
    // hosts (a lone `remount,bind,ro /` leaves e.g. a btrfs $HOME rw).
    expect(script).toContain('remount,bind,ro "$sbx_mp"');
    expect(script).toContain('could not be made read-only');
    expect(script).toContain('exit 126');
    // The mount table travels in a shell variable, NEVER a scratch file:
    // a scratch write made every sandboxed command hostage to workspace
    // writability (observed failing under a host EPERM window).
    expect(script).toContain('SBX_MOUNTS=$(awk');
    expect(script).not.toContain('.mochi-sbx-mounts.tmp');
    // /tmp tmpfs stacking: with the workspace + mask target under /tmp,
    // the script must NOT cover /tmp (it would hide both — observed live
    // as "mount point does not exist"); with nothing under /tmp, it must
    // (private tmp). The mask line for the under-/tmp home does not
    // false-positive the substring: it is quoted ('/tmp/...').
    const scriptUnderTmp = buildUnshareSetupScript({
      cwd: '/tmp/x/ws',
      writable: ['/tmp/x/ws'],
      sensitive: { dirs: ['/tmp/x/home/.ssh'], files: [] },
    });
    expect(scriptUnderTmp).not.toContain('mount -t tmpfs tmpfs /tmp');
    const scriptElsewhere = buildUnshareSetupScript({
      cwd: '/var/work/proj',
      writable: ['/var/work/proj'],
      sensitive: { dirs: [], files: [] },
    });
    expect(scriptElsewhere).toContain('mount -t tmpfs tmpfs /tmp');
    expect(script.trimEnd().endsWith('exec "$@"')).toBe(true);
    expect(script).toContain('mount --make-rprivate /');

    const argv = buildUnshareArgs('/usr/bin/unshare', 'echo', ['hi'], { cwd: workspace, home: fakeHome, network: false });
    expect(argv).toContain('--net'); // network off => net namespace
    expect(argv).toContain('--map-root-user');
    expect(argv.slice(-2)).toEqual(['echo', 'hi']);
    // Propagation privatisation at namespace creation (hazard fix): the
    // flag pair appears iff the probe found it supported.
    const argvProp = buildUnshareArgs('/usr/bin/unshare', 'echo', [], { cwd: workspace, home: fakeHome, propagation: true });
    const pi = argvProp.indexOf('--propagation');
    expect(pi).toBeGreaterThan(-1);
    expect(argvProp[pi + 1]).toBe('private');
    expect(argv).not.toContain('--propagation');
    const argvNet = buildUnshareArgs('/usr/bin/unshare', 'echo', [], { cwd: workspace, home: fakeHome });
    expect(argvNet).not.toContain('--net');
  });
});

describe('tier policy resolution (unit)', () => {
  const base = { workspaceDir: workspace };
  it('safe/ask/auto tiers engage auto sandbox, network OFF, scrub ON', () => {
    for (const safetyMode of ['safe', 'ask', 'auto']) {
      const p = resolveShellSandboxPolicy({ ...base, safetyMode });
      expect(p.mode).toBe('auto');
      expect(p.network).toBe(false);
      expect(p.envScrub).toBe(true);
    }
  });
  it('uncensored leaves the sandbox off unless the operator configured it', () => {
    expect(resolveShellSandboxPolicy({ ...base, safetyMode: 'uncensored' }).mode).toBe('off');
    const p = resolveShellSandboxPolicy({ ...base, safetyMode: 'uncensored', configMode: 'auto' });
    expect(p.mode).toBe('auto');
    expect(p.envScrub).toBe(false);
  });
  it('explicit config beats the tier default; network only via the config knob', () => {
    expect(resolveShellSandboxPolicy({ ...base, safetyMode: 'safe', configMode: 'off' }).mode).toBe('off');
    expect(resolveShellSandboxPolicy({ ...base, safetyMode: 'safe', configNetwork: true }).network).toBe(true);
  });
});

describe('capability probe honesty (unit)', () => {
  it('empty PATH => SOFT jail, landlock named as unavailable with a reason', () => {
    const caps = probeSandboxCapabilities('');
    expect(caps.autoBackend).toBe('soft');
    expect(caps.autoLevel).toBe('soft');
    expect(caps.summary).toMatch(/SOFT/);
    expect(caps.landlock.available).toBe(false);
    expect(caps.landlock.reason.length).toBeGreaterThan(20);
  });

  it('forced modes throw loudly when their backend is absent', () => {
    expect(() => wrapWithSandbox('echo', [], {
      mode: 'bubblewrap', pathEnv: '/nonexistent-dir-xyz', policy: { workspaceDir: workspace },
    })).toThrow(/bwrap.*not found/);
    expect(() => wrapWithSandbox('echo', [], {
      mode: 'unshare', pathEnv: '/nonexistent-dir-xyz', policy: { workspaceDir: workspace },
    })).toThrow(/unshare.*not found|namespaces are disabled/);
  });

  it('soft fallback: env scrubbed, cwd clamped into the workspace', () => {
    const w = wrapWithSandbox('env', [], {
      mode: 'auto',
      pathEnv: '/nonexistent-dir-xyz',
      cwd: root, // outside the workspace
      env: { ...process.env, PLANTED_API_KEY: 'shh' },
      policy: { workspaceDir: workspace },
    });
    expect(w.level).toBe('soft');
    expect(w.backend).toBe('soft');
    expect(w.env?.PLANTED_API_KEY).toBeUndefined();
    expect(w.env?.PATH).toBeDefined();
    expect(w.cwd).toBe(workspace);
  });
});

// ---------------------------------------------------------------------------
// Live escape tests — gated on a real OS backend.
// ---------------------------------------------------------------------------
const caps = probeSandboxCapabilities();
if (caps.autoLevel !== 'os') {
  console.warn(`[sandbox.test] NO OS SANDBOX BACKEND on this host (probe: ${caps.summary}) — live escape tests SKIPPED, soft-jail tests above are the only coverage here.`);
}
const osIt = caps.autoLevel === 'os' ? it : it.skip;

describe(`live sandbox escapes (backend: ${caps.autoBackend})`, () => {
  osIt('write INSIDE the workspace works; normal commands run', async () => {
    const r = await runShellString(`"${process.execPath}" -e "require('fs').writeFileSync('out.txt','ok')" && cat out.txt`, {
      cwd: workspace, env: fixtureEnv(), sandbox: sandboxOpts(false), timeoutMs: 30_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.sandboxLevel).toBe('os');
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('ok');
  }, 60_000);

  osIt('write OUTSIDE the workspace FAILS (read-only root)', async () => {
    const target = join(fakeHome, 'evil.txt');
    const r = await runArgv('touch', [target], {
      cwd: workspace, env: fixtureEnv(), sandbox: sandboxOpts(false), timeoutMs: 30_000,
    });
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  osIt('credential canary in $HOME/.ssh is NOT readable', async () => {
    const r = await runShellString('cat "$HOME/.ssh/id_rsa" 2>&1; echo "rc=$?"', {
      cwd: workspace, env: fixtureEnv(), sandbox: sandboxOpts(false), timeoutMs: 30_000,
    });
    expect(r.stdout).not.toContain(CANARY);
    expect(r.stdout).toContain('rc=1'); // masked: the file simply is not there
    // And nothing the sandboxed process wrote into .ssh persists outside.
    expect(readFileSync(join(fakeHome, '.ssh', 'id_rsa'), 'utf8')).toBe(CANARY);
  }, 60_000);

  osIt('secret env vars are scrubbed even on the OS backend', async () => {
    const r = await runShellString('echo "secret=[$PLANTED_API_KEY]"', {
      cwd: workspace,
      env: { ...fixtureEnv(), PLANTED_API_KEY: 'shh-do-not-pass' },
      sandbox: sandboxOpts(false),
      timeoutMs: 30_000,
    });
    expect(r.stdout).toContain('secret=[]');
    expect(r.stdout).not.toContain('shh-do-not-pass');
  }, 60_000);
});

describe('live sandbox network policy', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    // Swallow per-socket errors: a client that exits the instant it
    // connects (the network-on case) RSTs the server's write, which is an
    // unhandled 'error' on the socket — not a test failure.
    server = createServer((s) => { s.on('error', () => {}); s.end('hello'); });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server?.close());

  const clientScript = (p: number) =>
    `const net=require('net');const s=net.connect(${p},'127.0.0.1');` +
    `s.setTimeout(2500);s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});` +
    `s.on('timeout',()=>{console.log('FAILED');process.exit(0)});s.on('error',()=>{console.log('FAILED');process.exit(0)});`;

  osIt('TCP connect to a local listener FAILS with network off', async () => {
    const r = await runArgv(process.execPath, ['-e', clientScript(port)], {
      cwd: workspace, env: fixtureEnv(), sandbox: sandboxOpts(false), timeoutMs: 30_000,
    });
    expect(r.stdout).toContain('FAILED');
    expect(r.stdout).not.toContain('CONNECTED');
  }, 60_000);

  osIt('TCP connect SUCCEEDS when the policy allows network', async () => {
    const r = await runArgv(process.execPath, ['-e', clientScript(port)], {
      cwd: workspace, env: fixtureEnv(), sandbox: sandboxOpts(true), timeoutMs: 30_000,
    });
    expect(r.stdout).toContain('CONNECTED');
  }, 60_000);
});

describe('soft jail live behavior (no OS backend simulated via empty PATH)', () => {
  it('runShellString under auto+empty PATH: scrub applies, cwd clamps, result is labeled SOFT', async () => {
    const realPath = process.env.PATH;
    resetSandboxProbeCache();
    process.env.PATH = '';
    try {
      const r = await runShellString('pwd; echo "secret=[$PLANTED_API_KEY]"', {
        cwd: root, // outside the workspace: the soft jail must clamp it
        env: { ...process.env, PLANTED_API_KEY: 'shh-soft' },
        sandbox: { mode: 'auto', network: false, workspaceDir: workspace, envScrub: true },
        timeoutMs: 30_000,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(workspace); // pwd == clamped cwd
      expect(r.stdout).toContain('secret=[]');
      expect(r.sandboxLevel).toBe('soft');
      expect(r.sandboxBackend).toBe('soft');
    } finally {
      process.env.PATH = realPath;
      resetSandboxProbeCache();
    }
  }, 60_000);
});
