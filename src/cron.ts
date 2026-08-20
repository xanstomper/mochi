// Recurring agent jobs (the Claude Code /loop + CronCreate insight): the
// daemon runs a prompt on a schedule and persists job definitions to disk, so
// long-running agent work happens without anyone driving it interactively.
//
// A job pairs a human prompt with a cadence:
//   - interval: "every 30m", "every 2 hours", "every day", "every 9h"
//   - cron:     standard 5-field cron, e.g. "0 9 * * 1-5"
// Jobs persist as JSON (.mochi/cron.json) and are owned by the daemon process.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface CronJob {
  id: string;
  prompt: string;
  schedule: string;               // normalized spec as written
  lastRun: number | null;         // epoch ms of last execution
  nextRun: number;                // epoch ms of next execution
  createdAt: number;
  enabled: boolean;
  runs: number;
}

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
    const f = resolve(dir, '.mochi', 'cron.json');
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(raw) ? (raw as CronJob[]) : [];
  } catch {
    return [];
  }
}

function saveJobs(dir: string, jobs: CronJob[]): void {
  mkdirSync(resolve(dir, '.mochi'), { recursive: true });
  writeFileSync(resolve(dir, '.mochi', 'cron.json'), JSON.stringify(jobs, null, 2));
}

/** Add a recurring job; returns its id or a validation error. */
export function addJob(dir: string, prompt: string, schedule: string): { id?: string; error?: string } {
  const n = nextRunFor(schedule);
  if (n === null) return { error: `Unparseable schedule "${schedule}". Use "every 30m" or a 5-field cron like "0 9 * * 1-5".` };
  const jobs = loadJobs(dir);
  const job: CronJob = {
    id: randomUUID().slice(0, 8),
    prompt,
    schedule,
    lastRun: null,
    nextRun: n,
    createdAt: Date.now(),
    enabled: true,
    runs: 0,
  };
  jobs.push(job);
  saveJobs(dir, jobs);
  return { id: job.id };
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
  return loadJobs(dir).filter((j) => j.enabled && j.nextRun <= now);
}