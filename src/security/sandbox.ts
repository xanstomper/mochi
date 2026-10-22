// OS-level sandboxing for spawned commands — the backend + policy layer
// behind exec.ts's `sandbox` option and the shell tool's tier policy.
//
// Why this exists: Mochi historically had permission TIERS (prompts) plus a
// bubblewrap wrapper that (a) left $HOME credential dirs READABLE (ro-bind
// of / exposes ~/.ssh), (b) defaulted network ON, and (c) silently ran
// UNSANDBOXED in 'auto' mode when bwrap was missing. This module fixes all
// three: credential dirs are masked on every OS backend, the shell policy
// defaults network OFF, and 'auto' degrades to an explicitly-labeled SOFT
// jail (env scrub + cwd clamp) — never to a silent direct run.
//
// PROPAGATION HAZARD (read before touching mount code): mount events on
// SHARED-propagation mounts leak into the parent namespace and can mask
// paths or flip flags for unrelated processes on the host. Both namespace
// backends therefore privatise propagation BEFORE any mount happens —
// unshare gets `--propagation private` at namespace creation (no window
// between the namespace clone and the first shell command), the setup
// prelude's first operation is `mount --make-rprivate /`, and bwrap
// privatises by construction. Binds only ever target the workspace, the
// tmpdir, and dev-tool caches — never shared trees.
//
// Backends, in preference order:
//   1. bubblewrap (bwrap) — setuid-free userns sandbox, when on PATH.
//   2. unshare (util-linux) — user+mount+pid(+net) namespaces driven by a
//      setup prelude: same kernel primitives bwrap uses. Verified by a
//      live probe (the binary existing is not enough — unprivileged
//      userns can be disabled by sysctl/AppArmor).
//   3. soft jail — NOT OS confinement: secret-env scrub + cwd clamped to
//      the workspace. Labeled SOFT everywhere it surfaces (doctor, shell
//      result annotations, this file). It raises the cost of accidents; it
//      does not stop a determined command, and nothing may claim otherwise.
//   Landlock/seccomp: NOT implemented. Applying Landlock needs syscalls in
//   the child between fork and exec; Node's child_process cannot inject
//   them and the Rust native core exposes no pre-exec/confinement FFI (its
//   surface is budget/tokenizer/codegraph calls). A `mochi-sandbox-exec`
//   Rust helper is the designed path; it needs a Rust toolchain to build
//   and verify, which this change deliberately does not fake.
//
// Policy (resolveShellSandboxPolicy): permission tier -> sandbox posture.
//   safe / ask / auto tiers -> sandbox engaged ('auto'), network OFF,
//     credential reads masked, env scrubbed; explicit config wins.
//   uncensored (yolo)       -> sandbox off unless the operator configured
//     safety.sandbox explicitly; if engaged, network follows config.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, resolve, sep } from 'node:path';

export type SandboxBackendId = 'bubblewrap' | 'unshare' | 'soft';
export type SandboxLevel = 'os' | 'soft' | 'off';
export type SandboxMode = 'off' | 'auto' | 'bubblewrap' | 'unshare';

export interface SandboxPolicy {
  /** Primary writable root — the workspace the command is confined to. */
  workspaceDir: string;
  /** Extra writable paths beyond cwd + tmpdir + dev-tool caches. */
  writablePaths?: string[];
  /** Network access inside the sandbox. Policy default is OFF; the
   *  exec layer only isolates network when this is explicitly false on
   *  legacy call paths (see exec.ts SandboxOptions). */
  network?: boolean;
  /** Strip secret-looking variables from the child environment. */
  envScrub?: boolean;
  /** Home dir the credential paths derive from (test seam). Default: the
   *  child env's HOME when set, else the process home. */
  home?: string;
}

export interface WrappedCommand {
  cmd: string;
  args: string[];
  /** Environment override when the wrap transforms it (env scrub). When
   *  undefined the caller keeps its own env. */
  env?: NodeJS.ProcessEnv;
  /** Working-directory override (soft-jail cwd clamp). */
  cwd?: string;
  level: SandboxLevel;
  backend: SandboxBackendId | 'none';
}

// ---------------------------------------------------------------------------
// Binary detection (PATH search). Caches follow the detectBubblewrap
// discipline: an entry is only valid for the PATH it was computed from, so
// a test that mutates PATH to simulate a missing binary can never be
// poisoned by an earlier probe (see exec.ts's resetBubblewrapCache note).
// ---------------------------------------------------------------------------

function findOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const full = resolve(dir, name);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch { /* not here */ }
  }
  return null;
}

interface PathKeyedCache<T> { pathEnv: string; value: T }
let bwrapCache: PathKeyedCache<string | null> | undefined;
let unshareCache: PathKeyedCache<{ bin: string; killChild: boolean; propagation: boolean } | null> | undefined;

/** Test seam: forget cached probes (mirrors exec.ts resetBubblewrapCache). */
export function resetSandboxProbeCache(): void {
  bwrapCache = undefined;
  unshareCache = undefined;
}

/** Absolute path to `bwrap`, or null when unavailable. */
export function detectBubblewrapBin(pathEnv = process.env.PATH ?? ''): string | null {
  const current = process.env.PATH ?? '';
  if (pathEnv === current && bwrapCache && bwrapCache.pathEnv === pathEnv) return bwrapCache.value;
  const found = findOnPath('bwrap', pathEnv);
  if (pathEnv === current) bwrapCache = { pathEnv, value: found };
  return found;
}

/** Detect util-linux `unshare` AND verify unprivileged namespaces actually
 *  work (binary presence proves nothing: kernel.unprivileged_userns_clone
 *  or AppArmor can still forbid them). The probe runs a real namespace
 *  entry with the full flag set the backend uses. Returns the binary plus
 *  whether --kill-child is supported, or null. */
export function detectUnshare(pathEnv = process.env.PATH ?? ''): { bin: string; killChild: boolean; propagation: boolean } | null {
  const current = process.env.PATH ?? '';
  if (pathEnv === current && unshareCache && unshareCache.pathEnv === pathEnv) return unshareCache.value;
  let value: { bin: string; killChild: boolean; propagation: boolean } | null = null;
  const bin = findOnPath('unshare', pathEnv);
  if (bin) {
    const probe = (extra: string[]) => {
      try {
        const r = spawnSync(bin, ['--user', '--map-root-user', '--mount', '--pid', '--fork', ...extra, 'true'], {
          timeout: 5_000,
          stdio: 'ignore',
        });
        return r.status === 0;
      } catch { return false; }
    };
    if (probe([])) {
      value = {
        bin,
        killChild: probe(['--kill-child']),
        // --propagation private privatises the new namespace's mounts at
        // creation (see the hazard note at the top of this file). Probed
        // separately: older util-linux lacks the flag, and the prelude's
        // make-rprivate is the fallback, not a silent difference.
        propagation: probe(['--propagation', 'private']),
      };
    }
  }
  if (pathEnv === current) unshareCache = { pathEnv, value };
  return value;
}

// ---------------------------------------------------------------------------
// Credential paths + writable defaults
// ---------------------------------------------------------------------------

/** Credential locations masked (made unreadable) inside every OS sandbox:
 *  directories are covered with an empty tmpfs; files are bound to
 *  /dev/null. Only paths that EXIST are returned — masking a nonexistent
 *  path would fail the mount, and a nonexistent path leaks nothing. */
export function sensitivePaths(home: string): { dirs: string[]; files: string[] } {
  const dirs = ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.azure', '.docker', '.kube']
    .map((d) => resolve(home, d))
    .filter((p) => existsSync(p));
  const files = ['.netrc', '.git-credentials']
    .map((f) => resolve(home, f))
    .filter((p) => existsSync(p));
  return { dirs, files };
}

/** Default writable locations inside an OS sandbox: the task cwd, the OS
 *  tmpdir, and the dev-tool caches npm/cargo/pip need to function. The rest
 *  of the filesystem (including $HOME dotfiles and SSH keys) is read-only
 *  or masked; /tmp gets a fresh private tmpfs unless the real tmpdir is in
 *  this list (the unshare backend reproduces the bwrap argv semantics). */
export function defaultSandboxWritable(cwd: string, home: string): string[] {
  const out = [cwd, tmpdir()];
  for (const d of ['.npm', '.cache', '.cargo']) {
    const p = resolve(home, d);
    try {
      accessSync(p, constants.R_OK);
      out.push(p);
    } catch { /* cache dir absent: skip rather than create it inside the sandbox */ }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Environment scrub (soft jail + defense-in-depth on OS backends)
// ---------------------------------------------------------------------------

/** Names that carry secret VALUES (as opposed to identifiers/regions).
 *  Deliberately suffix/keyword based: AWS_ACCESS_KEY_ID is an identifier
 *  and survives (aws CLI still knows WHO it is; it just has no secret to
 *  sign with), while *_SECRET_ACCESS_KEY / *_SESSION_TOKEN do not. */
const SECRET_ENV_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|API_?KEY|AUTH_KEY)/i;

/** Return a copy of `env` with secret-bearing variables removed, plus the
 *  list of removed names (for audit/doctor reporting — names only, never
 *  values). */
export function scrubEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(k)) removed.push(k);
    else out[k] = v;
  }
  return { env: out, removed };
}

