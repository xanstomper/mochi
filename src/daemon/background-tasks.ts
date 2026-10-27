// Background tasks (the Claude Code insight): long commands run async while
// the agent keeps working; the harness delivers results as events the loop
// injects when they complete. This converts "block the loop 60s on npm test"
// into "start it, keep editing, consume the result when it lands".
//
// Design: one registry per process (daemon-safe), keyed by task id. The shell
// tool gets a `background: true` flag; the tool returns immediately with a
// task id, and the agent loop polls delivered results between model calls.
//
// The registry is ALSO persisted to <cwd>/.mochi/bg-tasks.json, because a
// fresh `mochi bg list|logs|kill` CLI process used to read this in-process
// Map — which is always empty in a new process, so the command could never
// show or kill anything. Readers should merge: in-process truth first, then
// the on-disk ledger (with owner-pid liveness checks for stale 'running').
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import { maybeSandbox, type SandboxOptions } from '../exec.js';

export interface BackgroundTask {
  id: string;
  command: string;
  description?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  exitCode?: number | null;
  output: string;
  /** Child pid — lets a DIFFERENT process (`mochi bg kill`) signal the task. */
  pid?: number;
  /** MCH-218: path of the task's stdin FIFO when cross-process steering is
   *  available (mkfifo present). Writers append to this to feed the child. */
  fifoPath?: string;
}

/** The relay command for a task's stdin FIFO (MCH-218b). Between reopens it
 *  self-checks: FIFO gone (cleanup unlinked it) or task PID dead → exit, so a
 *  relay orphaned by a hard daemon death reaps itself instead of holding the
 *  FIFO (and a forked `cat`) forever. */
export function buildRelayCommand(fifoPath: string, taskPid: number): string {
  return `while :; do [ -e "${fifoPath}" ] || exit 0; kill -0 ${taskPid} 2>/dev/null || exit 0; cat "${fifoPath}" || break; done`;
}

/** Matches BOTH relay command shapes (legacy leak-prone + self-reaping) in a
 *  /proc/<pid>/cmdline vector. Requires the bg-*.stdin fifo path — a plain
 *  `cat` loop over any other file never matches. */
export function isRelayCmdline(parts: string[]): boolean {
  if (parts[0] !== 'sh' || parts[1] !== '-c' || parts.length !== 3) return false;
  return /^while :; do (?:\[ -e "[^"]*bg-[^"]*\.stdin" \] \|\| exit 0; kill -0 \d+ 2>\/dev\/null \|\| exit 0; )?cat "[^"]*bg-[^"]*\.stdin" \|\| break; done$/.test(parts[2]);
}

const tasks = new Map<string, BackgroundTask>();
/** Owning cwd per task id — each task's ledger record lives in the directory
 *  it was started in (B22). */
const taskDirs = new Map<string, string>();
const processes = new Map<string, import('node:child_process').ChildProcess>();
/** MCH-218: per-task FIFO relay process (reads the stdin FIFO, writes the
 *  child's stdin). Killed + unlinked when the task exits or is killed. */
const relays = new Map<string, import('node:child_process').ChildProcess>();

/** Reap relay processes orphaned by a hard daemon death. The four per-task
 *  cleanup paths only run while the daemon lives; when it dies by SIGKILL/OOM
 *  its detached relay groups survive, holding FIFOs open forever (measured
 *  leak: 4 pairs at 9h+ age). Walks /proc for relay-shaped cmdlines, skips our
 *  own live relays and anything younger than PROTECT_AGE (a concurrent
 *  daemon's active tasks), and group-kills the rest. Returns the reaped count.
 *  Safe to call at every daemon/server startup; a clean box reaps 0. */
const RELAY_PROTECT_AGE_MS = 10 * 60_000;

