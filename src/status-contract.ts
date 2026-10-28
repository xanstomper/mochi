// D3 — Assumption-in-artifact + per-step status contract.
//
// Problem: when a step is blocked on a fact the agent cannot verify, the
// historical failure mode is a SILENT GUESS — the claim lands in an artifact
// (or worse, only in a transient message) phrased as verified fact, and every
// downstream reader inherits it as truth. Nudges ("don't guess") do not fix
// this; a contract does:
//
//   1. SEARCH FIRST: a blocked step must search the available evidence
//      (files, tool results, memory, prior context) before falling back to
//      an assumption. Evidence found → the artifact cites it and NO
//      assumption flag is raised.
//   2. ASSUMPTION-IN-ARTIFACT: a fact that stays unknown after searching may
//      be assumed, but only with the assumption written INTO the artifact —
//      the claim, the reference it attaches to, and an explicit flag:
//        [ASSUMPTION:A-1] <claim> — attaches: <file:line | section>; unverified (searched: <where>)
//      An assumption that lives only in a transient message, with no
//      artifact line and no flag, violates the contract.
//   3. PER-STEP STATUS: every step in multi-step work carries a status line
//      in the todo ledger — done (evidence cited), assumed (flag referenced),
//      blocked (blocker named), or open — so the run reads as a status
//      ledger, never a narrative that buries unknowns.
//
// This module is the contract's single vocabulary: the flag grammar, the
// canonical line formats, the parser, and the two scorers the bench and the
// compaction probe use. Pure and dependency-free so every seam (todo tool,
// system prompt, compaction, bench) can import it without cycles.

/** A step's ledger state (the todo tool accepts these plus the legacy
 *  pending/in_progress pair). */
export type StepState = 'done' | 'blocked' | 'assumed' | 'open';

export const STEP_STATES: readonly StepState[] = ['done', 'blocked', 'assumed', 'open'];

export function isStepState(value: string): value is StepState {
  return (STEP_STATES as readonly string[]).includes(value);
}

/** Liberal flag detector: matches the canonical `[ASSUMPTION:A-1]` form and
 *  tolerant variants (`[ASSUMPTION A-1]`, `[UNVERIFIED:...]`, or a bare
 *  ASSUMPTION/UNVERIFIED token). Detection is liberal on purpose — a flag we
 *  fail to see reads as an unflagged guess downstream. */
const ASSUMPTION_FLAG_RE = /\[\s*(?:ASSUMPTION|UNVERIFIED)\b[^\]]*\]|\b(?:ASSUMPTION|UNVERIFIED)\b/;

/** Evidence citation on a line: an explicit `evidence:` marker or a
 *  file:line pointer (`src/x.ts:42`). A cited claim is attributed — no
 *  assumption flag is warranted when the fact was found. */
const EVIDENCE_RE = /\bevidence:\s*\S|\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|md|json|yaml|yml|toml|txt|sh):\d+\b/;

export function hasAssumptionFlag(line: string): boolean {
  return ASSUMPTION_FLAG_RE.test(line);
}

export function hasEvidenceCitation(line: string): boolean {
  return EVIDENCE_RE.test(line);
}

export interface AssumptionFlag {
  /** 1-based line number in the scanned text. */
  line: number;
  /** Flag id from the canonical form (`A-1`), when present. */
  id?: string;
  /** The `attaches:` reference (what the assumption hangs on), when stated. */
  attachesTo?: string;
  /** The flagged line, trimmed. */
  text: string;
}

/** Extract every assumption-flagged line from an artifact/summary text. */
export function parseAssumptionFlags(text: string): AssumptionFlag[] {
  const out: AssumptionFlag[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!hasAssumptionFlag(raw)) continue;
    const flag: AssumptionFlag = { line: i + 1, text: raw.trim() };
    const idMatch = raw.match(/\[\s*(?:ASSUMPTION|UNVERIFIED)\s*[:\s]\s*([A-Za-z0-9._-]+)/);
    if (idMatch) flag.id = idMatch[1];
    const attachMatch = raw.match(/\battaches?:\s*([^;)\n]+)/);
    if (attachMatch) flag.attachesTo = attachMatch[1].trim();
    out.push(flag);
  }
  return out;
}

