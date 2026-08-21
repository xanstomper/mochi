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
  // ---- extended mochi palette -------------------------------------------
  /** magenta #ff6ec7 — brand-forward accent for headers/tasks */
  magenta: '\x1b[38;2;255;110;199m',
  /** violet #c792ea — tool call names */
  violet: '\x1b[38;2;199;146;234m',
  /** cyan #56d4dd — streaming tokens */
  cyan: '\x1b[38;2;86;212;221m',
  /** lime #a3e635 — cache hits */
  lime: '\x1b[38;2;163;230;53m',
  /** orange #ff9e64 — in-flight work */
  orange: '\x1b[38;2;255;158;100m',
  /** teal #2dd4bf — plan-mode banner */
  teal: '\x1b[38;2;45;212;191m',
} as const;

/** Truecolor 24-bit fg helper. */
export function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Interpolate two [r,g,b] colors; t in [0,1]. */
export function lerp(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return [c(a[0], b[0]), c(a[1], b[1]), c(a[2], b[2])];
}

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

// ---- Thinking spinner ------------------------------------------------------
// Layered animation: a braille cycle for motion + a sweeping color gradient
// (violet → cyan → lime) so the spinner feels alive instead of a gray dot.
const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_COLORS: Array<[number, number, number]> = [
  [199, 146, 234], // violet
  [121, 184, 255], // act blue
  [86, 212, 221],  // cyan
  [163, 230, 53],  // lime
];

export function spinnerFrame(i: number): string {
  return DOTS[Math.abs(i) % DOTS.length];
}

export function spinnerColored(i: number): string {
  const dot = spinnerFrame(i);
  const c = SPIN_COLORS[Math.abs(i) % SPIN_COLORS.length];
  return `${rgb(c[0], c[1], c[2])}${T.bold}${dot}${T.reset}`;
}

/** Animated gradient underline that sweeps under the thinking note. */
export function spinnerSweep(i: number, width = 18): string {
  const pos = Math.abs(i) % width;
  const cells: string[] = [];
  for (let x = 0; x < width; x++) {
    const dist = Math.abs(x - pos);
    if (dist > 2) { cells.push(`${T.grayDark}·${T.reset}`); continue; }
    const t = 1 - dist / 2; // 0..1 peak at the sweep head
    const c = lerp([72, 79, 86], [86, 212, 221], t);
    cells.push(`${rgb(c[0], c[1], c[2])}━${T.reset}`);
  }
  return cells.join('');
}

export function thinkingLine(frame: number, note = ''): string {
  const note_ = note ? ` ${T.orange}${note}${T.reset}` : '';
  return `${spinnerColored(frame)} ${T.cyan}Thinking…${T.reset}${note_} ${T.grayDark}(esc to cancel)${T.reset}\n${spinnerSweep(frame)}`;
}

// ---- jcode-style animated context + cache bars ----------------------------
export interface GradientBar {
  text: string;
  pct: number;
}

const CTX_STOPS: Array<[number, number, number]> = [
  [163, 230, 53],  // lime — plenty of room
  [86, 212, 221],  // cyan
  [255, 234, 127], // yellow
  [255, 158, 100], // orange
  [248, 81, 73],   // red — nearly full
];

function rampColor(pct: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, pct));
  const scaled = clamped * (CTX_STOPS.length - 1);
  const idx = Math.min(CTX_STOPS.length - 2, Math.floor(scaled));
  return lerp(CTX_STOPS[idx], CTX_STOPS[idx + 1], scaled - idx);
}

/**
 * Animated gradient context bar (jcode-style): each filled cell gets the
 * gradient ramp color for its position; an animated glow head tracks `tick`
 * so the bar shimmers while active.
 */
