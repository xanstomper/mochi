// `mochi learn` — repo onboarding as a skill whose claims are EXECUTABLE.
//
// Hermes' `/learn` turns any source into a skill, but the result is
// unverified prose: a build command it names might not exist, might be
// broken, might never have been run. This is the moat version. `learn`
// analyses the current repo (repo-map / codegraph for structure,
// detectRepo for commands) and authors ONE normal skill —
// `repo-<name>-architecture` — through the ordinary skill pipeline
// (writeSkill: lint + quality gate + probation birth), with a hard rule:
//
//   Every load-bearing claim is either VERIFIED during the learn run or
//   explicitly marked UNVERIFIED, with the evidence attached.
//
// Command claims (build / test / lint / typecheck / dev) are verified by
// RUNNING them — bounded (timeout + output cap), through the standard
// exec path (src/exec.ts runShellString: hardline floor + sandbox hook),
// in a throwaway scratch COPY of the repo, so a learn run never mutates
// the tree it describes (build artifacts land in the copy, which is
// deleted). The only write to the real repo is the skill itself, under
// `.mochi/skills/` (Mochi's own state dir). Entrypoint claims are
// verified structurally (the file exists in the tree). Module-map claims
// come from the codegraph symbol index — never from a model's
// imagination — and are labelled structure-inferred in the skill body.
//
// Re-running learn UPDATES the same skill: claims are re-verified, the
// version increments, and status flips are reported as changes. A claim
// that was verified last time and fails now is a REGRESSION and is
// called out loudly in the skill body — never silently kept as verified.
//
// The claims are also embedded in the skill as a machine-readable
// comment block (`mochi:learn-claims`) so the diff above is computed
// from data, not from parsing prose. The skill's Verification section
// carries a `bash verify` snippet (the Skill Doctor mechanism) that
// re-runs exactly the commands currently asserted as verified — so the
// doctor's routine replay keeps re-checking learn's claims for free.
import {
  existsSync, readFileSync, readdirSync, mkdtempSync, rmSync,
  symlinkSync, cpSync, statSync,
} from 'node:fs';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { detectRepo } from './repo/repo.js';
import { warmCodegraph, querySymbolGraphSync } from './repo/codegraph.js';
import { runShellString } from './exec.js';
import { maybeRedact } from './security/security.js';
import { writeSkill, safeSlug, skillsRoot } from './skills/skill-manager.js';

// ─── Claims ──────────────────────────────────────────────────────────────

export type ClaimStatus = 'verified' | 'unverified';

export interface CommandClaim {
  kind: 'command';
  /** Stable claim key part: 'build' | 'test' | 'lint' | 'typecheck' | 'dev'. */
  label: string;
  command: string;
  status: ClaimStatus;
  /** Process exit code when run; null when not run / no code reported. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Redacted output tail (bounded) — the evidence behind the status. */
  evidence: string;
  /** Why the claim is unverified (exit != 0, timeout, not run, …). */
  reason?: string;
}

export interface EntrypointClaim {
  kind: 'entrypoint';
  /** Repo-relative path of the entry point file. */
  label: string;
  status: ClaimStatus;
  evidence: string;
}

export type LearnClaim = CommandClaim | EntrypointClaim;

export interface StoredClaim {
  kind: 'command' | 'entrypoint';
  label: string;
  status: ClaimStatus;
  command?: string;
}

export interface StoredClaims {
  version: number;
  learnedAt: string;
  claims: StoredClaim[];
}

const CLAIMS_MARKER = 'mochi:learn-claims';

