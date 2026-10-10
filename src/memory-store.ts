/**
 * Durable project memory — facts the agent has learned that should
 * persist across sessions. Backed by ~/.mochi/memory.jsonl with one fact
 * per line. Memory entries include an `attempts` and `last_failed`
 * counter; facts that have failed 3+ times without success are
 * automatically pruned so the memory doesn't replay the same dead ends.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface MemoryFact {
  id: string;             // short uuid-ish
  ts: number;             // epoch ms when written
  category: 'fact' | 'preference' | 'convention' | 'history';
  statement: string;      // the fact itself, one sentence
  source?: string;        // what produced it: 'session', 'user', 'inferred'
  attempts: number;       // how many times the agent tried to act on it
  last_failed?: number;   // epoch ms of last failed attempt
  success_count: number;  // how many times acting on it worked
}

const MEMORY_DIR = resolve(homedir(), '.mochi');
// MCH-59/60: resolved lazily — module load order in bundled test runs makes
// const-time binding unreliable (a sibling's static import can bind the env
// override before the test sets it). Reading the env at call time fixes both
// test isolation and multi-profile redirection.
function memoryFile(): string {
  return process.env['MOCHI_MEMORY_FILE']
    ? resolve(process.env['MOCHI_MEMORY_FILE'])
    : resolve(MEMORY_DIR, 'memory.jsonl');
}
const MAX_FAILS = 3;

function ensure(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  if (!existsSync(memoryFile())) writeFileSync(memoryFile(), '');
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function addFact(statement: string, category: MemoryFact['category'] = 'fact', source = 'session'): MemoryFact | null {
  ensure();
  // MCH-42 (cross-run dedup): reject near-duplicates of an existing fact so
  // repeated sessions don't bloat memory.jsonl with the same sentence.
  for (const f of loadFacts()) {
    if (memorySimilarity(statement, f.statement) >= DEDUP_THRESHOLD) return null;
  }
  const fact: MemoryFact = {
    id: randomId(),
    ts: Date.now(),
    category,
    statement,
    source,
    attempts: 0,
    success_count: 0,
  };
  appendFileSync(memoryFile(), JSON.stringify(fact) + '\n');
  return fact;
}

export function loadFacts(): MemoryFact[] {
  ensure();
  let raw = '';
  try { raw = readFileSync(memoryFile(), 'utf8'); } catch { return []; }
  const out: MemoryFact[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as MemoryFact); } catch { /* skip */ }
  }
  // Auto-prune facts that failed too many times
  const live = out.filter((f) => (f.attempts - f.success_count) < MAX_FAILS);
  if (live.length !== out.length) {
    writeFileSync(memoryFile(), live.map((f) => JSON.stringify(f)).join('\n') + '\n');
  }
  return live;
}

/** Mark a fact as tried; if success=true increment success_count, else
 *  bump attempts and set last_failed. */
