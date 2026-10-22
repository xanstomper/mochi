// Flaky-test detection, registry, and quarantine classification.
//
// Why this exists: flakes poison every downstream signal. A flaky suite makes
// the verify gate block good work, makes mutation checks unreadable (a mutant
// "killed" by a coin-flip test proves nothing), and corrupts the per-skill
// fix-rate data the self-improvement engine learns from. So verification
// classifies failures before it judges them:
//
//   FAIL        — the same tests fail on every attempt (consistent breakage).
//   PASS        — everything green on the first attempt.
//   FLAKY-PASS  — failures that pass on a bounded re-run of the SAME command
//                 with NO code change in between. Does not block completion,
//                 but is always surfaced loudly (summary + registry), never
//                 silently absorbed.
//
// Detection policy (bounded, anti-gaming):
//   - Re-runs happen only on failure, only for the failing command, and only
//     when the failing set is SMALL (<= MAX_FLAKE_SUBSET parsed test ids).
//     A wholesale-broken suite is never re-run repeatedly: with parseable ids
//     the cap is MAX_FLAKE_RERUNS extra attempts; with no parseable ids the
//     command itself is the unit and gets ONE extra attempt.
//   - A test that fails attempt 1 but is absent from a later attempt's
//     failing set (or the command goes green) flaked. A test present in
//     EVERY attempt's failing set is a consistent failure.
//   - ANTI-GAMING CORE: a flaky test whose FILE was changed by this very run
//     is treated as FAIL. "It flakes" is never an excuse for your own edits.
//   - Quarantine = classification + reporting only. Quarantined tests still
//     run in the user's suite; nothing is skipped or deleted. Quarantine
//     status feeds the mutation gate (known-flaky commands are excluded —
//     their baseline is noise) and the doctor report.
//
// The registry lives at `.mochi/state/flaky-tests.json` (workspace state,
// atomic Workspace writes). Scores decay: halved per 14-day period elapsed,
// and halved for a command's entries whenever that command is observed
// passing cleanly on the first attempt; entries under MIN_SCORE drop out.

import { execFileSync } from 'node:child_process';
import { redact } from '../security/security.js';
import type { Workspace } from '../workspace.js';

export const FLAKY_STATE_PATH = 'state/flaky-tests.json';
/** Extra attempts granted when the failing set parses to a small id set. */
export const MAX_FLAKE_RERUNS = 2;
/** Extra attempts when no per-test ids parse (command is the only unit). */
export const MAX_FLAKE_RERUNS_UNPARSED = 1;
/** Failing-set size above which re-runs are refused (wholesale breakage). */
export const MAX_FLAKE_SUBSET = 5;
/** Score at/above which a test or command counts as known-flaky/quarantined. */
export const KNOWN_FLAKE_SCORE = 2;
/** Decay period: scores halve per elapsed period. */
export const FLAKE_DECAY_MS = 14 * 24 * 3600 * 1000;
/** Entries whose decayed score falls below this are dropped. */
const MIN_SCORE = 0.5;
const MAX_EXAMPLES = 2;
const MAX_EXAMPLE_CHARS = 400;

export interface FlakyEntry {
  /** Test id as parsed from runner output, or `cmd:<command>` when the
   *  runner exposes no per-test names and the command is the flake unit. */
  id: string;
  /** Normalized command key that produced the flake. */
  command: string;
  /** Flakiness score: +1 per verify run that observed the flake; decays. */
  score: number;
  /** Lifetime count of verify runs that observed this test flake. */
  flakeEvents: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Redacted failure snippets (newest last), for human triage. */
  examples: string[];
}

export interface FlakyRegistry {
  version: 1;
  updatedAt: number;
  lastDecayAt: number;
  entries: Record<string, FlakyEntry>;
}

export function emptyFlakyRegistry(now = Date.now()): FlakyRegistry {
  return { version: 1, updatedAt: now, lastDecayAt: now, entries: {} };
}

/** Load the registry and apply time decay in memory. Persistence of the
 *  decayed state happens on the next saveFlakyRegistry call. */
export function loadFlakyRegistry(workspace: Workspace, now = Date.now()): FlakyRegistry {
  const raw = workspace.readJson<FlakyRegistry | null>(FLAKY_STATE_PATH, null);
  if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object') {
    return emptyFlakyRegistry(now);
  }
  const reg: FlakyRegistry = {
    version: 1,
    updatedAt: raw.updatedAt ?? now,
    lastDecayAt: raw.lastDecayAt ?? now,
    entries: raw.entries,
  };
  applyFlakyDecay(reg, now);
  return reg;
}

export function saveFlakyRegistry(workspace: Workspace, reg: FlakyRegistry): void {
  reg.updatedAt = Date.now();
  workspace.writeJson(FLAKY_STATE_PATH, reg);
}

