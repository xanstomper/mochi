// Tool Forge v1 (Wave O, design §A.5 of niche-features-and-self-improvement):
// Mochi synthesises its own TESTED, PERSISTENT tools from its verified
// trajectories. Skills are text; forged tools are CODE that had to run green
// before it existed.
//
// Pipeline, every stage evidence-gated:
//   1. TRIGGER — mine the trajectory store for the same ≥4-step tool
//      subsequence in ≥3 verifier-PASSED runs with stable argument shapes
//      (Alita-G: synthesise from verified wins, never from imagination).
//      Values that vary across the mined runs become the tool's parameters
//      (one parameterised primitive, not near-duplicates — TroVE/Alita-G);
//      values that never vary are baked in as constants.
//   2. SYNTHESIS — the frontier-tier model (LATM maker/user split, via the
//      model router's 'reasoning' profile) writes a single-file script +
//      description. Unit tests are NOT the model's to invent alone: the
//      forge derives replay cases mechanically from the mined trajectories
//      (recorded parameter values → recorded final output, redacted), and
//      the model may only ADD cases, never remove forge-derived ones.
//   3. SANDBOX TEST GATE — no exceptions. Tests execute through the exec
//      path (src/exec.ts) with the sandbox requested network-off and a
//      scratch cwd, under a static security scan (no network APIs, no
//      filesystem writes, no process spawning, no dynamic code) and the
//      hardline floor's spirit: a forged tool is read-only/transform ONLY
//      in v1. 100% pass required. Failure → ONE rectification round fed
//      the execution errors (CREATOR); second failure → discard + log
//      (failed forges are curriculum data, kept in forge-log.jsonl).
//   4. PROBATION — identical in spirit to skills: the tool registers as
//      probationary, is advertised only when the tool-exposure signals
//      predict relevance, and every invocation is logged with its outcome.
//      Promotion (the gate's decision, never the model's) needs ≥5
//      invocations, zero attributable task failures, and a non-negative
//      cost delta vs the raw sequence it replaced; the curator's lifecycle
//      evaluation trims tools that fail that bar (TroVE trimming).
//
// Storage: forged tools are plain files a human can read, diff, and delete —
//   <root>/.mochi/tools/<slug>/tool.json   (authored-tool manifest, command
//                                           runs the script via MOCHI_TOOL_DIR)
//   <root>/.mochi/tools/<slug>/tool.mjs    (the single-file script)
//   <root>/.mochi/tools/<slug>/tests.json  (gate test cases)
//   <root>/.mochi/tools/<slug>/forge.json  (candidate provenance snapshot)
//   <root>/.mochi/tools/forge-registry.json (lifecycle + invocation ledger)
//   <root>/.mochi/tools/forge-log.jsonl     (every forge attempt, incl. discards)
// Disabled/trimmed/discarded tools are archived under .mochi/tools/.archive/
// (never hard-deleted), so the loader never sees them again.
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  readdirSync, renameSync, statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import type { MochiConfig } from '../types.js';
import type { Tool, ToolContext } from './types.js';
import {
  validateManifest, runAuthoredCommand, RESERVED_TOOL_NAMES,
  listAuthoredTools, type AuthoredToolManifest,
} from './tool-factory.js';
import { recordToolUsage } from './tool-usage.js';
import { TOOL_SIGNAL_RES, type ToolUsageLedger } from './tool-exposure.js';
import { argShapeOf } from '../core/tool-sequence.js';
import {
  isVerifiedRecord, parseTrajectoryJsonl,
  type TrajectoryRecord, type TrajectoryStep,
} from '../observability/trajectory.js';
import { runArgv, detectBubblewrap } from '../exec.js';
import { maybeRedact } from '../security/security.js';
import { safeSlug } from '../skills/skill-manager.js';
import { createProvider } from '../model/router.js';
import { mochiStateDir } from '../core/mochi-dir.js';

// ─── Constants (the evidence bars; named so the audit view can quote them) ──

export const FORGE_MIN_SEQ_LEN = 4;
export const FORGE_MAX_SEQ_LEN = 8;
export const FORGE_MIN_RUNS = 3;
export const FORGE_MAX_PARAMS = 6;
export const FORGE_MAX_EXAMPLES = 3;
export const FORGE_PROMOTE_MIN_INVOCATIONS = 5;
export const FORGE_TRIM_ERRORS = 3;
export const FORGE_PROBATION_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const FORGE_SCRIPT_MAX_CHARS = 48_000;
const GATE_CASE_TIMEOUT_MS = 15_000;

/** Source tools a v1 forge candidate may be built from: read-only /
 *  transform only. Deliberately NARROWER than the capability registry's
 *  READ_ONLY_TOOLS — network tools (web_search, fetch, deepwiki) are out
 *  because forged tools run network-off; `git` is out because its args
 *  select mutating subcommands; `shell` is admitted only per-command
 *  through the conservative screen below. */
export const FORGEABLE_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'read', 'search', 'glob', 'inspect', 'diff', 'tree', 'outline', 'ast_slice',
  'find_references', 'find_definitions', 'get_function', 'find_callers',
  'type_hierarchy', 'analyze_code', 'code_similarity', 'blast_radius',
  'get_diagnostics', 'system_info', 'git_blame', 'git_history',
]);

/** Shell command heads a mined sequence may contain (read-only inspection
 *  only). Interpreters and package managers are never forgeable: a pipeline
 *  headed by `node -e` is a program, not a pattern. This is a heuristic
 *  screen — defence in depth behind the sandbox gate, the static script
 *  scan, and the read-only runtime — not a proof. */
const SHELL_READ_HEADS: ReadonlySet<string> = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'cat', 'ls', 'find', 'wc', 'head', 'tail',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'echo', 'pwd', 'stat', 'file', 'du', 'df',
  'basename', 'dirname', 'realpath', 'readlink', 'sha256sum', 'md5sum',
]);
const SHELL_FORBIDDEN_TOKENS: ReadonlySet<string> = new Set([
  'rm', 'mv', 'cp', 'dd', 'tee', 'chmod', 'chown', 'mkdir', 'touch', 'kill',
  'curl', 'wget', 'nc', 'ssh', 'scp', 'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'node', 'python', 'python3', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'awk',
  'sed', 'env', 'xargs', 'sudo', 'su', 'eval', 'exec', 'source',
]);
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log', 'show', 'diff', 'blame', 'status', 'ls-files', 'grep', 'rev-parse',
  'cat-file', 'shortlog', 'describe',
]);

/** Conservative read-only screen for one recorded shell command. Every
 *  pipeline segment's head must be allowlisted (or a read-only git
 *  subcommand); redirection, substitution, and mutating flags fail. */
