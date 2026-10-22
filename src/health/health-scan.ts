// Proactive repo health scan (Wave O3) — the agent that tells you what's
// wrong before you ask. A bounded, READ-ONLY scan of the user's repo that
// produces a ranked, evidence-backed health digest:
//
//   tests     — the repo's own test command on HEAD (cached by HEAD hash)
//   deps      — lockfile age + an offline-safe outdated probe
//   todos     — TODO/FIXME/HACK density and delta since the last scan
//   dead-code — conservative import-graph heuristic (labelled heuristic)
//   hotspots  — git churn × file size risk surface
//
// Every check is bounded (time/file budgets) and SKIPPABLE: missing tooling
// is reported as 'skipped: <reason>', never as an error and never as a
// finding. Every finding carries the command/output evidence that produced
// it and an expiry — findings live in .mochi/health/state.json and are
// mirrored into project memory as [health]-tagged facts; a finding that
// stops being detected is resolved, and one whose check could not run is
// dropped at expiry, so stale findings expire instead of haunting.
//
// The scan NEVER mutates the scanned tree: all state lands under .mochi/
// (Mochi's own state dir) and every command run is read-only w.r.t. the
// repo (the repo's own test command is the user's command — it runs in the
// repo exactly as the user would run it, which is the point of the check).
//
// Delivery: the digest renders into the sleeptime morning report via
// createHealthScanStep (health-step.ts), is printable on demand via
// `mochi health`, and the top findings are synced to project memory.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { mochiStateDir } from '../core/mochi-dir.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import { projectMemoryPath, recordProjectMemory } from '../memory/project-memory.js';

// ─── Types ───────────────────────────────────────────────────────────────

export type HealthSeverity = 'high' | 'medium' | 'low' | 'info';
/** measured = a command ran and its output is the evidence; observed = a
 *  deterministic count/read of repo state; heuristic = a fallible inference
 *  (dead code) — ranked below measured evidence at equal severity. */
export type EvidenceStrength = 'measured' | 'observed' | 'heuristic';
export type HealthCheckId = 'tests' | 'deps' | 'todos' | 'dead-code' | 'hotspots';
export type HealthCheckStatus = 'ok' | 'findings' | 'skipped';

export interface HealthFinding {
  /** Stable across scans for the same check+subject, so persistence and
   *  expiry can be tracked (e.g. 'tests:failing', 'dead-code:src/dead.ts'). */
  id: string;
  check: HealthCheckId;
  severity: HealthSeverity;
  evidenceStrength: EvidenceStrength;
  title: string;
  /** The command/output evidence, trimmed for the digest. */
  evidence: string;
  suggestedAction: string;
  /** Rank score (severity × evidence + persistence bonus), higher first. */
  score: number;
  firstSeenAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface HealthCheckReport {
  id: HealthCheckId;
  status: HealthCheckStatus;
  /** One-line outcome for the digest footer ('tests green (41 passed)'). */
  note: string;
}

export interface HealthScanResult {
  kind: 'mochi-health-scan';
  version: 1;
  projectDir: string;
  scannedAt: string;
  head: string | null;
  checks: HealthCheckReport[];
  /** Ranked, highest first. */
  findings: HealthFinding[];
  allClear: boolean;
  /** True when the tests check reused the HEAD-keyed cache. */
  testsCached: boolean;
  /** Stored findings dropped this scan because their check now passes. */
  resolvedCount: number;
  /** Stored findings dropped this scan because they expired undetected. */
  expiredCount: number;
  /** One-line summary (the sleeptime unit detail / CLI headline). */
  headline: string;
  /** Full markdown digest. */
  digest: string;
  paths: { state: string; lastScan: string; digest: string };
}

interface StoredTestCache {
  head: string;
  command: string;
  exitCode: number;
  passed?: number;
  failed?: number;
  timedOut: boolean;
  ranAt: number;
}

interface HealthState {
  version: 1;
  lastScanAt: number;
  head: string | null;
  testCache?: StoredTestCache;
  todoTotal?: number;
  findings: HealthFinding[];
}

// ─── Command execution (injectable for tests) ────────────────────────────

export interface CommandResult {
  code: number;
  out: string;
  timedOut: boolean;
}

export type CommandRunner = (cmd: string, cwd: string, timeoutMs: number) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (cmd, cwd, timeoutMs) =>
  new Promise((res) => {
    execFile('sh', ['-c', cmd], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      const code = e && typeof e.code === 'number' ? e.code : e ? 1 : 0;
      res({ code, out: `${stdout ?? ''}\n${stderr ?? ''}`, timedOut: !!e?.killed && code !== 0 });
    });
  });

