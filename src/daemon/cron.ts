// Recurring agent jobs (the Claude Code /loop + CronCreate insight): the
// daemon runs a prompt on a schedule and persists job definitions to disk, so
// long-running agent work happens without anyone driving it interactively.
//
// A job pairs a human prompt with a cadence:
//   - interval: "every 30m", "every 2 hours", "every day", "every 9h"
//   - cron:     standard 5-field cron, e.g. "0 9 * * 1-5"
// Jobs persist as JSON (.mochi/cron.json) and are owned by the daemon process.
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mochiStateDir } from '../core/mochi-dir.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';

export interface CronJob {
  id: string;
  prompt: string;
  schedule: string;               // normalized spec as written
  lastRun: number | null;         // epoch ms of last execution
  nextRun: number;                // epoch ms of next execution
  createdAt: number;
  enabled: boolean;
  runs: number;
  /** Optional delivery when a job finishes: either an https webhook URL or a
   *  shell command. Receives the goal summary via stdin / {summary} token. */
  notify?: string;
  /** Per-run wall-clock cap. The daemon aborts the goal when it expires. */
  timeoutMs?: number;
  /** Explicitly paused jobs keep their schedule but never fire. */
  paused?: boolean;
  /** Outcome of the most recent run (surfaced by `schedule` and `mochi cron`). */
  lastStatus?: 'ok' | 'error' | 'timeout';
  lastError?: string;
  lastOutput?: string;
  lastDurationMs?: number;
}

export interface AddCronOptions {
  notify?: string;
  timeoutMs?: number;
  paused?: boolean;
}

export const DEFAULT_CRON_TIMEOUT_MS = 30 * 60_000;
export const MAX_CRON_TIMEOUT_MS = 24 * 60 * 60_000;
export const MIN_CRON_TIMEOUT_MS = 10_000;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** Parse "every <n>? <unit>" -> ms interval. Returns null if unparseable. */
export function everyInterval(spec: string): number | null {
  const m = spec.trim().toLowerCase().match(/^every\s+(?:(\d+)\s*)?(s|sec|second|m|min|minute|h|hr|hour|d|day|week)s?$/);
  if (!m) return null;
  const n = Number(m[1] || 1);
  const u = m[2][0]; // s|m|h|d
  const base = UNIT_MS[u];
  if (!base) return null;
  return m[2].startsWith('week') ? 7 * UNIT_MS.d : n * base;
}

/** Expand a cron field into a set of allowed values; empty array = wildcard. */
function fieldSet(v: string): number[] {
  if (v === '*') return [];
  const out: number[] = [];
  for (const part of v.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) out.push(i);
    } else if (part.includes('/')) {
      const [start, step] = part.split('/').map(Number);
      for (let i = start; i < 60; i += step) out.push(i);
    } else if (part !== '') out.push(Number(part));
  }
  return out;
}

/** Next fire time at-or-after `from` for a 5-field cron. */
function nextCron(fields: string[], from: number): number | null {
  const mins = fieldSet(fields[0]);
  const hours = fieldSet(fields[1]);
  const doms = fieldSet(fields[2]);
  const mons = fieldSet(fields[3]);
  const dows = fieldSet(fields[4]);
  const MS = 60_000;
  let t = from;
  for (let step = 0; step < 24 * 60 * 7; step++) {
    const d = new Date(t);
    if (matches(d, mins, hours, doms, mons, dows)) return t;
    t += MS;
  }
  return from + 60_000; // safety fallback so the loop never hangs
}

function matches(d: Date, mins: number[], hours: number[], doms: number[], mons: number[], dows: number[]): boolean {
  return (
    (mins.length === 0 || mins.includes(d.getMinutes())) &&
    (hours.length === 0 || hours.includes(d.getHours())) &&
    (mons.length === 0 || mons.includes(d.getMonth() + 1)) &&
    (doms.length === 0 || doms.includes(d.getDate())) &&
    (dows.length === 0 || dows.includes(d.getDay()))
  );
}