export function isForgeableShellCommand(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const cmd = raw.trim();
  if (/[><`]|\$\(|>>?|<<<?/.test(cmd)) return false; // redirection / substitution / heredoc
  for (const seg of cmd.split(/[|;&\n]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // Skip leading VAR=value assignments; the head after them decides.
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (i >= tokens.length) return false;
    const head = tokens[i].split('/').pop() ?? '';
    if (SHELL_FORBIDDEN_TOKENS.has(head)) return false;
    if (head === 'git') {
      const sub = tokens[i + 1] ?? '';
      if (!GIT_READ_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    if (head === 'find' && tokens.some((t) => t === '-delete' || t === '-exec' || t === '-execdir' || t === '-ok')) return false;
    if (!SHELL_READ_HEADS.has(head)) return false;
  }
  return true;
}

/** Is one mined step forgeable in v1? Tool must be on the read-only list —
 *  or a shell call whose recorded command passes the screen. */
export function isForgeableStep(step: TrajectoryStep): boolean {
  if (FORGEABLE_SOURCE_TOOLS.has(step.tool)) return true;
  if (step.tool === 'shell') {
    const args = step.args as Record<string, unknown> | null;
    return isForgeableShellCommand(args?.command);
  }
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface ForgeParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  /** (step index within the sequence, arg key) slots this parameter feeds —
   *  slots whose values moved together across runs share one parameter. */
  slots: Array<{ step: number; key: string }>;
}

export interface ForgeExample {
  runId: string;
  /** Parameter values for this occurrence (the tool's invocation args). */
  args: Record<string, unknown>;
  /** The final step's recorded output (redacted, snippet-capped upstream). */
  expectedOutput: string;
}

export interface ForgeCandidate {
  /** Stable key: sequence + arg-shape signature. Re-forging the same key
   *  is how the pass knows this pattern was already attempted. */
  key: string;
  sequence: string[];
  shapes: string[];
  /** Distinct verifier-PASSED runs containing the sequence. */
  support: number;
  runIds: string[];
  taskKinds: string[];
  parameters: ForgeParameter[];
  /** Arg values identical across every mined run — baked into the tool. */
  constants: Array<{ step: number; key: string; value: unknown }>;
  examples: ForgeExample[];
  /** Mean summed step duration of the raw window across runs, when every
   *  step carried a duration. The cost-delta baseline for promotion. */
  avgWindowMs?: number;
}

export interface ForgeTestCase {
  name: string;
  args: Record<string, unknown>;
  expectContains?: string;
  expectEquals?: string;
  /** 'trajectory' = forge-derived replay case (the gate's evidence);
   *  'synthesis' = model-added case (may extend, never replace). */
  origin: 'trajectory' | 'synthesis';
}

export interface ForgeDraft {
  name: string;
  description: string;
  /** Single-file ESM script source (tool.mjs). */
  script: string;
  extraTests?: ForgeTestCase[];
}

export interface ForgeSynthesizer {
  synthesize(candidate: ForgeCandidate): Promise<ForgeDraft>;
  rectify(candidate: ForgeCandidate, draft: ForgeDraft, errors: string): Promise<ForgeDraft>;
}

export type ForgedToolState = 'probation' | 'active' | 'disabled' | 'trimmed' | 'discarded';

export interface ForgedToolRecord {
  name: string;
  state: ForgedToolState;
  candidateKey: string;
  sequence: string[];
  /** Provenance: the verifier-passed trajectory runs this tool was mined
   *  from. The audit trail that lets a human judge the evidence. */
  provenanceRunIds: string[];
  description: string;
  createdAt: number;
  stateAt: number;
  /** Invocation ledger (written by the tool's own execute wrapper). */
  invocations: number;
  errors: number;
  totalMs: number;
  lastInvokedAt?: number;
  /** Cost-delta baseline captured at forge time (candidate.avgWindowMs). */
  rawWindowMs?: number;
  /** Where the tool's directory went when it left the live store. */
  archivedPath?: string;
  /** Why the record is in its current state (gate errors, trim reason…). */
  lastReason?: string;
}

export interface ForgeRegistry {
  version: 1;
  tools: Record<string, ForgedToolRecord>;
}

export interface ForgeGateCheck { name: string; ok: boolean; detail?: string }
export interface ForgeGateReport {
  ok: boolean;
  /** True when the OS sandbox (bubblewrap) actually confined the test
   *  runs; false = exec fell back to direct execution and confinement
   *  rested on the static scan + canary snapshots. Recorded, never hidden. */
  sandboxed: boolean;
  checks: ForgeGateCheck[];
  errors: string[];
}

// ─── Paths ────────────────────────────────────────────────────────────────

/** Canonical project root for a forge projectDir argument: accepts the
 *  root or its `.mochi` state dir (mochiStateDir normalises the split that
 *  historically produced nested stores). */
export function forgeProjectRoot(projectDir: string): string {
  return resolve(mochiStateDir(projectDir), '..');
}

export function forgeToolsRoot(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'tools');
}

export function forgedToolDir(projectDir: string, name: string): string {
  return join(forgeToolsRoot(projectDir), safeSlug(name));
}

export function forgeRegistryPath(projectDir: string): string {
  return join(forgeToolsRoot(projectDir), 'forge-registry.json');
}

export function forgeLogPath(projectDir: string): string {
  return join(forgeToolsRoot(projectDir), 'forge-log.jsonl');
}

/** True when a tool directory in the authored-tools store belongs to the
 *  forge (carries a forge.json provenance snapshot). The authored loader
 *  skips these: forged tools load through loadForgedTools, which enforces
 *  lifecycle state and logs invocations. */
export function isForgedToolDir(dir: string): boolean {
  return existsSync(join(dir, 'forge.json'));
}

// ─── Registry + log ───────────────────────────────────────────────────────

export function loadForgeRegistry(projectDir: string): ForgeRegistry {
  try {
    const raw = JSON.parse(readFileSync(forgeRegistryPath(projectDir), 'utf8')) as ForgeRegistry;
    if (raw && typeof raw === 'object' && raw.tools && typeof raw.tools === 'object') {
      return { version: 1, tools: raw.tools };
    }
  } catch { /* missing/corrupt → empty registry; forging must not break */ }
  return { version: 1, tools: {} };
}

export function saveForgeRegistry(projectDir: string, reg: ForgeRegistry): void {
  const p = forgeRegistryPath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

/** Append one attempt/outcome line to the forge log. Failed forges are
 *  curriculum data: the log is the corpus the failure curriculum mines.
 *  Best-effort — logging never breaks a forge pass. */
export function appendForgeLog(projectDir: string, entry: Record<string, unknown>): void {
  try {
    const p = forgeLogPath(projectDir);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

export function readForgeLog(projectDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(forgeLogPath(projectDir), 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((e): e is Record<string, unknown> => e !== null);
  } catch {
    return [];
  }
}

/** Record one invocation of a forged tool (its execute wrapper calls this).
 *  Never throws — telemetry must not break the tool it measures. */
export function recordForgeInvocation(projectDir: string, name: string, opts: { ok: boolean; durationMs: number }): void {
  try {
    const reg = loadForgeRegistry(projectDir);
    const rec = reg.tools[name];
    if (!rec) return;
    rec.invocations += 1;
    if (!opts.ok) rec.errors += 1;
    rec.totalMs += Math.max(0, opts.durationMs);
    rec.lastInvokedAt = Date.now();
    saveForgeRegistry(projectDir, reg);
  } catch { /* telemetry never breaks execution */ }
}

// ─── Trajectory corpus ────────────────────────────────────────────────────

/** Load every trajectory export for a project. Exports land under the
 *  workspace state dir (`<root>/.mochi/exports`, written via
 *  runtime.workspace.dir); a bare `<root>/exports` is also checked for
 *  hand-placed corpora. Deduped by runId. */
export function loadTrajectoryCorpus(projectDir: string): TrajectoryRecord[] {
  const byId = new Map<string, TrajectoryRecord>();
  for (const dir of [join(mochiStateDir(projectDir), 'exports'), join(forgeProjectRoot(projectDir), 'exports')]) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          for (const rec of parseTrajectoryJsonl(readFileSync(join(dir, f), 'utf8'))) {
            if (!byId.has(rec.runId)) byId.set(rec.runId, rec);
          }
        } catch { /* one bad export never breaks the pass */ }
      }
    } catch { /* no exports dir → empty corpus */ }
  }
  return [...byId.values()];
}

// ─── Mining (the trigger) ─────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Canonical JSON for deep-equality of recorded arg values (key-sorted). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

interface Occurrence {
  runId: string;
  taskKind?: string;
  steps: TrajectoryStep[];
}

export interface MineOptions {
  minRuns?: number;
  minLen?: number;
  maxLen?: number;
  maxCandidates?: number;
}

/** Mine forge candidates from a trajectory corpus. Pure and deterministic.
 *
 *  A candidate is a contiguous window of ≥minLen steps that (a) appears in
 *  ≥minRuns DISTINCT verifier-passed records, (b) is made only of forgeable
 *  read-only/transform steps, all recorded ok, (c) has an IDENTICAL
 *  arg-shape signature in every occurrence, and (d) parameterises cleanly:
 *  every arg value that varies across runs is a short scalar, and slots
 *  whose values moved together collapse into one parameter. */
export function mineForgeCandidates(records: readonly TrajectoryRecord[], opts: MineOptions = {}): ForgeCandidate[] {
  const minRuns = opts.minRuns ?? FORGE_MIN_RUNS;
  const minLen = opts.minLen ?? FORGE_MIN_SEQ_LEN;
  const maxLen = opts.maxLen ?? FORGE_MAX_SEQ_LEN;
  const maxCandidates = opts.maxCandidates ?? 4;

  const byKey = new Map<string, { sequence: string[]; shapes: string[]; occurrences: Occurrence[] }>();
  for (const rec of records) {
    if (!isVerifiedRecord(rec)) continue;
    const steps = rec.steps;
    for (let start = 0; start + minLen <= steps.length; start++) {
      for (let len = minLen; len <= maxLen && start + len <= steps.length; len++) {
        const window = steps.slice(start, start + len);
        if (window.some((s) => !s.ok)) break; // a failed step poisons every longer window from here
        if (window.some((s) => !isForgeableStep(s))) break;
        const sequence = window.map((s) => s.tool);
        const shapes = window.map((s) => s.argShape ?? argShapeOf(s.args));
        const key = createKey(sequence, shapes);
        let bucket = byKey.get(key);
        if (!bucket) { bucket = { sequence, shapes, occurrences: [] }; byKey.set(key, bucket); }
        bucket.occurrences.push({
          runId: rec.runId,
          ...(rec.taskKind && rec.taskKind !== 'unknown' ? { taskKind: rec.taskKind } : {}),
          steps: window,
        });
      }
    }
  }

  const candidates: ForgeCandidate[] = [];
  for (const [key, bucket] of byKey) {
    // Support counts distinct RUNS (one occurrence per run — the first).
    const perRun = new Map<string, Occurrence>();
    for (const occ of bucket.occurrences) if (!perRun.has(occ.runId)) perRun.set(occ.runId, occ);
    const occs = [...perRun.values()];
    if (occs.length < minRuns) continue;
    const built = buildCandidate(key, bucket.sequence, bucket.shapes, occs);
    if (built) candidates.push(built);
  }

  // Subsumption (TroVE/workflow-induction rule): a shorter candidate whose
  // run set is covered by a longer candidate stating the same evidence is
  // a near-duplicate — the longest statement wins.
  const pruned = candidates.filter((c) => !candidates.some((other) =>
    other !== c && other.sequence.length > c.sequence.length &&
    containsSequence(other.sequence, c.sequence) &&
    c.runIds.every((id) => other.runIds.includes(id))));
  pruned.sort((a, b) => b.support - a.support || b.sequence.length - a.sequence.length || a.key.localeCompare(b.key));
  return pruned.slice(0, maxCandidates);
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function buildCandidate(
  key: string,
  sequence: string[],
  shapes: string[],
  occs: Occurrence[],
): ForgeCandidate | null {
  const len = sequence.length;
  // Parameterisation: per (step, key), the values across occurrences.
  interface Slot { step: number; key: string; values: unknown[] }
  const slots: Slot[] = [];
  const constants: ForgeCandidate['constants'] = [];
  for (let i = 0; i < len; i++) {
    const argObjs = occs.map((o) => o.steps[i].args);
    if (argObjs.some((a) => !isPlainObject(a))) {
      // Non-object args: forgeable only when byte-identical in every run.
      if (!argObjs.every((a) => canonical(a) === canonical(argObjs[0]))) return null;
      continue;
    }
    const objs = argObjs as Array<Record<string, unknown>>;
    const keys = new Set<string>();
    for (const o of objs) for (const k of Object.keys(o)) keys.add(k);
    for (const k of [...keys].sort()) {
      const values = objs.map((o) => o[k]);
      if (values.every((v) => canonical(v) === canonical(values[0]))) {
        if (values[0] !== undefined) constants.push({ step: i, key: k, value: values[0] });
        continue;
      }
      // Varying: every value must be a short scalar, same type family.
      const scalarOk = values.every((v) =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
      if (!scalarOk) return null;
      const types = new Set(values.map((v) => typeof v));
      if (types.size !== 1) return null;
      if (values.some((v) => typeof v === 'string' && (v.length > 120 || /[\r\n]/.test(v)))) return null;
      slots.push({ step: i, key: k, values });
    }
  }
  // Slots whose values moved together across runs = ONE parameter.
  const byVector = new Map<string, Slot[]>();
  for (const s of slots) {
    const vec = canonical(s.values);
    const arr = byVector.get(vec) ?? [];
    arr.push(s);
    byVector.set(vec, arr);
  }
  if (byVector.size > FORGE_MAX_PARAMS) return null;
  const usedNames = new Set<string>();
  const parameters: ForgeParameter[] = [];
  const paramByVector = new Map<string, ForgeParameter>();
  for (const [vec, group] of byVector) {
    const first = group[0];
    let name = `${sequence[first.step]}_${first.key}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!name || !/^[a-z]/.test(name)) name = `p_${name}`;
    let unique = name;
    let n = 2;
    while (usedNames.has(unique)) unique = `${name}_${n++}`;
    usedNames.add(unique);
    const t = typeof group[0].values[0];
    const param: ForgeParameter = {
      name: unique,
      type: t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string',
      description: `Value for the '${first.key}' argument of the '${sequence[first.step]}' step (varied across the ${occs.length} mined runs; identical values feed ${group.length} slot${group.length > 1 ? 's' : ''}).`,
      slots: group.map((s) => ({ step: s.step, key: s.key })),
    };
    parameters.push(param);
    paramByVector.set(vec, param);
  }
  // Examples: one occurrence per run, args = parameter values at that run.
  const slotVector = new Map<string, string>(); // "step:key" -> vector key
  for (const s of slots) slotVector.set(`${s.step}:${s.key}`, canonical(s.values));
  const examples: ForgeExample[] = [];
  for (let oi = 0; oi < occs.length && examples.length < FORGE_MAX_EXAMPLES; oi++) {
    const occ = occs[oi];
    const finalOut = occ.steps[len - 1].outputSnippet ?? '';
    if (!finalOut) continue;
    const args: Record<string, unknown> = {};
    for (const s of slots) {
      const param = paramByVector.get(slotVector.get(`${s.step}:${s.key}`)!)!;
      args[param.name] = s.values[oi];
    }
    examples.push({ runId: occ.runId, args, expectedOutput: maybeRedact(finalOut) });
  }
  if (examples.length < 2) return null; // the gate needs ≥2 replay cases to mean anything
  // Cost baseline: only when EVERY step of EVERY occurrence carried a duration.
  let avgWindowMs: number | undefined;
  const windowMs: number[] = [];
  let complete = true;
  for (const occ of occs) {
    let sum = 0;
    for (const s of occ.steps) {
      if (typeof s.durationMs !== 'number') { complete = false; break; }
      sum += s.durationMs;
    }
    if (!complete) break;
    windowMs.push(sum);
  }
  if (complete && windowMs.length === occs.length) {
    avgWindowMs = windowMs.reduce((a, b) => a + b, 0) / windowMs.length;
  }
  return {
    key,
    sequence,
    shapes,
    support: occs.length,
    runIds: occs.map((o) => o.runId).sort(),
    taskKinds: [...new Set(occs.map((o) => o.taskKind).filter((k): k is string => !!k))].sort(),
    parameters,
    constants,
    examples,
    ...(avgWindowMs !== undefined ? { avgWindowMs } : {}),
  };
}

