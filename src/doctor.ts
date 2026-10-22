// Comprehensive health self-inspection (`mochi doctor`). Surfaces the state of
// every subsystem so an operator can see at a glance whether Mochi is ready
// and where the gaps are: provider keys, sqlite index, code symbol index,
// background tasks, cron jobs, sessions, and the running daemon.
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hasSqlite, sqliteSource } from './sqlite.js';
import { listJobs } from './daemon/cron.js';
import { loadSkillFile, staleSkills, skillConflicts } from './skills/skills.js';
import { SessionStore } from './state/session-store.js';
import { runRetention } from './memory/retention.js';
import { loadSavedTheme, getTheme, getCurrentTheme } from './tui/themes.js';
import { mochiStateDir } from './core/mochi-dir.js';

export interface SkillHealthEntry {
  name: string;
  status: 'ok' | 'empty' | 'missing-frontmatter' | 'orphaned' | 'stale' | 'conflict';
  path: string;
}

export interface DoctorReport {
  version: string;
  providerReachable?: boolean;
  runtime: { engine: string; node: string; sqlite: boolean };
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
  harness: { openIssues: number };
  /** Flaky-test quarantine registry (.mochi/state/flaky-tests.json):
   *  tracked = every test ever observed flaking (post-decay); quarantined =
   *  score >= threshold — still run, but non-blocking and excluded from
   *  mutation checks. */
  flaky: { tracked: number; quarantined: number; tests: Array<{ id: string; score: number; flakeEvents: number; lastSeenAt: number }> };
  theme: { id: string; name: string; stuck: boolean };
  diagnostics: { typescript: boolean; python: boolean };
  sandbox: { bubblewrap: boolean };
  browser: { driver: boolean; browsers: string[] };
  skills: { total: number; healthy: number; degraded: SkillHealthEntry[] };
  acp?: { ok: boolean; detail: string };
  editors?: { vscodeInstalled: boolean; jetbrainsPluginPresent: boolean; vscodeCli: boolean };
  onboarding?: { done: boolean };
  ambientAuth: Array<{ provider: string; source: string; expiresAtMs?: number }>;
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
      if (existsSync(resolve(process.cwd(), 'node_modules', 'typescript'))) return true;
      if (existsSync(resolve(homedir(), '.npm-global', 'bin', 'tsc'))) return true;
      execFileSync('tsc', ['--version'], { timeout: 2000, stdio: 'ignore' });
      return true;
    } catch { return false; }
  })();
  const pyAvailable = ['/usr/bin/python3', '/usr/bin/python', '/opt/homebrew/bin/python3'].some((p) => existsSync(p));
  let bubblewrap = false;
  try {
    const { detectBubblewrap } = await import('./exec.js');
    bubblewrap = detectBubblewrap() !== null;
  } catch { /* exec module unavailable: report unavailable */ }
  // Browser driver probe: playwright present + downloaded browser binaries.
  // Runs the driver's no-launch `probe` (never opens a window). The driver is
  // a plain node script: run it with node from PATH when available, else fall
  // back to the current executable (works for node dist/cli.js and for the
  // bun-compiled binary, which also runs plain JS — but NEVER assume
  // process.execPath is node, or doctor spawns a second agent instead!).
  let browserDriver = false;
  let browsers: string[] = [];
  try {
    const { execFile: ef } = await import('node:child_process');
    const { resolve: rp, dirname: dn } = await import('node:path');
    const { fileURLToPath: ffp } = await import('node:url');
    // Candidate driver locations: under a bun-compiled binary import.meta
    // does not point at the real dist tree, so also try the executable's
    // directory (dist/mochi-bin -> <root>/scripts/...).
    const candidates = [
      rp(dn(ffp(import.meta.url)), '..', 'scripts', 'browser-driver.mjs'),
      rp(dn(process.execPath), '..', 'scripts', 'browser-driver.mjs'),
    ];
    const driver = candidates.find((p) => { try { return existsSync(p); } catch { return false; } });
    if (!driver) throw new Error('browser driver script not found');
    const runners = ['node', process.execPath];
    let out = '';
    for (const runner of runners) {
      try {
        out = await new Promise<string>((resolve2, reject2) => {
          ef(runner, [driver, 'probe'], { timeout: 20_000 }, (err, stdout) => {
            if (err) reject2(err);
            else resolve2(String(stdout ?? ''));
          });
        });
        if (out.includes('{')) break;
        out = '';
      } catch { /* try the next runner */ }
    }
    const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { ok?: boolean; browsers?: string[] };
    if (parsed && parsed.ok) {
      browserDriver = true;
      browsers = Array.isArray(parsed.browsers) ? parsed.browsers : [];
    }
  } catch { /* driver missing/broken: report unavailable */ }

  // Real subsystem counts from the workspace's `.mochi/` state. `workspaceDir`
  // is a project root from the CLI, but accept either form so the report can
  // never read from the wrong (or a nested) location.
  const stateDir = mochiStateDir(opts.workspaceDir);
  const cronJobs = listJobs(stateDir).length;
  let sessionCount = 0;
  {
    try {
      const store = new SessionStore(stateDir);
      try { sessionCount = store.list().length; } finally { store.close(); }
    } catch { /* store not initialised yet */ }
  }
  let harnessOpenIssues = 0;
  try {
    const { listHarnessIssues } = await import('./core/harness-issues.js');
    harnessOpenIssues = listHarnessIssues(stateDir, { status: 'open' }).length;
  } catch { /* best-effort */ }

  // Flaky-test quarantine: stateDir here is the `.mochi` dir itself, so the
  // Workspace root is its parent. Read-only — the doctor never mutates the
  // registry (decay is applied in memory for display).
  let flakySection: DoctorReport['flaky'] = { tracked: 0, quarantined: 0, tests: [] };
  try {
    const { flakyQuarantineReport } = await import('./core/flaky.js');
    const { Workspace } = await import('./workspace.js');
    const rep = flakyQuarantineReport(new Workspace(resolve(stateDir, '..'), '.mochi'));
    flakySection = {
      tracked: rep.tracked,
      quarantined: rep.quarantined.length,
      tests: rep.entries.map((e) => ({ id: e.id, score: e.score, flakeEvents: e.flakeEvents, lastSeenAt: e.lastSeenAt })),
    };
  } catch { /* best-effort: registry absent or unreadable */ }

  // Skill regression doctor (MCH-20): scan the skills directories for degraded
  // entries — empty files, missing frontmatter, or stale orphans.
  const candidateDirs = [
    resolve(opts.workspaceDir, 'skills'),
    resolve(stateDir, 'skills'),
  ];
  const degradedSkills: SkillHealthEntry[] = [];
  const visitedPaths = new Set<string>();
  let totalSkills = 0;
  const allDiscoveredSkills: import('./skills/skills.js').Skill[] = [];

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
    // The true engine, not process.version: the compiled Bun binary reports a
    // Node-compatible `process.version` (v24.x) while running Bun — printing
    // "on node v24.3.0" from the standalone binary was simply false and read
    // as "Mochi runs under Node" in every doctor screenshot.
    runtime: {
      engine: (process.versions as Record<string, string | undefined>).bun
        ? `bun ${(process.versions as Record<string, string | undefined>).bun}`
        : `node ${process.version}`,
      node: process.version,
      sqlite,
    },
    model: { provider: opts.provider, keySet: Boolean(opts.apiKey), keySource: opts.apiKey ? 'env/config' : 'unset', baseUrl: opts.baseUrl, model: opts.model },
    index: { sqlite, codegraph: sqlite ? 'ready' : 'unavailable' },
    daemon: { running: opts.daemon?.running ?? false, port: opts.daemon?.port, jobs: cronJobs },
    cron: { jobs: cronJobs },
    sessions: { sqlite, count: sessionCount },
    harness: { openIssues: harnessOpenIssues },
    flaky: flakySection,
  theme: currentThemeInfo(),
    diagnostics: { typescript: tsAvailable, python: pyAvailable },
    sandbox: { bubblewrap },
    browser: { driver: browserDriver, browsers },
    skills: { total: totalSkills, healthy: healthySkills, degraded: degradedSkills },
    acp: await acpHealth(),
    editors: editorHealth(),
    onboarding: onboardingHealth(),
    ambientAuth: await ambientAuthHealth(),
    problems,
  };

  if (!opts.apiKey && opts.provider !== 'ollama' && opts.provider !== 'llamacpp') {
    problems.push('No API key configured for the active provider.');
  }
  if (!sqlite) problems.push('No SQLite driver (need Node >= 22.5 or the bun binary) — conversation history runs on the JSON fallback; the code index and FTS search are off.');
  if (!opts.model) problems.push('No model selected for the active provider.');
  if (cronJobs > 0 && !opts.daemon?.running) problems.push(`${cronJobs} scheduled job(s) configured but the daemon is not running — they will not fire.`);
  if (degradedSkills.length > 0) {
    for (const s of degradedSkills) {
      problems.push(`Skill "${s.name}" is degraded (${s.status}): ${s.path}`);
    }
  }
  if (flakySection.quarantined > 0) {
    problems.push(`${flakySection.quarantined} test(s) quarantined as flaky (score >= 2 in .mochi/state/flaky-tests.json): ${flakySection.tests.filter((t) => t.score >= 2).slice(0, 3).map((t) => t.id).join(', ')}. They still run, but no longer block verification or feed mutation checks — fix or delete them to restore full signal.`);
  }
  if (report.acp && !report.acp.ok) problems.push(`ACP bridge broken: ${report.acp.detail} — editors (VS Code/JetBrains) will fail. Run \`mochi acp --check\`.`);
  if (report.onboarding && !report.onboarding.done) problems.push('First-run setup not completed — run `mochi onboard --yes` to wire providers/skills/MCPs.');
  return report;
}