// ---------------------------------------------------------------------------
// Bubblewrap backend
// ---------------------------------------------------------------------------

/** Pure argv builder: wrap [cmd, ...args] in a bubblewrap invocation.
 *  Read-only root; writable cwd/tmp/caches (+ policy extras); credential
 *  dirs masked with empty tmpfs and credential files bound to /dev/null —
 *  the pre-existing builder left ALL of $HOME readable, which is why a
 *  "sandboxed" command could previously read ~/.ssh. Order matters:
 *  masks are applied AFTER the writable binds so a mask always wins over
 *  a bind (e.g. when the workspace IS $HOME, ~/.ssh is still masked). */
export function buildBubblewrapArgs(
  bwrapBin: string,
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; network?: boolean; writablePaths?: string[]; home?: string } = {},
): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const argv: string[] = [
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];
  const writable = [...defaultSandboxWritable(cwd, home), ...(opts.writablePaths ?? [])];
  for (const p of new Set(writable)) {
    argv.push('--bind', p, p);
  }
  const sensitive = sensitivePaths(home);
  for (const d of sensitive.dirs) argv.push('--tmpfs', d);
  for (const f of sensitive.files) argv.push('--ro-bind', '/dev/null', f);
  if (opts.network === false) argv.push('--unshare-net');
  argv.push('--chdir', cwd, '--', cmd, ...args);
  return [bwrapBin, ...argv];
}

// ---------------------------------------------------------------------------
// unshare backend (util-linux namespaces)
// ---------------------------------------------------------------------------

/** Single-quote a path for safe embedding in the setup script. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Pseudo-filesystems exempt from the read-only sweep: they expose no
 *  ordinary file data to confine (proc/sysfs are kernel views already
 *  governed by their own permission models; device opens are exempt from
 *  mount read-only flags at the kernel level anyway). Everything else —
 *  including host tmpfs mounts like /dev/shm — is swept. */
const SWEEP_EXEMPT_FSTYPES = [
  'proc', 'sysfs', 'devpts', 'devtmpfs', 'cgroup', 'cgroup2', 'mqueue',
  'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl',
  'hugetlbfs', 'autofs', 'binfmt_misc', 'nsfs', 'ramfs', 'efivarfs',
];

/** Build the mount-setup script the unshare prelude runs (as mapped root,
 *  before exec'ing the real command):
 *    1. make / privately propagated — belt-and-braces with unshare's
 *       --propagation private at namespace creation; either alone closes
 *       the leak, both together leave no window at all
 *    2. bind every writable path onto itself and remount it rw (a bind of
 *       a not-yet-swept mount starts with the source mount's flags)
 *    3. sweep: remount EVERY other real filesystem read-only. Remounting
 *       only / is NOT enough — on hosts where $HOME or the workspace's
 *       parent is a separate mount (btrfs subvolume, overlay), that mount
 *       would stay writable and the "confinement" would be fiction. The
 *       first escape-test run on such a host caught exactly that.
 *    4. verify: re-read the mount table (top-of-stack entry per mount
 *       point); any swept mount still rw aborts the prelude (exit 126).
 *       Fail closed with evidence, never silently partially-sandboxed.
 *    5. fresh tmpfs on /tmp — only when nothing the sandbox still needs
 *       (cwd, writables, mask targets) lives under /tmp; covering it would
 *       hide them. When skipped, the sweep already made host /tmp ro.
 *    6. mask credential dirs (tmpfs) and files (/dev/null bind)
 *    7. best-effort fresh /proc for the new pid namespace
 *  `set -e` throughout: a failed step aborts before the command runs.
 *  Mount points containing spaces (escaped as \040 in /proc/self/mounts)
 *  can defeat the sweep's field parsing; the verify step then fails
 *  closed rather than letting it pass unnoticed. */
