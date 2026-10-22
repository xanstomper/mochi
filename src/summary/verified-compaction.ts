// Verified compaction (Phase C / C7): retention probe + summary lineage.
//
// Problem: compaction replaces a slice of history with a summary/ledger and
// then SILENTLY continues. If the summary dropped a load-bearing fact (the
// acceptance criterion, the error being fixed, the file under edit), the run
// only discovers the loss many turns later — as drift, re-reads, or a wrong
// fix. This module makes the loss detectable AT compaction time:
//
//   1. BEFORE the cut, extract N probe facts from the to-be-dropped slice.
//      Extraction builds on the Phase A salience ranking (digest-input.ts):
//      lines carrying errors / decisions / paths score salient; the first
//      substantive user message (the task statement) and user constraints
//      are probe-worthy by construction.
//   2. AFTER the cut, run the probe against the post-compaction transcript:
//      can each fact still be "answered" from what remains (needle — path /
//      error code — present verbatim, or >=60% of its distinctive tokens)?
//   3. On failure, ESCALATE instead of continuing silently:
//        level 1 "re-include": the missing facts are re-injected verbatim;
//        level 2 "widen": if they are STILL missing, the raw source
//        excerpts are re-included too (a wider budget for the survivors).
//      The final report is recorded on the caller either way — a compaction
//      that ends with missing facts is surfaced, never hidden.
//
// Lineage: every summary this module stamps carries `[summary sum-<hash>
// parents: <ids|none> replaced: <n> messages]`. The id is a deterministic
// hash of the replaced slice; parents are the ids of any EARLIER summaries
// found inside that slice (a compacted ledger or digest being compacted
// again), so the chain of summaries is walkable back to the raw messages —
// whose fingerprints are also recorded (bounded) on the lineage object.
//
// The probe set is not just the dropped slice: probeFactsFromState() adds
// the pinned state that lives outside the messages — the task contract
// (root goal), explicit constraints, recorded decisions, unresolved
// errors, modified files — so a ledger that drops one of those is caught
// the same way. And each compaction persists a lineage RECORD under
// .mochi/state/compaction-lineage.json (source/digest fingerprints, probe
// outcome, recall_output archive pointers; free text redacted), readable
// via readCompactionLineage().
//
// Deterministic, no model calls. Probe/escalation are pure; only the
// lineage-record persistence touches disk, best-effort.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../security/security.js';
import { lineSalience } from './digest-input.js';

export interface ProbeMessageLike {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

export type ProbeFactKind = 'contract' | 'goal' | 'error' | 'decision' | 'path' | 'constraint' | 'fact';

export interface ProbeFact {
  /** Deterministic id: hash of the fact text + source index. */
  id: string;
  /** The fact, verbatim from the pre-compaction context (one line, bounded). */
  text: string;
  kind: ProbeFactKind;
  /** Index of the source message within the dropped slice. */
  sourceIndex: number;
  sourceRole: string;
  /** High-signal substrings (file paths, error codes). Any one found in the
   *  post-compaction text counts the fact as retained. Derived ONLY from
   *  `text`, so re-including `text` verbatim always satisfies the needle. */
  needles: string[];
  /** Distinctive content tokens of `text` (stopwords removed). Used for the
   *  paraphrase-tolerant overlap check when no needle exists/matches. */
  tokens: string[];
}

export interface RetentionReport {
  total: number;
  retainedIds: string[];
  missing: ProbeFact[];
  /** retained / total (1 when there were no facts to probe). */
  score: number;
  /** True iff every probe fact is still answerable post-compaction. */
  passed: boolean;
}

export interface SummaryLineage {
  /** `sum-<hash>` of the replaced slice. */
  id: string;
  /** Ids of earlier summaries replaced by this one (its parents). */
  parents: string[];
  /** How many messages this summary replaced. */
  replacedCount: number;
  /** Bounded fingerprints (`m<index>:<hash>`) of the replaced messages. */
  replaced: string[];
}

export interface CompactionVerification {
  lineage: SummaryLineage;
  facts: ProbeFact[];
  /** Probe result BEFORE any escalation. */
  initial: RetentionReport;
  /** Probe result AFTER escalation (=== initial when it passed outright). */
  final: RetentionReport;
  /** Escalation steps actually taken, in order: 're-include' | 'widen'. */
  escalations: Array<'re-include' | 'widen'>;
  passed: boolean;
}

// ── Hashing (FNV-1a 32-bit, same family as the loop's redundancy hash) ──────

export function fnvHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Text of a message-like value: string content, text parts of multimodal
 *  content, or a JSON rendering as a last resort. */
export function probeTextOf(m: ProbeMessageLike): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (c == null) return '';
  try { return JSON.stringify(c) ?? ''; } catch { return ''; }
}