// ─── Options ─────────────────────────────────────────────────────────────

export interface HealthScanOptions {
  /** Injectable clock (tests). */
  now?: Date;
  /** Injectable command runner (tests). */
  runner?: CommandRunner;
  /** Hard budget for the repo's test command. Default 120s. */
  testBudgetMs?: number;
  /** Hard budget for the dependency probe. Default 25s. */
  probeBudgetMs?: number;
  /** Force the test command to run even when HEAD is unchanged. */
  forceTests?: boolean;
  /** Never run the network-shaped probe; report 'skipped: offline'. */
  offline?: boolean;
  /** Lockfile age (days) at which staleness becomes a finding. Default 90. */
  lockfileStaleDays?: number;
  /** TODO growth since last scan that becomes a finding. Default 5. */
  todoGrowthThreshold?: number;
  /** Absolute TODO total that becomes a finding. Default 100. */
  todoTotalThreshold?: number;
  /** Mirror findings into project memory as [health] facts. Default true. */
  recordFacts?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Per-check finding TTLs: test failures go stale fast (they get fixed or
 *  the world moves on); structural findings live longer. */
export const FINDING_TTL_DAYS: Record<HealthCheckId, number> = {
  tests: 3,
  deps: 7,
  todos: 14,
  'dead-code': 14,
  hotspots: 14,
};

const SEVERITY_WEIGHT: Record<HealthSeverity, number> = { high: 100, medium: 50, low: 20, info: 5 };
const EVIDENCE_WEIGHT: Record<EvidenceStrength, number> = { measured: 1, observed: 0.75, heuristic: 0.45 };

function rankScore(severity: HealthSeverity, evidence: EvidenceStrength, persisted: boolean): number {
  return Math.round(SEVERITY_WEIGHT[severity] * EVIDENCE_WEIGHT[evidence] + (persisted ? 5 : 0));
}

// ─── Paths / state ───────────────────────────────────────────────────────

export function healthDir(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'health');
}
export function healthStatePath(projectDir: string): string {
  return join(healthDir(projectDir), 'state.json');
}

function loadState(projectDir: string): HealthState {
  try {
    const p = healthStatePath(projectDir);
    if (!existsSync(p)) return { version: 1, lastScanAt: 0, head: null, findings: [] };
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as HealthState;
    if (parsed.version !== 1 || !Array.isArray(parsed.findings)) {
      return { version: 1, lastScanAt: 0, head: null, findings: [] };
    }
    return parsed;
  } catch {
    return { version: 1, lastScanAt: 0, head: null, findings: [] };
  }
}

function saveState(projectDir: string, state: HealthState): void {
  mkdirSync(healthDir(projectDir), { recursive: true });
  atomicWriteFileSync(healthStatePath(projectDir), JSON.stringify(state, null, 2) + '\n');
}

// ─── Repo facts (git + file enumeration) ─────────────────────────────────

interface RepoFacts {
  head: string | null;
  /** Tracked (or walked) files, relative POSIX paths. */
  files: string[];
  isGit: boolean;
}

