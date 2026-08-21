// Cline/OpenCode-style view layer for the mochi TUI.
//
// Pure rendering functions (no I/O, no terminal) extracted so the look is
// unit-testable: transcript entries (user/assistant/tool/system), the ❯
// input bar with hairline rules, the three-row status bar (model + context
// bar + tokens/cost | Plan/Act | git stats | auto-approve), the slash-command
// autocomplete dropdown, and the braille thinking spinner.
//
// Design language mirrors Cline's OpenTUI components (status-bar.tsx,
// input-bar.tsx, chat-message-list.tsx, tool-output.tsx) and themes.ts:
// act #79b8ff, plan #ffea7f, success #99e89b, muted grays, and a transcript
// capped to a comfortable reading width on wide terminals.
import type { LineKind } from './state.js';

// ---- Palette (harmonized with Cline's dark theme accents) -----------------
export const T = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  /** act accent (Cline #79b8ff) */
  act: '\x1b[38;2;121;184;255m',
  /** plan accent (Cline #ffea7f) */
  plan: '\x1b[38;2;255;234;127m',
  /** success (Cline #99e89b) */
  success: '\x1b[38;2;153;232;155m',
  error: '\x1b[38;2;248;81;73m',
  warning: '\x1b[38;2;240;173;77m',
  gray: '\x1b[38;2;139;148;158m',
  grayDark: '\x1b[38;2;72;79;86m',
  fg: '\x1b[38;2;230;237;243m',
  /** user message background tint */
  bgUser: '\x1b[48;2;32;39;49m',
  /** rule/border color for the input bar */
  rule: '\x1b[38;2;48;54;61m',
  /** brand */
  pink: '\x1b[38;2;255;175;209m',
} as const;

export const RESULT = '⌿';
export const MAX_COLLAPSED_LINES = 5;
/** Cline caps its home view at 60; chat transcript reads best near this. */
export const TRANSCRIPT_MAX_WIDTH = 72;

// ---- Shared helpers --------------------------------------------------------
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate with ellipsis on a visible-length budget. */
export function ellipsize(s: string, max: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= max) return plain;
  return plain.slice(0, Math.max(1, max - 1)) + '…';
}

export function padEnd(s: string, n: number): string {
  const vis = visibleLen(s);
  if (vis >= n) return stripAnsi(s).slice(0, n); // width safety net, colors dropped
  return s + ' '.repeat(n - vis);
}

// ---- Thinking spinner (braille dots like opentui-spinner "dots") ----------
const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function spinnerFrame(i: number): string {
  return DOTS[Math.abs(i) % DOTS.length];
}

export function thinkingLine(frame: number, note = ''): string {
  const note_ = note ? ` ${note}` : '';
  return `${T.gray}${spinnerFrame(frame)} Thinking…${note_}${T.reset} ${T.grayDark}(esc to cancel)${T.reset}`;
}

// ---- Context bar (Cline createContextBar) ----------------------------------
export interface ContextBar {
  filled: string;
  empty: string;
  pct: number;
}