/** Parse the machine-readable claims block embedded in a learned skill. */
export function parseLearnClaims(skillText: string): StoredClaims | null {
  const m = new RegExp(`<!--\\s*${CLAIMS_MARKER}\\s*\\n([\\s\\S]*?)\\n\\s*-->`).exec(skillText);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as StoredClaims;
    if (typeof parsed.version !== 'number' || !Array.isArray(parsed.claims)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function renderClaimsBlock(stored: StoredClaims): string {
  return `<!-- ${CLAIMS_MARKER}\n${JSON.stringify(stored, null, 1)}\n-->`;
}

// ─── Module map (codegraph-derived, structure-inferred) ─────────────────

export interface ModuleInfo {
  /** Repo-relative directory ('.' rendered as the repo root). */
  dir: string;
  files: number;
  symbols: number;
  /** Up to 5 representative symbol names (declaration kinds first). */
  keySymbols: string[];
  /** Entry-point files inside this module. */
  entrypoints: string[];
  /** Up to 3 module dirs this module calls into most. */
  dependsOn: string[];
  /** Deterministic structure summary (labelled as inferred in the body). */
  summary: string;
}

const SKIP_DIRS = new Set([
  '.git', '.mochi', 'node_modules', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', 'coverage', '.cache', 'vendor', '__pycache__',
]);
const MAX_WALK_FILES = 20_000;
const ENTRY_BASENAME = /^(index|main|cli|app|server|mod|lib)\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go)$/;

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    if (out.length >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_WALK_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return out;
}

interface SymRow { name: string; kind: string; rel: string }
interface CallRow { callee: string; rel: string }

function moduleOf(rel: string): string {
  const d = dirname(rel);
  return d === '.' ? '.' : d.split(sep).join('/');
}

const KIND_PRIORITY: Record<string, number> = {
  class: 0, interface: 0, enum: 0, type: 1, function: 1, method: 2, constructor: 2,
};

/** Build the module map from the codegraph symbol index + the file walk.
 *  Returns [] when the codegraph has nothing (learn still proceeds —
 *  command claims do not depend on the graph). */
async function buildModuleMap(root: string, files: string[], entrypoints: string[]): Promise<ModuleInfo[]> {
  let symbols: SymRow[] = [];
  let calls: CallRow[] = [];
  try {
    await warmCodegraph(root);
    const sq = querySymbolGraphSync(root, 'SELECT name, kind, rel FROM symbols', 200_000);
    if (sq && 'rows' in sq) symbols = sq.rows as SymRow[];
    const cq = querySymbolGraphSync(root, 'SELECT callee, rel FROM calls', 100_000);
    if (cq && 'rows' in cq) calls = cq.rows as CallRow[];
  } catch { /* codegraph unavailable: no module map, claims still work */ }
  if (symbols.length === 0) return [];

  const filesByModule = new Map<string, number>();
  for (const f of files) {
    const m = moduleOf(f);
    filesByModule.set(m, (filesByModule.get(m) ?? 0) + 1);
  }

  // callee name -> defining files (for file-level call edges)
  const defFiles = new Map<string, Set<string>>();
  const symsByModule = new Map<string, SymRow[]>();
  for (const s of symbols) {
    if (!s.name || !s.rel) continue;
    const rel = s.rel.replace(/^\.\//, '');
    if (!defFiles.has(s.name)) defFiles.set(s.name, new Set());
    defFiles.get(s.name)!.add(rel);
    const m = moduleOf(rel);
    if (!symsByModule.has(m)) symsByModule.set(m, []);
    symsByModule.get(m)!.push({ ...s, rel });
  }

  // module -> module call edges
  const edges = new Map<string, Map<string, number>>();
  for (const c of calls) {
    if (!c.callee || !c.rel) continue;
    const callerFile = c.rel.replace(/^\.\//, '');
    const callerMod = moduleOf(callerFile);
    for (const targetFile of defFiles.get(c.callee) ?? []) {
      const targetMod = moduleOf(targetFile);
      if (targetMod === callerMod) continue;
      if (!edges.has(callerMod)) edges.set(callerMod, new Map());
      const m = edges.get(callerMod)!;
      m.set(targetMod, (m.get(targetMod) ?? 0) + 1);
    }
  }

  const entrySet = new Set(entrypoints);
  const modules: ModuleInfo[] = [];
  for (const [dir, syms] of symsByModule) {
    const sorted = syms.slice().sort((a, b) =>
      (KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3) || a.name.localeCompare(b.name));
    const keySymbols: string[] = [];
    const seen = new Set<string>();
    for (const s of sorted) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      keySymbols.push(s.name);
      if (keySymbols.length >= 5) break;
    }
    const kindCounts = new Map<string, number>();
    for (const s of syms) kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
    const dominant = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
    const dependsOn = [...(edges.get(dir)?.entries() ?? [])]
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m);
    modules.push({
      dir,
      files: filesByModule.get(dir) ?? 0,
      symbols: syms.length,
      keySymbols,
      entrypoints: files.filter((f) => moduleOf(f) === dir && entrySet.has(f)),
      dependsOn,
      summary: `Dominant declarations: ${dominant || 'none indexed'}. Key symbols: ${keySymbols.join(', ') || 'none'}.`,
    });
  }
  modules.sort((a, b) => b.symbols - a.symbols || a.dir.localeCompare(b.dir));
  return modules.slice(0, 40);
}

// ─── Command verification (scratch copy, bounded, existing exec path) ───

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEV_PROBE_TIMEOUT_MS = 15_000;
const EVIDENCE_TAIL_CHARS = 400;

function evidenceTail(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return '';
  return maybeRedact(combined).slice(-EVIDENCE_TAIL_CHARS);
}

function lastLine(evidence: string): string {
  const lines = evidence.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.length > 160 ? `${last.slice(0, 157)}...` : last;
}

/** Copy the repo to a throwaway scratch dir (deps linked, state excluded)
 *  so verification commands cannot mutate the tree being described. */
function makeScratchCopy(root: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'mochi-learn-'));
  cpSync(root, scratch, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src);
      if (!rel) return true;
      return !rel.split(sep).some((seg) => SKIP_DIRS.has(seg));
    },
  });
  const nm = join(root, 'node_modules');
  if (existsSync(nm) && !existsSync(join(scratch, 'node_modules'))) {
    try { symlinkSync(nm, join(scratch, 'node_modules'), 'dir'); } catch { /* best effort */ }
  }
  return scratch;
}

