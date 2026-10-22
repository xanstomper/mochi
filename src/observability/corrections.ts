/**
 * User-correction capture (niche item B24) — when the user corrects the
 * agent mid-task ("no, don't use sed — use the edit tool instead"), the
 * correction is a high-value learning signal. Before this module it existed
 * only as raw transcript text: unsearchable, unpromotable, gone when the
 * session ended. Now a correction-shaped steer is captured as a STRUCTURED
 * record — what was wrong, what the user wanted — persisted redacted and
 * local-only (~/.mochi/corrections.jsonl, the feedback.jsonl pattern), and
 * promoted into the per-workspace lessons store as a lesson candidate
 * (kind 'user-correction') so the curator/lessons path can reuse it.
 *
 * Detection is deliberately conservative and deterministic (regex markers,
 * no model call): a mid-run steer is usually guidance, not correction, and
 * a false "correction" pollutes the lesson store. Only messages carrying an
 * explicit correction marker are captured.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { redact } from '../security/security.js';
import { recordLesson } from '../lessons.js';

export interface CorrectionRecord {
  ts: number;
  session: string;
  /** What the user said was wrong (clause before the pivot, when separable). */
  whatWasWrong: string;
  /** What the user wants instead — the actionable directive. */
  whatTheyWanted: string;
  /** Short normalized trigger phrase; doubles as the lesson signature. */
  signature: string;
  /** Redacted raw message (bounded) for audit. */
  excerpt: string;
}

export interface CorrectionDetection {
  whatWasWrong: string;
  whatTheyWanted: string;
  signature: string;
}

const MAX_FIELD = 500;

// Correction markers, strongest first. A message needs ONE to qualify.
const PIVOT_RE = /\b(instead|actually)\b/i;
const MARKERS: RegExp[] = [
  /^\s*(no|nope|wrong|stop|wait)\b/i,
  /\b(that'?s|that is)\s+(wrong|not right|incorrect|not what)\b/i,
  /\bnot what i\s+(asked|said|wanted|meant)\b/i,
  /\bi\s+(said|meant|asked for)\b/i,
  /\b(don'?t|do not|never|stop)\s+(use|do|run|write|edit|add|make|create|call|try|commit|push|delete|remove|change|modify|touch|install|merge|revert|print|log|hardcode|skip|ignore)\b/i,
  /\bwhy did you\b/i,
  PIVOT_RE,
];

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
}

/** Salient trigger phrase for lesson matching/dedupe: the prohibition or
 *  opening words of the wanted directive, normalized. */
function signatureOf(wanted: string): string {
  const w = wanted.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const prohib = /(don'?t|do not|never|stop)\s+([a-z]+(?:\s+[a-z]+){0,3})/.exec(w);
  if (prohib) return `${prohib[1]} ${prohib[2]}`.slice(0, 60).trim();
  return w.split(' ').slice(0, 5).join(' ').slice(0, 60).trim();
}

/**
 * Classify a user message. Returns the structured split when the message is
 * correction-shaped, else null. Pure + deterministic — unit-testable and
 * safe to run on every steer.
 */
export function detectCorrection(text: string): CorrectionDetection | null {
  const msg = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (msg.length < 3) return null;
  if (!MARKERS.some((re) => re.test(msg))) return null;

  let whatWasWrong = '';
  let whatTheyWanted = msg;
  const pivot = PIVOT_RE.exec(msg);
  if (pivot && pivot.index > 0) {
    const before = clean(msg.slice(0, pivot.index).replace(/[—–,:;]\s*$/, ''));
    const after = clean(msg.slice(pivot.index).replace(/^(actually|instead)\b[,\s]*/i, ''));
    if (pivot[1].toLowerCase() === 'instead') {
      // "use X instead" / "use X instead of Y": the wanted part is BEFORE
      // the pivot; "of Y" (when present) names the rejected thing.
      if (before) {
        whatTheyWanted = before;
        whatWasWrong = /^of\s+/i.test(after) ? clean(after.replace(/^of\s+/i, '')) : '';
      } else if (after) {
        whatTheyWanted = after;
      }
    } else if (after) {
      // "that's wrong, actually use the edit tool": wanted follows the pivot.
      whatWasWrong = before;
      whatTheyWanted = after;
    }
  }
  whatTheyWanted = clean(whatTheyWanted);
  if (!whatTheyWanted) return null;
  return { whatWasWrong, whatTheyWanted, signature: signatureOf(whatTheyWanted) };
}

function correctionsDir(): string {
  const h = process.env.HOME || process.env.USERPROFILE || homedir();
  return resolve(h, '.mochi');
}

export function correctionsFile(): string {
  return resolve(correctionsDir(), 'corrections.jsonl');
}

function ensureFile(): void {
  const dir = correctionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = correctionsFile();
  if (!existsSync(file)) writeFileSync(file, '');
}

/**
 * Capture one user message if it is correction-shaped. Persists the record
 * REDACTED (the message is free user text — it can carry a pasted secret —
 * and the store feeds prompts later). Returns the record, or null when the
 * message is not a correction.
 */
export function captureCorrection(text: string, opts: { session: string }): CorrectionRecord | null {
  const det = detectCorrection(text);
  if (!det) return null;
  const record: CorrectionRecord = {
    ts: Date.now(),
    session: opts.session,
    whatWasWrong: redact(det.whatWasWrong),
    whatTheyWanted: redact(det.whatTheyWanted),
    signature: det.signature,
    excerpt: redact(clean(String(text ?? ''))),
  };
  ensureFile();
  appendFileSync(correctionsFile(), JSON.stringify(record) + '\n');
  return record;
}

export function loadCorrections(): CorrectionRecord[] {
  ensureFile();
  const out: CorrectionRecord[] = [];
  for (const line of readFileSync(correctionsFile(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as CorrectionRecord); } catch { /* skip malformed */ }
  }
  return out;
}

export function recentCorrections(n = 10): CorrectionRecord[] {
  const all = loadCorrections();
  return all.slice(Math.max(0, all.length - n));
}

/**
 * Promote a captured correction into the workspace lessons store as a
 * lesson candidate (kind 'user-correction'). recordLesson dedupes on
 * signature+kind, so promoting the same correction twice reinforces rather
 * than duplicates. Returns the lesson id.
 */
export function promoteCorrectionToLesson(workspaceDir: string, record: CorrectionRecord): string {
  const id = `correction-${record.ts}-${record.signature.replace(/[^a-z0-9]+/gi, '-').slice(0, 32)}`;
  const lessonText = record.whatWasWrong
    ? `User correction: ${record.whatTheyWanted} (was: ${record.whatWasWrong})`
    : `User correction: ${record.whatTheyWanted}`;
  recordLesson(workspaceDir, { id, signature: record.signature, kind: 'user-correction', lesson: lessonText });
  return id;
}

/** Prompt-facing digest of recent corrections (mirrors feedbackDigest). */
export function correctionsDigest(n = 5): string {
  const recent = recentCorrections(n);
  if (!recent.length) return '';
  const lines = ['# USER CORRECTIONS (structured — do not repeat these)'];
  for (const r of recent) {
    lines.push(r.whatWasWrong ? `  - wanted: ${r.whatTheyWanted} (was: ${r.whatWasWrong})` : `  - wanted: ${r.whatTheyWanted}`);
  }
  return lines.join('\n');
}