// ── Probe-fact extraction ────────────────────────────────────────────────────

const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|java|rb|md|json|yaml|yml|toml|sh)\b/g;
const ERROR_CODE_RE = /\b(?:TS\d{4,5}|[A-Z][A-Za-z]+Error|exit(?: code)? [1-9]\d*)\b/g;
const ERRORISH_RE = /\b(?:error|failed|failure|exception|panic)\b/i;
const CONSTRAINT_RE = /\b(?:must|should|never|always|require[sd]?|constraint|acceptance)\b/i;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'will', 'must',
  'should', 'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being', 'then',
  'than', 'when', 'what', 'which', 'while', 'about', 'after', 'before', 'over',
  'under', 'using', 'used', 'use', 'one', 'all', 'any', 'per', 'via', 'its',
  'it', 'is', 'to', 'of', 'in', 'on', 'a', 'an', 'by', 'or', 'as', 'at', 'be',
  'so', 'if', 'do', 'does', 'did', 'not', 'no', 'yes', 'still', 'just', 'now',
]);

export function distinctiveTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    const t = raw.replace(/^[./-]+|[./-]+$/g, '');
    if (t.length < 3 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 14) break;
  }
  return out;
}

function needlesOf(text: string): string[] {
  const out: string[] = [];
  for (const re of [PATH_RE, ERROR_CODE_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const v = m[0];
      if (v.length >= 4 && !out.includes(v)) out.push(v);
    }
  }
  return out.slice(0, 4);
}

function kindOf(line: string, role: string, isGoal: boolean): ProbeFactKind {
  if (isGoal) return 'goal';
  ERROR_CODE_RE.lastIndex = 0; // global regex: .test() is stateful
  const hasCode = ERROR_CODE_RE.test(line);
  ERROR_CODE_RE.lastIndex = 0;
  if (ERRORISH_RE.test(line) || hasCode) return 'error';
  if (role === 'user' && CONSTRAINT_RE.test(line)) return 'constraint';
  if (/\b(?:decided|decision|chose|chosen|will use|instead of|root cause|fixed by|approach)\b/i.test(line)) return 'decision';
  if (needlesOf(line).length > 0) return 'path';
  return 'fact';
}

/**
 * Extract up to `maxFacts` probe facts from the pre-compaction slice.
 * Candidates: salient lines (Phase A lineSalience), lines carrying a path or
 * error-code needle, user constraints, and the first substantive user
 * message (the task statement). Ranked by score; duplicates (same text or
 * same needle set) collapse. Returned in chronological order.
 */