interface CommandSpec { label: string; command: string }

async function verifyCommands(
  root: string,
  specs: CommandSpec[],
  timeoutMs: number,
): Promise<CommandClaim[]> {
  const scratch = makeScratchCopy(root);
  try {
    const claims: CommandClaim[] = [];
    for (const spec of specs) {
      const budget = spec.label === 'dev' ? Math.min(timeoutMs, DEV_PROBE_TIMEOUT_MS) : timeoutMs;
      const started = Date.now();
      let code: number | null = null;
      let timedOut = false;
      let evidence = '';
      try {
        const r = await runShellString(spec.command, {
          cwd: scratch,
          timeoutMs: budget,
          maxOutput: 256 * 1024,
          sandbox: { mode: 'auto' },
        });
        code = r.code;
        timedOut = r.timedOut;
        evidence = evidenceTail(r.stdout, r.stderr);
      } catch (e) {
        evidence = maybeRedact(e instanceof Error ? e.message : String(e)).slice(-EVIDENCE_TAIL_CHARS);
      }
      const durationMs = Date.now() - started;
      if (!timedOut && code === 0) {
        claims.push({
          kind: 'command', label: spec.label, command: spec.command, status: 'verified',
          exitCode: 0, timedOut: false, durationMs, evidence,
        });
      } else {
        const reason = timedOut
          ? (spec.label === 'dev'
            ? `still running after ${Math.round(budget / 1000)}s probe — long-running commands are launched, not verified`
            : `timed out after ${Math.round(budget / 1000)}s`)
          : `exited with code ${code ?? 'unknown'}`;
        claims.push({
          kind: 'command', label: spec.label, command: spec.command, status: 'unverified',
          exitCode: code, timedOut, durationMs, evidence, reason,
        });
      }
    }
    return claims;
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ─── Skill body rendering ────────────────────────────────────────────────

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function claimKey(c: { kind: string; label: string; command?: string }): string {
  return c.kind === 'command' ? `command:${c.label}:${c.command ?? ''}` : `entrypoint:${c.label}`;
}

export interface ClaimChange {
  key: string;
  label: string;
  kind: 'added' | 'removed' | 'status-changed';
  from?: ClaimStatus;
  to?: ClaimStatus;
  /** verified last learn, unverified now — the loud one. */
  regression: boolean;
}

function diffClaims(prev: StoredClaims | null, next: LearnClaim[]): ClaimChange[] {
  if (!prev) return [];
  const prevMap = new Map(prev.claims.map((c) => [claimKey(c), c]));
  const nextMap = new Map(next.map((c) => [claimKey(c), c]));
  const changes: ClaimChange[] = [];
  for (const [key, c] of nextMap) {
    const p = prevMap.get(key);
    if (!p) changes.push({ key, label: c.label, kind: 'added', to: c.status, regression: false });
    else if (p.status !== c.status) {
      changes.push({
        key, label: c.label, kind: 'status-changed', from: p.status, to: c.status,
        regression: p.status === 'verified' && c.status === 'unverified',
      });
    }
  }
  for (const [key, p] of prevMap) {
    if (!nextMap.has(key)) changes.push({ key, label: p.label, kind: 'removed', from: p.status, regression: false });
  }
  return changes;
}

interface RenderInput {
  repoName: string;
  skillName: string;
  version: number;
  learnedAt: string;
  language?: string;
  framework?: string;
  modules: ModuleInfo[];
  claims: LearnClaim[];
  changes: ClaimChange[];
  moduleMapAvailable: boolean;
}

function renderBody(inp: RenderInput): string {
  const commands = inp.claims.filter((c): c is CommandClaim => c.kind === 'command');
  const entries = inp.claims.filter((c): c is EntrypointClaim => c.kind === 'entrypoint');
  const verifiedCmds = commands.filter((c) => c.status === 'verified');
  const regressions = inp.changes.filter((c) => c.regression);

  const lines: string[] = [];
  lines.push(`# Repository architecture: ${inp.repoName}`);
  lines.push('');
  lines.push(
    `Generated by \`mochi learn\` (version ${inp.version} of this skill, ${inp.learnedAt}). ` +
    `${inp.claims.filter((c) => c.status === 'verified').length} verified / ` +
    `${inp.claims.filter((c) => c.status === 'unverified').length} unverified claims. ` +
    `A claim is VERIFIED only if it was executed (commands) or checked against the tree ` +
    `(entry points) during the learn run that produced this file. Anything else is ` +
    `labelled UNVERIFIED or structure-inferred — treat it as a lead, not a fact.`,
  );
  if (inp.language || inp.framework) {
    lines.push('');
    lines.push(`Detected stack: ${[inp.language, inp.framework].filter(Boolean).join(' / ')} (from manifest markers, structure-inferred).`);
  }
  lines.push('');
  lines.push('## When to use');
  lines.push(
    `Use when starting work in the ${inp.repoName} repository, when you need to know which ` +
    `module owns a behaviour, or when a build/test/lint command's status is in doubt. ` +
    `Re-run \`mochi learn\` after major refactors so the claims below are re-verified ` +
    `instead of going stale.`,
  );
  lines.push('');
  lines.push('## Module map');
  if (!inp.moduleMapAvailable) {
    lines.push('The codegraph symbol index was unavailable for this repo during learn, so no module map could be derived. Command and entry-point claims below still stand on their own evidence.');
  } else {
    lines.push('Derived from the codegraph symbol index (files, declarations, cross-file calls). Responsibility summaries are deterministic structure summaries — what declarations a module contains — NOT observed behaviour.');
    lines.push('');
    for (const m of inp.modules) {
      const dirLabel = m.dir === '.' ? '(repo root)' : m.dir;
      let line = `- \`${dirLabel}\` — ${m.files} files, ${m.symbols} symbols. ${m.summary}`;
      if (m.entrypoints.length) line += ` Entry points: ${m.entrypoints.map((e) => `\`${e}\``).join(', ')}.`;
      if (m.dependsOn.length) line += ` Calls into: ${m.dependsOn.map((d) => `\`${d === '.' ? '(repo root)' : d}\``).join(', ')}.`;
      lines.push(line);
    }
  }
  lines.push('');
  lines.push('## Commands (executable claims)');
  if (regressions.length) {
    lines.push('');
    for (const r of regressions) {
      lines.push(`**REGRESSED — previously verified, now failing:** the \`${r.label}\` claim was verified by the previous learn and does not verify now. Trust the current UNVERIFIED status below, not the old one.`);
    }
  }
  lines.push('');
  lines.push('| Claim | Command | Status | Evidence |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of commands) {
    const ev = c.status === 'verified'
      ? `exit 0 in ${c.durationMs}ms${lastLine(c.evidence) ? ` — ${lastLine(c.evidence)}` : ''}`
      : `${c.reason ?? 'failed'}${lastLine(c.evidence) ? ` — ${lastLine(c.evidence)}` : ''}`;
    lines.push(`| ${cell(c.label)} | \`${cell(c.command)}\` | ${c.status === 'verified' ? 'VERIFIED' : 'UNVERIFIED'} | ${cell(ev)} |`);
  }
  if (entries.length) {
    lines.push('');
    lines.push('Entry points (structural claims — verified = the file exists in the tree and is indexed):');
    for (const e of entries) {
      lines.push(`- \`${e.label}\` — ${e.status === 'verified' ? 'VERIFIED' : 'UNVERIFIED'} (${e.evidence})`);
    }
  }
  if (inp.version > 1 && inp.changes.length) {
    lines.push('');
    lines.push(`## Changes since the previous learn`);
    for (const ch of inp.changes) {
      if (ch.kind === 'added') lines.push(`- added: \`${ch.label}\` (${ch.to})`);
      else if (ch.kind === 'removed') lines.push(`- removed: \`${ch.label}\` (was ${ch.from})`);
      else lines.push(`- changed: \`${ch.label}\` ${ch.from} -> ${ch.to}${ch.regression ? ' (REGRESSION)' : ''}`);
    }
  }
  lines.push('');
  lines.push('## Procedure');
  lines.push('1. Read the module map above and locate the module that owns the behaviour you are changing; check its entry points and call edges before editing.');
  lines.push(`2. Run the verified test command (${verifiedCmds.find((c) => c.label === 'test') ? `\`${verifiedCmds.find((c) => c.label === 'test')!.command}\`` : 'see the claims table — no test command is currently verified'}) before and after your change; require a successful exit both times.`);
  lines.push('3. If a command you need is marked UNVERIFIED, treat its failure modes as unknown: run it yourself, read the evidence line in the claims table, and re-run `mochi learn` once it passes so the skill records the verified status.');
  lines.push('4. After structural changes (new modules, moved entry points, renamed scripts), re-run `mochi learn` and read the changes section so stale claims are demoted loudly instead of trusted silently.');
  lines.push('');
  lines.push('## Pitfalls');
  lines.push('- UNVERIFIED commands failed, timed out, or were not run during learn. The evidence line shows the actual output tail; do not assume the command works because it is listed.');
  lines.push('- Module responsibility summaries are structure-inferred from declarations and file layout. A module whose symbols are mostly types may still be behaviour-critical at runtime.');
  lines.push('- Verification ran in a throwaway copy of the repo. Commands whose result depends on untracked local state (credentials, a running service, machine-specific paths) can verify in the copy and still fail in your checkout, or the reverse.');
  lines.push('- Claims age. A verified stamp is evidence about the learn run that produced it, not a permanent property of the repo.');
  lines.push('');
  lines.push('## Verification');
  if (verifiedCmds.length) {
    lines.push('The snippet below re-runs exactly the commands this skill asserts as VERIFIED. Skill Doctor replays it; a failure means a claim in this file has gone stale.');
    lines.push('');
    lines.push('```bash verify');
    for (const c of verifiedCmds) lines.push(c.command);
    lines.push('```');
  } else if (entries.length) {
    lines.push('No command claim is currently verified, so the snippet below checks the structural claims: every asserted entry point must still exist.');
    lines.push('');
    lines.push('```bash verify');
    for (const e of entries.filter((x) => x.status === 'verified')) lines.push(`test -f ${e.label}`);
    lines.push('```');
  } else {
    lines.push('No executable claim could be verified for this repo during learn (no runnable commands, no entry points found). This section intentionally carries no snippet: there is nothing honest to replay yet. Re-run `mochi learn` when the repo has a working build or test command.');
  }
  lines.push('');
  lines.push(renderClaimsBlock({
    version: inp.version,
    learnedAt: inp.learnedAt,
    claims: inp.claims.map((c) => ({
      kind: c.kind, label: c.label, status: c.status,
      ...(c.kind === 'command' ? { command: c.command } : {}),
    })),
  }));
  return lines.join('\n');
}

