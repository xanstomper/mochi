// Cline/OpenCode-style view layer for the mochi TUI.
//
// Pure rendering functions (no I/O, no terminal) extracted so the look is
// unit-testable: transcript entries (user/assistant/tool/system), the ❯
// input bar with hairline rules, the three-row status bar (model + context
// bar + tokens/cost | Plan/Act | git stats | auto-approve), the slash-command
// autocomplete dropdown, and the braille thinking spinner.
//
// Two color surfaces are exported:
//   T  — palette tokens (raw hex slots from the theme's colors{}). Used by
//        generic surfaces: status bar, gradient bars, splash, autocomplete
//        borders, and any place where the "color harmony" of the palette
//        matters more than a specific role.
//   R  — semantic role colors (assistantGutter, toolWriteName, etc.).
//        Themes override these to genuinely change which color is used for
//        which role, so two themes can have very different tool-name
//        philosophies without sharing the same cyan/violet tokens.
//
// Both T and R are reassigned in place by setTheme() so callers can read
// them without re-importing.
import type { LineKind } from './state.js';

import {
  THEMES, getTheme, getAllThemes, getCurrentTheme, applyTheme, themeSwatch,
  defaultRoleColors, resolveRoleColors, adaptThemeColors,
  type MochiTheme, type RoleColors,
} from './themes.js';

export {
  THEMES, getTheme, getAllThemes, getCurrentTheme, applyTheme, themeSwatch,
  defaultRoleColors, resolveRoleColors, adaptThemeColors,
  type MochiTheme, type RoleColors,
};

// ---- Palette (customizable with 15 handcrafted themes) -------------------
export const T = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  ...adaptThemeColors(getCurrentTheme()).colors,
};

/** Semantic role colors. Initialized from the current theme and refreshed
 *  in place by setTheme(). Use R.assistantGutter, R.toolWriteName, etc.
 *  instead of hardcoded token names so themes can legitimately re-color
 *  roles. T.<token> stays available for generic surfaces that just want
 *  the palette. */
export const R: RoleColors = resolveRoleColors(adaptThemeColors(getCurrentTheme()));

/** Switch active theme dynamically. Updates T (palette) AND R (role colors)
 *  in place so any code that has a reference to either sees the new theme
 *  immediately without re-importing. */