export function extractProbeFacts(
  messages: readonly ProbeMessageLike[],
  opts: { maxFacts?: number } = {},
): ProbeFact[] {
  const maxFacts = Math.max(1, opts.maxFacts ?? 5);
  interface Cand { text: string; sourceIndex: number; sourceRole: string; score: number; kind: ProbeFactKind }
  const cands: Cand[] = [];
  let firstUserSeen = false;

  messages.forEach((m, index) => {
    const isFirstUser = m.role === 'user' && !firstUserSeen;
    if (m.role === 'user') firstUserSeen = true;
    // Render tool calls as a line too: the PATH of a read/edit lives in the
    // arguments, not the (often empty) assistant prose.
    const lines: Array<{ line: string; bonus: number }> = [];
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        lines.push({ line: `${tc.function.name}(${tc.function.arguments ?? ''})`, bonus: 4 });
      }
    }
    for (const raw of probeTextOf(m).split('\n')) lines.push({ line: raw, bonus: 0 });

    for (const { line, bonus } of lines) {
      const text = line.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (text.length < 8) continue;
      const salience = lineSalience(text);
      const needles = needlesOf(text);
      const userGoal = isFirstUser && text.length >= 24 && text.split(' ').length >= 4;
      const userConstraint = m.role === 'user' && CONSTRAINT_RE.test(text);
      if (!userGoal && !userConstraint && salience < 8 && needles.length === 0) continue;
      let score = salience + bonus + needles.length * 3;
      if (userGoal) score += 50;
      if (userConstraint) score += 10;
      if (m.role === 'user') score += 2;
      cands.push({ text, sourceIndex: index, sourceRole: m.role, score, kind: kindOf(text, m.role, userGoal) });
    }
  });

  cands.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex);
  const picked: Cand[] = [];
  const seenTexts = new Set<string>();
  const seenNeedles = new Set<string>();
  const seenSingleNeedles = new Set<string>();
  for (const c of cands) {
    if (picked.length >= maxFacts) break;
    const key = c.text.toLowerCase();
    if (seenTexts.has(key)) continue;
    const needles = needlesOf(c.text);
    // One fact per needle set: five facts all pointing at the same file
    // probe nothing beyond the first. A path-ONLY fact (its whole signal
    // is the path) is also redundant once any earlier fact carries that
    // same path needle — e.g. an edit tool-call on the file an error fact
    // already names.
    const needleKey = needles.slice().sort().join('|');
    if (needleKey && seenNeedles.has(needleKey) && c.kind !== 'goal') continue;
    if (c.kind === 'path' && needles.some((n) => seenSingleNeedles.has(n))) continue;
    seenTexts.add(key);
    if (needleKey) seenNeedles.add(needleKey);
    for (const n of needles) seenSingleNeedles.add(n);
    picked.push(c);
  }

  return picked
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map((c) => ({
      id: `fact-${fnvHash(`${c.sourceIndex}:${c.text}`)}`,
      text: c.text,
      kind: c.kind,
      sourceIndex: c.sourceIndex,
      sourceRole: c.sourceRole,
      needles: needlesOf(c.text),
      tokens: distinctiveTokens(c.text),
    }));
}

// ── Probe facts from pinned engine state ─────────────────────────────────────

/** The pinned must-survive set that lives OUTSIDE the message slice: the
 *  task contract (root goal), explicit user constraints/corrections,
 *  recorded decisions, unresolved errors, and modified files (ContextState).
 *  The compacted ledger re-injects most of these — but not all (it
 *  historically dropped constraints entirely), so they are probed like any
 *  other fact: if the ledger lost one, escalation restores it verbatim. */
export interface ProbeStateLike {
  goal?: string;
  initialUserPrompt?: string;
  constraints?: readonly string[];
  decisions?: readonly string[];
  errors?: readonly string[];
  filesModified?: readonly string[];
}

function stateFact(kind: ProbeFactKind, text: string): ProbeFact {
  const clean = text.trim().replace(/\s+/g, ' ').slice(0, 200);
  return {
    id: `fact-${fnvHash(`state:${kind}:${clean}`)}`,
    text: clean,
    kind,
    sourceIndex: -1, // pinned state, not a dropped message
    sourceRole: 'state',
    needles: kind === 'contract' || kind === 'constraint' ? [] : needlesOf(clean),
    tokens: distinctiveTokens(clean),
  };
}

export function probeFactsFromState(state: ProbeStateLike): ProbeFact[] {
  const facts: ProbeFact[] = [];
  const contract = (state.initialUserPrompt || state.goal || '').trim();
  // Substance bar, mirroring goal extraction: addMessage stamps
  // initialUserPrompt from ANY first user message ('msg 0' in a synthetic
  // history) — a stub like that is not a pinned contract worth probing.
  if (contract.length >= 24) facts.push(stateFact('contract', contract));
  for (const c of state.constraints ?? []) if (c.trim()) facts.push(stateFact('constraint', c));
  for (const d of state.decisions ?? []) if (d.trim()) facts.push(stateFact('decision', d));
  for (const e of state.errors ?? []) if (e.trim()) facts.push(stateFact('error', e));
  for (const p of state.filesModified ?? []) if (p.trim()) facts.push(stateFact('path', `${p.trim()} (modified)`));
  return facts;
}

