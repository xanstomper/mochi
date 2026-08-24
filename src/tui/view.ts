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

import { THEMES, getTheme, getAllThemes, getCurrentTheme, applyTheme, themeSwatch, type MochiTheme } from './themes.js';

export { THEMES, getTheme, getAllThemes, getCurrentTheme, applyTheme, themeSwatch, type MochiTheme };

// ---- Palette (customizable with 15 handcrafted themes) -------------------
export const T = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  ...getCurrentTheme().colors,
};

/** Switch active theme dynamically. Updates all color codes in T in place. */
export function setTheme(themeId: string): MochiTheme {
  const t = applyTheme(themeId);
  Object.assign(T, t.colors);
  return t;
}

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
export const TRANSCRIPT_MAX_WIDTH = 100;

// ---- Shared helpers --------------------------------------------------------
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate with ellipsis on a visible-length budget, preserving ANSI color codes. */
export function ellipsize(s: string, max: number): string {
  const vis = visibleLen(s);
  if (vis <= max) return s;
  let out = '';
  let visCount = 0;
  let i = 0;
  while (i < s.length && visCount < max - 1) {
    if (s[i] === '\x1b') {
      const match = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += s[i];
    visCount++;
    i++;
  }
  return out + '\x1b[0m…';
}

export function padEnd(s: string, n: number): string {
  const vis = visibleLen(s);
  if (vis >= n) return ellipsize(s, n);
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
  return `${spinnerColored(frame)} ${T.cyan}Thinking…${T.reset} ${spinnerSweep(frame, 8)}${note_} ${T.grayDark}(esc to cancel)${T.reset}`;
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
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
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
  /** active execution mode (normal/spec/security/codemod/chaos) */
  agentMode?: string;
  /** active reasoning effort (low/medium/high/max) */
  reasoningLevel?: string;
  workspaceName: string;
  gitBranch: string | null;
  gitDiff: { files: number; additions: number; deletions: number } | null;
  autoApprove: boolean;
  /** extra mochi badges: kv-cache, queued tasks */
  extra?: string[];
}

function modeColor(mode: string): string {
  switch (mode) {
    case 'spec':
      return T.plan;
    case 'security':
      return T.error;
    case 'codemod':
      return T.violet;
    case 'chaos':
      return T.warning;
    default:
      return T.gray;
  }
}

/** Row 1: model + [REASON: LEVEL] + [mode] + context … ○ Plan ● Act (Tab) */
export function statusBarRow1(m: StatusBarModel, width: number): string {
  const bar = m.maxInputTokens ? contextBar(m.totalTokens, m.maxInputTokens) : undefined;
  const usage = usageText(m.totalTokens, m.totalCost);
  const barText = bar
    ? ` ${T.fg}${bar.filled}${T.grayDark}${bar.empty}${T.reset} ${T.gray}${usage}${T.reset}`
    : ` ${T.gray}${usage}${T.reset}`;
  const toggle = `${m.mode === 'plan' ? `${T.plan}● Plan` : `${T.grayDark}○ Plan`}${T.reset} ${m.mode === 'act' ? `${T.act}● Act` : `${T.grayDark}○ Act`}${T.reset} ${T.grayDark}(Tab)${T.reset}`;
  const reasoningBadge = m.reasoningLevel
    ? ` ${T.cyan}${T.bold}[REASON: ${m.reasoningLevel.toUpperCase()}]${T.reset}`
    : '';
  const modeBadge = m.agentMode && m.agentMode !== 'normal'
    ? ` ${modeColor(m.agentMode)}${T.bold}[${m.agentMode.toUpperCase()}]${T.reset}`
    : '';
  const left = `${T.fg}${T.bold}${ellipsize(m.modelId, 28)}${T.reset}${reasoningBadge}${modeBadge}${barText}`;
  const extra = m.extra?.length ? ` ${T.grayDark}· ${m.extra.join(' · ')}${T.reset}` : '';
  const leftAll = left + extra;
  const leftLen = visibleLen(leftAll);
  const toggleLen = visibleLen(toggle);
  if (leftLen + toggleLen + 1 <= width) {
    return padEnd(`${leftAll}${' '.repeat(Math.max(1, width - leftLen - toggleLen))}${toggle}`, width);
  }
  // Too narrow: keep the toggle, shrink the model label instead.
  const reasonLen = visibleLen(reasoningBadge);
  const modelMax = Math.max(6, width - toggleLen - reasonLen - 3);
  const modelOnly = `${T.fg}${T.bold}${ellipsize(m.modelId, modelMax)}${T.reset}${reasoningBadge}`;
  return padEnd(`${modelOnly}${' '.repeat(Math.max(1, width - visibleLen(modelOnly) - toggleLen))}${toggle}`, width);
}

/** Row 2: workspace (branch) | auto-approve | N files +X -Y */
export function statusBarRow2(m: StatusBarModel, width: number): string {
  const hasDiff = m.gitDiff && m.gitDiff.files > 0;
  const suffix = hasDiff
    ? ` ${T.grayDark}|${T.reset} ${T.gray}${m.gitDiff!.files} file${m.gitDiff!.files !== 1 ? 's' : ''}${T.reset} ${T.success}+${m.gitDiff!.additions}${T.reset} ${T.error}-${m.gitDiff!.deletions}${T.reset}`
    : '';
  const autoApproveText = m.autoApprove
    ? `${T.success}Auto improve: ON${T.reset} ${T.grayDark}(Shift+Tab to toggle)${T.reset}`
    : `${T.gray}Auto improve: OFF${T.reset} ${T.grayDark}(Shift+Tab to toggle)${T.reset}`;
  const path = m.workspaceName + (m.gitBranch ? ` (${m.gitBranch})` : '');
  const middle = ` ${T.grayDark}·${T.reset} ${autoApproveText}`;
  return padEnd(`${T.fg}${ellipsize(path, Math.max(5, width - visibleLen(suffix) - visibleLen(middle) - 1))}${T.reset}${middle}${suffix}`, width);
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

export function highlightShellCommand(cmd: string): string {
  if (!cmd || !cmd.trim()) return cmd;
  const parts = cmd.trim().split(/(\s+|&&|\|\||\||;)/);
  if (!parts.length) return cmd;

  return parts.map((part, idx) => {
    if (!part || /^\s+$/.test(part)) return part;
    if (part === '&&' || part === '||' || part === '|' || part === ';') {
      return `${T.orange}${T.bold}${part}${T.reset}`;
    }
    // Leading binary of each command pipe / chain
    const prev = idx > 1 ? parts[idx - 2]?.trim() : '';
    const isBin = idx === 0 || prev === '&&' || prev === '||' || prev === '|' || prev === ';';
    if (isBin) {
      return `${T.cyan}${T.bold}${part}${T.reset}`;
    }
    // Flags (e.g. -v, --release, -m, --filter=...)
    if (part.startsWith('-')) {
      if (part.includes('=')) {
        const [flag, val] = part.split('=', 2);
        return `${T.orange}${flag}${T.reset}=${T.lime}${val}${T.reset}`;
      }
      return `${T.orange}${part}${T.reset}`;
    }
    // Common subcommands / verbs
    if (/^(build|test|run|check|status|commit|push|pull|checkout|branch|diff|log|add|rm|reset|install|update|publish|serve|start|stop|restart|daemon|team|exec|fmt|lint)\b/i.test(part)) {
      return `${T.magenta}${T.bold}${part}${T.reset}`;
    }
    // Quoted strings
    if (/^["'].*["']$/.test(part)) {
      return `${T.lime}${part}${T.reset}`;
    }
    // File paths / extensions / numbers
    if (part.includes('/') || (part.includes('.') && !/^\d+$/.test(part))) {
      return `${T.teal}${part}${T.reset}`;
    }
    if (/^\d+$/.test(part)) {
      return `${T.orange}${part}${T.reset}`;
    }
    return `${T.fg}${part}${T.reset}`;
  }).join('');
}

/** Visual Unicode meter bar for token/budget/progress metrics. */
export function renderMetricGauge(label: string, value: number, max: number, unit = '', width = 12): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  const color = ratio < 0.6 ? T.lime : ratio < 0.85 ? T.orange : T.error;
  const bar = `${color}${'█'.repeat(filled)}${T.grayDark}${'░'.repeat(empty)}${T.reset}`;
  const pct = Math.round(ratio * 100);
  const formattedVal = value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`;
  const formattedMax = max >= 1000 ? `${(max / 1000).toFixed(1)}k` : `${max}`;
  return `${T.gray}${label}:${T.reset} [${bar}] ${color}${pct}%${T.reset} ${T.grayDark}(${formattedVal}/${formattedMax}${unit ? ' ' + unit : ''})${T.reset}`;
}

export function accentToolPrefix(text: string): string {
  if (text.startsWith('⚡') || text.startsWith('[TOOL]')) {
    const rest = text.replace(/^(⚡|\[TOOL\])\s*/, '');
    return `${T.orange}${T.bold}[TOOL]${T.reset} ${T.cyan}${rest}${T.reset}`;
  }
  if (text.startsWith('✓') || text.startsWith('[OK]')) {
    const rest = text.replace(/^(✓|\[OK\])\s*/, '');
    return `${T.success}${T.bold}[OK]${T.reset} ${T.fg}${rest}${T.reset}`;
  }
  if (text.startsWith('✗') || text.startsWith('[ERR]')) {
    const rest = text.replace(/^(✗|\[ERR\])\s*/, '');
    return `${T.error}${T.bold}[ERR]${T.reset} ${T.error}${rest}${T.reset}`;
  }
  if (text.startsWith('[SKIP]')) {
    const rest = text.replace(/^\[SKIP\]\s*/, '');
    return `${T.grayDark}${T.bold}[SKIP]${T.reset} ${T.gray}${rest}${T.reset}`;
  }
  if (text.startsWith('[WARN]')) {
    const rest = text.replace(/^\[WARN\]\s*/, '');
    return `${T.warning}${T.bold}[WARN]${T.reset} ${T.warning}${rest}${T.reset}`;
  }
  const colonIdx = text.indexOf(':');
  if (colonIdx !== -1) {
    const name = text.slice(0, colonIdx).trim();
    const rest = text.slice(colonIdx + 1);
    let color = 'violet';
    for (const [re, c] of TOOL_ACCENTS) {
      if (re.test(name)) { color = c; break; }
    }
    const coloredName = `${(T as any)[color] ?? T.violet}${T.bold}${name}${T.reset}:`;
    if (name === 'shell' || name === 'git') {
      return `${coloredName} ${highlightShellCommand(rest.trimStart())}`;
    }
    return `${coloredName}${T.fg}${rest}${T.reset}`;
  }
  const name = text.split(/[(:\s]/)[0] ?? '';
  for (const [re, color] of TOOL_ACCENTS) {
    if (re.test(name)) return `${(T as any)[color]}${name}${T.reset}${T.grayDark}${text.slice(name.length)}${T.reset}`;
  }
  return `${T.violet}${name}${T.reset}${T.grayDark}${text.slice(name.length)}${T.reset}`;
}

export function formatInlineMarkdown(text: string): string {
  // Bold: **text**
  let s = text.replace(/\*\*(.+?)\*\*/g, `${T.bold}${T.fg}$1${T.reset}${T.fg}`);
  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, `${T.violet}${T.bold}$1${T.reset}${T.fg}`);
  // Italic: *text* (when not preceded or followed by *)
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${T.italic}$1${T.reset}${T.fg}`);
  return `${T.fg}${s}${T.reset}`;
}

function highlightCodeLine(line: string): string {
  let s = line;
  // Keywords
  s = s.replace(/\b(const|let|var|function|return|import|export|from|class|extends|interface|type|async|await|if|else|switch|case|break|for|while|try|catch|throw|finally|new|typeof|instanceof)\b/g, `${T.magenta}$1${T.reset}${T.fg}`);
  // Types & builtins
  s = s.replace(/\b(string|number|boolean|void|any|unknown|never|null|undefined|Promise|Array|Record|Set|Map|Object|Function)\b/g, `${T.cyan}$1${T.reset}${T.fg}`);
  // Strings
  s = s.replace(/(['"`])(.*?)\1/g, `${T.lime}$1$2$1${T.reset}${T.fg}`);
  // Numbers
  s = s.replace(/\b(\d+)\b/g, `${T.orange}$1${T.reset}${T.fg}`);
  // Comments
  s = s.replace(/(\/\/.*$)/g, `${T.grayDark}$1${T.reset}`);
  return `${T.fg}${s}${T.reset}`;
}

/**
 * Fast, ANSI-enhanced terminal markdown renderer.
 * Formats headers, code blocks with syntax highlighting, inline code,
 * bold, italic, bullet lists, blockquotes, and dividers.
 */
export function renderMarkdown(text: string): string[] {
  const rawLines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    // Fenced code blocks
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        const tag = codeBlockLang ? ` ${T.cyan}${codeBlockLang}${T.reset} ` : ' ';
        out.push(`${T.rule}┌──${tag}${'─'.repeat(Math.max(0, 36 - (codeBlockLang?.length || 0)))}┐${T.reset}`);
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
        out.push(`${T.rule}└──${'─'.repeat(38)}┘${T.reset}`);
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(`${T.rule}│${T.reset} ${highlightCodeLine(raw)}`);
      continue;
    }

    // Markdown Headers
    if (trimmed.startsWith('### ')) {
      out.push(`${T.pink}${T.bold}### ${formatInlineMarkdown(trimmed.slice(4))}${T.reset}`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      out.push(`${T.cyan}${T.bold}## ${formatInlineMarkdown(trimmed.slice(3))}${T.reset}`);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      out.push(`${T.magenta}${T.bold}# ${formatInlineMarkdown(trimmed.slice(2))}${T.reset}`);
      continue;
    }

    // Horizontal divider
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(`${T.rule}${'─'.repeat(40)}${T.reset}`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ') || trimmed === '>') {
      out.push(`  ${T.grayDark}│${T.reset} ${T.gray}${formatInlineMarkdown(trimmed.slice(2))}${T.reset}`);
      continue;
    }

    // Unordered bullet lists
    if (/^[\*\-\+]\s+/.test(trimmed)) {
      const content = trimmed.replace(/^[\*\-\+]\s+/, '');
      out.push(`  ${T.cyan}•${T.reset} ${formatInlineMarkdown(content)}`);
      continue;
    }

    // Numbered lists
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      out.push(`  ${T.magenta}${numMatch[1]}.${T.reset} ${formatInlineMarkdown(numMatch[2])}`);
      continue;
    }

    // Standard paragraph line with inline formatting
    out.push(formatInlineMarkdown(raw));
  }

  return out;
}

/** Render one transcript entry with mochi color coordination. */
export function renderEntry(entry: RenderEntry, expandTools = false): string[] {
  const text = entry.text;
  if (!text.trim()) return [];
  switch (entry.kind) {
    case 'user':
      return [`${T.magenta}❯${T.reset} ${T.bgUser}${T.fg}${T.bold}${text}${T.reset}`];
    case 'assistant':
      return renderMarkdown(text);
    case 'thought':
      return text.split('\n').map((l) => `${T.grayDark}│ ${T.reset}${T.italic}${T.gray}${l}${T.reset}`);
    case 'tool':
      return [accentToolPrefix(text)];
    case 'error': {
      const rest = text.startsWith('[ERR] ') ? text.slice(6) : text.replace(/^✗\s*/, '');
      return [`${T.error}${T.bold}[ERR]${T.reset} ${T.error}${rest}${T.reset}`];
    }
    case 'system':
      return [`${T.gray}${text}${T.reset}`];
    case 'task':
      return [`${T.cyan}${T.bold}[TASK]${T.reset} ${T.fg}${text}${T.reset}`];
    case 'goal':
      return [`${T.pink}${T.bold}[GOAL]${T.reset} ${T.fg}${T.bold}${text}${T.reset}`];
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

export function composerBottomRule(width: number): string {
  const inner = Math.max(0, width - 2);
  return `${T.rule}└${'─'.repeat(inner)}┘${T.reset}`;
}

/** Hint line rendered ABOVE the composer box, left-aligned under the
 *  auto-approve row (user request). Previously lived inside the bottom
 *  border, where it clipped when the input wrapped to the last row. */
export function composerHintRow(hint: string, width: number): string {
  return `${T.grayDark}${hint}${T.reset}`;
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
/** Left margin padding for the transcript. Fills full width on widescreen without center compression. */
export function transcriptIndent(termWidth: number): number {
  return termWidth > 60 ? 2 : 0;
}

// ---- Animated mochi splash screen ------------------------------------------
// Pulsating wave gradient on MOCHI ASCII logo with dynamic sheen sweep,
// and real 0% -> 100% loading animation.

const MOCHI_ASCII = [
  '█▀▄▀█ █▀▀█ █▀▀▀ █  █ ▀█▀',
  '█ ▀ █ █  █ █    █▀▀█  █ ',
  '▀   ▀ ▀▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀',
];

const SPLASH_PALETTES: Array<Array<[number, number, number]>> = [
  // 0: Classic Mochi (magenta-pink -> violet -> cyan -> sky blue -> soft pink)
  [[255, 110, 199], [199, 146, 234], [86, 212, 221], [121, 184, 255], [255, 175, 209]],
  // 1: Golden Sakura (warm amber -> gold -> cherry blossom -> peach)
  [[255, 180, 80], [255, 215, 0], [255, 105, 180], [255, 160, 200], [255, 220, 130]],
  // 2: Cyber Neon (electric cyan -> laser lime -> hot magenta -> violet)
  [[0, 255, 240], [50, 255, 100], [255, 0, 180], [180, 50, 255], [0, 255, 240]],
  // 3: Aurora Borealis (emerald -> teal -> sky blue -> indigo -> mint)
  [[0, 230, 150], [0, 200, 230], [80, 140, 255], [160, 100, 255], [0, 240, 180]],
  // 4: Rainbow Sparkle (flowing rainbow spectrum)
  [[255, 80, 80], [255, 180, 50], [240, 240, 60], [80, 230, 120], [80, 180, 255], [200, 100, 255]],
];

/** Loading progress messages shown under the logo, one per phase. */
export const SPLASH_PHASES = [
  'warming neural fabric + core…',
  'loading skills + session memory…',
  'indexing workspace codegraph…',
  'connecting AI model provider…',
  'The Dongo is ready',
] as const;

/** One frame of the animated splash.
 *  - tick: animation frame counter (drives pulsating wave + sheen sweep)
 *  - progress: 0..1 real startup progress (drives the loading bar & 0-100% text)
 *  - burstMode: optional interactive click burst theme index
 */
export function splashFrame(tick: number, width: number, version: string, progress = 1, burstMode = 0): string[] {
  const logoW = MOCHI_ASCII.reduce((m, l) => Math.max(m, l.length), 0);
  const lines: string[] = [''];
  const center = (s: string, vis?: number) => {
    const v = vis ?? s.replace(/\x1b\[[0-9;]*m/g, '').length;
    return ' '.repeat(Math.max(0, Math.floor((width - v) / 2))) + s;
  };

  const activeTheme = getCurrentTheme();
  const stops = burstMode > 0 ? (SPLASH_PALETTES[burstMode % SPLASH_PALETTES.length] ?? activeTheme.splashStops) : activeTheme.splashStops;
  const pulseSpeed = burstMode > 0 ? 0.35 : 0.22;
  const waveSpeed = burstMode > 0 ? 0.12 : 0.07;

  // Dynamic pulsating wave: the gradient shifts horizontally with `tick`,
  // oscillating with a breathing pulse + bright sweep sheen
  const waveShift = (tick * waveSpeed) % 1;
  const pulse = 0.5 + 0.5 * Math.sin(tick * pulseSpeed); // 0..1 smooth sinusoidal breathing pulse
  const sheenPos = (tick % (logoW + 16)) - 8;

  for (let r = 0; r < MOCHI_ASCII.length; r++) {
    const row = MOCHI_ASCII[r];
    const cells: string[] = [];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ' ') { cells.push(' '); continue; }
      // Interpolate along moving color wave
      const t = (x / Math.max(1, logoW - 1) + waveShift) % 1;
      const numStops = stops.length;
      const scaled = t * (numStops - 1);
      const si = Math.min(numStops - 2, Math.floor(scaled));
      const lt = scaled - si;
      const base = lerp(stops[si], stops[si + 1], lt);

      // Sheen sweep + breathing glow
      const dist = Math.abs(x - sheenPos);
      const glow = dist <= 4 ? 1 - dist / 4 : 0;
      const brightness = Math.min(1, glow * 0.8 + pulse * 0.2);
      const c = lerp(base, [255, 255, 255], brightness);
      cells.push(`${rgb(c[0], c[1], c[2])}${T.bold}${ch}${T.reset}`);
    }
    lines.push(center(cells.join(''), row.length));
  }

  // Subtitle with hairline accents
  lines.push('');
  const sub = `${T.grayDark}──${T.reset} ${T.cyan}autonomous coding agent${T.reset} ${T.grayDark}──${T.reset}`;
  lines.push(center(sub, 29));
  lines.push('');

  // High-tech futuristic segmented cyber energy rail with moving gradient plasma flux
  const barW = Math.min(44, Math.max(20, Math.floor(width * 0.42)));
  const clampedProg = Math.max(0, Math.min(1, progress));
  const filled = Math.round(clampedProg * barW);
  const headPos = Math.max(0, filled - 1);
  const headChar = clampedProg < 1 ? (tick % 4 === 0 ? '◈' : tick % 4 === 1 ? '◆' : tick % 4 === 2 ? '✦' : '━') : '━';

  const barCells: string[] = [];
  for (let x = 0; x < barW; x++) {
    if (x < filled) {
      const frac = barW > 1 ? x / (barW - 1) : 1;
      const numStops = stops.length;
      const scaled = ((frac + waveShift) % 1) * (numStops - 1);
      const si = Math.min(numStops - 2, Math.floor(scaled));
      const cellColor = lerp(stops[si], stops[si + 1], scaled - si);
      if (x === headPos && clampedProg < 1) {
        barCells.push(`${T.bold}${rgb(255, 255, 255)}${headChar}${T.reset}`);
      } else {
        const isPulse = (x + tick) % 6 === 0;
        const pulseColor = isPulse ? lerp(cellColor, [255, 255, 255], 0.6) : cellColor;
        barCells.push(`${rgb(pulseColor[0], pulseColor[1], pulseColor[2])}━${T.reset}`);
      }
    } else {
      barCells.push(`${T.grayDark}─${T.reset}`);
    }
  }

  const bracketColor = clampedProg >= 1 ? T.lime : T.cyan;
  const bar = `${bracketColor}⟦${T.reset} ${barCells.join('')} ${bracketColor}⟧${T.reset}`;
  lines.push(center(bar, barW + 4));

  // Phase text + animated percentage (0% -> 100%)
  const phaseIdx = Math.min(SPLASH_PHASES.length - 1, Math.floor(clampedProg * (SPLASH_PHASES.length - 0.01)));
  const phase = SPLASH_PHASES[phaseIdx];
  const pct = Math.min(100, Math.max(0, Math.round(clampedProg * 100)));
  const spinnerChar = spinnerFrame(tick);
  const statusText = clampedProg >= 1
    ? `${T.lime}${T.bold}● The Dongo is ready${T.reset}`
    : `${T.cyan}${spinnerChar}${T.reset} ${T.gray}${phase}${T.reset}  ${T.pink}${T.bold}[ ${pct}% ]${T.reset}`;
  lines.push(center(statusText, clampedProg >= 1 ? 21 : phase.length + 10 + String(pct).length));

  // Version footer
  lines.push('');
  const ver = `${T.grayDark}mochi v${version}${T.reset}`;
  lines.push(center(ver, 8 + version.length));
  lines.push('');
  return lines;
}

export const SPLASH_TICKS = 14;