export function gradientContextBar(used: number, total: number | undefined, width = 12, tick = 0): GradientBar {
  const w = Math.max(0, Math.floor(width));
  const pct = total && total > 0 ? Math.min(used / total, 1) : 0;
  const filled = total && total > 0 && used > 0 ? Math.max(1, Math.round(pct * w)) : 0;
  const cells: string[] = [];
  for (let x = 0; x < w; x++) {
    if (x < filled) {
      const frac = w > 1 ? x / (w - 1) : 1;
      const c = rampColor(frac);
      const isHead = tick > 0 && x === (tick - 1) % Math.max(1, filled);
      cells.push(isHead
        ? `${T.bold}${rgb(255, 255, 255)}█${T.reset}`
        : `${rgb(c[0], c[1], c[2])}█${T.reset}`);
    } else {
      cells.push(`${T.grayDark}░${T.reset}`);
    }
  }
  return { text: cells.join(''), pct };
}

/** Cache-hit bar: lime gradient + live percentage, animated shimmer head. */
export function gradientCacheBar(hitRate: number, width = 10, tick = 0): GradientBar {
  const w = Math.max(0, Math.floor(width));
  const pct = Math.max(0, Math.min(1, hitRate));
  const filled = Math.round(pct * w);
  const cells: string[] = [];
  for (let x = 0; x < w; x++) {
    if (x < filled) {
      const frac = w > 1 ? x / (w - 1) : 1;
      const c = lerp([74, 222, 128], [163, 230, 53], frac);
      const isHead = tick > 0 && x === (tick - 1) % Math.max(1, filled);
      cells.push(isHead
        ? `${T.bold}${rgb(220, 255, 200)}▪${T.reset}`
        : `${rgb(c[0], c[1], c[2])}▪${T.reset}`);
    } else {
      cells.push(`${T.grayDark}▪${T.reset}`);
    }
  }
  return { text: cells.join(''), pct };
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
 * The tool name keeps its coordinated accent color.
 */
export function renderToolOutput(text: string, indent = 2): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  const first = accentToolPrefix(lines[0] ?? '');
  const pad = ' '.repeat(indent);
  const out = [`${pad}${T.gray}${RESULT} ${first}${T.reset}`];
  if (lines.length > 1) {
    out.push(`${pad}${T.gray}   … ${lines.length - 1} more line${lines.length - 1 !== 1 ? 's' : ''}${T.reset}`);
  }
  return out;
}

/** Color-coordinate tool names: known edit tools get the violet accent,
 *  read tools cyan, verification lime — so a transcript scan shows what the
 *  agent is DOING at a glance. */
const TOOL_ACCENTS: Array<[RegExp, string]> = [
  [/^(write|edit|delete|patch|replace_symbol|search_replace_multi)\b/, 'violet'],
  [/^(read|search|glob|inspect|tree|fetch|deepwiki|clipboard)\b/, 'cyan'],
  [/^(shell|git|verify|perf)\b/, 'orange'],
  [/^(memory|skill|subagent|chameleon|analyze_code|sql_codebase_query)\b/, 'magenta'],
];