/** Next epoch-ms for any supported spec (interval or cron). */
export function nextRunFor(spec: string, from = Date.now()): number | null {
  const ev = everyInterval(spec);
  if (ev !== null) return from + ev;
  const fields = spec.trim().split(/\s+/);
  if (fields.length === 5) return nextCron(fields, from);
  return null;
}

export function isRunnable(spec: string): boolean {
  return everyInterval(spec) !== null || spec.trim().split(/\s+/).length === 5;
}

/** Advance a job after a run: update lastRun, nextRun, runs. */
export function bumpJob(job: CronJob): CronJob {
  const next = nextRunFor(job.schedule);
  if (next === null) return job;
  return { ...job, lastRun: Date.now(), nextRun: next, runs: job.runs + 1 };
}

function loadJobs(dir: string): CronJob[] {
  try {
    const f = resolve(mochiStateDir(dir), 'cron.json');
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (!Array.isArray(raw)) return [];
    // Schema-validate each entry so a hand-edited or attacker-written job
    // file cannot inject unexpected shapes (e.g. non-string notify targets).
    const clean: CronJob[] = [];
    for (const j of raw) {
      if (!j || typeof j !== 'object') continue;
      const r = j as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.prompt !== 'string' || typeof r.schedule !== 'string') continue;
      if (typeof r.nextRun !== 'number' || typeof r.createdAt !== 'number') continue;
      const job: CronJob = {
        id: String(r.id).slice(0, 32),
        prompt: String(r.prompt).slice(0, 8000),
        schedule: String(r.schedule).slice(0, 64),
        lastRun: typeof r.lastRun === 'number' ? r.lastRun : null,
        nextRun: r.nextRun,
        createdAt: r.createdAt,
        enabled: r.enabled !== false,
        runs: typeof r.runs === 'number' && r.runs >= 0 ? Math.floor(r.runs) : 0,
      };
      if (typeof r.notify === 'string' && validateNotify(r.notify) === null) job.notify = r.notify;
      if (typeof r.timeoutMs === 'number' && r.timeoutMs >= MIN_CRON_TIMEOUT_MS) {
        job.timeoutMs = Math.min(Math.floor(r.timeoutMs), MAX_CRON_TIMEOUT_MS);
      }
      job.paused = r.paused === true;
      if (r.lastStatus === 'ok' || r.lastStatus === 'error' || r.lastStatus === 'timeout') job.lastStatus = r.lastStatus;
      if (typeof r.lastError === 'string') job.lastError = r.lastError.slice(0, 2000);
      if (typeof r.lastOutput === 'string') job.lastOutput = r.lastOutput.slice(0, 4000);
      if (typeof r.lastDurationMs === 'number' && r.lastDurationMs >= 0) job.lastDurationMs = Math.floor(r.lastDurationMs);
      clean.push(job);
    }
    return clean;
  } catch {
    return [];
  }
}

function saveJobs(dir: string, jobs: CronJob[]): void {
  mkdirSync(mochiStateDir(dir), { recursive: true });
  // Atomic (B29): a crash mid-write must never tear cron.json — the daemon
  // re-reads it on every scheduler tick.
  atomicWriteFileSync(resolve(mochiStateDir(dir), 'cron.json'), JSON.stringify(jobs, null, 2));
}

/** Validate a notify target: https? webhook URL or a bounded shell command.
 *  Returns null when valid, or a human-readable error. Shell targets are
 *  executed via `sh -c` with the summary passed ONLY through the
 *  MOCHI_JOB_SUMMARY env var + stdin (never interpolated into the command),
 *  so validation here is defense-in-depth: length caps, NUL/newline guards,
 *  and scheme check for URLs. */
export function validateNotify(notify: string): string | null {
  if (typeof notify !== 'string' || !notify.trim()) return 'Notify target must be a non-empty string.';
  const t = notify.trim();
  if (t.includes('\0')) return 'Notify target must not contain NUL bytes.';
  if (/^https?:\/\//i.test(t)) {
    if (t.length > 2000) return 'Notify webhook URL is too long (max 2000 chars).';
    try {
      const u = new URL(t);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Notify URL must be http(s).';
    } catch {
      return 'Notify URL is malformed.';
    }
    return null;
  }
  if (t.length > 500) return 'Notify shell command is too long (max 500 chars).';
  return null;
}

