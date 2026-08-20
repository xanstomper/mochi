// Comprehensive health self-inspection (`mochi doctor`). Surfaces the state of
// every subsystem so an operator can see at a glance whether Mochi is ready
// and where the gaps are: provider keys, sqlite index, code symbol index,
// background tasks, cron jobs, sessions, and the running daemon.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasSqlite } from './codegraph.js';
import { listJobs } from './cron.js';
import { SessionStore } from './session-store.js';

export interface DoctorReport {
  runtime: { node: string; sqlite: boolean };
  model: {
    provider: string;
    keySet: boolean;
    keySource: string;
    baseUrl: string;
    model: string;
  };
  index: { sqlite: boolean; codegraph: 'ready' | 'unavailable' };
  daemon: { running: boolean; port?: number; jobs: number };
  cron: { jobs: number };
  sessions: { sqlite: boolean; count: number };
  diagnostics: { typescript: boolean; python: boolean };
  problems: string[];
}

/** Build a health report for a workspace. Pure and testable. */
export async function doctorReport(opts: {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string | null | undefined;
  workspaceDir: string;
  daemon?: { running: boolean; port?: number };
}): Promise<DoctorReport> {
  const problems: string[] = [];
  // node:sqlite needs Node >= 22.5; hasSqlite() probes it directly, so use
  // that rather than a fragile version-string comparison.
  const sqlite = hasSqlite();

  // Detect toolchain the agent hot paths use.
  const tsAvailable = (() => {
    try {
      return !!(resolve(process.cwd(), 'node_modules', 'typescript') && existsSync(resolve(process.cwd(), 'node_modules', 'typescript')));
    } catch { return false; }
  })();
  const pyAvailable = ['/usr/bin/python3', '/usr/bin/python', '/opt/homebrew/bin/python3'].some((p) => existsSync(p));

  // Real subsystem counts from the workspace's `.mochi/` state.
  const cronJobs = listJobs(opts.workspaceDir).length;
  let sessionCount = 0;
  if (sqlite) {
    try { sessionCount = new SessionStore(opts.workspaceDir).list().length; } catch { /* store not initialised yet */ }
  }

  const report: DoctorReport = {
    runtime: { node: process.version, sqlite },
    model: { provider: opts.provider, keySet: Boolean(opts.apiKey), keySource: opts.apiKey ? 'env/config' : 'unset', baseUrl: opts.baseUrl, model: opts.model },
    index: { sqlite, codegraph: sqlite ? 'ready' : 'unavailable' },
    daemon: { running: opts.daemon?.running ?? false, port: opts.daemon?.port, jobs: cronJobs },
    cron: { jobs: cronJobs },
    sessions: { sqlite, count: sessionCount },
    diagnostics: { typescript: tsAvailable, python: pyAvailable },
    problems,
  };

  if (!opts.apiKey) problems.push('No API key configured for the active provider.');
  if (!sqlite) problems.push('node:sqlite unavailable (Node >= 22.5) — sessions, code index, and search are off.');
  if (!opts.model) problems.push('No model selected for the active provider.');
  if (cronJobs > 0 && !opts.daemon?.running) problems.push(`${cronJobs} scheduled job(s) configured but the daemon is not running — they will not fire.`);
  return report;
}

/** Human-readable doctor output. */
export function formatDoctor(r: DoctorReport): string {
  const ok = (b: boolean) => (b ? 'ok   ' : 'MISS ');
  return [
    `Mochi doctor on node ${r.runtime.node}`,
    '',
    `  model         ${r.model.provider} @ ${r.model.baseUrl}  (${r.model.model})`,
    `  api key       ${ok(r.model.keySet)} ${r.model.keySource}`,
    `  sqlite        ${ok(r.runtime.sqlite)} ${r.runtime.sqlite ? 'node:sqlite available' : 'Node < 22.5 — sessions/index/search off'}`,
    `  codegraph     ${ok(r.index.codegraph === 'ready')} ${r.index.codegraph}`,
    `  sessions      ${ok(r.sessions.sqlite)} ${r.sessions.sqlite ? 'FTS5 enabled' : 'disabled'}`,
    `  daemon        ${ok(r.daemon.running)} ${r.daemon.running ? `running on :${r.daemon.port}` : 'not running'}`,
    `  diagnostics   TS:${r.diagnostics.typescript ? 'yes' : 'no'} Python:${r.diagnostics.python ? 'yes' : 'no'}`,
    '',
    ...(r.problems.length === 0 ? ['No problems detected.'] : [`Problems (${r.problems.length}):`, ...r.problems.map((p) => `  • ${p}`)]),
  ].join('\n');
}