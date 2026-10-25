// Central command-execution policy: every child process mochi spawns for
// agent work flows through here (shell tool, verification, cron notify).
// Guarantees on every call: bounded wall-clock (SIGTERM then SIGKILL),
// bounded output (never OOMs the harness on firehose commands), argv-array
// API for shell-free execution, and an audit hook for risk logging.
// Long-lived processes (background tasks, daemons, PTY) keep their own
// lifecycle owners and are intentionally OUT of scope.
import { matchHardline } from './security/hardline.js';
import { wrapWithSandbox, type SandboxMode, type WrappedCommand } from './security/sandbox.js';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface SandboxOptions {
  /** 'off' (default) runs directly. 'bubblewrap'/'unshare' force that OS
   *  backend (throw when unavailable — an explicit request never degrades
   *  silently). 'auto' uses the best OS backend (bubblewrap, then unshare
   *  namespaces), else the SOFT jail (env scrub + cwd clamp, reported as
   *  level 'soft' — never a silent direct run). See security/sandbox.ts. */
  mode: SandboxMode;
  /** Allow network inside the sandbox. When false, OS backends isolate
   *  the network namespace. Undefined keeps each backend's historical
   *  default (shared network); the shell tool's tier policy always passes
   *  an explicit value (default OFF — see resolveShellSandboxPolicy). */
  network?: boolean;
  /** Extra read-write paths beyond cwd + tmpdir + devtool caches. */
  writablePaths?: string[];
  /** Workspace root the sandbox confines writes to. Default: the exec
   *  cwd. The soft jail clamps the cwd into this root. */
  workspaceDir?: string;
  /** Strip secret-looking variables from the child environment. */
  envScrub?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock budget. Default 120s. */
  timeoutMs?: number;
  /** Per-stream accumulation cap. Default 2MB. */
  maxOutput?: number;
  /** AbortSignal for caller cancellation (Ctrl+C, task abort). */
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL. Default 1500ms. */
  killGraceMs?: number;
  /** Per-exec CPU-time ceiling in seconds (RLIMIT_CPU). Opt-in; applied via
   *  `prlimit` (util-linux) on Linux — the whole child TREE inherits the
   *  rlimit. When prlimit is unavailable the result reports ceilings NOT
   *  applied (never silent). A limit kill is clean (process-tree SIGKILL
   *  sweep) and LABELED in the result (ceilings.ceilingHit) — see exec.test. */
  cpuLimitSeconds?: number;
  /** Per-exec address-space ceiling in MB (RLIMIT_AS). Same semantics as
   *  cpuLimitSeconds. */
  memoryLimitMb?: number;
  /** Called once with the outcome for audit/risk logging. Never throws. */
  onAudit?: (info: { cmd: string; code: number | null; timedOut: boolean; durationMs: number }) => void;
  /** OS-level sandbox (bubblewrap). Default off — opt in per call or via
   *  `safety.sandbox` for the shell tool. */
  sandbox?: SandboxOptions;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Resource ceilings requested for this exec and their outcome. Present
   *  only when at least one ceiling was requested. `applied: false` means
   *  the host cannot enforce them (no prlimit / not Linux) — callers must
   *  surface that, never let a requested ceiling silently vanish.
   *  `ceilingHit` names the ceiling that KILLED the child (SIGXCPU/SIGKILL
   *  under RLIMIT_CPU, or an allocation abort under RLIMIT_AS). */
  ceilings?: {
    cpuLimitSeconds?: number;
    memoryLimitMb?: number;
    applied: boolean;
    ceilingHit?: 'cpu' | 'memory';
  };
  /** Sandbox actually applied, when a sandbox was requested: level 'os'
   *  (real namespace confinement) or 'soft' (env scrub + cwd clamp ONLY —
   *  not OS confinement). Absent when no sandbox was requested. */
  sandboxLevel?: 'os' | 'soft';
  sandboxBackend?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 2_000_000;

/** Per-stream accumulation with keep-ends truncation. A firehose stream that
 *  overflows the cap keeps the HEAD half (startup context, first error) AND
 *  a rolling TAIL half (build/test failure summaries print at the END —
 *  head-only truncation made models re-run failed commands to see the tail),
 *  eliding the middle with a dropped-bytes marker. Bounded memory: the tail
 *  is re-trimmed per chunk; the stream is NOT destroyed on overflow, so the
 *  tail keeps arriving (timeouts still bound runaway children). */
interface StreamAcc {
  total: number;
  head: string;
  tail: string;
  truncated: boolean;
}

function newStreamAcc(): StreamAcc {
  return { total: 0, head: '', tail: '', truncated: false };
}

function pushStream(acc: StreamAcc, chunk: string, cap: number): void {
  acc.total += chunk.length;
  if (!acc.truncated) {
    acc.head += chunk;
    if (acc.head.length > cap) {
      acc.truncated = true;
      const keep = Math.max(0, Math.floor(cap / 2));
      acc.tail = acc.head.slice(keep);
      acc.head = acc.head.slice(0, keep);
      if (acc.tail.length > keep) acc.tail = acc.tail.slice(-keep);
    }
    return;
  }
  acc.tail += chunk;
  const keep = Math.max(0, Math.floor(cap / 2));
  if (acc.tail.length > keep) acc.tail = acc.tail.slice(-keep);
}

function streamText(acc: StreamAcc): string {
  if (!acc.truncated) return acc.head;
  const dropped = acc.total - acc.head.length - acc.tail.length;
  // The literal `[truncated]` anchor is part of the observable contract —
  // consumers (and tests) grep for it — so it stays intact with the detail
  // appended after it.
  return `${acc.head}\n... [truncated] (${dropped} bytes in the middle elided — output ends below) ...\n${acc.tail}`;
}

// ------------------------------------------------------------- ceilings -----
// W3-5 exec ceilings: per-exec CPU (RLIMIT_CPU) and address-space (RLIMIT_AS)
// limits, applied by prefixing the command with `prlimit` (util-linux) on
// Linux. The rlimits are INHERITED by the whole child tree, so a ceiling
// bounds descendants too. A limit kill is (a) CLEAN — finishSpawn sweeps the
// process group on a ceiling death — and (b) LABELED — the result carries
// `ceilings.ceilingHit` and the shell tool appends a visible label; output is
// never silently truncated by a ceiling.

interface CeilingRequest { cpuLimitSeconds?: number; memoryLimitMb?: number }

interface CeilingWrap {
  cmd: string;
  args: string[];
  /** false = the host cannot enforce ceilings (no prlimit / not Linux) —
   *  the result must say so (never silent). */
  applied: boolean;
}

let prlimitCache: { pathEnv: string; value: string | null } | undefined;

function detectPrlimit(): string | null {
  const pathEnv = process.env.PATH ?? '';
  if (prlimitCache && prlimitCache.pathEnv === pathEnv) return prlimitCache.value;
  let value: string | null = null;
  if (process.platform === 'linux') {
    for (const dir of pathEnv.split(':')) {
      if (!dir) continue;
      const candidate = `${dir}/prlimit`;
      try {
        if (existsSync(candidate)) { value = candidate; break; }
      } catch { /* unreadable PATH entry: skip */ }
    }
  }
  if (pathEnv === (process.env.PATH ?? '')) prlimitCache = { pathEnv, value };
  return value;
}

/** Test hook: forget the cached prlimit probe (PATH mutated in tests). */
export function _resetExecCeilingProbeForTests(): void {
  prlimitCache = undefined;
}

/** Prefix [cmd, args] with prlimit when ceilings are requested. Zero/negative
 *  ceilings are treated as absent (no wrap). */
function wrapWithCeilings(cmd: string, args: readonly string[], req: CeilingRequest): CeilingWrap {
  const cpu = req.cpuLimitSeconds && req.cpuLimitSeconds > 0 ? Math.floor(req.cpuLimitSeconds) : 0;
  const mem = req.memoryLimitMb && req.memoryLimitMb > 0 ? Math.floor(req.memoryLimitMb) : 0;
  if (!cpu && !mem) return { cmd, args: [...args], applied: false };
  const prlimit = detectPrlimit();
  if (!prlimit) return { cmd, args: [...args], applied: false };
  // prlimit's limit options take OPTIONAL arguments — only the `--opt=value`
  // form binds the value; `--opt value` makes value the COMMAND (measured:
  // "prlimit: failed to execute 10").
  const argv = [prlimit];
  if (cpu) argv.push(`--cpu=${cpu}`);
  if (mem) argv.push(`--as=${mem * 1024 * 1024}`);
  argv.push('--', cmd, ...args);
  return { cmd: argv[0], args: argv.slice(1), applied: true };
}

/** Attribute a child death to a requested ceiling. Evidence (pinned by
 *  exec.test.ts against prlimit 2.37.4):
 *  - RLIMIT_CPU with soft==hard: SIGKILL (shell exit 137); when the kernel
 *    sends SIGXCPU first (soft<hard configs), signal SIGXCPU.
 *  - RLIMIT_AS: allocation failures abort the runtime — SIGTRAP (V8 OOM,
 *    exit 133), SIGABRT (glibc, exit 134), SIGSEGV (exit 139), or a nonzero
 *    exit with an ENOMEM-flavored message.
 *  Our OWN kills are excluded: timeouts/cancels are flagged before this runs.
 *  With BOTH ceilings set, the signals disambiguate (RLIMIT_AS never
 *  produces SIGKILL/137 — malloc fails instead). */
function detectCeilingHit(
  code: number | null,
  signal: NodeJS.Signals | null | undefined,
  timedOut: boolean,
  cancelled: boolean,
  req: CeilingRequest,
): 'cpu' | 'memory' | undefined {
  if (timedOut || cancelled) return undefined; // our own kills, not the ceiling
  if (signal === 'SIGXCPU' && req.cpuLimitSeconds) return 'cpu';
  if ((code === 137 || signal === 'SIGKILL') && req.cpuLimitSeconds) return 'cpu';
  if (req.memoryLimitMb) {
    if (signal === 'SIGTRAP' || signal === 'SIGABRT' || signal === 'SIGSEGV') return 'memory';
    if (code === 133 || code === 134 || code === 139) return 'memory';
  }
  return undefined;
}

function finishSpawn(
  child: ReturnType<typeof spawn>,
  cmd: string,
  opts: ExecOptions,
  stdoutAcc: StreamAcc,
  stderrAcc: StreamAcc,
  startedAt: number,
  ceilings?: { cpuLimitSeconds?: number; memoryLimitMb?: number; applied: boolean },
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? 1500;
  const stdoutCap = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const stderrCap = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
  // MOCHI_EXEC_TRACE=1 logs every spawn and outcome — the ONLY way to see
  // WHICH command a hung run is stuck on (a hang prints start, never done).
  if (process.env.MOCHI_EXEC_TRACE === '1') {
    console.warn(`[exec] start :: ${cmd.slice(0, 160)}${opts.cwd ? ` (cwd=${opts.cwd})` : ''}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const done = (code: number | null, extra?: { timedOut?: boolean; cancelled?: boolean; signal?: NodeJS.Signals | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const durationMs = Date.now() - startedAt;
      // The `close` event usually wins the race after our SIGTERM (the child
      // is already dead), so the closure flags — not just `extra` — carry
      // the timeout/cancel truth.
      const wasTimedOut = extra?.timedOut ?? timedOut;
      const wasCancelled = extra?.cancelled ?? cancelled;
      // W3-5 exec ceilings: attribute a death caused by a requested rlimit.
      // Never silent — the result carries the label, callers surface it.
      const ceilingHit = ceilings?.applied
        ? detectCeilingHit(code, extra?.signal ?? null, wasTimedOut, wasCancelled, ceilings)
        : undefined;
      if (ceilingHit) {
        // Clean kill: the rlimit terminated (at least) the main process;
        // sweep the whole tree so no descendant outlives the ceiling.
        // (killTree is defined below; done() only ever runs after it exists.)
        killTree('SIGKILL');
      }
      if (process.env.MOCHI_EXEC_TRACE === '1') {
        console.warn(`[exec] done  :: ${Math.round(durationMs)}ms code=${code}${wasTimedOut ? ' TIMEOUT' : ''}${wasCancelled ? ' CANCELLED' : ''}${ceilingHit ? ` CEILING=${ceilingHit}` : ''} :: ${cmd.slice(0, 160)}`);
      }
      try {
        opts.onAudit?.({ cmd: cmd.slice(0, 200), code, timedOut: wasTimedOut, durationMs });
      } catch { /* audit must never break execution */ }
      resolve({
        stdout: streamText(stdoutAcc),
        stderr: streamText(stderrAcc),
        code,
        timedOut: wasTimedOut,
        cancelled: wasCancelled,
        durationMs,
        ...(ceilings ? { ceilings: { ...ceilings, ceilingHit } } : {}),
      });
    };
    // Kill the WHOLE process tree, not just the direct child. A shell command
    // like `npm test` is `sh -c …` -> npm -> node -> test runners; signalling
    // only the direct child on timeout left the descendants running (CPU/port
    // leaks, a "finished" run that still pins a core). On POSIX we spawned the
    // child as its own process-group leader (detached), so a negative pid
    // signals the entire group; on Windows taskkill /T walks the tree.
    const killTree = (sig: NodeJS.Signals) => {
      if (process.platform === 'win32') {
        if (child.pid) {
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            return;
          } catch { /* fall through to a direct kill */ }
        }
        try { child.kill(sig); } catch { /* already dead */ }
        return;
      }
      try {
        // Negative pid = the child's process group (it is the group leader).
        // Only while the child is STILL RUNNING: once it has exited, its pid
        // may already have been recycled, and a negative-pid kill would then
        // signal an unrelated process group (a sibling's, or — worst case —
        // the host's own). An exited child needs no signal at all.
        if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already dead */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      child.stdout?.destroy();
      child.stderr?.destroy();
      setTimeout(() => { if (!settled) { killTree('SIGKILL'); done(124, { timedOut: true }); } }, killGraceMs);
    }, timeoutMs);
    // `timer.unref?.()` so a runaway timer never holds the process open.
    (timer as unknown as { unref?: () => void }).unref?.();
    const onAbort = () => {
      cancelled = true;
      killTree('SIGTERM');
      child.stdout?.destroy();
      child.stderr?.destroy();
      setTimeout(() => { if (!settled) { killTree('SIGKILL'); done(130, { cancelled: true }); } }, 800);
    };
    // No caller ever feeds stdin (no stdin-input API exists): close it now so
    // an interactive child (cmd.exe without /C) hits EOF instead of blocking
    // on our open pipe until the timeout kills it.
    try { child.stdin?.end(); } catch { /* already closed */ }
    void timedOut; void cancelled;
    child.stdout?.on('data', (chunk) => {
      // Keep-ends accumulation: on overflow the head AND a rolling tail are
      // retained (build/test failure summaries print at the END — head-only
      // truncation hid them and made models re-run failed commands). The
      // stream stays open so the tail keeps arriving; memory is bounded by
      // the per-chunk re-trim in pushStream.
      pushStream(stdoutAcc, String(chunk), stdoutCap);
    });
    child.stderr?.on('data', (chunk) => {
      pushStream(stderrAcc, String(chunk), stderrCap);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, signal) => done(code, { signal }));
    // Already-aborted: run the abort path AFTER the listeners exist. The old
    // early-return skipped 'error'/'close' attachment — a spawn that fails
    // while already aborted (nonexistent cwd, deleted shell) then emitted
    // 'error' with NO listener: an unhandled 'error' event crashes the whole
    // process. Order guarantees the rejection is caught.
    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Ceiling wrap shared by runArgv/runShellString: sandbox first (the sandbox
 *  executable becomes the command), then prlimit around it — rlimits are
 *  inherited, so the sandboxed tree is bounded too. `info` is undefined when
 *  no ceiling was requested (result shape unchanged), else carries the
 *  request + whether the host could enforce it. */
function prepareCeilings(
  opts: ExecOptions,
  wrapped: WrappedCommand,
): { spawnCmd: string; spawnArgs: string[]; info?: { cpuLimitSeconds?: number; memoryLimitMb?: number; applied: boolean } } {
  const requested = (opts.cpuLimitSeconds ?? 0) > 0 || (opts.memoryLimitMb ?? 0) > 0;
  const wrap = wrapWithCeilings(wrapped.cmd, wrapped.args, opts);
  return {
    spawnCmd: wrap.cmd,
    spawnArgs: wrap.args,
    info: requested
      ? { cpuLimitSeconds: opts.cpuLimitSeconds, memoryLimitMb: opts.memoryLimitMb, applied: wrap.applied }
      : undefined,
  };
}

/** Run a command WITHOUT a shell: argv array only, no interpolation.
 *  Prefer this for every harness-internal invocation (git, probes, notify). */
export function runArgv(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const startedAt = Date.now();
  const wrapped = wrapForExec(cmd, args, opts);
  const ceilings = prepareCeilings(opts, wrapped);
  const child = spawn(ceilings.spawnCmd, ceilings.spawnArgs, {
    cwd: wrapped.cwd ?? opts.cwd,
    env: wrapped.env ?? opts.env ?? process.env,
    stdio: 'pipe',
    windowsHide: true,
    // POSIX: make the child a process-group leader so a timeout/cancel can
    // signal the entire tree (see killTree). No-op on Windows.
    detached: process.platform !== 'win32',
  });
  return withSandboxInfo(finishSpawn(child, [cmd, ...args].join(' '), opts, newStreamAcc(), newStreamAcc(), startedAt, ceilings.info), wrapped);
}

/** Run a shell string (`sh -c`-class) under policy. Reserved for the agent's
 *  `shell` tool and user-configured hooks (cron notify) where shell
 *  composition (pipes, redirects) is the feature. Harness internals must
 *  use runArgv instead. */
export function runShellString(command: string, opts: ExecOptions & { shellBin?: string } = {}): Promise<ExecResult> {
  // Hardline floor (security/hardline.ts): catastrophic commands are refused
  // here — the one function every shell-string execution flows through — so
  // no caller, policy, or mode (yolo included) can run them. Returned as a
  // 126 result (shell's "cannot execute") instead of a throw, matching this
  // function's result-envelope contract.
  const hardline = matchHardline(command);
  if (hardline) {
    return Promise.resolve({
      stdout: '',
      stderr: `Blocked by hardline safety floor (${hardline}): catastrophic commands are refused under every permission policy, including yolo/unattended. Command: ${command.slice(0, 200)}`,
      code: 126,
      timedOut: false,
      cancelled: false,
      durationMs: 0,
    });
  }
  const startedAt = Date.now();
  const isWin = process.platform === 'win32';
  const shellBin = opts.shellBin ?? (isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash'));
  // Windows: mirror Node's own shell:true recipe (child_process.js): cmd.exe
  // only understands `/`-prefixed switches, so the POSIX `-c` form leaves cmd
  // with no /C — it starts INTERACTIVELY, prints its banner, and blocks on
  // our never-closed stdin pipe until killed (every runShellString hung to
  // its timeout on win32). /d skips AutoRun, /s + outer quotes strip exactly
  // one quote pair and run the rest verbatim; windowsVerbatimArguments keeps
  // Node from re-quoting the already-quoted command.
  const shellArgs = isWin ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
  const wrapped = wrapForExec(shellBin, shellArgs, opts);
  const ceilings = prepareCeilings(opts, wrapped);
  const child = spawn(ceilings.spawnCmd, ceilings.spawnArgs, {
    cwd: wrapped.cwd ?? opts.cwd,
    env: wrapped.env ?? opts.env ?? process.env,
    stdio: 'pipe',
    windowsHide: true,
    // POSIX: own process group so timeout/cancel kills the whole tree.
    detached: process.platform !== 'win32',
    ...(isWin ? { windowsVerbatimArguments: true } : {}),
  });
  return withSandboxInfo(finishSpawn(child, command, opts, newStreamAcc(), newStreamAcc(), startedAt, ceilings.info), wrapped);
}

/** execFile-style convenience for short harness probes with a string result.
 *  Rejects on non-zero exit (like execFile with callback error). */
export function execArgvText(cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/** Sandbox machinery lives in security/sandbox.ts (backends: bubblewrap,
 *  unshare namespaces, soft jail; tier policy resolution). Re-exported here
 *  so existing importers (doctor, background-tasks, tests) keep their
 *  surface. NOTE: no win32 special-casing anywhere in the wrap path —
 *  bubblewrap/unshare are POSIX-only, so a forced request on Windows must
 *  throw the loud "not found" error instead of silently running
 *  unsandboxed; 'auto' on Windows resolves to the labeled SOFT jail. */
export {
  detectBubblewrapBin as detectBubblewrap,
  buildBubblewrapArgs,
  detectUnshare,
  buildUnshareArgs,
  probeSandboxCapabilities,
  resetSandboxProbeCache as resetBubblewrapCache,
} from './security/sandbox.js';

/** Full wrap for the exec paths: resolves the backend AND the env/cwd the
 *  spawn must use (env scrub / soft-jail cwd clamp travel with the wrap). */
function wrapForExec(cmd: string, args: readonly string[], opts: ExecOptions): WrappedCommand {
  const sb = opts.sandbox;
  if (!sb || sb.mode === 'off') return { cmd, args: [...args], level: 'off', backend: 'none' };
  return wrapWithSandbox(cmd, args, {
    mode: sb.mode,
    cwd: opts.cwd,
    env: opts.env,
    policy: {
      workspaceDir: sb.workspaceDir ?? opts.cwd ?? process.cwd(),
      writablePaths: sb.writablePaths,
      network: sb.network,
      envScrub: sb.envScrub,
    },
  });
}

/** Attach the applied sandbox level/backend to a finished result (only
 *  when a sandbox actually engaged — off/absent leaves the result shape
 *  exactly as it was). */
function withSandboxInfo(p: Promise<ExecResult>, wrapped: WrappedCommand): Promise<ExecResult> {
  const level = wrapped.level;
  if (level === 'off') return p;
  return p.then((r) => ({ ...r, sandboxLevel: level, sandboxBackend: wrapped.backend }));
}

/** Wrap [cmd, args] per opts.sandbox. Returns the command unchanged when the
 *  sandbox is off or unavailable in auto mode — or throws in `bubblewrap`/
 *  `unshare` mode when the requested binary is missing (explicit request,
 *  fail loudly, never silently run unsandboxed). NOTE: no win32 early-return
 *  — both backends are POSIX-only, so a forced request on Windows must throw
 *  the loud "not found" error instead of silently running unsandboxed. */
export function maybeSandbox(
  cmd: string,
  args: readonly string[],
  opts: ExecOptions,
): { cmd: string; args: string[] } {
  const w = wrapForExec(cmd, args, opts);
  return { cmd: w.cmd, args: w.args };
}