/** Add a recurring job; returns its id or a validation error. */
export function addJob(
  dir: string,
  prompt: string,
  schedule: string,
  notifyOrOptions?: string | AddCronOptions,
): { id?: string; error?: string } {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { id: undefined, error: 'Job prompt must be a non-empty string.' };
  }
  const opts: AddCronOptions = typeof notifyOrOptions === 'string'
    ? { notify: notifyOrOptions }
    : (notifyOrOptions ?? {});
  const n = nextRunFor(schedule);
  if (n === null) return { id: undefined, error: `Unparseable schedule "${schedule}". Use "every 30m" or a 5-field cron like "0 9 * * 1-5".` };
  if (opts.notify !== undefined) {
    const bad = validateNotify(opts.notify);
    if (bad) return { id: undefined, error: bad };
  }
  let timeoutMs: number | undefined;
  if (opts.timeoutMs !== undefined) {
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < MIN_CRON_TIMEOUT_MS) {
      return { id: undefined, error: `timeoutMs must be at least ${MIN_CRON_TIMEOUT_MS}ms.` };
    }
    timeoutMs = Math.min(Math.floor(opts.timeoutMs), MAX_CRON_TIMEOUT_MS);
  }
  const jobs = loadJobs(dir);
  const job: CronJob = {
    id: randomUUID().slice(0, 8),
    prompt: prompt.trim(),
    schedule,
    lastRun: null,
    nextRun: n,
    createdAt: Date.now(),
    enabled: true,
    runs: 0,
    ...(opts.notify ? { notify: opts.notify } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(opts.paused ? { paused: true } : {}),
  };
  jobs.push(job);
  saveJobs(dir, jobs);
  return { id: job.id };
}

/** Pause/resume without deleting the schedule. Resuming re-arms the next run. */
export function setJobPaused(dir: string, id: string, paused: boolean): boolean {
  const jobs = loadJobs(dir);
  let found = false;
  const next = jobs.map((j) => {
    if (j.id !== id) return j;
    found = true;
    if (paused) return { ...j, paused: true };
    const at = nextRunFor(j.schedule);
    return { ...j, paused: false, enabled: true, ...(at ? { nextRun: at } : {}) };
  });
  if (found) saveJobs(dir, next);
  return found;
}

/** Enable/disable a job. Disabled jobs are kept for history and re-enabling. */
export function setJobEnabled(dir: string, id: string, enabled: boolean): boolean {
  const jobs = loadJobs(dir);
  let found = false;
  const next = jobs.map((j) => {
    if (j.id !== id) return j;
    found = true;
    if (!enabled) return { ...j, enabled: false };
    const at = nextRunFor(j.schedule);
    return { ...j, enabled: true, paused: false, ...(at ? { nextRun: at } : {}) };
  });
  if (found) saveJobs(dir, next);
  return found;
}

/** Queue a job for the next scheduler tick (1s in-process, 10s detached). */
export function runJobNow(dir: string, id: string): boolean {
  const jobs = loadJobs(dir);
  let found = false;
  const next = jobs.map((j) => {
    if (j.id !== id) return j;
    found = true;
    return { ...j, enabled: true, paused: false, nextRun: Date.now() };
  });
  if (found) saveJobs(dir, next);
  return found;
}

export function getJob(dir: string, id: string): CronJob | undefined {
  return loadJobs(dir).find((j) => j.id === id || j.id.startsWith(id));
}

export interface CronRunOutcome {
  id: string;
  ok: boolean;
  status: 'ok' | 'error' | 'timeout';
  output: string;
  error?: string;
  durationMs: number;
}

/** Execute every due job serially with a real abort-based timeout, persist the
 *  outcome, and deliver notifications. Returns one outcome per job. */