// ─── The learn run ───────────────────────────────────────────────────────

export interface LearnOptions {
  /** Run command claims (default true). False = record them unverified. */
  verify?: boolean;
  /** Per-command wall-clock budget in ms (default 60s). */
  commandTimeoutMs?: number;
  /** Clock override for tests (learnedAt stamp). */
  now?: () => Date;
}

export interface LearnResult {
  ok: boolean;
  skillName: string;
  skillPath?: string;
  version: number;
  repoName: string;
  claims: LearnClaim[];
  modules: ModuleInfo[];
  changes: ClaimChange[];
  verifiedCount: number;
  unverifiedCount: number;
  /** Lifecycle state stamped at write (probation unless enforcement off). */
  state?: string;
  error?: string;
}

export function learnedSkillName(repoName: string): string {
  return `repo-${safeSlug(repoName)}-architecture`;
}

export function learnedSkillPath(projectDir: string, skillName: string): string {
  return join(skillsRoot(projectDir), safeSlug(skillName), 'SKILL.md');
}

/** Detect entry-point candidates: manifest-declared (package.json main/bin),
 *  detectRepo's spec entries, and conventional basenames near the root. */
function detectEntrypoints(root: string, files: string[], specEntries: string[]): string[] {
  const fileSet = new Set(files);
  const out = new Set<string>();
  for (const e of specEntries) {
    const rel = e.split(sep).join('/');
    if (fileSet.has(rel)) out.add(rel);
  }
  try {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: unknown; bin?: unknown };
      const mains: string[] = [];
      if (typeof pkg.main === 'string') mains.push(pkg.main);
      if (typeof pkg.bin === 'string') mains.push(pkg.bin);
      else if (pkg.bin && typeof pkg.bin === 'object') mains.push(...Object.values(pkg.bin as Record<string, unknown>).filter((v): v is string => typeof v === 'string'));
      for (const m of mains) {
        const rel = m.replace(/^\.\//, '');
        if (fileSet.has(rel)) out.add(rel);
      }
    }
  } catch { /* malformed manifest: spec/convention detection still applies */ }
  for (const f of files) {
    const depth = f.split('/').length;
    if (depth <= 3 && ENTRY_BASENAME.test(basename(f))) out.add(f);
  }
  return [...out].sort().slice(0, 8);
}