/** ACP bridge health (in-process lifecycle, no spawn). Best-effort, never throws. */
async function acpHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { acpCheck } = await import('./acp.js');
    const r = await acpCheck(process.cwd());
    return { ok: r.ok, detail: r.report };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Editor integration health: VS Code/Cursor CLI present? JetBrains plugin sources shipped? */
function editorHealth(): { vscodeInstalled: boolean; jetbrainsPluginPresent: boolean; vscodeCli: boolean } {
  let vscodeCli = false;
  for (const bin of ['code', 'cursor']) {
    try {
      execFileSync(bin, ['--version'], { timeout: 3000, stdio: 'ignore' });
      vscodeCli = true;
      break;
    } catch { /* try next */ }
  }
  // This build ships editor sources under <root>/editors (npm tarball may exclude them).
  let jetbrainsPluginPresent = false;
  let vscodeInstalled = false;
  try {
    const candidates = [
      resolve(process.cwd(), 'editors'),
      resolve(homedir(), 'mochi', 'editors'),
      resolve(dirname(process.execPath), '..', 'editors'),
    ];
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      candidates.push(resolve(here, '..', '..', 'editors'));
    } catch { /* virtual fs */ }
    for (const c of candidates) {
      if (!vscodeInstalled && existsSync(resolve(c, 'vscode', 'package.json'))) vscodeInstalled = true;
      if (!jetbrainsPluginPresent && existsSync(resolve(c, 'jetbrains', 'build.gradle.kts'))) jetbrainsPluginPresent = true;
    }
  } catch { /* best-effort */ }
  return { vscodeInstalled, jetbrainsPluginPresent, vscodeCli };
}

