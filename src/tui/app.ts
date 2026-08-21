import { execFile } from 'node:child_process';
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
  gradientContextBar,
  gradientCacheBar,
  splashFrame,
  SPLASH_TICKS,
  statusBarRow1,
  statusBarRow2,
  statusBarRow3,
  renderEntry,
  renderDropdown,
  composerRow,
  composerPlaceholderRow,
  composerTopRule,
  composerBottomRule,
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
  { name: '/exit', hint: 'Quit' },
  { name: '/login', hint: 'Set up a model provider' },
  { name: '/providers', hint: 'List providers' },
  { name: '/model', hint: 'Show / change model' },
  { name: '/mode', hint: 'Set execution mode (spec|security|codemod|chaos|normal)' },
  { name: '/modes', hint: 'List execution modes' },
  { name: '/plugins', hint: 'List installed plugins' },
  { name: '/goal', hint: 'Create goal' },
  { name: '/team', hint: 'Run team mode' },
  { name: '/plan', hint: 'Plan only' },
  { name: '/approve', hint: 'Execute the pending plan' },
  { name: '/tasks', hint: 'List tasks' },
  { name: '/status', hint: 'Git status' },
  { name: '/diff', hint: 'Show diff' },
  { name: '/changes', hint: 'Changed files' },
  { name: '/checkpoint', hint: 'Create checkpoint' },
  { name: '/rollback', hint: 'Roll back' },
  { name: '/profiles', hint: 'List agent profiles' },
  { name: '/memory', hint: 'Project memory' },
  { name: '/inspect', hint: 'Inspect query' },
  { name: '/sessions', hint: 'List sessions' },
  { name: '/resume', hint: 'Resume session' },
  { name: '/export', hint: 'Export session' },
  { name: '/import', hint: 'Import session' },
  { name: '/doctor', hint: 'Diagnose setup' },
  { name: '/usage', hint: 'Usage / cost' },
  { name: '/known-good', hint: 'Record known-good baseline' },
  { name: '/check', hint: 'Compare current state to baseline' },
  { name: '/settings', hint: 'Show settings' },
  { name: '/run', hint: 'Run shell command' },
  { name: '/test', hint: 'Run tests' },
  { name: '/new', hint: 'New session' },
  { name: '/context', hint: 'Show context budget' },
  { name: '/init', hint: 'Create MOCHI.md' },
  { name: '/branch', hint: 'Show branch' },
  { name: '/commit', hint: 'Create checkpoint commit' },
  { name: '/undo', hint: 'Restore last checkpoint' },
  { name: '/redo', hint: 'Reapply last checkpoint' },
  { name: '/stop', hint: 'Stop current task' },
  { name: '/history', hint: 'Command history' },
  { name: '/tools', hint: 'List available tools' },
  { name: '/compact', hint: 'Compact context' },
  { name: '/yolo', hint: 'Toggle unrestricted (bypass permissions)' },
  { name: '/dangerously-skip-permissions', hint: 'Alias for /yolo' },
  { name: '/workspace-safe', hint: 'Auto-approve workspace edits, prompt for shell' },
  { name: '/rewind', hint: 'Rollback to last checkpoint' },
  { name: '/audit', hint: 'Show recent audit log entries' },
];

const SPINNER = ['◐', '◓', '◑', '◒'];

