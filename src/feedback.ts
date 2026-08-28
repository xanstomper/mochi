/**
 * Mochi feedback loop — durable good/bad signal attached to assistant turns.
 * Backed by ~/.mochi/feedback.jsonl so the signal survives restarts. The
 * next turn in any session reads the recent feedback as a directive so the
 * agent adjusts within the session instead of repeating the failure mode.
 *
 * Feedback signals:
 *   - 'good'    : this answer was useful, do more like it
 *   - 'bad'     : this answer missed, avoid this pattern
 *   - 'why:<reason>' : free-text reason attached to a bad signal
 *
 * The TUI exposes 👍 / 👎 on every assistant turn via keys (g / b) and the
 * last-N feedback digest is also injected into the system prompt so the
 * agent self-corrects.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export type FeedbackVerdict = 'good' | 'bad';

export interface FeedbackEntry {
  ts: number;            // epoch ms
  session: string;       // short session id
  turn: number;          // 0-indexed assistant turn
  verdict: FeedbackVerdict;
  reason?: string;       // only set on bad
  snippet: string;       // first 200 chars of the answer text
}

const FEEDBACK_DIR = resolve(homedir(), '.mochi');
const FEEDBACK_FILE = resolve(FEEDBACK_DIR, 'feedback.jsonl');

function ensureFile(): void {
  if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
  if (!existsSync(FEEDBACK_FILE)) writeFileSync(FEEDBACK_FILE, '');
}

export function recordFeedback(entry: FeedbackEntry): void {
  ensureFile();
  appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
}

export function loadAllFeedback(): FeedbackEntry[] {
  ensureFile();
  const raw = [];
  try { raw.push(...readFileSync(FEEDBACK_FILE, 'utf8').split('\n')); } catch { return []; }
  const out: FeedbackEntry[] = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as FeedbackEntry); } catch { /* skip malformed */ }
  }
  return out;
}

/** Most recent N feedback entries, oldest first. */
export function recentFeedback(n = 10): FeedbackEntry[] {
  const all = loadAllFeedback();
  return all.slice(Math.max(0, all.length - n));
}

/** Last N bad entries, used to detect recurring failure modes. */
export function recentBad(n = 5): FeedbackEntry[] {
  return loadAllFeedback().filter((e) => e.verdict === 'bad').slice(-n);
}

/** Summary injected into the system prompt when feedback exists. The
 *  agent uses this to self-correct within the session: don't repeat the
 *  pattern that was just marked bad. */
export function feedbackDigest(): string {
  const recent = recentFeedback(8);
  if (recent.length === 0) return '';
  const bad = recent.filter((e) => e.verdict === 'bad');
  const good = recent.filter((e) => e.verdict === 'good');
  const lines: string[] = [];
  lines.push('# FEEDBACK SIGNAL (recent user ratings)');
  lines.push('');
  lines.push(`Recent assistant answers were rated: ${good.length} good / ${bad.length} bad (last ${recent.length}).`);
  if (bad.length) {
    lines.push('');
    lines.push('Patterns the user marked BAD — avoid repeating:');
    for (const e of bad) {
      const reason = e.reason ? ` — ${e.reason}` : '';
      lines.push(`  - "${e.snippet}"${reason}`);
    }
  }
  if (good.length) {
    lines.push('');
    lines.push('Patterns the user marked GOOD — keep doing:');
    for (const e of good) {
      lines.push(`  - "${e.snippet}"`);
    }
  }
  lines.push('');
  lines.push('Use this signal to self-correct within the session.');
  return lines.join('\n');
}

/** Compact one-line status for the status bar. */
export function feedbackPulse(): string {
  const all = recentFeedback(20);
  if (all.length === 0) return '';
  const bad = all.filter((e) => e.verdict === 'bad').length;
  const good = all.length - bad;
  if (bad === 0) return `${good} 👍`;
  if (good === 0) return `${bad} 👎`;
  return `${good}👍 ${bad}👎`;
}