// Comprehensive health self-inspection (`mochi doctor`). Surfaces the state of
// every subsystem so an operator can see at a glance whether Mochi is ready
// and where the gaps are: provider keys, sqlite index, code symbol index,
// background tasks, cron jobs, sessions, and the running daemon.
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasSqlite, sqliteSource } from './sqlite.js';
import { listJobs } from './cron.js';
import { loadSkillFile, staleSkills, skillConflicts } from './skills.js';
import { SessionStore } from './session-store.js';
import { runRetention } from './retention.js';

export interface SkillHealthEntry {
  name: string;
  status: 'ok' | 'empty' | 'missing-frontmatter' | 'orphaned' | 'stale' | 'conflict';
  path: string;
}

export interface DoctorReport {
  version: string;
  providerReachable?: boolean;
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
  skills: { total: number; healthy: number; degraded: SkillHealthEntry[] };
  problems: string[];
}

/** Build a health report for a workspace. Pure and testable. */
export async function doctorReport(opts: {
  version?: string;
  probeProvider?: boolean;
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

  // Skill regression doctor (MCH-20): scan the skills directories for degraded
  // entries — empty files, missing frontmatter, or stale orphans.
  const candidateDirs = [
    resolve(opts.workspaceDir, 'skills'),
    resolve(opts.workspaceDir, '.mochi', 'skills'),
  ];
  const degradedSkills: SkillHealthEntry[] = [];
  const visitedPaths = new Set<string>();
  let totalSkills = 0;
  const allDiscoveredSkills: import('./skills.js').Skill[] = [];

  for (const sDir of candidateDirs) {
    if (!existsSync(sDir)) continue;
    const checkFile = (skillPath: string, name: string) => {
      if (visitedPaths.has(skillPath)) return;
      visitedPaths.add(skillPath);
      totalSkills++;
      let raw = '';
      try { raw = readFileSync(skillPath, 'utf8'); } catch { raw = ''; }
      const size = (() => { try { return statSync(skillPath).size; } catch { return 0; } })();
      if (size === 0 || raw.trim().length === 0) {
        degradedSkills.push({ name, status: 'empty', path: skillPath });
      } else if (!raw.includes('name:') && !raw.startsWith('---')) {
        degradedSkills.push({ name, status: 'missing-frontmatter', path: skillPath });
      } else {
        const parsed = loadSkillFile(skillPath).skill;
        if (parsed) allDiscoveredSkills.push(parsed);
      }
    };

    const walk = (dir: string) => {
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (entry.startsWith('.') || /^readme(?:\.md)?$/i.test(entry)) continue;
        const full = resolve(dir, entry);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          const nestedSkill = resolve(full, 'SKILL.md');
          if (existsSync(nestedSkill)) {
            checkFile(nestedSkill, entry);
          } else {
            walk(full);
          }
        } else if (entry.endsWith('.md') || entry.endsWith('.yaml') || entry.endsWith('.yml')) {
          checkFile(full, entry);
        }
      }
    };
    walk(sDir);
  }
  const healthySkills = totalSkills - degradedSkills.length;

  // MCH-34: provider reachability — a key being SET says nothing about the
  // endpoint actually answering. One cheap models-list ping (2s budget) so
  // 'mochi doctor' catches dead endpoints, not just missing env vars.
  let providerReachable: boolean | undefined;
  if (opts.probeProvider && opts.baseUrl && (opts.apiKey || opts.provider === 'ollama' || opts.provider === 'llamacpp')) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      const res = await fetch(new URL('models', opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/').href, { signal: ctl.signal, headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {} });
      clearTimeout(t);
      providerReachable = res.ok;
    } catch {
      providerReachable = false;
    }
    if (providerReachable === false) problems.push(`Provider endpoint ${opts.baseUrl} did not answer within 2s — runs will stall/fail over.`);
  }

  // MCH-40 (skills v2): staleness + semantic conflicts across ALL skills found.
  const staleList = staleSkills(allDiscoveredSkills);
  const conflicts = skillConflicts(allDiscoveredSkills);
  for (const n of staleList) degradedSkills.push({ name: n, status: 'stale' as SkillHealthEntry['status'], path: '' });
  for (const c of conflicts) degradedSkills.push({ name: `${c.a} ~ ${c.b}`, status: 'conflict' as SkillHealthEntry['status'], path: '' });
  if (staleList.length > 0) problems.push(`${staleList.length} skill(s) stale (>90d): ${staleList.slice(0, 5).join(', ')}.`);
  if (conflicts.length > 0) problems.push(`${conflicts.length} skill conflict(s) (>0.8 overlap): ${conflicts.slice(0, 3).map((c) => c.a + ' ~ ' + c.b).join(', ')}.`);

  const report: DoctorReport = {
    version: opts.version ?? 'unknown',
    providerReachable,
    runtime: { node: process.version, sqlite },
    model: { provider: opts.provider, keySet: Boolean(opts.apiKey), keySource: opts.apiKey ? 'env/config' : 'unset', baseUrl: opts.baseUrl, model: opts.model },
    index: { sqlite, codegraph: sqlite ? 'ready' : 'unavailable' },
    daemon: { running: opts.daemon?.running ?? false, port: opts.daemon?.port, jobs: cronJobs },
    cron: { jobs: cronJobs },
    sessions: { sqlite, count: sessionCount },
    diagnostics: { typescript: tsAvailable, python: pyAvailable },
    skills: { total: totalSkills, healthy: healthySkills, degraded: degradedSkills },
    problems,
  };

  if (!opts.apiKey && opts.provider !== 'ollama' && opts.provider !== 'llamacpp') {
    problems.push('No API key configured for the active provider.');
  }
  if (!sqlite) problems.push('No SQLite driver (need Node >= 22.5 or the bun binary) — sessions, code index, and search are off.');
  if (!opts.model) problems.push('No model selected for the active provider.');
  if (cronJobs > 0 && !opts.daemon?.running) problems.push(`${cronJobs} scheduled job(s) configured but the daemon is not running — they will not fire.`);
  if (degradedSkills.length > 0) {
    for (const s of degradedSkills) {
      problems.push(`Skill "${s.name}" is degraded (${s.status}): ${s.path}`);
    }
  }
  return report;
}