/** Halve every score once per full decay period elapsed since the last
 *  decay; drop entries that fall below MIN_SCORE. Returns true when the
 *  registry changed. */
export function applyFlakyDecay(reg: FlakyRegistry, now = Date.now()): boolean {
  const periods = Math.floor((now - reg.lastDecayAt) / FLAKE_DECAY_MS);
  if (periods < 1) return false;
  const factor = Math.pow(0.5, periods);
  let changed = false;
  for (const [id, entry] of Object.entries(reg.entries)) {
    entry.score = entry.score * factor;
    changed = true;
    if (entry.score < MIN_SCORE) delete reg.entries[id];
  }
  reg.lastDecayAt = now;
  return changed;
}

/** Record one verify run's worth of flake observations (+1 score per id). */
export function recordFlakes(
  reg: FlakyRegistry,
  commandKey: string,
  ids: string[],
  failingOutput: string,
  now = Date.now(),
): void {
  if (ids.length === 0) return;
  const example = failureExample(failingOutput);
  for (const id of ids) {
    const existing = reg.entries[id];
    if (existing) {
      existing.score += 1;
      existing.flakeEvents += 1;
      existing.lastSeenAt = now;
      existing.command = commandKey;
      if (example && !existing.examples.includes(example)) {
        existing.examples = [...existing.examples, example].slice(-MAX_EXAMPLES);
      }
    } else {
      reg.entries[id] = {
        id,
        command: commandKey,
        score: 1,
        flakeEvents: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        examples: example ? [example] : [],
      };
    }
  }
}

/** A command observed passing cleanly on its first attempt is evidence its
 *  known flakes are healing: halve that command's entry scores (dropping
 *  sub-threshold entries). Returns true when the registry changed. */
export function recordCleanPass(reg: FlakyRegistry, commandKey: string): boolean {
  let changed = false;
  for (const [id, entry] of Object.entries(reg.entries)) {
    if (entry.command !== commandKey) continue;
    entry.score *= 0.5;
    changed = true;
    if (entry.score < MIN_SCORE) delete reg.entries[id];
  }
  return changed;
}

export function isKnownFlaky(reg: FlakyRegistry, id: string): boolean {
  const entry = reg.entries[id];
  return Boolean(entry) && entry.score >= KNOWN_FLAKE_SCORE;
}

/** True when any entry produced by this command is quarantined — including
 *  command-granularity entries. Mutation checks key on this: a flaky
 *  baseline makes mutant verdicts unreadable. */
export function isKnownFlakyCommand(reg: FlakyRegistry, command: string): boolean {
  const key = flakeCommandKey(command);
  return Object.values(reg.entries).some((e) => e.command === key && e.score >= KNOWN_FLAKE_SCORE);
}

/** Command keys quarantined RIGHT NOW. Verify runs snapshot this at start:
 *  gate decisions (mutation exclusion) use the track record as it stood
 *  when the run began — a clean pass mid-run decays scores for the NEXT
 *  run, it does not retroactively un-quarantine the command mid-flight. */
export function knownFlakyCommandKeys(reg: FlakyRegistry): string[] {
  const keys = new Set<string>();
  for (const e of Object.values(reg.entries)) {
    if (e.score >= KNOWN_FLAKE_SCORE) keys.add(e.command);
  }
  return [...keys];
}

export function quarantinedEntries(reg: FlakyRegistry): FlakyEntry[] {
  return Object.values(reg.entries)
    .filter((e) => e.score >= KNOWN_FLAKE_SCORE)
    .sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt);
}

/** Stable key for a verification command (mirrors verification.ts's
 *  baseline keying: a leading `cd <dir> && ` is not part of the identity). */
