// D2: the protected head — the session evidence compaction must never drop.
//
// Defined in ONE place (this file) so every compaction path carries the same
// set. Members, in render order:
//   - session snapshot: the root goal (task contract) and the current plan
//     state (next action);
//   - open TODOs: the live plan ledger — OPEN items only, completed ones are
//     history, not head;
//   - skill names in play this session — NAMES only, never bodies. Bodies
//     are re-loadable via the `skill` tool (and cached per process); the
//     NAME is the part compaction must preserve, so the post-compaction
//     agent still knows which workflow it was applying.
//
// The same file owns the post-compaction re-injection block (leg 3 of the
// bundle): after a cut, ContextEngine.compact() renders the protected head
// plus every spill-store key referenced by surviving markers, bounded by a
// char budget so re-injection cannot blow the context back up. When the
// budget cuts, the omissions are NAMED in the block — never silent.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_REINJECTION_BUDGET_CHARS } from './spill-store.js';

export interface ProtectedTodo {
  order: number;
  status: string;
  title: string;
  notes?: string;
}

export interface ProtectedHead {
  /** Root goal / task contract (the session snapshot's mission line). */
  goal?: string;
  /** Current plan state (what the agent said it would do next). */
  nextAction?: string;
  /** Open TODOs (status !== 'done'). */
  todos: ProtectedTodo[];
  /** Skill names loaded in play this session (names only). */
  skillNames: string[];
}

/** Cap on rendered todo/skill lines per head — lists beyond this are named
 *  as counts rather than rendered (bounded re-injection). */
const MAX_TODOS = 32;
const MAX_SKILL_NAMES = 24;

/**
 * Read the OPEN todos from the workspace's state/todo.json — the same file
 * the `todo` tool and the state prompt use, so the protected head and the
 * live plan never disagree. Unreadable/absent file → empty list.
 */
export function readOpenTodos(projectRoot: string): ProtectedTodo[] {
  try {
    const p = resolve(projectRoot, '.mochi', 'state', 'todo.json');
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t: ProtectedTodo) => t && typeof t.title === 'string' && t.status !== 'done')
      .map((t: ProtectedTodo) => ({ order: t.order, status: t.status, title: t.title, notes: t.notes }));
  } catch {
    return [];
  }
}

/** Assemble the protected head from engine state. Done todos are filtered
 *  HERE (not just in readOpenTodos) so the protected set can never include
 *  completed items regardless of the source — done = history, not head. */
export function collectProtectedHead(input: {
  goal?: string;
  nextAction?: string;
  todos?: ProtectedTodo[];
  skillNames?: string[];
}): ProtectedHead {
  return {
    goal: input.goal?.trim() || undefined,
    nextAction: input.nextAction?.trim() || undefined,
    todos: (input.todos ?? []).filter((t) => t && t.status !== 'done'),
    skillNames: input.skillNames ?? [],
  };
}

const HEAD_HEADER = '[PROTECTED SESSION HEAD — compaction must never drop this evidence]';

/**
 * Render the protected head, bounded to `budgetChars`. The goal and next
 * action always render (they are the snapshot and are small); list members
 * (todos, skill names) are added line-by-line until the budget is reached,
 * with any omissions NAMED in a trailing note — never silently dropped.
 * Returns '' when the head has no members at all.
 */
