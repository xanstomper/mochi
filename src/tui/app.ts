import { sliceVisibleRange, highlightRange } from './selection.js';
import { execFile, spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { findProjectRoot } from '../repo.js';
import type { Runtime } from '../runtime.js';
import type { MochiEvent } from '../types.js';
import { PROVIDERS, providerById } from '../providers.js';
import { reduceEvent, trimTranscript } from './state.js';
import { wrap, visibleLen } from './wrap.js';
import pkg from '../../package.json' with { type: 'json' };
import { kvCache } from '../kv-cache.js';
import { formatModes } from '../modes.js';
import {
  T,
  R,
  setTheme,
  getAllThemes,
  getCurrentTheme,
  themeSwatch,
  gradientContextBar,
  gradientCacheBar,
  splashFrame,
  SPLASH_TICKS,
  statusBarRow1,
  statusBarRow2,
  renderEntry,
  renderMarkdown,
  renderDropdown,

  composerRow,
  composerPlaceholderRow,
  composerTopRule,
  composerBottomRule,
  composerHintRow,
  transcriptIndent,
  turnRule,
  thinkingLine,
  spinnerFrame,
  ellipsize,
} from './view.js';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ALT_ENTER = '\x1b[?1049h';
const ALT_EXIT = '\x1b[?1049l';
const BRACKET_PASTE_ON = '\x1b[?2004h';
const BRACKET_PASTE_OFF = '\x1b[?2004l';
const RESET = '\x1b[0m';

type LineKind = 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'task' | 'goal' | 'plain' | 'thought';

interface Line {
  kind: LineKind;
  text: string;
}

interface TaskView {
  id: string;
  title: string;
  role: string;
  status: string;
}

const COMMANDS = [
  { name: '/help', hint: 'Show commands' },
  { name: '/clear', hint: 'Clear transcript' },
  { name: '/copy', hint: 'Copy last assistant message to clipboard (works without mouse)' },
  { name: '/model', hint: 'Select AI model provider & model' },
  { name: '/reasoning', hint: 'Adjust reasoning effort & compute (low, medium, high, max)' },
  { name: '/theme', hint: 'Select color theme (15 styles)' },
  { name: '/skills', hint: 'Browse & activate specialized engineering skills' },
  { name: '/mode', hint: 'Set execution mode (normal, spec, security, chaos)' },
  { name: '/providers', hint: 'List connected AI model providers' },
  { name: '/login', hint: 'Authenticate a model provider API key' },
  { name: '/plan', hint: 'Plan only without executing changes' },
  { name: '/approve', hint: 'Execute the pending plan' },
  { name: '/goal', hint: 'Create a multi-step objective' },
  { name: '/tasks', hint: 'List current tasks and statuses' },
  { name: '/status', hint: 'Show repository git status' },
  { name: '/diff', hint: 'Show pending git changes' },
  { name: '/commit', hint: 'Create a checkpoint commit' },
  { name: '/undo', hint: 'Restore previous checkpoint' },
  { name: '/redo', hint: 'Reapply last checkpoint' },
  { name: '/rewind', hint: 'Rollback to last checkpoint' },
  { name: '/yolo', hint: 'Toggle auto-approve for all tool actions' },
  { name: '/workspace-safe', hint: 'Auto-approve edits, prompt for shell' },
  { name: '/plugins', hint: 'List installed plugins' },
  { name: '/profiles', hint: 'List specialized agent profiles' },
  { name: '/memory', hint: 'Show project memory and learned rules' },
  { name: '/history', hint: 'Interactive session manager & history' },
  { name: '/rename', hint: 'Rename current conversation session' },
  { name: '/export', hint: 'Export session transcript to JSON' },
  { name: '/import', hint: 'Import session transcript' },
  { name: '/usage', hint: 'Show token usage, costs, and cache hits' },
  { name: '/tokens', hint: 'Show token breakdown and prompt cache efficiency' },
  { name: '/stats', hint: 'Show real-time performance and cost statistics' },
  { name: '/chameleon', hint: 'Synthesize Chameleon synthetic reasoning parameters for a task' },
  { name: '/doctor', hint: 'Diagnose workspace configuration' },
  { name: '/init', hint: 'Create project MOCHI.md instructions' },
  { name: '/new', hint: 'Start a fresh conversation session' },
  { name: '/skip', hint: 'Skip/interrupt current in-flight task' },
  { name: '/stop', hint: 'Interrupt current in-flight task' },
  { name: '/exit', hint: 'Quit Mochi CLI' },
];

const SPINNER = ['◐', '◓', '◑', '◒'];

export async function launchTui(runtime: Runtime, initialPrompt?: string): Promise<void> {
  const projectRoot = findProjectRoot(runtime.cwd);
  const projectName = basename(projectRoot);
  let branch = '';
  void gitBranch(projectRoot).then((b) => {
    branch = b;
    scheduleRender();
  });
  let modelShort = runtime.config.model.model.split('/').pop() ?? runtime.config.model.model;

  // Synchronize saved theme immediately on launch
  const savedTheme = getCurrentTheme();
  setTheme(savedTheme.id);

  const state = {
    input: '',
    cursor: 0,
    history: [] as string[],
    historyIndex: -1,
    lines: [] as Line[],
    tasks: new Map<string, TaskView>(),
    busy: false,
    spinner: 0,
    scroll: 0,
    startedAt: Date.now(),
    promptActive: false,
    menuActive: false,
    menuTitle: '',
    menuItems: [] as string[],
    menuSelected: 0,
    menuMark: new Set<number>(),
    currentTool: '' as string,
    currentTask: '' as string,
    activeSubagents: new Map<string, { id: string; role: string; prompt: string; startedAt: number }>(),
    /** Args of in-flight tool calls, keyed by tool_call_id (or tool name).
     *  Stored at tool:called time so the matching tool:completed can render
     *  the full card showing the call AND the result in one frame. */
    activeToolArgs: new Map<string, unknown>(),
    /** Line index of each in-flight tool card, keyed by tool_call_id. */
    activeToolLine: new Map<string, number>(),
    tokenVelocity: 0 as number,
    lastUsageAt: 0 as number,
    lastTokens: 0 as number,
    lastStatus: '' as string,
    chatVer: 0 as number,
    trimmed: 0 as number,
    limit: 500 as number,
    /** cline-style plan/act mode (Tab) */
    uiMode: (runtime.config.planMode ? 'plan' : 'act') as 'plan' | 'act',
    /** auto-approve all (Shift+Tab) — mirrors /yolo */
    autoApprove: (runtime as any).__permPolicy === 'yolo',
    autoImproveArmed: false,
    /** slash autocomplete */
    dropActive: false,
    dropSelected: 0,
    /** live git diff stats for the status bar */
    gitDiff: null as { files: number; additions: number; deletions: number } | null,
    totalTokens: 0,
    totalCost: 0,
    /** real provider usage from usage:updated events */
    inTokens: 0,
    outTokens: 0,
    cacheTokens: 0,
    /** splash animation tick + real startup progress (0..1) */
    splashTick: 0,
    splashProgress: 0,
    splashBurst: 0,
    splashDismissed: false,
    /** true while the user has scrolled up away from the bottom (prevents
     *  live events from yanking the view back to the newest line). */
    userScrolled: false,
    /** mouse text selection (click-drag). Coordinates are terminal (row,col),
     *  row relative to the transcript area top. */
    selActive: false,
    selStart: null as { row: number; col: number } | null,
    selEnd: null as { row: number; col: number } | null,
    /** true while receiving a bracketed-paste block. */
    pasting: false,
    /** set true to abort the current auto-improve loop. */
    autoImproveAbort: false,
  };

  let pendingResolver: ((v: string) => void) | undefined;
  let pendingPrompt: string | undefined;
  let menuResolver: ((i: number) => void) | undefined;
  let lastEscAt = 0;
  let lastCtrlCAt = 0;

  let schedulerTimer: NodeJS.Timeout | undefined;
  let renderQueued = false;
  let renderPaused = false;
  let pasteBuffer = '';
  let lastRenderAt = 0;
  let exited = false;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let cleanupFns: Array<() => void> = [];
  /** Incremental transcript cache: stores the wrapped output per source line,
   *  so each frame only re-wraps lines whose text changed (the newly appended
   *  tail + the actively-streaming last line) instead of the whole 500-line
   *  transcript. This is the fix for the freeze while the agent works. */
  let transCache: { text: string; kind: LineKind; out: string[] }[] = [];
  let transMw = 0;
  /** How many head-trims the cache has already absorbed (see transcriptLines). */
  let transSeenTrimmed = 0;

  const width = () => process.stdout.columns || 100;
  const height = () => process.stdout.rows || 34;

  const push = (kind: LineKind, text: string) => {
    // Splash stays visible until user sends a message
    const last = state.lines[state.lines.length - 1];
    if (last && last.kind === kind && last.text === text) return;
    state.lines.push({ kind, text });
    state.chatVer++;
    trimTranscript(state);
    if (!state.userScrolled) state.scroll = 0;
    scheduleRender();
  };

  let lastRenderTime = 0;
  const scheduleRender = () => {
    if (renderQueued || renderPaused) return;
    renderQueued = true;
    const elapsed = Date.now() - lastRenderTime;
    const delay = elapsed >= 30 ? 0 : 30 - elapsed;
    setTimeout(() => {
      renderQueued = false;
      lastRenderTime = Date.now();
      render();
    }, delay);
  };

  const startSpinner = () => {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      state.spinner = (state.spinner + 1) % 60;
      if (state.splashTick < SPLASH_TICKS) {
        state.splashTick++;
        state.splashProgress = Math.min(1, state.splashTick / SPLASH_TICKS);
        if (state.splashTick >= SPLASH_TICKS) {
          state.splashProgress = 1;
        }
      } else {
        state.splashTick = (state.splashTick + 1) % 60000;
      }
      if (state.splashDismissed && !state.busy && state.splashProgress >= 1) {
        stopSpinner();
      }
      scheduleRender();
    }, 60);
    // Freeze-guard: if something starves event-driven renders for > 800ms,
    // force a redraw so the TUI can never appear frozen mid-task.
    schedulerTimer = setInterval(() => {
      if (state.busy && Date.now() - lastRenderAt > 800) scheduleRender();
    }, 300);
  };

  const stopSpinner = () => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = undefined; }
  };
  // `wrap` and `visibleLen` are imported from ./wrap.js (shared, testable).

  function prettifyToolCall(text: string): string | undefined {
    const m = text.trim().match(/^(shell|read|write|edit|search|git|inspect|glob|memory|delete)\(([\s\S]*)\)$/);
    if (!m) return undefined;
    const [, name, args] = m;
    const get = (key: string) => {
      const r = args.match(new RegExp(`"${key}":\\s*"([^"]+)"`));
      return r?.[1];
    };
    const getRaw = (key: string) => {
      const r = args.match(new RegExp(`"${key}":\\s*"([\\s\\S]*?)"(?:,|\\s*\\})`));
      return r?.[1]?.replace(/\\n/g, ' ');
    };
    if (name === 'shell') return `shell: ${get('description') ?? get('command') ?? ''}`;
    if (name === 'read') return `read: ${get('path') ?? ''}`;
    if (name === 'write') return `write: ${get('path') ?? ''}`;
    if (name === 'edit') return `edit: ${get('path') ?? ''}`;
    if (name === 'delete') return `delete: ${get('path') ?? ''}`;
    if (name === 'search') return `search: ${get('query') ?? get('text') ?? ''}`;
    if (name === 'git') return `git: ${get('command') ?? get('subcommand') ?? ''}`;
    if (name === 'inspect') return `inspect: ${get('path') ?? ''}`;
    if (name === 'glob') return `glob: ${get('pattern') ?? ''}`;
    if (name === 'memory') return `memory: ${get('operation') ?? ''}`;
    return `${name}: ${get('description') ?? get('command') ?? get('path') ?? get('query') ?? ''}`;
  }

  // ---- git diff stats for the status bar -------------------------------
  // Throttled: spawning `git diff --numstat` on every tool event (and every
  // force-render while busy) was stalling the UI loop during heavy work.
  let gitStatsTimer: NodeJS.Timeout | undefined;
  let gitStatsInFlight = false;
  async function refreshGitStats(force = false) {
    if (!force && (gitStatsTimer || gitStatsInFlight)) return; // already queued/flying
    gitStatsTimer = setTimeout(() => { gitStatsTimer = undefined; }, 1500);
    gitStatsInFlight = true;
    const stats = await gitDiffStats(projectRoot);
    gitStatsInFlight = false;
    state.gitDiff = stats;
  }

  function transcriptLines(maxWidth: number): string[] {
    // Scale the cache on resize or when the source shrank; otherwise keep the
    // wrapped rows and only re-wrap whatever changed (appended lines and the
    // actively-streaming last line), avoiding O(n) transcript rebuilds per frame.
    if (transMw !== maxWidth || transCache.length > state.lines.length) {
      transCache = [];
      transMw = maxWidth;
      transSeenTrimmed = state.trimmed;
    }
    // Head-trim realignment: once the transcript passes `limit`, every new
    // line drops the oldest one and shifts ALL indices down. Without this
    // mirror-splice, the dirty-scan below mismatched at index 0 after every
    // trim and re-wrapped the whole 500-line transcript every frame — the
    // second, cap-triggered half of the "frozen while working" bug.
    const trims = state.trimmed - transSeenTrimmed;
    if (trims > 0) {
      transCache.splice(0, Math.min(trims, transCache.length));
      transSeenTrimmed = state.trimmed;
    }
    // Grow the cache to match lines, copying prior rows, then find the first
    // changed source line and re-wrap everything from there.
    const grow = transCache.length;
    for (let i = grow; i < state.lines.length; i++) transCache.push({ text: '', kind: 'plain' as LineKind, out: [] });
    let dirty = 0;
    while (
      dirty < transCache.length &&
      dirty < state.lines.length &&
      transCache[dirty].text === state.lines[dirty].text &&
      (transCache[dirty] as any).kind === state.lines[dirty].kind
    ) dirty++;
    for (let i = dirty; i < state.lines.length; i++) {
      transCache[i].text = state.lines[i].text;
      (transCache[i] as any).kind = state.lines[i].kind;
      transCache[i].out = wrapLine(state.lines[i], maxWidth);
    }
    transCache.length = state.lines.length;
    const outLines: string[] = [];
    for (const row of transCache) {
      for (const l of row.out) outLines.push(l);
    }
    return outLines;
  }

  /** ANSI-aware wrap: split a colored line into rows <= max visible columns,
   *  preserving the active SGR state across line breaks. */
  function wrapAnsi(line: string, max: number): string[] {
    if (visibleLen(line) <= max) return [line];
    const rows: string[] = [];
    let cur = '';
    let curLen = 0;
    let lastSpace = -1;
    let sgr = '';
    const parts = line.match(/(\x1b\[[0-9;]*m|[^\n])/g) ?? [];
    for (const p of parts) {
      if (p.startsWith('\x1b')) {
        cur += p;
        sgr = p === '\x1b[0m' ? '' : p;
        continue;
      }
      if (curLen >= max) {
        if (lastSpace > 0) {
          const head = cur.slice(0, lastSpace);
          const tail = cur.slice(lastSpace + 1);
          rows.push(head);
          cur = sgr + tail + p;
          curLen = visibleLen(tail) + 1;
          lastSpace = -1;
        } else {
          rows.push(cur);
          cur = sgr + p;
          curLen = 1;
        }
      } else {
        if (p === ' ') lastSpace = curLen;
        cur += p;
        curLen++;
      }
    }
    if (cur) rows.push(cur);
    return rows;
  }

  /** Wrap a single transcript line into rendered, wrapped output rows.
   *  Production visual language: compact semantic rows from cards.ts keep
   *  their ANSI colors; agent prose renders as terminal prose (no glyph
   *  gutters); metadata stays muted. */
  function wrapLine(line: Line, maxWidth: number): string[] {
    if (line.kind === 'goal') return [];
    if (line.kind === 'system' && line.text.startsWith('Tokens used:')) return [];
    if (!line.text.trim()) return [];
    const cleanText = line.text.replace(/\x1b\[[0-9;]*m/g, '');
    const rows: string[] = [];

    switch (line.kind) {
      case 'user': {
        // 2-space gutter + ❯ accent + background-fill + bold fg text
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`  ${R.userGutter}${T.bold}❯${T.reset} ${R.userBg}${R.userFg}${T.bold}${w}${T.reset}`);
          else rows.push(`  ${R.userBg}${R.userFg}${T.bold}${w}${T.reset}`);
        }
        break;
      }
      case 'assistant': {
        // Terminal prose — live markdown rendering (bold, inline code,
        // headings, bullets, code blocks), ANSI-wrapped to viewport width.
        const mdRows = renderMarkdown(cleanText);
        for (const r of mdRows) {
          for (const w of wrapAnsi(r, Math.max(20, maxWidth - 2))) {
            rows.push(`  ${w}`);
          }
        }
        break;
      }
      case 'tool': {
        // Compact semantic rows from cards.ts — keep ANSI colors intact.
        const text = prettifyToolCall(line.text) ?? line.text;
        if (!text.trim()) return [];
        for (const src of text.split('\n')) {
          if (!src.trim()) { rows.push(''); continue; }
          for (const r of wrapAnsi(src, Math.max(20, maxWidth - 2))) {
            rows.push(`  ${r}`);
          }
        }
        break;
      }
      case 'error': {
        // ! gutter + [ERR] tag, bold
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`  ${R.errorMark}${T.bold}! [ERR]${T.reset} ${R.errorText}${w}${T.reset}`);
          else rows.push(`  ${R.errorText}${w}${T.reset}`);
        }
        break;
      }
      case 'system': {
        // Muted secondary info — no per-line glyphs.
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (const w of wrapped) {
          rows.push(`  ${T.dim}${R.systemText}${w}${T.reset}`);
        }
        break;
      }
      case 'task': {
        // ★ gutter + [TASK] tag
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`  ${R.taskMark}${T.bold}★ [TASK]${T.reset} ${R.taskText}${w}${T.reset}`);
          else rows.push(`  ${T.dim}${R.toolGenericName}${w}${T.reset}`);
        }
        break;
      }
      case 'thought': {
        // Hidden reasoning — plain dim italic, no glyph spam.
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (const w of wrapped) {
          rows.push(`  ${T.dim}${T.italic}${R.thoughtText}${w}${T.reset}`);
        }
        break;
      }
      default: {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth));
        for (const w of wrapped) {
          rows.push(`  ${R.assistantText}${w}${T.reset}`);
        }
        break;
      }
    }
    rows.push('');
    return rows;
  }

  // ---- Mouse text-selection: highlight + copy ----------------------------
  /** Recompute the same transcript window renderFrame uses, so selection and
   *  scroll clamping agree with what is actually on screen. */
  function transcriptGeometry(w: number): { chatMw: number; availableH: number } {
    const h = height();
    const statusRows = h >= 20 ? 4 : 3;
    const innerW = Math.max(1, w - 6);
    const textRows = state.input ? wrap(state.input, innerW).length : 1;
    const composerRows = Math.min(Math.max(4, Math.floor(h / 3)), textRows + 2);
    const bottomRows = composerRows + statusRows;
    const contentH = Math.max(1, h - bottomRows);
    const availableH = state.busy ? Math.max(1, contentH - 1) : contentH;
    const indent = transcriptIndent(w);
    const chatMw = Math.min(w - indent * 2, Math.max(24, w - 4));
    return { chatMw, availableH };
  }

  /** Apply the active selection to one rendered transcript content row. `row`
   *  is the terminal row index (0-based) within the chat area; `indent` is the
   *  leading spacing applied at render. Returns the transformed content. */
  function applySelection(content: string, row: number, indent: number): string {
    if (!state.selActive || !state.selStart || !state.selEnd) return content;
    const isStartTop = state.selStart.row <= state.selEnd.row;
    const top = Math.min(state.selStart.row, state.selEnd.row);
    const bottom = Math.max(state.selStart.row, state.selEnd.row);
    if (row < top || row > bottom) return content;

    const len = visibleLen(content);
    // The +1 makes the end column INCLUSIVE: SGR mouse reports the column
    // the cursor was over (1-based), and after we convert to 0-based and
    // subtract the indent, that cell should still be in the selection.
    // Without +1, dragging from col 7 to col 17 over "hello world" copies
    // only "hello worl" — the 'd' at col 17 gets dropped. (VisibleLen
    // counts the gutter markers so an off-by-one here is hard to spot.)
    const inc = (c: number) => Math.max(0, c - indent + 1);
    if (top === bottom) {
      let from = Math.max(0, Math.min(state.selStart.col, state.selEnd.col) - indent);
      let to = inc(Math.max(state.selStart.col, state.selEnd.col));
      if (to === from) to = from + 1; // single-cell click
      to = Math.min(len, to);
      if (to <= from) return content;
      return highlightRange(content, from, to);
    }

    const startCol = isStartTop ? state.selStart.col : state.selEnd.col;
    const endCol = isStartTop ? state.selEnd.col : state.selStart.col;

    if (row === top) {
      const from = Math.max(0, startCol - indent);
      if (from >= len) return content;
      return highlightRange(content, from, len);
    }
    if (row === bottom) {
      const to = Math.min(len, inc(endCol));
      if (to <= 0) return content;
      return highlightRange(content, 0, to);
    }
    return highlightRange(content, 0, len);
  }

  /** Extract the visible text inside the current selection (plain, no ANSI). */
  function selectedText(): string {
    if (!state.selActive || !state.selStart || !state.selEnd) return '';
    const w = width();
    const { chatMw, availableH } = transcriptGeometry(w);
    const indent = transcriptIndent(w);
    const chatLines = transcriptLines(chatMw);
    const windowStart = Math.max(0, chatLines.length - availableH - state.scroll);
    const isStartTop = state.selStart.row <= state.selEnd.row;
    const topRow = Math.min(state.selStart.row, state.selEnd.row);
    const bottomRow = Math.max(state.selStart.row, state.selEnd.row);
    const startCol = isStartTop ? state.selStart.col : state.selEnd.col;
    const endCol = isStartTop ? state.selEnd.col : state.selStart.col;

    // SGR mouse reports the column the cursor was over (1-based, then
    // converted to 0-based in the mouse handler). After subtracting the
    // indent, that cell is at index col - indent, but the slice end is
    // exclusive so we add 1 to make it inclusive. Without this, dragging
    // to col 17 over "hello world" copies only "hello worl" — the last
    // cell the cursor touched is silently dropped.
    const sliceEnd = (c: number) => Math.max(0, c - indent + 1);
    const lines: string[] = [];
    for (let r = topRow; r <= bottomRow; r++) {
      const idx = windowStart + r;
      if (idx < 0 || idx >= chatLines.length) continue;
      const bare = stripAnsi(chatLines[idx]);
      if (topRow === bottomRow) {
        const minCol = Math.min(state.selStart.col, state.selEnd.col);
        const maxCol = Math.max(state.selStart.col, state.selEnd.col);
        const from = Math.max(0, minCol - indent);
        const to = Math.min(bare.length, sliceEnd(maxCol));
        lines.push(from < to ? bare.slice(from, to) : '');
      } else if (r === topRow) {
        const from = Math.max(0, startCol - indent);
        lines.push(bare.slice(from));
      } else if (r === bottomRow) {
        const to = Math.min(bare.length, sliceEnd(endCol));
        lines.push(bare.slice(0, to));
      } else {
        lines.push(bare);
      }
    }
    return lines.join('\n');
  }

  /** Copy a string to the system clipboard: prefer terminal OSC-52 (works over
   *  ssh/inside any terminal that supports it), then xclip / xsel / wl-copy /
   *  pbcopy for a real X11/Wayland/macOS clipboard. Best-effort, never throws.
   *  Returns 'osc52' | 'x11' | 'wayland' | 'pbcopy' | 'failed' so callers can
   *  tell the user whether their copy went through. */
  function copyToClipboard(text: string): 'osc52' | 'x11' | 'wayland' | 'pbcopy' | 'failed' {
    if (!text) return 'failed';
    // OSC-52 needs no local tools and survives remote sessions. It is also
    // silently absorbed if the terminal doesn't support it, so the binary
    // fallback below handles the case where the host terminal doesn't have
    // OSC-52 enabled but the user is sitting at a real desktop.
    let osc52Ok = false;
    try {
      osc52Ok = process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    } catch { /* ignore */ }
    // Run the native-binary fallback on the next tick so the OSC-52 frame
    // gets a chance to flush first.
    let nativeResult: 'x11' | 'wayland' | 'pbcopy' | null = null;
    setImmediate(() => {
      const feed = (p: ReturnType<typeof spawn> | null) => {
        if (!p || !p.stdin) return;
        p.stdin.on('error', () => {});
        p.stdin.end(Buffer.from(text, 'utf8'));
      };
      const tryChain = (cmds: Array<{ bin: string; args: string[]; tag: 'x11' | 'wayland' | 'pbcopy' }>, idx = 0): void => {
        if (idx >= cmds.length) return;
        const { bin, args, tag } = cmds[idx];
        let p: ReturnType<typeof spawn>;
        try {
          p = spawn(bin, args);
        } catch {
          tryChain(cmds, idx + 1);
          return;
        }
        p.on('error', () => tryChain(cmds, idx + 1));
        p.on('spawn', () => {
          nativeResult = tag;
          feed(p);
        });
      };
      if (process.env.WAYLAND_DISPLAY) {
        tryChain([
          { bin: 'wl-copy', args: ['--type', 'text/plain'], tag: 'wayland' },
          { bin: 'xsel', args: ['-ib'], tag: 'x11' },
        ]);
      } else {
        tryChain([
          { bin: 'xclip', args: ['-selection', 'clipboard'], tag: 'x11' },
          { bin: 'pbcopy', args: [], tag: 'pbcopy' },
        ]);
      }
    });
    return osc52Ok ? 'osc52' : nativeResult ?? 'failed';
  }

  function beginSelection(row: number, col: number) {
    state.selStart = { row, col };
    state.selEnd = { row, col };
    state.selActive = true;
    lastFrame = [];
    scheduleRender();
  }

  function updateSelection(row: number, col: number) {
    if (!state.selActive) return;
    state.selEnd = { row, col };
    lastFrame = [];
    scheduleRender();
  }

  function endSelection() {
    if (state.selActive) {
      const t = selectedText();
      if (t && t.length > 0) {
        const via = copyToClipboard(t);
        const lines = t.split('\n').length;
        const word = lines > 1 ? ` (${lines} lines)` : '';
        if (via === 'failed') {
          push(
            'system',
            `Selected ${t.length} char${t.length !== 1 ? 's' : ''}${word}, but clipboard copy failed. ` +
              `Install xclip / wl-copy / pbcopy, or hold Shift while dragging for the host terminal's native selection.`,
          );
        } else {
          const label = via === 'osc52' ? 'terminal' : via;
          push('system', `Copied ${t.length} char${t.length !== 1 ? 's' : ''}${word} to clipboard via ${label}.`);
        }
        scheduleRender();
      } else {
        // The drag produced a visible highlight but the underlying cell
        // content is empty (e.g. user dragged across the splash screen,
        // or across a blank line below the chat). Tell them what to do
        // instead instead of silently doing nothing.
        const onSplash = !state.splashDismissed && state.lines.length === 0;
        if (onSplash) {
          push(
            'system',
            'No text to copy yet — the drag landed on the splash screen. ' +
              'Send mochi a message first, then drag-select the chat. ' +
              'Tip: /copy works without the mouse.',
          );
        } else {
          push(
            'system',
            'No text in the selected region (drag landed on a blank area). ' +
              'Tip: /copy pastes the last assistant message.',
          );
        }
        clearSelection();
        scheduleRender();
      }
    }
  }

  function clearSelection() {
    state.selActive = false;
    state.selStart = null;
    state.selEnd = null;
  }

  function currentDropItems() {
    const head = state.input.split(' ')[0];
    if (!head.startsWith('/')) return [];
    return COMMANDS.filter((c) => c.name.startsWith(head));
  }

  let lastFrame: string[] = [];
  let lastW = 0;

  function render() {
    if (exited) return;
    // A single bad frame must never freeze the whole UI. If a frame throws we
    // surface the real error, then PAUSE rendering (front-burner) instead of
    // rescheduling a throwing frame every 300ms, which itself pegs the loop and
    // looks like a freeze. The user can recover with Esc / typing.
    try {
      renderFrame();
    } catch (e) {
      renderQueued = false;
      const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      process.stdout.write(`${RESET}${SHOW}\r\n${T.error}[render error] ${msg}${RESET}\r\n${HIDE}`);
      // Back off: only resume renders from a real event (typing, resize), not
      // from an automatic retry, so a persistent bug can't wedge the loop.
      renderPaused = true;
    }
  }

  function renderFrame() {
    const w = width();
    const h = height();

    // Refactored layout
    const statusRows: number = h >= 20 ? 3 : 2; 
    const innerW = Math.max(1, w - 6);
    const rawRows = state.input ? wrap(state.input, innerW) : [''];
    
    // Composer expands as user types, up to 1/3 of screen height
    const composerBoxRows = Math.min(Math.max(4, Math.floor(h / 3)), rawRows.length + 2);
    const composerRows = composerBoxRows;
    
    // Bottom consists of composer, status bars, and auto-approve row
    const bottomRows = composerRows + statusRows + 1;
    const contentH = Math.max(1, h - bottomRows);

    const indent = transcriptIndent(w);
    const chatMw = Math.min(w - indent * 2, Math.max(24, w - 4));
    
    const availableH = state.busy ? Math.max(1, contentH - 1) : contentH;
    const chatLines = transcriptLines(chatMw);
    const visible = chatLines.slice(Math.max(0, chatLines.length - availableH - state.scroll), Math.max(0, chatLines.length - state.scroll));

    const rows: string[] = new Array(h).fill('');
    const lead = ' '.repeat(indent);
    
    const showSplash = !state.splashDismissed && state.lines.length === 0;
    if (showSplash) {
      const splash = splashFrame(state.splashTick, w, pkg.version, state.splashProgress, state.splashBurst);
      const top = Math.max(0, Math.floor((contentH - splash.length) / 2));
      for (let i = 0; i < splash.length && i < contentH; i++) {
        // Apply selection to splash rows too so drag-select works from the
        // very first frame (before any chat lines exist).
        rows[top + i] = lead + applySelection(splash[i], top + i, indent);
      }
    } else {
      for (let i = 0; i < availableH && i < contentH; i++) {
        const r = i;
        rows[r] = lead + applySelection(visible[i] ?? '', r, indent);
      }
    }

    if (state.busy) {
      const r = Math.max(0, contentH - 1);
      rows[r] = '  ' + thinkingLine(state.spinner, state.currentTool || state.currentTask || '');
    }

    // autocomplete dropdown floats above the status bar
    const dropItems = currentDropItems();
    if (dropItems.length && !state.menuActive) {
      const dd = renderDropdown(dropItems.slice(0, 6).map((c) => ({ name: c.name, hint: c.hint })), state.dropSelected, w - indent);
      const top = h - bottomRows - dd.length - 1;
      for (let i = 0; i < dd.length; i++) {
        const r = top + i;
        if (r >= 0 && r < h) rows[r] = lead + dd[i];
      }
    }

    const extra: string[] = [];
    if (kvCache.badge()) extra.push(kvCache.badge());
    const queued = [...state.tasks.values()].filter((t) => t.status === 'pending').length;
    if (queued) extra.push(`${queued} queued`);
    const activeSubs = state.activeSubagents ? [...state.activeSubagents.values()] : [];
    if (activeSubs.length > 0) {
      const roles = activeSubs.map((s) => `#${s.role}`).join(', ');
      extra.push(`⚡ ${activeSubs.length} subagents (${roles})`);
    }
    if (state.tokenVelocity && state.tokenVelocity > 0) {
      extra.push(`⚡ ${state.tokenVelocity} tok/s`);
    }
    const statusModel = {
      modelId: modelShort,
      totalTokens: state.inTokens + state.outTokens + state.cacheTokens,
      totalCost: state.totalCost,
      maxInputTokens: runtime.config.safety.contextBudgetTokens,
      mode: state.uiMode,
      agentMode: (runtime.config.mode as any) ?? 'normal',
      reasoningLevel: runtime.getReasoning(),
      workspaceName: projectName,
      gitBranch: branch || null,
      gitDiff: state.gitDiff,
      autoApprove: state.autoApprove,
      extra,
    };

    const s1 = h - bottomRows;
    rows[s1] = statusBarRow1(statusModel, w);
    let cTop = s1 + 1;
    
    if (statusRows === 3) {
      const promptTotal = state.inTokens + state.cacheTokens;
      const cacheRate = promptTotal > 0 ? Math.min(1, state.cacheTokens / promptTotal) : 0;
      const ctx = gradientContextBar(state.inTokens + state.outTokens, runtime.config.safety.contextBudgetTokens, 12, state.busy ? state.spinner + 1 : 0);
      const cache = gradientCacheBar(cacheRate, 10, state.busy ? state.spinner + 1 : 0);
      const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
      const cachePctText = cacheRate > 0 ? ` ${T.gray}(${Math.round(cacheRate * 100)}%)${T.reset}` : '';
      const barsRow = ` ${T.gray}in${T.reset} ${T.cyan}${fmt(state.inTokens)}${T.reset} ${T.gray}out${T.reset} ${T.orange}${fmt(state.outTokens)}${T.reset}  ${ctx.text} ${T.gray}${Math.round(ctx.pct * 100)}%${T.reset}  ${T.gray}cache${T.reset} ${cache.text} ${T.lime}${fmt(state.cacheTokens)}${T.reset}${cachePctText}`;
      
      rows[s1 + 1] = barsRow;
      rows[s1 + 2] = statusBarRow2(statusModel, w);
      rows[s1 + 3] = composerHintRow(' ⏎ send · Tab plan/act · ESC stop · / for commands', w);
      cTop = s1 + 4;
    } else {
      rows[s1 + 1] = statusBarRow2(statusModel, w);
      rows[s1 + 2] = composerHintRow(' ⏎ send · Tab plan/act · ESC stop · / for commands', w);
      cTop = s1 + 3;
    }

    rows[cTop] = composerTopRule(w);
    const visibleTextRows = composerBoxRows - 2;
    const shownRows = rawRows.slice(-visibleTextRows);
    for (let i = 0; i < visibleTextRows; i++) {
      const r = cTop + 1 + i;
      if (r < h) {
        if (i < shownRows.length) {
          rows[r] = composerRow(shownRows[i], w);
        } else if (i === 0 && !state.input) {
          rows[r] = composerPlaceholderRow('Message mochi… (type / for commands)', w);
        } else {
          rows[r] = composerRow('', w);
        }
      }
    }
    rows[cTop + visibleTextRows + 1] = composerBottomRule(w);
    
    // ---- Sleek centered modal menu overlay with scrolling window ----
    if (state.menuActive) {
      const totalItems = state.menuItems.length;
      const maxVisibleItems = Math.min(totalItems, Math.max(5, h - 8));
      const menuH = maxVisibleItems + 3;
      const menuTop = Math.max(1, Math.floor((h - menuH) / 2));
      const menuW = Math.min(Math.max(68, Math.floor(w * 0.76)), w - 4);
      const mLeft = Math.max(0, Math.floor((w - menuW) / 2));
      const pad = ' '.repeat(mLeft);

      // Windowed scrolling offset
      let scrollOffset = 0;
      if (totalItems > maxVisibleItems) {
        scrollOffset = Math.max(0, Math.min(totalItems - maxVisibleItems, state.menuSelected - Math.floor(maxVisibleItems / 2)));
      }

      // Title bar: ╭── Title [count] ──────────────────────────╮
      const titleText = ` ${state.menuTitle} `;
      const countBadge = totalItems > 1 ? ` [${state.menuSelected + 1}/${totalItems}] ` : ' ';
      const ruleWidth = Math.max(0, menuW - 2 - visibleLen(titleText) - visibleLen(countBadge));
      rows[menuTop] = pad + T.rule + '╭─' + T.reset + T.bold + titleText + T.reset + T.grayDark + countBadge + T.reset + T.rule + '─'.repeat(ruleWidth) + '╮' + T.reset;

      const innerW = menuW - 4;
      for (let i = 0; i < maxVisibleItems; i++) {
        const itemIdx = scrollOffset + i;
        const r = menuTop + 1 + i;
        if (r >= h) break;
        const sel = itemIdx === state.menuSelected;
        const rawItem = state.menuItems[itemIdx] ?? '';
        const mark = state.menuMark.has(itemIdx);

        const pointer = sel ? `${T.act}${T.bold}❯${T.reset} ` : '  ';
        const activeDot = mark && !rawItem.includes('[ACTIVE]') ? `${T.lime}● ${T.reset}` : '';
        const prefix = pointer + activeDot;
        const availForItem = Math.max(10, innerW - visibleLen(prefix));

        let formattedItem = rawItem;
        if (visibleLen(rawItem) > availForItem) {
          formattedItem = ellipsize(rawItem, availForItem);
        }

        const itemVis = visibleLen(formattedItem);
        const trail = Math.max(0, availForItem - itemVis);
        const content = prefix + (sel ? `${T.bold}${T.fg}` : '') + formattedItem + T.reset + ' '.repeat(trail);

        rows[r] = pad + T.rule + '│' + T.reset + ' ' + content + ' ' + T.rule + '│' + T.reset;
      }

      // Footer bar: ╰── ↑/↓ scroll · ⏎ select · esc cancel ─────╯
      const footerHint = ' ↑/↓ scroll · ⏎ select · esc cancel ';
      const footerRule = Math.max(0, menuW - 2 - visibleLen(footerHint));
      const rLeft = Math.floor(footerRule / 2);
      const rRight = Math.max(0, footerRule - rLeft);
      rows[menuTop + 1 + maxVisibleItems] = pad + T.rule + '╰' + '─'.repeat(rLeft) + T.reset + T.grayDark + footerHint + T.reset + T.rule + '─'.repeat(rRight) + '╯' + T.reset;
    }

    let out = HIDE;
    if (lastW !== w || lastFrame.length !== h) {
      out += '\x1b[2J';
      lastFrame = [];
    }
    for (let i = 0; i < h; i++) {
      const line = rows[i] ?? '';
      if (line !== lastFrame[i]) {
        out += '\x1b[' + (i + 1) + ';1H' + line + '\x1b[K';
      }
    }
    // Cursor placement: the composer spans the FULL terminal width from col 0,
    // so the caret column is exactly (❯ prefix + 2 spaces) + wrapped col —
    // no transcript indent. Row tracks the cursor's actual wrapped line,
    // scrolled into the visible window like the text itself.
    const beforeCursor = state.input.slice(0, state.cursor);
    const beforeLines = wrap(beforeCursor, innerW);
    const cursorVisualRow = Math.max(0, beforeLines.length - 1);
    const firstVisibleRow = Math.max(0, rawRows.length - shownRows.length);
    const cursorRow = cTop + 1 + Math.max(0, cursorVisualRow - firstVisibleRow);
    const cursorCol = 4 + (beforeLines.length ? visibleLen(beforeLines[beforeLines.length - 1]) : 0);
    out += '\x1b[' + (cursorRow + 1) + ';' + (cursorCol + 1) + 'H' + SHOW;
    process.stdout.write(out);
    lastFrame = rows.slice();
    lastW = w;
    lastRenderAt = Date.now();
  }

  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  async function handleCommand(raw: string) {
    const line = raw.trim();
    if (!line) return;

    state.history.push(line);
    state.historyIndex = -1;
    state.input = '';
    state.cursor = 0;

    if (line === '/exit' || line === '/quit') {
      exit();
      return;
    }
    if (line === '/help') { pushHelp(); return; }
    if (line === '/clear') { state.lines = []; state.tasks.clear(); state.scroll = 0; scheduleRender(); return; }
    if (line === '/copy' || line.startsWith('/copy ')) {
      // Keyboard fallback for terminal selection. By default copies the
      // last assistant message; "/copy last" copies the same, "/copy N"
      // copies the Nth-most-recent message.
      const arg = line.startsWith('/copy ') ? line.slice(6).trim() : '';
      const lastAssistantIdx = (() => {
        for (let i = state.lines.length - 1; i >= 0; i--) {
          if (state.lines[i].kind === 'assistant') return i;
        }
        return -1;
      })();
      const lastErrorIdx = (() => {
        for (let i = state.lines.length - 1; i >= 0; i--) {
          if (state.lines[i].kind === 'error') return i;
        }
        return -1;
      })();
      if (arg === 'last' || arg === '') {
        if (lastAssistantIdx >= 0) {
          const t = state.lines[lastAssistantIdx].text;
          const via = copyToClipboard(t);
          push('system', via === 'failed'
            ? `Could not copy last assistant message (no clipboard tool found). Install xclip / wl-copy / pbcopy.`
            : `Copied last assistant message (${t.length} chars) to clipboard via ${via === 'osc52' ? 'terminal' : via}.`);
        } else {
          push('system', 'No assistant message to copy yet.');
        }
        scheduleRender();
        return;
      }
      if (arg === 'err' || arg === 'error') {
        if (lastErrorIdx >= 0) {
          const t = state.lines[lastErrorIdx].text;
          const via = copyToClipboard(t);
          push('system', via === 'failed'
            ? `Could not copy last error (no clipboard tool found).`
            : `Copied last error (${t.length} chars) to clipboard via ${via === 'osc52' ? 'terminal' : via}.`);
        } else {
          push('system', 'No error to copy yet.');
        }
        scheduleRender();
        return;
      }
      // Numeric: copy Nth-most-recent line
      const n = parseInt(arg, 10);
      if (!isNaN(n) && n > 0 && n <= state.lines.length) {
        const idx = state.lines.length - n;
        const t = state.lines[idx].text;
        const via = copyToClipboard(t);
        push('system', via === 'failed'
          ? `Could not copy line (no clipboard tool found).`
          : `Copied line ${n} (${t.length} chars) to clipboard via ${via === 'osc52' ? 'terminal' : via}.`);
        scheduleRender();
        return;
      }
      push('system', `Usage: /copy [last | err | N] — copies to clipboard`);
      scheduleRender();
      return;
    }
    if (line === '/status' || line === '/changes') { await run(async () => (await import('../git.js')).status(projectRoot)); return; }
    if (line === '/diff') { await run(async () => (await import('../git.js')).diff(projectRoot)); return; }
    if (line === '/mode' || line.startsWith('/mode ')) {
      const specific = line.startsWith('/mode ') ? line.slice(6).trim() : '';
      if (!specific) {
        push('system', `${formatModes((runtime.config.mode as any) ?? 'normal')}\n\nUsage: /mode <name>`);
        return;
      }
      await run(async () => {
        const res = runtime.setMode(specific);
        return res.startsWith('Unknown')
          ? res
          : `Mode set: ${specific}${res === 'normal' ? '' : `\n${res.trim()}`}`;
      });
      return;
    }
    if (line === '/modes') {
      push('system', formatModes((runtime.config.mode as any) ?? 'normal'));
      return;
    }
    if (line === '/plugins') {
      const { PluginRegistry } = await import('../plugins.js');
      const records = new PluginRegistry(resolve(projectRoot, '.mochi', 'plugins')).list();
      if (!records.length) { push('system', 'No plugins installed. Use: mochi plugin add <dir>'); return; }
      push('system', records.map((p) => `${p.name} v${p.version} [${p.scope}] ${p.description}${p.hooks.length ? ` hooks:${p.hooks.join(',')}` : ''}`).join('\n'));
      return;
    }
    if (line === '/rules') {
      const { loadRules } = await import('../rules.js');
      const all = loadRules(projectRoot);
      if (!all.length) { push('system', 'No modular rules found in .mochi/rules/.'); return; }
      push('system', `🍡 Modular Project Rules (${all.length}):\n` + all.map(r => `• ${r.id.padEnd(16)} "${r.title}"`).join('\n'));
      return;
    }
    if (line.startsWith('/symbols ') || line === '/symbols' || line.startsWith('/find ') || line === '/find') {
      const query = (line.startsWith('/symbols ') ? line.slice(9) : line.startsWith('/find ') ? line.slice(6) : '').trim();
      await run(async () => {
        const { generateProjectDocs } = await import('../docgen.js');
        const docs = generateProjectDocs(projectRoot);
        const matches: string[] = [];
        for (const mod of docs.modules) {
          for (const s of mod.symbols) {
            if (!query || s.signature.toLowerCase().includes(query.toLowerCase())) {
              matches.push(`  ${mod.file}:${s.line} [${s.kind}] ${s.signature}`);
            }
          }
        }
        if (!matches.length) return `No symbols found matching "${query}".`;
        return `Symbol Search (${matches.length} matches):\n` + matches.slice(0, 30).join('\n') + (matches.length > 30 ? `\n  ... and ${matches.length - 30} more.` : '');
      });
      return;
    }
    if (line === '/docgen' || line === '/docs') {
      await run(async () => {
        const { generateProjectDocs } = await import('../docgen.js');
        const docs = generateProjectDocs(projectRoot);
        return docs.markdown;
      });
      return;
    }
    if (line === '/profiles') { await run(async () => runtime.profiles().map(p => `${p.name} (${p.role}) model=${p.defaultModel ?? 'coding'} verification=${p.verification ?? 'optional'}`).join('\n')); return; }
    if (line === '/memory') { await run(async () => runtime.memory() || 'No project memory yet.'); return; }
    if (line === '/tasks') { await run(async () => listTasks()); return; }
    if (line === '/checkpoint') { await run(async () => { const cp = await runtime.checkpoint(); return `${cp.type} ${cp.ref}`; }); return; }
    if (line === '/rollback') { await run(async () => runtime.rollback()); return; }
    if (line.startsWith('/inspect ') || line === '/inspect') {
      const target = line.startsWith('/inspect ') ? line.slice(9).trim() : await ask('Symbol or file to inspect:');
      if (target) {
        push('user', `/inspect ${target}`);
        scheduleRender();
        await run(async () => (await runtime.inspect(target)).summary);
      }
      return;
    }
    if (line.startsWith('/plan ') || line === '/plan') {
      const obj = line.startsWith('/plan ') ? line.slice(6).trim() : await ask('Objective to plan:');
      if (obj) {
        push('user', `/plan ${obj}`);
        push('goal', `Plan: ${obj}`);
        scheduleRender();
        await run(async () => runtime.plan(obj), true);
      }
      return;
    }
    if (line === '/approve') { await run(async () => runtime.approvePlan(), true); return; }
    if (line.startsWith('/team ') || line === '/team') {
      const obj = line.startsWith('/team ') ? line.slice(6).trim() : await ask('Team goal objective:');
      if (obj) {
        push('user', `/team ${obj}`);
        push('goal', `Team Goal: ${obj}`);
        scheduleRender();
        await run(async () => runtime.team(obj), true);
      }
      return;
    }
    if (line.startsWith('/goal ') || line === '/goal') {
      const obj = line.startsWith('/goal ') ? line.slice(6).trim() : await ask('Goal objective:');
      if (obj) {
        push('user', `/goal ${obj}`);
        push('goal', `Goal: ${obj}`);
        scheduleRender();
        await run(async () => runtime.goal(obj), true);
      }
      return;
    }
    if (line.startsWith('/chameleon ') || line === '/chameleon' || line.startsWith('/enhance ') || line === '/enhance') {
      const task = line.startsWith('/chameleon ')
        ? line.slice(11).trim()
        : line.startsWith('/enhance ')
        ? line.slice(9).trim()
        : await ask('Task to synthesize reasoning parameters for:');
      if (task) {
        push('user', `/chameleon ${task}`);
        scheduleRender();
        await run(async () => {
          const { ChameleonEngine } = await import('../chameleon.js');
          const engine = new ChameleonEngine(runtime.config);
          const r = await engine.enhance({ task, mode: 'auto', cwd: runtime.cwd });
          return `[Lazy Chameleon v2.4 — Mode: ${r.mode}, Strategy: ${r.strategy}, ${r.strategies.length} passes, ${r.tokensUsed} tokens, ${r.durationMs}ms]\n\n${r.context}`;
        });
      }
      return;
    }
    if (line.startsWith('/compact')) { push('system', 'Context compaction is managed automatically.'); return; }
    if (line === '/doctor' || line === '/settings') {
      await run(async () => {
        const { describeConfig } = await import('../model-manager.js');
        return `${describeConfig(runtime.config)}\n\nmodel: ${runtime.config.model.model}\ncat: config`;
      });
      return;
    }
    if (line === '/usage' || line === '/cost' || line === '/tokens' || line === '/stats') {
      await run(async () => {
        const summary = runtime.usage.summary();
        const recent = runtime.usage.recent();
        const cachePct = state.totalTokens > 0 ? Math.round((state.cacheTokens / state.totalTokens) * 100) : 0;
        return (
          `Token & Cost Performance:\n` +
          `  Total Tokens: ${state.totalTokens.toLocaleString()} (${state.cacheTokens.toLocaleString()} cached • ${cachePct}% KV cache hit rate)\n` +
          `  Total Cost: $${state.totalCost.toFixed(4)} USD\n` +
          `  Active Model: ${runtime.config.model.model}\n\n` +
          `Historical Usage:\n${summary}\n\nRecent Turns:\n${recent}`
        );
      });
      return;
    }
    if (line === '/known-good') { await run(async () => runtime.recordGood()); return; }
    if (line === '/check') { await run(async () => runtime.knownGood()); return; }
    if (line === '/providers') { await providerMenu(); return; }
    if (line === '/login' || line === '/provider') { await loginFlow(); return; }
    if (line === '/model' || line.startsWith('/model ')) {
      const specific = line.startsWith('/model ') ? line.slice(7).trim() : '';
      if (specific) {
        await run(async () => {
          const p = providerById(runtime.config.model.provider);
          return p ? (await runtime.useProvider(p.id, specific)) : 'Current provider unknown';
        });
      } else {
        await modelMenu();
      }
      return;
    }
    if (line === '/reasoning' || line.startsWith('/reasoning ') || line === '/depth' || line.startsWith('/depth ')) {
      const specific = (line.startsWith('/reasoning ') ? line.slice(11) : line.startsWith('/depth ') ? line.slice(7) : '').trim();
      if (specific) {
        const desc = runtime.setReasoning(specific);
        push('system', `[REASON] Reasoning mode set to ${runtime.getReasoning().toUpperCase()} — ${desc}`);
        scheduleRender();
      } else {
        await reasoningMenu();
      }
      return;
    }
    if (line === '/theme' || line.startsWith('/theme ') || line === '/themes') {
      const specific = line.startsWith('/theme ') ? line.slice(7).trim() : '';
      if (specific) {
        const t = setTheme(specific);
        push('system', `Theme switched to ${t.name} — ${t.description}`);
        scheduleRender();
      } else {
        await themeMenu();
      }
      return;
    }
    if (line === '/skills' || line.startsWith('/skills ') || line === '/skill' || line.startsWith('/skill ')) {
      const specific = (line.startsWith('/skills ') ? line.slice(8) : line.startsWith('/skill ') ? line.slice(7) : '').trim();
      if (specific) {
        const { loadAllSkills, readSkillBody } = await import('../skills.js');
        const { skills } = loadAllSkills(projectRoot);
        const sk = skills.find((s) => s.name === specific || s.name.toLowerCase().includes(specific.toLowerCase()));
        if (!sk) {
          push('error', `Skill "${specific}" not found. Type /skills to browse available skills.`);
          scheduleRender();
          return;
        }
        const body = readSkillBody(sk, projectRoot);
        push('system', `=== Skill: ${sk.name} ===\n${body || sk.description}`);
        scheduleRender();
      } else {
        await skillsMenu();
      }
      return;
    }
    if (line === '/history' || line === '/sessions' || line === '/resume') {
      await historySessionMenu();
      return;
    }
    if (line === '/rename' || line.startsWith('/rename ')) {
      const specific = line.startsWith('/rename ') ? line.slice(8).trim() : '';
      const { SessionStore } = await import('../session-store.js');
      const store = new SessionStore(projectRoot);
      const list = store.list(1);
      const target = list[0];
      if (!target) {
        push('system', 'No saved session found to rename.');
        scheduleRender();
        return;
      }
      const title = specific || await ask(`New title for session (${target.objective.slice(0, 20)}):`);
      if (title && title.trim()) {
        store.rename(target.id, title.trim());
        push('system', `Session renamed to "${title.trim()}".`);
        scheduleRender();
      }
      return;
    }
    if (line === '/export') { await exportSession(); return; }
    if (line === '/import') { await importFlow(); return; }
    if (line === '/new' || line === '/clear-all') {
      runtime.resetSession();
      runtime.workspace.clearCheckpoint();
      state.lines = [];
      state.tasks.clear();
      state.scroll = 0;
      state.totalTokens = 0;
      state.totalCost = 0;
      state.inTokens = 0;
      state.outTokens = 0;
      state.cacheTokens = 0;
      state.chatVer++;
      push('system', 'Started a completely fresh session.');
      scheduleRender();
      return;
    }
    if (line === '/compact') { await run(async () => { const res = await (await import('../context.js')).approxTokens(state.lines.map(l=>l.text).join('\n')); return `Entire transcript ≈ ${res} tokens. Compaction is managed automatically per-turn.`; }); return; }
    if (line === '/init') { await run(async () => { const { existsSync, writeFileSync } = await import('node:fs'); const { resolve: rp } = await import('node:path'); const p = rp(projectRoot, 'MOCHI.md'); if (existsSync(p)) return 'MOCHI.md already exists.'; writeFileSync(p, `# MOCHI.md\n\nProject instructions for the Mochi coding agent.\n`); return 'Created ' + p; }); return; }
    if (line === '/context') { push('system', `ctx budget: ${runtime.config.safety.contextBudgetTokens.toLocaleString()} tokens · agents: ${runtime.config.safety.maxConcurrentAgents}`); return; }
    if (line === '/branch') { await run(async () => (await import('../git.js')).status(projectRoot)); return; }
    if (line === '/commit') {
      const msg = await ask('Commit message:');
      await run(async () => {
        const { checkpoint } = await import('../git.js');
        const cp = await checkpoint(projectRoot, msg || 'mochi commit');
        return `Committed ${cp.type} ${cp.ref}`;
      });
      return;
    }
    if (line.startsWith('/run ') || line.startsWith('/shell ')) {
      const cmd = line.slice(line.startsWith('/run ') ? 5 : 7).trim();
      await runShell(cmd);
      return;
    }
    if (line === '/test' || line.startsWith('/test ')) {
      const extra = line.slice(6).trim();
      await runTest(extra);
      return;
    }
    if (line === '/stop' || line === '/abort' || line === '/skip') {
      // If an auto-improve loop is in flight, abort the loop itself so the
      // agent stops receiving new passes but the current pass can still
      // finish cleanly (vs. nuking its in-progress tool call).
      state.autoImproveAbort = true;
      runtime.abort('User stopped/skipped in-flight task');
      push('system', '[STOP] Skipped / stopped in-flight task. Auto-improve loop also halted.');
      state.busy = false;
      stopSpinner();
      scheduleRender();
      return;
    }
    if (line === '/undo' || line === '/redo') {
      const cp = runtime.workspace.readJson<{ ref: string; type: 'commit' | 'stash'; message: string }>('checkpoints/latest.json');
      if (!cp) { push('system', 'No checkpoint yet. Run /checkpoint first.'); return; }
      await run(async () => {
        const { restore } = await import('../git.js');
        await restore(projectRoot, cp);
        return `Restored ${cp.type} ${cp.ref}`;
      });
      return;
    }
    // Permission policy slash commands
    if (line === '/yolo' || line === '/yolo on' || line === '/dangerously-skip-permissions' || line === '/dangerously-skip-permissions on') {
      (runtime as any).__permPolicy = 'yolo';
      push('system', '[YOLO] YOLO mode ENABLED — all permission prompts bypassed. Type /yolo off to restore.');
      scheduleRender();
      return;
    }
    if (line === '/yolo off' || line === '/dangerously-skip-permissions off') {
      (runtime as any).__permPolicy = 'strict';
      push('system', '[SAFE] YOLO mode disabled. Strict permissions restored.');
      scheduleRender();
      return;
    }
    if (line === '/workspace-safe') {
      (runtime as any).__permPolicy = 'workspace-safe';
      push('system', '[AUTO] Workspace-safe mode: reads + workspace edits auto-approved, shell requires approval.');
      scheduleRender();
      return;
    }
    if (line === '/rewind') {
      const cpJson = runtime.workspace.readJson<{ ref: string; type: 'commit' | 'stash'; message: string }>('checkpoints/latest.json');
      if (!cpJson) { push('system', 'No checkpoint found. Use /checkpoint first.'); return; }
      await run(async () => {
        const { restore } = await import('../git.js');
        await restore(projectRoot, cpJson);
        return `[REWIND] Rewound to ${cpJson.type} ${cpJson.ref} — "${cpJson.message}"`;
      });
      return;
    }
    if (line === '/audit') {
      await run(async () => {
        const { readFileSync, existsSync } = await import('node:fs');
        const { resolve: rp } = await import('node:path');
        const logPath = rp(runtime.workspace.dir, 'logs', 'audit.jsonl');
        if (!existsSync(logPath)) return 'No audit log yet. Actions are logged when YOLO mode is active.';
        const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).slice(-20);
        return 'Audit log (last 20 entries):\n' + lines.map((l) => {
          try { const e = JSON.parse(l); return `  ${e.ts} ${e.tool} → ${e.decision}`; } catch { return l; }
        }).join('\n');
      });
      return;
    }
    if (line === '/tools') {
      const toolNames = runtime.getToolNames?.() ?? ['read', 'write', 'edit', 'delete', 'search', 'glob', 'shell', 'git', 'inspect', 'memory', 'skill', 'todo'];
      push('system', `${toolNames.length} tools: ${toolNames.join(', ')}`);
      return;
    }

    // Free-form prompt (already echo:false — agent pushes its own turns via events)
    push('user', line);
    if (state.autoImproveArmed) {
      // Auto-improve is on: chain N agent passes, each one receiving the
      // previous best summary. The first pass is the user's literal prompt.
      const passes = (runtime as any).__maxRuns ?? 5;
      state.autoImproveArmed = false;
      state.autoImproveAbort = false;
      await run(async () => {
        let lastSummary = '';
        const total = passes;
        for (let i = 0; i < total; i++) {
          if (state.autoImproveAbort) break;
          const iterPrompt = lastSummary
            ? `${line}\n\n---\n[Auto-improve pass ${i + 1}/${total}]\n\nPrevious best answer:\n${lastSummary.slice(0, 4000)}\n\nContinue: refine, fix remaining issues, deepen the work.`
            : `${line}\n\n---\n[Auto-improve pass ${i + 1}/${total}]`;
          push('system', `◇ auto-improve  pass ${i + 1}/${total}`);
          const pass = await runtime.runPrompt(iterPrompt);
          lastSummary = pass;
          push('assistant', pass);
        }
        push('system', `✓ auto-improve complete: ${total} passes`);
        return lastSummary;
      }, false);
    } else {
      await run(() => runtime.runPrompt(line), false);
    }
  }

  async function run(fn: () => Promise<string>, echo = true) {
    state.busy = true;
    startSpinner();
    scheduleRender();
    try {
      const result = await fn();
      if (echo) push('assistant', result);
    } catch (e) {
      push('error', e instanceof Error ? e.message : String(e));
    } finally {
      state.busy = false;
      stopSpinner();
      scheduleRender();
    }
  }

  function ask(question: string): Promise<string> {
    return new Promise((res) => {
      state.promptActive = true;
      pendingPrompt = question;
      pendingResolver = res;
      state.input = '';
      state.cursor = 0;
      push('system', `? ${question}`);
      scheduleRender();
    });
  }

  function openMenu(title: string, items: string[], mark?: Set<number>): Promise<number> {
    return new Promise((res) => {
      state.menuActive = true;
      state.menuTitle = title;
      state.menuItems = items;
      state.menuSelected = Math.min(state.menuSelected, items.length - 1);
      state.menuMark = mark ?? new Set();
      menuResolver = res;
      scheduleRender();
    });
  }

  function closeMenu(index: number) {
    if (!state.menuActive) return;
    state.menuActive = false;
    state.menuItems = [];
    if (menuResolver) menuResolver(index);
    if (state.menuTitle && state.menuTitle.includes('Auto-improve')) {
      const runs = [3, 10, 20, 40, 0];
      const chosen = runs[index] ?? 0;
      if (chosen > 0) {
        (runtime as any).__maxRuns = chosen;
        state.autoApprove = true;
        (runtime as any).__permPolicy = 'yolo';
        push('system', `Auto improve: ON — ${chosen} passes with best-synthesis feedback. Send a message to begin.`);
        state.autoImproveArmed = true;
      } else {
        push('system', 'Auto improve: cancelled — current mode preserved.');
      }
      state.splashDismissed = true;
    }
    menuResolver = undefined;
    scheduleRender();
  }

  function isProviderId(s: string) {
    return providerById(s) ? true : false;
  }

  async function runShell(cmd: string) {
    if (!cmd) { push('error', 'No command given'); return; }
    await run(async () => {
      const { execFile } = await import('node:child_process');
      const out = await new Promise<string>((res) => execFile('sh', ['-c', cmd], { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
        res((e ? `exit_code: ${(e as any).code ?? 1}\n` : 'exit_code: 0\n') + String(stdout ?? '') + String(stderr ?? ''));
      }));
      return out.slice(0, 12000);
    });
  }

  async function runTest(extra: string) {
    await run(async () => {
      const { detectRepo } = await import('../repo.js');
      const repo = detectRepo(projectRoot);
      const cmd = extra ? `node --run ${extra} 2>/dev/null || ${repo.testCommand}` : (repo.testCommand ?? 'no test command detected');
      const { execFile } = await import('node:child_process');
      const raw = cmd.includes(' || ') ? cmd.split(' || ')[0] : cmd;
      const resolved = cmd.includes(' || ') ? cmd : cmd;
      const out = await new Promise<string>((resolve) => execFile('sh', ['-c', resolved], { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
        resolve((e ? `exit code: ${(e as any).code ?? 1}\n` : 'exit code: 0\n') + String(stdout ?? '').slice(0, 6000) + String(stderr ?? '').slice(0, 3000));
      }));
      return out;
    });
  }

  async function loginFlow() {
    const activeProvider = runtime.config.model.provider;
    const providerItems = PROVIDERS.map((p) => {
      const active = p.id === activeProvider;
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${p.name.padEnd(20)}  ${badge}${T.grayDark}${p.id} · ${p.baseUrl}${T.reset}`;
    });
    const curIdx = PROVIDERS.findIndex((p) => p.id === activeProvider);
    state.menuSelected = Math.max(0, curIdx);
    const idx = await openMenu('Authenticate Model Provider', providerItems);
    if (idx < 0) return;
    const prov = PROVIDERS[idx];

    const modelItems = prov.models.map((m) => `${m.padEnd(36)}`);
    const defIdx = prov.models.indexOf(prov.defaultModel);
    state.menuSelected = Math.max(0, defIdx >= 0 ? defIdx : 0);
    const modelIdx = await openMenu(`${prov.name} · Select Default Model`, modelItems);
    const model = modelIdx >= 0 ? prov.models[modelIdx] : prov.defaultModel;
    const envKey = prov.envKey ? process.env[prov.envKey] : undefined;
    const storedKey = runtime.config.model.provider === prov.id ? runtime.config.model.apiKey : undefined;
    const apiKey = envKey || storedKey || await ask(`${prov.name} API Key:`);
    if (!apiKey && prov.envKey) { push('error', `No API key for ${prov.id}. Set $${prov.envKey} or enter one.`); return; }
    if (!apiKey) { push('error', 'No API key provided.'); return; }
    await run(async () => runtime.loginProvider(prov.id, apiKey, model || prov.defaultModel));
  }

  async function providerMenu() {
    const activeProvider = runtime.config.model.provider;
    const providerItems = PROVIDERS.map((p) => {
      const active = p.id === activeProvider;
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${p.name.padEnd(20)}  ${badge}${T.grayDark}${p.models.length} models · ${p.baseUrl}${T.reset}`;
    });
    const curIdx = PROVIDERS.findIndex((p) => p.id === activeProvider);
    state.menuSelected = Math.max(0, curIdx);
    const idx = await openMenu('Connected Model Providers', providerItems);
    if (idx < 0) return;
    const p = PROVIDERS[idx];
    push('system', `${p.name} (${p.id})\nBase URL: ${p.baseUrl}\nAvailable Models:\n  ${p.models.join('\n  ') || '(none listed)'}`);
    scheduleRender();
  }

  async function modelMenu() {
    // Step 1: select a provider
    const curProvider = runtime.config.model.provider;
    const providerItems = PROVIDERS.map((p) => {
      const active = p.id === curProvider;
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${p.name.padEnd(20)}  ${badge}${T.grayDark}${p.models.length} models · ${p.baseUrl}${T.reset}`;
    });
    const curIdx = PROVIDERS.findIndex((p) => p.id === curProvider);
    state.menuSelected = Math.max(0, curIdx);
    const pidx = await openMenu('Select AI Provider', providerItems);
    if (pidx < 0 || pidx >= PROVIDERS.length) return;
    const prov = PROVIDERS[pidx];

    // Step 2: select a model from the chosen provider
    const activeModel = runtime.config.model.model;
    const modelItems = prov.models.map((m) => {
      const active = prov.id === curProvider && m === activeModel;
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${m.padEnd(36)}  ${badge}`;
    });
    const curModelIdx = prov.models.indexOf(activeModel);
    state.menuSelected = Math.max(0, curModelIdx >= 0 ? curModelIdx : 0);
    const midx = await openMenu(`${prov.name} · Select Model`, modelItems);
    if (midx < 0 || midx >= prov.models.length) return;
    const model = prov.models[midx];

    // Apply the selection
    await run(async () => {
      const desc = await runtime.useProvider(prov.id, model);
      modelShort = model.split('/').pop() ?? model;
      return desc;
    });
  }

  async function reasoningMenu() {
    const cur = runtime.getReasoning();
    const options: Array<{ level: import('../types.js').ReasoningLevel; label: string; desc: string }> = [
      { level: 'low', label: 'Low', desc: 'Fast & agile: minimal reasoning overhead, speedy tool executions.' },
      { level: 'medium', label: 'Medium', desc: 'Balanced: thoughtful analysis, careful edits, reliable verification.' },
      { level: 'high', label: 'High', desc: 'Deep cognitive analysis: edge cases, AST blast radius checking, multi-step verification.' },
      { level: 'max', label: 'Max', desc: 'Maximum reasoning compute: exhaustive decomposition, Chameleon MoE synthesis, full invariant verification.' },
    ];
    const items = options.map((opt) => {
      const active = opt.level === cur;
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${T.cyan}${opt.label.padEnd(8)}${T.reset}  ${badge}${T.grayDark}· ${opt.desc}${T.reset}`;
    });
    const curIdx = options.findIndex((o) => o.level === cur);
    state.menuSelected = Math.max(0, curIdx);
    const idx = await openMenu('Adjust Reasoning Effort & Compute (low / medium / high / max)', items);
    if (idx < 0 || idx >= options.length) return;
    const chosen = options[idx];
    const desc = runtime.setReasoning(chosen.level);
    push('system', `[REASON] Reasoning mode set to ${chosen.level.toUpperCase()} — ${desc}`);
    scheduleRender();
  }

  async function themeMenu() {
    const themes = getAllThemes();
    const curTheme = getCurrentTheme();
    const items = themes.map((t) => {
      const active = t.id === curTheme.id;
      const swatch = themeSwatch(t);
      const name = t.name.padEnd(18);
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${swatch}  ${name}  ${badge}${T.grayDark}· ${t.description}${T.reset}`;
    });
    const curIdx = themes.findIndex((t) => t.id === curTheme.id);
    state.menuSelected = Math.max(0, curIdx);
    const idx = await openMenu('Select Color Theme (15 Styles)', items);
    if (idx < 0 || idx >= themes.length) return;
    const chosen = themes[idx];
    setTheme(chosen.id);
    push('system', `Theme switched to ${chosen.name} — ${chosen.description}`);
    scheduleRender();
  }

  async function skillsMenu() {
    const { loadAllSkills, readSkillBody } = await import('../skills.js');
    const { skills } = loadAllSkills(projectRoot);
    if (!skills.length) {
      push('system', 'No skills found in catalog or project.');
      scheduleRender();
      return;
    }

    const items = skills.map((s) => {
      const name = s.name.padEnd(24);
      const desc = s.description.length > 55 ? s.description.slice(0, 52) + '…' : s.description;
      return `${T.cyan}${name}${T.reset}  ${T.grayDark}· ${desc}${T.reset}`;
    });

    state.menuSelected = 0;
    const idx = await openMenu(`Available Engineering Skills (${skills.length} Loaded)`, items);
    if (idx < 0 || idx >= skills.length) return;

    const chosen = skills[idx];
    const subActions = [
      `▶  Activate & Load into Context`,
      `[DOC] View Full Skill Instructions`,
    ];
    const actIdx = await openMenu(`Skill: ${chosen.name}`, subActions);
    if (actIdx === 0) {
      const body = readSkillBody(chosen, projectRoot);
      await run(async () => {
        return runtime.runPrompt(`Please follow and activate the ${chosen.name} skill instructions:\n\n${body}`);
      }, false);
    } else if (actIdx === 1) {
      const body = readSkillBody(chosen, projectRoot);
      push('system', `=== Skill: ${chosen.name} ===\n${body || chosen.description}`);
      scheduleRender();
    }
  }

  function formatTimeAgo(ts: number): string {
    const diff = Math.max(0, Date.now() - ts);
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  async function historySessionMenu() {
    const { SessionStore } = await import('../session-store.js');
    const store = new SessionStore(projectRoot);
    const sessions = store.list(40);

    const items: string[] = [
      `${T.lime}+ Start New Session${T.reset}`,
    ];

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const msgs = store.messages(s.id);
      const msgCount = `${msgs.length} msgs`.padEnd(9);
      const timeAgo = formatTimeAgo(s.updatedAt);
      const title = (s.objective || s.summary || `Session ${i + 1}`).slice(0, 36);
      items.push(`${title.padEnd(38)}  ${T.grayDark}${msgCount} · ${timeAgo}${T.reset}`);
    }

    state.menuSelected = 0;
    const idx = await openMenu('Conversation History & Sessions', items);
    if (idx < 0) return;

    if (idx === 0) {
      runtime.resetSession();
      state.lines = [];
      state.tasks.clear();
      state.scroll = 0;
      push('system', 'Started a fresh session.');
      scheduleRender();
      return;
    }

    const chosen = sessions[idx - 1];
    if (!chosen) return;

    // Submenu for chosen session: Switch, Rename, Delete
    const subActions = [
      `▶  Switch to this Session`,
      `[EDIT] Rename Session ("${(chosen.objective || 'Session').slice(0, 20)}")`,
      `[DEL]  Delete Session`,
    ];
    const actIdx = await openMenu(`Manage: ${(chosen.objective || 'Session').slice(0, 30)}`, subActions);
    if (actIdx === 0) {
      runtime.activeSessionId = chosen.id;
      const msgs = store.messages(chosen.id);
      state.lines = [];
      state.tasks.clear();
      state.scroll = 0;
      for (const m of msgs) {
        if (m.role === 'user') push('user', m.content);
        else if (m.role === 'assistant') push('assistant', m.content);
        else if (m.role === 'system') push('system', m.content);
      }
      push('system', `Switched to session "${chosen.objective || 'Session'}" (${msgs.length} messages).`);
      scheduleRender();
    } else if (actIdx === 1) {
      const newTitle = await ask(`New title for session:`);
      if (newTitle && newTitle.trim()) {
        store.rename(chosen.id, newTitle.trim());
        push('system', `Session renamed to "${newTitle.trim()}".`);
        scheduleRender();
      }
    } else if (actIdx === 2) {
      store.delete(chosen.id);
      push('system', `Deleted session "${chosen.objective || 'Session'}".`);
      scheduleRender();
    }
  }

  async function exportSession() {
    const file = await ask('Export path:');
    await run(async () => {
      const { writeFileSync } = await import('node:fs');
      const data = JSON.stringify({ cwd: projectRoot, model: runtime.config.model, time: new Date().toISOString() });
      writeFileSync(file, data + '\n');
      return `Exported to ${file}`;
    });
  }

  async function importFlow() {
    const file = await ask('Import path:');
    handleCommand(`/export ${file}`);
  }

  function listTasks(): string {
    const goals = runtime.workspace.listGoals();
    if (goals.length === 0) return 'No goals yet.';
    const out: string[] = [];
    for (const g of goals) {
      const goal = runtime.workspace.loadGoal(g.replace(/\.json$/, ''));
      if (!goal) continue;
      const tasks = runtime.workspace.loadTasks(goal.id);
      out.push(`Goal: ${goal.objective}`);
      for (const t of tasks) {
        const icon = t.status === 'done' ? '[OK]' : t.status === 'running' ? '[..]' : t.status === 'failed' ? '[ERR]' : '[ ]';
        out.push(`  ${icon} ${t.title} (${t.role})`);
      }
    }
    return out.join('\n');
  }

  function pushHelp() {
    const text = COMMANDS.map(c => `${c.name.padEnd(12)} ${c.hint}`).join('\n');
    const tips =
      `\nCopying text from the transcript:\n` +
      `  Drag with the left mouse button to select text — release copies to clipboard.\n` +
      `  Shift+drag uses the host terminal's native selection (works in tmux / older terminals).\n` +
      `  /copy [last | err | N] — keyboard fallback: copy last assistant, last error,\n` +
      `    or the Nth-most-recent line. Works on every terminal, no mouse needed.\n` +
      `\nTerminal shortcuts:\n` +
      `  Wheel or PgUp/PgDn scroll the transcript — Home/End jump to top/bottom.\n` +
      `  Shift+Tab toggles auto-approve, Double Esc exits.`;
    push('system', text + tips);
  }

  function exit() {
    if (exited) return;
    exited = true;
    stopSpinner();
    process.stdout.write(`${RESET}${SHOW}${ALT_EXIT}`);
    for (const fn of cleanupFns) fn();
    process.exit(0);
  }

  function onKey(buf: Buffer) {
    const s = buf.toString('utf8');
    renderPaused = false;

    // Bracketed paste: the terminal wraps pasted text in
    // \x1b[200~ ... \x1b[201~ (possibly split across many data chunks).
    if (state.pasting || s.includes('\x1b[200~')) {
      if (!state.pasting) {
        state.pasting = true;
        pasteBuffer = s.replace(/^\x1b\[200~/, '');
      } else {
        pasteBuffer += s;
      }
      if (pasteBuffer.includes('\x1b[201~')) {
        state.pasting = false;
        const text = pasteBuffer.split('\x1b[201~')[0];
        pasteBuffer = '';
        state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor);
        state.cursor += text.length;
        state.dropActive = currentDropItems().length > 0;
        state.dropSelected = 0;
        clearSelection();
        scheduleRender();
      }
      return;
    }

    let i = 0;
    while (i < s.length) {
      const rest = s.slice(i);

      // 1. SGR Mouse protocol: CSI < btn ; col ; row (M|m)
      const sgrMouse = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (sgrMouse) {
        i += sgrMouse[0].length;
        const btn = Number(sgrMouse[1]);
        const row = Number(sgrMouse[3]);
        const isPress = sgrMouse[4] === 'M';

        if (state.menuActive) {
          if (btn === 64 && isPress) {
            state.menuSelected = Math.max(0, state.menuSelected - 1);
            lastFrame = [];
            scheduleRender();
          } else if (btn === 65 && isPress) {
            state.menuSelected = Math.min(state.menuItems.length - 1, state.menuSelected + 1);
            lastFrame = [];
            scheduleRender();
          } else if (btn === 0 && isPress) {
            const maxVisible = Math.min(state.menuItems.length, Math.max(5, height() - 8));
            const menuH = maxVisible + 3;
            const menuTop = Math.max(1, Math.floor((height() - menuH) / 2));
            let scrollOffset = 0;
            if (state.menuItems.length > maxVisible) {
              scrollOffset = Math.max(0, Math.min(state.menuItems.length - maxVisible, state.menuSelected - Math.floor(maxVisible / 2)));
            }
            const clickedRow = row - 1;
            const itemOffset = clickedRow - (menuTop + 1);
            if (itemOffset >= 0 && itemOffset < maxVisible) {
              const targetIdx = scrollOffset + itemOffset;
              if (targetIdx >= 0 && targetIdx < state.menuItems.length) {
                closeMenu(targetIdx);
              }
            }
          }
          continue;
        }

        if (btn === 64 || btn === 65) {
          // Wheel: 64 = scroll up, 65 = scroll down.
          if (isPress) scrollTranscript(btn === 64 ? 3 : -3);
          continue;
        }

        // Left-button click-drag text selection. Any press starts/extends a
        // selection; the drag motion updates it; the release (lowercase "m")
        // finalizes and copies the selected text to the OS clipboard.
        const col = Number(sgrMouse[2]);
        if (isPress) {
          const isMotion = (btn & 32) !== 0;
          if (isMotion) updateSelection(row - 1, col - 1);
          else beginSelection(row - 1, col - 1);
        } else {
          endSelection();
        }
        continue;
      }

      // 2. X10 Mouse: \x1b[M... (3 trailing bytes)
      if (rest.startsWith('\x1b[M') && rest.length >= 6) {
        i += 6;
        continue;
      }

      // 3. Shift+Tab: open interactive auto-improve selection menu
      if (rest.startsWith('\x1b[Z')) {
        i += 3;
        state.menuActive = true;
        state.menuTitle = 'Auto-improve — choose iteration count';
        state.menuItems = [
          '3 runs — quick improvement',
          '10 runs — standard depth',
          '20 runs — deep exploration',
          '40 runs — maximum continuous improvement',
          'Cancel — keep current mode',
        ];
        state.menuSelected = 0;
        state.menuMark = new Set<number>();
        scheduleRender();
        continue;
      }

      // 4. Menu mode navigation
      if (state.menuActive) {
        if (rest.startsWith('\x1b[A')) { i += 3; state.menuSelected = Math.max(0, state.menuSelected - 1); lastFrame = []; scheduleRender(); continue; }
        if (rest.startsWith('\x1b[B')) { i += 3; state.menuSelected = Math.min(state.menuItems.length - 1, state.menuSelected + 1); lastFrame = []; scheduleRender(); continue; }
        if (rest.startsWith('\x1b[C') || rest.startsWith('\x1b[D')) { i += 3; scheduleRender(); continue; }
        if (rest.startsWith('\x1b[5~') || rest.startsWith('\x1b[6~')) { i += 4; scheduleRender(); continue; }
        const ch0 = s[i];
        if (ch0 === '\r' || ch0 === '\n') { i++; const idx = state.menuSelected; closeMenu(idx); continue; }
        if (ch0 === '\x1b') { i++; closeMenu(-1); continue; }
        const n = parseInt(ch0, 10);
        if (!Number.isNaN(n) && n >= 0 && n < state.menuItems.length) { i++; state.menuSelected = n; lastFrame = []; scheduleRender(); continue; }
        i++;
        continue;
      }

      const c = s[i];
      if (c === '\r' || c === '\n') {
        if (state.dropActive) {
          const items = currentDropItems();
          const pick = items[Math.min(state.dropSelected, items.length - 1)];
          const exactMatch = items.length === 1 && state.input.trim() === items[0].name;
          const takesArg = pick && ['/goal', '/plan', '/team', '/model', '/reasoning', '/theme', '/inspect', '/run', '/shell', '/login', '/import', '/rename'].includes(pick.name);
          if (pick && state.input.startsWith('/') && (!exactMatch || (takesArg && state.input === pick.name))) {
            state.input = pick.name + ' ';
            state.cursor = state.input.length;
            state.dropActive = false;
            state.dropSelected = 0;
            scheduleRender();
            i++;
            continue;
          }
        }
        const text = state.input;
        state.input = '';
        state.cursor = 0;
        state.splashDismissed = true;
        if (text.trim()) {
          if (state.promptActive && pendingResolver) {
            pendingResolver(text.trim());
            pendingResolver = undefined;
            state.promptActive = false;
            pendingPrompt = undefined;
            state.input = '';
            state.cursor = 0;
          } else {
            Promise.resolve(handleCommand(text)).catch((e) => {
              push('error', e instanceof Error ? `${e.message}` : String(e));
              state.busy = false;
              stopSpinner();
              scheduleRender();
            });
          }
        }
        scheduleRender();
        i++;
        continue;
      }

      // Escape sequence router
      if (c === '\x1b') {
        const csi = rest.match(/^\x1b\[[0-9;?<=]*[A-Za-z~]/);
        if (csi) {
          handleEscape(csi[0]);
          i += csi[0].length;
          continue;
        }
        const osc = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
        if (osc) {
          i += osc[0].length;
          continue;
        }
        const now = Date.now();
        if (rest === '\x1b') {
          if (state.busy) {
            runtime.abort('User skipped/cancelled task via ESC');
            push('system', '[STOP] Task cancelled via ESC.');
            state.busy = false;
            stopSpinner();
            scheduleRender();
            i++;
            continue;
          }
          // Never exit application on ESC; only cancel tasks, close menus/drop, or clear input
          state.input = '';
          state.cursor = 0;
          state.dropActive = false;
          clearSelection();
          if (state.menuActive) closeMenu(-1);
          scheduleRender();
          i++;
          continue;
        }
        if (rest.length >= 2) {
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (c === '\u0003') {
        if (state.busy) {
          runtime.abort('User cancelled task via Ctrl+C');
          push('system', '[STOP] Task cancelled via Ctrl+C.');
          state.busy = false;
          stopSpinner();
          scheduleRender();
          i++;
          continue;
        }
        if (state.input.length > 0) {
          state.input = '';
          state.cursor = 0;
          scheduleRender();
          i++;
          continue;
        }
        const now = Date.now();
        if (now - lastCtrlCAt < 1000) {
          exit();
        } else {
          lastCtrlCAt = now;
          push('system', `${T.grayDark}Press Ctrl+C again to exit.${T.reset}`);
          scheduleRender();
        }
        i++;
        continue;
      }

      if (c === '\u0004') {
        exit();
        i++;
        continue;
      }

      if (c === '\u007f' || c === '\b') {
        if (state.cursor > 0) {
          state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
          state.cursor--;
        }
        scheduleRender();
        i++;
        continue;
      }

      if (c === '\t') {
        const items = currentDropItems();
        if (items.length > 1 && state.input.startsWith('/')) {
          state.dropSelected = (state.dropSelected + 1) % Math.min(items.length, 6);
        } else if (items.length === 1 && state.input.startsWith('/') && state.input.trim() !== items[0].name) {
          state.input = items[0].name + ' ';
          state.cursor = state.input.length;
          state.dropActive = false;
          state.dropSelected = 0;
        } else {
          state.uiMode = state.uiMode === 'plan' ? 'act' : 'plan';
          runtime.config.planMode = state.uiMode === 'plan';
        }
        state.dropActive = currentDropItems().length > 0;
        scheduleRender();
        i++;
        continue;
      }

      // Accumulate standard printable characters (>= ' ')
      let j = i;
      while (j < s.length) {
        const ch = s[j];
        if (ch < ' ') break;
        if (ch === '\x1b') break;
        j++;
      }
      if (j > i) {
        const text = s.slice(i, j);
        state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor);
        state.cursor += text.length;
        state.dropActive = currentDropItems().length > 0;
        state.dropSelected = 0;
        clearSelection();
        scheduleRender();
        i = j;
        continue;
      }
      i++;
    }
  }

  function handleEscape(seq: string) {
    switch (seq) {
      case '\x1b[D': if (state.cursor > 0) state.cursor--; break;
      case '\x1b[C': if (state.cursor < state.input.length) state.cursor++; break;
      case '\x1b[H': state.cursor = 0; break;
      case '\x1b[F': state.cursor = state.input.length; break;
      case '\x1b[A':
        if (state.dropActive) { state.dropSelected = Math.max(0, state.dropSelected - 1); break; }
        historyPrev(); break;
      case '\x1b[B':
        if (state.dropActive) { state.dropSelected = Math.min(currentDropItems().length - 1, state.dropSelected + 1); break; }
        historyNext(); break;
      case '\x1b[5~': scrollTranscript(scrollPageSize()); clearSelection(); return;
      case '\x1b[6~': scrollTranscript(-scrollPageSize()); clearSelection(); return;
      case '\x1b[3~': state.input = state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1); break;
      case '\x1b[1~': scrollTranscript(Number.MAX_SAFE_INTEGER); clearSelection(); return;
      case '\x1b[4~': scrollTranscript(-Number.MAX_SAFE_INTEGER); clearSelection(); return;
      default: break;
    }
    clearSelection();
    scheduleRender();
  }

  /** Full visible page of transcript rows to scroll with PgUp/PgDn. */
  function scrollPageSize(): number {
    return Math.max(1, (state.busy ? Math.max(1, height() - 8 - 1) : height() - 8) - 2);
  }

  function historyPrev() {
    if (state.history.length === 0) return;
    if (state.historyIndex === -1) state.historyIndex = state.history.length - 1;
    else if (state.historyIndex > 0) state.historyIndex--;
    state.input = state.history[state.historyIndex] ?? '';
    state.cursor = state.input.length;
  }

  function historyNext() {
    if (state.historyIndex === -1) return;
    state.historyIndex++;
    if (state.historyIndex >= state.history.length) {
      state.historyIndex = -1;
      state.input = '';
      state.cursor = 0;
      return;
    }
    state.input = state.history[state.historyIndex] ?? '';
    state.cursor = state.input.length;
  }

  /** Scroll the transcript. Positive `delta` scrolls up (view older content),
   *  negative scrolls back down. Reaching the bottom clears manual-scroll so
   *  live events auto-follow again. */
  function scrollTranscript(delta: number) {
    const w = width();
    const { chatMw, availableH } = transcriptGeometry(w);
    const lines = transcriptLines(chatMw);
    const maxScroll = Math.max(0, lines.length - availableH);
    if (delta > 0) {
      state.scroll = Math.min(maxScroll, state.scroll + delta);
      if (state.scroll > 0) state.userScrolled = true;
    } else {
      state.scroll = Math.max(0, state.scroll + delta);
      if (state.scroll <= 0) state.userScrolled = false;
    }
    lastFrame = [];
    scheduleRender();
  }

  function onRuntimeEvent(event: MochiEvent) {
    // First real event (model streaming, tools) means startup is done: finish
    // the splash immediately so it never covers live output.
    if (state.splashTick < SPLASH_TICKS) {
      state.splashTick = SPLASH_TICKS;
      state.splashProgress = 1;
    }
    renderPaused = false;
    if (reduceEvent(state, event as unknown as Record<string, unknown>)) {
      if (!state.userScrolled) state.scroll = 0;
      scheduleRender();
    }
    // Keep the status bar's git stats + token meter live.
    const type = String((event as any).type);
    if (type === 'file:changed' || type === 'tool:completed') void refreshGitStats();
    if (type === 'usage:updated') {
      // REAL provider numbers: input (net of cache hits), output, cache reads, and USD cost.
      state.inTokens = Number((event as any).inputTokens ?? 0);
      state.outTokens = Number((event as any).outputTokens ?? 0);
      state.cacheTokens = Number((event as any).cacheTokens ?? 0);
      state.totalTokens = Number((event as any).totalTokens ?? 0);
      if ((event as any).costUsd !== undefined) {
        state.totalCost = Number((event as any).costUsd ?? 0);
      }
      scheduleRender();
    }
  }

  function start() {
    // Enable SGR mouse reporting. The three modes do different things:
    //   ?1000  — basic press/release (needed for click)
    //   ?1002  — button-event tracking: forwards MOTION events while a button
    //            is held (needed for drag-select to actually update the
    //            highlight between press and release)
    //   ?1006  — SGR encoding so columns >223 don't get truncated
    // Without ?1002 a drag produces only a press+release pair — the user
    // sees no inline highlight, and copy() returns the single character
    // that was clicked. That's the "highlight doesn't work" bug.
    process.stdout.write(ALT_ENTER + HIDE + '\x1b[?1000h\x1b[?1002h\x1b[?1006h' + BRACKET_PASTE_ON);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const keyListener = (buf: Buffer) => onKey(buf);
    process.stdin.on('data', keyListener);
    const resizeListener = () => scheduleRender();
    process.stdout.on('resize', resizeListener);
    const exitListener = () => {
      process.stdout.write(`${RESET}${SHOW}${ALT_EXIT}\x1b[?1000l\x1b[?1002l\x1b[?1006l` + BRACKET_PASTE_OFF);
    };
    process.on('exit', exitListener);
    runtime.events.onAll(onRuntimeEvent);
    void refreshGitStats(); // seed the status bar diff stats
    cleanupFns = [
      () => process.stdin.off('data', keyListener),
      () => process.stdout.off('resize', resizeListener),
      () => process.off('exit', exitListener),
    ];
    startSpinner();
    scheduleRender();
    if (initialPrompt) {
      push('user', initialPrompt);
      state.busy = true;
      startSpinner();
      // echo:false — the agent streams assistant turns already.
      runtime.runPrompt(initialPrompt).then(() => {}).catch(e => push('error', e instanceof Error ? e.message : String(e))).finally(() => {
        state.busy = false;
        stopSpinner();
        scheduleRender();
      });
    }
  }

  start();
  return new Promise<void>(() => {});
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

import { nativeGitBranch, nativeDiffNumstat } from '../native/core.js';

async function gitBranch(cwd: string): Promise<string> {
  const nat = nativeGitBranch(cwd);
  if (nat) return nat;
  return new Promise(resolve => {
    execFile('git', ['branch', '--show-current'], { cwd }, (error, stdout) => {
      if (error || !stdout) return resolve('');
      resolve(stdout.toString().trim());
    });
  });
}

/** Cline-style git diff stats for the status bar: files, +additions, -deletions. */
async function gitDiffStats(cwd: string): Promise<{ files: number; additions: number; deletions: number } | null> {
  return new Promise(resolve => {
    execFile('git', ['diff', '--numstat'], { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      const str = stdout.toString();
      const nat = nativeDiffNumstat(str);
      if (nat && nat.files > 0) return resolve(nat);
      let files = 0, additions = 0, deletions = 0;
      for (const line of str.split('\n')) {
        const m = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
        if (!m) continue;
        files++;
        if (m[1] !== '-') additions += Number(m[1]);
        if (m[2] !== '-') deletions += Number(m[2]);
      }
      resolve(files ? { files, additions, deletions } : null);
    });
  });
}