/** Human-readable doctor output. */
export function formatDoctor(r: DoctorReport): string {
  const ok = (b: boolean) => (b ? 'ok   ' : 'MISS ');
  const skillLine = r.skills.total === 0
    ? 'no skills installed'
    : `${r.skills.healthy}/${r.skills.total} healthy${r.skills.degraded.length > 0 ? ` (${r.skills.degraded.length} degraded)` : ''}`;
  return [
    `Mochi doctor v${r.version} on node ${r.runtime.node}`,
    '',
    `  model         ${r.model.provider} @ ${r.model.baseUrl}  (${r.model.model})`,
    `  api key       ${ok(r.model.keySet)} ${r.model.keySource}`,
    `  reachability  ${r.providerReachable === undefined ? 'n/a (use --probe)' : r.providerReachable ? 'ok    endpoint answers' : 'MISS  endpoint did not answer (2s)'}`,
    `  sqlite        ${ok(r.runtime.sqlite)} ${r.runtime.sqlite ? `${sqliteSource() || 'driver'} available` : 'no driver — sessions/index/search off'}`,
    `  codegraph     ${ok(r.index.codegraph === 'ready')} ${r.index.codegraph}`,
    `  sessions      ${ok(r.sessions.sqlite)} ${r.sessions.sqlite ? 'FTS5 enabled' : 'disabled'}`,
    `  daemon        ${ok(r.daemon.running)} ${r.daemon.running ? `running on :${r.daemon.port}` : 'not running'}`,
    `  diagnostics   TS:${r.diagnostics.typescript ? 'yes' : 'no'} Python:${r.diagnostics.python ? 'yes' : 'no'}`,
    `  skills        ${ok(r.skills.degraded.length === 0)} ${skillLine}`,
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

  // 4. Disk retention / GC: prune stale session state and traces (>14 days)
  const retentionResult = runRetention({ workspaceDir: opts.workspaceDir, maxAgeDays: 14 });
  const retentionFixed = (retentionResult.state.deletedFiles + retentionResult.traces.deletedFiles) > 0;
  const freedMB = (retentionResult.state.freedBytes + retentionResult.traces.freedBytes) / (1024 * 1024);
  items.push({
    name: 'Disk Retention',
    status: retentionFixed ? 'fixed' : 'already_ok',
    details: retentionFixed
      ? `Cleaned ${retentionResult.state.deletedFiles + retentionResult.traces.deletedFiles} stale files (${freedMB.toFixed(1)} MB freed)`
      : 'No stale session/traces files to clean',
  });

  const fixedCount = items.filter((i) => i.status === 'fixed').length;
  const summary = `🩺 Auto-Repair: ${fixedCount} issue(s) resolved, ${items.filter((i) => i.status === 'already_ok').length} already healthy.`;

  return { items, summary };
}