export function reapOrphanedRelays(): number {
  let reaped = 0;
  let procDir: string[] = [];
  try {
    procDir = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return 0; // not Linux — nothing to walk
  }
  const ownPids = new Set<number>();
  for (const r of relays.values()) {
    if (r.pid) ownPids.add(r.pid);
  }
  for (const d of procDir) {
    const pid = Number(d);
    if (ownPids.has(pid) || pid === process.pid) continue;
    let cmdline: string[] = [];
    try {
      cmdline = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue; // process vanished mid-walk
    }
    if (!isRelayCmdline(cmdline)) continue;
    // Age guard via /proc/<pid>/stat starttime (field 22 after the comm).
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(after[19]);
      if (Number.isFinite(ticks) && ticks > 0) {
        const uptimeS = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
        const ageMs = (uptimeS - ticks / 100) * 1000;
        if (ageMs < RELAY_PROTECT_AGE_MS) continue;
      }
    } catch {
      continue;
    }
    try { if (pid > 1) process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    reaped++;
  }
  return reaped;
}

const MAX_COMPLETED = 20;
/** Output cap per task IN THE LEDGER (in-memory buffer stays at 200KB). */
const PERSIST_OUTPUT_CAP = 100_000;

function statePathFor(cwd: string): string {
  return resolve(cwd, '.mochi', 'bg-tasks.json');
}

function writeLedger(dir: string | undefined, list: BackgroundTask[]): void {
  if (!dir) return;
  try {
    const file = statePathFor(dir);
    const parent = resolve(file, '..');
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const slim = list.map((t) => ({
      ...t,
      output: t.output.length > PERSIST_OUTPUT_CAP
        ? `…(truncated)\n${t.output.slice(-PERSIST_OUTPUT_CAP)}`
        : t.output,
    }));
    // Atomic via tmp+rename: a crash mid-write must never leave a torn
    // bg-tasks.json (I4) — `mochi bg list/kill` in a fresh process would
    // die on the truncated JSON.
    atomicWriteFileSync(file, JSON.stringify(slim));
  } catch {
    /* ledger is best-effort — never break a task over it */
  }
}

/** Persist each task's record into the ledger of the directory it was started
 *  in. B22: the old single `lastStateDir` dumped the ENTIRE registry into the
 *  cwd of the most recently started task — a task started in workspace A had
 *  its completion written into workspace B's ledger while A kept a stale
 *  'running' record that listPersistedTasks then falsified to 'failed (owner
 *  exited)'. Tasks with no known dir (never possible via startBackgroundTask)
 *  are skipped. */
function persist(): void {
  const byDir = new Map<string, BackgroundTask[]>();
  for (const t of tasks.values()) {
    const dir = taskDirs.get(t.id);
    if (!dir) continue;
    const list = byDir.get(dir);
    if (list) list.push(t);
    else byDir.set(dir, [t]);
  }
  for (const [dir, list] of byDir) writeLedger(dir, list);
}

function prune() {
  const done = [...tasks.values()].filter((t) => t.status !== 'running');
  if (done.length > MAX_COMPLETED) {
    for (const t of done.slice(0, done.length - MAX_COMPLETED)) {
      tasks.delete(t.id);
      processes.delete(t.id);
      taskDirs.delete(t.id);
    }
  }
}

