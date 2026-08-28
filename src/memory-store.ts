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
const MEMORY_FILE = resolve(MEMORY_DIR, 'memory.jsonl');
const MAX_FAILS = 3;

function ensure(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  if (!existsSync(MEMORY_FILE)) writeFileSync(MEMORY_FILE, '');
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function addFact(statement: string, category: MemoryFact['category'] = 'fact', source = 'session'): MemoryFact {
  ensure();
  const fact: MemoryFact = {
    id: randomId(),
    ts: Date.now(),
    category,
    statement,
    source,
    attempts: 0,
    success_count: 0,
  };
  appendFileSync(MEMORY_FILE, JSON.stringify(fact) + '\n');
  return fact;
}

export function loadFacts(): MemoryFact[] {
  ensure();
  let raw = '';
  try { raw = readFileSync(MEMORY_FILE, 'utf8'); } catch { return []; }
  const out: MemoryFact[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as MemoryFact); } catch { /* skip */ }
  }
  // Auto-prune facts that failed too many times
  const live = out.filter((f) => (f.attempts - f.success_count) < MAX_FAILS);
  if (live.length !== out.length) {
    writeFileSync(MEMORY_FILE, live.map((f) => JSON.stringify(f)).join('\n') + '\n');
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
  if (touched) writeFileSync(MEMORY_FILE, facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
}

/** Forget a fact by id or by statement substring. */
export function forgetFact(query: string): number {
  ensure();
  const facts = loadFacts();
  const remaining = facts.filter((f) => !f.id.startsWith(query) && !f.statement.includes(query));
  const removed = facts.length - remaining.length;
  writeFileSync(MEMORY_FILE, remaining.map((f) => JSON.stringify(f)).join('\n') + '\n');
  return removed;
}

/** Render facts as a prompt section. */
export function memoryDigest(): string {
  const facts = loadFacts();
  if (facts.length === 0) return '';
  const lines: string[] = ['# DURABLE MEMORY (project facts)', ''];
  for (const f of facts) {
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