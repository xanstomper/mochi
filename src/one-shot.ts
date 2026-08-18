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

// Editing / verification signals that rule out a one-shot answer.
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

  const answered = ANSWER_MARKERS.some((m) => text.includes(m));
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