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
import { wrap } from './wrap.js'; // visibleLen is local (line ~84)

import {
  THEMES, getTheme, getAllThemes, getCurrentTheme, applyTheme, themeSwatch,
  defaultRoleColors, resolveRoleColors, adaptThemeColors, parseThemeRgb,
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
 *  immediately without re-importing. Paint-only: NEVER persists (persistence
 *  is an explicit user action via applyTheme — auto-persisting here once
 *  cemented a stale fallback over the user's real theme files). */
export function setTheme(themeId: string): MochiTheme {
  const found = getTheme(themeId);
  if (!found) return getCurrentTheme();
  const t = adaptThemeColors(found);
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

// ---- Shared helpers --------------------------------------------------------
// Cell-aware ANSI/width primitives live in wrap.ts (single source of truth —
// CJK wide chars count 2 cells, emoji 2, combining marks 0, full CSI stripped).
import { stripAnsi, visibleLen, visibleCells, cellWidth, sliceCells } from './wrap.js';
export { stripAnsi, visibleLen, visibleCells, cellWidth, sliceCells };

/** Truncate with ellipsis on a visible-cell budget, preserving ANSI color codes
 *  and never splitting a surrogate pair or wide character. */
export function ellipsize(s: string, max: number): string {
  // Zero (or negative) budget means zero cells: emit nothing, not a 1-cell
  // ellipsis that would overflow its row (narrow dropdowns/menus hit this).
  if (max <= 0) return '';
  if (visibleLen(s) <= max) return s;
  return sliceCells(s, Math.max(0, max - 1)).text + '\x1b[0m…';
}

export function padEnd(s: string, n: number): string {
  const vis = visibleLen(s);
  if (vis >= n) return ellipsize(s, n);
  return s + ' '.repeat(n - vis);
}

// ---- Thinking spinner (OpenCode braille spinner) ---------------------------
// Classic OpenCode/OpenTUI braille spinner ('⠋', '⠙', '⠹', ...) with smooth
// theme-native harmonic breathing glow. Clean, lightweight, professional.
const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerFrame(i: number): string {
  return DOTS[Math.abs(i) % DOTS.length];
}

export function sparkleFrame(i: number): string {
  const stars = ['★', '✶', '✷', '✸', '✹', '✸', '✷', '✶'];
  return stars[Math.abs(i) % stars.length];
}

/**
 * Resolves harmonic color stops tailored to the active theme.
 * Extracts bright stops from the theme's handcrafted splashStops (ignoring dark backgrounds),
 * or falls back to theme role tokens, and mirrors them into a smooth breathing wave.
 */
export function getThemeSpinnerColors(): Array<[number, number, number]> {
  const theme = getCurrentTheme();
  const rawStops = (theme.splashStops ?? []).filter(([r, g, b]) => (r + g + b) > 100);
  if (rawStops.length >= 2) {
    return [...rawStops, ...rawStops.slice(1, -1).reverse()];
  }
  const actRgb = parseThemeRgb(T.act, 38) ?? [167, 139, 250];
  const secRgb = parseThemeRgb(T.violet ?? T.cyan ?? T.pink, 38) ?? [139, 92, 246];
  return [secRgb, actRgb, [248, 248, 255], actRgb];
}

/**
 * OpenCode-style colored braille spinner:
 * Renders the rotating braille dot with smooth theme color breathing.
 */
export function spinnerColored(i: number): string {
  const dot = spinnerFrame(i);
  const stops = getThemeSpinnerColors();
  const c = stops[Math.abs(i) % stops.length];
  return `${rgb(c[0], c[1], c[2])}${T.bold}${dot}${T.reset}`;
}

/**
 * Resolves the active verb based on current tool execution and task intent.
 * Distinct states:
 * - 'Searching': search, read, glob, grep, find, web_search, inspect, etc.
 * - 'Working': write, edit, patch, shell, exec, verify, format, etc.
 * - 'Thinking': model generation, planning, reasoning, think tool.
 * - 'Done': task completed.
 */
export function resolveVerb(tool = '', task = ''): 'Thinking' | 'Working' | 'Searching' | 'Done' {
  if (!tool) {
    if (/\b(search|find|grep|look\s+for|lookup)\b/i.test(task)) return 'Searching';
    if (/\b(build|compile|test|write|edit|fix|patch)\b/i.test(task)) return 'Working';
    return 'Thinking';
  }
  const t = tool.toLowerCase().replace(/[-_]/g, '');
  if (
    t.includes('search') ||
    t.includes('glob') ||
    t.includes('grep') ||
    t.includes('find') ||
    t.includes('read') ||
    t.includes('inspect') ||
    t.includes('tree') ||
    t.includes('outline') ||
    t.includes('ast') ||
    t.includes('crawl') ||
    t.includes('codegraph') ||
    t.includes('codebasemap') ||
    t.includes('symbol') ||
    t.includes('fuzzy') ||
    t.includes('fetch')
  ) {
    return 'Searching';
  }
  if (t === 'think' || t.includes('thinking')) {
    return 'Thinking';
  }
  return 'Working';
}

/**
 * Animated moving ellipsis dots (.  -> ..  -> ...)
 * Exactly 3 characters wide on all frames to eliminate horizontal wiggling/jitter.
 */
export function movingDots(frame: number): string {
  const dotCycle = Math.floor(Math.abs(frame) / 4) % 3;
  return dotCycle === 0 ? '.  ' : dotCycle === 1 ? '.. ' : '...';
}

export function doneLine(elapsed?: string | number, note = ''): string {
  const note_ = note ? ` ${T.grayDark}·${T.reset} ${T.cyan}${note}${T.reset}` : '';
  const time_ = elapsed !== undefined && elapsed !== '' ? ` ${T.grayDark}·${T.reset} ${T.gray}${elapsed}${T.reset}` : '';
  return `${T.lime}${T.bold}✓${T.reset} ${T.lime}${T.bold}Done${T.reset}${note_}${time_}`;
}

export function thinkingLine(
  frame: number,
  note = '',
  elapsed?: string | number,
  verb: 'Thinking' | 'Working' | 'Searching' | 'Done' | string = 'Thinking',
): string {
  if (verb === 'Done') {
    return doneLine(elapsed, note);
  }
  const note_ = note ? ` ${T.grayDark}·${T.reset} ${T.cyan}${note}${T.reset}` : '';
  const time_ = elapsed !== undefined && elapsed !== '' ? ` ${T.grayDark}·${T.reset} ${T.gray}${elapsed}${T.reset}` : '';
  const dots = movingDots(frame);

  let verbColor = R.thinkingLabel || T.act;
  if (verb === 'Searching') verbColor = T.cyan ?? T.act;
  else if (verb === 'Working') verbColor = T.pink ?? T.violet ?? T.act;

  const verbGlow = `${verbColor}${T.bold}${verb}${dots}${T.reset}`;
  return `${spinnerColored(frame)} ${verbGlow}${note_}${time_} ${T.grayDark}(esc to cancel)${T.reset}`;
}

export interface TaskStepItem {
  id?: string;
  title: string;
  status: string; // 'pending' | 'running' | 'completed' | 'failed' | 'done'
}

/**
 * Borderless cyber progress stepper for multi-step autonomous plans.
 * e.g. ·✦· [1/3 ✓ Audit] ── [2/3 ✦ Patch view.ts] ── [3/3 ○ Run Tests]
 */
export function renderTaskStepper(tasks: TaskStepItem[], width: number): string {
  if (!tasks.length) return '';
  const total = tasks.length;
  const parts: string[] = [];

  for (let i = 0; i < total; i++) {
    const t = tasks[i];
    let icon = '○';
    let color = T.grayDark;
    if (t.status === 'completed' || t.status === 'done') {
      icon = '✓';
      color = T.lime;
    } else if (t.status === 'running') {
      icon = '✦';
      color = T.act;
    } else if (t.status === 'failed' || t.status === 'error') {
      icon = '✗';
      color = T.error;
    }

    const num = width < 42 ? `${i + 1}` : `${i + 1}/${total}`;
    const maxTitleLen = Math.max(4, Math.floor((width - 20) / total));
    const shortTitle = t.title ? ellipsize(t.title, maxTitleLen) : '';
    const label = width >= 64 && shortTitle ? ` ${shortTitle}` : '';
    parts.push(`${color}[${num} ${icon}${label}]${T.reset}`);
  }

  const connector = width < 50 ? `${T.grayDark}─${T.reset}` : `${T.grayDark} ── ${T.reset}`;
  const rail = parts.join(connector);
  const prefix = width < 48 ? '' : `${T.act}·✦·${T.reset} `;
  const out = `${prefix}${rail}`;
  return visibleLen(out) > width ? ellipsize(out, width) : out;
}

/** Empty-track color for gauge bars: near-black fixed RGB, deliberately NOT a
 *  theme token. Theme grayDark renders as a VISIBLE gray bar (12+10+6 gray
 *  blocks at idle) — the "grey bars" defect. This fixed dim track reads as
 *  empty on black canvases and as a subtle rail on light ones. */
const TRACK = '\x1b[38;2;58;54;70m';

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
      cells.push(`${TRACK}░${T.reset}`);
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
      cells.push(`${TRACK}▪${T.reset}`);
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
  tokenVelocity?: number;
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

/** Row 1: model + [REASON: LEVEL] + [mode] + context … plan/act toggle */
export function statusBarRow1(m: StatusBarModel, width: number): string {
  const fullToggle = `${m.mode === 'plan' ? `${T.plan}● Plan` : `${T.act}● Act`}${T.reset}`;
  const compactToggle = `${m.mode === 'plan' ? `${T.plan}● Plan` : `${T.act}● Act`}${T.reset} ${T.grayDark}(Tab)${T.reset}`;
  const miniToggle = `${m.mode === 'plan' ? `${T.plan}● P` : `${T.act}● A`}${T.reset}`;

  const toggle = width >= 78 ? fullToggle : width >= 56 ? compactToggle : miniToggle;

  // Level-keyed badge color with a safe fallback: an unknown level name can
  // never print `[object Object]` (the old `?? R.reasonBadge` fallback did
  // exactly that when the key missed, since reasonBadge is an object).
  const badgeFor = (lvl: string): string => {
    const hit = (R.reasonBadge as Record<string, string | undefined>)[lvl.toLowerCase()];
    return typeof hit === 'string' ? hit : R.reasoningBadge;
  };
  const reasoningBadge = m.reasoningLevel
    ? width >= 70
      ? ` ${badgeFor(m.reasoningLevel)}${T.bold}[REASON: ${m.reasoningLevel.toUpperCase()}]${T.reset}`
      : width >= 48
        ? ` ${badgeFor(m.reasoningLevel)}${T.bold}[${m.reasoningLevel.toUpperCase()}]${T.reset}`
        : ''
    : '';

  const velocityBadge = (m.tokenVelocity && m.tokenVelocity > 0 && width >= 54)
    ? ` ${T.warning}${Math.round(m.tokenVelocity)} t/s ▲${T.reset}`
    : '';

  const modeBadge = m.agentMode && m.agentMode !== 'normal'
    ? width >= 48
      ? ` ${modeColor(m.agentMode)}${T.bold}[${m.agentMode.toUpperCase()}]${T.reset}`
      : ` ${modeColor(m.agentMode)}${T.bold}[${m.agentMode[0].toUpperCase()}]${T.reset}`
    : '';

  const bar = m.maxInputTokens ? contextBar(m.totalTokens, m.maxInputTokens) : undefined;
  const usage = usageText(m.totalTokens, m.totalCost);

  let barText = '';
  if (width >= 82) {
    barText = bar
      ? ` ${T.fg}${bar.filled}${TRACK}${bar.empty}${T.reset} ${T.gray}${usage}${T.reset}`
      : ` ${T.gray}${usage}${T.reset}`;
  } else if (width >= 62) {
    const shortUsage = m.totalTokens >= 1000 ? `${(m.totalTokens / 1000).toFixed(1)}k tok` : `${m.totalTokens} tok`;
    barText = bar
      ? ` ${T.fg}${bar.filled.slice(0, 4)}${TRACK}${bar.empty.slice(0, 4)}${T.reset} ${T.gray}${shortUsage}${T.reset}`
      : ` ${T.gray}${shortUsage}${T.reset}`;
  } else if (width >= 46) {
    const shortTokens = m.totalTokens >= 1000 ? `${(m.totalTokens / 1000).toFixed(1)}k` : `${m.totalTokens}`;
    barText = ` ${T.gray}${shortTokens}${T.reset}`;
  }

  const extra = m.extra?.length && width >= 90 ? ` ${T.grayDark}· ${m.extra.join(' · ')}${T.reset}` : '';

  const togglePart = toggle ? `  ${toggle}` : '';
  const togglePartLen = visibleLen(togglePart);
  const fixedLen = visibleLen(reasoningBadge) + visibleLen(velocityBadge) + visibleLen(modeBadge) + visibleLen(barText) + togglePartLen + visibleLen(extra);
  const availForModel = Math.max(4, width - fixedLen);
  const modelMax = Math.min(28, availForModel);
  const modelText = `${T.fg}${T.bold}${ellipsize(m.modelId, modelMax)}${T.reset}`;

  // Plan/act toggle sits directly beside the token usage/bar on the left, not right-padded.
  let line = `${modelText}${velocityBadge}${reasoningBadge}${modeBadge}${barText}${togglePart}${extra}`;
  if (visibleLen(line) > width) {
    line = `${modelText}${velocityBadge}${reasoningBadge}${modeBadge}${barText}${togglePart}`;
    if (visibleLen(line) > width) {
      line = `${modelText}${reasoningBadge}${modeBadge}${barText}${togglePart}`;
      if (visibleLen(line) > width) {
        line = `${modelText}${modeBadge}${barText}${togglePart}`;
        if (visibleLen(line) > width) {
          line = `${modelText}${barText}${togglePart}`;
          if (visibleLen(line) > width) {
            line = `${modelText}${togglePart}`;
            if (visibleLen(line) > width) {
              line = `${ellipsize(modelText, Math.max(4, width - togglePartLen))}${togglePart}`;
            }
          }
        }
      }
    }
  }

  return padEnd(visibleLen(line) > width ? ellipsize(line, width) : line, width);
}

/** Row 2: workspace (branch) | auto-approve | N files +X -Y */
export function statusBarRow2(m: StatusBarModel, width: number): string {
  const hasDiff = m.gitDiff && m.gitDiff.files > 0;
  const fmtDiff = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'm' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  
  let suffix = '';
  if (hasDiff) {
    if (width >= 82) {
      suffix = ` ${T.grayDark}|${T.reset} ${T.gray}${m.gitDiff!.files} file${m.gitDiff!.files !== 1 ? 's' : ''}${T.reset} ${T.success}+${m.gitDiff!.additions}${T.reset} ${T.error}-${m.gitDiff!.deletions}${T.reset}`;
    } else if (width >= 62) {
      suffix = ` ${T.grayDark}|${T.reset} ${T.gray}${m.gitDiff!.files}f${T.reset} ${T.success}+${fmtDiff(m.gitDiff!.additions)}${T.reset} ${T.error}-${fmtDiff(m.gitDiff!.deletions)}${T.reset}`;
    } else if (width >= 46) {
      suffix = ` ${T.grayDark}|${T.reset} ${T.success}+${fmtDiff(m.gitDiff!.additions)}${T.reset} ${T.error}-${fmtDiff(m.gitDiff!.deletions)}${T.reset}`;
    } else {
      suffix = ` ${T.success}+${fmtDiff(m.gitDiff!.additions)}${T.reset}`;
    }
  }

  let autoApproveText = '';
  if (width >= 88) {
    autoApproveText = m.autoApprove
      ? `${T.success}Auto improve: ON${T.reset} ${T.grayDark}(Shift+Tab to toggle)${T.reset}`
      : `${T.gray}Auto improve: OFF${T.reset} ${T.grayDark}(Shift+Tab to toggle)${T.reset}`;
  } else if (width >= 65) {
    autoApproveText = m.autoApprove
      ? `${T.success}Auto: ON${T.reset} ${T.grayDark}(Shift+Tab)${T.reset}`
      : `${T.gray}Auto: OFF${T.reset} ${T.grayDark}(Shift+Tab)${T.reset}`;
  } else if (width >= 48) {
    autoApproveText = m.autoApprove
      ? `${T.success}Auto: ON${T.reset}`
      : `${T.gray}Auto: OFF${T.reset}`;
  }

  const middle = autoApproveText ? ` ${T.grayDark}·${T.reset} ${autoApproveText}` : '';
  const path = m.workspaceName + (m.gitBranch ? ` (${m.gitBranch})` : '');
  const pathAvail = Math.max(4, width - visibleLen(middle) - visibleLen(suffix) - 1);
  let shownPath = ellipsize(path, pathAvail);
  let activeMiddle = middle;

  if (visibleLen(shownPath) + visibleLen(activeMiddle) + visibleLen(suffix) > width) {
    activeMiddle = '';
    const newPathAvail = Math.max(4, width - visibleLen(suffix) - 1);
    shownPath = ellipsize(path, newPathAvail);
  }

  const combined = `${T.fg}${shownPath}${T.reset}${activeMiddle}${suffix}`;
  return padEnd(visibleLen(combined) > width ? ellipsize(combined, width) : combined, width);
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
  const bar = `${color}${'█'.repeat(filled)}${TRACK}${'░'.repeat(empty)}${T.reset}`;
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
  // Inline markdown: code, links, bold, italic — emit ONE clean SGR per token
  // so a downstream ANSI-aware wrap never breaks colors mid-line. Priority
  // order matters: code first (so `**foo**` inside backticks isn't re-bulded),
  // then links, then bold, then italic. Code AND links share one placeholder
  // stash (null-byte tokens) so neither is re-processed by later passes.
  const BASE = R.assistantText;
  const stash: string[] = [];
  const stashToken = (rendered: string): string => {
    stash.push(rendered);
    return `\u0000T${stash.length - 1}\u0000`;
  };
  // 1. Inline code → colored token (protected from later passes).
  let s = text.replace(/`([^`\n]+)`/g, (_m, inner: string) =>
    stashToken(`${R.codeType}${T.bold}${inner}${T.reset}${BASE}`));
  // 2. Links [label](url) → underlined label + dimmed url. The `[..](..)`
  //    sigils never print (Cline-style clean label, URL kept beside it).
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, label: string, url: string) =>
    stashToken(`${R.mdLink}${T.underline}${label}${T.reset}${T.grayDark} → ${url}${T.reset}${BASE}`));
  // 3. Bold.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, `${T.bold}${R.mdBold}$1${T.reset}${BASE}`);
  // 4. Italic (single *…*, not adjacent to another *).
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, inner: string) =>
    `${pre}${T.italic}${R.mdItalic}${inner}${T.reset}${BASE}`);
  // 5. Restore stashed tokens.
  s = s.replace(/\u0000T(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? '');
  // Wrap with assistant foreground + reset so a downstream wrap that
  // splits the line lands back in the base color without bleeding.
  return `${BASE}${s}${T.reset}`;
}

// Syntax highlight using semantically-coordinated role colors. Each
// token emits a single SGR so a downstream wrap that splits the line
// resumes the base color cleanly at the next row.
//
// SINGLE-PASS tokenizer (one combined regex, one replace call). The old
// code ran 7 sequential passes, and later passes matched INSIDE escape
// sequences emitted by earlier ones — e.g. the number pass re-wrapped the
// `38`, `2`, `216`… inside `\x1b[38;2;216;180;254m`, orphaning the `\x1b[`
// intro and printing SGR parameters as literal text (plus phantom width
// that broke every row after it). One pass can never re-scan its output.
//
// LANGUAGE-AWARE (Wave S3): the fence tag selects a profile. Previously
// every fence used the JS profile, so Python `#` comments and `def`/`None`
// rendered flat and shell scripts got no comment colour at all. Profiles:
// python/shell ('#' comments + their own keywords), rust, go, json
// (strings/numbers/constants only), an explicit text/plain fence gets NO
// highlighting (prose fenced as text used to sprout spurious keyword
// colour). Unknown/untagged fences keep the JS-flavoured default — an
// untagged fence in model output is usually code.
interface CodeProfile {
  comment: string | null; // line-comment prefix; null = none
  keywords: string;       // regex alternation, '' = none
  types: string;          // regex alternation, '' = none
  variable?: boolean;     // highlight $var tokens (shell)
}
const CODE_PROFILES: Record<string, CodeProfile> = {
  clike: {
    comment: '//',
    keywords: 'const|let|var|function|return|import|export|from|class|extends|interface|type|async|await|if|else|switch|case|break|for|while|try|catch|throw|finally|new|typeof|instanceof|in|of|do|continue|delete',
    types: 'string|number|boolean|void|any|unknown|never|null|undefined|Promise|Array|Record|Set|Map|Object|Function|true|false',
  },
  python: {
    comment: '#',
    keywords: 'def|return|if|elif|else|for|while|import|from|as|class|try|except|finally|with|lambda|pass|raise|yield|async|await|in|is|not|and|or|del|global|nonlocal|assert|break|continue',
    types: 'None|True|False|self|cls|print|len|range|str|int|float|bool|list|dict|set|tuple|type|object|super|enumerate|zip|isinstance|getattr|setattr|hasattr|Exception|ValueError|TypeError|KeyError|RuntimeError|IndexError',
  },
  shell: {
    comment: '#',
    keywords: 'if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|select',
    types: 'echo|cd|export|local|readonly|declare|source|eval|exec|exit|return|shift|set|unset|printf|read|trap|test|alias|unalias|pushd|popd|jobs|fg|bg|kill|wait|sudo|mkdir|rm|cp|mv|cat|grep|sed|awk|find|xargs|curl|wget|chmod|chown|tar|git|npm|node',
    variable: true,
  },
  rust: {
    comment: '//',
    keywords: 'fn|let|mut|pub|struct|enum|impl|trait|for|in|if|else|match|return|use|mod|const|static|type|where|async|await|move|ref|dyn|crate|loop|while|break|continue|as|extern|unsafe',
    types: 'Self|self|true|false|None|Some|Ok|Err|Vec|String|str|bool|char|i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|Option|Result|Box|Iterator',
  },
  go: {
    comment: '//',
    keywords: 'func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|break|continue|import|package|select|fallthrough|goto',
    types: 'nil|true|false|iota|string|bool|byte|rune|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|float32|float64|error|any|make|new|len|cap|append|copy|close|delete|panic|recover|print|println',
  },
  json: { comment: null, keywords: '', types: 'true|false|null' },
  none: { comment: null, keywords: '', types: '' },
};
function codeProfileFor(lang: string): CodeProfile {
  switch (lang.trim().toLowerCase()) {
    case 'py': case 'python': case 'python3': return CODE_PROFILES.python;
    case 'bash': case 'sh': case 'zsh': case 'shell': case 'console': return CODE_PROFILES.shell;
    case 'rs': case 'rust': return CODE_PROFILES.rust;
    case 'go': case 'golang': return CODE_PROFILES.go;
    case 'json': case 'jsonc': case 'json5': return CODE_PROFILES.json;
    case 'text': case 'plain': case 'plaintext': case 'txt': case 'md': case 'markdown': return CODE_PROFILES.none;
    default: return CODE_PROFILES.clike;
  }
}
const codeTokenReCache = new Map<CodeProfile, RegExp>();
function codeTokenRe(profile: CodeProfile): RegExp {
  const cached = codeTokenReCache.get(profile);
  if (cached) return cached;
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const never = '(?!)'; // non-capturing never-match placeholder keeps group numbering stable
  const re = new RegExp(
    (profile.comment ? `(${escRe(profile.comment)}[^\\n]*)` : `(${never})`) + // 1: comment
    `|('(?:\\\\.|[^'\\\\\\n])*'|"(?:\\\\.|[^"\\\\\\n])*"|\`(?:\\\\.|[^\`\\\\\\n])*\`)` + // 2: string
    (profile.keywords ? `|\\b(${profile.keywords})\\b` : `|(${never})`) +     // 3: keyword
    (profile.types ? `|\\b(${profile.types})\\b` : `|(${never})`) +           // 4: type
    `|\\b(\\d+(?:\\.\\d+)?)\\b` +                                            // 5: number
    `|\\b([a-zA-Z_$][\\w$]*)(?=\\s*\\()` +                                    // 6: function call
    `|([{}();,<>\\[\\]=+\\-*/%!&|?:])` +                                      // 7: punctuation
    (profile.variable ? `|(\\$\\{[^}\\n]*\\}|\\$[A-Za-z_][\\w]*|\\$\\d)` : `|(${never})`), // 8: $var
    'g',
  );
  codeTokenReCache.set(profile, re);
  return re;
}
function highlightCodeLine(line: string, lang = ''): string {
  const profile = codeProfileFor(lang);
  const BASE = R.assistantText;
  if (profile === CODE_PROFILES.none) return `${BASE}${line}${T.reset}`;
  const s = line.replace(codeTokenRe(profile), (m, comment, str, kw, type, num, fn, _punct, vr) => {
    if (comment !== undefined) return `${R.codeComment}${m}${T.reset}`;
    if (str !== undefined) return `${R.codeString}${m}${T.reset}`;
    if (kw !== undefined) return `${R.codeKeyword}${m}${T.reset}`;
    if (type !== undefined) return `${R.codeType}${m}${T.reset}`;
    if (num !== undefined) return `${R.codeNumber}${m}${T.reset}`;
    if (fn !== undefined) return `${R.codeFn}${m}${T.reset}`;
    if (vr !== undefined) return `${R.codeNumber}${m}${T.reset}`;
    return `${R.codePunct}${m}${T.reset}`; // punct
  });
  return `${BASE}${s}${T.reset}`;
}

/**
 * Cline-grade terminal markdown renderer ("same as Cline but better"):
 *  - headings: bold colored text + a hairline that MATCHES the text length
 *  - unordered bullets: cyan `•` glyphs (distinct from ordered lists)
 *  - ordered lists: orange auto-numbers
 *  - NESTED lists: 2-space indent per level, parent-colored markers
 *  - HANGING INDENTS: wrapped continuation lines align under the text,
 *    not under the marker (the Cline signature look)
 *  - width-aware wrapping at `width` (defaults to the terminal) so the
 *    renderer itself produces final rows — no double-wrap drift
 *  - blockquotes with a colored left bar on every continuation line
 *  - code fences with a language tag + highlighted lines, indented
 */
/** Parse cells from a markdown table row (handles escaped pipes). */
export function parseTableCells(line: string): string[] {
  // Cells are single-line by definition — a CR has no business inside one
  // (direct renderTable callers bypass renderMarkdown's normalization).
  const trimmed = line.replace(/\r/g, '').trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const placeholder = '\u0000PIPE\u0000';
  const escaped = inner.replace(/\\\|/g, placeholder);
  return escaped.split('|').map((c) => c.replace(new RegExp(placeholder, 'g'), '|').trim());
}

/** Check if a line is a markdown table delimiter row (e.g. |---|---| or |:---|---:|). */
export function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|').map((c) => c.trim());
  if (cells.length < 1) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/** Check if a line can be a markdown table row. */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (trimmed.startsWith('|') && trimmed.endsWith('|')) return true;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').length >= 2;
}

export type TableAlignment = 'left' | 'center' | 'right';

export function parseTableAlignments(delimLine: string): TableAlignment[] {
  const inner = delimLine.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => {
    const trimmed = c.trim();
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

/** Compute column widths allocating available space proportionally up to maxTableWidth. */
export function computeColumnWidths(headers: string[], bodyRows: string[][], maxTableWidth: number): number[] {
  const numCols = headers.length;
  if (numCols === 0) return [];
  const borderOverhead = numCols + 1;
  const avail = Math.max(numCols * 2, maxTableWidth - borderOverhead);

  // 1. Natural width of each column: visible content length + 2 spaces padding (1 left, 1 right)
  const natural: number[] = headers.map((h, colIdx) => {
    let maxVis = visibleLen(stripAnsi(h));
    for (const row of bodyRows) {
      if (row[colIdx]) {
        maxVis = Math.max(maxVis, visibleLen(stripAnsi(formatInlineMarkdown(row[colIdx]))));
      }
    }
    return Math.max(4, maxVis + 2);
  });

  const sumNatural = natural.reduce((a, b) => a + b, 0);

  if (sumNatural <= avail) {
    return natural;
  }

  // Shrink columns to fit inside avail while protecting small columns (<= 12 chars).
  const minCol = Math.max(2, Math.min(4, Math.floor(avail / numCols)));
  const widths = natural.slice();

  const smallCutoff = 12;
  let smallColsTotal = 0;
  let largeColsNatural = 0;
  let largeColsCount = 0;

  for (let i = 0; i < numCols; i++) {
    if (natural[i] <= smallCutoff) {
      smallColsTotal += natural[i];
    } else {
      largeColsNatural += natural[i];
      largeColsCount++;
    }
  }

  if (largeColsCount > 0 && avail - smallColsTotal >= largeColsCount * minCol) {
    const remainingAvail = avail - smallColsTotal;
    let allocated = 0;
    for (let i = 0; i < numCols; i++) {
      if (natural[i] > smallCutoff) {
        const share = Math.max(minCol, Math.floor(remainingAvail * (natural[i] / largeColsNatural)));
        widths[i] = share;
        allocated += share;
      }
    }
    let rem = remainingAvail - allocated;
    while (rem > 0) {
      let maxIdx = -1;
      for (let i = 0; i < numCols; i++) {
        if (natural[i] > smallCutoff && (maxIdx === -1 || widths[i] < widths[maxIdx])) {
          maxIdx = i;
        }
      }
      if (maxIdx === -1) break;
      widths[maxIdx]++;
      rem--;
    }
    while (widths.reduce((a, b) => a + b, 0) > avail) {
      let maxIdx = -1;
      for (let i = 0; i < numCols; i++) {
        if (widths[i] > minCol && (maxIdx === -1 || widths[i] > widths[maxIdx])) {
          maxIdx = i;
        }
      }
      if (maxIdx === -1) break;
      widths[maxIdx]--;
    }
    return widths;
  }

  const totalMin = numCols * minCol;
  if (avail <= totalMin) {
    const each = Math.max(2, Math.floor(avail / numCols));
    const res = new Array(numCols).fill(each);
    let rem = avail - each * numCols;
    for (let i = 0; i < rem; i++) res[i]++;
    return res;
  }

  const extra = avail - totalMin;
  const naturalExtra = Math.max(1, sumNatural - totalMin);
  let allocatedExtra = 0;
  for (let i = 0; i < numCols; i++) {
    const share = Math.floor(extra * ((natural[i] - minCol) / naturalExtra));
    widths[i] = minCol + share;
    allocatedExtra += share;
  }
  let rem = extra - allocatedExtra;
  for (let i = 0; i < numCols && rem > 0; i++, rem--) {
    widths[i]++;
  }
  while (widths.reduce((a, b) => a + b, 0) > avail) {
    let maxIdx = 0;
    for (let i = 1; i < numCols; i++) {
      if (widths[i] > widths[maxIdx]) maxIdx = i;
    }
    if (widths[maxIdx] <= 2) break;
    widths[maxIdx]--;
  }
  return widths;
}

function formatTableCell(s: string, colW: number, align: TableAlignment = 'left'): string {
  const contentW = Math.max(0, colW - 2);
  const truncated = visibleLen(s) > contentW ? ellipsize(s, contentW) : s;
  const vis = visibleLen(truncated);
  const pad = Math.max(0, contentW - vis);
  if (align === 'right') {
    return ' ' + ' '.repeat(pad) + truncated + ' ';
  }
  if (align === 'center') {
    const leftPad = Math.floor(pad / 2);
    const rightPad = pad - leftPad;
    return ' ' + ' '.repeat(leftPad) + truncated + ' '.repeat(rightPad) + ' ';
  }
  return ' ' + truncated + ' '.repeat(pad) + ' ';
}

/** Render a markdown table as a Cline-grade boxed matrix (┌─┬─┐, │ │ │, ├─┼─┤, └─┴─┘). */
export function renderTable(headerRaw: string, delimRaw: string, bodyRaws: string[], maxW: number, minColWidths?: number[], widthsOut?: number[][]): string[] {
  const headers = parseTableCells(headerRaw);
  if (headers.length === 0) return [];
  const numCols = headers.length;
  const alignments = parseTableAlignments(delimRaw);
  while (alignments.length < numCols) alignments.push('left');

  const bodyRows: string[][] = bodyRaws.map((rowRaw) => {
    const cells = parseTableCells(rowRaw);
    while (cells.length < numCols) cells.push('');
    return cells.slice(0, numCols);
  });

  const colWidths = computeColumnWidths(headers, bodyRows, maxW);
  // Streaming hint (Wave S3): a table that is still receiving rows used to
  // recompute its column widths from the rows seen so far on EVERY frame,
  // so the whole box visibly jittered sideways as the model typed. The
  // streaming renderer passes the widths the previous frame used as a
  // floor; widths then only grow (never shrink mid-stream) and settle once
  // when the table's block seals. Hints come from a feasible render at the
  // same maxW; if natural growth + hints overflow, shave the widest
  // columns back to fit.
  if (minColWidths && minColWidths.length === numCols) {
    for (let c = 0; c < numCols; c++) colWidths[c] = Math.max(colWidths[c], minColWidths[c]);
    let total = colWidths.reduce((a, b) => a + b, 0) + numCols + 1;
    while (total > maxW) {
      let widest = -1;
      for (let c = 0; c < numCols; c++) {
        if (colWidths[c] > 3 && (widest === -1 || colWidths[c] > colWidths[widest])) widest = c;
      }
      if (widest === -1) break;
      colWidths[widest]--;
      total--;
    }
  }
  if (widthsOut) widthsOut.push([...colWidths]);
  const borderCol = T.rule ?? T.grayDark ?? '\x1b[38;2;86;95;137m';
  const out: string[] = [];

  // Top border: ┌───┬───┐
  out.push(`${borderCol}┌${colWidths.map((w) => '─'.repeat(w)).join('┬')}┐${T.reset}`);

  // Header row: │ Header 1 │ Header 2 │
  const headerCells = headers.map((h, colIdx) => {
    const styledText = `${T.bold}${T.cyan}${h}${T.reset}`;
    return formatTableCell(styledText, colWidths[colIdx], alignments[colIdx]);
  });
  out.push(`${borderCol}│${T.reset}${headerCells.join(`${borderCol}│${T.reset}`)}${borderCol}│${T.reset}`);

  // Header separator: ├───┼───┤
  out.push(`${borderCol}├${colWidths.map((w) => '─'.repeat(w)).join('┼')}┤${T.reset}`);

  // Body rows: │ Cell 1 │ Cell 2 │
  for (const row of bodyRows) {
    const rowCells = row.map((cell, colIdx) => {
      const styledText = formatInlineMarkdown(cell);
      return formatTableCell(styledText, colWidths[colIdx], alignments[colIdx]);
    });
    out.push(`${borderCol}│${T.reset}${rowCells.join(`${borderCol}│${T.reset}`)}${borderCol}│${T.reset}`);
  }

  // Bottom border: └───┴───┘
  out.push(`${borderCol}└${colWidths.map((w) => '─'.repeat(w)).join('┴')}┘${T.reset}`);

  return out;
}

/**
 * Cline-grade terminal markdown renderer ("same as Cline but better"):
 *  - headings: bold colored text + a hairline that MATCHES the text length
 *  - unordered bullets: cyan `•` glyphs (distinct from ordered lists)
 *  - ordered lists: orange auto-numbers
 *  - NESTED lists: 2-space indent per level, parent-colored markers
 *  - HANGING INDENTS: wrapped continuation lines align under the text,
 *    not under the marker (the Cline signature look)
 *  - width-aware wrapping at `width` (defaults to the terminal) so the
 *    renderer itself produces final rows — no double-wrap drift
 *  - blockquotes with a colored left bar on every continuation line
 *  - code fences with a language tag + highlighted lines, indented
 *  - tables: boxed matrix with single-line borders (┌─┬─┐, │ │ │, ├─┼─┤, └─┴─┘)
 *  - proper vertical paragraph and block spacing (clean single blank lines)
 */
export function renderMarkdown(text: string, width?: string | number): string[] {
  return renderMarkdownInternal(text, width, {});
}

interface MarkdownRenderOpts {
  /** Keep the single trailing blank row (a block separator) instead of
   *  popping it — the streaming renderer seals segments at blank-line
   *  boundaries, and the separator blank belongs between the segment and
   *  whatever streams next. */
  keepTrailingBlank?: boolean;
  /** Per-table sticky column-width hints (by table ordinal in this render,
   *  keyed by the table's raw header line so a replaced tail can't apply
   *  one table's widths to a different table). */
  tableMinWidths?: { key: string; widths: number[] }[];
  /** Out-param: header key + column widths each rendered table used. */
  tableWidthsOut?: { key: string; widths: number[] }[];
}

function renderMarkdownInternal(text: string, width: string | number | undefined, opts: MarkdownRenderOpts): string[] {
  const termW = typeof width === 'number' ? width : (process.stdout.columns || 100);
  const W = Math.max(20, Math.min(Number(termW) || 100, 200));
  // Same CR rule as wrap(): a `\r` inside code fences or table cells would
  // render as a mid-row carriage return and overwrite the row's own border.
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let paragraph: string[] = [];
  let tableOrdinal = 0;

  const emitBlankIfNeeded = () => {
    if (out.length > 0 && out[out.length - 1] !== '') {
      out.push('');
    }
  };

  // Emit one wrapped paragraph with a hanging indent: continuation rows pad
  // to `hang` visible columns so they align under the text, not the marker.
  // Returns the index of the first row pushed. Callers used to RE-derive
  // that index by re-wrapping the content with a hand-computed width — the
  // numbered-list branch passed a width 3 columns narrower than the one
  // used here, so its count overshot, stamping the number onto the wrong
  // row in long documents and indexing before the array (crash) in short
  // ones, e.g. a streaming tail that starts at a list (Wave S3 find).
  const emitWrapped = (content: string, indent: number, hang: number, styled: (s: string) => string): number => {
    const firstRow = out.length;
    const avail = Math.max(12, W - 2 - indent - 2);
    const wrapped = wrap(content, avail);
    wrapped.forEach((row, i) => {
      const pad = indent + (i > 0 ? hang : 0);
      // Trim leading space on continuation rows: wrap() keeps the inter-word
      // space that lands at the split boundary, which printed as a stray
      // leading space on every continuation line.
      const body = i > 0 ? row.replace(/^\s+/, '') : row;
      out.push(`${' '.repeat(pad)}${styled(body)}`);
    });
    return firstRow;
  };

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    paragraph = [];
    if (!joined) return;
    emitWrapped(joined, 0, 0, formatInlineMarkdown);
  };

  // List state: nesting via leading-space depth; unordered bullets keep their
  // own glyph; ordered lists number within their depth.
  const bulletStack: Array<{ ordered: boolean; n: number }> = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    // Fenced code blocks: tight list of highlighted rows with a language tag.
    if (trimmed.startsWith('```')) {
      flushParagraph();
      bulletStack.length = 0;
      if (!inCodeBlock) {
        emitBlankIfNeeded();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        let lang = codeBlockLang;
        let file = '';
        if (lang.includes(':')) {
          const parts = lang.split(':', 2);
          lang = parts[0];
          file = parts[1];
        } else if (lang.includes('/') || (lang.includes('.') && !/^\w+$/.test(lang))) {
          file = lang;
          lang = file.split('.').pop() || '';
        }
        const filePart = file ? `${T.fg}${T.bold}${file}${T.reset} ${T.grayDark}·${T.reset} ` : '';
        const langPart = lang ? `${R.codeType}${lang}${T.reset}` : `${T.grayDark}code${T.reset}`;
        const pill = `${T.act}✦${T.reset} ${filePart}${langPart}`;
        const barLen = Math.max(4, Math.min(W - visibleLen(pill) - 6, 40));
        out.push(`  ${pill} ${T.grayDark}${'─'.repeat(barLen)}${T.reset}`);
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
        out.push(`  ${T.grayDark}──${T.reset}`);
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(`  ${highlightCodeLine(raw, codeBlockLang)}`);
      continue;
    }

    // Blank line → paragraph boundary + list reset + clean single spacing.
    if (!trimmed) {
      flushParagraph();
      bulletStack.length = 0;
      emitBlankIfNeeded();
      continue;
    }

    // Markdown table: header row followed by delimiter row (|---|---|)
    if (isTableRow(raw) && i + 1 < rawLines.length && isTableDelimiter(rawLines[i + 1])) {
      flushParagraph();
      bulletStack.length = 0;
      emitBlankIfNeeded();

      const headerRaw = raw;
      const delimRaw = rawLines[i + 1];
      const tableRowsRaw: string[] = [];
      i += 2;
      while (i < rawLines.length) {
        const nextLine = rawLines[i];
        if (!nextLine.trim() || !isTableRow(nextLine)) break;
        tableRowsRaw.push(nextLine);
        i++;
      }
      i--; // loop increment counter will advance to next line

      const hint = opts.tableMinWidths?.[tableOrdinal];
      const tableUsed: number[][] = [];
      const tableRows = renderTable(
        headerRaw, delimRaw, tableRowsRaw, W,
        hint && hint.key === headerRaw ? hint.widths : undefined,
        tableUsed,
      );
      if (opts.tableWidthsOut) opts.tableWidthsOut.push({ key: headerRaw, widths: tableUsed[0] ?? [] });
      tableOrdinal++;
      for (const row of tableRows) {
        out.push(row);
      }
      continue;
    }

    // Headers (#–######): strip sigil, bold + colored, hairline matches text.
    // Levels 4–6 render as bold text without the hairline (and without the
    // literal hashes the old {1,3} cap leaked into prose as a paragraph).
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (hMatch) {
      flushParagraph();
      bulletStack.length = 0;
      emitBlankIfNeeded();
      const headingText = hMatch[2];
      out.push(`${R.mdHeading}${T.bold}${headingText}${T.reset}`);
      if (hMatch[1].length <= 3) {
        out.push(`${R.mdHeading}${'─'.repeat(Math.max(8, Math.min(40, visibleLen(headingText))))}${T.reset}`);
      }
      continue;
    }

    // Horizontal divider.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      bulletStack.length = 0;
      out.push(`${T.grayDark}${'─'.repeat(Math.min(40, W - 4))}${T.reset}`);
      continue;
    }

    // Blockquote: colored left bar on EVERY line (Cline-style vertical rule).
    if (trimmed.startsWith('> ') || trimmed === '>') {
      flushParagraph();
      bulletStack.length = 0;
      const body = trimmed.replace(/^>\s?/, '');
      for (const l of wrap(body, Math.max(12, W - 8))) {
        out.push(`  ${SEMANTIC_QUOTE}│ ${T.reset}${formatInlineMarkdown(l)}`);
      }
      continue;
    }

    // Unordered bullet: cyan • glyph, NESTED via leading-space depth, with
    // hanging indent so wrapped rows align under the text.
    const uMatch = /^(\s*)([•\-\*\+])\s+(.*)$/.exec(raw);
    if (uMatch) {
      flushParagraph();
      const depth = Math.min(3, Math.floor(uMatch[1].length / 2));
      bulletStack.length = depth; // deeper level starts a fresh sub-list
      bulletStack.push({ ordered: false, n: 0 });
      const indent = 2 + depth * 2;
      // Prefix the first emitted row with the glyph (emitWrapped reports
      // exactly which row that is — no re-wrap guesswork).
      const first = emitWrapped(uMatch[3], indent, 2, formatInlineMarkdown);
      out[first] = out[first].replace(/^(\s*)/, `$1${R.codeType}•${T.reset} `);
      continue;
    }

    // Numbered list: orange numbers, per-depth counter, hanging indent.
    const numMatch = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
    if (numMatch) {
      flushParagraph();
      const depth = Math.min(3, Math.floor(numMatch[1].length / 2));
      const parent = bulletStack[depth - 1];
      if (!bulletStack[depth] || bulletStack[depth].ordered !== true) {
        bulletStack.length = depth;
        bulletStack.push({ ordered: true, n: 0 });
      }
      void parent;
      bulletStack[depth].n += 1;
      const indent = 2 + depth * 2;
      const marker = `${R.codeNumber}${bulletStack[depth].n}.${T.reset}`;
      // Same grid as bullets (indent), hang 3 so continuation aligns under
      // the number's text column — markers never outdent the list.
      const first = emitWrapped(numMatch[3], indent, 3, formatInlineMarkdown);
      out[first] = out[first].replace(/^(\s*)/, `$1${marker} `);
      continue;
    }
    if (!/^\s/.test(raw)) bulletStack.length = 0;

    // Standard paragraph: accumulate and emit on next blank / EOF.
    paragraph.push(raw);
  }
  flushParagraph();
  if (!opts.keepTrailingBlank) {
    while (out.length > 0 && out[out.length - 1] === '') {
      out.pop();
    }
  }
  return out;
}

// ── Streaming markdown renderer (Wave S3) ──────────────────────────────────
// The transcript used to call renderMarkdown on the ENTIRE accumulated
// assistant line on every coalesced frame — up to the 16K-char stream cap,
// fully re-parsed ~33×/s. Measured on a 13.9K-char replay fixture: mean
// 19.7ms/frame, p95 51ms, 43/92 frames over the 16ms budget — main-loop
// time (and keystroke latency) grew with message length. This renderer
// makes per-frame cost proportional to the UNFINISHED TAIL only:
//
//  - Text is SEALED at blank-line boundaries outside code fences. In this
//    renderer a blank line flushes the paragraph and resets list state, so
//    a sealed prefix renders identically standalone and inside the whole
//    document (its trailing separator blank is kept on the sealed side).
//    Sealed rows render once and are reused verbatim.
//  - The tail is re-rendered per frame, but first gets a VIRTUAL CLOSURE:
//    an unclosed ** or backtick in the final block gets its closer
//    appended for display only, and a half-typed link collapses to its
//    label — no raw markdown syntax is ever visible mid-stream. When the
//    real closer streams in, the raw tail takes over seamlessly.
//  - Tables in the tail receive the previous frame's column widths as a
//    floor, so a streaming table's box never jitters sideways.
//
// Input must be append-only (state.ts appends chunks to the same Line
// object). A width change or a non-append edit (provider re-send replaces
// the line's text) resets the seal and falls back to a full render.
export interface StreamMarkdownRenderer {
  render(text: string, width?: string | number): string[];
  stats(): { sealedChars: number; tailChars: number; segmentRenders: number; resets: number };
}

function streamWidthKey(width: string | number | undefined): number {
  const termW = typeof width === 'number' ? width : (process.stdout.columns || 100);
  return Math.max(20, Math.min(Number(termW) || 100, 200));
}

/** Largest offset ≤ text.length such that text.slice(from, offset) ends
 *  just after a blank line and the scan is outside a code fence there.
 *  `from` must itself be outside a fence (seal points always are). */
function findSealEnd(text: string, from: number): number {
  let inFence = false;
  let seal = from;
  let lineStart = from;
  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const trimmed = text.slice(lineStart, lineEnd).trim();
    if (trimmed.startsWith('```')) inFence = !inFence;
    else if (!inFence && trimmed === '') seal = nl === -1 ? text.length : nl + 1;
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return seal;
}

/** Display-only closure for the unfinished tail (see section comment).
 *  Only the final block can hold a half-typed construct. If the stream
 *  ends inside a code fence, the fence renderer already shows a sane
 *  open state, so the text is returned untouched. */
function closeTailForStreaming(tail: string): string {
  const blockStarts: number[] = [0];
  let inFence = false;
  let lineStart = 0;
  while (lineStart < tail.length) {
    const nl = tail.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? tail.length : nl;
    const trimmed = tail.slice(lineStart, lineEnd).trim();
    if (trimmed.startsWith('```')) inFence = !inFence;
    else if (!inFence && trimmed === '' && nl !== -1) blockStarts.push(nl + 1);
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (inFence) return tail;
  // The final block may be empty when the stream pauses right after a
  // newline — fall back to the last non-empty block.
  let blockStart = blockStarts[blockStarts.length - 1];
  while (blockStart > 0 && tail.slice(blockStart).trim() === '') {
    blockStarts.pop();
    blockStart = blockStarts[blockStarts.length - 1];
  }
  const head = tail.slice(0, blockStart);
  let block = tail.slice(blockStart);
  // Half-typed link at the very end: show just the label, not brackets.
  block = block.replace(/\[([^\]\n]+)\]\([^)\n]*$/, '$1');
  block = block.replace(/\[([^\]\n]*)$/, '$1');
  // Unclosed inline code on the last line (code spans are single-line in
  // formatInlineMarkdown): an odd backtick count means a span is open.
  const lastLine = block.slice(block.lastIndexOf('\n') + 1);
  const ticks = (lastLine.match(/`/g) ?? []).length;
  if (ticks % 2 === 1 && !lastLine.endsWith('`')) block += '`';
  // Unclosed bold in the final block: count ** outside code spans.
  const noCode = block.replace(/`[^`\n]*`/g, '');
  const bolds = (noCode.match(/\*\*/g) ?? []).length;
  if (bolds % 2 === 1) block += '**';
  return head + block;
}

export function createStreamMarkdownRenderer(): StreamMarkdownRenderer {
  let widthKey = -1;
  let prevText = '';
  let sealedLen = 0;
  let sealedRows: string[] = [];
  let hints: { key: string; widths: number[] }[] = [];
  let segmentRenders = 0;
  let resets = 0;
  let lastTailChars = 0;

  function render(text: string, width?: string | number): string[] {
    const W = streamWidthKey(width);
    const norm = text.replace(/\r\n?/g, '\n');
    if (W !== widthKey || !norm.startsWith(prevText)) {
      widthKey = W;
      sealedLen = 0;
      sealedRows = [];
      hints = [];
      resets++;
    }
    // Extend the seal over every complete block now available.
    const sealEnd = findSealEnd(norm, sealedLen);
    if (sealEnd > sealedLen) {
      sealedRows.push(...renderMarkdownInternal(norm.slice(sealedLen, sealEnd), W, { keepTrailingBlank: true }));
      segmentRenders++;
      sealedLen = sealEnd;
      hints = [];
    }
    prevText = norm;
    const tail = norm.slice(sealedLen);
    lastTailChars = tail.length;
    if (tail.trim() === '') {
      // Nothing after the seal: drop the separator blank the whole-doc
      // renderer would have popped at end of document.
      const rows = sealedRows.slice();
      if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
      return rows;
    }
    const widthsOut: { key: string; widths: number[] }[] = [];
    const tailRows = renderMarkdownInternal(closeTailForStreaming(tail), W, {
      tableMinWidths: hints,
      tableWidthsOut: widthsOut,
    });
    hints = widthsOut;
    return sealedRows.concat(tailRows);
  }

  return {
    render,
    stats: () => ({ sealedChars: sealedLen, tailChars: lastTailChars, segmentRenders, resets }),
  };
}

const SEMANTIC_QUOTE = '\x1b[38;2;150;150;165m';

/** Render one transcript entry with mochi color coordination. */
export function renderEntry(entry: RenderEntry, _expandTools = false): string[] {
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
      // Internal reasoning rendered as dim italic prose, no glyph spam.
      // Gray alone (no T.dim stacking) — dim+gray on dark themes was
      // literally unreadable (the "can't see the text" report).
      return text.split('\n').filter((l) => l.trim()).map((l) => `  ${T.italic}${T.gray}${l}${T.reset}`);
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


// ---- Input bar (Cline input-bar.tsx: ❯ + hairline rules) -------------------

export function composerTopRule(width: number): string {
  return `${T.rule}┌${'─'.repeat(Math.max(0, width - 2))}┐${T.reset}`;
}

/** One text row of the composer box.
 *
 *  `isFirst` controls the prompt glyph: the `❯` cursor and its padding are
 *  rendered ONLY on the first visible row, so a multi-line (wrapped) input does
 *  not repeat `❯` on every continuation line — which previously made a long
 *  input look like a row of stacked `❯❯❯` symbols and corrupted the box. The
 *  `❯` column still matches the caret math (`4 = ❯ + 2 spaces`).
 */
/** Mask a secret input for display (char-for-char `*`, newlines kept): lengths
 *  are preserved exactly so caret math and wrapping behave identically. */
export function maskSecretInput(text: string): string {
  return text.replace(/[^\n]/g, '*');
}

export function composerRow(text: string, width: number, isFirst = true): string {
  const inner = Math.max(1, width - 6);
  const shown = visibleLen(text) > inner ? ellipsize(text, inner) : text;
  // First row: `│ ❯ <text> │`; continuation rows: `│   <text> │` — text starts
  // at column 4 on EVERY row so wrapped input reads as one block. (The old
  // 3-space continuation put text at column 5: continuation text visibly
  // jogged right AND the caret math, which assumes a 4-cell prefix, landed
  // one cell left — on top of the character being typed.)
  // Skeleton per row is `│ ` + prompt + padEnd + ` │`; both prompts are
  // 2 cells so both rows sum to `inner + 6 == width`, keeping the right
  // border `│` at a fixed column and the box perfectly square.
  const prompt = isFirst ? `${T.act}${T.bold}❯${T.reset} ` : '  ';
  return `${T.rule}│${T.reset} ${prompt}${T.fg}${padEnd(shown, inner)}${T.reset} ${T.rule}│${T.reset}`;
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
  let text = hint;
  if (width < 52 && width >= 38) {
    text = ' ⏎ send · Tab mode · ESC stop · / cmds';
  } else if (width < 38) {
    text = ' ⏎ send · ESC stop';
  }
  const vis = visibleLen(text);
  const shown = vis > width ? ellipsize(text, width) : text;
  return `${T.grayDark}${shown}${T.reset}`;
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

  // Category pills header for Raycast-style palette on wide-enough terminals
  if (w >= 48) {
    const pills = `  ${T.act}${T.bold}[All]${T.reset} ${T.cyan}[Tools]${T.reset} ${T.pink}[Themes]${T.reset} ${T.lime}[Skills]${T.reset}`;
    out.push(`${T.rule}│${T.reset}${padEnd(pills, w - 2)}${T.rule}│${T.reset}`);
    out.push(`${T.rule}├${'─'.repeat(Math.max(0, w - 2))}┤${T.reset}`);
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const sel = i === selected;
    // Budget-driven columns: the old fixed 16-cell name + 2-cell pointer +
    // borders needed 20 cells minimum, so every narrower terminal overflowed.
    // The name column now shrinks (floor 1) and the hint takes the remainder
    // (possibly 0 → ellipsize emits ''), keeping rows graceful at any width.
    const inner = Math.max(1, w - 2); // cells between the borders
    const nameW = Math.max(1, Math.min(16, inner - 2 - 1)); // pointer 2, hint ≥ 1
    const name = padEnd(it.name, nameW);
    const hint = ellipsize(it.hint, Math.max(0, inner - 2 - nameW));
    const rowBody = sel
      ? `${T.act}❯ ${T.bold}${name}${T.reset}${T.gray}${hint}${T.reset}`
      : `  ${T.fg}${name}${T.reset}${T.grayDark}${hint}${T.reset}`;
    const pad = Math.max(0, inner - 2 - nameW - visibleLen(hint));
    let row = `${T.rule}│${T.reset}${rowBody}${' '.repeat(pad)}${T.rule}│${T.reset}`;
    // Airtight invariant: no row ever exceeds the box, at ANY width. The
    // border is re-appended after the cut so the box never loses its edge.
    if (visibleLen(row) > w) row = `${ellipsize(row, Math.max(0, w - 1))}${T.rule}│${T.reset}`;
    out.push(row);
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
      barCells.push(`${TRACK}─${T.reset}`);
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

// ---- Goodbye screen (opencode-style exit card) ----------------------------
// Printed once to the real stdout AFTER the alt-screen is torn down, so it
// persists in scrollback: mini MOCHI logo + session id + run stats + the
// safety badge (uncensored/admin when privileged). Pure like splashFrame.
export interface FarewellModel {
  version: string;
  sessionId: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  uiMode: 'plan' | 'act';
  safetyMode: string;
  uncensored: boolean;
}

/** `125000ms` → `2m05s`, `45000` → `45s`, `3600000+` → `1h02m`. Pure. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function farewellFrame(m: FarewellModel, width: number): string[] {
  const stops = SPLASH_PALETTES[0];
  const logoW = MOCHI_ASCII.reduce((mm, l) => Math.max(mm, l.length), 0);
  const lines: string[] = [''];
  for (const row of MOCHI_ASCII) {
    const cells: string[] = [];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ' ') { cells.push(' '); continue; }
      const t = x / Math.max(1, logoW - 1);
      const scaled = t * (stops.length - 1);
      const si = Math.min(stops.length - 2, Math.floor(scaled));
      const c = lerp(stops[si], stops[si + 1], scaled - si);
      cells.push(`${rgb(c[0], c[1], c[2])}${T.bold}${ch}${T.reset}`);
    }
    const v = row.length;
    lines.push(' '.repeat(Math.max(0, Math.floor((width - v) / 2))) + cells.join(''));
  }
  lines.push('');
  const tok = m.tokens >= 1000 ? `${(m.tokens / 1000).toFixed(1)}k` : `${m.tokens}`;
  const stats = `session ${m.sessionId} · ${m.uiMode} · ${tok} tokens · $${m.costUsd.toFixed(2)} · ${formatDuration(m.durationMs)}`;
  lines.push(' '.repeat(Math.max(0, Math.floor((width - stats.length) / 2))) + `${T.gray}${stats}${T.reset}`);
  const badge = m.uncensored
    ? `🔓 UNCENSORED · admin privileges active`
    : `safety: ${m.safetyMode}`;
  const badgeColored = m.uncensored ? `${T.warning}${T.bold}${badge}${T.reset}` : `${T.grayDark}${badge}${T.reset}`;
  lines.push(' '.repeat(Math.max(0, Math.floor((width - badge.length) / 2))) + badgeColored);
  lines.push('');
  const bye = `thanks for building with mochi v${m.version} — see you soon 🍡`;
  lines.push(' '.repeat(Math.max(0, Math.floor((width - bye.length) / 2))) + `${T.cyan}${bye}${T.reset}`);
  const resume = `${T.grayDark}resume anytime: mochi resume${T.reset}`;
  lines.push(' '.repeat(Math.max(0, Math.floor((width - 28) / 2))) + resume);
  lines.push('');
  return lines;
}