function createKey(sequence: string[], shapes: string[]): string {
  return `${sequence.join('>')}::${shapes.join('|')}`;
}

// ─── Static script scan (the gate's first wall) ───────────────────────────

const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  'node:fs', 'node:path', 'node:os', 'node:url', 'node:util', 'node:crypto',
  'node:string_decoder', 'node:buffer', 'node:assert', 'node:process',
]);

const FORBIDDEN_SCRIPT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bchild_process\b/, label: 'child_process (process spawning is forbidden)' },
  { re: /\bnode:(net|http|https|dns|tls|dgram|cluster|worker_threads)\b/, label: 'network/worker module import' },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, label: 'network API use' },
  { re: /\b(writeFileSync|writeFile|createWriteStream|appendFileSync|appendFile|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|mkdirSync|mkdir|copyFileSync|copyFile|truncateSync|truncate|symlinkSync|linkSync|utimesSync|chmodSync|chownSync|openSync|createReadStream)\b/, label: 'filesystem write/stream API (forged v1 tools are read-only; createReadStream/openSync are banned because their write modes cannot be excluded statically)' },
  { re: /\beval\s*\(|\bnew\s+Function\b/, label: 'dynamic code evaluation' },
  { re: /\bimport\s*\(/, label: 'dynamic import (static imports only, allowlist-checked)' },
  { re: /\brequire\s*\(/, label: 'CommonJS require call (ESM only)' },
  { re: /\bskill_manage\b|\btool_factory\b/, label: 'self-modification surface (forged tools cannot manage skills or author tools)' },
  { re: /\bprocess\s*\.\s*exit\b/, label: 'process.exit (return normally; the runner owns the lifecycle)' },
];

/** Scan a forged script for everything v1 forbids. Returns violation
 *  labels (empty = clean). Also enforces the import allowlist. */
export function scanForgedScript(script: string): string[] {
  const violations: string[] = [];
  for (const { re, label } of FORBIDDEN_SCRIPT_PATTERNS) {
    if (re.test(script)) violations.push(label);
  }
  const importRe = /(?:from\s+|import\s+)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(script)) !== null) {
    if (!ALLOWED_IMPORTS.has(m[1])) violations.push(`import not on the allowlist: '${m[1]}'`);
  }
  if (script.length > FORGE_SCRIPT_MAX_CHARS) violations.push(`script exceeds ${FORGE_SCRIPT_MAX_CHARS} chars`);
  return violations;
}