/** Merge fact sets, deduping by normalized text. On a collision the
 *  higher-priority kind wins (a state contract beats a slice goal carrying
 *  the same words). Result is priority-ordered. */
export function dedupeProbeFacts(facts: readonly ProbeFact[]): ProbeFact[] {
  const byKey = new Map<string, ProbeFact>();
  for (const f of facts) {
    const key = f.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || KIND_PRIORITY[f.kind] < KIND_PRIORITY[existing.kind]) byKey.set(key, f);
  }
  return [...byKey.values()].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.sourceIndex - b.sourceIndex,
  );
}

// ── Retention probe ──────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/** Can `fact` still be answered from the post-compaction text? A needle hit
 *  (path / error code verbatim) is decisive; otherwise require >=60% of the
 *  fact's distinctive tokens to survive (a faithful paraphrase keeps them). */
export function factRetained(fact: ProbeFact, normalizedPost: string): boolean {
  for (const n of fact.needles) {
    if (normalizedPost.includes(n.toLowerCase())) return true;
  }
  if (fact.tokens.length === 0) return false;
  let hit = 0;
  for (const t of fact.tokens) if (normalizedPost.includes(t)) hit++;
  return hit / fact.tokens.length >= 0.6;
}

export function runRetentionProbe(
  facts: readonly ProbeFact[],
  post: string | readonly ProbeMessageLike[],
): RetentionReport {
  const postText = typeof post === 'string'
    ? post
    : post.map((m) => `${probeTextOf(m)}${m.tool_calls ? ' ' + m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments ?? ''})`).join(' ') : ''}`).join('\n');
  const norm = normalize(postText);
  const retainedIds: string[] = [];
  const missing: ProbeFact[] = [];
  for (const f of facts) {
    if (factRetained(f, norm)) retainedIds.push(f.id);
    else missing.push(f);
  }
  return {
    total: facts.length,
    retainedIds,
    missing,
    score: facts.length === 0 ? 1 : retainedIds.length / facts.length,
    passed: missing.length === 0,
  };
}

/** Kind priority for bounded recovery: lower is restored first. The
 *  contract outranks everything — see buildRecoveryBlock. */
const KIND_PRIORITY: Record<ProbeFactKind, number> = {
  contract: 0,
  goal: 1,
  error: 2,
  decision: 3,
  constraint: 4,
  path: 5,
  fact: 6,
};

/** Default char budget for the recovery appendix. */
export const RECOVERY_BUDGET_CHARS = 4096;

/** The re-include block: missing facts, verbatim, under an explicit header
 *  so a later reader (human or model) knows WHY they are back.
 *
 *  Bounded by `budgetChars`: facts are restored in kind-priority order and
 *  any that do not fit are NAMED in a trailing note (kind + text head) —
 *  never silently dropped. Contract facts are exempt from the budget: the
 *  pinned task contract is always carried in full, even when it alone
 *  exceeds the bound (the overflow stays visible in the block's size). */
export function buildRecoveryBlock(missing: readonly ProbeFact[], budgetChars = RECOVERY_BUDGET_CHARS): string {
  if (missing.length === 0) return '';
  const ordered = [...missing].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.sourceIndex - b.sourceIndex,
  );
  const header = 'RETENTION RECOVERY (compaction probe failed for these facts — re-included verbatim, do not drop):';
  const lines: string[] = [header];
  let used = header.length;
  const omitted: ProbeFact[] = [];
  for (const f of ordered) {
    const line = `- [${f.kind}] ${f.text}`;
    if (f.kind !== 'contract' && used + line.length + 1 > budgetChars) {
      omitted.push(f);
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted.length > 0) {
    const named = omitted.map((f) => `[${f.kind}] ${f.text.slice(0, 80)}`).join('; ');
    lines.push(`(+${omitted.length} fact(s) omitted by the recovery budget of ${budgetChars} chars — NOT restored: ${named})`);
  }
  return lines.join('\n');
}

/**
 * Probe → escalate driver. Pure orchestration over caller-supplied effects:
 * `readText` returns the current post-compaction text; `reinject` performs
 * the re-include step; `widen` (optional) performs the raw re-inclusion.
 * Each step runs only if the previous probe still fails, and the loop
 * re-probes after each — escalation must PROVE it worked, not assume it.
 */
export function ensureRetention(opts: {
  facts: readonly ProbeFact[];
  readText: () => string;
  reinject: (missing: ProbeFact[]) => void;
  widen?: (missing: ProbeFact[]) => void;
}): { initial: RetentionReport; final: RetentionReport; escalations: Array<'re-include' | 'widen'> } {
  const escalations: Array<'re-include' | 'widen'> = [];
  const initial = runRetentionProbe(opts.facts, opts.readText());
  let final = initial;
  if (final.passed || opts.facts.length === 0) return { initial, final, escalations };
  escalations.push('re-include');
  opts.reinject([...final.missing]);
  final = runRetentionProbe(opts.facts, opts.readText());
  if (!final.passed && opts.widen) {
    escalations.push('widen');
    opts.widen([...final.missing]);
    final = runRetentionProbe(opts.facts, opts.readText());
  }
  return { initial, final, escalations };
}

// ── Summary lineage ──────────────────────────────────────────────────────────

const SUMMARY_MARKER_RE = /\[summary (sum-[0-9a-f]{8})(?: parents: ([^\]]*?))?(?: replaced: (\d+) messages)?\]/;

/** Fingerprint one replaced message: position + content hash. Lets a later
 *  reader confirm WHICH messages a summary replaced without storing them. */
export function fingerprintMessage(m: ProbeMessageLike, index: number): string {
  const render = `${m.role}\0${m.name ?? ''}\0${probeTextOf(m)}\0${(m.tool_calls ?? []).map((t) => `${t.function.name}(${t.function.arguments ?? ''})`).join(';')}`;
  return `m${index}:${fnvHash(render)}`;
}

/** Parse a lineage marker previously rendered into a summary/digest text. */
export function parseSummaryMarker(text: string): { id: string; parents: string[] } | null {
  const m = text.match(SUMMARY_MARKER_RE);
  if (!m) return null;
  const parents = (m[2] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^sum-[0-9a-f]{8}$/.test(s));
  return { id: m[1], parents };
}

/** Build the lineage for a summary replacing `messages`: parents are the
 *  summary ids found INSIDE the replaced slice (compacted ledgers and
 *  digests carry their marker), flattened with their own parents so the
 *  chain never loses a generation. */
export function buildSummaryLineage(messages: readonly ProbeMessageLike[]): SummaryLineage {
  const replaced = messages.map((m, i) => fingerprintMessage(m, i));
  const parents: string[] = [];
  const addParent = (id: string) => { if (!parents.includes(id)) parents.push(id); };
  messages.forEach((m) => {
    const marker = parseSummaryMarker(probeTextOf(m));
    if (marker) {
      addParent(marker.id);
      for (const p of marker.parents) addParent(p);
    }
  });
  const id = `sum-${fnvHash(`${parents.join(',')}|${replaced.join(',')}`)}`;
  return {
    id: parents.includes(id) ? `sum-${fnvHash(id + '|self')}` : id,
    parents,
    replacedCount: messages.length,
    replaced: replaced.slice(0, 32),
  };
}

export function renderSummaryLineage(lineage: SummaryLineage): string {
  return `[summary ${lineage.id} parents: ${lineage.parents.length ? lineage.parents.join(',') : 'none'} replaced: ${lineage.replacedCount} messages]`;
}

// ── Persisted compaction lineage (.mochi/state) ──────────────────────────────

export interface CompactionLineageRecord {
  /** Summary lineage id of this compaction. */
  id: string;
  ts: number;
  parents: string[];
  replacedCount: number;
  /** Pre-compaction message index range this compaction replaced. */
  sourceRange: { from: number; to: number };
  /** Fingerprint of the rendered replaced slice. */
  sourceHash: string;
  /** Fingerprint of the compacted digest text that replaced it. */
  digestHash: string;
  probe: {
    total: number;
    /** Fact ids retained in the final post-compaction context. */
    keptIds: string[];
    /** Facts missing initially but restored by escalation. */
    repairedIds: string[];
    /** Facts still missing after escalation (redacted) — empty on pass. */
    missed: Array<{ kind: ProbeFactKind; text: string }>;
    escalations: string[];
    passed: boolean;
  };
  /** recall_output archive ids referenced by the digest / replaced slice:
   *  pointers to the full tool outputs the summary stands in for. */
  archiveIds: string[];
}

const LINEAGE_MAX_RECORDS = 100;
const ARCHIVE_ID_RE = /\bout-[a-z0-9]+-[a-z0-9]+\b/g;

function hash16(text: string): string {
  return fnvHash(text) + fnvHash(`#${text.length}:${text}`);
}