export function setTheme(themeId: string): MochiTheme {
  const t = adaptThemeColors(applyTheme(themeId));
  Object.assign(T, t.colors);
  Object.assign(R, resolveRoleColors(t));
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
  return `${spinnerColored(frame)} ${R.thinkingLabel}Thinking…${T.reset} ${spinnerSweep(frame, 8)}${note_} ${T.grayDark}(esc to cancel)${T.reset}`;
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
    ? ` ${(R.reasonBadge as any)[m.reasoningLevel] ?? R.reasoningBadge}${T.bold}[REASON: ${m.reasoningLevel.toUpperCase()}]${T.reset}`
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

/** Color-coordinate tool names by verb group, so a transcript scan shows
 *  what the agent is DOING at a glance. The mapped string is now a key into
 *  R (semantic role colors) instead of T (palette tokens), so themes can
 *  legitimately recolor write tools (Tokyo Night makes them yellow, Dracula
 *  makes them red, etc.) without breaking the meaning of "write=mutating". */
const TOOL_ACCENTS: Array<[RegExp, keyof RoleColors]> = [
  [/^(write|edit|delete|patch|replace_symbol|search_replace_multi)\b/, 'toolWriteName'],
  [/^(read|search|glob|inspect|tree|fetch|deepwiki|clipboard)\b/, 'toolReadName'],
  [/^(shell|git)\b/, 'toolShellName'],
  [/^(verify|perf|test)\b/, 'toolTestName'],
  [/^(memory|skill|subagent|chameleon|analyze_code|sql_codebase_query)\b/, 'toolGenericName'],
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
  const color = ratio < 0.6 ? R.contextLow : ratio < 0.85 ? R.contextMid : R.contextHigh;
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
    return `${R.errorMark}${T.bold}[ERR]${T.reset} ${R.errorText}${rest}${T.reset}`;
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
    let color: keyof RoleColors = 'toolGenericName';
    for (const [re, c] of TOOL_ACCENTS) {
      if (re.test(name)) { color = c; break; }
    }
    const coloredName = `${R[color]}${T.bold}${name}${T.reset}:`;
    if (name === 'shell' || name === 'git') {
      return `${coloredName} ${highlightShellCommand(rest.trimStart())}`;
    }
    return `${coloredName}${R.assistantText}${rest}${T.reset}`;
  }
  const name = text.split(/[(:\s]/)[0] ?? '';
  for (const [re, color] of TOOL_ACCENTS) {
    if (re.test(name)) return `${R[color]}${name}${T.reset}${T.grayDark}${text.slice(name.length)}${T.reset}`;
  }
  return `${R.toolGenericName}${name}${T.reset}${T.grayDark}${text.slice(name.length)}${T.reset}`;
}

export function formatInlineMarkdown(text: string): string {
  // Inline markdown: bold, inline code, italic — emit ONE clean SGR per
  // token so a downstream ANSI-aware wrap never breaks colors mid-line.
  // Replacements work in priority order: code first (so `**foo**` inside
  // backticks isn't re-bolded), then bold, then italic.
  const BASE = R.assistantText;
  // 1. Inline code: protect contents from later replacements by stashing
  // them in a token map, then restore the colored token at the end.
  const codeTokens: string[] = [];
  const codePlaceholder = (raw: string) => {
    const token = `${R.codeType}${T.bold}${raw}${T.reset}${BASE}`;
    codeTokens.push(token);
    return ` CODE${codeTokens.length - 1} `;
  };
  let s = text.replace(/`([^`\n]+)`/g, (_m, inner) => codePlaceholder(String(inner)));
  // 2. Bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, `${T.bold}${R.mdBold}$1${T.reset}${BASE}`);
  // 3. Italic (single *…*, not preceded/followed by *)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre, inner) => `${pre}${T.italic}${R.mdItalic}${inner}${T.reset}${BASE}`);
  // 4. Restore code tokens
  s = s.replace(/ CODE(\d+) /g, (_m, i) => codeTokens[Number(i)] ?? '');
  // Wrap with assistant foreground + reset so a downstream wrap that
  // splits the line lands back in the base color without bleeding.
  return `${BASE}${s}${T.reset}`;
}

function highlightCodeLine(line: string): string {
  // Syntax highlight using semantically-coordinated role colors. Each
  // token emits a single SGR so a downstream wrap that splits the line
  // resumes the base color cleanly at the next row.
  const BASE = R.assistantText;
  let s = line;
  // Order matters: comments first (so a // string isn't re-stringed),
  // then strings (so a string containing "if" isn't re-keyworded).
  s = s.replace(/(\/\/[^\n]*)/g, `${R.codeComment}$1${T.reset}`);
  s = s.replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*?\1/g, (m) => `${R.codeString}${m}${T.reset}`);
  s = s.replace(/\b(const|let|var|function|return|import|export|from|class|extends|interface|type|async|await|if|else|switch|case|break|for|while|try|catch|throw|finally|new|typeof|instanceof|in|of|do|continue|delete)\b/g, (m) => `${R.codeKeyword}${m}${T.reset}`);
  s = s.replace(/\b(string|number|boolean|void|any|unknown|never|null|undefined|Promise|Array|Record|Set|Map|Object|Function|true|false)\b/g, (m) => `${R.codeType}${m}${T.reset}`);
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, (m) => `${R.codeNumber}${m}${T.reset}`);
  s = s.replace(/\b([a-zA-Z_$][\w$]*)(?=\s*\()/g, (m) => `${R.codeFn}${m}${T.reset}`);
  s = s.replace(/([{}();,<>[\]=+\-*/%!&|?:])/g, `${R.codePunct}$1${T.reset}`);
  return `${BASE}${s}${T.reset}`;
}

/**
 * Compact terminal markdown renderer. Produces tight Cline/Claude-style
 * output: paragraphs collapsed to one logical line each, no extra blank
 * between sentences, headings stripped of the `##` sigil, bullets on a
 * consistent 2-space indent, code fences without box borders, and a
 * unified color baseline so wrap-and-resume keeps the right role color.
 */
export function renderMarkdown(text: string): string[] {
  const rawLines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let paragraph: string[] = [];
  let bulletNum = 0; // auto-number for consecutive "-"/*"/+" bullets

  const flushParagraph = () => {
    if (!paragraph.length) return;
    // Join soft-wrapped source lines into one paragraph, collapse runs
    // of whitespace, then re-emit as a single colored line. The TUI's
    // downstream wrapAnsi() handles viewport-width rewrap without any
    // extra blank rows between sentences.
    const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    paragraph = [];
    if (!joined) return;
    bulletNum = 0; // a paragraph break restarts bullet numbering
    out.push(formatInlineMarkdown(joined));
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    // Fenced code blocks: tight list of highlighted rows, no box border.
    // The opening fence is the only "header" row; the closing fence is
    // a single subtle hairline so the user can see the block end.
    if (trimmed.startsWith('```')) {
      flushParagraph();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        const tag = codeBlockLang ? `${R.codeType}${codeBlockLang}${T.reset}` : `${T.grayDark}code${T.reset}`;
        out.push(`${T.grayDark}  ─ ${tag}${T.reset}`);
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
        out.push(`${T.grayDark}  ─${T.reset}`);
      }
      continue;
    }

    if (inCodeBlock) {
      // 2-space indent matches everything else on the transcript grid.
      out.push(`  ${highlightCodeLine(raw)}`);
      continue;
    }

    // Blank line → paragraph boundary.
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    // Markdown headers — strip the `##`/`#` sigil so the rendered output
    // does NOT print it literally (the prior version prefixed the heading
    // text with "## " again, producing "## ## Next steps" in the
    // transcript). The visual hierarchy comes from color + bold, plus
    // a tight hairline below the heading.
    const hMatch = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (hMatch) {
      flushParagraph();
      const headingText = hMatch[2];
      out.push(`${R.mdHeading}${T.bold}${headingText}${T.reset}`);
      out.push(`${R.mdHeading}  ${'─'.repeat(Math.max(8, Math.min(40, headingText.length * 2)))}${T.reset}`);
      continue;
    }

    // Horizontal divider.
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      out.push(`${T.grayDark}${'─'.repeat(40)}${T.reset}`);
      continue;
    }

    // Blockquote.
    if (trimmed.startsWith('> ') || trimmed === '>') {
      flushParagraph();
      out.push(`${T.grayDark}│ ${T.reset}${formatInlineMarkdown(trimmed.replace(/^>\s?/, ''))}`);
      continue;
    }

    // Unordered bullet — rendered as an orange auto-number on the same
    // 2-space grid as numbered lists (no blue bullet glyphs; lists always
    // number, matching the orange numbered-list treatment).
    if (/^[\*\-\+]\s+/.test(trimmed)) {
      flushParagraph();
      bulletNum += 1;
      const content = trimmed.replace(/^[\*\-\+]\s+/, '');
      out.push(`${R.codeNumber}  ${bulletNum}.${T.reset} ${formatInlineMarkdown(content)}`);
      continue;
    }
    bulletNum = 0;
    // Numbered list — same 2-space grid, orange numbers.
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      flushParagraph();
      out.push(`${R.codeNumber}  ${numMatch[1]}.${T.reset} ${formatInlineMarkdown(numMatch[2])}`);
      continue;
    }

    // Standard paragraph: accumulate and emit on next blank / EOF.
    paragraph.push(raw);
  }
  flushParagraph();
  return out;
}