// ─── The sandbox test gate ────────────────────────────────────────────────

function snapshotTree(root: string, excludeTop: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (rel === '' && e.name === excludeTop) continue;
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else {
        try {
          const st = statSync(p);
          out.set(r, `${st.size}:${st.mtimeMs}`);
        } catch { /* racing file — treat as absent */ }
      }
    }
  };
  walk(root, '');
  return out;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) changes.push(`created ${k}`);
    else if (before.get(k) !== v) changes.push(`modified ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) changes.push(`deleted ${k}`);
  return changes;
}

/** Read a forged tool's on-disk bundle (manifest + tests + provenance). */
export function readForgedBundle(projectDir: string, name: string): {
  manifest: AuthoredToolManifest;
  tests: ForgeTestCase[];
  candidate: ForgeCandidate;
} | null {
  try {
    const dir = forgedToolDir(projectDir, name);
    const manifest = JSON.parse(readFileSync(join(dir, 'tool.json'), 'utf8')) as AuthoredToolManifest;
    const tests = JSON.parse(readFileSync(join(dir, 'tests.json'), 'utf8')) as ForgeTestCase[];
    const candidate = JSON.parse(readFileSync(join(dir, 'forge.json'), 'utf8')) as ForgeCandidate;
    if (!Array.isArray(tests)) return null;
    return { manifest, tests, candidate };
  } catch {
    return null;
  }
}

/**
 * Run the full gate over a forged tool bundle on disk. The tool must pass
 * EVERY check: manifest validity + read-only permission, syntax, static
 * scan, and 100% of its test cases executed through the exec path with
 * the sandbox requested (network off), a scratch cwd, and a scrubbed
 * environment — plus the escape canary: NOTHING outside the tool's own
 * directory may change, the tool's own files may not change, and the
 * scratch cwd must stay empty (a read-only tool writes nowhere).
 */
export async function runForgeGate(projectDir: string, name: string, opts: { timeoutMs?: number } = {}): Promise<ForgeGateReport> {
  const checks: ForgeGateCheck[] = [];
  const errors: string[] = [];
  const fail = (check: string, detail: string) => { checks.push({ name: check, ok: false, detail }); errors.push(`${check}: ${detail}`); };
  const pass = (check: string, detail?: string) => checks.push({ name: check, ok: true, ...(detail ? { detail } : {}) });
  const sandboxed = detectBubblewrap() !== null;

  const bundle = readForgedBundle(projectDir, name);
  if (!bundle) return { ok: false, sandboxed, checks, errors: ['bundle unreadable (tool.json/tests.json/forge.json missing or malformed)'] };
  const { manifest, tests } = bundle;

  const manifestErr = validateManifest(manifest);
  if (manifestErr) fail('manifest', manifestErr);
  else if (manifest.permission !== 'read') fail('manifest', `permission must be 'read' for forged v1 tools, got '${manifest.permission ?? 'default'}'`);
  else pass('manifest');

  const dir = forgedToolDir(projectDir, name);
  const scriptPath = join(dir, 'tool.mjs');
  let script = '';
  try { script = readFileSync(scriptPath, 'utf8'); } catch { /* handled below */ }
  if (!script) {
    fail('script', 'tool.mjs missing or empty');
    return { ok: false, sandboxed, checks, errors };
  }

  const syntax = await runArgv('node', ['--check', scriptPath], { timeoutMs: 10_000 });
  if (syntax.code === 0) pass('syntax');
  else fail('syntax', (syntax.stderr || syntax.stdout).slice(0, 500));

  const violations = scanForgedScript(script);
  if (violations.length === 0) pass('static-scan');
  else for (const v of violations) fail('static-scan', v);

  if (tests.length === 0) fail('tests', 'no test cases — a forged tool without replay evidence cannot exist');
  else pass('tests-present', `${tests.length} case(s)`);

  // A bundle that failed a static wall (manifest / syntax / scan) is NEVER
  // executed: the gate does not run code it has already condemned. The
  // escape canary below exists for the subtler case — a script that
  // passes the scan and still tries to write at runtime.
  const staticFailed = errors.length > 0;

  // Escape canary snapshots: the whole tools root outside this tool's dir,
  // plus this tool's own files (self-modification check).
  const root = forgeToolsRoot(projectDir);
  const slug = safeSlug(name);
  const before = snapshotTree(root, slug);
  const ownBefore = snapshotTree(dir, '');
  const scratch = mkdtempSync(join(tmpdir(), 'mochi-forge-gate-'));
  let casesPassed = 0;
  for (const tc of staticFailed ? [] : tests) {
    const r = await runArgv('node', [scriptPath], {
      cwd: scratch,
      timeoutMs: opts.timeoutMs ?? GATE_CASE_TIMEOUT_MS,
      maxOutput: 200_000,
      sandbox: { mode: 'auto', network: false },
      env: {
        PATH: process.env.PATH ?? '',
        HOME: scratch,
        TMPDIR: scratch,
        MOCHI_TOOL_NAME: name,
        MOCHI_TOOL_DIR: dir,
        MOCHI_TOOL_ARGS: JSON.stringify(tc.args ?? {}),
        MOCHI_WORKSPACE: forgeProjectRoot(projectDir),
      },
    });
    const label = `case '${tc.name}'`;
    if (r.timedOut) { fail(label, `timed out after ${opts.timeoutMs ?? GATE_CASE_TIMEOUT_MS}ms`); continue; }
    if (r.code !== 0) { fail(label, `exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 400)}`); continue; }
    if (tc.expectEquals !== undefined && r.stdout.trim() !== tc.expectEquals.trim()) {
      fail(label, `stdout mismatch — expected ${JSON.stringify(tc.expectEquals.slice(0, 200))}, got ${JSON.stringify(r.stdout.slice(0, 200))}`);
      continue;
    }
    if (tc.expectContains !== undefined && !r.stdout.includes(tc.expectContains)) {
      fail(label, `stdout missing expected fragment ${JSON.stringify(tc.expectContains.slice(0, 200))} — got ${JSON.stringify(r.stdout.slice(0, 200))}`);
      continue;
    }
    casesPassed++;
  }
  if (staticFailed) fail('test-cases', 'not executed — an earlier gate wall (manifest/syntax/static-scan) already failed');
  else if (tests.length > 0 && casesPassed === tests.length) pass('test-cases', `${casesPassed}/${tests.length} passed`);
  else if (tests.length > 0) fail('test-cases', `${casesPassed}/${tests.length} passed — 100% required`);

  const outsideChanges = diffSnapshots(before, snapshotTree(root, slug));
  if (outsideChanges.length === 0) pass('escape-canary');
  else fail('escape-canary', `writes outside the tool directory detected: ${outsideChanges.slice(0, 5).join('; ')}`);
  const ownChanges = diffSnapshots(ownBefore, snapshotTree(dir, ''));
  if (ownChanges.length === 0) pass('self-integrity');
  else fail('self-integrity', `the tool modified its own bundle: ${ownChanges.slice(0, 5).join('; ')}`);
  let scratchFiles: string[] = [];
  try { scratchFiles = readdirSync(scratch); } catch { /* gone */ }
  if (scratchFiles.length === 0) pass('cwd-clean');
  else fail('cwd-clean', `tool wrote into its working directory: ${scratchFiles.slice(0, 5).join(', ')}`);

  return { ok: errors.length === 0, sandboxed, checks, errors };
}

// ─── Draft validation + bundle writing ────────────────────────────────────

const FORGE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Validate a synthesised draft against the hard rails. `extraReserved`
 *  carries the caller's full built-in name/alias set (the CLI passes
 *  ALL_TOOLS_MAP + TOOL_ALIASES; the static RESERVED list is always on). */
export function validateForgeDraft(
  draft: ForgeDraft,
  candidate: ForgeCandidate,
  extraReserved: ReadonlySet<string>,
  existingNames: ReadonlySet<string>,
): string | null {
  if (!draft || typeof draft !== 'object') return 'draft must be an object';
  if (typeof draft.name !== 'string' || !FORGE_NAME_RE.test(draft.name)) return `name must match ^[a-z][a-z0-9_]*$, got ${JSON.stringify(draft.name)}`;
  if (draft.name.length > 64) return 'name exceeds 64 chars';
  if (safeSlug(draft.name) !== draft.name) return 'name must already be slug-form';
  if (RESERVED_TOOL_NAMES.has(draft.name) || extraReserved.has(draft.name)) {
    return `'${draft.name}' shadows a built-in tool — forged tools never shadow built-ins`;
  }
  if (existingNames.has(draft.name)) return `'${draft.name}' already exists as an authored/forged tool`;
  if (typeof draft.description !== 'string' || draft.description.trim().length < 8) return 'description is required (min 8 chars)';
  if (typeof draft.script !== 'string' || !draft.script.trim()) return 'script is required';
  if (draft.script.length > FORGE_SCRIPT_MAX_CHARS) return `script exceeds ${FORGE_SCRIPT_MAX_CHARS} chars`;
  if (!/MOCHI_TOOL_ARGS/.test(draft.script)) return 'script must read its arguments from MOCHI_TOOL_ARGS (the authored-tool contract)';
  // Model-added tests are validated for shape; forge-derived cases are
  // computed from the candidate and can never be removed by the draft.
  for (const t of draft.extraTests ?? []) {
    if (!t || typeof t.name !== 'string' || !t.args || typeof t.args !== 'object') return 'extraTests entries need {name, args}';
    if (t.expectContains === undefined && t.expectEquals === undefined) return `extraTest '${t.name}' needs expectContains or expectEquals`;
  }
  void candidate;
  return null;
}

/** The replay cases the FORGE derives from the candidate — the gate's
 *  evidence. Derived, never model-authored. */
export function forgeDerivedTests(candidate: ForgeCandidate): ForgeTestCase[] {
  return candidate.examples.map((ex, i) => ({
    name: `replay-${i + 1}-${ex.runId}`,
    args: ex.args,
    expectContains: ex.expectedOutput,
    origin: 'trajectory' as const,
  }));
}

/** Write a validated draft as a forged bundle on disk (NOT registered —
 *  registration happens only after the gate passes). */
export function writeForgedBundle(projectDir: string, candidate: ForgeCandidate, draft: ForgeDraft): string {
  const dir = forgedToolDir(projectDir, draft.name);
  mkdirSync(dir, { recursive: true });
  const manifest: AuthoredToolManifest = {
    name: draft.name,
    description: `[forged] ${draft.description}`,
    // MOCHI_WORKSPACE = the project root (authored commands run with the
    // root as cwd): scripts resolve relative arg paths against it, never
    // against an incidental cwd.
    command: 'MOCHI_WORKSPACE="$PWD" node "$MOCHI_TOOL_DIR/tool.mjs"',
    parameters: candidate.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      required: true,
    })),
    permission: 'read',
    timeoutMs: 30_000,
  };
  writeFileSync(join(dir, 'tool.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'tool.mjs'), draft.script.endsWith('\n') ? draft.script : draft.script + '\n', 'utf8');
  const tests = [...forgeDerivedTests(candidate), ...(draft.extraTests ?? []).map((t) => ({ ...t, origin: 'synthesis' as const }))];
  writeFileSync(join(dir, 'tests.json'), JSON.stringify(tests, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'forge.json'), JSON.stringify(candidate, null, 2) + '\n', 'utf8');
  return dir;
}

function archiveForgedDir(projectDir: string, name: string, now: number): string {
  const dir = forgedToolDir(projectDir, name);
  const dest = join(forgeToolsRoot(projectDir), '.archive', `${safeSlug(name)}-${now}`);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dir)) renameSync(dir, dest);
  return dest;
}

// ─── The forge pass ───────────────────────────────────────────────────────

export interface ForgePassOptions {
  synthesizer: ForgeSynthesizer;
  records?: readonly TrajectoryRecord[];
  /** Built-in tool names + aliases a forged name may never shadow. */
  builtinNames?: ReadonlySet<string>;
  minRuns?: number;
  minLen?: number;
  /** Max NEW tools to attempt this pass (bounded ambient spend). */
  maxForges?: number;
  now?: number;
}

export interface ForgePassResult {
  candidatesFound: number;
  forged: string[];
  discarded: Array<{ name?: string; candidateKey: string; reason: string }>;
  skipped: Array<{ candidateKey: string; reason: string }>;
}

export async function runForgePass(projectDir: string, opts: ForgePassOptions): Promise<ForgePassResult> {
  const now = opts.now ?? Date.now();
  const records = opts.records ?? loadTrajectoryCorpus(projectDir);
  const candidates = mineForgeCandidates(records, {
    ...(opts.minRuns !== undefined ? { minRuns: opts.minRuns } : {}),
    ...(opts.minLen !== undefined ? { minLen: opts.minLen } : {}),
    maxCandidates: Math.max(opts.maxForges ?? 2, 1) * 2,
  });
  const result: ForgePassResult = { candidatesFound: candidates.length, forged: [], discarded: [], skipped: [] };
  const registry = loadForgeRegistry(projectDir);
  const byKey = new Map(Object.values(registry.tools).map((r) => [r.candidateKey, r]));
  const existingNames = new Set<string>([
    ...listAuthoredTools(projectDir).map((m) => m.name),
    ...Object.keys(registry.tools).filter((n) => registry.tools[n].state !== 'discarded'),
  ]);
  const maxForges = opts.maxForges ?? 2;
  let attempted = 0;

  for (const candidate of candidates) {
    const prior = byKey.get(candidate.key);
    if (prior && (prior.state === 'probation' || prior.state === 'active')) {
      result.skipped.push({ candidateKey: candidate.key, reason: `already forged as '${prior.name}' (${prior.state})` });
      continue;
    }
    if (prior && prior.state === 'discarded') {
      result.skipped.push({ candidateKey: candidate.key, reason: `already attempted and discarded (${prior.lastReason ?? 'gate failed'}) — failed forges are not retried on the same evidence` });
      continue;
    }
    if (attempted >= maxForges) {
      result.skipped.push({ candidateKey: candidate.key, reason: 'pass budget (maxForges) reached' });
      continue;
    }
    attempted++;

    let draft: ForgeDraft;
    try {
      draft = await opts.synthesizer.synthesize(candidate);
    } catch (err) {
      const reason = `synthesis failed: ${err instanceof Error ? err.message : String(err)}`;
      result.discarded.push({ candidateKey: candidate.key, reason });
      appendForgeLog(projectDir, { event: 'discarded', candidateKey: candidate.key, reason, sequence: candidate.sequence, provenanceRunIds: candidate.runIds });
      continue;
    }

    // Gate loop: initial attempt + ONE rectification round (CREATOR).
    let lastErrors = '';
    let gated: { name: string; report: ForgeGateReport } | null = null;
    for (let round = 0; round < 2; round++) {
      const invalid = validateForgeDraft(draft, candidate, opts.builtinNames ?? new Set(), existingNames);
      if (invalid) { lastErrors = invalid; }
      else {
        writeForgedBundle(projectDir, candidate, draft);
        const report = await runForgeGate(projectDir, draft.name);
        if (report.ok) { gated = { name: draft.name, report }; break; }
        lastErrors = report.errors.join('\n');
      }
      if (round === 0) {
        appendForgeLog(projectDir, { event: 'rectify', name: draft.name, candidateKey: candidate.key, errors: lastErrors.slice(0, 2_000) });
        try {
          draft = await opts.synthesizer.rectify(candidate, draft, lastErrors);
        } catch (err) {
          lastErrors = `rectification failed: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }
    }

    if (gated) {
      const rec: ForgedToolRecord = {
        name: gated.name,
        state: 'probation',
        candidateKey: candidate.key,
        sequence: candidate.sequence,
        provenanceRunIds: candidate.runIds,
        description: draft.description,
        createdAt: now,
        stateAt: now,
        invocations: 0,
        errors: 0,
        totalMs: 0,
        ...(candidate.avgWindowMs !== undefined ? { rawWindowMs: candidate.avgWindowMs } : {}),
      };
      registry.tools[gated.name] = rec;
      existingNames.add(gated.name);
      saveForgeRegistry(projectDir, registry);
      result.forged.push(gated.name);
      appendForgeLog(projectDir, {
        event: 'forged', name: gated.name, candidateKey: candidate.key, state: 'probation',
        sequence: candidate.sequence, provenanceRunIds: candidate.runIds,
        sandboxed: gated.report.sandboxed,
      });
    } else {
      // Discard: archive whatever bundle was written, keep the record and
      // the log line — a failed forge is curriculum data, not an embarrassment
      // to delete.
      let archivedPath: string | undefined;
      const attemptedName = typeof draft?.name === 'string' && FORGE_NAME_RE.test(draft.name) ? draft.name : undefined;
      if (attemptedName && existsSync(forgedToolDir(projectDir, attemptedName))) {
        archivedPath = archiveForgedDir(projectDir, attemptedName, now);
      }
      if (attemptedName) {
        registry.tools[attemptedName] = {
          name: attemptedName,
          state: 'discarded',
          candidateKey: candidate.key,
          sequence: candidate.sequence,
          provenanceRunIds: candidate.runIds,
          description: typeof draft?.description === 'string' ? draft.description : '',
          createdAt: now,
          stateAt: now,
          invocations: 0,
          errors: 0,
          totalMs: 0,
          ...(archivedPath ? { archivedPath } : {}),
          lastReason: lastErrors.slice(0, 1_000),
        };
        saveForgeRegistry(projectDir, registry);
      }
      result.discarded.push({ ...(attemptedName ? { name: attemptedName } : {}), candidateKey: candidate.key, reason: lastErrors.slice(0, 1_000) });
      appendForgeLog(projectDir, { event: 'discarded', name: attemptedName, candidateKey: candidate.key, reason: lastErrors.slice(0, 2_000), sequence: candidate.sequence, provenanceRunIds: candidate.runIds, ...(archivedPath ? { archivedPath } : {}) });
    }
  }
  return result;
}