export function contextBar(used: number, total: number | undefined, width = 6): ContextBar {
  const w = Math.max(0, Math.floor(width));
  const ratio = total && total > 0 ? Math.min(used / total, 1) : 0;
  const filledCount =
    total && total > 0 && used > 0
      ? used >= total
        ? w
        : Math.min(Math.max(1, Math.ceil(ratio * w)), Math.max(0, w - 1))
      : 0;
  return {
    filled: '█'.repeat(filledCount),
    empty: '█'.repeat(Math.max(0, w - filledCount)),
    pct: ratio,
  };
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/** Cline formatStatusBarUsageText: "(12,345) $0.42" */
export function usageText(totalTokens: number, totalCost: number): string {
  const tokens = `(${totalTokens.toLocaleString()})`;
  return `${tokens} ${formatCost(totalCost)}`;
}

// ---- Status bar (three Cline rows) -----------------------------------------
export interface StatusBarModel {
  modelId: string;
  totalTokens: number;
  totalCost: number;
  maxInputTokens?: number;
  /** plan/act mode */
  mode: 'plan' | 'act';
  workspaceName: string;
  gitBranch: string | null;
  gitDiff: { files: number; additions: number; deletions: number } | null;
  autoApprove: boolean;
  /** extra mochi badges: kv-cache, queued tasks */
  extra?: string[];
}

/** Row 1: model + context … ○ Plan ● Act (Tab) */
export function statusBarRow1(m: StatusBarModel, width: number): string {
  const bar = m.maxInputTokens ? contextBar(m.totalTokens, m.maxInputTokens) : undefined;
  const usage = usageText(m.totalTokens, m.totalCost);
  const barText = bar
    ? ` ${T.fg}${bar.filled}${T.grayDark}${bar.empty}${T.reset} ${T.gray}${usage}${T.reset}`
    : ` ${T.gray}${usage}${T.reset}`;
  const toggle = `${m.mode === 'plan' ? `${T.plan}● Plan` : `${T.grayDark}○ Plan`}${T.reset} ${m.mode === 'act' ? `${T.act}● Act` : `${T.grayDark}○ Act`}${T.reset} ${T.grayDark}(Tab)${T.reset}`;
  const left = `${T.gray}${ellipsize(m.modelId, 40)}${T.reset}${barText}`;
  const extra = m.extra?.length ? ` ${T.grayDark}· ${m.extra.join(' · ')}${T.reset}` : '';
  const leftAll = left + extra;
  const leftLen = visibleLen(leftAll);
  const toggleLen = visibleLen(toggle);
  if (leftLen + toggleLen + 1 <= width) {
    return padEnd(`${leftAll}${' '.repeat(Math.max(1, width - leftLen - toggleLen))}${toggle}`, width);
  }
  // Too narrow: keep the toggle, shrink the model label instead.
  const modelOnly = `${T.gray}${ellipsize(m.modelId, Math.max(8, width - toggleLen - 2))}${T.reset}`;
  return padEnd(`${modelOnly}${' '.repeat(Math.max(1, width - visibleLen(modelOnly) - toggleLen))}${toggle}`, width);
}

/** Row 2: workspace (branch) | N files +X -Y */
export function statusBarRow2(m: StatusBarModel, width: number): string {
  const hasDiff = m.gitDiff && m.gitDiff.files > 0;
  const suffix = hasDiff
    ? ` ${T.grayDark}|${T.reset} ${T.gray}${m.gitDiff!.files} file${m.gitDiff!.files !== 1 ? 's' : ''}${T.reset} ${T.success}+${m.gitDiff!.additions}${T.reset} ${T.error}-${m.gitDiff!.deletions}${T.reset}`
    : '';
  const path = m.workspaceName + (m.gitBranch ? ` (${m.gitBranch})` : '');
  return padEnd(`${T.fg}${ellipsize(path, Math.max(5, width - visibleLen(suffix) - 1))}${T.reset}${suffix}`, width);
}

/** Row 3: auto-approve state. */
export function statusBarRow3(autoApprove: boolean, width: number): string {
  const text = autoApprove
    ? `${T.success}⏵⏵ Auto-approve enabled${T.reset} ${T.grayDark}(Shift+Tab)${T.reset}`
    : `${T.gray}Auto-approve off ${T.grayDark}(Shift+Tab to toggle ⏵⏵)${T.reset}`;
  return padEnd(text, width);
}

// ---- Transcript entries ----------------------------------------------------
export interface RenderEntry {
  kind: LineKind;
  text: string;
}

/**
 * Collapsed tool output (Cline tool-output.tsx): first line with ⌿, then
 * "... N more lines" in gray. Output longer than MAX_COLLAPSED_LINES folds.
 */
export function renderToolOutput(text: string, indent = 2): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  const first = lines[0] ?? '';
  const pad = ' '.repeat(indent);
  const out = [`${pad}${T.gray}${RESULT} ${first}${T.reset}`];
  if (lines.length > 1) {
    out.push(`${pad}${T.gray}   … ${lines.length - 1} more line${lines.length - 1 !== 1 ? 's' : ''}${T.reset}`);
  }
  return out;
}

