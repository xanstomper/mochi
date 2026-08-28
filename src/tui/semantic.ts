// Semantic color + status system (master rebuild Phases 11 & 28 & 32).
//
// ONE map from meaning to visual treatment. Components consume these enums —
// they never invent their own colors or symbols. Semantic categories resolve
// onto the existing theme palette (T) and role colors (R) so themes keep
// control of the actual RGB values while the MEANING stays fixed.

import { T, R } from './view.js';

/** The 19 semantic categories from the design spec. Every colored thing in
 *  the UI must map to exactly one of these. */
export type Semantic =
  | 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CRITICAL'
  | 'TOOL' | 'COMMAND' | 'FILE' | 'CODE' | 'REFERENCE' | 'LINK'
  | 'PLAN' | 'REASONING' | 'DECISION' | 'CHANGE' | 'TEST'
  | 'PERFORMANCE' | 'SECURITY' | 'CONTEXT';

/** Resolution table: semantic meaning -> ANSI color from the theme palette.
 *  This object is the ONLY place meaning maps to color. */
export const SEMANTIC_COLOR: Record<Semantic, string> = {
  INFO: T.fg,
  SUCCESS: T.success,
  WARNING: T.warning,
  ERROR: T.error,
  CRITICAL: T.error,
  TOOL: R.toolMarker,
  COMMAND: T.teal,
  FILE: T.cyan,
  CODE: T.violet,
  REFERENCE: T.pink,
  LINK: T.cyan,
  PLAN: T.plan,
  REASONING: R.thoughtText,
  DECISION: T.orange,
  CHANGE: T.lime,
  TEST: T.success,
  PERFORMANCE: T.magenta,
  SECURITY: T.error,
  CONTEXT: T.gray,
};

/** Status glyphs (Phase 28): one symbol per status, used everywhere. */
export type StatusKind =
  | 'completed' | 'running' | 'queued' | 'warning' | 'failed' | 'canceled' | 'skipped';

export const STATUS_GLYPH: Record<StatusKind, string> = {
  completed: '✓',
  running: '●',
  queued: '○',
  warning: '!',
  failed: '✗',
  canceled: '⊘',
  skipped: '–',
};

/** Glyph + color for a status kind, composed. */
export function statusLabel(kind: StatusKind): string {
  const color: Record<StatusKind, string> = {
    completed: T.success,
    running: T.cyan,
    queued: T.gray,
    warning: T.warning,
    failed: T.error,
    canceled: T.gray,
    skipped: T.gray,
  };
  return `${color[kind]}${STATUS_GLYPH[kind]} ${kind}${T.reset}`;
}

/** Priority -> visual weight (Phase 10). Loud for P0, silent for P4. */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export const PRIORITY_STYLE: Record<Priority, { color: string; bold: boolean; dim: boolean }> = {
  P0: { color: T.error, bold: true, dim: false },
  P1: { color: T.fg, bold: false, dim: false },
  P2: { color: T.fg, bold: false, dim: false },
  P3: { color: T.gray, bold: false, dim: true },
  P4: { color: T.grayDark, bold: false, dim: true },
};

/** Paint text with a semantic category. The single sanctioned way to colorize. */
export function paint(text: string, semantic: Semantic): string {
  return `${SEMANTIC_COLOR[semantic]}${text}${T.reset}`;
}

/** Paint text according to its priority weight. */
export function paintPriority(text: string, priority: Priority): string {
  const s = PRIORITY_STYLE[priority];
  return `${s.color}${s.bold ? T.bold : ''}${s.dim ? T.dim : ''}${text}${T.reset}`;
}