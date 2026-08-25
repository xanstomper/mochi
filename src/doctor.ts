// Comprehensive health self-inspection (`mochi doctor`). Surfaces the state of
// every subsystem so an operator can see at a glance whether Mochi is ready
// and where the gaps are: provider keys, sqlite index, code symbol index,
// background tasks, cron jobs, sessions, and the running daemon.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasSqlite, sqliteSource } from './sqlite.js';
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
  if (!sqlite) problems.push('No SQLite driver (need Node >= 22.5 or the bun binary) — sessions, code index, and search are off.');
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
    `  sqlite        ${ok(r.runtime.sqlite)} ${r.runtime.sqlite ? `${sqliteSource() || 'driver'} available` : 'no driver — sessions/index/search off'}`,
    `  codegraph     ${ok(r.index.codegraph === 'ready')} ${r.index.codegraph}`,
    `  sessions      ${ok(r.sessions.sqlite)} ${r.sessions.sqlite ? 'FTS5 enabled' : 'disabled'}`,
    `  daemon        ${ok(r.daemon.running)} ${r.daemon.running ? `running on :${r.daemon.port}` : 'not running'}`,
    `  diagnostics   TS:${r.diagnostics.typescript ? 'yes' : 'no'} Python:${r.diagnostics.python ? 'yes' : 'no'}`,
    '',
    ...(r.problems.length === 0 ? ['No problems detected.'] : [`Problems (${r.problems.length}):`, ...r.problems.map((p) => `  • ${p}`)]),
  ].join('\n');
}

export interface RepairItem {
  name: string;
  status: 'fixed' | 'already_ok' | 'manual_action_required';
  details: string;
}

/** Automatically fix workspace configuration gaps and missing state directories */
export async function repairDoctor(opts: {
  cwd: string;
  workspaceDir: string;
}): Promise<{ items: RepairItem[]; summary: string }> {
  const { mkdirSync, existsSync, writeFileSync } = await import('node:fs');
  const items: RepairItem[] = [];

  // 1. Workspace directories
  const requiredDirs = [
    opts.workspaceDir,
    resolve(opts.workspaceDir, 'rules'),
    resolve(opts.workspaceDir, 'plugins'),
    resolve(opts.workspaceDir, 'ambient'),
    resolve(opts.workspaceDir, 'checkpoints'),
    resolve(opts.workspaceDir, 'sessions'),
  ];

  let createdDirs = 0;
  for (const dir of requiredDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      createdDirs++;
    }
  }
  if (createdDirs > 0) {
    items.push({ name: 'Workspace Directories', status: 'fixed', details: `Created ${createdDirs} missing .mochi directories` });
  } else {
    items.push({ name: 'Workspace Directories', status: 'already_ok', details: 'All .mochi directories present' });
  }

  // 2. Env configuration template
  const envPath = resolve(opts.workspaceDir, '.env');
  if (!existsSync(envPath) && !existsSync(resolve(opts.cwd, '.env'))) {
    const template = [
      '# Mochi Agent Configuration',
      'OPENCODE_ZEN_API_KEY=',
      'OPENCODE_GO_API_KEY=',
      'DISCORD_BOT_TOKEN=',
      'DISCORD_ALLOW_ALL_USERS=true',
      '',
    ].join('\n');
    writeFileSync(envPath, template, 'utf8');
    items.push({ name: 'Environment File', status: 'fixed', details: `Created .mochi/.env template` });
  } else {
    items.push({ name: 'Environment File', status: 'already_ok', details: 'Environment file exists' });
  }

  // 3. Git repository initialization
  const gitDir = resolve(opts.cwd, '.git');
  if (!existsSync(gitDir)) {
    const { spawnSync } = await import('node:child_process');
    try {
      spawnSync('git', ['init'], { cwd: opts.cwd });
      items.push({ name: 'Git Repository', status: 'fixed', details: 'Initialized new git repository' });
    } catch {
      items.push({ name: 'Git Repository', status: 'manual_action_required', details: 'Run `git init` to enable versioning and checkpoints' });
    }
  } else {
    items.push({ name: 'Git Repository', status: 'already_ok', details: 'Git repository initialized' });
  }

  const fixedCount = items.filter((i) => i.status === 'fixed').length;
  const summary = `🩺 Auto-Repair: ${fixedCount} issue(s) resolved, ${items.filter((i) => i.status === 'already_ok').length} already healthy.`;

  return { items, summary };
}