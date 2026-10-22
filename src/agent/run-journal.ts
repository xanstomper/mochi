// Durable run journal (Phase C6) — step-level write-ahead record of a run.
//
// What existed before: compaction checkpoints (a prose Goal/Progress/Next
// summary in workspace state) and the trajectory exporter (a post-hoc view
// over the trace). Neither could answer "which STEPS of this run already
// completed?" — so a killed run resumed from a summary and re-executed
// (and re-billed) every tool call from scratch, including mutations whose
// effects were already on disk (re-applying a patch that already landed,
// re-running an expensive shell command, re-spawning a subagent).
//
// This module is the missing journal semantics:
//
//   * Every completed step is appended to disk SYNCHRONOUSLY (write + fsync)
//     as it completes — one JSON object per line in
//     `<workspaceDir>/journals/<runId>.jsonl`. A SIGKILL between steps loses
//     at most the in-flight step; everything before it is durable.
//   * On resume, a fresh RunJournal over the same runId loads the file and
//     serves completed steps back instead of re-executing them. Replay is
//     keyed two ways:
//       - by stepId (the tool_call_id / caller-chosen step id) — exact, and
//       - by signature (tool name + stable hash of normalized args) — the
//         resumed model regenerates tool_call_ids, so signature replay is
//         what actually saves re-execution in the agent loop. Signature
//         claims are FIFO per signature: two identical calls in the original
//         run replay in order, and a third identical call (no journal entry
//         left) executes fresh — a legitimate repeat after a mutation is
//         never silently served a stale result.
//   * Session boundary: only entries that were ON DISK when this journal
//     instance was opened are claimable. Steps recorded by this same
//     instance are visible for inspection but not claimable until the
//     journal is reopened (a resume). Within one live run, duplicate
//     suppression is the ExecutionRegistry's job (1.5s window); the journal
//     is the CROSS-PROCESS record. This also means a brand-new run in a
//     fresh workspace can never replay its own just-written steps.
//   * Failed steps are journaled for audit but are NOT replayable — a
//     resume retries them.
//   * A torn final line (crash mid-append) is ignored on load; every
//     complete line before it still loads. Appends use a single writeSync
//     of one line, so a tear can only affect the last line.
//   * Everything persisted passes through redact()/redactObject() first
//     (the security house rule for anything written to disk): a secret in
//     a tool output or argument must never land in the journal, because a
//     replay serves the stored text back into the model context verbatim.
//   * Workspace-divergence rail: each step records the post-state hash of
//     any file it touched (via path-like args) and the git HEAD at record
//     time. At claim time the recorded state is re-checked — a file whose
//     current state matches NO state the journal itself recorded, or a
//     HEAD the journal never saw, means the world moved outside this run
//     (user edit, another agent, a manual commit). Replay then stops for
//     the whole journal: later entries were built on a world that no
//     longer exists, so serving them would resurrect stale side effects.
//     States the journal itself produced (a later step rewrote the file,
//     the run committed its own work) always validate — the check only
//     fires on changes the journal cannot explain. Shell steps carry no
//     path args, so their file effects are covered only via git HEAD.
//   * Version skew never guesses: a step line written by a newer journal
//     format (v > JOURNAL_FORMAT_VERSION) makes the file non-claimable
//     (audit-visible, never served).
//   * Model turns replay as a strict sequence (claimModelTurn): each
//     completed turn is journaled with a fingerprint of the exact request
//     that produced it (modelTurnFingerprint — provider, model, full
//     message list as sent, tool schemas offered, output-affecting
//     params). A resume is served the recorded response only while its
//     requests reproduce the journaled fingerprints in order; the first
//     mismatch — or any rail above tripping — ends model-turn replay for
//     the session and the run continues live. Tool-step replay is
//     unaffected and keeps the semantics above.
//
// The journal never throws into the agent: file errors degrade to
// in-memory-only operation (steps still tracked for the process lifetime,
// replay across processes simply unavailable). Callers treat it as
// best-effort durability, exactly like the trace recorder.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { redact, redactObject } from '../security/security.js';

/** On-disk format version stamped on every line this build writes. */
export const JOURNAL_FORMAT_VERSION = 1;

/** What sort of step an entry records. `verify` steps are tool calls to
 *  the verify tool, broken out because their replay semantics (a recorded
 *  pass re-arms the completion gate) differ from an ordinary tool call. */
export type JournalStepKind = 'tool_call' | 'model_turn' | 'verify';

/** Token/cost accounting attached to a step (model turns carry the real
 *  numbers; tool steps usually only durationMs, kept top-level). */