/** Onboarding marker health. */
/** Ambient OAuth from other real CLIs (Codex/Gemini/Claude/gcloud). */
async function ambientAuthHealth(): Promise<Array<{ provider: string; source: string; expiresAtMs?: number }>> {
  const out: Array<{ provider: string; source: string; expiresAtMs?: number }> = [];
  try {
    const { codexAmbientToken, geminiAmbientToken, claudeAmbientToken, gcloudAmbientToken, antigravityAmbientToken, githubAmbientToken, huggingfaceAmbientToken } = await import('./model/ambient-auth.js');
    const codex = await codexAmbientToken();
    if (codex) out.push({ provider: 'openai', source: codex.source, expiresAtMs: codex.expiresAtMs });
    const gemini = geminiAmbientToken() ?? (await gcloudAmbientToken());
    if (gemini) out.push({ provider: 'gemini/google', source: gemini.source, expiresAtMs: gemini.expiresAtMs });
    const claude = claudeAmbientToken();
    if (claude) out.push({ provider: 'anthropic', source: claude.source, expiresAtMs: claude.expiresAtMs });
    const antigravity = await antigravityAmbientToken();
    if (antigravity) out.push({ provider: 'antigravity', source: antigravity.source, expiresAtMs: antigravity.expiresAtMs });
    const gh = await githubAmbientToken();
    if (gh) out.push({ provider: 'github-models', source: gh.source, expiresAtMs: gh.expiresAtMs });
    const hf = huggingfaceAmbientToken();
    if (hf) out.push({ provider: 'huggingface', source: hf.source, expiresAtMs: hf.expiresAtMs });
  } catch { /* best-effort */ }
  return out;
}

function onboardingHealth(): { done: boolean } {
  try {
    return { done: existsSync(join(homedir(), '.config', 'mochi', 'onboarded.json')) };
  } catch {
    return { done: false };
  }
}

/** Live UI theme info. `stuck` is true when the saved theme id is not
 *  registered in THIS build (stale binary still running) — the user must
 *  relaunch for theming fixes to take effect. */
export function currentThemeInfo(): { id: string; name: string; stuck: boolean } {
  try {
    const saved = loadSavedTheme();
    const live = getCurrentTheme();
    const known = getTheme(saved.id);
    return { id: live.id, name: live.name, stuck: !known };
  } catch {
    return { id: 'unknown', name: 'unknown', stuck: false };
  }
}