function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but owned by another user; ESRCH = no such process.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function startBackgroundTask(
  command: string,
  cwd: string,
  opts: { description?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; sandbox?: SandboxOptions } = {},
): BackgroundTask {
  const id = randomUUID().slice(0, 8);
  const task: BackgroundTask = {
    id,
    command,
    description: opts.description,
    startedAt: Date.now(),
    status: 'running',
    output: '',
  };
  // B31 restructure: `sandbox` (set by the shell tool for safe-mode
  // elevated-risk background commands) wraps the raw `sh -c` spawn through
  // the SAME maybeSandbox machinery the foreground path uses. Callers pass
  // mode 'bubblewrap' only after probing availability, so a vanished bwrap
  // throws here — the task fails visibly, never runs unsandboxed.
  let spawnCmd = 'sh';
  let spawnArgs = ['-c', command];
  if (opts.sandbox && opts.sandbox.mode !== 'off') {
    ({ cmd: spawnCmd, args: spawnArgs } = maybeSandbox('sh', ['-c', command], {
      cwd,
      sandbox: opts.sandbox,
    }));
  }
  const child = spawn(spawnCmd, spawnArgs, {
    cwd,
    env: opts.env ?? process.env,
    detached: false,
  });
  task.pid = child.pid;
  processes.set(id, child);
  taskDirs.set(id, cwd);
  // MCH-218: per-task stdin FIFO — the child reads its input from a named
  // pipe on disk, so ANY process (a later `mochi bg steer`, another agent,
  // the daemon) can steer a RUNNING task by appending to the FIFO. The
  // direct-handle path (steerTask with a live `processes` entry) stays the
  // fast path; the FIFO is the cross-process fallback.
  const fifoPath = resolve(cwd, '.mochi', `bg-${id}.stdin`);
  try {
    mkdirSync(resolve(cwd, '.mochi'), { recursive: true });
    unlinkSync(fifoPath);
  } catch { /* fresh fifo path */ }
  try {
    execFileSync('mkfifo', [fifoPath]);
    // Relay loop: `cat` blocks opening the FIFO until a writer appears, relays
    // that writer's bytes into the child's stdin, hits EOF when the writer
    // closes, and REOPENS — so the FIFO accepts steering lines for the whole
    // life of the task, not just the first writer.
    // detached:true + group SIGKILL: `sh -c 'while ...'` forks a fresh `cat`
    // per reopen, and killing the sh alone orphans the running cat (it keeps
    // the FIFO open forever — the process-leak bug). The relay is its own
    // process group, so every cleanup kills sh AND its cat children in one
    // signal. (Node kills only the direct child; the negative pid targets
    // the group.)
    // SELF-REAPING: the four cleanup paths (exit/error/timeout/kill) cover a
    // LIVING daemon, but a daemon that dies hard (SIGKILL, OOM, crash) never
    // runs them — real leak evidence: 4 orphaned relay pairs found at 9h+ age.
    // The loop now checks, between reopens: (1) the FIFO still exists (cleanup
    // unlinks it) and (2) the task's PID is alive (kill -0). Either failing
    // ends the relay within one cycle, so an orphaned relay reaps itself even
    // when every cleanup path was skipped. Both checks run BEFORE cat blocks
    // on open, so steering latency is unchanged.
    const relay = spawn('sh', ['-c', child.pid !== undefined ? buildRelayCommand(fifoPath, child.pid) : `while :; do cat "${fifoPath}" || break; done`], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    relays.set(id, relay);
    relay.stdout?.on('data', (d: Buffer) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(d);
    });
    const killRelayGroup = () => {
      // Group kill first (sh + every forked cat); fall back to direct kill
      // when the group is already gone or the platform refuses negative pids.
      try { if (relay.pid) process.kill(-relay.pid, 'SIGKILL'); } catch { /* group gone */ }
      try { relay.kill('SIGKILL'); } catch { /* gone */ }
    };
    const cleanupFifo = () => {
      killRelayGroup();
      try { unlinkSync(fifoPath); } catch { /* gone */ }
    };
    child.on('exit', cleanupFifo);
    child.on('error', cleanupFifo);
    task.fifoPath = fifoPath;
  } catch {
    // mkfifo unavailable — cross-process steering disabled for this task;
    // the direct-handle path still works.
  }
  let buffer = '';
  const cap = 200_000;
  let lastFlushAt = 0;
  // Live output: reflect the buffer on the task and flush the ledger at most
  // once a second so `mochi bg logs` on a RUNNING task shows something and a
  // crash of the owner doesn't lose the whole run's output.
  const flush = (force = false) => {
    task.output = buffer;
    const now = Date.now();
    if (force || now - lastFlushAt > 1000) {
      lastFlushAt = now;
      persist();
    }
  };
  child.stdout?.on('data', (d: Buffer) => {
    if (buffer.length < cap) buffer += d.toString();
    flush();
  });
  child.stderr?.on('data', (d: Buffer) => {
    if (buffer.length < cap) buffer += d.toString();
    flush();
  });
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    processes.delete(id);
    task.status = 'timeout';
    task.endedAt = Date.now();
    task.output = buffer;
    const r = relays.get(id);
    if (r) { try { if (r.pid) process.kill(-r.pid, 'SIGKILL'); } catch { /* group gone */ } try { r.kill('SIGKILL'); } catch { /* gone */ } }
    relays.delete(id);
    try { unlinkSync(fifoPath); } catch { /* gone */ }
    persist();
  }, timeout);
  child.on('exit', (code) => {
    clearTimeout(timer);
    processes.delete(id);
    const r = relays.get(id);
    if (r) { try { if (r.pid) process.kill(-r.pid, 'SIGKILL'); } catch { /* group gone */ } try { r.kill('SIGKILL'); } catch { /* gone */ } }
    relays.delete(id);
    try { unlinkSync(fifoPath); } catch { /* gone */ }
    if (task.status === 'running') {
      task.status = code === 0 ? 'completed' : 'failed';
      task.exitCode = code;
      task.endedAt = Date.now();
      task.output = buffer;
      prune();
    }
    persist();
  });
  child.on('error', () => {
    clearTimeout(timer);
    processes.delete(id);
    const r = relays.get(id);
    if (r) { try { if (r.pid) process.kill(-r.pid, 'SIGKILL'); } catch { /* group gone */ } try { r.kill('SIGKILL'); } catch { /* gone */ } }
    relays.delete(id);
    try { unlinkSync(fifoPath); } catch { /* gone */ }
    task.status = 'failed';
    task.endedAt = Date.now();
    task.output = buffer + '\n(spawn error)';
    persist();
  });
  tasks.set(id, task);
  persist();
  return task;
}