export function flakeCommandKey(command: string): string {
  const t = command.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** Command-granularity registry id for runners with no per-test names. */
export function commandFlakeId(command: string): string {
  return `cmd:${flakeCommandKey(command)}`;
}

// ---------------------------------------------------------------------------
// Failure-output parsing
// ---------------------------------------------------------------------------

/** Extract failing test identifiers from common runner output shapes:
 *  vitest/jest (FAIL lines, ❯ banners, × cases, ● headers), pytest (FAILED
 *  summary lines), Go (--- FAIL:), node --test TAP (not ok), cargo
 *  (test x ... FAILED). Deliberately conservative: an id we cannot attribute
 *  is worse than none, because ids drive the anti-gaming file check and the
 *  persistent registry. Returns [] when the runner exposes no names — the
 *  caller then treats the command as the flake unit. */
export function parseFailingTests(output: string): string[] {
  const ids: string[] = [];
  const push = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (t && t.length <= 220 && !ids.includes(t)) ids.push(t);
  };
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    // pytest short summary: "FAILED tests/test_x.py::test_y - AssertionError"
    if ((m = line.match(/^FAILED\s+(\S+?)(?:\s+-.*)?$/))) { push(m[1]); continue; }
    // vitest file banner: "❯ src/foo.test.ts (3 tests | 1 failed)"
    if ((m = line.match(/^❯\s+(\S+)\s+\(\d+\s+tests?/))) { push(m[1]); continue; }
    // vitest/jest: "FAIL  src/foo.test.ts > suite > case" | "FAIL src/foo.test.ts"
    if ((m = line.match(/^FAIL\s{1,}(.+)$/))) {
      push(m[1].replace(/\s*\(\d+\s+tests?.*\)\s*$/, ''));
      continue;
    }
    // Go: "--- FAIL: TestName (0.01s)"
    if ((m = line.match(/^--- FAIL:\s*(\S+)/))) { push(m[1]); continue; }
    // node --test TAP: "not ok 12 - test name"
    if ((m = line.match(/^not ok\s+\d+\s*-\s*(.+)$/))) { push(m[1]); continue; }
    // cargo: "test module::case ... FAILED"
    if ((m = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED/))) { push(m[1]); continue; }
    // vitest/jest per-case markers: "× case name" / "✗ case name 12ms"
    if ((m = line.match(/^[×✗✕]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?\s*$/))) { push(m[1]); continue; }
    // jest failure header: "● suite › case" (not "● Console" / suite errors)
    if ((m = line.match(/^●\s+(.+)$/)) && !/^Console\b/.test(m[1]) && !/Test suite failed/.test(m[1])) { push(m[1]); continue; }
  }
  return ids.slice(0, 50);
}

/** The test FILE an id belongs to, when the id carries one (vitest FAIL
 *  chains, pytest node ids). Name-only ids (Go, TAP) return undefined — the
 *  anti-gaming file rule simply cannot apply to them. */
