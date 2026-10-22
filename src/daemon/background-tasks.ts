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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
}

const tasks = new Map<string, BackgroundTask>();
/** Owning cwd per task id — each task's ledger record lives in the directory
 *  it was started in (B22). */
const taskDirs = new Map<string, string>();
const processes = new Map<string, import('node:child_process').ChildProcess>();
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
    persist();
  }, timeout);
  child.on('exit', (code) => {
    clearTimeout(timer);
    processes.delete(id);
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
  const child = processes.get(id);
  if (!child?.stdin || child.stdin.destroyed) return false;
  child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
  return true;
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

/** Human/agent-readable snapshot for tool results. */
export function describeTask(t: BackgroundTask, maxOutput = 1500): string {
  const head = `[bg:${t.id}] ${t.status} "${t.description ?? t.command.slice(0, 60)}" started ${Math.round((Date.now() - t.startedAt) / 1000)}s ago`;
  if (t.status === 'running') return `${head} — still running`;
  const out = t.output.length > maxOutput ? t.output.slice(0, maxOutput) + `\n... (${t.output.length} bytes total)` : t.output;
  return `${head} exit=${t.exitCode}\n${out}`;
}