export function buildUnshareSetupScript(opts: {
  cwd: string;
  writable: string[];
  sensitive: { dirs: string[]; files: string[] };
}): string {
  // NB: the `/*` suffix must stay UNQUOTED — it is a case glob, not data.
  const writableCase = opts.writable.map((w) => `${shq(w)}|${shq(w)}/*`).join('|');
  // Mounts UNDER /proc or /sys inherit the exemption: container runtimes
  // plant locked tmpfs masks over individual /proc files (e.g.
  // /proc/sys/kernel/random/boot_id) that a child userns may not remount —
  // and their contents are kernel-governed, not file data to confine.
  const pseudoPrefixCase = `/proc|/proc/*|/sys|/sys/*`;
  // The mount table is captured into a shell VARIABLE (reversed: top of
  // stack first), never a scratch file. The first version wrote it to
  // <workspace>/.mochi-sbx-mounts.tmp — and a full-suite run during a
  // host-wide EPERM window showed the cost: the scratch write failed,
  // `set -e` aborted the prelude, and EVERY sandboxed command died with
  // it (awk: write failure / Operation not permitted). The sandbox
  // machinery must not depend on a writable filesystem to do its job.
  // Loops read the variable through a pipeline; the sweep tolerates
  // failures (`|| true` — the verify step is the judge), while a verify
  // `exit 126` inside the pipeline subshell propagates as the pipeline's
  // exit status and `set -e` aborts the prelude with it. An empty capture
  // (unreadable mount table) also aborts: fail closed, never vacuous.
  const capture =
    `SBX_MOUNTS=$(awk '{a[NR]=$0} END{for(i=NR;i>0;i--) print a[i]}' /proc/self/mounts)`;
  const captureGuard =
    `[ -n "$SBX_MOUNTS" ] || { echo 'mochi-sandbox: cannot read the mount table — refusing to run unsandboxed' >&2; exit 126; }`;
  const exemptCase = SWEEP_EXEMPT_FSTYPES.join('|');
  const lines: string[] = ['set -e', 'mount --make-rprivate /'];
  for (const w of opts.writable) {
    lines.push(`mount --bind ${shq(w)} ${shq(w)}`);
    lines.push(`mount -o remount,bind,rw ${shq(w)}`);
  }
  lines.push(capture, captureGuard);
  lines.push(
    `sbx_seen=' '`,
    `printf '%s\\n' "$SBX_MOUNTS" | while read -r sbx_src sbx_mp sbx_fstype sbx_opts sbx_rest; do`,
    `  case " $sbx_seen " in *" $sbx_mp "*) continue ;; esac`,
    `  sbx_seen="$sbx_seen$sbx_mp "`,
    `  case "$sbx_mp" in ${pseudoPrefixCase}) continue ;; esac`,
    `  case "$sbx_fstype" in ${exemptCase}) continue ;; esac`,
    `  case "$sbx_mp" in ${writableCase}) continue ;; esac`,
    `  mount -o remount,bind,ro "$sbx_mp" 2>/dev/null || true`,
    `done || true`,
    capture,
    captureGuard,
    `sbx_seen=' '`,
    `printf '%s\\n' "$SBX_MOUNTS" | while read -r sbx_src sbx_mp sbx_fstype sbx_opts sbx_rest; do`,
    `  case " $sbx_seen " in *" $sbx_mp "*) continue ;; esac`,
    `  sbx_seen="$sbx_seen$sbx_mp "`,
    `  case "$sbx_mp" in ${pseudoPrefixCase}) continue ;; esac`,
    `  case "$sbx_fstype" in ${exemptCase}) continue ;; esac`,
    `  case "$sbx_mp" in ${writableCase}) continue ;; esac`,
    `  case ",$sbx_opts," in *,ro,*) : ;; *) echo "mochi-sandbox: mount $sbx_mp ($sbx_fstype) could not be made read-only — refusing to run unsandboxed" >&2; exit 126 ;; esac`,
    `done`,
  );
  // Fresh tmpfs on /tmp ONLY when nothing the sandbox still needs lives
  // under it: stacking a tmpfs over /tmp hides every child mount point
  // beneath it — a workspace, mask target, or cwd under /tmp would
  // vanish (observed live: "mount point does not exist" for a credential
  // dir under /tmp). When skipped, the sweep has already remounted the
  // host /tmp read-only, so writes stay confined either way.
  const underTmp = (p: string) => p === '/tmp' || p.startsWith('/tmp/');
  const tmpNeeded = [opts.cwd, ...opts.writable, ...opts.sensitive.dirs, ...opts.sensitive.files].some(underTmp);
  if (!tmpNeeded) {
    lines.push('mount -t tmpfs tmpfs /tmp');
  }
  for (const d of opts.sensitive.dirs) {
    lines.push(`mount -t tmpfs tmpfs ${shq(d)}`);
  }
  for (const f of opts.sensitive.files) {
    lines.push(`mount --bind /dev/null ${shq(f)}`);
  }
  lines.push('mount -t proc proc /proc 2>/dev/null || true');
  lines.push(`cd ${shq(opts.cwd)}`);
  lines.push('exec "$@"');
  return lines.join('\n');
}