export interface JournalStepUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** One journaled step outcome. Stored verbatim as one JSONL line. */
export interface JournalStepEntry {
  kind: 'step';
  /** Journal format version that wrote this line. */
  v: number;
  /** Monotonic sequence within the journal file (0-based, append order). */
  seq: number;
  runId: string;
  /** Caller-chosen step identity (tool_call_id in the agent loop). */
  stepId: string;
  stepKind: JournalStepKind;
  /** `${toolName}\0${argsHash}` — the signature-replay key. */
  signature: string;
  toolName: string;
  /** Stable hash of the normalized args (see hashArgs). */
  argsHash: string;
  /** Normalized args (redacted), kept for audit/debugging (bounded). */
  args?: Record<string, unknown>;
  /** Model turns only: fingerprint of the canonical model REQUEST that
   *  produced this entry's response (see modelTurnFingerprint). Model-turn
   *  replay is sequence-strict — the recorded response is served only
   *  when a resumed run's next request reproduces this fingerprint
   *  exactly, in the original order. */
  fingerprint?: string;
  status: 'completed' | 'failed';
  /** The output the step produced (what the model saw, for tool steps). */
  output?: string;
  /** Compact one-line-ish summary of the result (first 300 chars). */
  summary?: string;
  /** SHA-256 of the full stored output — fingerprints the result even
   *  when the stored text itself had to be truncated to the bound. */
  outputHash?: string;
  error?: string;
  durationMs?: number;
  usage?: JournalStepUsage;
  /** Post-state of files this step touched: path (relative to the
   *  workspace root when possible) -> content SHA-256, or null when the
   *  file was absent after the step (a delete). Divergence-checked at
   *  claim time; see the module header. */
  files?: Record<string, string | null>;
  /** Git HEAD of the workspace root when the step completed. */
  gitHead?: string;
  /** Session (RunJournal instance) that recorded this step. */
  sessionId: string;
  completedAt: number;
  /** True when output/args were truncated to the storage bound. */
  truncated?: boolean;
  /** True when the OUTPUT itself hit the storage bound: the stored text
   *  is not the full result, so the entry is audit-only, never served. */
  outputTruncated?: boolean;
}

export interface JournalRunMarker {
  kind: 'run_started' | 'run_finished';
  v: number;
  runId: string;
  taskId?: string;
  title?: string;
  /** For run_finished: 'completed' or the run's stop reason. */
  outcome?: string;
  sessionId: string;
  at: number;
}

export type JournalLine = JournalStepEntry | JournalRunMarker;

export interface JournalStats {
  runId: string;
  file: string;
  /** Step entries loaded from disk at open (claimable on resume). */
  loadedSteps: number;
  /** Step entries recorded by this instance. */
  recordedSteps: number;
  /** Completed steps served from the journal instead of re-executing. */
  replayedSteps: number;
  /** Model turns served from the journal instead of calling the provider
   *  (a subset of replayedSteps). Present only when > 0. */
  replayedModelTurns?: number;
  /** Completed steps currently claimable by signature/id. */
  claimableSteps: number;
  /** Summed usage over ALL step entries (loaded + recorded). Replayed
   *  steps add nothing — a resume's totals equal the original run's,
   *  which is exactly the no-double-billing observable. */
  usage: { durationMs: number; inputTokens: number; outputTokens: number };
  /** Workspace divergence detected at claim time; replay has stopped. */
  diverged?: boolean;
  divergenceReason?: string;
  /** Entry cap reached; further steps are no longer persisted. */
  capped?: boolean;
  /** The file contains lines from a newer journal format; not claimable. */
  versionSkew?: boolean;
  /** Unparseable lines skipped at load (torn tail / corruption). */
  corruptLines?: number;
}

/** Storage bound for one step's output / serialized args. Tool output in
 *  the loop is already policy-folded to a few KB; this cap only guards
 *  direct journal users against unbounded lines. */
export const JOURNAL_MAX_STORED_CHARS = 128 * 1024;

/** Hard cap on step entries per journal. Past it, recording stops (the
 *  run continues unjournaled) rather than growing the file forever. */
export const JOURNAL_MAX_ENTRIES = 5000;

/** Journal-directory retention, mirroring trace retention
 *  (pruneTraces: 100 files / 32MB, oldest first). */
export const JOURNAL_MAX_FILES = 100;
export const JOURNAL_MAX_BYTES = 32 * 1024 * 1024;

/** Files larger than this are fingerprinted by size token, not content
 *  hash — hashing a multi-GB artifact per step would dwarf the step. */
const FILE_HASH_MAX_BYTES = 4 * 1024 * 1024;

/** Tools whose post-state for a path arg is meaningful even when the file
 *  is absent afterwards (deletes) or created by the call. For other tools
 *  an absent path is not recorded (a failed read proves nothing). */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write', 'edit', 'delete', 'patch',
  'create_directory', 'mkdir', 'move_file', 'copy_file',
  'replace_symbol', 'rename_symbol', 'regex_replace', 'search_replace_multi',
  'notebook',
]);

/** Arg keys that name a file a step touches. */
const PATH_ARG_KEYS = ['path', 'file_path', 'filePath', 'file'] as const;