export function killTask(id: string): boolean {
  const t = tasks.get(id);
  if (!t || t.status !== 'running') return false;
  const child = processes.get(id);
  if (child) {
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 500);
    } catch {
      /* process already exited */
    }
  }
  const relay = relays.get(id);
  if (relay) { try { if (relay.pid) process.kill(-relay.pid, 'SIGKILL'); } catch { /* group gone */ } try { relay.kill('SIGKILL'); } catch { /* gone */ } }
  relays.delete(id);
  if (t.fifoPath) { try { unlinkSync(t.fifoPath); } catch { /* gone */ } }
  processes.delete(id);
  t.status = 'failed';
  t.endedAt = Date.now();
  t.output = t.output ? `${t.output}\n(task killed by agent)` : '(task killed by agent)';
  prune();
  persist();
  return true;
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

/** MCH-218: steer a RUNNING background task — write a line to its stdin.
 *  Interactive CLIs (fzf-style pickers, pagers, REPLs, mochi's own TUI smoke)
 *  become controllable mid-run. Returns false when the task is unknown,
 *  finished, or its process handle is gone (e.g. after owner-process death,
 *  where the ledger records the orphan). */
export function steerTask(id: string, text: string): boolean {
  const t = tasks.get(id);
  if (!t || t.status !== 'running') return false;
  const line = text.endsWith('\n') ? text : `${text}\n`;
  // Fast path: live child handle in this process.
  const child = processes.get(id);
  if (child?.stdin && !child.stdin.destroyed) {
    child.stdin.write(line);
    return true;
  }
  // Cross-process fallback (MCH-218): append to the task's stdin FIFO —
  // works from ANY process (later `mochi bg steer`, another agent, the
  // daemon) as long as the FIFO file still exists.
  if (t.fifoPath && existsSync(t.fifoPath)) {
    try {
      appendFileSync(t.fifoPath, line);
      return true;
    } catch {
      return false; // no reader (relay dead) — honest false
    }
  }
  return false;
}

