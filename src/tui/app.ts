import { sliceVisibleRange, highlightRange } from './selection.js';
import { execFile, spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { findProjectRoot } from '../repo.js';
import type { Runtime } from '../runtime.js';
import type { MochiEvent } from '../types.js';
import { PROVIDERS, providerById } from '../providers.js';
import { reduceEvent } from './state.js';
import pkg from '../../package.json' with { type: 'json' };
import { kvCache } from '../kv-cache.js';
import { formatModes } from '../modes.js';
import {
  T,
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
  renderDropdown,
  composerRow,
  composerPlaceholderRow,
  composerTopRule,
  composerBottomRule,
  composerHintRow,
  transcriptIndent,
  thinkingLine,
  spinnerFrame,
  visibleLen,
  ellipsize,
} from './view.js';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ALT_ENTER = '\x1b[?1049h';
const ALT_EXIT = '\x1b[?1049l';
const BRACKET_PASTE_ON = '\x1b[?2004h';
const BRACKET_PASTE_OFF = '\x1b[?2004l';
const RESET = '\x1b[0m';

type LineKind = 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'task' | 'goal' | 'plain';

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
  { name: '/model', hint: 'Select AI model provider & model' },
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
    lastStatus: '' as string,
    chatVer: 0 as number,
    limit: 500 as number,
    /** cline-style plan/act mode (Tab) */
    uiMode: (runtime.config.planMode ? 'plan' : 'act') as 'plan' | 'act',
    /** auto-approve all (Shift+Tab) — mirrors /yolo */
    autoApprove: (runtime as any).__permPolicy === 'yolo',
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

  const width = () => process.stdout.columns || 100;
  const height = () => process.stdout.rows || 34;

  const push = (kind: LineKind, text: string) => {
    state.splashDismissed = true;
    const last = state.lines[state.lines.length - 1];
    if (last && last.kind === kind && last.text === text) return;
    state.lines.push({ kind, text });
    state.chatVer++;
    if (state.lines.length > state.limit) state.lines.splice(0, state.lines.length - state.limit);
    if (!state.userScrolled) state.scroll = 0;
    scheduleRender();
  };

  const scheduleRender = () => {
    if (renderQueued || renderPaused) return;
    renderQueued = true;
    // Use a macrotask (setTimeout 0) instead of queueMicrotask so bursty
    // updates (streaming message:chunk, tool events) coalesce into a single
    // render per tick instead of draining N microtasks synchronously and
    // pegging the event loop. That spinning was the source of the freeze
    // during heavy work: every chunk scheduled a full O(n) transcript wrap
    // that starved everything else.
    setTimeout(() => {
      renderQueued = false;
      render();
    }, 0);
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

  function visibleLen(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  function wrap(text: string, max: number): string[] {
    if (!text) return [''];
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      let lineVis = 0; // visible (ANSI-stripped) length of `line`, kept O(1)
      for (const word of paragraph.split(/(\s+)/)) {
        const wVis = visibleLen(word);
        if (lineVis + wVis > max) {
          if (line.trim()) out.push(line.trimEnd());
          line = word.startsWith(' ') ? word.slice(1) : word;
          lineVis = visibleLen(line);
        } else {
          // O(1) cumulative visible length instead of re-stripping ANSI over
          // the whole growing line per word, which was O(line^2) and froze
          // the UI while a long response streamed in.
          line += word;
          lineVis += wVis;
        }
      }
      out.push(line);
    }
    return out.length ? out : [''];
  }

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

  /** Wrap a single transcript line into rendered, wrapped output rows. */
  function wrapLine(line: Line, maxWidth: number): string[] {
    if (line.kind === 'goal') return [];
    if (line.kind === 'system' && line.text.startsWith('Tokens used:')) return [];
    const text = prettifyToolCall(line.text) ?? line.text;
    if (!text.trim()) return [];
    const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
    const rows: string[] = [];

    switch (line.kind) {
      case 'user': {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`${T.magenta}❯${T.reset} ${T.bold}${T.fg}${w}${T.reset}`);
          else rows.push(`  ${T.bold}${T.fg}${w}${T.reset}`);
        }
        break;
      }
      case 'assistant': {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth));
        for (const w of wrapped) {
          rows.push(`${T.fg}${w}${T.reset}`);
        }
        break;
      }
      case 'tool': {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`${T.violet}◆${T.reset} ${T.grayDark}${w}${T.reset}`);
          else rows.push(`  ${T.grayDark}${w}${T.reset}`);
        }
        break;
      }
      case 'error': {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`${T.error}${T.bold}✗${T.reset} ${T.error}${w}${T.reset}`);
          else rows.push(`  ${T.error}${w}${T.reset}`);
        }
        break;
      }
      case 'system': {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth));
        for (const w of wrapped) {
          rows.push(`${T.gray}${w}${T.reset}`);
        }
        break;
      }
      case 'task': {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`${T.teal}▸${T.reset} ${T.teal}${w}${T.reset}`);
          else rows.push(`  ${T.teal}${w}${T.reset}`);
        }
        break;
      }
      default: {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth));
        for (const w of wrapped) {
          rows.push(`${T.fg}${w}${T.reset}`);
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
    const top = Math.min(state.selStart.row, state.selEnd.row);
    const bottom = Math.max(state.selStart.row, state.selEnd.row);
    if (row < top || row > bottom) return content;
    const left = Math.min(state.selStart.col, state.selEnd.col);
    const right = Math.max(state.selStart.col, state.selEnd.col);
    const len = visibleLen(content);
    const from = row === top ? Math.max(0, left - indent) : 0;
    const to = row === bottom ? Math.min(len, right - indent) : len;
    if (to <= from) return content;
    return highlightRange(content, from, to);
  }

  /** Extract the visible text inside the current selection (plain, no ANSI). */
  function selectedText(): string {
    if (!state.selActive || !state.selStart || !state.selEnd) return '';
    const w = width();
    const { chatMw, availableH } = transcriptGeometry(w);
    const indent = transcriptIndent(w);
    const chatLines = transcriptLines(chatMw);
    const windowStart = Math.max(0, chatLines.length - availableH - state.scroll);
    const top = Math.min(state.selStart.row, state.selEnd.row);
    const bottom = Math.max(state.selStart.row, state.selEnd.row);
    const left = Math.min(state.selStart.col, state.selEnd.col);
    const right = Math.max(state.selStart.col, state.selEnd.col);
    const lines: string[] = [];
    for (let r = top; r <= bottom; r++) {
      const idx = windowStart + r;
      if (idx < 0 || idx >= chatLines.length) continue;
      const bare = stripAnsi(chatLines[idx]);
      const from = r === top ? Math.max(0, left - indent) : 0;
      const to = r === bottom ? Math.min(bare.length, right - indent) : bare.length;
      lines.push(from < to ? bare.slice(from, to) : '');
    }
    return lines.join('\n');
  }

  /** Copy a string to the system clipboard: prefer terminal OSC-52 (works over
   *  ssh/inside any terminal that supports it), then xclip / xsel / wl-copy /
   *  pbcopy for a real X11/Wayland/macOS clipboard. Best-effort, never throws. */
  function copyToClipboard(text: string) {
    if (!text) return;
    // OSC-52 needs no local tools and survives remote sessions.
    try {
      process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    } catch { /* ignore */ }
    setImmediate(() => {
      const feed = (p: ReturnType<typeof spawn> | null) => {
        if (!p || !p.stdin) return;
        p.stdin.on('error', () => {});
        p.stdin.end(Buffer.from(text, 'utf8'));
      };
      try {
        if (process.env.WAYLAND_DISPLAY) {
          const wl = spawn('wl-copy', ['--type', 'text/plain']);
          wl.on('error', () => feed(spawn('xsel', ['-ib'])));
          feed(wl);
        } else {
          const xclip = spawn('xclip', ['-selection', 'clipboard']);
          xclip.on('error', () => feed(spawn('pbcopy')));
          feed(xclip);
        }
      } catch { /* ignore */ }
    });
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
      copyToClipboard(t);
      // keep the highlight visible until the next click/keypress clears it
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
        rows[top + i] = splash[i];
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
    const statusModel = {
      modelId: modelShort,
      totalTokens: state.inTokens + state.outTokens + state.cacheTokens,
      totalCost: state.totalCost,
      maxInputTokens: runtime.config.safety.contextBudgetTokens,
      mode: state.uiMode,
      agentMode: (runtime.config.mode as any) ?? 'normal',
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
      cTop = s1 + 3;
    } else {
      rows[s1 + 1] = statusBarRow2(statusModel, w);
      cTop = s1 + 2;
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
    return s.replace(/\[[0-9;]*m/g, '');
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
    if (line === '/profiles') { await run(async () => runtime.profiles().map(p => `${p.name} (${p.role}) model=${p.defaultModel ?? 'coding'} verification=${p.verification ?? 'optional'}`).join('\n')); return; }
    if (line === '/memory') { await run(async () => runtime.memory() || 'No project memory yet.'); return; }
    if (line === '/tasks') { await run(async () => listTasks()); return; }
    if (line === '/checkpoint') { await run(async () => { const cp = await runtime.checkpoint(); return `${cp.type} ${cp.ref}`; }); return; }
    if (line === '/rollback') { await run(async () => runtime.rollback()); return; }
    if (line.startsWith('/inspect ') || line === '/inspect') {
      const target = line.startsWith('/inspect ') ? line.slice(9).trim() : await ask('Symbol or file to inspect:');
      if (target) await run(async () => (await runtime.inspect(target)).summary);
      return;
    }
    if (line.startsWith('/plan ') || line === '/plan') {
      const obj = line.startsWith('/plan ') ? line.slice(6).trim() : await ask('Objective to plan:');
      if (obj) await run(async () => runtime.plan(obj));
      return;
    }
    if (line === '/approve') { await run(async () => runtime.approvePlan(), false); return; }
    if (line.startsWith('/team ') || line === '/team') {
      const obj = line.startsWith('/team ') ? line.slice(6).trim() : await ask('Team goal objective:');
      if (obj) await run(async () => runtime.team(obj), false);
      return;
    }
    if (line.startsWith('/goal ') || line === '/goal') {
      const obj = line.startsWith('/goal ') ? line.slice(6).trim() : await ask('Goal objective:');
      if (obj) await run(async () => runtime.goal(obj), false);
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
    if (line === '/usage' || line === '/cost') {
      await run(async () => `${runtime.usage.summary()}\n\nRecent:\n${runtime.usage.recent()}`);
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
      runtime.abort('User stopped/skipped in-flight task');
      push('system', '[STOP] Skipped / stopped in-flight task.');
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
        return `⏪ Rewound to ${cpJson.type} ${cpJson.ref} — "${cpJson.message}"`;
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
        return '📋 Audit log (last 20 entries):\n' + lines.map((l) => {
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
    await run(() => runtime.runPrompt(line), false);
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
        const icon = t.status === 'done' ? '✓' : t.status === 'running' ? '◐' : t.status === 'failed' ? '✗' : '○';
        out.push(`  ${icon} ${t.title} (${t.role})`);
      }
    }
    return out.join('\n');
  }

  function pushHelp() {
    const text = COMMANDS.map(c => `${c.name.padEnd(12)} ${c.hint}`).join('\n');
    const tips =
      `\nTerminal shortcuts:\n` +
      `  Drag to select text - release copies to clipboard\n` +
      `  Wheel or PgUp/PgDn scroll the transcript - Home/End jump to top/bottom\n` +
      `  Shift+drag for native host selection - Shift+Tab toggles auto-approve\n` +
      `  Double Esc exits`;
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

    if (s.length > 0) {
      state.splashDismissed = true;
      if (state.splashTick < SPLASH_TICKS) {
        state.splashTick = SPLASH_TICKS;
        state.splashProgress = 1;
      }
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

      // 3. Shift+Tab: CSI Z
      if (rest.startsWith('\x1b[Z')) {
        i += 3;
        state.autoApprove = !state.autoApprove;
        (runtime as any).__permPolicy = state.autoApprove ? 'yolo' : 'strict';
        push('system', state.autoApprove ? 'Auto improve: ON — autonomous continuous execution and verification active.' : 'Auto improve: OFF — strict permissions restored.');
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
          const takesArg = pick && ['/goal', '/plan', '/team', '/model', '/theme', '/inspect', '/run', '/shell', '/login', '/import', '/rename'].includes(pick.name);
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
        if (text.trim()) {
          if (state.promptActive && pendingResolver) {
            pendingResolver(text.trim());
            pendingResolver = undefined;
            state.promptActive = false;
            pendingPrompt = undefined;
            state.input = '';
            state.cursor = 0;
          } else {
            void handleCommand(text);
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
            push('system', '⏹️  Skipped / stopped thinking.');
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
          push('system', '⏹️  Cancelled thinking.');
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
    // Enable SGR mouse reporting so the scroll wheel (and future click-to-focus)
    // reach stdin as escape sequences. Disabled again on exit.
    process.stdout.write(ALT_ENTER + HIDE + '\x1b[?1000h\x1b[?1006h' + BRACKET_PASTE_ON);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const keyListener = (buf: Buffer) => onKey(buf);
    process.stdin.on('data', keyListener);
    const resizeListener = () => scheduleRender();
    process.stdout.on('resize', resizeListener);
    const exitListener = () => {
      process.stdout.write(`${RESET}${SHOW}${ALT_EXIT}\x1b[?1000l\x1b[?1006l` + BRACKET_PASTE_OFF);
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