function lineageFilePath(projectRoot: string): string {
  return join(projectRoot, '.mochi', 'state', 'compaction-lineage.json');
}

/** Assemble the persisted record for a finished compaction. Missed fact
 *  texts are redacted here so no caller can persist them raw by mistake. */
export function buildCompactionLineageRecord(args: {
  lineage: SummaryLineage;
  ts: number;
  sourceRange: { from: number; to: number };
  sourceText: string;
  digestText: string;
  verification: CompactionVerification;
  archiveScanText: string;
}): CompactionLineageRecord {
  const v = args.verification;
  const repairedIds = v.initial.missing.map((f) => f.id).filter((id) => v.final.retainedIds.includes(id));
  return {
    id: args.lineage.id,
    ts: args.ts,
    parents: args.lineage.parents,
    replacedCount: args.lineage.replacedCount,
    sourceRange: args.sourceRange,
    sourceHash: hash16(args.sourceText),
    digestHash: hash16(args.digestText),
    probe: {
      total: v.facts.length,
      keptIds: v.final.retainedIds,
      repairedIds,
      missed: v.final.missing.map((f) => ({ kind: f.kind, text: redact(f.text) })),
      escalations: [...v.escalations],
      passed: v.passed,
    },
    archiveIds: [...new Set(args.archiveScanText.match(ARCHIVE_ID_RE) ?? [])],
  };
}

