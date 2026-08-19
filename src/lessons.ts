// Procedural memory: per-workspace lessons learned, written when an autopsy
// reaches a confirmed root cause and fix. Each lesson carries a signature
// (a regex-shaped substring that triggered the lesson) and a use-count so
// stale or wrong strategies can be retired. Loops retrieve lessons matching
// the current failure signature and inject them into the model prompt as
// "previous approaches that worked here" — solving "what was the fix last
// time?" without retraining.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact } from './security.js';

export interface Lesson {
  id: string;
  signature: string;        // substring of stderr/output that triggers the lesson
  kind?: string;            // optional FailureKind alignment
  lesson: string;           // one-line human-readable strategy
  sourceAutopsy?: string;   // taskId of the autopsy that produced it
  useCount: number;         // how many times the loop retrieved it
  successCount: number;     // how often retrieval led to a fix
  recordedAtMs: number;
  lastUsedAtMs?: number;
}

const FILE = 'lessons.json';

export function lessonsPath(workspaceDir: string): string {
  return resolve(workspaceDir, 'memory', FILE);
}

export function loadLessons(workspaceDir: string): Lesson[] {
  const p = lessonsPath(workspaceDir);
  if (!existsSync(p)) return [];
  try {
    const arr = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr as Lesson[] : [];
  } catch {
    return [];
  }
}

export function saveLessons(workspaceDir: string, lessons: Lesson[]): void {
  mkdirSync(resolve(workspaceDir, 'memory'), { recursive: true });
  writeFileSync(lessonsPath(workspaceDir), redact(JSON.stringify(lessons, null, 2)));
}

/** Append a lesson if its signature is novel; otherwise increment use counts on
 *  the matching lesson. Returns the updated list. */
export function recordLesson(workspaceDir: string, lesson: Omit<Lesson, 'useCount' | 'successCount' | 'recordedAtMs'>): Lesson[] {
  const all = loadLessons(workspaceDir);
  // Match on signature + same kind so a "tsc not found" lesson doesn't get
  // grouped with a generic "tests fail" lesson.
  const existing = all.find((l) => l.signature === lesson.signature && (l.kind ?? '') === (lesson.kind ?? ''));
  if (existing) {
    // Reinforce the existing lesson's language; do not duplicate.
    existing.lesson = lesson.lesson;
    existing.useCount++;
    existing.lastUsedAtMs = Date.now();
    saveLessons(workspaceDir, all);
    return all;
  }
  all.push({
    ...lesson,
    useCount: 0,
    successCount: 0,
    recordedAtMs: Date.now(),
  });
  saveLessons(workspaceDir, all);
  return all;
}

export function retrieveLessons(workspaceDir: string, signal: string, kind?: string, limit = 3): Lesson[] {
  const all = loadLessons(workspaceDir);
  const s = signal.toLowerCase();
  const scored = all
    .map((l) => {
      const sigMatch = l.signature && s.includes(l.signature.toLowerCase()) ? 1 : 0;
      const kindMatch = l.kind && kind && l.kind === kind ? 1 : 0;
      return { l, score: sigMatch * 2 + kindMatch + Math.min(0.1, l.useCount * 0.005) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.l);
}

export function markLessonUsed(workspaceDir: string, id: string, succeeded: boolean): void {
  const all = loadLessons(workspaceDir);
  const lesson = all.find((l) => l.id === id);
  if (!lesson) return;
  lesson.useCount++;
  if (succeeded) lesson.successCount++;
  lesson.lastUsedAtMs = Date.now();
  saveLessons(workspaceDir, all);
}

/** One-line summary for embedding in the next-turn prompt. */
export function lessonsToPrompt(lessons: Lesson[]): string {
  if (lessons.length === 0) return '';
  const lines = ['LESSONS FROM PREVIOUS ATTEMPTS:'];
  for (const l of lessons) {
    const stats = l.successCount !== undefined ? ` (worked ${l.successCount}/${l.useCount} times)` : '';
    lines.push(`- when you see: "${l.signature}" -> ${l.lesson}${stats}`);
  }
  return lines.join('\n');
}