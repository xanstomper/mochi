// Unified memory retrieval + substantive success writes (P1.5).
//
// Mochi historically had FOUR memory stores with no shared index — global
// facts (~/.mochi/memory.jsonl), workspace markdown (.mochi/memory/*.md),
// project memory (.mochi/project-memory.md) and lessons
// (.mochi/memory/lessons.json) — and every injector searched at most one of
// them, with keyword/Jaccard scoring only. This module is the single search
// entry point over all four. It is READ-UNIFY only: the stores keep their
// on-disk formats and their existing writers; nothing is migrated.
//
// Ranking = reciprocal-rank fusion (RRF) of two dependency-free rankers:
//   1. keyword — relevance.ts scoreEntry (stemmed, synonym-clustered token
//      overlap): precise when the query reuses the stored vocabulary.
//   2. semantic — character-trigram TF vectors + cosine similarity. Local,
//      deterministic, no embeddings, no network. Trigrams capture sub-word
//      and morphological overlap ("rebuilds" ~ "build rerun", "lockfile" ~
//      "lock file", "signing out" ~ "signs out") that token overlap scores
//      as exactly zero. This is the local semantic signal relevance.ts's
//      header anticipated swapping in when the corpus outgrew keywords.
// A candidate both rankers like beats a candidate only one likes: keyword
// stuffing (order-blind token overlap) cannot win on its own, and a vague
// semantic vibe without any lexical anchor cannot either.
//
// The module also hosts the loop's success-fact writer (recordRunSuccessFact)
// — the first caller of the global store's addFact() inside the agent loop.
// Until now the automatic write signal was failures (consolidation) and a
// "Run touched N file(s)" line (project memory); completed runs recorded
// nothing substantive anywhere.

import { loadFacts, addFact, type MemoryFact } from './memory-store.js';
import { MemoryStore } from './memory.js';
import { loadProjectMemoryEntries } from './project-memory.js';
import { loadLessons } from '../lessons.js';
import { scoreEntry } from './relevance.js';

export type MemorySourceId = 'global' | 'workspace' | 'project' | 'lessons';

export interface UnifiedCandidate {
  source: MemorySourceId;
  /** Short label rendered above the text ('' when the text stands alone). */
  title: string;
  text: string;
  kind?: string;
  /** Project overview blob: carried regardless of score, rendered first. */
  always?: boolean;
  updatedAt?: number;
}

export interface UnifiedMemoryHit extends UnifiedCandidate {
  /** Fused reciprocal-rank score (higher is better; not a probability). */
  score: number;
  keywordScore: number;
  semanticScore: number;
}

// ---------------------------------------------------------------------------
// Character n-gram semantic signal
// ---------------------------------------------------------------------------

const NGRAM = 3;

/** Lowercase, punctuation-collapsed form the trigram vectors are built from. */
export function normalizeForNgrams(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Term-frequency vector of character trigrams (space-padded so word-edge
 *  grams like " lo" / "ck " participate — they carry the cross-word signal). */
export function ngramVector(text: string): Map<string, number> {
  const s = ` ${normalizeForNgrams(text)} `;
  const v = new Map<string, number>();
  for (let i = 0; i + NGRAM <= s.length; i++) {
    const g = s.slice(i, i + NGRAM);
    v.set(g, (v.get(g) ?? 0) + 1);
  }
  return v;
}

function cosineOf(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [g, c] of a) {
    na += c * c;
    const o = b.get(g);
    if (o !== undefined) dot += c * o;
  }
  for (const c of b.values()) nb += c * c;
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Cosine similarity between two texts' trigram TF vectors, 0..1. */
export function ngramSimilarity(a: string, b: string): number {
  return cosineOf(ngramVector(a), ngramVector(b));
}

// ---------------------------------------------------------------------------
// Fusion ranking (pure)
// ---------------------------------------------------------------------------

/** A ranker only contributes when its score clears this floor — otherwise a
 *  candidate ranked #1 by a ranker that found nothing would still collect a
 *  full RRF share. The semantic floor sits above the cosine noise two
 *  unrelated short texts produce from shared stopword trigrams alone. */
export const KEYWORD_FLOOR = 0;
export const SEMANTIC_FLOOR = 0.05;
const RRF_K = 60;

function rankPositions(scores: number[]): Map<number, number> {
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => (b.s - a.s) || (a.i - b.i));
  const ranks = new Map<number, number>();
  order.forEach((o, pos) => ranks.set(o.i, pos + 1));
  return ranks;
}

/**
 * Rank candidates against a query by fusing the keyword and trigram rankers
 * with reciprocal-rank fusion: fused = Σ 1/(K + rank) over the rankers that
 * cleared their floor. Deterministic: score ties break on the stronger single
 * signal, then on insertion order. `always` candidates are always returned
 * (ahead of scored hits), mirroring selectRelevant's project-overview rule.
 */