/** Append a record to .mochi/state/compaction-lineage.json (ring-capped at
 *  the newest 100). Best-effort: bookkeeping must never fail a compaction. */
export function recordCompactionLineage(projectRoot: string, record: CompactionLineageRecord): void {
  if (!projectRoot) return;
  try {
    const records = readCompactionLineage(projectRoot);
    records.push(record);
    mkdirSync(join(projectRoot, '.mochi', 'state'), { recursive: true });
    writeFileSync(lineageFilePath(projectRoot), JSON.stringify(records.slice(-LINEAGE_MAX_RECORDS), null, 2), 'utf8');
  } catch {
    /* best-effort bookkeeping */
  }
}

/** Read persisted compaction lineage records (oldest first). With `id`,
 *  returns only the matching record (empty array when absent). This is the
 *  inspection surface for the compaction chain. */
export function readCompactionLineage(projectRoot: string, id?: string): CompactionLineageRecord[] {
  if (!projectRoot) return [];
  try {
    const p = lineageFilePath(projectRoot);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const records = parsed as CompactionLineageRecord[];
    return id ? records.filter((r) => r.id === id) : records;
  } catch {
    return [];
  }
}

/** One-line probe outcome for the compacted ledger / logs. */
export function renderProbeOutcome(v: {
  initial: RetentionReport;
  final: RetentionReport;
  escalations: Array<'re-include' | 'widen'>;
}): string {
  if (v.final.total === 0) return '[compaction-probe: no salient facts to probe]';
  const esc = v.escalations.length ? ` after escalation: ${v.escalations.join(' → ')}` : '';
  const verdict = v.final.passed ? 'retained' : 'STILL MISSING';
  return `[compaction-probe: ${verdict} ${v.final.retainedIds.length}/${v.final.total} facts${esc}]`;
}