/** Render one transcript entry with mochi color coordination. */
export function renderEntry(entry: RenderEntry, expandTools = false): string[] {
  const text = entry.text;
  if (!text.trim()) return [];
  // Coordinated visual language: every transcript line carries a 2-space
  // left gutter + a single-character kind marker, so the eye can scan by
  // column and the terminal stays on a readable grid regardless of width.
  // The kind marker is colored with the theme's role accent so colors stay
  // semantically coordinated across all 15 themes.
  switch (entry.kind) {
    case 'user':
      // Background-highlighted user input (left gutter through end of text).
      return [`  ${R.userGutter}${T.bold}❯${T.reset} ${R.userBg}${R.userFg}${T.bold}${text}${T.reset}`];
    case 'assistant':
      // Terminal prose — no per-line gutters, markdown only.
      return renderMarkdown(text);
    case 'thought':
      // Internal reasoning rendered as plain dim italic prose, no glyph spam.
      return text.split('\n').filter((l) => l.trim()).map((l) => `  ${T.dim}${T.italic}${T.gray}${l}${T.reset}`);
    case 'tool':
      // Compact tool rows already include their own semantic glyph from cards.ts
      return text.split('\n').map((l) => `  ${l}`);
    case 'error': {
      const rest = text.startsWith('[ERR] ') ? text.slice(6) : text.replace(/^✗\s*/, '');
      return [`  ${R.errorMark}${T.bold}! [ERR]${T.reset} ${R.errorText}${rest}${T.reset}`];
    }
    case 'system':
      return text.split('\n').map((l) => `  ${R.systemMark}◆ ${T.reset}${R.systemText}${l}${T.reset}`);
    case 'task':
      return [`  ${R.taskMark}${T.bold}★ [TASK]${T.reset} ${R.taskText}${text}${T.reset}`];
    case 'goal':
      return [`  ${R.goalMark}${T.bold}◉ [GOAL]${T.reset} ${R.goalText}${T.bold}${text}${T.reset}`];
    default:
      return [`  ${text}`];
  }
}