function accentToolPrefix(text: string): string {
  const name = text.split(/[(:]/)[0] ?? '';
  for (const [re, color] of TOOL_ACCENTS) {
    if (re.test(name)) return `${(T as any)[color]}${name}${T.reset}${T.grayDark}${text.slice(name.length)}${T.reset}`;
  }
  return `${T.violet}${name}${T.reset}${T.grayDark}${text.slice(name.length)}${T.reset}`;
}

/** Render one transcript entry with mochi color coordination. */
export function renderEntry(entry: RenderEntry, expandTools = false): string[] {
  const text = entry.text;
  if (!text.trim()) return [];
  switch (entry.kind) {
    case 'user':
      return [`${T.magenta}❯${T.reset} ${T.bgUser}${T.fg}${T.bold}${text}${T.reset}`];
    case 'assistant':
      return [`${T.cyan}${text}${T.reset}`];
    case 'tool':
      return expandTools ? [accentToolPrefix(text)] : renderToolOutput(text);
    case 'error':
      return [`${T.error}${T.bold}✗${T.reset} ${T.error}${text}${T.reset}`];
    case 'system':
      return [`${T.gray}${text}${T.reset}`];
    case 'task':
      return [`${T.teal}▸ ${text}${T.reset}`];
    case 'goal':
      return [`${T.pink}${T.bold}● ${text}${T.reset}`];
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

// ---- Animated mochi splash screen ------------------------------------------
// Big block-letter MOCHI (figlet "ANSI Shadow"-style) rendered as a loading
// animation: gradient sheen sweeps left→right across the letters, a progress
// bar fills underneath with live status text, then it fades into the session.
const MOCHI_ASCII = [
  '█▀▄▀█ █▀▀█ █▀▀▀ █  █ ▀█▀',
  '█ ▀ █ █  █ █    █▀▀█  █ ',
  '▀   ▀ ▀▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀',
];

const SPLASH_STOPS: Array<[number, number, number]> = [
  [255, 110, 199], // magenta
  [199, 146, 234], // violet
  [86, 212, 221],  // cyan
  [121, 184, 255], // blue
  [255, 175, 209], // pink
];

/** Loading progress messages shown under the logo, one per phase. */
export const SPLASH_PHASES = [
  'warming up the dango…',
  'loading skills + memory…',
  'indexing code graph…',
  'connecting model provider…',
  'ready.',
] as const;

/** One frame of the animated splash.
 *  - tick: animation frame counter (drives sheen + progress)
 *  - progress: 0..1 real startup progress (drives the loading bar)
 */
export function splashFrame(tick: number, width: number, version: string, progress = 1): string[] {
  const logoW = MOCHI_ASCII.reduce((m, l) => Math.max(m, l.length), 0);
  const lines: string[] = [''];

  // Per-cell gradient sheen: a bright band sweeps across the letters.
  const sheenPos = (tick % (logoW + 12)) - 6;
  for (let r = 0; r < MOCHI_ASCII.length; r++) {
    const row = MOCHI_ASCII[r];
    const left = Math.max(0, Math.floor((width - logoW) / 2));
    const cells: string[] = [];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ' ') { cells.push(' '); continue; }
      // base gradient along the row: magenta → violet → cyan → blue
      const base = lerp(SPLASH_STOPS[0], SPLASH_STOPS[2], x / Math.max(1, logoW - 1));
      // sheen: brighten near the sweep position
      const dist = Math.abs(x - sheenPos);
      const glow = dist <= 4 ? 1 - dist / 4 : 0;
      const c = lerp(base, [255, 255, 255], glow * 0.85);
      cells.push(`${rgb(c[0], c[1], c[2])}${T.bold}${ch}${T.reset}`);
    }
    lines.push(' '.repeat(left) + cells.join(''));
  }

  // Loading bar with animated fill + status text for the current phase.
  lines.push('');
  const barW = Math.min(40, width - 8);
  const barLeft = Math.max(0, Math.floor((width - barW) / 2));
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * barW);
  const head = filled > 0 && filled < barW && progress < 1 ? (tick % 2 === 0 ? '▓' : '▒') : '';
  const bar =
    `${T.magenta}${'━'.repeat(Math.max(0, filled - (head ? 1 : 0)))}${T.reset}` +
    (head ? `${T.bold}${rgb(255,255,255)}${head}${T.reset}` : '') +
    `${T.grayDark}${'━'.repeat(Math.max(0, barW - filled))}${T.reset}`;
  lines.push(' '.repeat(barLeft) + bar);
  const phaseIdx = Math.min(SPLASH_PHASES.length - 1, Math.floor(progress * SPLASH_PHASES.length));
  const phase = SPLASH_PHASES[phaseIdx];
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const label = `${phase}  ${pct}%`;
  lines.push(' '.repeat(Math.max(0, Math.floor((width - label.length) / 2))) + `${T.gray}${phase}${T.reset}  ${T.pink}${pct}%${T.reset}`);

  // version footer
  const sub = `mochi v${version}`;
  lines.push('');
  lines.push(' '.repeat(Math.max(0, Math.floor((width - sub.length) / 2))) + `${T.grayDark}${sub}${T.reset}`);
  return lines;
}

/** Splash duration in ticks (~2.4s at 60ms); the bar reflects REAL startup
 *  milestones passed by the caller via progress. */
export const SPLASH_TICKS = 40;