// ─── Model synthesizer (LATM maker: frontier tier via the router) ─────────

const FORGE_SYSTEM_PROMPT = `You are Mochi's Tool Forge maker model. You write ONE single-file Node.js ESM script that replaces a repeated multi-step tool sequence with a single read-only tool call.

Hard rules (the sandbox gate enforces all of them; a violation discards the tool):
- Read the invocation arguments as JSON from process.env.MOCHI_TOOL_ARGS. Print ONLY the tool's result to stdout. Exit 0 on success; on failure print the reason to stderr and exit 1.
- READ-ONLY: no filesystem writes of any kind, no network, no child processes, no dynamic import/eval/require, no process.exit.
- Imports allowed ONLY from: node:fs, node:path, node:os, node:url, node:util, node:crypto, node:string_decoder, node:buffer, node:assert.
- The tool's parameters are FIXED (given below) — use exactly those names. Values that were constant across the mined runs are given as constants: bake them in.
- The script must reproduce, for each recorded example, output that CONTAINS the example's expected output text when invoked with the example's args. The examples were recorded in the project workspace; file paths in args are relative to the workspace root, and the script's cwd at gate time is a scratch dir — resolve arg paths against process.env.MOCHI_WORKSPACE || process.cwd().
- Keep it small and deterministic. No timestamps, no randomness in the output.

Respond with ONLY a JSON object: {"name": "<snake_case tool name>", "description": "<what it does + when to use it>", "script": "<the full .mjs source>", "extraTests": [{"name": "...", "args": {...}, "expectContains": "..."}]} — extraTests may be an empty array; the forge adds its own replay tests from the trajectories regardless.`;