/** Render one transcript entry to display lines (no wrapping; caller wraps). */
export function renderEntry(entry: RenderEntry, expandTools = false): string[] {
  const text = entry.text;
  if (!text.trim()) return [];
  switch (entry.kind) {
    case 'user':
      // Cline: user text on a subtle background block, ❯ accent.
      return [`${T.act}❯${T.reset} ${T.bgUser}${T.fg}${T.bold}${text}${T.reset}`];
    case 'assistant':
      return [`${T.fg}${text}${T.reset}`];
    case 'tool':
      return expandTools ? [text] : renderToolOutput(text);
    case 'error':
      return [`${T.error}✗ ${text}${T.reset}`];
    case 'system':
      return [`${T.gray}${text}${T.reset}`];
    case 'task':
      return [`${T.gray}· ${text}${T.reset}`];
    case 'goal':
      return [`${T.plan}● ${text}${T.reset}`];
    default:
      return [text];
  }
}

// ---- Input bar (Cline input-bar.tsx: ❯ + hairline rules) -------------------
export interface ComposerModel {
  text: string;
  placeholder: string;
}

export function composerTopRule(width: number): string {
  return `${T.rule}┌${'─'.repeat(Math.max(0, width - 2))}┐${T.reset}`;
}

export function composerRow(text: string, width: number): string {
  const inner = Math.max(1, width - 6);
  const shown = visibleLen(text) > inner ? ellipsize(text, inner) : text;
  return `${T.rule}│${T.reset} ${T.act}${T.bold}❯${T.reset} ${T.fg}${padEnd(shown, inner)}${T.reset} ${T.rule}│${T.reset}`;
}

export function composerPlaceholderRow(placeholder: string, width: number): string {
  const inner = Math.max(1, width - 6);
  return `${T.rule}│${T.reset} ${T.act}${T.bold}❯${T.reset} ${T.grayDark}${padEnd(placeholder, inner)}${T.reset} ${T.rule}│${T.reset}`;
}

export function composerBottomRule(width: number, hint: string): string {
  const inner = Math.max(0, width - 2);
  const hintVis = visibleLen(hint) + 2;
  const left = '─'.repeat(Math.max(0, inner - hintVis));
  return `${T.rule}└${left}${T.reset} ${T.grayDark}${hint}${T.reset} ${T.rule}┘${T.reset}`;
}

// ---- Autocomplete dropdown (Cline autocomplete-dropdown.tsx) ---------------
export interface DropdownItem {
  name: string;
  hint: string;
}

export function renderDropdown(items: DropdownItem[], selected: number, width: number): string[] {
  if (!items.length) return [];
  const w = Math.min(width, 64);
  const out: string[] = [];
  out.push(`${T.rule}╭${'─'.repeat(Math.max(0, w - 2))}╮${T.reset}`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const sel = i === selected;
    const name = padEnd(it.name, 16);
    const hint = ellipsize(it.hint, Math.max(0, w - 4 - 16 - 3));
    const rowBody = sel
      ? `${T.act}❯ ${T.bold}${name}${T.reset}${T.gray}${hint}${T.reset}`
      : `  ${T.fg}${name}${T.reset}${T.grayDark}${hint}${T.reset}`;
    const pad = Math.max(0, w - 2 - 2 - 16 - visibleLen(hint));
    out.push(`${T.rule}│${T.reset}${rowBody}${' '.repeat(pad)}${T.rule}│${T.reset}`);
  }
  out.push(`${T.rule}╰${'─'.repeat(Math.max(0, w - 2))}╯${T.reset}`);
  return out;
}

// ---- Layout glue -----------------------------------------------------------
/** Horizontal center offset for the transcript column, Cline-style. */
export function transcriptIndent(termWidth: number): number {
  const w = Math.min(termWidth, TRANSCRIPT_MAX_WIDTH);
  return Math.max(0, Math.floor((termWidth - w) / 2));
}