/** Human-readable doctor output. */
export function formatDoctor(r: DoctorReport): string {
  const ok = (b: boolean) => (b ? 'ok   ' : 'MISS ');
  const skillLine = r.skills.total === 0
    ? 'no skills installed'
    : `${r.skills.healthy}/${r.skills.total} healthy${r.skills.degraded.length > 0 ? ` (${r.skills.degraded.length} degraded)` : ''}`;
  return [
    `Mochi doctor v${r.version} on ${r.runtime.engine ?? `node ${r.runtime.node}`}${process.env.MOCHI_LAUNCHER === 'rust' ? ' (rust launcher)' : ''}`,
    '',
    `  model         ${r.model.provider} @ ${r.model.baseUrl}  (${r.model.model})`,
    `  api key       ${ok(r.model.keySet)} ${r.model.keySource}`,
    `  reachability  ${r.providerReachable === undefined ? 'n/a (use --probe)' : r.providerReachable ? 'ok    endpoint answers' : 'MISS  endpoint did not answer (2s)'}`,
    `  sqlite        ${ok(r.runtime.sqlite)} ${r.runtime.sqlite ? `${sqliteSource() || 'driver'} available` : 'no driver — code index/search off, sessions on JSON fallback'}`,
    `  codegraph     ${ok(r.index.codegraph === 'ready')} ${r.index.codegraph}`,
    `  sessions      ${ok(true)} ${r.sessions.sqlite ? `FTS5 enabled (${r.sessions.count})` : `JSON fallback (${r.sessions.count})`}`,
    `  harness       ${ok(r.harness.openIssues === 0)} ${r.harness.openIssues === 0 ? 'no open issues' : `${r.harness.openIssues} open issue(s) — run mochi selfheal`}`,
    `  flaky tests   ${ok(r.flaky.quarantined === 0)} ${r.flaky.tracked === 0 ? 'none tracked' : `${r.flaky.tracked} tracked, ${r.flaky.quarantined} quarantined (still run; non-blocking)`}`,
    `  daemon        ${ok(r.daemon.running)} ${r.daemon.running ? `running on :${r.daemon.port}` : 'not running'}`,
    `  diagnostics   TS:${r.diagnostics.typescript ? 'yes' : 'no'} Python:${r.diagnostics.python ? 'yes' : 'no'}`,
    `  sandbox       ${r.sandbox.bubblewrap ? 'ok    bubblewrap available (safety.sandbox / shell sandbox:true)' : 'MISS  no bwrap (sandbox unavailable)'}`,
    `  browser       ${r.browser.driver && r.browser.browsers.length > 0 ? `ok    playwright + ${r.browser.browsers.join(', ')}` : r.browser.driver ? 'MISS  playwright present but no browser binaries (npx playwright install)' : 'MISS  browser driver unavailable (npm i -g playwright)'}`,
    `  skills        ${ok(r.skills.degraded.length === 0)} ${skillLine}`,
    `  acp           ${r.acp ? (r.acp.ok ? 'ok    bridge verified (editors will work)' : `MISS  ${r.acp.detail.slice(0, 90)}`) : 'n/a'}`,
    `  vscode        ${r.editors ? (r.editors.vscodeCli ? 'ok    `code`/`cursor` CLI on PATH' : r.editors.vscodeInstalled ? 'ok    extension sources shipped (`mochi setup vscode`)' : 'MISS  no editor CLI and no shipped sources') : 'n/a'}`,
    `  jetbrains     ${r.editors ? (r.editors.jetbrainsPluginPresent ? 'ok    plugin sources shipped (`mochi setup jetbrains`)' : 'MISS  plugin sources not in this install') : 'n/a'}`,
    `  onboard       ${r.onboarding ? (r.onboarding.done ? 'ok    first-run setup completed' : 'MISS  run `mochi onboard --yes`') : 'n/a'}`,
    `  theme         ${r.theme.id} (${r.theme.name})${r.theme.stuck ? '  STUCK — relaunch the TUI to pick up theming fixes' : ''}`,
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
  // Normalize so callers may pass either the project root or the state dir.
  const stateDir = mochiStateDir(opts.workspaceDir);

  // 1. Workspace directories
  const requiredDirs = [
    stateDir,
    resolve(stateDir, 'rules'),
    resolve(stateDir, 'plugins'),
    resolve(stateDir, 'ambient'),
    resolve(stateDir, 'checkpoints'),
    resolve(stateDir, 'sessions'),
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
  const envPath = resolve(stateDir, '.env');
  if (!existsSync(envPath) && !existsSync(resolve(opts.cwd, '.env'))) {
    const template = [
      '# Mochi Agent Configuration',
      'OPENCODE_ZEN_API_KEY=',
      'OPENCODE_GO_API_KEY=',
      'DISCORD_BOT_TOKEN=',
      'DISCORD_ALLOW_ALL_USERS=true',
      'TELEGRAM_BOT_TOKEN=',
      'TELEGRAM_ALLOW_ALL_USERS=true',
      'SLACK_BOT_TOKEN=',
      'SLACK_CHANNEL=',
      'BLUEBUBBLES_SERVER_URL=',
      'BLUEBUBBLES_PASSWORD=',
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
  const retentionResult = runRetention({ workspaceDir: stateDir, maxAgeDays: 60 });
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