/** Production synthesizer: the model router's reasoning (frontier) tier
 *  writes the tool; the runtime's everyday models merely use it (LATM). */
export function createModelSynthesizer(config: MochiConfig): ForgeSynthesizer {
  const provider = createProvider(config.model, 'reasoning');
  const ask = async (candidate: ForgeCandidate, extra: string): Promise<ForgeDraft> => {
    const user = [
      `Tool sequence to replace (${candidate.sequence.length} steps): ${candidate.sequence.join(' -> ')}`,
      `Argument shapes per step: ${candidate.shapes.join(' | ')}`,
      `Parameters (fixed): ${JSON.stringify(candidate.parameters.map((p) => ({ name: p.name, type: p.type })))}`,
      `Constants to bake in: ${JSON.stringify(candidate.constants)}`,
      `Recorded examples (args -> expected output the final step produced):`,
      ...candidate.examples.map((ex) => `  args=${JSON.stringify(ex.args)} expected=${JSON.stringify(ex.expectedOutput.slice(0, 400))}`),
      `Evidence: mined from ${candidate.support} verifier-passed runs (${candidate.runIds.join(', ')}).`,
      extra,
    ].join('\n');
    const res = await provider.chat(
      [{ role: 'system', content: FORGE_SYSTEM_PROMPT }, { role: 'user', content: user }],
      [],
      { temperature: 0.2, maxTokens: 8_000 },
    );
    const text = res.content ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('synthesizer returned no JSON object');
    const parsed = JSON.parse(text.slice(start, end + 1)) as ForgeDraft;
    if (typeof parsed.name !== 'string' || typeof parsed.script !== 'string' || typeof parsed.description !== 'string') {
      throw new Error('synthesizer JSON missing name/description/script');
    }
    return parsed;
  };
  return {
    synthesize: (candidate) => ask(candidate, 'Write the tool now.'),
    rectify: (candidate, draft, errors) => ask(
      candidate,
      `Your previous attempt (name '${draft.name}') FAILED the sandbox gate with these errors:\n${errors.slice(0, 3_000)}\nFix the script and return the full corrected JSON. Do not rename the tool unless the name itself was the error.`,
    ),
  };
}

