// Decision memory: per-workspace records of REJECTED APPROACHES — what the
// agent actually tried on a task, why it was abandoned/rejected, and the
// evidence for the rejection. A future session starting a similar task
// retrieves the matching rejections and surfaces them as WARNINGS ("tried X,
// failed because Y") so it does not repeat a known-dead approach — unless it
// has new evidence that contradicts the recorded reason.
//
// Relationship to the existing memory subsystems (deliberately NOT a second
// memory system):
//   - lessons.json        → what WORKS (confirmed root cause + fix)
//   - speculation.json    → which strategy CLASS resolved vs stalled
//   - failures.md (MemoryStore) → per-task failure lessons (title-keyed)
//   - decision-memory.json → per-APPROACH rejections, task-signature-keyed,
//     retrieved by relevance (not title equality) so a differently-worded
//     repeat of the same task still surfaces the dead approach.
// Ranking reuses the unified-search RRF machinery (keyword + trigram cosine)
// rather than inventing a fifth scorer. Storage follows the established
// per-workspace state location: <state>/.mochi/memory/, next to lessons.json.
//
// Write discipline: a record is written only when an approach was ABANDONED
// or REJECTED after real work (the loop records failed runs that changed
// files; the memory tool exposes 'reject' for explicit mid-run
// abandonments). Approaches merely considered and never tried are never
// recorded. Records never contain secrets: everything passes through the
// repo-wide redact() gate before it touches disk.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mochiStateDir } from '../core/mochi-dir.js';
import { redact } from '../security/security.js';
import { rankCandidates, ngramSimilarity, type UnifiedCandidate } from './unified-search.js';

export interface DecisionRecord {
  id: string;
  /** What the task was about, in the agent's own terms (title + intent). */
  taskSignature: string;
  /** The approach that was tried and then abandoned/rejected. */
  approach: string;
  /** Why it was rejected — the concrete failure, not a vibe. */
  reason: string;
  /** file:line, test result, or run reference backing the rejection. */
  evidence?: string;
  recordedAtMs: number;
  /** How many times retrieval has surfaced this record (prune weight +
   *  outcome attribution). */
  surfacedCount: number;
  lastSurfacedAtMs?: number;
}

const FILE = 'decision-memory.json';

/** Growth bound: no pins (the repo has no pin concept in these stores);
 *  overflow prunes least-referenced first, oldest first as the tiebreak. */
export const MAX_DECISION_RECORDS = 100;

/** A re-confirmed rejection (same task + approach, possibly a sharper reason)
 *  updates the existing record instead of stacking a near-duplicate. Sits at
 *  the unified-search run-fact threshold: distinct approaches on the same
 *  task score well below this, re-recorded identical ones far above. */
export const DECISION_DEDUP_THRESHOLD = 0.85;

export function decisionMemoryPath(workspaceDir: string): string {
  return resolve(mochiStateDir(workspaceDir), 'memory', FILE);
}

export function loadDecisionMemory(workspaceDir: string): DecisionRecord[] {
  const p = decisionMemoryPath(workspaceDir);
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return (arr as DecisionRecord[]).slice(-MAX_DECISION_RECORDS);
  } catch {
    return [];
  }
}