async function gatherRepoFacts(dir: string, runner: CommandRunner): Promise<RepoFacts> {
  const headRes = await runner('git rev-parse HEAD', dir, 10_000);
  const head = headRes.code === 0 ? headRes.out.trim().split('\n')[0] || null : null;
  if (head) {
    const ls = await runner('git ls-files -z', dir, 15_000);
    if (ls.code === 0) {
      // ls-files lists tracked paths, including ones deleted from the
      // working tree — the scan describes the tree as it IS, so only
      // files that exist on disk are enumerated.
      const files = ls.out.split('\0').filter(Boolean).slice(0, 20_000)
        .filter((f) => existsSync(join(dir, f)));
      return { head, files, isGit: true };
    }
  }
  // Not a git repo (or git absent): bounded walk, skipping state/vendor dirs.
  const files: string[] = [];
  const skip = new Set(['.git', 'node_modules', '.mochi', 'dist', 'build', 'target', '.next']);
  const walk = (cur: string): void => {
    if (files.length >= 5_000) return;
    let entries: string[];
    try { entries = readdirSync(cur); } catch { return; }
    for (const name of entries) {
      if (files.length >= 5_000) return;
      if (skip.has(name)) continue;
      const full = join(cur, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push(relative(dir, full));
    }
  };
  walk(dir);
  return { head: null, files, isGit: false };
}

// ─── Check: tests on HEAD ────────────────────────────────────────────────

/** Detect the repo's test command. Mirrors ambient.ts's package.json
 *  handling; pytest/cargo fallbacks by marker file. */
export function detectTestCommand(dir: string): { cmd: string; ecosystem: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) {
      return { cmd: pkg.scripts.test.startsWith('npm ') ? pkg.scripts.test : 'npm test', ecosystem: 'node' };
    }
  } catch { /* no package.json */ }
  if (existsSync(join(dir, 'Cargo.toml'))) return { cmd: 'cargo test', ecosystem: 'rust' };
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'setup.py'))) {
    return { cmd: 'python3 -m pytest -q', ecosystem: 'python' };
  }
  return null;
}

/** Best-effort pass/fail extraction for the common runners (vitest, jest,
 *  pytest, go test). Unknown formats yield undefined counts — the exit
 *  code remains the evidence. */
export function parseTestCounts(out: string): { passed?: number; failed?: number } {
  const vitest = out.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/);
  if (vitest) return { ...(vitest[1] ? { failed: Number(vitest[1]) } : {}), passed: Number(vitest[2]) };
  const jest = out.match(/Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed/);
  if (jest) return { ...(jest[1] ? { failed: Number(jest[1]) } : {}), passed: Number(jest[2]) };
  const failedMatches = [...out.matchAll(/(\d+)\s+failed/g)];
  const passedMatches = [...out.matchAll(/(\d+)\s+passed/g)];
  const failed = failedMatches.length ? Number(failedMatches[failedMatches.length - 1][1]) : undefined;
  const passed = passedMatches.length ? Number(passedMatches[passedMatches.length - 1][1]) : undefined;
  return { ...(failed !== undefined ? { failed } : {}), ...(passed !== undefined ? { passed } : {}) };
}

function countsText(c: { passed?: number; failed?: number }): string {
  const bits: string[] = [];
  if (c.failed !== undefined) bits.push(`${c.failed} failed`);
  if (c.passed !== undefined) bits.push(`${c.passed} passed`);
  return bits.join(', ');
}

function tailEvidence(out: string, maxChars = 280): string {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-3).join(' · ').slice(0, maxChars);
}

// ─── Check: dependencies ─────────────────────────────────────────────────

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'Gemfile.lock'];
const NETWORK_ERR = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|registry|getaddrinfo|socket hang up/i;

interface DepsOutcome {
  report: HealthCheckReport;
  raw: Omit<HealthFinding, 'score' | 'firstSeenAt' | 'lastSeenAt' | 'expiresAt'>[];
}

// ─── Check: TODO markers ─────────────────────────────────────────────────

const MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b/g;

// ─── Check: dead code (heuristic) ────────────────────────────────────────

