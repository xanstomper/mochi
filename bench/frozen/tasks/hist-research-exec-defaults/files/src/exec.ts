// Central command-execution policy: every child process mochi spawns for
// agent work flows through here (shell tool, verification, cron notify).
// Guarantees on every call: bounded wall-clock (SIGTERM then SIGKILL),
// bounded output (never OOMs the harness on firehose commands), argv-array
// API for shell-free execution, and an audit hook for risk logging.
// Long-lived processes (background tasks, daemons, PTY) keep their own
// lifecycle owners and are intentionally OUT of scope.
import { spawn, spawnSync, execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { accessSync, constants } from 'node:fs';

export interface SandboxOptions {
  /** 'off' (default) runs directly; 'bubblewrap' forces bwrap (fails if
   *  missing); 'auto' uses bwrap when available, else runs directly. */
  mode: 'off' | 'auto' | 'bubblewrap';
  /** Allow network inside the sandbox. Default true (npm/tests need it). */
  network?: boolean;
  /** Extra read-write paths beyond cwd + tmpdir + devtool caches. */
  writablePaths?: string[];
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
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 2_000_000;

function finishSpawn(
  child: ReturnType<typeof spawn>,
  cmd: string,
  opts: ExecOptions,
  stdoutRef: { text: string; truncated: boolean },
  stderrRef: { text: string; truncated: boolean },
  startedAt: number,
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? 1500;
  // MOCHI_EXEC_TRACE=1 logs every spawn and outcome — the ONLY way to see
  // WHICH command a hung run is stuck on (a hang prints start, never done).
  if (process.env.MOCHI_EXEC_TRACE === '1') {
    console.warn(`[exec] start :: ${cmd.slice(0, 160)}${opts.cwd ? ` (cwd=${opts.cwd})` : ''}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