export function flakeFileOf(id: string): string | undefined {
  if (id.startsWith('cmd:')) return undefined;
  const head = id.split(' > ')[0].split('::')[0].trim();
  if (/[./\\]/.test(head) && /\.[a-z]{1,6}$/i.test(head)) return head.replace(/^\.\//, '');
  return undefined;
}

function samePath(a: string, b: string): boolean {
  const na = a.replace(/^\.\//, '').replace(/\\/g, '/');
  const nb = b.replace(/^\.\//, '').replace(/\\/g, '/');
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

export interface FlakePartition {
  /** Flakes excused by quarantine semantics (unrelated files). */
  excused: string[];
  /** Flakes in files THIS run changed — never excused (anti-gaming). */
  ownEdit: string[];
  /** Excused flakes that are nevertheless this task's own target tests —
   *  excused, but warned about more strongly. */
  ownTarget: string[];
}

/** Split resolved flakes by provenance against the run's changed files and
 *  the task's target files (fileScope / named tests). */
export function partitionFlakes(ids: string[], changedFiles: string[], targetFiles: string[]): FlakePartition {
  const out: FlakePartition = { excused: [], ownEdit: [], ownTarget: [] };
  for (const id of ids) {
    const file = flakeFileOf(id);
    if (file && changedFiles.some((f) => samePath(f, file))) { out.ownEdit.push(id); continue; }
    out.excused.push(id);
    if (file && targetFiles.some((f) => samePath(f, file) || file.startsWith(f.replace(/^\.\//, '') + '/'))) {
      out.ownTarget.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded re-run classification
// ---------------------------------------------------------------------------

export interface FlakeRunResult {
  exitCode: number;
  output: string;
}

export interface FlakeAnalysis {
  /** False when the failing set was too large to justify any re-run. */
  eligible: boolean;
  /** Total executions of the command, first attempt included. */
  attempts: number;
  /** True only when a re-run of the unchanged command actually went GREEN:
   *  every first-attempt failure is then explained by flakiness. Without an
   *  observed green run the gate cannot certify the check, however flaky the
   *  individual tests look — callers must FAIL on the last output. */
  resolved: boolean;
  /** Ids that failed attempt 1 but not every attempt. For command-unit
   *  flakes (no parseable ids) this holds the single `cmd:` id. */
  flakyIds: string[];
  /** Ids that failed EVERY attempt — consistent breakage. */
  consistentIds: string[];
  /** Output of the last failing attempt (evidence for the FAIL path). */
  lastOutput: string;
}

/** Exit code from a runShell/runCommand envelope (`exit_code: N` header). */
export function exitCodeOfEnvelope(out: string): number {
  const m = out.match(/^exit_code: (\d+)/);
  return m ? Number(m[1]) : 1;
}

/**
 * Classify a failed command execution by bounded re-runs. `run` executes the
 * SAME command again (no code changes happen between attempts — that is the
 * caller's contract, and what makes pass-on-retry proof of flakiness).
 */
export async function analyzeFailure(
  command: string,
  first: FlakeRunResult,
  run: () => Promise<FlakeRunResult>,
): Promise<FlakeAnalysis> {
  const firstIds = parseFailingTests(first.output);
  if (firstIds.length > MAX_FLAKE_SUBSET) {
    return {
      eligible: false, attempts: 1, resolved: false,
      flakyIds: [], consistentIds: firstIds, lastOutput: first.output,
    };
  }
  const maxExtra = firstIds.length > 0 ? MAX_FLAKE_RERUNS : MAX_FLAKE_RERUNS_UNPARSED;
  // Ids still failing in every attempt so far. An attempt whose output has
  // no parseable ids proves nothing per-test, so it leaves the set intact.
  let consistent = new Set(firstIds);
  let attempts = 1;
  let lastOutput = first.output;
  let commandPassed = false;
  while (attempts - 1 < maxExtra) {
    const next = await run();
    attempts++;
    if (next.exitCode === 0) { commandPassed = true; break; }
    lastOutput = next.output;
    const ids = parseFailingTests(next.output);
    if (ids.length > 0) {
      consistent = new Set([...consistent].filter((id) => ids.includes(id)));
    }
  }
  if (firstIds.length === 0) {
    return {
      eligible: true, attempts, resolved: commandPassed,
      flakyIds: commandPassed ? [commandFlakeId(command)] : [],
      consistentIds: [], lastOutput,
    };
  }
  // A fully green re-run clears every first-attempt failure at once: each
  // one passed with the tree unchanged, which is the definition of a flake.
  const consistentIds = commandPassed ? [] : firstIds.filter((id) => consistent.has(id));
  const flakyIds = firstIds.filter((id) => !consistentIds.includes(id));
  return {
    eligible: true, attempts,
    resolved: commandPassed,
    flakyIds, consistentIds, lastOutput,
  };
}

// ---------------------------------------------------------------------------
// Reporting / changed files
// ---------------------------------------------------------------------------

/** All working-tree changed files (tracked + untracked, harness state
 *  excluded), repo-relative. Used for the anti-gaming own-edit check in the
 *  goals-layer verifier, which has no agent context to consult. */
export function gitChangedFiles(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000,
    });
    const files: string[] = [];
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      const path = line.slice(3).trim().replace(/^"|"$/g, '').split(' -> ').pop() ?? '';
      if (!path) continue;
      if (path.split('/').some((seg) => seg === '.mochi' || seg === 'node_modules')) continue;
      files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

export interface FlakyQuarantineReport {
  tracked: number;
  quarantined: FlakyEntry[];
  entries: FlakyEntry[];
}

/** Read-side view of the registry for status surfaces (doctor, CLI). */
export function flakyQuarantineReport(workspace: Workspace, now = Date.now()): FlakyQuarantineReport {
  const reg = loadFlakyRegistry(workspace, now);
  const entries = Object.values(reg.entries).sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt);
  return { tracked: entries.length, quarantined: quarantinedEntries(reg), entries };
}

export function formatFlakyReport(report: FlakyQuarantineReport): string {
  if (report.tracked === 0) return 'Flaky tests: none tracked.';
  const lines = [`Flaky tests: ${report.tracked} tracked, ${report.quarantined.length} quarantined (score >= ${KNOWN_FLAKE_SCORE}).`];
  for (const e of report.entries.slice(0, 20)) {
    const when = new Date(e.lastSeenAt).toISOString().slice(0, 10);
    lines.push(`  - ${e.id} — score ${e.score}, ${e.flakeEvents} flake event(s), last ${when}${e.score >= KNOWN_FLAKE_SCORE ? ' [QUARANTINED]' : ''}`);
  }
  return lines.join('\n');
}

/** Loud one-block summary of flakes observed in one verify run, for run
 *  summaries and traces. Never returns an empty string when hits exist —
 *  flakes must be impossible to miss. */
export function formatFlakyHits(
  hits: { id: string; known: boolean; ownTarget: boolean }[],
  command: string,
): string {
  if (hits.length === 0) return '';
  const lines = [
    `⚠ FLAKY TESTS OBSERVED via \`${command}\` — failed, then passed on re-run with no code changes. Completion NOT blocked, but these results are not trustworthy:`,
  ];
  for (const h of hits) {
    lines.push(`  - ${h.id}${h.known ? ' (known flaky, quarantined)' : ' (first observed)'}${h.ownTarget ? ' ⚠ THIS TASK’S OWN TARGET TEST — treat its pass with suspicion' : ''}`);
  }
  return lines.join('\n');
}

function failureExample(output: string): string {
  const lines = output.split('\n').filter((l) => /fail|error|expected|assert/i.test(l)).slice(0, 3);
  const text = (lines.length ? lines.join('\n') : output.split('\n').slice(0, 3).join('\n')).trim();
  if (!text) return '';
  return redact(text).slice(0, MAX_EXAMPLE_CHARS);
}