/** Pure argv builder: wrap [cmd, ...args] in an `unshare` invocation that
 *  enters user+mount+pid namespaces (plus a network namespace when network
 *  is off) and runs the setup script above before exec'ing the command. */
export function buildUnshareArgs(
  unshareBin: string,
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; network?: boolean; writablePaths?: string[]; home?: string; killChild?: boolean; propagation?: boolean } = {},
): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const writable = [...new Set([...defaultSandboxWritable(cwd, home), ...(opts.writablePaths ?? [])])]
    .filter((p) => existsSync(p));
  const script = buildUnshareSetupScript({ cwd, writable, sensitive: sensitivePaths(home) });
  const argv: string[] = ['--user', '--map-root-user', '--mount', '--pid', '--fork'];
  if (opts.propagation) argv.push('--propagation', 'private');
  if (opts.killChild) argv.push('--kill-child');
  if (opts.network === false) argv.push('--net');
  argv.push('--', '/bin/sh', '-c', script, 'mochi-sandbox', cmd, ...args);
  return [unshareBin, ...argv];
}

// ---------------------------------------------------------------------------
// The resolver: policy + mode -> wrapped command
// ---------------------------------------------------------------------------

function clampCwd(cwd: string, workspaceDir: string): string {
  const ws = resolve(workspaceDir);
  const c = resolve(cwd);
  return c === ws || c.startsWith(ws.endsWith(sep) ? ws : ws + sep) ? c : ws;
}

/** Wrap [cmd, args] per the requested mode and policy.
 *  - 'off'        : passthrough (level 'off').
 *  - 'bubblewrap' : bwrap or THROW (explicit request fails loudly).
 *  - 'unshare'    : unshare or THROW.
 *  - 'auto'       : bwrap, else unshare, else the SOFT jail (env scrub +
 *                   cwd clamp, level 'soft') — never a silent direct run. */
export function wrapWithSandbox(
  cmd: string,
  args: readonly string[],
  opts: {
    mode: SandboxMode;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    policy: SandboxPolicy;
    pathEnv?: string;
  },
): WrappedCommand {
  const { mode, policy } = opts;
  const cwd = opts.cwd ?? policy.workspaceDir;
  if (mode === 'off') return { cmd, args: [...args], level: 'off', backend: 'none' };

  const home = policy.home ?? opts.env?.HOME ?? homedir();
  const scrubbed = policy.envScrub ? scrubEnv(opts.env ?? process.env).env : undefined;

  const tryOs = (which: 'bubblewrap' | 'unshare'): WrappedCommand | null => {
    if (which === 'bubblewrap') {
      const bin = detectBubblewrapBin(opts.pathEnv);
      if (!bin) return null;
      const full = buildBubblewrapArgs(bin, cmd, args, {
        cwd,
        network: policy.network,
        writablePaths: policy.writablePaths,
        home,
      });
      return { cmd: full[0], args: full.slice(1), env: scrubbed, level: 'os', backend: 'bubblewrap' };
    }
    const found = detectUnshare(opts.pathEnv);
    if (!found) return null;
    const full = buildUnshareArgs(found.bin, cmd, args, {
      cwd,
      network: policy.network,
      writablePaths: policy.writablePaths,
      home,
      killChild: found.killChild,
      propagation: found.propagation,
    });
    return { cmd: full[0], args: full.slice(1), env: scrubbed, level: 'os', backend: 'unshare' };
  };

  if (mode === 'bubblewrap' || mode === 'unshare') {
    const w = tryOs(mode);
    if (!w) {
      // Explicit request, unavailable backend: fail loudly, never silently
      // run unsandboxed. (The bubblewrap wording is pinned by exec.test.ts.)
      throw new Error(
        mode === 'bubblewrap'
          ? 'Sandbox requested (bubblewrap) but `bwrap` was not found on PATH. Install bubblewrap or use sandbox mode "off".'
          : 'Sandbox requested (unshare) but `unshare` was not found on PATH or unprivileged namespaces are disabled on this host. Use sandbox mode "auto" or "off".',
      );
    }
    return w;
  }
  // auto
  return (
    tryOs('bubblewrap') ??
    tryOs('unshare') ?? {
      cmd,
      args: [...args],
      env: scrubEnv(opts.env ?? process.env).env, // the soft jail always scrubs
      cwd: clampCwd(cwd, policy.workspaceDir),
      level: 'soft',
      backend: 'soft',
    }
  );
}