export async function launchTui(runtime: Runtime, initialPrompt?: string): Promise<void> {
  const projectRoot = findProjectRoot(runtime.cwd);
  const projectName = basename(projectRoot);
  const branch = await gitBranch(projectRoot);
  const modelShort = runtime.config.model.model.split('/').pop() ?? runtime.config.model.model;

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
    /** true while the user has scrolled up away from the bottom (prevents
     *  live events from yanking the view back to the newest line). */
    userScrolled: false,
  };

  let pendingResolver: ((v: string) => void) | undefined;
  let pendingPrompt: string | undefined;
  let menuResolver: ((i: number) => void) | undefined;
  let lastEscAt = 0;

  let schedulerTimer: NodeJS.Timeout | undefined;
  let renderQueued = false;
  let lastRenderAt = 0;
  let exited = false;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let cleanupFns: Array<() => void> = [];
  /** Incremental transcript cache: stores the wrapped output per source line,
   *  so each frame only re-wraps lines whose text changed (the newly appended
   *  tail + the actively-streaming last line) instead of the whole 500-line
   *  transcript. This is the fix for the freeze while the agent works. */
  let transCache: { text: string; out: string[] }[] = [];
  let transMw = 0;

  const width = () => process.stdout.columns || 100;
  const height = () => process.stdout.rows || 34;

  const push = (kind: LineKind, text: string) => {
    state.lines.push({ kind, text });
    state.chatVer++;
    if (state.lines.length > state.limit) state.lines.splice(0, state.lines.length - state.limit);
    if (!state.userScrolled) state.scroll = 0;
    scheduleRender();
  };

  const scheduleRender = () => {
    if (renderQueued) return;
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
      state.spinner = (state.spinner + 1) % SPINNER.length;
      if (state.splashTick < SPLASH_TICKS) {
        state.splashTick++;
        // Ease toward done: fast at first, slower near 1; first user prompt
        // or any runtime event jumps it to full so the splash never blocks.
        state.splashProgress = Math.min(1, Math.max(state.splashProgress + 0.03, state.splashTick / SPLASH_TICKS));
        if (state.splashTick >= SPLASH_TICKS) state.splashProgress = 1;
      }
      scheduleRender();
    }, 160);
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
      for (const word of paragraph.split(/(\s+)/)) {
        if (visibleLen(line + word) > max) {
          if (line.trim()) out.push(line.trimEnd());
          line = word.startsWith(' ') ? word.slice(1) : word;
        } else {
          line += word;
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
    for (let i = grow; i < state.lines.length; i++) transCache.push({ text: '', out: [] });
    let dirty = 0;
    while (dirty < transCache.length && dirty < state.lines.length && transCache[dirty].text === state.lines[dirty].text) dirty++;
    for (let i = dirty; i < state.lines.length; i++) {
      transCache[i].text = state.lines[i].text;
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
    const rows: string[] = [];
    const entries = renderEntry({ kind: line.kind, text }, false);
    for (const e of entries) {
      for (const seg of e.split('\n')) {
        const wrapped = wrap(seg, Math.max(10, maxWidth));
        for (const wLine of wrapped) rows.push(wLine);
      }
    }
    rows.push('');
    return rows;
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
    // A single bad frame must never freeze the whole UI: recover, log, and
    // reschedule instead of throwing out of the render loop.
    try {
      renderFrame();
    } catch (e) {
      renderQueued = false;
      process.stdout.write(`${T.reset}${SHOW}\r\n${T.error}[mochi render error] ${e instanceof Error ? e.message : String(e)}${T.reset}\r\n${HIDE}`);
      setTimeout(() => scheduleRender(), 300);
    }
  }

  function renderFrame() {
    const w = width();
    const h = height();

    // 4 status rows when tall (model+toggle, ctx/cache bars, workspace+git,
    // auto-approve); 3 when short (bars folded away).
    const statusRows: number = h >= 24 ? 4 : 3;
    const composerRows = state.input ? Math.min(6, Math.ceil(state.input.length / Math.max(10, w - 8)) + 2) : 3;
    const bottomRows = composerRows + statusRows;
    const contentH = Math.max(1, h - bottomRows - 1);

    const indent = transcriptIndent(w);
    const chatMw = Math.min(w - indent * 2, Math.max(24, w - 4));

    const chatLines = transcriptLines(chatMw);
    const visible = chatLines.slice(Math.max(0, chatLines.length - contentH - state.scroll), Math.max(0, chatLines.length - state.scroll));

    const rows: string[] = new Array(h).fill('');
    const lead = ' '.repeat(indent);
    if (state.splashTick < SPLASH_TICKS) {
      // Splash with REAL loading progress: providers/skills/graph milestones
      // push splashProgress; the bar fills with them and the sheen animates.
      const splash = splashFrame(state.splashTick, w, pkg.version, state.splashProgress);
      const top = Math.max(0, Math.floor((contentH - splash.length) / 2));
      for (let i = 0; i < splash.length && i < contentH; i++) {
        rows[top + i] = splash[i];
      }
    } else {
      for (let i = 0; i < contentH; i++) {
        const r = i;
        rows[r] = lead + (visible[i] ?? '');
      }
    }

    // thinking line pinned under the transcript while busy
    if (state.busy) {
      const r = Math.max(0, contentH - 1);
      rows[r] = lead + thinkingLine(state.spinner, state.currentTool || state.currentTask || '');
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

    // ---- 3-row status bar (cline StatusBar) ----
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
    const s1 = h - bottomRows;          // model + context + Plan/Act
    const s2 = s1 + 1;                  // animated ctx + cache bars
    const s3 = s2 + 1;                  // workspace (branch) | git stats
    const s4 = s3 + 1;                  // auto-approve
    rows[s1] = statusBarRow1(statusModel, w);
    // jcode-style animated gradient bars, shimmering while busy.
    const ctx = gradientContextBar(state.inTokens + state.outTokens, runtime.config.safety.contextBudgetTokens, 12, state.busy ? state.spinner + 1 : 0);
    // Cache bar: share of prompt tokens served from cache this session.
    const promptTotal = state.inTokens + state.cacheTokens;
    const cacheRate = promptTotal > 0 ? Math.min(1, state.cacheTokens / promptTotal) : 0;
    const cache = gradientCacheBar(cacheRate, 10, state.busy ? state.spinner + 1 : 0);
    const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const barsRow = ` ${T.gray}in${T.reset} ${T.cyan}${fmt(state.inTokens)}${T.reset} ${T.gray}out${T.reset} ${T.orange}${fmt(state.outTokens)}${T.reset}  ${ctx.text} ${T.gray}${Math.round(ctx.pct * 100)}%${T.reset}  ${T.gray}cache${T.reset} ${cache.text} ${T.lime}${fmt(state.cacheTokens)}${T.reset}`;
    if (statusRows === 4) {
      rows[s2] = barsRow;
      rows[s3] = statusBarRow2(statusModel, w);
      rows[s4] = statusBarRow3(state.autoApprove, w);
    } else {
      // short terminal: drop the bars row, keep the classic 3-row layout
      rows[s2] = statusBarRow2(statusModel, w);
      rows[s3] = statusBarRow3(state.autoApprove, w);
    }

    // ---- composer (cline InputBar) ----
    const cTop = s1 + statusRows;
    rows[cTop] = composerTopRule(w);
    const innerW = Math.max(1, w - 6);
    const rawRows = state.input ? wrap(state.input, innerW) : [''];
    const shownRows = rawRows.slice(-4);
    for (let i = 0; i < shownRows.length; i++) {
      const r = cTop + 1 + i;
      if (r < h) {
        rows[r] = state.input
          ? composerRow(shownRows[i], w)
          : composerPlaceholderRow('Message mochi… (type / for commands)', w);
      }
    }
    rows[h - 1] = composerBottomRule(w, state.uiMode === 'plan' ? '⏎ send · Tab → act · esc stop' : '⏎ send · Tab → plan · esc stop');

    // ---- centered menu overlay (kept from before) ----
    if (state.menuActive) {
      const menuH = Math.min(state.menuItems.length + 4, h - 4);
      const menuTop = Math.max(1, Math.floor((h - menuH) / 2));
      const menuW = Math.min(Math.max(50, Math.floor(w * 0.6)), w - 6);
      const mLeft = Math.floor((w - menuW) / 2);
      rows[menuTop] = T.rule + '╭' + '─'.repeat(menuW - 2) + '╮' + T.reset;
      rows[menuTop + 1] = T.rule + '│' + T.reset + ' ' + T.bold + state.menuTitle + T.reset + ' ' + T.grayDark + '↑/↓ · Enter · Esc' + T.reset + ' '.repeat(Math.max(0, menuW - 6 - visibleLen(state.menuTitle) - 18)) + T.rule + '│' + T.reset;
      for (let mi = 0; mi < menuH - 3 && menuTop + 2 + mi < h - bottomRows; mi++) {
        const r = menuTop + 2 + mi;
        const sel = mi === state.menuSelected;
        const item = state.menuItems[mi] ?? '';
        const mark = state.menuMark.has(mi);
        const body = (sel ? T.act + '❯ ' : '  ') + (mark ? T.pink + '● ' : '  ') + (sel ? T.bold : '') + item + T.reset;
        rows[r] = T.rule + '│' + T.reset + ' ' + body + ' '.repeat(Math.max(0, menuW - 4 - visibleLen(item) - 3)) + T.rule + '│' + T.reset;
      }
      rows[menuTop + menuH - 1] = T.rule + '╰' + '─'.repeat(menuW - 2) + '╯' + T.reset;
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
    push('user', line);

    if (line === '/exit' || line === '/quit') {
      exit();
      return;
    }
    if (line === '/help') { pushHelp(); return; }
    if (line === '/clear') { state.lines = []; state.tasks.clear(); state.scroll = 0; scheduleRender(); return; }
    if (line === '/status' || line === '/changes') { await run(async () => (await import('../git.js')).status(projectRoot)); return; }
    if (line === '/diff') { await run(async () => (await import('../git.js')).diff(projectRoot)); return; }
    if (line === '/model') { push('system', `${runtime.config.model.provider}/${runtime.config.model.model}`); return; }
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
    if (line.startsWith('/inspect ')) { await run(async () => (await runtime.inspect(line.slice(9).trim())).summary); return; }
    if (line.startsWith('/plan ')) { await run(async () => runtime.plan(line.slice(6).trim())); return; }
    if (line === '/approve') { await run(async () => runtime.approvePlan(), false); return; }
    if (line.startsWith('/team ')) { await run(async () => runtime.team(line.slice(6).trim()), false); return; }
    if (line.startsWith('/goal ')) { await run(async () => runtime.goal(line.slice(6).trim()), false); return; }
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
    if (line === '/sessions' || line === '/resume') { await run(async () => listSessions()); return; }
    if (line === '/export') { await exportSession(); return; }
    if (line === '/import') { await importFlow(); return; }
    if (line === '/new' || line === '/clear-all') { state.lines = []; state.tasks.clear(); state.scroll = 0; push('system', 'New session.'); scheduleRender(); return; }
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
    if (line === '/stop' || line === '/abort') { state.busy = false; stopSpinner(); scheduleRender(); return; }
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
      push('system', '⚡ YOLO mode ENABLED — all permission prompts bypassed. Type /yolo off to restore.');
      scheduleRender();
      return;
    }
    if (line === '/yolo off' || line === '/dangerously-skip-permissions off') {
      (runtime as any).__permPolicy = 'strict';
      push('system', '🛡️  YOLO mode disabled. Strict permissions restored.');
      scheduleRender();
      return;
    }
    if (line === '/workspace-safe') {
      (runtime as any).__permPolicy = 'workspace-safe';
      push('system', '🔓 Workspace-safe mode: reads + workspace edits auto-approved, shell requires approval.');
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
    if (line === '/tools') { push('system', 'read, write, edit, delete, search, glob, shell, git, inspect, memory, get_function, find_callers, type_hierarchy'); return; }
    if (line === '/history') { await run(async () => state.history.slice(-20).join('\n') || 'No history.'); return; }

    // Free-form prompt (already echo:false — agent pushes its own turns via events)
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
    const idx = await openMenu('Select a provider to login', PROVIDERS.map(p => `${p.id}  ·  ${p.name}`));
    if (idx < 0) return;
    const prov = PROVIDERS[idx];
    // Let them pick a model first (or skip to default).
    const modelIdx = await openMenu(`Select a model (${prov.name})`, prov.models.map((m) => m), new Set([prov.models.indexOf(prov.defaultModel)]));
    const model = modelIdx >= 0 ? prov.models[modelIdx] : prov.defaultModel;
    const envKey = prov.envKey ? process.env[prov.envKey] : undefined;
    // Reuse an already-stored key for this provider so re-login doesn't force re-entry.
    const storedKey = runtime.config.model.provider === prov.id ? runtime.config.model.apiKey : undefined;
    const apiKey = envKey || storedKey || await ask(`${prov.name}: API key`);
    if (!apiKey && prov.envKey) { push('error', `No API key for ${prov.id}. Set $${prov.envKey} or type one.`); return; }
    if (!apiKey) { push('error', 'No API key provided'); return; }
    await run(async () => runtime.loginProvider(prov.id, apiKey, model || prov.defaultModel));
  }

  async function providerMenu() {
    const activeProvider = runtime.config.model.provider;
    const mark = new Set(PROVIDERS.map((p, i) => (p.id === activeProvider ? i : -1)).filter((i) => i >= 0));
    const idx = await openMenu('Providers (select to view)', PROVIDERS.map(p => `${p.id}  ·  ${p.name}${p.id === activeProvider ? '  (active)' : ''}`), mark);
    if (idx < 0) return;
    const p = PROVIDERS[idx];
    push('system', `${p.name}\nbase: ${p.baseUrl}\nmodels: ${p.models.join(', ') || 'none listed'}`);
    scheduleRender();
  }

  async function modelMenu() {
    const cur = providerById(runtime.config.model.provider);
    if (!cur) { push('error', 'Current provider unknown.'); return; }
    const activeModel = runtime.config.model.model;
    const idx = await openMenu(`${cur.name} · select model`, cur.models.map((m) => `${m}${m === activeModel ? '  (active)' : ''}`));
    if (idx < 0) return;
    const model = cur.models[idx];
    await run(async () => runtime.useProvider(cur.id, model));
  }

  async function listSessions(): Promise<string> {
    try {
      const { readdirSync, existsSync } = await import('node:fs');
      const dir = runtime.workspace.path('state');
      if (!existsSync(dir)) return 'No sessions yet.';
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      return files.length ? files.join('\n') : 'No sessions yet.';
    } catch (e) {
      return 'Error listing sessions: ' + (e instanceof Error ? e.message : String(e));
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
    push('system', text);
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
    // Mouse wheel (SGR protocol): CSI < 64 ; row ; col M = scroll up,
    // CSI < 65 ; row ; col M = scroll down. Only active when mouse tracking
    // is enabled (see start()). Intercept before the generic escape router.
    const wheel = s.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (wheel) {
      scrollTranscript(Number(wheel[1]) === 64 ? 3 : -3);
      return;
    }
    // Shift+Tab arrives as CSI Z — intercept before the escape router.
    if (s.startsWith('\x1b[Z')) {
      state.autoApprove = !state.autoApprove;
      (runtime as any).__permPolicy = state.autoApprove ? 'yolo' : 'strict';
      push('system', state.autoApprove ? '⏵⏵ Auto-approve ENABLED — all permission prompts bypassed.' : 'Auto-approve off — strict permissions restored.');
      scheduleRender();
      return;
    }
    let i = 0;
    // Menu mode: handle navigation keys only.
    if (state.menuActive) {
      if (s === '\x1b[A') { state.menuSelected = Math.max(0, state.menuSelected - 1); scheduleRender(); return; }
      if (s === '\x1b[B') { state.menuSelected = Math.min(state.menuItems.length - 1, state.menuSelected + 1); scheduleRender(); return; }
      if (s === '\x1b[C' || s === '\x1b[D') { scheduleRender(); return; }
      if (s === '\r' || s === '\n') { const idx = state.menuSelected; closeMenu(idx); return; }
      if (s === '\x1b') { closeMenu(-1); return; }
      if (s === '\x1b[5~') { scheduleRender(); return; }
      if (s === '\x1b[6~') { scheduleRender(); return; }
      const n = parseInt(s, 10);
      if (!Number.isNaN(n) && n >= 0 && n < state.menuItems.length) { state.menuSelected = n; scheduleRender(); return; }
      return;
    }
    while (i < s.length) {
      const c = s[i];
      if (c === '\r' || c === '\n') {
        // Dropdown active: Enter completes the selected slash command — unless
        // the input already IS that exact command, in which case run it.
        if (state.dropActive) {
          const items = currentDropItems();
          const pick = items[Math.min(state.dropSelected, items.length - 1)];
          const exactMatch = items.length === 1 && state.input.trim() === items[0].name;
          if (pick && state.input.startsWith('/') && !exactMatch) {
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
      // Single ESC: clear input context (not a termination key)
      if (c === '\x1b') {
        const rest = s.slice(i);
        const m = rest.match(/^\x1b\[[0-9]*[A-Za-z~]/);
        if (m) {
          handleEscape(m[0]);
          i += m[0].length;
          continue;
        }
        // Double-tap ESC within 400ms: request clean abort (not immediate exit)
        const now = Date.now();
        if (rest === '\x1b') {
          if (now - lastEscAt < 400 && !state.busy) {
            runtime.abort('User requested exit via double ESC');
          }
          lastEscAt = now;
          state.input = '';
          state.cursor = 0;
          if (state.menuActive) closeMenu(-1);
          scheduleRender();
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (c === '\u0003') {
        if (state.input.length > 0) {
          state.input = '';
          state.cursor = 0;
        } else {
          exit();
        }
        scheduleRender();
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
        // Tab: cycle slash autocomplete when open, else toggle Plan/Act.
        const items = currentDropItems();
        if (items.length > 1 && state.input.startsWith('/')) {
          state.dropSelected = (state.dropSelected + 1) % Math.min(items.length, 6);
        } else {
          state.uiMode = state.uiMode === 'plan' ? 'act' : 'plan';
          runtime.config.planMode = state.uiMode === 'plan';
        }
        state.dropActive = currentDropItems().length > 0;
        scheduleRender();
        continue;
      }
      // Accumulate a printable run.
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
      case '\x1b[5~': scrollTranscript(10); return;
      case '\x1b[6~': scrollTranscript(-10); return;
      case '\x1b[3~': state.input = state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1); break;
      default: break;
    }
    scheduleRender();
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
    const maxScroll = Math.max(0, state.lines.length);
    // Up (delta > 0): scroll deeper into history, enter manual mode.
    if (delta > 0) {
      state.scroll = Math.min(maxScroll, state.scroll + delta);
      if (state.scroll > 0) state.userScrolled = true;
    } else {
      // Down (delta < 0): closer to bottom; exit manual mode at the newest line.
      state.scroll = Math.max(0, state.scroll + delta);
      if (state.scroll <= 0) state.userScrolled = false;
    }
    scheduleRender();
  }

  function onRuntimeEvent(event: MochiEvent) {
    // First real event (model streaming, tools) means startup is done: finish
    // the splash immediately so it never covers live output.
    if (state.splashTick < SPLASH_TICKS) {
      state.splashTick = SPLASH_TICKS;
      state.splashProgress = 1;
    }
    // Delegate to the pure, tested reducer (src/tui/state.ts): it maintains
    // the transcript, task tree, current tool, and stop reasons exactly as the
    // tests assert. Non-rendering events return false and skip the redraw.
    if (reduceEvent(state, event as unknown as Record<string, unknown>)) {
      if (!state.userScrolled) state.scroll = 0;
      scheduleRender();
    }
    // Keep the status bar's git stats + token meter live.
    const type = String((event as any).type);
    if (type === 'file:changed' || type === 'tool:completed') void refreshGitStats();
    if (type === 'usage:updated') {
      // REAL provider numbers: input (net of cache hits), output, cache reads.
      state.inTokens = Number((event as any).inputTokens ?? 0);
      state.outTokens = Number((event as any).outputTokens ?? 0);
      state.cacheTokens = Number((event as any).cacheTokens ?? 0);
      state.totalTokens = Number((event as any).totalTokens ?? 0);
      scheduleRender();
    }
  }

  function start() {
    // Enable SGR mouse reporting so the scroll wheel (and future click-to-focus)
    // reach stdin as escape sequences. Disabled again on exit.
    process.stdout.write(ALT_ENTER + HIDE + '\x1b[?1000h\x1b[?1006h');
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const keyListener = (buf: Buffer) => onKey(buf);
    process.stdin.on('data', keyListener);
    const resizeListener = () => scheduleRender();
    process.stdout.on('resize', resizeListener);
    const exitListener = () => {
      process.stdout.write(`${RESET}${SHOW}${ALT_EXIT}\x1b[?1000l\x1b[?1006l`);
    };
    process.on('exit', exitListener);
    runtime.events.onAll(onRuntimeEvent);
    void refreshGitStats(); // seed the status bar diff stats
    cleanupFns = [
      () => process.stdin.off('data', keyListener),
      () => process.stdout.off('resize', resizeListener),
      () => process.off('exit', exitListener),
    ];
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

async function gitBranch(cwd: string): Promise<string> {
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
      let files = 0, additions = 0, deletions = 0;
      for (const line of stdout.toString().split('\n')) {
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