/** Canonical artifact line for an assumption that survived a search. */
export function formatAssumptionLine(input: {
  id: string;
  claim: string;
  attachesTo: string;
  searched: string;
}): string {
  return `[ASSUMPTION:${input.id}] ${input.claim} — attaches: ${input.attachesTo}; unverified (searched: ${input.searched})`;
}

/** Canonical per-step status line. */
export function formatStepStatusLine(input: {
  state: StepState;
  step: string;
  ref?: string;
  assumptionId?: string;
}): string {
  const refPart = input.state === 'assumed' && input.assumptionId
    ? ` — assumption: [ASSUMPTION:${input.assumptionId}]`
    : input.ref
      ? ` — evidence: ${input.ref}`
      : '';
  return `status: ${input.state} — ${input.step}${refPart}`;
}

/** Ledger marker for a todo status, shared by the todo tool renderer and the
 *  state prompt's execution ledger so both render identical glyphs. */
export function todoStatusChar(status: string): string {
  switch (status) {
    case 'done': return 'x';
    case 'in_progress': return '-';
    case 'blocked': return 'B';
    case 'assumed': return 'A';
    case 'open': return '?';
    default: return ' '; // pending and anything legacy
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface UnflaggedGuess {
  /** Which scanned text (path or label) carried the guess. */
  source: string;
  line: number;
  /** The hint token the guess asserted. */
  token: string;
  excerpt: string;
}

/** A fact-hint the bench plants: a distinctive token whose every appearance
 *  must be either evidence-cited or assumption-flagged. */
export interface GuessHint {
  token: string;
}

/** Lines where `token` appears WITHOUT evidence citation or an assumption
 *  flag (flag on the same line or within 2 lines above — a flagged block
 *  covers the claim lines under it). These are the contract violations. */
export function findUnflaggedGuesses(
  source: string,
  text: string,
  hints: readonly GuessHint[],
): UnflaggedGuess[] {
  const out: UnflaggedGuess[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!hints.some((h) => h.token.length > 0 && line.includes(h.token))) continue;
    if (hasEvidenceCitation(line)) continue;
    let flagged = hasAssumptionFlag(line);
    if (!flagged) {
      for (let j = Math.max(0, i - 2); j < i; j++) {
        if (hasAssumptionFlag(lines[j])) { flagged = true; break; }
      }
    }
    if (!flagged) {
      out.push({ source, line: i + 1, token: hints.find((h) => line.includes(h.token))!.token, excerpt: line.trim().slice(0, 160) });
    }
  }
  return out;
}

/** Scan texts for guesses on planted hints. */
export function scanForUnflaggedGuesses(
  texts: ReadonlyArray<{ source: string; text: string }>,
  hints: readonly GuessHint[],
): UnflaggedGuess[] {
  const out: UnflaggedGuess[] = [];
  for (const { source, text } of texts) out.push(...findUnflaggedGuesses(source, text, hints));
  return out;
}

export interface StatusCoverage {
  total: number;
  covered: number;
  /** covered / total (1 when there were no steps). */
  rate: number;
}

/** Per-step status coverage over a todo ledger (raw todo.json items):
 *  a step is COVERED when its state rests on something a reader can check —
 *  done must cite evidence (or a flag), assumed must reference its
 *  assumption flag, blocked must name its blocker in the note; an
 *  open/pending step is covered by its explicit open state (nothing to cite
 *  yet). A done-with-no-reference line is exactly the
 *  narrative-that-buries-unknowns shape this contract forbids. */
export function ledgerStatusCoverage(
  items: ReadonlyArray<{ status?: string; notes?: string }>,
): StatusCoverage {
  let covered = 0;
  const total = items.length;
  for (const item of items) {
    const status = String(item.status ?? '');
    const note = (item.notes ?? '').trim();
    if (status === 'done') {
      if (hasEvidenceCitation(note) || hasAssumptionFlag(note)) covered++;
    } else if (status === 'assumed') {
      if (hasAssumptionFlag(note)) covered++; // the todo tool enforces this too
    } else if (status === 'blocked') {
      if (note.length > 0) covered++; // the todo tool enforces the blocker note
    } else {
      covered++; // open/pending: the open state IS the status line
    }
  }
  return { total, covered, rate: total === 0 ? 1 : covered / total };
}