// ---------------------------------------------------------------------------
// Capability probe (doctor / startup / shell policy)
// ---------------------------------------------------------------------------

export interface SandboxCapabilities {
  platform: NodeJS.Platform;
  bubblewrap: string | null;
  unshare: string | null;
  unshareKillChild: boolean;
  unsharePropagation: boolean;
  /** Landlock is not implemented — see the file header for why. The probe
   *  reports it as a named absence with a reason instead of omitting it,
   *  so doctor output never implies coverage that does not exist. */
  landlock: { available: false; reason: string };
  /** What sandbox mode 'auto' resolves to on this host. */
  autoBackend: SandboxBackendId;
  autoLevel: 'os' | 'soft';
  /** One-line human summary for doctor/startup surfaces. */
  summary: string;
}

let capsCache: PathKeyedCache<SandboxCapabilities> | undefined;

/** Probe the host's sandbox capabilities. Cached per PATH (same discipline
 *  as the binary detectors — a PATH mutation always re-probes). */
export function probeSandboxCapabilities(pathEnv = process.env.PATH ?? ''): SandboxCapabilities {
  const current = process.env.PATH ?? '';
  if (pathEnv === current && capsCache && capsCache.pathEnv === pathEnv) return capsCache.value;
  const bubblewrap = process.platform === 'win32' ? null : detectBubblewrapBin(pathEnv);
  const un = process.platform === 'win32' ? null : detectUnshare(pathEnv);
  const autoBackend: SandboxBackendId = bubblewrap ? 'bubblewrap' : un ? 'unshare' : 'soft';
  const autoLevel: 'os' | 'soft' = autoBackend === 'soft' ? 'soft' : 'os';
  const value: SandboxCapabilities = {
    platform: process.platform,
    bubblewrap,
    unshare: un?.bin ?? null,
    unshareKillChild: un?.killChild ?? false,
    unsharePropagation: un?.propagation ?? false,
    landlock: {
      available: false,
      reason:
        'no pre-exec confinement surface: Node child_process cannot apply Landlock/seccomp between fork and exec, ' +
        'and the Rust native core exposes no such FFI. Namespace backends (bubblewrap/unshare) provide the OS confinement today.',
    },
    autoBackend,
    autoLevel,
    summary:
      autoLevel === 'os'
        ? `${autoBackend} namespaces (OS level): writes confined to workspace, credential dirs masked, network per policy`
        : 'SOFT jail only (env scrub + cwd clamp) — NOT OS confinement: no bubblewrap/unshare backend available',
  };
  if (pathEnv === current) capsCache = { pathEnv, value };
  return value;
}

// ---------------------------------------------------------------------------
// Tier policy: permission tier -> sandbox posture for shell commands
// ---------------------------------------------------------------------------

export interface ShellSandboxPolicy {
  mode: SandboxMode;
  network: boolean;
  envScrub: boolean;
  writablePaths: string[];
  workspaceDir: string;
}

/** Resolve the shell tool's sandbox posture.
 *  Precedence: per-call arg (already folded into `configMode` by the
 *  caller) > explicit operator config (safety.sandbox) > tier default.
 *  Tier defaults: uncensored/yolo leaves the sandbox OFF (the operator
 *  opted out of guardrails wholesale); every other tier engages 'auto'
 *  with network OFF and env scrub ON. Network is only ever ON via the
 *  explicit safety.sandboxNetwork config knob — never by tier accident. */
export function resolveShellSandboxPolicy(input: {
  safetyMode?: string;
  configMode?: SandboxMode;
  configNetwork?: boolean;
  extraWritablePaths?: string[];
  workspaceDir: string;
}): ShellSandboxPolicy {
  const uncensored = input.safetyMode === 'uncensored';
  return {
    mode: input.configMode ?? (uncensored ? 'off' : 'auto'),
    network: input.configNetwork ?? false,
    envScrub: !uncensored,
    writablePaths: input.extraWritablePaths ?? [],
    workspaceDir: input.workspaceDir,
  };
}