// ─── Loading + invocation (probation-aware) ───────────────────────────────

function forgedManifestToTool(m: AuthoredToolManifest, root: string): Tool {
  return {
    def: {
      name: m.name,
      description: m.description,
      parameters: (m.parameters ?? []).map((p) => ({
        name: p.name,
        type: p.type ?? 'string',
        description: p.description ?? '',
        required: p.required ?? false,
      })),
      permission: 'read',
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext) {
      const r = await runAuthoredCommand(m, args, root);
      recordToolUsage(root, m.name, { error: !!r.error, durationMs: r.durationMs });
      recordForgeInvocation(root, m.name, { ok: !r.error, durationMs: r.durationMs });
      if (r.error) return `ERROR: ${r.error}\n${r.output}`.trim();
      return r.output;
    },
  };
}

/** Load every forged tool in a live state (probation | active) as a Tool.
 *  Disabled/trimmed/discarded tools are archived out of the store and are
 *  never returned. Malformed bundles are skipped, never fatal. */
export function loadForgedTools(projectDir: string): Map<string, Tool> {
  const out = new Map<string, Tool>();
  const root = forgeProjectRoot(projectDir);
  let registry: ForgeRegistry;
  try { registry = loadForgeRegistry(projectDir); } catch { return out; }
  for (const rec of Object.values(registry.tools)) {
    if (rec.state !== 'probation' && rec.state !== 'active') continue;
    try {
      const dir = forgedToolDir(projectDir, rec.name);
      const m = JSON.parse(readFileSync(join(dir, 'tool.json'), 'utf8')) as AuthoredToolManifest;
      if (validateManifest(m) || m.name !== rec.name) continue;
      out.set(rec.name, forgedManifestToTool(m, root));
    } catch { /* skip malformed bundle */ }
  }
  return out;
}

/** buildTools helper: merge forged tools without EVER shadowing a name
 *  already in the map (built-ins and authored tools win). Fail-silent. */
export function loadForgedToolsSafe(projectDir: string): Map<string, Tool> {
  try {
    return loadForgedTools(projectDir);
  } catch {
    return new Map<string, Tool>();
  }
}

// ─── Probation exposure (advertised only when relevance is predicted) ─────

/** Should a probationary forged tool be advertised for this task? The
 *  prediction reuses the exposure layer's own signals: the task text
 *  names the tool or one of its source tools, a domain signal for a source
 *  tool fires, or the usage ledger shows this workspace actually runs the
 *  source sequence's tools for this task kind. */
export function forgedToolRelevant(
  rec: ForgedToolRecord,
  taskText: string,
  ledger?: ToolUsageLedger | null,
  taskKind?: string,
): boolean {
  const text = taskText ?? '';
  if (text) {
    if (new RegExp(`\\b${rec.name}\\b`, 'i').test(text)) return true;
    for (const toolName of rec.sequence) {
      if (new RegExp(`\\b${toolName}\\b`, 'i').test(text)) return true;
      const sig = TOOL_SIGNAL_RES[toolName];
      if (sig && sig.test(text)) return true;
    }
    // Description keywords (the model picks tools by description; a task
    // that names the tool's domain in its own words predicts relevance).
    const keywords = new Set(
      `${rec.description} ${rec.sequence.join(' ')}`.toLowerCase().split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 5),
    );
    let hits = 0;
    for (const w of keywords) if (new RegExp(`\\b${w}\\b`, 'i').test(text)) hits++;
    if (hits >= 2) return true;
  }
  if (ledger) {
    const kindRecs = taskKind ? ledger.byKind?.[taskKind] : undefined;
    for (const toolName of rec.sequence) {
      if ((kindRecs?.[toolName]?.calls ?? 0) > 0) return true;
      if ((ledger.tools?.[toolName]?.calls ?? 0) >= 3) return true;
    }
  }
  return false;
}

/** Remove probationary forged tools the relevance prediction doesn't
 *  support from a live tool map (mirrors the loop's other trim passes;
 *  ACTIVE forged tools are earned and always stay). Returns removed names. */
export function trimForgedProbationTools(
  map: Map<string, Tool>,
  projectDir: string,
  taskText: string,
  ledger?: ToolUsageLedger | null,
  taskKind?: string,
): string[] {
  let registry: ForgeRegistry;
  try { registry = loadForgeRegistry(projectDir); } catch { return []; }
  const removed: string[] = [];
  for (const name of [...map.keys()]) {
    const rec = registry.tools[name];
    if (!rec || rec.state !== 'probation') continue;
    if (!forgedToolRelevant(rec, taskText, ledger, taskKind)) {
      map.delete(name);
      removed.push(name);
    }
  }
  return removed;
}