/**
 * Render a thin hairline separator between user→assistant turns. Use this
 * between turns to visually segment the transcript on the grid. Optional —
 * calls renderEntry do NOT emit this automatically (kept composable).
 */
export function turnRule(width: number, accent: string = T.rule): string {
  const w = Math.max(0, Math.floor(width / 2));
  return `  ${accent}${'─'.repeat(w)}${T.reset}`;
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

// ---- Autocomplete dropdown (opencode-style scrolling command palette) -------
export interface DropdownItem {
  name: string;
  hint: string;
}

/** Render the slash-command dropdown as an opencode floating panel:
 *  no border glyphs — a solid panelBg block on the backdrop, peach selection
 *  bar (text near-black on it), white command names, gray hints, bold title
 *  with `esc` right-aligned. The CALLER owns the scroll window. */
export function renderDropdown(
  items: DropdownItem[],
  selected: number,
  width: number,
  viewport = 8,
  scrollOffset = 0,
): { rows: string[]; indexMap: number[] } {
  if (!items.length) return { rows: [], indexMap: [] };
  const w = Math.min(Math.max(width, 40), 72);
  const out: string[] = [];
  const indexMap: number[] = [];
  const maxVisible = Math.min(items.length, Math.max(3, viewport));

  const maxOffset = Math.max(0, items.length - maxVisible);
  const offset = Math.max(0, Math.min(maxOffset, Math.min(scrollOffset, selected - Math.floor(maxVisible / 2) < 0 ? 0 : selected - Math.floor(maxVisible / 2) > maxOffset ? maxOffset : selected - Math.floor(maxVisible / 2))));
  const P = T.panelBg;    // panel background (theme-derived, blends with bg)
  const bar = T.actBg;    // selection bar
  const onBar = T.bgText; // text on the bar (dark)
  const white = '\x1b[38;2;238;238;238m';
  const dim = '\x1b[38;2;128;128;128m';

  // Header row: bold "Commands" title, dim "esc" right-aligned — on panel bg.
  const headTitle = 'Commands';
  const headEsc = 'esc';
  const headGap = Math.max(1, w - 4 - headTitle.length - headEsc.length - 2);
  out.push(`${P}  ${T.bold}${white}${headTitle}${T.reset}${P}${' '.repeat(headGap)}${dim}${headEsc}${T.reset}${P}  ${T.reset}`);

  for (let i = 0; i < maxVisible; i++) {
    const itemIdx = offset + i;
    const it = items[itemIdx];
    if (!it) break;
    indexMap.push(itemIdx);
    const sel = itemIdx === selected;
    const name = padEnd(it.name, 12);
    const hint = ellipsize(it.hint, Math.max(0, w - 8 - 12 - 2));
    const pad = Math.max(0, w - 6 - 12 - visibleLen(hint));
    if (sel) {
      // Full-width accent bar, near-black text — bleeds 1 cell over the
      // panel edge on each side (opencode's bar is wider than text rows).
      out.push(` ${bar}${onBar} ${name}  ${hint}${' '.repeat(pad)} ${bar}${T.reset}`);
    } else {
      out.push(`${P}  ${white}${name}${T.reset}${P}  ${dim}${hint}${T.reset}${P}${' '.repeat(pad)}  ${T.reset}`);
    }
  }

  // Footer row: dim scroll state left, dim count right — on panel bg.
  const hasAbove = offset > 0;
  const hasBelow = offset + maxVisible < items.length;
  const scrollState = hasAbove && hasBelow ? '↑↓' : hasAbove ? '↑' : hasBelow ? '↓' : '';
  const count = `${items.length} commands`;
  const footGap = Math.max(1, w - 4 - scrollState.length - count.length - 2);
  out.push(`${P}  ${dim}${scrollState}${T.reset}${P}${' '.repeat(footGap)}${dim}${count}${T.reset}${P}  ${T.reset}`);
  return { rows: out, indexMap };
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