export function recordFactAttempt(id: string, success: boolean): void {
  ensure();
  const facts = loadFacts();
  let touched = false;
  for (const f of facts) {
    if (f.id !== id) continue;
    f.attempts++;
    if (success) f.success_count++;
    else f.last_failed = Date.now();
    touched = true;
  }
  if (touched) writeFileSync(memoryFile(), facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
}

// MCH-63: fact outcome attribution. recordFactAttempt existed but was NEVER
// called — facts never learned from outcomes, so dead-end pruning (MAX_FAILS)
// and the success-ratio term in recallFacts were dead code. Track which fact
// ids the digest actually surfaced this run (module-level, mirroring the
// MCH-57 skill-attribution pattern); the loop drains the set at finish() and
// records success/failure per surfaced fact.
const surfacedFactIds = new Set<string>();

/** Internal: called by memoryDigest for every fact it renders. */
function noteFactSurfaced(id: string): void {
  surfacedFactIds.add(id);
}

/** Drain the surfaced-facts set (loop calls once at finish). */
export function takeSurfacedFactIds(): string[] {
  const out: string[] = [];
  surfacedFactIds.forEach((id) => out.push(id));
  surfacedFactIds.clear();
  return out;
}

/** Forget a fact by id or by statement substring. */
export function forgetFact(query: string): number {
  ensure();
  const facts = loadFacts();
  const remaining = facts.filter((f) => !f.id.startsWith(query) && !f.statement.includes(query));
  const removed = facts.length - remaining.length;
  writeFileSync(memoryFile(), remaining.map((f) => JSON.stringify(f)).join('\n') + '\n');
  return removed;
}

/** MCH-42 (memory v2): tokenize into a lowercase word set minus stopwords. */
const MEMORY_STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'not', 'no']);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9_.\-/]{2,}/g) ?? []) {
    if (!MEMORY_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** MCH-42: Jaccard similarity between two texts' token sets. */
export function memorySimilarity(a: string, b: string): number {
  const ta = tokenize(a), tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** MCH-42 (cross-run dedup): near-duplicate detection threshold. */
const DEDUP_THRESHOLD = 0.55;

/** MCH-42: semantic recall — score facts against the current task context.
 *  score = w_sim*jaccard + w_succ*success_ratio + w_rec*recency, where the
 *  weights shift by category (MCH-59): preferences/conventions are explicit
 *  user directives, so similarity matters less and they surface even on a
 *  weak match; plain facts must earn their slot via strong similarity.
 *  Returns facts sorted by score desc, capped at maxFacts. */
export function recallFacts(context: string, maxFacts = 15): MemoryFact[] {
  const facts = loadFacts();
  const now = Date.now();
  const HALF_LIFE_MS = 14 * 24 * 3600 * 1000; // 14-day recency half-life
  const W = (c: MemoryFact['category']): { sim: number; base: number } =>
    c === 'preference' ? { sim: 0.3, base: 0.12 }
    : c === 'convention' ? { sim: 0.4, base: 0.06 }
    : { sim: 0.5, base: 0 };
  const scored = facts.map((f) => {
    const sim = memorySimilarity(context, f.statement);
    const succ = f.attempts > 0 ? f.success_count / f.attempts : 0.5;
    const recency = Math.exp(-Math.LN2 * ((now - f.ts) / HALF_LIFE_MS));
    const w = W(f.category);
    return { fact: f, score: w.base + w.sim * sim + 0.3 * succ + 0.2 * recency };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFacts)
    .map((s) => s.fact);
}

/** MCH-42 (auto-decay): facts untouched for 60 days with zero successes are
 *  pruned on every digest render — stale memory should not cost prompt bytes
 *  forever. Returns number pruned. */
export function decayFacts(maxAgeMs = 60 * 24 * 3600 * 1000): number {
  const facts = loadFacts();
  const cutoff = Date.now() - maxAgeMs;
  const live = facts.filter((f) => f.ts >= cutoff || f.success_count > 0 || f.attempts === 0);
  if (live.length !== facts.length) {
    writeFileSync(memoryFile(), live.map((f) => JSON.stringify(f)).join('\n') + '\n');
  }
  return facts.length - live.length;
}

/** Render facts as a prompt section, with MCH-42 upgrades:
 *  - auto-decay pass (60-day stale pruning) before rendering
 *  - ranked by semantic relevance when task context is provided */
export function memoryDigest(taskContext?: string): string {
  decayFacts();
  let facts: MemoryFact[];
  if (taskContext && taskContext.trim().length > 20) {
    facts = recallFacts(taskContext);
  } else {
    facts = loadFacts();
    // Even without context, cap the digest so memory can't eat the prompt.
    if (facts.length > 20) facts = facts.slice(0, 20);
  }
  if (facts.length === 0) return '';
  const lines: string[] = ['# DURABLE MEMORY (project facts)', ''];
  for (const f of facts) {
    noteFactSurfaced(f.id); // MCH-63: so the run outcome can be attributed back
    const tag = `[${f.category}]`;
    lines.push(`- ${tag} ${f.statement}`);
  }
  lines.push('');
  lines.push('These facts persist across sessions. Act on them when relevant; do not re-derive.');
  return lines.join('\n');
}

/** One-line pulse for status bar. */
export function memoryPulse(): string {
  const n = loadFacts().length;
  return n === 0 ? '' : `${n} facts`;
}