export async function learnRepo(projectDir: string, opts: LearnOptions = {}): Promise<LearnResult> {
  const root = resolve(projectDir);
  const repoName = basename(root);
  const skillName = learnedSkillName(repoName);
  const base: Omit<LearnResult, 'ok'> = {
    skillName, version: 1, repoName, claims: [], modules: [], changes: [],
    verifiedCount: 0, unverifiedCount: 0,
  };
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { ...base, ok: false, error: `not a directory: ${root}` };
    }

    // Previous learn (for version + claim diffing).
    const skillPath = learnedSkillPath(root, skillName);
    let prev: StoredClaims | null = null;
    if (existsSync(skillPath)) {
      prev = parseLearnClaims(readFileSync(skillPath, 'utf8'));
    }
    const version = prev ? prev.version + 1 : 1;

    const info = detectRepo(root);
    const specs: CommandSpec[] = [];
    if (info.buildCommand) specs.push({ label: 'build', command: info.buildCommand });
    if (info.testCommand) specs.push({ label: 'test', command: info.testCommand });
    if (info.lintCommand) specs.push({ label: 'lint', command: info.lintCommand });
    if (info.typecheckCommand) specs.push({ label: 'typecheck', command: info.typecheckCommand });
    // dev/start scripts are real claims too (detectRepo does not surface them).
    try {
      const pkgPath = join(root, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
        const pm = info.packageManager ?? 'npm';
        if (pkg.scripts?.dev) specs.push({ label: 'dev', command: `${pm} run dev` });
        else if (pkg.scripts?.start) specs.push({ label: 'dev', command: `${pm} start` });
      }
    } catch { /* manifest unreadable: command set stays as detected */ }

    const files = walkFiles(root);
    const entrypoints = detectEntrypoints(root, files, info.entrypoints ?? []);
    const modules = await buildModuleMap(root, files, entrypoints);

    // Command claims: run them, or record honestly that we did not.
    let commandClaims: CommandClaim[];
    if (opts.verify === false) {
      commandClaims = specs.map((s) => ({
        kind: 'command', label: s.label, command: s.command, status: 'unverified',
        exitCode: null, timedOut: false, durationMs: 0, evidence: '',
        reason: 'not run (verification disabled)',
      }));
    } else {
      commandClaims = await verifyCommands(root, specs, opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    }
    const entryClaims: EntrypointClaim[] = entrypoints.map((rel) => ({
      kind: 'entrypoint', label: rel, status: 'verified',
      evidence: 'present in tree',
    }));
    const claims: LearnClaim[] = [...commandClaims, ...entryClaims];
    const changes = diffClaims(prev, claims);

    const learnedAt = (opts.now ? opts.now() : new Date()).toISOString();
    const body = renderBody({
      repoName, skillName, version, learnedAt,
      language: info.language, framework: info.framework,
      modules, claims, changes,
      moduleMapAvailable: modules.length > 0,
    });
    const description =
      `Architecture map for the ${repoName} repository: module map, entry points, and ` +
      `build/test/lint commands verified by execution during \`mochi learn\`.`;
    const written = writeSkill(root, {
      name: skillName, description, body, lifecycle: 'probation',
    });
    if (!written.ok) {
      return { ...base, ok: false, version, claims, modules, changes, error: written.error ?? 'skill write failed' };
    }
    return {
      ...base,
      ok: true,
      skillPath: written.path,
      version,
      claims,
      modules,
      changes,
      verifiedCount: claims.filter((c) => c.status === 'verified').length,
      unverifiedCount: claims.filter((c) => c.status === 'unverified').length,
      ...(written.state ? { state: written.state } : {}),
    };
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── CLI surface ─────────────────────────────────────────────────────────

export interface LearnCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi learn [path] [--timeout <sec>] [--no-verify] [--json]

Analyse a repo and author/update its architecture skill
(repo-<name>-architecture) with EXECUTABLE claims: every build/test/lint
command the skill names is run (bounded, in a scratch copy of the repo)
and recorded VERIFIED only on a successful exit — otherwise UNVERIFIED
with the output as evidence. Entry points are checked against the tree;
the module map comes from the codegraph. Re-running learn re-verifies
every claim, bumps the skill version, and flags regressions loudly.`;

function numFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export async function handleLearnCommand({ positional, flags, cwd }: LearnCliArgs): Promise<void> {
  if (flags.help || flags.h) {
    console.log(USAGE);
    return;
  }
  const target = positional[1] ? resolve(cwd, positional[1]) : cwd;
  const timeoutSec = numFlag(flags, 'timeout');
  const result = await learnRepo(target, {
    verify: flags['no-verify'] ? false : true,
    ...(timeoutSec ? { commandTimeoutMs: timeoutSec * 1000 } : {}),
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    console.error(`mochi learn: ${result.error ?? 'failed'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`🍡 Learned ${result.repoName} -> skill "${result.skillName}" (v${result.version}${result.state ? `, born ${result.state}` : ''})`);
  console.log(`   ${result.skillPath}`);
  console.log(`   claims: ${result.verifiedCount} verified / ${result.unverifiedCount} unverified · modules mapped: ${result.modules.length}`);
  for (const c of result.claims) {
    if (c.kind === 'command') {
      console.log(`   ${c.status === 'verified' ? '✓' : '✗'} ${c.label}: \`${c.command}\`${c.status === 'unverified' && c.reason ? ` — ${c.reason}` : ''}`);
    }
  }
  for (const ch of result.changes) {
    if (ch.kind === 'status-changed') {
      console.log(`   ${ch.regression ? '⚠ REGRESSED' : '↻ changed'}: ${ch.label} ${ch.from} -> ${ch.to}`);
    }
  }
  const un = result.claims.filter((c) => c.status === 'unverified').length;
  if (un > 0) console.log(`   ${un} claim(s) are UNVERIFIED in the skill — they failed or were not run; evidence is recorded in the skill body.`);
}
