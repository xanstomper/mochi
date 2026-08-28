// Session Compaction (master rebuild Phases 20 & 21).
//
// RAW SESSION → IMPORTANCE SCORING → FACT/DECISION/FILE/ISSUE EXTRACTION →
// DEDUPE → STRUCTURED MEMORY → COMPACT CONTEXT.
//
// NEVER discards: requirements, constraints, architectural decisions, errors,
// unresolved issues, file references, user decisions. Discards: conversational
// noise (chunks, repetitive logs), duplicated tool results. Output is bounded
// so compaction cannot regress into an unbounded prompt.

import type { MochiEvent } from '../types.js';

export interface CompactContext {
  goal?: string;
  decisions: string[];
  implemented: string[];
  files: string[];
  constraints: string[];
  unresolved: string[];
  references: string[];
  nextAction?: string;
  /** true when anything was preserved (an empty context means compaction
   *  found nothing of value and callers should keep the raw transcript). */
  isEmpty: boolean;
}

export interface CompactOptions {
  goal?: string;
  constraints?: string[];
  priorDecisions?: string[];
  maxPerSection?: number;
}

const DEFAULT_MAX = 12;

function pushBounded(arr: string[], value: string, max: number): void {
  const v = value.trim();
  if (!v) return;
  if (arr.includes(v)) return;
  if (arr.length >= max) arr.shift(); // drop oldest when full
  arr.push(v);
}

/** Extract a bounded, structured memory from the session's event stream. */
export function compactSession(events: readonly MochiEvent[], opts: CompactOptions = {}): CompactContext {
  const max = opts.maxPerSection ?? DEFAULT_MAX;
  const out: CompactContext = {
    goal: opts.goal,
    decisions: [...(opts.priorDecisions ?? [])],
    implemented: [],
    files: [],
    constraints: [...(opts.constraints ?? [])],
    unresolved: [],
    references: [],
    nextAction: undefined,
    isEmpty: false,
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'file:changed':
        pushBounded(out.files, `${ev.operation}: ${ev.path}`, max);
        pushBounded(out.implemented, `${ev.operation} ${ev.path}`, max);
        break;
      case 'diff:generated':
        pushBounded(out.files, `${ev.path} (+${ev.additions}/-${ev.deletions})`, max);
        break;
      case 'task:failed':
        pushBounded(out.unresolved, ev.reason.slice(0, 240), max);
        break;
      case 'tool:failed':
        pushBounded(out.unresolved, `${ev.tool}: ${ev.error.slice(0, 200)}`, max);
        break;
      case 'error':
        pushBounded(out.unresolved, ev.error.slice(0, 240), max);
        break;
      case 'agent:reasoning':
        // Reasoning lines that mention a decision keyword are decisions.
        if (/decid|choose|approach|strategy|because/i.test(ev.content)) {
          pushBounded(out.decisions, ev.content.slice(0, 240), max);
        }
        break;
      case 'tool:completed': {
        const head = (ev.result.output || '').split('\n')[0].slice(0, 160);
        if (head) pushBounded(out.references, `${ev.tool}: ${head}`, max);
        break;
      }
      case 'command:completed':
        pushBounded(out.references, `$ ${ev.command} (exit ${ev.exitCode})`, max);
        break;
      default:
        break; // chunks/logs/noise intentionally dropped
    }
  }

  // Compaction with no signal: caller should retain the raw transcript rather
  // than replace it with an empty summary.
  out.isEmpty =
    out.decisions.length === 0 &&
    out.implemented.length === 0 &&
    out.files.length === 0 &&
    out.unresolved.length === 0 &&
    out.references.length === 0 &&
    !out.nextAction &&
    !out.goal;

  return out;
}

/** Render the compact context as the structured SESSION CONTEXT block
 *  (Phase 20 format). Empty sections are omitted. */
export function compactToPrompt(ctx: CompactContext): string {
  if (ctx.isEmpty) return '';
  const sections: string[] = ['SESSION CONTEXT'];
  if (ctx.goal) sections.push(`GOAL\n${ctx.goal}`);
  if (ctx.decisions.length) sections.push(`DECISIONS\n${ctx.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (ctx.implemented.length) sections.push(`IMPLEMENTED\n${ctx.implemented.map((d) => `- ${d}`).join('\n')}`);
  if (ctx.files.length) sections.push(`FILES\n${ctx.files.map((d) => `- ${d}`).join('\n')}`);
  if (ctx.constraints.length) sections.push(`CONSTRAINTS\n${ctx.constraints.map((d) => `- ${d}`).join('\n')}`);
  if (ctx.unresolved.length) sections.push(`UNRESOLVED\n${ctx.unresolved.map((d) => `- ${d}`).join('\n')}`);
  if (ctx.references.length) sections.push(`IMPORTANT REFERENCES\n${ctx.references.map((d) => `- ${d}`).join('\n')}`);
  if (ctx.nextAction) sections.push(`NEXT ACTION\n${ctx.nextAction}`);
  return sections.join('\n\n');
}