function boundText(text: string): { text: string; truncated: boolean } {
  if (text.length <= JOURNAL_MAX_STORED_CHARS) return { text, truncated: false };
  return { text: text.slice(0, JOURNAL_MAX_STORED_CHARS), truncated: true };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Content state of one file: SHA-256, a `size:<n>` token for oversized
 *  files, null when absent, undefined when not a regular file (dirs and
 *  exotic nodes are not tracked). */
function fileState(absPath: string): string | null | undefined {
  try {
    if (!existsSync(absPath)) return null;
    const st = statSync(absPath);
    if (!st.isFile()) return undefined;
    if (st.size > FILE_HASH_MAX_BYTES) return `size:${st.size}`;
    return sha256(readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Filesystem-safe journal file stem for a runId. Keeps readable ids
 *  readable; anything exotic is hashed so distinct ids never collide. */
export function sanitizeRunId(runId: string): string {
  const raw = String(runId ?? '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(raw)) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const stem = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'run';
  return `${stem}-${hash}`;
}

export function journalFilePath(baseDir: string, runId: string): string {
  return resolve(baseDir, 'journals', `${sanitizeRunId(runId)}.jsonl`);
}

/** Stable stringify (sorted keys, recursive) — same contract as the
 *  execution registry's argsKey, so a step's identity never depends on
 *  the model's JSON key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v !== 'function' && typeof v !== 'symbol' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Stable hash of a step's arguments. */
export function hashArgs(args: Record<string, unknown>): string {
  try {
    return createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 24);
  } catch {
    return createHash('sha256').update(`unserializable:${Object.keys(args ?? {}).sort().join(',')}`).digest('hex').slice(0, 24);
  }
}

export function stepSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}\u0000${hashArgs(args)}`;
}

/** Tools whose effects are session-local or interactive, never durable work
 *  steps: replaying them would either do nothing useful (load_tools mutates
 *  the LIVE toolset — the replay path cannot restore it) or fabricate a
 *  user answer (ask_question). The loop neither journals nor replays these. */
export const NON_JOURNALED_TOOLS: ReadonlySet<string> = new Set(['load_tools', 'ask_question']);

export function isJournalableTool(toolName: string): boolean {
  return !NON_JOURNALED_TOOLS.has(toolName);
}

/** The canonical request material a model-turn fingerprint covers. A
 *  provider's response is a function of exactly: which backend/model is
 *  asked, the full message list as sent (the system prompt rides inside
 *  it as the first message in this codebase), the tool schemas offered,
 *  and the sampling parameters that can change the output. Transport-only
 *  concerns (streaming, timeouts, abort signals) cannot change WHAT a
 *  completed response says, so they are deliberately excluded. */
export interface ModelTurnFingerprintInput {
  /** Provider identity as the caller knows it (config.model.provider). */
  provider: string;
  /** Model id as sent (config.model.model). */
  model: string;
  /** The full message list exactly as sent to the provider. */
  messages: ReadonlyArray<{
    role: string;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: string;
    name?: string;
  }>;
  /** Tool schemas offered with the request (name/description/parameters —
   *  the parts a provider actually serializes). */
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    parameters?: unknown;
  }>;
  temperature?: number | null;
  reasoningEffort?: string | null;
  maxTokens?: number | null;
}

/** Fingerprint of one model request: SHA-256 over the stable-stringified
 *  canonical request (see ModelTurnFingerprintInput). Two requests with
 *  the same fingerprint are interchangeable to the provider; any
 *  output-affecting difference — a message edited, a tool schema added,
 *  a different sampling parameter — yields a different fingerprint, and
 *  model-turn replay serves NOTHING on a mismatch. */
export function modelTurnFingerprint(input: ModelTurnFingerprintInput): string {
  const material = {
    v: 1,
    provider: input.provider,
    model: input.model,
    messages: input.messages.map((m) => ({
      role: m.role,
      content: m.content ?? null,
      tool_calls: m.tool_calls ?? null,
      tool_call_id: m.tool_call_id ?? null,
      name: m.name ?? null,
    })),
    tools: input.tools.map((t) => ({
      name: t.name,
      description: t.description ?? null,
      parameters: t.parameters ?? null,
    })),
    params: {
      temperature: input.temperature ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      maxTokens: input.maxTokens ?? null,
    },
  };
  return sha256(stableStringify(material));
}

export interface RunJournalOptions {
  /** Base dir the `journals/` folder lives under (workspace.dir, i.e. the
   *  `.mochi` dir, in the agent loop; any dir in tests). */
  baseDir: string;
  runId: string;
  taskId?: string;
  /** Workspace root that path args resolve against and whose git HEAD is
   *  tracked for divergence. Defaults to baseDir's parent — correct for
   *  the loop, where baseDir IS `<root>/.mochi`. */
  cwd?: string;
}

export class RunJournal {
  readonly runId: string;
  readonly taskId?: string;
  readonly file: string;
  /** This instance's session id — entries recorded before this session are
   *  the ones a resume may claim. */
  readonly sessionId = randomUUID();
  /** Workspace root for file/git divergence checks. */
  private readonly rootDir: string;

  private seq = 0;
  private durable = true;
  /** All step entries in append order (loaded + recorded this session). */
  private steps: JournalStepEntry[] = [];
  /** Completed entries present at open: the claimable pool. */
  private claimableById = new Map<string, JournalStepEntry>();
  private claimableBySig = new Map<string, JournalStepEntry[]>();
  /** Signature -> number of entries already claimed this session (FIFO). */
  private sigClaimCursor = new Map<string, number>();
  private claimedIds = new Set<string>();
  private loadedSteps = 0;
  private recordedSteps = 0;
  private replayedSteps = 0;
  /** Model-turn replay chain: completed, fully-stored model_turn entries
   *  from prior sessions, in original order. Built at load; the chain
   *  STOPS at the first model turn that failed or whose output was
   *  truncated (audit-only) — turns after a gap can never be served,
   *  because the resumed run's request sequence has no way to prove it
   *  reproduces the state that produced them. */
  private modelChain: JournalStepEntry[] = [];
  /** True once a failed/truncated model turn has ended chain building. */
  private modelChainSealed = false;
  /** Position of the next claimable model turn in modelChain. */
  private modelTurnCursor = 0;
  /** Latched forever once model-turn replay ends for this session (first
   *  fingerprint mismatch, divergence, unparseable payload, or chain
   *  exhaustion): there is no resume-the-replay, the run continues live. */
  private modelReplayEnded = false;
  private replayedModelTurns = 0;
  private started = false;
  private finishedOutcome: string | undefined;
  /** Every file state the journal itself has recorded, per path — the
   *  "explainable" set for divergence checks (a later step legitimately
   *  rewriting a file must not look like external tampering). */
  private fileStates = new Map<string, Set<string | null>>();
  /** Every git HEAD the journal has recorded across its entries. */
  private gitHeads = new Set<string>();
  private divergedReason: string | undefined;
  private capped = false;
  private versionSkew = false;
  private corruptLines = 0;
  private gitHeadCache: { at: number; value: string | undefined } | undefined;

  private constructor(opts: RunJournalOptions) {
    this.runId = opts.runId;
    this.taskId = opts.taskId;
    this.file = journalFilePath(opts.baseDir, opts.runId);
    this.rootDir = opts.cwd ?? resolve(opts.baseDir, '..');
    this.loadFromDisk();
  }

  /** Open (creating on first record) the journal for a run and load any
   *  prior session's steps. Never throws. */
  static open(opts: RunJournalOptions): RunJournal {
    // Retention first (trace discipline): bound the journals directory
    // before this run adds to it. Never prunes the file being opened.
    try {
      pruneRunJournals(opts.baseDir, { keepFile: journalFilePath(opts.baseDir, opts.runId) });
    } catch { /* retention must never block a run */ }
    return new RunJournal(opts);
  }

  private loadFromDisk(): void {
    let raw: string;
    try {
      if (!existsSync(this.file)) return;
      raw = readFileSync(this.file, 'utf8');
    } catch {
      this.durable = false;
      return;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: JournalLine;
      try {
        parsed = JSON.parse(line) as JournalLine;
      } catch {
        // Torn tail (crash mid-append) or external corruption: the line
        // is unrecoverable, but lines are self-contained and seq-ordered,
        // so later complete lines still load — one bad line must not
        // brick the journal for every future resume.
        this.corruptLines++;
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.kind === 'run_finished') {
        this.finishedOutcome = (parsed as JournalRunMarker).outcome;
        continue;
      }
      if (parsed.kind !== 'step') continue;
      const entry = parsed as JournalStepEntry;
      // Version skew: a line from a NEWER format than this build writes.
      // Its semantics are unknowable — the whole file becomes audit-only.
      if (typeof entry.v === 'number' && entry.v > JOURNAL_FORMAT_VERSION) {
        this.versionSkew = true;
        continue;
      }
      if (typeof entry.seq === 'number' && entry.seq >= this.seq) this.seq = entry.seq + 1;
      this.steps.push(entry);
      this.loadedSteps++;
      this.indexEntryState(entry);
      // Model-turn replay chain (see the field comment): prior sessions'
      // model turns in order; the first failed/truncated one ends it.
      if (entry.stepKind === 'model_turn') {
        if (!this.modelChainSealed && entry.status === 'completed' && !entry.outputTruncated) {
          this.modelChain.push(entry);
        } else {
          // Seal the chain: this turn (and every model turn after it)
          // stays audit-only. Entries already pushed keep their
          // positions; claims stop at the gap because the chain simply
          // has no entry for that turn.
          this.modelChainSealed = true;
        }
      }
      // Output-truncated entries are audit-only: the stored text is not
      // the full result, so serving it would fabricate an outcome.
      if (entry.status === 'completed' && !entry.outputTruncated) {
        // First entry wins for a stepId (a re-executed duplicate appended
        // after a same-session retry must not shadow the original).
        if (!this.claimableById.has(entry.stepId)) this.claimableById.set(entry.stepId, entry);
        const queue = this.claimableBySig.get(entry.signature) ?? [];
        queue.push(entry);
        this.claimableBySig.set(entry.signature, queue);
      }
    }
    if (this.versionSkew) {
      this.claimableById.clear();
      this.claimableBySig.clear();
      // A newer format's model turns are just as unknowable: no chain.
      this.modelChain = [];
      this.modelReplayEnded = true;
    }
  }

  /** Fold one entry's recorded workspace state into the explainable sets
   *  used by the divergence check. */
  private indexEntryState(entry: JournalStepEntry): void {
    if (entry.gitHead) this.gitHeads.add(entry.gitHead);
    if (entry.files) {
      for (const [rel, state] of Object.entries(entry.files)) {
        const set = this.fileStates.get(rel) ?? new Set<string | null>();
        set.add(state);
        this.fileStates.set(rel, set);
      }
    }
  }

  /** Current git HEAD of the workspace root (undefined outside a repo).
   *  Cached briefly — a record/claim burst must not fork git per step. */
  private gitHeadNow(): string | undefined {
    const now = Date.now();
    if (this.gitHeadCache && now - this.gitHeadCache.at < 1000) return this.gitHeadCache.value;
    let value: string | undefined;
    try {
      const out = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.rootDir,
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      if (/^[0-9a-f]{40}$/.test(out)) value = out;
    } catch { /* not a git repo / git missing — HEAD checks stay off */ }
    this.gitHeadCache = { at: now, value };
    return value;
  }

  /** Post-state of every file a step touches, keyed by root-relative path
   *  (absolute when the arg escapes the root). Absent files are recorded
   *  (as null) only for file-mutating tools — see FILE_MUTATING_TOOLS. */
  private captureFileStates(toolName: string, args: Record<string, unknown>): Record<string, string | null> | undefined {
    const out: Record<string, string | null> = {};
    const candidates: string[] = [];
    for (const key of PATH_ARG_KEYS) {
      const v = args[key];
      if (typeof v === 'string' && v) candidates.push(v);
    }
    if (Array.isArray(args.paths)) {
      for (const v of args.paths) if (typeof v === 'string' && v) candidates.push(v);
    }
    for (const raw of candidates) {
      const abs = resolve(this.rootDir, raw);
      const rel = abs.startsWith(`${this.rootDir}/`) ? abs.slice(this.rootDir.length + 1) : abs;
      const state = fileState(abs);
      if (state === undefined) {
        // Absent or non-file: only a mutating tool's absence is a fact
        // worth recording (the step DELETED / failed to create it).
        if (!existsSync(abs) && FILE_MUTATING_TOOLS.has(toolName)) out[rel] = null;
        continue;
      }
      out[rel] = state;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * Divergence check for one candidate entry. Returns a reason string
   * when the workspace has moved in a way the journal cannot explain,
   * undefined when the entry is safe to serve. A current state is
   * explainable iff it equals the entry's recorded state OR any state
   * the journal recorded for that file/HEAD in ANY session — the run's
   * own later steps rewriting a file (or committing) is not tampering.
   */
  private divergenceFor(entry: JournalStepEntry): string | undefined {
    if (entry.gitHead) {
      const now = this.gitHeadNow();
      if (now && now !== entry.gitHead && !this.gitHeads.has(now)) {
        return `git HEAD moved outside the journaled run (${entry.gitHead.slice(0, 8)} -> ${now.slice(0, 8)})`;
      }
    }
    if (entry.files) {
      for (const [rel, recorded] of Object.entries(entry.files)) {
        const now = fileState(resolve(this.rootDir, rel)) ?? null;
        if (now !== recorded && !this.fileStates.get(rel)?.has(now)) {
          return `file "${rel}" changed outside the journaled run`;
        }
      }
    }
    return undefined;
  }

  /** Replay stops journal-wide: once the world has diverged, entries
   *  after the divergence point were built on state that no longer
   *  exists, so NONE of them may be served. */
  private failDivergence(reason: string): void {
    this.divergedReason = reason;
    this.claimableById.clear();
    this.claimableBySig.clear();
    this.sigClaimCursor.clear();
    this.claimedIds.clear();
  }

  /** Append one line durably: single write + fsync before returning, so a
   *  step reported complete to the caller survives an immediate SIGKILL. */
  private appendLine(line: JournalLine): void {
    if (!this.durable) return;
    try {
      mkdirSync(resolve(this.file, '..'), { recursive: true });
      const fd = openSync(this.file, 'a');
      try {
        appendFileSync(fd, JSON.stringify(line) + '\n', 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Degrade to in-memory only: the run continues, cross-process replay
      // is simply unavailable. Never break the agent over its journal.
      this.durable = false;
    }
  }

  /** Write the run_started marker (idempotent per instance). */
  beginRun(meta?: { taskId?: string; title?: string }): void {
    if (this.started) return;
    this.started = true;
    this.appendLine({
      kind: 'run_started',
      v: JOURNAL_FORMAT_VERSION,
      runId: this.runId,
      taskId: meta?.taskId ?? this.taskId,
      title: meta?.title ? redact(meta.title) : meta?.title,
      sessionId: this.sessionId,
      at: Date.now(),
    });
  }

  /** Record a finished step. The append is synchronous + fsynced: when
   *  this returns, the step is durable. Returns the stored entry.
   *
   *  Redaction happens HERE, before anything is persisted: output, error
   *  and the stored args copy all pass through the security redactors.
   *  The args fingerprint is computed over the caller's ORIGINAL args —
   *  claims recompute it from live args, so the two always agree. */
  recordStep(input: {
    stepId: string;
    toolName: string;
    args: Record<string, unknown>;
    output?: string;
    error?: string;
    durationMs?: number;
    stepKind?: JournalStepKind;
    usage?: JournalStepUsage;
    /** Model turns: fingerprint of the request that produced the output
     *  (see modelTurnFingerprint). Stored verbatim; claims compare it. */
    fingerprint?: string;
  }): JournalStepEntry {
    const argsHash = hashArgs(input.args);
    let args: Record<string, unknown> | undefined;
    let truncated = false;
    try {
      const ser = stableStringify(input.args);
      if (ser.length <= JOURNAL_MAX_STORED_CHARS) args = redactObject(input.args);
      else truncated = true;
    } catch { /* args stay undefined; the hash still identifies the step */ }
    let output = input.output;
    let outputTruncated = false;
    let outputHash: string | undefined;
    let summary: string | undefined;
    if (typeof output === 'string') {
      output = redact(output);
      outputHash = sha256(output);
      summary = output.slice(0, 300);
      const bounded = boundText(output);
      output = bounded.text;
      truncated = truncated || bounded.truncated;
      outputTruncated = bounded.truncated;
    }
    const files = this.captureFileStates(input.toolName, input.args);
    const gitHead = this.gitHeadNow();
    const entry: JournalStepEntry = {
      kind: 'step',
      v: JOURNAL_FORMAT_VERSION,
      seq: this.seq++,
      runId: this.runId,
      stepId: input.stepId,
      stepKind: input.stepKind ?? (input.toolName === 'verify' ? 'verify' : input.toolName === 'model_turn' ? 'model_turn' : 'tool_call'),
      signature: `${input.toolName}\u0000${argsHash}`,
      toolName: input.toolName,
      argsHash,
      ...(args !== undefined ? { args } : {}),
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
      status: input.error ? 'failed' : 'completed',
      ...(output !== undefined ? { output } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(outputHash !== undefined ? { outputHash } : {}),
      ...(input.error ? { error: redact(input.error) } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(gitHead !== undefined ? { gitHead } : {}),
      sessionId: this.sessionId,
      completedAt: Date.now(),
      ...(truncated ? { truncated: true } : {}),
      ...(outputTruncated ? { outputTruncated: true } : {}),
    };
    if (this.steps.length >= JOURNAL_MAX_ENTRIES) {
      // Cap reached: the step still happened (the caller gets its entry),
      // but it is not persisted — durability degrades, never the run.
      this.capped = true;
      return entry;
    }
    this.steps.push(entry);
    this.recordedSteps++;
    // Deliberately NOT indexed into the divergence explainable-sets: this
    // session's own writes must not legitimize serving a PRIOR session's
    // entry whose world has since been rewritten live. A future session
    // indexes this entry at load, when it is genuinely prior state.
    this.appendLine(entry);
    return entry;
  }

  /** Record a completed/failed tool execution (agent-loop convenience). */
  recordToolResult(input: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    output: string;
    error?: string;
    durationMs?: number;
  }): JournalStepEntry {
    return this.recordStep({
      stepId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      output: input.output,
      error: input.error,
      durationMs: input.durationMs,
    });
  }

  /** Record a completed model turn (the response payload + its billed
   *  usage). The `output` is the serialized response a replay serves; the
   *  `fingerprint` identifies the request that produced it. A resume
   *  whose next request reproduces the fingerprint exactly is served the
   *  recorded response via claimModelTurn instead of re-calling (and
   *  re-billing) the provider. */
  recordModelTurn(input: {
    stepId: string;
    args?: Record<string, unknown>;
    output: string;
    usage?: JournalStepUsage;
    durationMs?: number;
    fingerprint?: string;
  }): JournalStepEntry {
    return this.recordStep({
      stepId: input.stepId,
      toolName: 'model_turn',
      stepKind: 'model_turn',
      args: input.args ?? {},
      output: input.output,
      usage: input.usage,
      durationMs: input.durationMs,
      fingerprint: input.fingerprint,
    });
  }

  /** Mark the run finished (audit marker). Step entries stay claimable: a
   *  later session with the same runId IS a resume, and replaying a
   *  finished run's steps is the idempotency contract. */
  finishRun(outcome: string): void {
    this.appendLine({
      kind: 'run_finished',
      v: JOURNAL_FORMAT_VERSION,
      runId: this.runId,
      taskId: this.taskId,
      outcome,
      sessionId: this.sessionId,
      at: Date.now(),
    });
    this.finishedOutcome = outcome;
  }

  // ── Replay lookups ─────────────────────────────────────────────────────

  /** Exact replay by stepId. Claimable = recorded by a PREVIOUS session
   *  (present at open) and not already claimed by id in this session.
   *  Every claim passes the divergence check first: a diverged workspace
   *  serves nothing, to anyone, ever again in this session. */
  claimById(stepId: string): JournalStepEntry | undefined {
    if (this.divergedReason) return undefined;
    const entry = this.claimableById.get(stepId);
    if (!entry || this.claimedIds.has(entry.stepId + '@' + entry.seq)) return undefined;
    const problem = this.divergenceFor(entry);
    if (problem) {
      this.failDivergence(problem);
      return undefined;
    }
    this.claimedIds.add(entry.stepId + '@' + entry.seq);
    this.replayedSteps++;
    return entry;
  }

  /** Signature replay: the next unclaimed completed entry for
   *  (toolName, args), in original execution order (FIFO). Returns
   *  undefined when the journal holds no (further) matching step — the
   *  caller then executes for real. */
  claimBySignature(toolName: string, args: Record<string, unknown>): JournalStepEntry | undefined {
    if (this.divergedReason) return undefined;
    const sig = stepSignature(toolName, args);
    const queue = this.claimableBySig.get(sig);
    if (!queue) return undefined;
    const cursor = this.sigClaimCursor.get(sig) ?? 0;
    if (cursor >= queue.length) return undefined;
    const entry = queue[cursor];
    const problem = this.divergenceFor(entry);
    if (problem) {
      this.failDivergence(problem);
      return undefined;
    }
    this.sigClaimCursor.set(sig, cursor + 1);
    this.replayedSteps++;
    return entry;
  }

  /** Combined lookup the agent loop uses: exact id first (the model's
   *  tool_call_id survived in a replayed transcript), signature second
   *  (fresh ids on a true resume). */
  claim(input: { stepId?: string; toolName: string; args: Record<string, unknown> }): JournalStepEntry | undefined {
    if (input.stepId) {
      const byId = this.claimById(input.stepId);
      if (byId) {
        // Keep the signature cursor in step: this entry must not be served
        // twice (once by id, once by signature).
        const queue = this.claimableBySig.get(byId.signature);
        if (queue) {
          const idx = queue.indexOf(byId);
          const cursor = this.sigClaimCursor.get(byId.signature) ?? 0;
          if (idx >= cursor) this.sigClaimCursor.set(byId.signature, idx + 1);
        }
        return byId;
      }
    }
    return this.claimBySignature(input.toolName, input.args);
  }

  // ── Model-turn replay ──────────────────────────────────────────────
  //
  // Model turns replay as a STRICT SEQUENCE, unlike tool steps: a tool
  // step is an independent fact ("this call already ran with these
  // args"), but a model response is only meaningful as the answer to the
  // exact conversation state that produced it. Claims therefore consume
  // the loaded chain in order — the Nth claim of a session is checked
  // against the Nth journaled turn — and the FIRST failure of any kind
  // (fingerprint mismatch, chain exhaustion, divergence, unparseable
  // payload) ends model-turn replay permanently for the session. The
  // run then continues live; nothing is ever served approximately.

  /** True when a prior session journaled at least one model turn this
   *  session has not yet claimed or invalidated. Hosts use this to know
   *  model-turn replay is armed BEFORE the first model call (e.g. to
   *  keep resume-time context injections from poisoning turn 1). */
  hasClaimableModelTurns(): boolean {
    return !this.modelReplayEnded && !this.divergedReason && this.modelTurnCursor < this.modelChain.length;
  }

  /** Permanently end model-turn replay for this session (the caller hit
   *  a rail the journal cannot see itself, e.g. a payload whose shape
   *  the loop cannot accept). Tool-step replay is unaffected. */
  endModelReplay(): void {
    this.modelReplayEnded = true;
  }

  /** Claim the next journaled model turn for a request fingerprint.
   *  Returns the entry and its parsed response payload ONLY on exact
   *  fingerprint equality with the next unclaimed chain entry; any other
   *  outcome returns undefined and latches replay off for the session. */
  claimModelTurn(fingerprint: string): { entry: JournalStepEntry; payload: unknown } | undefined {
    if (this.modelReplayEnded) return undefined;
    if (this.divergedReason) {
      this.modelReplayEnded = true;
      return undefined;
    }
    const entry = this.modelChain[this.modelTurnCursor];
    if (!entry) {
      // Chain exhausted (or sealed at a gap): the live run has reached
      // the frontier of the journaled prefix. Replay is over, cleanly.
      this.modelReplayEnded = true;
      return undefined;
    }
    if (!entry.fingerprint || entry.fingerprint !== fingerprint) {
      // The resumed run's next request is NOT the request this response
      // answered — serving it would fabricate a continuation. End here:
      // later turns were answers to a state built on THIS response, so
      // none of them may be served either.
      this.modelReplayEnded = true;
      return undefined;
    }
    const problem = this.divergenceFor(entry);
    if (problem) {
      this.failDivergence(problem);
      this.modelReplayEnded = true;
      return undefined;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(entry.output ?? 'null');
    } catch {
      // The stored response cannot be reconstructed (redaction edge,
      // torn write that still parsed as JSON, …). Never serve a guess.
      this.modelReplayEnded = true;
      return undefined;
    }
    if (payload === null || typeof payload !== 'object') {
      this.modelReplayEnded = true;
      return undefined;
    }
    this.modelTurnCursor++;
    this.replayedSteps++;
    this.replayedModelTurns++;
    return { entry, payload };
  }

  /** Non-claiming inspection: was this stepId completed in ANY session
   *  (including this one)? Used by tests/diagnostics, not the replay path. */
  getCompleted(stepId: string): JournalStepEntry | undefined {
    return this.steps.find((s) => s.stepId === stepId && s.status === 'completed');
  }

  isCompleted(stepId: string): boolean {
    return this.getCompleted(stepId) !== undefined;
  }

  /** All step entries in order (loaded + this session's). */
  entries(): JournalStepEntry[] {
    return [...this.steps];
  }

  completedSteps(): JournalStepEntry[] {
    return this.steps.filter((s) => s.status === 'completed');
  }

  get completedCount(): number {
    return this.steps.reduce((n, s) => n + (s.status === 'completed' ? 1 : 0), 0);
  }

  /** Outcome recorded by a previous finishRun, if any. */
  get priorOutcome(): string | undefined {
    return this.finishedOutcome;
  }

  /** True when this journal was written to disk successfully so far. */
  get isDurable(): boolean {
    return this.durable;
  }

  stats(): JournalStats {
    let claimable = 0;
    for (const queue of this.claimableBySig.values()) claimable += queue.length;
    const usage = { durationMs: 0, inputTokens: 0, outputTokens: 0 };
    for (const s of this.steps) {
      usage.durationMs += s.durationMs ?? 0;
      usage.inputTokens += s.usage?.inputTokens ?? 0;
      usage.outputTokens += s.usage?.outputTokens ?? 0;
    }
    return {
      runId: this.runId,
      file: this.file,
      loadedSteps: this.loadedSteps,
      recordedSteps: this.recordedSteps,
      replayedSteps: this.replayedSteps,
      claimableSteps: claimable,
      usage,
      ...(this.replayedModelTurns > 0 ? { replayedModelTurns: this.replayedModelTurns } : {}),
      ...(this.divergedReason ? { diverged: true, divergenceReason: this.divergedReason } : {}),
      ...(this.capped ? { capped: true } : {}),
      ...(this.versionSkew ? { versionSkew: true } : {}),
      ...(this.corruptLines > 0 ? { corruptLines: this.corruptLines } : {}),
    };
  }

  /** Delete the journal file (fresh start for this runId). */
  clear(): void {
    try { unlinkSync(this.file); } catch { /* best effort */ }
    this.steps = [];
    this.claimableById.clear();
    this.claimableBySig.clear();
    this.sigClaimCursor.clear();
    this.claimedIds.clear();
    this.fileStates.clear();
    this.gitHeads.clear();
    this.loadedSteps = 0;
    this.divergedReason = undefined;
    this.capped = false;
    this.versionSkew = false;
    this.corruptLines = 0;
    this.modelChain = [];
    this.modelChainSealed = false;
    this.modelTurnCursor = 0;
    this.modelReplayEnded = false;
    this.replayedModelTurns = 0;
  }

  // ── Step execution with replay ─────────────────────────────────────────

  /**
   * Execute one journaled step, or replay it.
   *
   * If a previous session completed `stepId` (or an identical tool
   * signature, when `toolName`/`args` are given), the stored result is
   * returned with `replayed: true` and `execute` is NEVER called — no
   * side effect, no re-billing. Otherwise `execute` runs, its result is
   * journaled (durably, before returning), and returned with
   * `replayed: false`. A throwing executor is journaled as a failed step
   * and re-thrown — failures are never replayed, a resume retries them.
   *
   * Results are stored via JSON round-trip (`serialize`/`deserialize`
   * override the encoding), so a replayed result is exactly what a fresh
   * load from disk would produce.
   */
  async executeStep<T>(input: {
    stepId: string;
    toolName?: string;
    args?: Record<string, unknown>;
    execute: () => Promise<T> | T;
    serialize?: (result: T) => string;
    deserialize?: (stored: string) => T;
  }): Promise<{ result: T; replayed: boolean; entry: JournalStepEntry }> {
    const toolName = input.toolName ?? input.stepId;
    const args = input.args ?? {};
    const prior = this.claim({ stepId: input.stepId, toolName, args });
    if (prior) {
      const stored = prior.output ?? '';
      const result = input.deserialize ? input.deserialize(stored) : (JSON.parse(stored || 'null') as T);
      return { result, replayed: true, entry: prior };
    }
    const startedAt = Date.now();
    try {
      const result = await input.execute();
      const stored = input.serialize ? input.serialize(result) : JSON.stringify(result) ?? '';
      const entry = this.recordStep({
        stepId: input.stepId,
        toolName,
        args,
        output: stored,
        durationMs: Date.now() - startedAt,
      });
      return { result, replayed: false, entry };
    } catch (err) {
      this.recordStep({
        stepId: input.stepId,
        toolName,
        args,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
}

/** One step in a journaled step sequence (see runJournaledSteps). */
export interface JournaledStep<T = unknown> {
  id: string;
  toolName?: string;
  args?: Record<string, unknown>;
  execute: () => Promise<T> | T;
  serialize?: (result: T) => string;
  deserialize?: (stored: string) => T;
}

/**
 * Run a sequence of steps through a journal: completed steps replay,
 * remaining steps execute in order. This is the resume driver the
 * falsifiable kill/resume test exercises — and the shape any stepwise
 * caller (bench harness, multi-step tool pipelines) can adopt without
 * the full agent loop.
 */
export async function runJournaledSteps<T>(
  journal: RunJournal,
  steps: Array<JournaledStep<T>>,
): Promise<Array<{ id: string; result: T; replayed: boolean }>> {
  const out: Array<{ id: string; result: T; replayed: boolean }> = [];
  for (const step of steps) {
    const { result, replayed } = await journal.executeStep({
      stepId: step.id,
      toolName: step.toolName,
      args: step.args,
      execute: step.execute,
      serialize: step.serialize,
      deserialize: step.deserialize,
    });
    out.push({ id: step.id, result, replayed });
  }
  return out;
}

/** Read a journal file's lines back (bad lines skipped, like load). */
export function readJournalEntries(baseDir: string, runId: string): JournalLine[] {
  const file = journalFilePath(baseDir, runId);
  if (!existsSync(file)) return [];
  const out: JournalLine[] = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalLine);
      } catch {
        continue;
      }
    }
  } catch { /* unreadable => no entries */ }
  return out;
}

/**
 * Retention for the journals directory — the same discipline as trace
 * retention (pruneTraces): keep at most `maxFiles` journal files and
 * `maxBytes` total, deleting oldest (by mtime) first. `keepFile` (the
 * journal being opened) is never deleted. Returns files removed.
 * RunJournal.open runs this automatically; hosts may also call it.
 */
export function pruneRunJournals(
  baseDir: string,
  opts?: { keepFile?: string; maxFiles?: number; maxBytes?: number },
): number {
  const maxFiles = opts?.maxFiles ?? JOURNAL_MAX_FILES;
  const maxBytes = opts?.maxBytes ?? JOURNAL_MAX_BYTES;
  try {
    const dir = resolve(baseDir, 'journals');
    if (!existsSync(dir)) return 0;
    const files: Array<{ path: string; mtime: number; size: number }> = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = resolve(dir, f);
      try {
        const st = statSync(p);
        files.push({ path: p, mtime: st.mtimeMs, size: st.size });
      } catch { /* racing deletion — skip */ }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, f) => n + f.size, 0);
    let count = files.length;
    let removed = 0;
    for (const f of files) {
      if (count <= maxFiles && total <= maxBytes) break;
      if (opts?.keepFile && f.path === opts.keepFile) continue;
      try {
        unlinkSync(f.path);
        removed++;
        count--;
        total -= f.size;
      } catch { /* best effort */ }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** RunIds with a journal under baseDir (file stems, sorted for determinism). */
export function listRunJournals(baseDir: string): string[] {
  try {
    const dir = resolve(baseDir, 'journals');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)).sort();
  } catch {
    return [];
  }
}
