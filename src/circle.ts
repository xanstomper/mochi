/**
 * Circle detector — recognizes when a conversation is spiraling without
 * forward progress and produces a stop directive the agent must honor.
 *
 * Signals tracked across the recent N turns:
 *  - repeated opening prefixes ("So here's", "Honest answer", "More things")
 *  - question-only / list-only answers (no tools, no concrete task output)
 *  - near-duplicate content fingerprints (Jaccard over word shingles)
 *  - escalation markers ("definitive", "final", "real task")
 *
 * When 2+ signals fire the agent gets an injected stop directive:
 *   "Stop enumerating. Ask for one concrete task instead of another list."
 */

import type { ChatMessage } from './types.ts';

export interface CircleVerdict {
  circling: boolean;
  signals: string[];
  stopDirective: string;
}

const PREFIX_PATTERNS = [
  /^so[, ]/i,
  /^honest answer/i,
  /^more things/i,
  /^here'?s? (the )?/i,
  /^definitive/i,
  /^final\b/i,
  /^real task/i,
  /^let me (re-?)?summar/i,
  /^to recap/i,
];

const ESCALATION_PATTERNS = [
  /\bdefinitive\b/i,
  /\bfinal\b/i,
  /\breal task\b/i,
  /\bno more lists?\b/i,
  /\bstop enumerating\b/i,
  /\blast (one|two|three|time)/i,
];

function openingPrefix(text: string): string {
  const first = text.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
  return first;
}

function shingleSet(text: string, k = 3): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) {
    out.add(words.slice(i, i + k).join(' '));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

function isQuestionOnly(text: string): boolean {
  const stripped = text.replace(/[?]\s*$/, '').trim();
  const sentences = stripped.split(/[.!?]\s+/).filter(Boolean);
  if (sentences.length < 3) return false;
  // Heuristic: lots of sentences that end in "?" or are short bullets = questions.
  const questions = (text.match(/\?/g) ?? []).length;
  return questions >= 3;
}

function isListOnly(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const numberedOrBulleted = lines.filter((l) => /^\d+[.)]\s/.test(l) || /^[-*•]\s/.test(l)).length;
  return numberedOrBulleted >= lines.length * 0.6;
}

/** Returns a circle verdict based on the last N assistant turns. */
export function detectCircle(messages: ChatMessage[], windowSize = 4): CircleVerdict {
  const recent = messages.filter((m) => m.role === 'assistant').slice(-windowSize);
  if (recent.length < 2) return { circling: false, signals: [], stopDirective: '' };

  const signals: string[] = [];

  // 1. repeated opening prefixes
  const prefixes = recent.map((m) => openingPrefix(m.content ?? ''));
  const seen = new Map<string, number>();
  for (const p of prefixes) seen.set(p, (seen.get(p) ?? 0) + 1);
  const repeats: [string, number][] = [];
  for (const [p, n] of seen.entries()) {
    if (n >= 2 && p !== undefined) repeats.push([p, n]);
  }
  if (repeats.length) signals.push(`opening-prefix-repeat(${repeats.map(([p, n]) => `"${p}"×${n}`).join(',')})`);

  // 2. escalation markers in any recent turn
  for (const m of recent) {
    let hit = false;
    const text = m.content ?? '';
    for (const pat of ESCALATION_PATTERNS) {
      if (pat.test(text)) { hit = true; break; }
    }
    if (hit) signals.push('escalation-marker');
  }

  // 3. question-only or list-only answers across multiple turns
  let questionOnlyCount = 0;
  let listOnlyCount = 0;
  for (const m of recent) {
    const text = m.content ?? '';
    if (isQuestionOnly(text)) questionOnlyCount++;
    if (isListOnly(text)) listOnlyCount++;
  }
  if (questionOnlyCount >= 2) signals.push(`question-only-answers(${questionOnlyCount})`);
  if (listOnlyCount >= 2) signals.push(`list-only-answers(${listOnlyCount})`);

  // 4. near-duplicate fingerprints
  const shingles = recent.map((m) => shingleSet(m.content ?? ''));
  for (let i = 0; i < shingles.length; i++) {
    const a = shingles[i];
    if (!a) continue;
    for (let j = i + 1; j < shingles.length; j++) {
      const b = shingles[j];
      if (!b) continue;
      if (jaccard(a, b) >= 0.55) {
        signals.push(`near-duplicate(${i}<>${j})`);
        break;
      }
    }
  }

  const circling = signals.length >= 2;
  const stopDirective = circling
    ? '\n\n# STOP CONDITION (system)\nYou have been circling. Stop enumerating. Do not produce another list, another recap, or another meta-discussion. Ask the user for ONE concrete task (a real bug, a real file, a real feature) and execute it. If the user does not provide a concrete task in their next message, say so plainly and end your turn.\n'
    : '';

  return { circling, signals, stopDirective };
}