export function renderProtectedHead(head: ProtectedHead, budgetChars: number): string {
  const snapshot: string[] = [];
  if (head.goal) snapshot.push(`Goal: ${head.goal.slice(0, 400)}`);
  if (head.nextAction) snapshot.push(`Next action: ${head.nextAction.slice(0, 200)}`);
  if (snapshot.length === 0 && head.todos.length === 0 && head.skillNames.length === 0) return '';

  const listLines: string[] = [];
  if (head.todos.length > 0) {
    listLines.push('Open TODOs:');
    for (const t of head.todos.slice(0, MAX_TODOS)) {
      const mark = t.status === 'in_progress' ? '-' : ' ';
      const notes = t.notes ? ` -- ${t.notes.slice(0, 120)}` : '';
      listLines.push(`  [${mark}] ${t.title.slice(0, 160)}${notes}`);
    }
    if (head.todos.length > MAX_TODOS) listLines.push(`  (+${head.todos.length - MAX_TODOS} more open TODOs)`);
  }
  if (head.skillNames.length > 0) {
    listLines.push('Skills in play (names only — re-load bodies with the skill tool):');
    for (const n of head.skillNames.slice(0, MAX_SKILL_NAMES)) listLines.push(`  - ${n.slice(0, 80)}`);
    if (head.skillNames.length > MAX_SKILL_NAMES) listLines.push(`  (+${head.skillNames.length - MAX_SKILL_NAMES} more skill names)`);
  }

  const lines: string[] = [HEAD_HEADER, ...snapshot];
  let used = lines.join('\n').length;
  const omittedNoteReserve = 180; // room for the omission note inside the budget
  let omittedLists = false;
  for (const line of listLines) {
    if (used + line.length + 1 + omittedNoteReserve > budgetChars) { omittedLists = true; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (omittedLists) {
    lines.push(`[…further protected-head lines omitted by the ${budgetChars}-char budget — not dropped, just not re-rendered here; see the ledger and .mochi/state/todo.json…]`);
  }
  return lines.join('\n');
}

export interface ReinjectionResult {
  /** '' when there was nothing to re-inject (no head members, no keys). */
  block: string;
  budgetChars: number;
  spentChars: number;
  /** Every store key referenced by surviving markers (scanned input). */
  keys: string[];
  /** The subset that fit the budget and got a description line. */
  keysIncluded: string[];
  /** True when anything was cut by the budget. */
  truncated: boolean;
}

const REINJECTION_HEADER = '[POST-COMPACTION EVIDENCE RE-INJECTION — the next step\u2019s reachable evidence, bounded]';

/**
 * Build the bounded post-compaction re-injection block: the protected head
 * plus, for each store key referenced by surviving markers, a one-line
 * description (chars + preview). Keys that do not fit the budget keep their
 * ledger references (the ledger line names them); the block says how many
 * were omitted. Keys that FAIL to resolve are labeled as broken in the
 * block — a marker that points nowhere is surfaced, never hidden.
 *
 * Bound contract: list members (key lines, head lists) obey `budgetChars`
 * exactly; the block's irreducible floor — the header, the snapshot lines
 * (goal ≤400 + next action ≤200 by construction), and the keys header — is
 * exempt, mirroring buildRecoveryBlock's contract-fact exemption. The
 * snapshot is the one payload that must never be budget-cut, and it is
 * capped at ~730 chars by construction, so the block can never exceed
 * max(budgetChars, ~730 + key lines already counted). */
export function buildReinjectionBlock(input: {
  head: ProtectedHead;
  keys: readonly string[];
  describeKey?: (key: string) => string | null;
  budgetChars?: number;
}): ReinjectionResult {
  const budget = Math.max(200, input.budgetChars ?? DEFAULT_REINJECTION_BUDGET_CHARS);
  const headRender = renderProtectedHead(input.head, Math.max(200, Math.floor(budget * 0.6)));
  const keys = [...input.keys];
  if (!headRender && keys.length === 0) {
    return { block: '', budgetChars: budget, spentChars: 0, keys, keysIncluded: [], truncated: false };
  }

  const lines: string[] = [REINJECTION_HEADER];
  let spent = REINJECTION_HEADER.length;
  if (headRender) {
    lines.push(headRender);
    spent += headRender.length + 1;
  }

  const keysIncluded: string[] = [];
  let omittedKeys = 0;
  // Reserve room for a potential omission note so the block (note included)
  // never exceeds the budget — the note is part of the spend, not an extra.
  const noteReserve = 160;
  if (keys.length > 0) {
    const keysHeader = 'Evidence spilled to the local content store (referenced by surviving markers above) — retrieve the FULL text with recall_output key="<key>":';
    lines.push(keysHeader);
    spent += keysHeader.length + 1;
    for (const key of keys) {
      const described = input.describeKey ? input.describeKey(key) : `${key}: (un described)`;
      const line = described
        ? `- ${described.slice(0, 240)}`
        : `- ${key}: [BROKEN POINTER — the key does not resolve in the local store]`;
      if (spent + line.length + 1 + noteReserve > budget) { omittedKeys++; continue; }
      lines.push(line);
      spent += line.length + 1;
      keysIncluded.push(key);
    }
    if (omittedKeys > 0) {
      const note = `(+${omittedKeys} spill key(s) omitted by the ${budget}-char re-injection budget — still referenced verbatim by their markers and by the compacted ledger)`;
      lines.push(note);
      spent += note.length + 1;
    }
  }
  return {
    block: lines.join('\n'),
    budgetChars: budget,
    spentChars: spent,
    keys,
    keysIncluded,
    truncated: omittedKeys > 0,
  };
}
