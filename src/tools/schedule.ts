// Recurring / scheduled task automation.
//
// The daemon already owns the scheduler; this tool is the agent-facing control
// plane for it: create, inspect, pause/resume, run-now, and delete jobs without
// hand-editing `.mochi/cron.json`. Jobs persist across restarts and each run
// records status, duration, output excerpt, and the last error.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import {
  addJob, getJob, isRunnable, listJobs, removeJob, runJobNow,
  setJobPaused, setJobEnabled, nextRunFor, MIN_CRON_TIMEOUT_MS,
  type CronJob,
} from '../daemon/cron.js';

function daemonAlive(cwd: string): boolean {
  try {
    const p = resolve(mochiStateDir(cwd), 'daemon', 'info.json');
    if (!existsSync(p)) return false;
    const info = JSON.parse(readFileSync(p, 'utf8')) as { pid?: number };
    if (typeof info.pid !== 'number') return false;
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function when(ms: number | null | undefined): string {
  if (!ms) return '—';
  const delta = ms - Date.now();
  const abs = new Date(ms).toLocaleString();
  if (delta <= 0) return `${abs} (due now)`;
  const mins = Math.round(delta / 60_000);
  const rel = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return `${abs} (in ${rel})`;
}

function line(j: CronJob): string {
  const state = j.paused ? 'PAUSED' : (j.enabled ? 'active' : 'disabled');
  const status = j.lastStatus ? ` · last: ${j.lastStatus}${j.lastDurationMs ? ` ${Math.round(j.lastDurationMs / 1000)}s` : ''}` : ' · never run';
  const out = [
    `• ${j.id} [${state}] ${j.schedule} — runs ${j.runs}${status}`,
    `  next: ${when(j.nextRun)}`,
    `  prompt: ${j.prompt.length > 160 ? `${j.prompt.slice(0, 157)}…` : j.prompt}`,
  ];
  if (j.timeoutMs) out.push(`  timeout: ${Math.round(j.timeoutMs / 1000)}s`);
  if (j.notify) out.push(`  notify: ${j.notify.length > 80 ? `${j.notify.slice(0, 77)}…` : j.notify}`);
  if (j.lastError) out.push(`  last error: ${j.lastError.slice(0, 300)}`);
  if (j.lastOutput) out.push(`  last output: ${j.lastOutput.slice(0, 240).replace(/\n/g, ' ')}`);
  return out.join('\n');
}

export const scheduleTool: Tool = {
  def: {
    name: 'schedule',
    description:
      'Create and manage recurring autonomous tasks (cron). The daemon executes each job prompt on its schedule and records status/output. ' +
      'Actions: add (prompt + schedule like "every 30m" or "0 9 * * 1-5"), list, status, run (queue now), pause, resume, enable, disable, remove. ' +
      'Supports per-job timeoutMs, notify webhook/shell, and reliable last-error reporting. Use for "every morning…", "check X hourly", ' +
      '"run this daily", reminders that actually execute, and recurring maintenance. Jobs run only while `mochi daemon start` is active.',
    parameters: [
      { name: 'action', type: 'string', description: 'add | list | status | run | pause | resume | enable | disable | remove', required: true },
      { name: 'prompt', type: 'string', description: 'Task/instruction to run on each tick (add)', required: false },
      { name: 'schedule', type: 'string', description: '"every 30m", "every 2 hours", "every day", or 5-field cron "0 9 * * 1-5" (add)', required: false },
      { name: 'id', type: 'string', description: 'Job id (status/run/pause/resume/enable/disable/remove)', required: false },
      { name: 'timeoutMs', type: 'integer', description: `Per-run timeout in ms (default 30m, min ${MIN_CRON_TIMEOUT_MS})`, required: false },
      { name: 'notify', type: 'string', description: 'Optional https webhook URL or shell command to receive the run summary', required: false },
      { name: 'paused', type: 'boolean', description: 'Create the job paused (add)', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'list').toLowerCase();
    const cwd = ctx.cwd;
    try {
      if (action === 'add' || action === 'create') {
        const prompt = String(args.prompt ?? '').trim();
        const schedule = String(args.schedule ?? '').trim();
        if (!prompt) return '[schedule add] ERROR: prompt is required';
        if (!schedule) return '[schedule add] ERROR: schedule is required (e.g. "every 30m" or "0 9 * * 1-5")';
        if (!isRunnable(schedule)) return `[schedule add] ERROR: unparseable schedule "${schedule}"`;
        const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined;
        const r = addJob(cwd, prompt, schedule, {
          notify: args.notify ? String(args.notify) : undefined,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
          paused: args.paused === true,
        });
        if (r.error) return `[schedule add] ERROR: ${r.error}`;
        const job = getJob(cwd, r.id!);
        const live = daemonAlive(cwd);
        return [
          `[schedule add] ok — job ${r.id}`,
          `schedule: ${schedule}`,
          `next: ${when(job?.nextRun ?? nextRunFor(schedule))}`,
          live ? 'daemon: running (will execute automatically)' : 'daemon: NOT running — start it with `mochi daemon start` or the job will not fire',
          `prompt: ${prompt.slice(0, 200)}`,
        ].join('\n');
      }
      if (action === 'list') {
        const jobs = listJobs(cwd);
        if (!jobs.length) return '[schedule list] no jobs. Add one with action:"add".';
        return [`[schedule list] ${jobs.length} job(s)${daemonAlive(cwd) ? '' : ' (daemon NOT running)'}`, ...jobs.map(line)].join('\n');
      }
      if (action === 'status') {
        const id = String(args.id ?? '');
        if (!id) return '[schedule status] ERROR: id is required';
        const job = getJob(cwd, id);
        if (!job) return `[schedule status] ERROR: no job matching "${id}"`;
        return [`[schedule status] ${job.id}`, line(job), `created: ${new Date(job.createdAt).toLocaleString()}`, `last run: ${when(job.lastRun)}`].join('\n');
      }
      const id = String(args.id ?? '');
      if (!id) return `[schedule ${action}] ERROR: id is required`;
      const found = getJob(cwd, id);
      if (!found) return `[schedule ${action}] ERROR: no job matching "${id}"`;
      if (action === 'run') {
        runJobNow(cwd, found.id);
        return `[schedule run] queued ${found.id}; ${daemonAlive(cwd) ? 'the daemon will pick it up within ~1s' : 'start `mochi daemon start` to execute it'}`;
      }
      if (action === 'pause' || action === 'resume') {
        setJobPaused(cwd, found.id, action === 'pause');
        const job = getJob(cwd, found.id);
        return `[schedule ${action}] ${found.id} → ${action === 'pause' ? 'paused' : `active, next ${when(job?.nextRun)}`}`;
      }
      if (action === 'enable' || action === 'disable') {
        setJobEnabled(cwd, found.id, action === 'enable');
        return `[schedule ${action}] ${found.id} updated`;
      }
      if (action === 'remove' || action === 'delete') {
        removeJob(cwd, found.id);
        return `[schedule remove] deleted ${found.id}`;
      }
      return `[schedule ${action}] ERROR: unknown action. Use add|list|status|run|pause|resume|enable|disable|remove.`;
    } catch (err) {
      return `[schedule ${action}] ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