export function listTasks(): BackgroundTask[] {
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
}

// ---- Cross-process ledger (CLI: `mochi bg …`) -----------------------------

function readLedger(cwd: string): BackgroundTask[] {
  try {
    const file = statePathFor(cwd);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as BackgroundTask[]) : [];
  } catch {
    return [];
  }
}

/** Tasks from the on-disk ledger, with owner-pid liveness applied: a record
 *  still 'running' whose child pid is dead (and which this process doesn't
 *  own) is corrected to 'failed' — the owning agent exited before recording
 *  the outcome, so the status is unknowable, not "still running". */
export function listPersistedTasks(cwd: string): BackgroundTask[] {
  const list = readLedger(cwd);
  let changed = false;
  for (const t of list) {
    if (t.status !== 'running') continue;
    if (processes.has(t.id)) continue; // this process owns it — Map is truth
    if (!isPidAlive(t.pid)) {
      t.status = 'failed';
      t.endedAt = t.endedAt ?? Date.now();
      t.output = (t.output ? `${t.output}\n` : '') + '(owner process exited before completion — exit status unknown)';
      changed = true;
    }
  }
  if (changed) writeLedger(cwd, list);
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

export function getPersistedTask(id: string, cwd: string): BackgroundTask | undefined {
  return listPersistedTasks(cwd).find((t) => t.id === id);
}

/** Kill a task recorded in the ledger from a DIFFERENT process (signals the
 *  child pid directly). Returns false when the task is gone or already dead —
 *  after marking the record so it stops claiming 'running'. */
export function killPersistedTask(id: string, cwd: string): boolean {
  const list = readLedger(cwd);
  const t = list.find((x) => x.id === id);
  if (!t) return false;
  if (processes.has(id)) return killTask(id); // this process owns it
  if (t.status !== 'running') return false;
  if (isPidAlive(t.pid)) {
    try {
      process.kill(t.pid!, 'SIGTERM');
    } catch {
      return false;
    }
  } else {
    t.status = 'failed';
    t.endedAt = Date.now();
    t.output = (t.output ? `${t.output}\n` : '') + '(task was already dead when kill was requested)';
    writeLedger(cwd, list);
    return false;
  }
  t.status = 'failed';
  t.endedAt = Date.now();
  t.output = (t.output ? `${t.output}\n` : '') + '(task killed)';
  writeLedger(cwd, list);
  return true;
}

/** MCH-218: steer a task recorded in the ledger from a DIFFERENT process.
 *  Appends the line to the task's stdin FIFO (the relay feeds the child).
 *  Returns false when the task is unknown/not-running, has no FIFO (started
 *  before MCH-218 or mkfifo missing), or the relay is gone. */
export function steerPersistedTask(id: string, cwd: string, text: string): boolean {
  const list = readLedger(cwd);
  const t = list.find((x) => x.id === id);
  if (!t || t.status !== 'running') return false;
  if (processes.has(id)) return steerTask(id, text); // this process owns it
  if (!t.fifoPath || !existsSync(t.fifoPath)) return false;
  try {
    appendFileSync(t.fifoPath, text.endsWith('\n') ? text : `${text}\n`);
    return true;
  } catch {
    return false; // relay dead / no reader — honest false
  }
}

/** Human/agent-readable snapshot for tool results. */
export function describeTask(t: BackgroundTask, maxOutput = 1500): string {
  const head = `[bg:${t.id}] ${t.status} "${t.description ?? t.command.slice(0, 60)}" started ${Math.round((Date.now() - t.startedAt) / 1000)}s ago`;
  if (t.status === 'running') return `${head} — still running`;
  const out = t.output.length > maxOutput ? t.output.slice(0, maxOutput) + `\n... (${t.output.length} bytes total)` : t.output;
  return `${head} exit=${t.exitCode}\n${out}`;
}