function saveDecisionMemory(workspaceDir: string, records: DecisionRecord[]): void {
  mkdirSync(resolve(mochiStateDir(workspaceDir), 'memory'), { recursive: true });
  writeFileSync(decisionMemoryPath(workspaceDir), redact(JSON.stringify(records, null, 2)));
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export interface RejectionInput {
  taskSignature: string;
  approach: string;
  reason: string;
  evidence?: string;
  atMs?: number;
}

/**
 * Record a rejected approach. Returns the stored record, or null when the
 * input was not a real post-work rejection (empty task signature, approach,
 * or reason — "considered it and moved on" is not recordable) or when a
 * near-identical rejection already exists (the existing record's reason is
 * refreshed instead).
 */
export function recordRejectedApproach(workspaceDir: string, input: RejectionInput): DecisionRecord | null {
  const taskSignature = clip(input.taskSignature ?? '', 300);
  const approach = clip(input.approach ?? '', 500);
  const reason = clip(input.reason ?? '', 500);
  const evidence = input.evidence ? clip(input.evidence, 300) : undefined;
  if (!taskSignature || !approach || !reason) return null;
  const all = loadDecisionMemory(workspaceDir);
  const novel = `${taskSignature} ${approach}`;
  const existing = all.find((r) => ngramSimilarity(novel, `${r.taskSignature} ${r.approach}`) >= DECISION_DEDUP_THRESHOLD);
  if (existing) {
    // Re-confirmed rejection: keep the sharper (longer) reason and refresh ts.
    existing.reason = reason.length >= existing.reason.length ? reason : existing.reason;
    if (evidence) existing.evidence = evidence;
    existing.recordedAtMs = input.atMs ?? Date.now();
    saveDecisionMemory(workspaceDir, all);
    return existing;
  }
  const rec: DecisionRecord = {
    id: randomId(),
    taskSignature,
    approach,
    reason,
    evidence,
    recordedAtMs: input.atMs ?? Date.now(),
    surfacedCount: 0,
  };
  all.push(rec);
  saveDecisionMemory(workspaceDir, prune(all));
  return rec;
}

/** Cap enforcement: keep the MAX most valuable records — most-referenced
 *  first, newest first as the tiebreak (least-referenced/oldest drop). */
export function prune(records: DecisionRecord[], max = MAX_DECISION_RECORDS): DecisionRecord[] {
  if (records.length <= max) return records;
  return [...records]
    .sort((a, b) =>
      (a.surfacedCount - b.surfacedCount)
      || (a.recordedAtMs - b.recordedAtMs))
    .slice(records.length - max);
}

export interface RejectionHit extends DecisionRecord {
  score: number;
  keywordScore: number;
  semanticScore: number;
}

// Precision floor (measured on the fixture bench): a genuinely same-task
// repeat — including paraphrases, via the synonym clusters + stemming in
// relevance.ts — scores keyword ≥ 0.23, while cross-task noise stays ≤ 0.04.
// Trigram cosine CANNOT separate (correct 0.36–0.53 vs noise 0.29–0.46: any
// two English paragraphs share stopword trigrams), so it contributes ranking
// only, never admission. A hit must clear the keyword floor.
export const REJECTION_MIN_KEYWORD = 0.15;

/**
 * Surface past rejections whose task signature matches the current task,
 * ranked by relevance (unified-search RRF: keyword overlap + trigram
 * cosine). Bounded: at most `limit` (default 3) records, never a
 * full-history dump. Surfacing counts are bumped for attribution and so the
 * prune policy can weight records the agent actually consulted.
 */
export function recallRejections(workspaceDir: string, taskDescription: string, limit = 3): RejectionHit[] {
  const records = loadDecisionMemory(workspaceDir);
  if (records.length === 0 || !taskDescription.trim()) return [];
  // rankCandidates spreads each candidate into its hit, so a `rec` back-reference
  // survives the fusion and lets us map ranked hits to their stored records.
  type KeyedCandidate = UnifiedCandidate & { rec: DecisionRecord };
  const hits = rankCandidates(
    taskDescription,
    records.map((r): KeyedCandidate => ({
      source: 'workspace',
      title: r.approach,
      text: `${r.taskSignature} ${r.reason}`,
      kind: 'decision',
      updatedAt: r.recordedAtMs,
      rec: r,
    })),
    { limit },
  );
  if (hits.length === 0) return [];
  const out: RejectionHit[] = [];
  const now = Date.now();
  let touched = false;
  for (const h of hits) {
    // Precision gate: a hit must clear the keyword floor (see the constant
    // above for the measured noise separation).
    if (h.keywordScore < REJECTION_MIN_KEYWORD) continue;
    const rec = (h as unknown as KeyedCandidate).rec;
    if (!rec) continue;
    out.push({ ...rec, score: h.score, keywordScore: h.keywordScore, semanticScore: h.semanticScore });
    rec.surfacedCount++;
    rec.lastSurfacedAtMs = now;
    touched = true;
  }
  if (touched) saveDecisionMemory(workspaceDir, records);
  return out;
}

/**
 * Render surfaced rejections as the prompt block. Empty string when nothing
 * matched. Framed as WARNINGS, not instructions: the agent may still retry a
 * rejected approach if new evidence contradicts the recorded reason.
 */
export function rejectionWarningsToPrompt(hits: RejectionHit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h) => {
    const ev = h.evidence ? ` (evidence: ${h.evidence})` : '';
    return `- Task "${clip(h.taskSignature, 120)}": tried ${clip(h.approach, 200)} — failed because ${clip(h.reason, 250)}${ev}`;
  });
  return [
    '# REJECTED APPROACHES (from prior sessions on similar tasks)',
    'These are warnings, not instructions. Each records an approach that was really tried and then abandoned.',
    ...lines,
    'Do not repeat these approaches unless you have NEW evidence that contradicts the recorded reason; if you must retry, say what changed.',
    '',
  ].join('\n');
}

/** One-call retrieval hook for the loop: recall + render. */
export function decisionMemoryPrefix(workspaceDir: string, taskDescription: string, limit = 3): string {
  try {
    return rejectionWarningsToPrompt(recallRejections(workspaceDir, taskDescription, limit));
  } catch {
    return ''; // memory must never break the run
  }
}