export function rankCandidates(
  query: string,
  candidates: UnifiedCandidate[],
  opts: { limit?: number } = {},
): UnifiedMemoryHit[] {
  const limit = opts.limit ?? 12;
  const queryVec = ngramVector(query);
  const keywordScores = candidates.map((c) => scoreEntry(query, c.title, c.text, c.kind ?? ''));
  const semanticScores = candidates.map((c) =>
    cosineOf(queryVec, ngramVector(c.title ? `${c.title} ${c.text}` : c.text)),
  );
  const kwRanks = rankPositions(keywordScores);
  const semRanks = rankPositions(semanticScores);

  const hits: UnifiedMemoryHit[] = candidates.map((c, i) => {
    let fused = 0;
    if (keywordScores[i] > KEYWORD_FLOOR) fused += 1 / (RRF_K + (kwRanks.get(i) ?? candidates.length));
    if (semanticScores[i] >= SEMANTIC_FLOOR) fused += 1 / (RRF_K + (semRanks.get(i) ?? candidates.length));
    return { ...c, score: fused, keywordScore: keywordScores[i], semanticScore: semanticScores[i] };
  });

  return hits
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.always === true || h.score > 0)
    .sort((a, b) => {
      if ((a.h.always === true) !== (b.h.always === true)) return a.h.always ? -1 : 1;
      if (b.h.score !== a.h.score) return b.h.score - a.h.score;
      const am = Math.max(a.h.keywordScore, a.h.semanticScore);
      const bm = Math.max(b.h.keywordScore, b.h.semanticScore);
      if (bm !== am) return bm - am;
      return a.i - b.i;
    })
    .slice(0, limit)
    .map(({ h }) => h);
}

// ---------------------------------------------------------------------------
// Store collection (IO) — every store is best-effort: a corrupt or missing
// store contributes nothing instead of failing the whole search.
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** The workspace state dir (`<root>/.mochi`) backing the workspace
   *  markdown store and lessons.json. */
  stateDir: string;
  /** Project root (or the state dir — both normalize) for project memory. */
  projectDir?: string;
}

export function collectCandidates(opts: CollectOptions): UnifiedCandidate[] {
  const out: UnifiedCandidate[] = [];
  const projectDir = opts.projectDir ?? opts.stateDir;

  try {
    for (const f of loadFacts()) {
      out.push({ source: 'global', title: '', text: f.statement, kind: f.category, updatedAt: f.ts });
    }
  } catch { /* global store unreadable — other stores still serve */ }

  try {
    const store = new MemoryStore(opts.stateDir);
    for (const e of store.entries()) {
      out.push({
        source: 'workspace',
        title: e.title,
        text: e.body,
        kind: e.kind,
        always: e.source === 'project.md',
        updatedAt: e.updatedAt,
      });
    }
  } catch { /* workspace store unreadable */ }

  try {
    for (const e of loadProjectMemoryEntries(projectDir)) {
      if (!e.text) continue;
      out.push({
        source: 'project',
        title: '',
        text: e.text,
        updatedAt: e.date ? Date.parse(`${e.date}T00:00:00Z`) : undefined,
      });
    }
  } catch { /* project memory unreadable */ }

  try {
    for (const l of loadLessons(opts.stateDir)) {
      out.push({
        source: 'lessons',
        title: 'lesson',
        text: `${l.lesson} (trigger: ${l.signature})`,
        kind: l.kind,
        updatedAt: l.recordedAtMs,
      });
    }
  } catch { /* lessons unreadable */ }

  return out;
}

/** The one memory search entry point: collect from all four stores, fuse. */
export function searchMemory(
  query: string,
  opts: CollectOptions & { limit?: number },
): UnifiedMemoryHit[] {
  return rankCandidates(query, collectCandidates(opts), { limit: opts.limit });
}

// ---------------------------------------------------------------------------
// Substantive success writes
// ---------------------------------------------------------------------------

export interface RunSuccessInput {
  /** TaskKind of the finished run (fix / implement / refactor / test / …). */
  kind: string;
  taskTitle: string;
  /** The run's own completion summary (first line is used). */
  summary?: string;
  /** Files the run changed, workspace-relative where possible. */
  filesChanged: string[];
  /** Final verification state of the run. */
  verification: 'passed' | 'failed' | 'not run';
}

/** Near-identical run facts (same task re-completed, a re-run after a crash)
 *  must not stack: trigram cosine ≥ this against an existing fact = the same
 *  outcome already recorded. Sits far above the ~0.5 two DIFFERENT runs on
 *  the same files produce, and below the ~0.98 a re-run produces. */
export const RUN_FACT_DEDUP_THRESHOLD = 0.85;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Build the one-sentence success fact for a completed run. Pure. */
export function buildRunSuccessFact(input: RunSuccessInput): string {
  const title = clip(input.taskTitle, 110);
  const summaryLine = clip((input.summary ?? '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '')).find((l) => l.length > 0) ?? '', 140);
  const files = [...new Set(input.filesChanged)].filter(Boolean);
  const filePart = files.length
    ? ` Changed: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}.`
    : '';
  const head = `Completed ${input.kind} task "${title}"`;
  return `${head}${summaryLine && summaryLine !== title ? `: ${summaryLine}` : ''}${filePart} Verification: ${input.verification}.`;
}

/**
 * Record a completed run's success fact in the GLOBAL fact store via its
 * existing addFact() API — the loop's finish path is the caller. Returns the
 * stored fact, or null when a near-identical fact already exists (checked
 * with the unified trigram similarity; addFact's own Jaccard dedup is a
 * second net). Category 'history', source 'run' so run-derived facts stay
 * distinguishable from user/SDK facts and join the normal recall/attribution
 * lifecycle (surfaced-fact outcomes, 60-day decay).
 */
export function recordRunSuccessFact(input: RunSuccessInput): MemoryFact | null {
  const statement = buildRunSuccessFact(input);
  try {
    for (const f of loadFacts()) {
      if (ngramSimilarity(statement, f.statement) >= RUN_FACT_DEDUP_THRESHOLD) return null;
    }
  } catch { /* if the store can't be read, addFact's own dedup still applies */ }
  return addFact(statement, 'history', 'run');
}
