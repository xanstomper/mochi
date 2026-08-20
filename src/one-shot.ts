import { isWeakVerification } from './testdetect.js';
// One-shot fast path: classify trivial, self-contained tasks that do not need
// a codebase-exploration loop so the harness can lean on first-turn answers
// instead of spending tokens on redundant read/search round-trips.
//
// This is a *pure, deterministic* classifier (no model calls, no heuristics on
// file state), so it is cheap, deterministic, and safe to test. It is NOT a
// replacement for verification - the loop still verifies before declaring done.

interface ClassifyInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  verificationCommand?: string;
}

export type OneShotKind =
  | 'answer' // pure knowledge/explanation question, no repo work
  | 'summarize' // summarize an existing file/symbol (needs a read, but tiny)
  | 'not_one_shot'; // needs edits/verify/iteration

// Verbs & phrasings that strongly indicate "just tell me / explain", no edits.
const ANSWER_MARKERS = [
  'explain', 'what does', 'what is', 'what are', 'how does', 'why', 'describe',
  'summarize', 'define', 'list the', 'tell me', 'steps to', 'tutorial', 'meaning',
  'difference between', 'compare', 'when should',
];

// Short direct-utterance commands ("say hello", "reply in 3 words", "return the
// json") that almost never need to touch the filesystem. Only honoured when the
// objective is short and carries no edit/work marker, to avoid misrouting a real
// coding command like "say it by writing a logger".
const UTTERANCE_MARKERS = ['say ', 'return ', 'respond', 'print ', 'answer', 'reply', 'output ', 'return exactly'];

const WORK_MARKERS = [
  'create', 'write a', 'implement', 'build', 'add ', 'fix', 'refactor', 'change',
  'update', 'migrate', 'test that', 'write tests', 'new file', 'editing',
  'commit', 'refactor into', 'restructure', 'rename', 'delete', 'remove',
];

/**
 * Classify whether a task can likely be resolved in a single, direct turn.
 * Returns a tentative short-answer prompt only for high-confidence cases where
 * both the title+description read as explanatory AND there is no write/verify
 * signal. It favours returning NOT_ELIGIBLE when unsure, so we never short-
 * circuit a task that actually needs to touch code.
 */
export function classifyOneShot(input: ClassifyInput): { kind: OneShotKind; suggests: string | null } {
  const text = `${input.title} ${input.description}`.toLowerCase();

  // Explicit write/verification intent overrides any answer phrasing.
  if (WORK_MARKERS.some((m) => text.includes(m))) {
    return { kind: 'not_one_shot' as const, suggests: null };
  }
  if (input.verificationCommand) {
    return { kind: 'not_one_shot' as const, suggests: null };
  }
  if (input.acceptanceCriteria.length > 0) {
    // A list of acceptance criteria usually implies a coding change.
    return { kind: 'not_one_shot' as const, suggests: null };
  }

  const hasAnswer = ANSWER_MARKERS.some((m) => text.includes(m));
  // Trivial short utterance commands ("say hello", "reply in 3 words") are also
  // one-shot when the objective is compact and clean of work intent.
  const isShortUtterance = text.length < 90 && UTTERANCE_MARKERS.some((m) => text.includes(m));
  const answered = hasAnswer || isShortUtterance;
  if (!answered) return { kind: 'not_one_shot' as const, suggests: null };

  // 'summarize' may still need a read; route it as a short, single-read task.
  const isSummarize = /summarize|summary|overview/.test(text);
  const kind: OneShotKind = isSummarize ? 'summarize' : 'answer';
  const nudge =
    kind === 'answer'
      ? 'This is a knowledge question. Answer directly and concisely in one turn. Do not call any tools unless you truly need a file read to answer.'
      : 'Summarize the relevant source directly and concisely. Avoid recomputing the same reads; finish with a compact answer in this same turn.';

  return { kind, suggests: nudge };
}

/** File extensions whose content has no executable behavior for a repo's
 *  test suite to exercise. Editing them cannot break code paths. */
const CONTENT_ONLY_EXTENSIONS = [
  '.md', '.txt', '.rst', '.adoc', 'README', 'CHANGELOG', 'LICENSE',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env.example',
  '.csv', '.tsv', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp',
];

/** Classify a task as CONTENT-ONLY: the deliverable is file content with no
 *  behavior change (docs, config, data, plain text). Such tasks must not run
 *  repo-wide test suites or builds: suites exercise code, not content, and a
 *  pre-existing failure would burn tokens and fail correct work. */
export function classifyContentOnly(input: ClassifyInput): boolean {
  const text = `${input.title} ${input.description}`.toLowerCase();
  // Behavior-changing verbs mean code, regardless of extensions mentioned.
  const behaviorMarkers = ['implement', 'fix', 'refactor', 'function', 'method',
    'class ', 'api', 'endpoint', 'logic', 'bug', 'compile', 'typecheck', 'lint'];
  if (behaviorMarkers.some((m) => text.includes(m))) return false;
  // A verificationCommand that runs a real test runner implies behavior to
  // exercise; a direct content check (test -f / grep / cat) does not — it IS
  // the proportionate verification for a content-only deliverable.
  if (input.verificationCommand && !isWeakVerification(input.verificationCommand)) return false;
  // Mention of a content-only extension or artifact type.
  return CONTENT_ONLY_EXTENSIONS.some((ext) => text.includes(ext.toLowerCase()))
    || /\b(doc|docs|documentation|note|notes|readme|changelog|config|data file|text file|content)\b/.test(text);
}