// ─── Lifecycle: promotion + curator trimming ──────────────────────────────

/** Runs whose final gate verdict was FAIL and whose steps invoked `name` —
 *  the attributable-failure join (same join skill attribution uses). */
export function attributableFailRuns(records: readonly TrajectoryRecord[], name: string): number {
  let n = 0;
  for (const rec of records) {
    if (rec.verification?.verdict !== 'fail') continue;
    if (rec.steps.some((s) => s.tool === name)) n++;
  }
  return n;
}

export interface ForgedLifecycleResult {
  promoted: string[];
  trimmed: Array<{ name: string; reason: string }>;
  probationStale: string[];
}

/**
 * The forged-tool lifecycle evaluation — run by the curator pass. The
 * GATE decides, never the model:
 *  - PROMOTE (probation → active): ≥5 invocations, zero execution errors,
 *    zero attributable verified-fail runs, and a measured cost delta ≥ 0
 *    (mean invocation duration vs the raw sequence's mean window duration
 *    captured at forge time). No duration evidence → no promotion.
 *  - TRIM (probation → archived): ≥5 invocations with execution errors
 *    ≥3, any attributable verified-fail run, or a negative cost delta —
 *    a forged tool that doesn't beat the raw sequence it replaced is
 *    exactly the bloat TroVE trimming exists to remove.
 *  - STALE: probation older than the expiry with <5 invocations — flagged
 *    for the report, not acted on (mirrors skill probation).
 */
export function evaluateForgedToolLifecycle(
  projectDir: string,
  opts: { records?: readonly TrajectoryRecord[]; now?: number } = {},
): ForgedLifecycleResult {
  const now = opts.now ?? Date.now();
  const registry = loadForgeRegistry(projectDir);
  const records = opts.records ?? loadTrajectoryCorpus(projectDir);
  const result: ForgedLifecycleResult = { promoted: [], trimmed: [], probationStale: [] };
  let dirty = false;
  for (const rec of Object.values(registry.tools)) {
    if (rec.state !== 'probation') continue;
    if (rec.invocations < FORGE_PROMOTE_MIN_INVOCATIONS) {
      if (now - rec.createdAt > FORGE_PROBATION_STALE_MS) result.probationStale.push(rec.name);
      continue;
    }
    const fails = attributableFailRuns(records, rec.name);
    const avgMs = rec.invocations > 0 ? rec.totalMs / rec.invocations : 0;
    const delta = rec.rawWindowMs !== undefined ? rec.rawWindowMs - avgMs : undefined;
    const trimReason =
      rec.errors >= FORGE_TRIM_ERRORS ? `${rec.errors} execution errors across ${rec.invocations} invocations`
      : fails > 0 ? `present in ${fails} verifier-FAIL run(s)`
      : delta !== undefined && delta < 0 ? `negative cost delta (${avgMs.toFixed(1)}ms/invocation vs ${rec.rawWindowMs!.toFixed(1)}ms raw sequence)`
      : null;
    if (trimReason) {
      const archivedPath = archiveForgedDir(projectDir, rec.name, now);
      rec.state = 'trimmed';
      rec.stateAt = now;
      rec.archivedPath = archivedPath;
      rec.lastReason = trimReason;
      dirty = true;
      result.trimmed.push({ name: rec.name, reason: trimReason });
      appendForgeLog(projectDir, { event: 'trimmed', name: rec.name, reason: trimReason });
      continue;
    }
    if (rec.errors === 0 && fails === 0 && delta !== undefined && delta >= 0) {
      rec.state = 'active';
      rec.stateAt = now;
      rec.lastReason = `promoted: ${rec.invocations} invocations, 0 errors, 0 attributable fails, cost delta +${delta.toFixed(1)}ms/invocation`;
      dirty = true;
      result.promoted.push(rec.name);
      appendForgeLog(projectDir, { event: 'promoted', name: rec.name, reason: rec.lastReason });
    }
    // Otherwise: evidence is mixed or incomplete (e.g. no duration
    // baseline) — the tool stays on probation. No evidence, no promotion.
  }
  if (dirty) saveForgeRegistry(projectDir, registry);
  return result;
}

/** One-command disable (the audit view's kill switch): archive the bundle
 *  and mark the record disabled. Recoverable by a human from .archive —
 *  the forge itself never resurrects a disabled tool. */
export function disableForgedTool(projectDir: string, name: string, reason = 'disabled by operator'): boolean {
  const registry = loadForgeRegistry(projectDir);
  const rec = registry.tools[name];
  if (!rec || rec.state === 'disabled') return false;
  const now = Date.now();
  rec.archivedPath = archiveForgedDir(projectDir, name, now);
  rec.state = 'disabled';
  rec.stateAt = now;
  rec.lastReason = reason;
  saveForgeRegistry(projectDir, registry);
  appendForgeLog(projectDir, { event: 'disabled', name, reason });
  return true;
}

// ─── Audit view ───────────────────────────────────────────────────────────

export interface ForgedToolView extends ForgedToolRecord {
  /** Mean invocation duration (ms), when invoked at least once. */
  avgMs?: number;
  /** Measured cost delta vs the raw sequence (ms/invocation), when a
   *  duration baseline exists. Positive = the forged tool is faster. */
  costDeltaMs?: number;
  liveOnDisk: boolean;
}

export function listForgedTools(projectDir: string): ForgedToolView[] {
  const registry = loadForgeRegistry(projectDir);
  return Object.values(registry.tools)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((rec) => ({
      ...rec,
      ...(rec.invocations > 0 ? { avgMs: rec.totalMs / rec.invocations } : {}),
      ...(rec.rawWindowMs !== undefined && rec.invocations > 0
        ? { costDeltaMs: rec.rawWindowMs - rec.totalMs / rec.invocations }
        : {}),
      liveOnDisk: existsSync(join(forgedToolDir(projectDir, rec.name), 'tool.json')),
    }));
}

/** The `mochi tools forged` audit text: every forged tool with its state,
 *  provenance, invocation record, and cost evidence. */
export function formatForgedToolsAudit(projectDir: string): string {
  const views = listForgedTools(projectDir);
  if (views.length === 0) {
    return 'No forged tools yet. The forge mines verifier-passed trajectories for repeated ≥4-step sequences and synthesises tested tools from them (run `mochi tools forged run` to attempt a pass).';
  }
  const lines = [`Forged tools (${views.length}) — self-synthesised, sandbox-gated, probation-managed:`, ''];
  for (const v of views) {
    lines.push(`${v.name} [${v.state}] — ${v.description}`);
    lines.push(`  replaces: ${v.sequence.join(' -> ')}`);
    lines.push(`  provenance: ${v.provenanceRunIds.length} verifier-passed run(s): ${v.provenanceRunIds.join(', ')}`);
    lines.push(`  invocations: ${v.invocations} (errors ${v.errors})${v.avgMs !== undefined ? `, avg ${v.avgMs.toFixed(1)}ms` : ''}${v.costDeltaMs !== undefined ? `, cost delta ${v.costDeltaMs >= 0 ? '+' : ''}${v.costDeltaMs.toFixed(1)}ms/invocation vs raw sequence` : ''}`);
    if (v.lastReason) lines.push(`  note: ${v.lastReason}`);
    if (v.archivedPath) lines.push(`  archived: ${v.archivedPath}`);
    lines.push(`  disable: mochi tools forged disable ${v.name}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