const SRC_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const ENTRYPOINT_NAMES = new Set(['cli.ts', 'cli.tsx', 'main.ts', 'main.tsx', 'main.js', 'index.ts', 'index.tsx', 'index.js', 'index.mts', 'index.mjs']);
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveImport(fromFile: string, spec: string, fileSet: Set<string>): string | null {
  const base = join(dirname(fromFile), spec);
  const candidates: string[] = [];
  const ext = extname(base);
  if (ext && SRC_EXTS.has(ext)) {
    candidates.push(base);
    // ESM-style './foo.js' importing the TS source './foo.ts'.
    if (ext === '.js') candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
    if (ext === '.mjs') candidates.push(base.slice(0, -4) + '.mts');
  } else {
    for (const e of SRC_EXTS) candidates.push(base + e);
    for (const e of SRC_EXTS) candidates.push(join(base, 'index' + e));
  }
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

// ─── Scan ────────────────────────────────────────────────────────────────

type RawFinding = Omit<HealthFinding, 'score' | 'firstSeenAt' | 'lastSeenAt' | 'expiresAt'>;

export async function runHealthScan(projectDir: string, opts: HealthScanOptions = {}): Promise<HealthScanResult> {
  const dir = resolve(projectDir);
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const runner = opts.runner ?? defaultCommandRunner;
  const state = loadState(dir);
  const priorById = new Map(state.findings.map((f) => [f.id, f]));

  const facts = await gatherRepoFacts(dir, runner);
  const checks: HealthCheckReport[] = [];
  const detected: RawFinding[] = [];
  const checkRan = new Set<HealthCheckId>();
  let testsCached = false;
  let nextTestCache = state.testCache;
  let nextTodoTotal = state.todoTotal;

  // (a) tests on HEAD — cached by HEAD hash.
  {
    const detectedCmd = detectTestCommand(dir);
    if (!detectedCmd) {
      checks.push({ id: 'tests', status: 'skipped', note: 'tests skipped: no test command detected' });
    } else {
      checkRan.add('tests');
      let cache: StoredTestCache | undefined;
      if (!opts.forceTests && facts.head && state.testCache?.head === facts.head) {
        cache = state.testCache;
        testsCached = true;
      }
      if (!cache) {
        const res = await runner(detectedCmd.cmd, dir, opts.testBudgetMs ?? 120_000);
        const counts = parseTestCounts(res.out);
        cache = {
          head: facts.head ?? `nogit:${nowMs}`,
          command: detectedCmd.cmd,
          exitCode: res.code,
          ...(counts.passed !== undefined ? { passed: counts.passed } : {}),
          ...(counts.failed !== undefined ? { failed: counts.failed } : {}),
          timedOut: res.timedOut,
          ranAt: nowMs,
        };
        // No HEAD to key on → do not cache across scans.
        nextTestCache = facts.head ? cache : undefined;
        if (res.timedOut) {
          detected.push({
            id: 'tests:timeout', check: 'tests', severity: 'medium', evidenceStrength: 'measured',
            title: `Test suite exceeded the ${Math.round((opts.testBudgetMs ?? 120_000) / 1000)}s scan budget`,
            evidence: `\`${detectedCmd.cmd}\` did not finish within budget (killed). Tail: ${tailEvidence(res.out) || '(no output)'}`,
            suggestedAction: 'Profile the slowest tests, or raise the health scan test budget if the suite is legitimately long.',
          });
          checks.push({ id: 'tests', status: 'findings', note: `tests timed out (\`${detectedCmd.cmd}\`)` });
        }
      }
      if (cache && !cache.timedOut) {
        const cachedNote = testsCached ? ` (cached — HEAD unchanged since ${new Date(cache.ranAt).toISOString().slice(0, 10)})` : '';
        if (cache.exitCode !== 0) {
          const counts = countsText(cache);
          detected.push({
            id: 'tests:failing', check: 'tests', severity: 'high', evidenceStrength: 'measured',
            title: `Tests failing on HEAD${counts ? ` — ${counts}` : ''}`,
            evidence: `\`${cache.command}\` exit ${cache.exitCode}${cachedNote}`,
            suggestedAction: `Run \`${cache.command}\` and fix the failing tests before merging.`,
          });
          checks.push({ id: 'tests', status: 'findings', note: `tests FAILING${counts ? ` (${counts})` : ''} via \`${cache.command}\`${cachedNote}` });
        } else {
          checks.push({ id: 'tests', status: 'ok', note: `tests green${cache.passed !== undefined ? ` (${cache.passed} passed)` : ''} via \`${cache.command}\`${cachedNote}` });
        }
      } else if (cache?.timedOut && testsCached) {
        checks.push({ id: 'tests', status: 'skipped', note: 'tests skipped: prior run at this HEAD timed out (use --force to retry)' });
        checkRan.delete('tests');
      }
    }
  }

  // (b) dependencies — lockfile age + offline-safe probe.
  {
    const lock = LOCKFILES.find((f) => existsSync(join(dir, f)));
    if (!lock) {
      checks.push({ id: 'deps', status: 'skipped', note: 'deps skipped: no lockfile found' });
    } else {
      checkRan.add('deps');
      const outcome: DepsOutcome = { report: { id: 'deps', status: 'ok', note: '' }, raw: [] };
      // Age: last commit touching the lockfile, else file mtime.
      let ageDays: number | null = null;
      if (facts.isGit) {
        const log = await runner(`git log -1 --format=%ct -- ${lock}`, dir, 10_000);
        const ts = Number(log.out.trim());
        if (log.code === 0 && Number.isFinite(ts) && ts > 0) ageDays = Math.max(0, Math.floor((nowMs / 1000 - ts) / 86400));
      }
      if (ageDays === null) {
        try { ageDays = Math.max(0, Math.floor((nowMs - statSync(join(dir, lock)).mtimeMs) / DAY_MS)); } catch { ageDays = null; }
      }
      const staleDays = opts.lockfileStaleDays ?? 90;
      let note = ageDays !== null ? `lockfile ${lock} ${ageDays}d old` : `lockfile ${lock} present`;
      if (ageDays !== null && ageDays >= staleDays) {
        outcome.raw.push({
          id: `deps:lockfile-stale:${lock}`, check: 'deps', severity: 'low', evidenceStrength: 'observed',
          title: `Lockfile untouched for ${ageDays} days`,
          evidence: `\`git log -1 -- ${lock}\` → ${ageDays}d ago (threshold ${staleDays}d)`,
          suggestedAction: 'Run the ecosystem update command, review the diff, and commit the refreshed lockfile.',
        });
        note = `lockfile ${lock} stale (${ageDays}d)`;
      }
      // Probe (node only; never a network hard-dependency).
      const offline = opts.offline ?? !!process.env.MOCHI_HEALTH_OFFLINE;
      if (!existsSync(join(dir, 'package.json'))) {
        note += '; probe skipped: no offline probe for this ecosystem';
      } else if (offline) {
        note += '; probe skipped: offline';
      } else {
        const probe = await runner('npm outdated --json', dir, opts.probeBudgetMs ?? 25_000);
        const jsonStart = probe.out.indexOf('{');
        const jsonEnd = probe.out.lastIndexOf('}');
        let parsed: Record<string, unknown> | null = null;
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          try { parsed = JSON.parse(probe.out.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>; } catch { parsed = null; }
        }
        if (parsed) {
          const n = Object.keys(parsed).length;
          if (n > 0) {
            outcome.raw.push({
              id: 'deps:outdated', check: 'deps', severity: 'low', evidenceStrength: 'measured',
              title: `${n} dependencies behind their latest release`,
              evidence: `\`npm outdated --json\` → ${n} outdated: ${Object.keys(parsed).slice(0, 6).join(', ')}${n > 6 ? ', …' : ''}`,
              suggestedAction: 'Review `npm outdated`, bump within semver ranges first, and let the test suite judge.',
            });
            note += `; ${n} outdated`;
          } else {
            note += '; dependencies up to date';
          }
        } else if (NETWORK_ERR.test(probe.out) || probe.timedOut) {
          note += '; probe skipped: offline';
        } else {
          note += '; probe skipped: no usable output';
        }
      }
      outcome.report.note = note;
      outcome.report.status = outcome.raw.length ? 'findings' : 'ok';
      checks.push(outcome.report);
      detected.push(...outcome.raw);
    }
  }

  // (c) TODO/FIXME/HACK density + delta.
  {
    checkRan.add('todos');
    let total = 0;
    let scanned = 0;
    for (const rel of facts.files) {
      if (scanned >= 3_000 || total > 100_000) break;
      const full = join(dir, rel);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile() || st.size > 256 * 1024) continue;
      let content: string;
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      scanned++;
      total += [...content.matchAll(MARKER_RE)].length;
    }
    const prev = state.todoTotal;
    const growth = prev !== undefined ? total - prev : 0;
    nextTodoTotal = total;
    const growthThreshold = opts.todoGrowthThreshold ?? 5;
    const totalThreshold = opts.todoTotalThreshold ?? 100;
    let note = `TODO markers: ${total}${prev !== undefined ? ` (${growth >= 0 ? '+' : ''}${growth} since last scan)` : ' (baseline)'}`;
    if (prev !== undefined && growth >= growthThreshold) {
      detected.push({
        id: 'todos:growth', check: 'todos', severity: 'low', evidenceStrength: 'observed',
        title: `TODO/FIXME markers grew by ${growth} since the last scan (${prev} → ${total})`,
        evidence: `marker count over ${scanned} scanned files: ${prev} → ${total}`,
        suggestedAction: 'Convert the newest markers into tracked issues or fix them while the context is fresh.',
      });
      note += ' — growing';
    } else if (total >= totalThreshold) {
      detected.push({
        id: 'todos:density', check: 'todos', severity: 'low', evidenceStrength: 'observed',
        title: `High TODO/FIXME density: ${total} markers`,
        evidence: `marker count over ${scanned} scanned files (threshold ${totalThreshold})`,
        suggestedAction: 'Triage the oldest markers: fix, file as issues, or delete the stale ones.',
      });
      note += ' — high density';
    }
    checks.push({ id: 'todos', status: detected.some((f) => f.check === 'todos') ? 'findings' : 'ok', note });
  }

  // (d) dead-code candidates (heuristic, conservative).
  {
    const srcFiles = facts.files.filter((f) => f.startsWith('src/') && SRC_EXTS.has(extname(f)));
    if (!srcFiles.length) {
      checks.push({ id: 'dead-code', status: 'skipped', note: 'dead-code skipped: no src/ tree' });
    } else {
      checkRan.add('dead-code');
      const fileSet = new Set(facts.files);
      const imported = new Set<string>();
      for (const rel of srcFiles) {
        let content: string;
        try { content = readFileSync(join(dir, rel), 'utf8'); } catch { continue; }
        for (const m of content.matchAll(IMPORT_RE)) {
          const spec = m[1] ?? m[2] ?? m[3];
          if (!spec || (!spec.startsWith('./') && !spec.startsWith('../'))) continue;
          const target = resolveImport(rel, spec, fileSet);
          if (target) imported.add(target);
        }
      }
      let pkgText = '';
      try { pkgText = readFileSync(join(dir, 'package.json'), 'utf8'); } catch { /* none */ }
      const candidates = srcFiles.filter((f) => {
        const base = f.split('/').pop() ?? f;
        if (imported.has(f)) return false;
        if (ENTRYPOINT_NAMES.has(base)) return false;
        if (/\.test\.|\.spec\.|\.d\.ts$|\.config\./.test(base)) return false;
        if (f.includes('__tests__/')) return false;
        if (pkgText.includes(f)) return false; // referenced by package.json (bin/main/exports)
        return true;
      }).sort();
      if (candidates.length) {
        const shown = candidates.slice(0, 8);
        detected.push({
          id: `dead-code:${candidates.length}`, check: 'dead-code', severity: 'low', evidenceStrength: 'heuristic',
          title: `${candidates.length} possibly-dead file(s) under src/ (heuristic)`,
          evidence: `no importers found for: ${shown.join(', ')}${candidates.length > shown.length ? `, … (+${candidates.length - shown.length} more)` : ''}`,
          suggestedAction: 'Verify each is truly unreferenced (dynamic imports, CLI registration), then delete or wire it in.',
        });
        checks.push({ id: 'dead-code', status: 'findings', note: `dead-code: ${candidates.length} candidate(s) (heuristic)` });
      } else {
        checks.push({ id: 'dead-code', status: 'ok', note: 'dead-code: no candidates (heuristic)' });
      }
    }
  }

  // (e) churn × size hotspots from git history.
  {
    if (!facts.isGit) {
      checks.push({ id: 'hotspots', status: 'skipped', note: 'hotspots skipped: not a git repository' });
    } else {
      checkRan.add('hotspots');
      const log = await runner('git log --numstat -n 200 --format=', dir, 20_000);
      const churn = new Map<string, { lines: number; commits: number }>();
      if (log.code === 0) {
        let currentCommitFiles = new Set<string>();
        for (const line of log.out.split('\n')) {
          const m = line.match(/^(\d+)\t(\d+)\t(.+)$/);
          if (!m) continue;
          const path = m[3].trim();
          const entry = churn.get(path) ?? { lines: 0, commits: 0 };
          entry.lines += Number(m[1]) + Number(m[2]);
          if (!currentCommitFiles.has(path)) { entry.commits++; currentCommitFiles.add(path); }
          churn.set(path, entry);
        }
      }
      const hot: { path: string; lines: number; commits: number; kb: number }[] = [];
      for (const [path, c] of churn) {
        if (c.lines < 1_000) continue;
        let kb = 0;
        try { kb = Math.round(statSync(join(dir, path)).size / 1024); } catch { continue; }
        if (kb >= 32) hot.push({ path, lines: c.lines, commits: c.commits, kb });
      }
      hot.sort((a, b) => b.lines - a.lines);
      if (hot.length) {
        const top = hot.slice(0, 3);
        detected.push({
          id: 'hotspots:churn', check: 'hotspots', severity: 'info', evidenceStrength: 'observed',
          title: `Churn hotspot${top.length > 1 ? 's' : ''}: ${top.map((h) => h.path).join(', ')}`,
          evidence: top.map((h) => `${h.path}: ${h.lines} lines changed over the last 200 commits, ${h.kb}KB`).join('; '),
          suggestedAction: 'These files concentrate risk: prioritise tests and review care around them.',
        });
        checks.push({ id: 'hotspots', status: 'findings', note: `hotspots: ${hot.length} churn hotspot(s)` });
      } else {
        checks.push({ id: 'hotspots', status: 'ok', note: 'hotspots: none extreme' });
      }
    }
  }

  // ─── Merge with stored findings: persistence + expiry ──────────────────
  const nowFindings: HealthFinding[] = detected.map((raw) => {
    const prior = priorById.get(raw.id);
    const persisted = !!prior && prior.firstSeenAt < nowMs;
    return {
      ...raw,
      score: rankScore(raw.severity, raw.evidenceStrength, persisted),
      firstSeenAt: prior?.firstSeenAt ?? nowMs,
      lastSeenAt: nowMs,
      expiresAt: nowMs + FINDING_TTL_DAYS[raw.check] * DAY_MS,
    };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  let resolvedCount = 0;
  let expiredCount = 0;
  const detectedIds = new Set(nowFindings.map((f) => f.id));
  for (const prior of state.findings) {
    if (detectedIds.has(prior.id)) continue;
    if (checkRan.has(prior.check)) resolvedCount++;
    else if (prior.expiresAt <= nowMs) expiredCount++;
    else {
      // Check could not run and the finding has not expired: carry it over
      // (still ranked, clearly the same stored finding).
      nowFindings.push(prior);
    }
  }
  nowFindings.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const allClear = nowFindings.length === 0;
  const highCount = nowFindings.filter((f) => f.severity === 'high').length;
  const headline = allClear
    ? `Repo health: all clear at HEAD ${facts.head ? facts.head.slice(0, 7) : '(no git)'}.`
    : `Repo health: ${nowFindings.length} finding(s)${highCount ? `, ${highCount} high` : ''} — top: ${nowFindings[0].title}`;

  const paths = {
    state: healthStatePath(dir),
    lastScan: join(healthDir(dir), 'last-scan.json'),
    digest: join(healthDir(dir), 'digest.md'),
  };

  const base: Omit<HealthScanResult, 'digest'> = {
    kind: 'mochi-health-scan',
    version: 1,
    projectDir: dir,
    scannedAt: now.toISOString(),
    head: facts.head,
    checks,
    findings: nowFindings,
    allClear,
    testsCached,
    resolvedCount,
    expiredCount,
    headline,
    paths,
  };
  const digest = renderHealthDigest(base);

  saveState(dir, {
    version: 1,
    lastScanAt: nowMs,
    head: facts.head,
    ...(nextTestCache ? { testCache: nextTestCache } : {}),
    ...(nextTodoTotal !== undefined ? { todoTotal: nextTodoTotal } : {}),
    findings: nowFindings,
  });
  mkdirSync(healthDir(dir), { recursive: true });
  atomicWriteFileSync(paths.lastScan, JSON.stringify({ ...base, digest }, null, 2) + '\n');
  atomicWriteFileSync(paths.digest, digest);
  if (opts.recordFacts !== false) syncHealthFacts(dir, nowFindings, now);

  return { ...base, digest };
}

// ─── Digest ──────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<HealthSeverity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: '🔵' };

export function renderHealthDigest(r: Omit<HealthScanResult, 'digest'>): string {
  const lines: string[] = [];
  const date = r.scannedAt.slice(0, 10);
  const head = r.head ? r.head.slice(0, 7) : '(no git)';
  lines.push(`# 🩺 Repo health — ${date} · HEAD ${head}`);
  if (r.allClear) {
    lines.push(`✅ All clear — ${r.checks.filter((c) => c.status !== 'skipped').map((c) => c.note).join('; ')}.`);
    const skipped = r.checks.filter((c) => c.status === 'skipped');
    if (skipped.length) lines.push(`Skipped: ${skipped.map((c) => c.note).join('; ')}.`);
  } else {
    const high = r.findings.filter((f) => f.severity === 'high').length;
    lines.push(`${r.findings.length} finding(s)${high ? ` (${high} high)` : ''}, ranked by severity × evidence strength:`);
    lines.push('');
    r.findings.slice(0, 8).forEach((f, i) => {
      lines.push(`${i + 1}. ${SEVERITY_ICON[f.severity]} [${f.check}] ${f.title}`);
      lines.push(`   Evidence: ${f.evidence}`);
      lines.push(`   → ${f.suggestedAction}`);
    });
    if (r.findings.length > 8) lines.push(`…and ${r.findings.length - 8} more in .mochi/health/last-scan.json`);
    lines.push('');
    lines.push('Findings persist as project-memory facts with expiry and drop off when resolved or expired.');
  }
  if (r.resolvedCount || r.expiredCount) {
    lines.push(`Since last scan: ${r.resolvedCount} resolved, ${r.expiredCount} expired.`);
  }
  lines.push(`Checks: ${r.checks.map((c) => `${c.id} ${c.status}`).join(' · ')}`);
  return lines.join('\n') + '\n';
}

// ─── Project-memory facts ────────────────────────────────────────────────

/** Mirror the current findings into project memory as [health]-tagged
 *  facts with an expiry date, after pruning every previously-written
 *  [health] line (so resolved/expired findings stop haunting the prefix).
 *  The authoritative store is .mochi/health/state.json; memory is the
 *  ambient surface. Fact lines respect project-memory's 200-char cap. */
export function syncHealthFacts(projectDir: string, findings: HealthFinding[], now: Date): void {
  try {
    const p = projectMemoryPath(projectDir);
    if (existsSync(p)) {
      const lines = readFileSync(p, 'utf8').split('\n');
      const kept = lines.filter((l) => !l.includes('[health]'));
      if (kept.length !== lines.length) {
        atomicWriteFileSync(p, kept.join('\n'));
      }
    }
    for (const f of findings.slice(0, 5)) {
      const expires = new Date(f.expiresAt).toISOString().slice(0, 10);
      let fact = `[health] ${f.title} — ${f.suggestedAction} Expires ${expires}.`;
      if (fact.length > 195) fact = fact.slice(0, 192).trimEnd() + '…';
      recordProjectMemory(projectDir, fact);
    }
    void now;
  } catch {
    /* memory must never break a scan */
  }
}