export async function runDueCronJobs(
  dir: string,
  runGoal: (prompt: string, signal: AbortSignal) => Promise<string>,
): Promise<CronRunOutcome[]> {
  const outcomes: CronRunOutcome[] = [];
  for (const job of dueJobs(dir)) {
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(job.timeoutMs ?? DEFAULT_CRON_TIMEOUT_MS, MIN_CRON_TIMEOUT_MS), MAX_CRON_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`cron job ${job.id} timed out after ${timeoutMs}ms`)), timeoutMs);
    let status: 'ok' | 'error' | 'timeout' = 'ok';
    let output = '';
    let error: string | undefined;
    try {
      output = await runGoal(job.prompt, controller.signal);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = controller.signal.aborted ? 'timeout' : 'error';
      output = error;
    } finally {
      clearTimeout(timer);
    }
    const finished = Date.now();
    const durationMs = finished - started;
    const next = nextRunFor(job.schedule, finished) ?? job.nextRun;
    const updated: CronJob = {
      ...job,
      lastRun: finished,
      nextRun: next,
      runs: job.runs + 1,
      lastStatus: status,
      lastDurationMs: durationMs,
      lastOutput: String(output ?? '').slice(0, 4000),
      ...(error ? { lastError: error.slice(0, 2000) } : { lastError: undefined }),
    };
    updateJob(dir, updated);
    await notifyJobResult(job, String(output ?? ''));
    outcomes.push({ id: job.id, ok: status === 'ok', status, output: String(output ?? ''), ...(error ? { error } : {}), durationMs });
  }
  return outcomes;
}

/** Deliver a job result to its configured notify target (webhook or command).
 *  Webhooks get a POST with JSON; shell commands get the summary via the
 *  MOCHI_JOB_SUMMARY env var. Never throws — failures are logged, not fatal. */
export async function notifyJobResult(job: CronJob, summary: string): Promise<void> {
  const target = job.notify;
  if (!target) return;
  // Defense in depth: re-validate at execution time; a job file edited
  // behind our back with a malformed target is dropped, not executed.
  if (validateNotify(target) !== null) {
    console.warn(`[cron] notify target failed validation for job ${job.id} — skipped.`);
    return;
  }
  // Env vars carry arbitrary bytes safely; no shell escaping needed (the old
  // `"\"` rewrite corrupted summaries). Cap sizes to bound the child env.
  const summaryCapped = summary.slice(0, 4000);
  const ok = await (async () => {
    try {
      if (/^https?:\/\//i.test(target)) {
        const res = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ job: job.id, prompt: job.prompt, summary, ts: Date.now() }),
        });
        return res.ok;
      }
      // shell command: summary via MOCHI_JOB_SUMMARY env under central policy
      // (timeout/SIGKILL/output cap). Never interpolated into the command.
      // runShellString (not runArgv sh -c): on win32 this runs the fixed
      // cmd.exe /d /s /c recipe; a raw `sh` spawn mangles backslash redirect
      // paths and ENOENTs when Git usr/bin is absent.
      const { runShellString } = await import('../exec.js');
      try {
        const r = await runShellString(target, {
          env: { ...process.env, MOCHI_JOB_SUMMARY: summaryCapped },
          timeoutMs: 15_000,
          maxOutput: 1024 * 1024,
        });
        return (r.code ?? 1) === 0;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  })();
  if (!ok) console.warn(`[cron] notify failed for job ${job.id} -> ${target.slice(0, 60)}`);
}


export function removeJob(dir: string, id: string): boolean {
  saveJobs(dir, loadJobs(dir).filter((j) => j.id !== id));
  return true;
}

/** Persist an in-memory update to a job back to disk (e.g. after a run). */
export function updateJob(dir: string, job: CronJob): void {
  const jobs = loadJobs(dir).map((j) => (j.id === job.id ? job : j));
  saveJobs(dir, jobs);
}

export function listJobs(dir: string): CronJob[] {
  return loadJobs(dir);
}

/** Jobs whose nextRun has come due (enabled only). */
export function dueJobs(dir: string, now = Date.now()): CronJob[] {
  return loadJobs(dir).filter((j) => j.enabled && !j.paused && j.nextRun <= now);
}