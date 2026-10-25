import {highlightRange} from './selection.js';
import { execFile, execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { findProjectRoot } from '../repo/repo.js';
import { Runtime } from '../runtime.js';
import type { MochiEvent } from '../types.js';
import { PROVIDERS, providerById } from '../model/providers.js';
import { loadKeyring, storedKeyForProvider, deleteKeyringKey, accountsFor as accountsForKr, activeAccountName as activeAccountForKr, switchAccount as switchAccountKr, deleteAccount as deleteAccountKr } from '../model/keyring.js';
import { reduceEvent, trimTranscript, rewrapSummaries, resolveCommandPrefix, type TuiLine, type SpawnLedgerEntry } from './state.js';
import { renderSubagentPanel, subagentPanelRowCount } from './subagent-panel.js';
import { describeProviderFailure } from '../model/provider-failure.js';
import { wrap, visibleLen, cellColToIndex, indexToCellCol } from './wrap.js';
import { terminateRow, paintCanvasBg } from './ansi-hygiene.js';
import { prefersReducedMotion, applyTheme, canvasBg, tabActiveBg } from './themes.js';
import { TabManager, tabBarCells, tabBarHit, slugTitle } from './tabs.js';
import { chromeLayout } from './chrome.js';
import pkg from '../../package.json' with { type: 'json' };
import { kvCache } from '../model/kv-cache.js';
import { SessionHub } from '../state/session-hub.js';
import { prefetchBadge } from '../core/prefetch.js';
import { recordFeedback } from '../observability/feedback.js';
import type { FeedbackVerdict } from '../observability/feedback.js';
import { formatModes, isMode } from '../modes.js';
import type { AgentMode } from '../modes.js';
import { describeToolArgs } from './cards.js';
import {
  T,
  R,
  setTheme,
  getAllThemes,
  getCurrentTheme,
  themeSwatch,
  splashFrame,
  SPLASH_TICKS,
  farewellFrame,
  statusBarRow1,
  statusBarRow2,
  createStreamMarkdownRenderer,
  type StreamMarkdownRenderer,
  renderDropdown,
  composerRow,
  composerPlaceholderRow,
  composerTopRule,
  composerBottomRule,
  transcriptIndent,
  spinnerFrame,
  thinkingLine,
  doneLine,
  resolveVerb,
  getThemeSpinnerColors,
  ellipsize,
  maskSecretInput,
} from './view.js';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ALT_ENTER = '\x1b[?1049h';
const ALT_EXIT = '\x1b[?1049l';
const NO_AUTOWRAP = '\x1b[?7l';
const AUTOWRAP = '\x1b[?7h';
const BRACKET_PASTE_ON = '\x1b[?2004h';
const BRACKET_PASTE_OFF = '\x1b[?2004l';
const RESET = '\x1b[0m';
const OSC_BG_BLACK = '\x1b]11;#1a1a1a\x07';
const OSC_BG_RESET = '\x1b]111\x07';

type LineKind = 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'task' | 'goal' | 'plain' | 'thought' | 'summary';

interface Line {
  kind: LineKind;
  text: string;
  fullContent?: string;
  metadata?: {
    tool?: string;
    args?: unknown;
    output?: string;
    filePath?: string;
    title?: string;
    isCode?: boolean;
    isTruncated?: boolean;
    hiddenRows?: number;
  };
}

interface TaskView {
  id: string;
  title: string;
  role: string;
  status: string;
}

const COMMANDS = [
  { name: '/help', hint: 'Show commands' },
  { name: '/onboard', hint: 'Cozy setup: import keys, models, skills, MCPs, editors' },
  { name: '/setup', hint: 'Interactive setup: import keys, models, skills, MCPs, editors' },
  { name: '/inject', hint: 'Universal agent injection: adopt keys, models, skills & MCP tools' },
  { name: '/adopt', hint: 'Adopt skills, models, keys & MCP tools from your other agents' },
  { name: '/welcome', hint: 'Show welcome screen and setup wizard' },
  { name: '/expand', hint: 'Inspect uncompressed code, hidden reasoning & tool output (or press Ctrl+O)' },
  { name: '/clear', hint: 'Clear transcript' },
  { name: '/update', hint: 'Check GitHub releases & upgrade Mochi (/update --check to only look)' },
  { name: '/version', hint: 'Show version, install style & update status' },
  { name: '/copy', hint: 'Copy last assistant message to clipboard (works without mouse)' },
  { name: '/model', hint: 'Select AI model provider & model' },
  { name: '/reasoning', hint: 'Adjust reasoning effort & compute (low, medium, high, max)' },
  { name: '/fallback', hint: 'Configure fallback / failover models' },
  { name: '/account', hint: 'Switch or inspect active account (/account or /account <email>)' },
  { name: '/accounts', hint: 'List available accounts for active provider' },
  { name: '/switch', hint: 'Switch account for active provider' },
  { name: '/resume', hint: 'Resume an interrupted session or goal (/resume or /resume <id>)' },
  { name: '/collab', hint: 'Inter-session messaging hub (send to or list other tabs)' },
  { name: '/send', hint: 'Send message to another session/tab (/send <tab#> <message>)' },
  { name: '/theme', hint: 'Select color theme (23 styles)' },
  { name: '/skills', hint: 'Browse, search & activate specialized engineering skills' },
  { name: '/mcp', hint: 'Search, add & manage MCP servers (1-command install)' },
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
  { name: '/redo', hint: 'Re-run the last prompt or command' },
  { name: '/rewind', hint: 'Rollback to last checkpoint' },
  { name: '/yolo', hint: 'Toggle auto-approve for all tool actions' },
  { name: '/workspace-safe', hint: 'Auto-approve edits, prompt for shell' },
  { name: '/plugins', hint: 'List installed plugins' },
  { name: '/profiles', hint: 'List specialized agent profiles' },
  { name: '/memory', hint: 'Show project memory and learned rules' },
  { name: '/rules', hint: 'Show/edit the MOCHI.md behavioral contract' },
  { name: '/feedback', hint: 'Show recent 👍/👎 feedback signal (or /good, /bad)' },
  { name: '/good', hint: 'Rate last assistant response with 👍' },
  { name: '/bad', hint: 'Rate last assistant response with 👎' },
  { name: '/history', hint: 'Interactive session manager & history' },
  { name: '/rename', hint: 'Rename current conversation session' },
  { name: '/export', hint: 'Export session transcript to JSON' },
  { name: '/import', hint: 'Import session transcript' },
  { name: '/usage', hint: 'Show token usage, costs, and cache hits' },
  { name: '/tokens', hint: 'Show token breakdown and prompt cache efficiency' },
  { name: '/stats', hint: 'Show real-time performance and cost statistics' },
  { name: '/self-train', hint: 'Auto-improve Mochi: self-review, iterate to done, train its own skills/code' },
  { name: '/doctor', hint: 'Diagnose workspace configuration' },
  { name: '/init', hint: 'Create project MOCHI.md instructions' },
  { name: '/context', hint: 'Show context usage health (colored bar + tips)' },
  { name: '/compact', hint: 'Compact the session transcript, optionally keeping lines about [focus]' },
  { name: '/review', hint: 'Review the working-tree diff before commit [staged|last]' },
  { name: '/security-review', hint: 'Security-focused review of the diff [staged|last]' },
  { name: '/new', hint: 'Start a fresh conversation session' },
  { name: '/close', hint: 'Close and exit the current session tab (Alt+W)' },
  { name: '/tab', hint: 'Multi-session tabs: new|close|next|prev|rename|list|N (Alt+T/W/1-8)' },
  { name: '/team', hint: 'Run concurrent specialist agents on one objective' },
  { name: '/image', hint: 'Attach image file(s) to your next message [path...|clear]' },
  { name: '/run', hint: 'Run a shell command and show output' },
  { name: '/shell', hint: 'Run a shell command and show output' },
  { name: '/test', hint: 'Run the detected repo test command [extra args]' },
  { name: '/watch', hint: 'Run the repo check now (test > typecheck > build); CLI `mochi watch` for continuous' },
  { name: '/bundle', hint: 'Write a diagnostic bundle (transcript + diff + doctor) to a file' },
  { name: '/update', hint: 'Check GitHub releases for a newer Mochi (prints notes + upgrade command)' },
  { name: '/explain', hint: 'Explain how a symbol, file, or concept works [target]' },
  { name: '/checkpoint', hint: 'Save a named git snapshot of the workspace' },
  { name: '/rollback', hint: 'Restore the last checkpoint' },
  { name: '/tools', hint: 'Browse, inspect & run agent tools' },
  { name: '/branch', hint: 'Branch the current session (forks the transcript, keeps lineage) [title]' },
  { name: '/skip', hint: 'Skip/interrupt current in-flight task' },
  { name: '/stop', hint: 'Interrupt current in-flight task' },
  { name: '/exit', hint: 'Quit Mochi CLI' },
];


export async function launchTui(runtime: Runtime, initialPrompt?: string): Promise<void> {
  const projectRoot = findProjectRoot(runtime.cwd, initialPrompt);
  const projectName = basename(projectRoot);
  let branch = '';
  void gitBranch(projectRoot).then((b) => {
    branch = b;
    scheduleRender();
  });
  let modelShort = runtime.config.model.model.split('/').pop() ?? runtime.config.model.model;

  // Background update check — never blocks or delays startup. When a new
  // GitHub release exists, drop a notice into the transcript suggesting
  // /update. Cached 24h; silent on any failure (offline, rate-limit).
  // MCH-TDZ: scheduleRender is declared further down (line ~661) — resolving
  // this promise before init completes threw "Cannot access 'scheduleRender'
  // before initialization" (crash.log, repeated). Defer via setTimeout(0) so
  // the callback runs after the constructor body finishes.
  // MCH-TDZ: the update-check block MOVED below scheduleRender's declaration
  // (line ~679) — a setTimeout(0) deferral still left `push`/`scheduleRender`
  // statically used-before-declared (TS2448) and could fire mid-init.

  // Paint the saved theme immediately on launch. NOTE: never persist here —
  // persisting a fallback-resolved theme would CLOBBER the user's files when
  // the saved id is momentarily unresolvable (e.g. stale dist). Persistence
  // happens only on explicit user action (/theme, theme menu).
  const savedTheme = getCurrentTheme();
  setTheme(savedTheme.id);

  // First-message latency: the prompt path cold-imports a cascade of modules
  // (goals/task, context, security/sandbox, observability/trace, repo/repo,
  // node:child_process). Each costs 20-230ms cold — summed, that was the
  // ~1s "mochi freezes for a second when I send the first message" jank.
  // Pre-warm them NOW in the background so the first message hits warm cache.
  for (const mod of [
    '../goals/task.js', '../context.js', '../security/sandbox.js',
    '../observability/trace.js', '../repo/repo.js', '../core/taskkind.js',
  ]) {
    void import(mod).catch(() => { /* best-effort warmup */ });
  }

  // Tab bar occupies the top rows (row 0: tabs, row 1: breathing margin).
  const TAB_BAR_ROWS = 2;

  let state = {
    input: '',
    cursor: 0,
    history: [] as string[],
    historyIndex: -1,
    lines: [] as Line[],
    tasks: new Map<string, TaskView>(),
    busy: false,
    busyStartedAt: 0,
    doneAt: 0,
    lastDoneElapsed: '',
    spinner: 0,
    scroll: 0,
    startedAt: Date.now(),
    promptActive: false,
    /** A secret prompt (API key) is armed: composer input renders masked. */
    promptSecret: false,
    menuActive: false,
    menuTitle: '',
    menuItems: [] as string[],
    menuSelected: 0,
    menuMark: new Set<number>(),
    currentTool: '' as string,
    currentTask: '' as string,
    activeSubagents: new Map<string, { id: string; role: string; prompt: string; startedAt: number }>(),
    /** Spawn ledger (W3-4): per-child status + token spend for the panel. */
    spawnLedger: new Map<string, SpawnLedgerEntry>(),
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
    autoApprove: runtime.permPolicy === 'yolo',
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
    /** live model-turn count + routing evidence for the status bar (W3-4) */
    turns: 0 as number,
    activeModel: undefined as string | undefined,
    routingReason: undefined as string | undefined,
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
    /** Click-count tracking for double/triple-click selection (word / line). */
    lastClickAt: 0,
    lastClickRow: -1,
    clickCount: 1,
    /** true while receiving a bracketed-paste block. */
    pasting: false,
    /** set true to abort the current auto-improve loop. */
    autoImproveAbort: false,
    /** Uncompressed Inspector Pager (Ctrl+O) state */
    inspectorActive: false,
    inspectorTitle: '',
    inspectorLines: [] as string[],
    inspectorScroll: 0,
  };

  /** Per-tab TUI state object (same shape as the active `state` binding). */
  type AppState = typeof state;

  // ---- Multi-tab sessions (opencode-style) ---------------------------------
  // Each tab owns an isolated Runtime (own abort, session, budget) plus its
  // own transcript/input/scroll state. `state` + `runtime` are rebound on
  // every switch, so the hundreds of existing references keep working
  // untouched. Background runs continue; their events badge the tab unread.
  const tabs = new TabManager();
  const tabStates = new Map<string, AppState>();
  const tabRuntimes = new Map<string, Runtime>();
  let activeTabId = tabs.activeTab().id;
  tabStates.set(activeTabId, state);
  tabRuntimes.set(activeTabId, runtime);

  /** Render the pinned top tab-bar row from the shared layout (tabs.ts), so
   *  styled columns match hit-test columns EXACTLY (ANSI is zero-width).
  /** Tab bar row for the top of the terminal:
   *  opencode-style surface pills: breathing purple dot for running tabs,
   *  green check for completed tabs, red cross for errors, soft purple dot for idle,
   *  and clickable close button on each tab + `+` button. */
  let lastActiveTabRange: [number, number] | null = null;

  function sendSystemNotification(title: string, body: string, urgency: 'low' | 'normal' | 'critical' = 'normal') {
    // 1. Terminal escape sequences (OSC 9 + OSC 777 + Bell) for terminal emulator integration
    try {
      safeWrite(`\x07\x1b]9;Mochi: ${title} - ${body}\x07\x1b]777;notify;Mochi;${title} - ${body}\x07`);
    } catch { /* ignore */ }

    // 2. Real OS desktop notification (notify-send on Linux / osascript on macOS)
    try {
      import('node:child_process').then(({ spawn }) => {
        if (process.platform === 'linux') {
          const child = spawn('notify-send', ['-a', 'Mochi', '-u', urgency, title, body], {
            stdio: 'ignore',
            detached: true,
          });
          child.unref();
        } else if (process.platform === 'darwin') {
          const safeBody = body.replace(/"/g, '\\"');
          const safeTitle = title.replace(/"/g, '\\"');
          const script = `display notification "${safeBody}" with title "Mochi" subtitle "${safeTitle}"`;
          const child = spawn('osascript', ['-e', script], {
            stdio: 'ignore',
            detached: true,
          });
          child.unref();
        }
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  function tabBarRow(w: number): string {
    const tabList = tabs.list();
    const layout = tabBarCells(tabList, activeTabId, w);
    const activeIdx = layout.cells.findIndex((c) => c.tabId === activeTabId);
    lastActiveTabRange = (activeIdx >= 0 && layout.ranges[activeIdx]) ? layout.ranges[activeIdx] : null;

    // Tab chrome follows the theme: pill + plus use the canvas/active
    // backgrounds, titles use fg/gray, completion uses the theme's own
    // success/error — no fixed purple anywhere, so all 23 themes re-skin it.
    const ACTIVE_BG = tabActiveBg();
    const PLUS_BG = canvasBg();

    const styled = layout.cells.map((c) => {
      if (c.tabId === null) {
        return `${PLUS_BG}\x1b[1m${T.act}${c.plain}${T.reset}`;
      }
      const isActive = c.tabId === activeTabId;
      const tab = tabList.find((t) => t.id === c.tabId);
      const isBusy = tab?.busy ?? false;
      const status = tab?.status ?? (isBusy ? 'running' : 'idle');

      let iconColored = '';
      if (isBusy || status === 'running') {
        const frame = spinnerFrame(state.spinner);
        const stops = getThemeSpinnerColors();
        const c = stops[state.spinner % stops.length];
        iconColored = `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${frame}`;
      } else if (status === 'done') {
        iconColored = `${T.success}✓`;
      } else if (status === 'error') {
        iconColored = `${T.error}✗`;
      } else {
        iconColored = isActive ? `${T.act}•` : `${T.grayDark}•`;
      }

      const unread = c.unread ? ` ${T.act}•` : '';

      if (isActive) {
        const titleText = `\x1b[1m${T.fg}${c.title}`;
        const closeText = tabList.length > 1 ? `${T.grayDark}×` : ' ';
        return `${ACTIVE_BG} ${iconColored}${ACTIVE_BG} ${titleText}${unread}${ACTIVE_BG} ${closeText}${T.reset} `;
      } else {
        const titleText = `${T.gray}${c.title}`;
        const closeText = tabList.length > 1 ? `${T.grayDark}×` : ' ';
        return ` ${iconColored} ${titleText}${unread} ${closeText}${T.reset} `;
      }
    });

    const rendered = styled.join('');
    const remaining = Math.max(0, w - layout.width);

    // Dynamic right-aligned context indicators (git branch, active model, and version)
    let rightBadge = '';
    let rightBadgeLen = 0;

    const branchPart = branch ? `${T.act}⎇ ${T.fg}${branch}\x1b[0m` : '';
    const branchLen = branch ? 2 + branch.length : 0;
    const modelPart = modelShort ? `${T.gray}${modelShort}\x1b[0m` : '';
    const modelLen = modelShort ? modelShort.length : 0;
    const verPart = `${T.grayDark}v${pkg.version}\x1b[0m`;
    const verLen = 1 + pkg.version.length;
    const dotSep = `${T.grayDark} · \x1b[0m`;

    if (branchPart && modelPart && verPart && remaining >= branchLen + 3 + modelLen + 3 + verLen + 4) {
      rightBadge = `${branchPart}${dotSep}${modelPart}${dotSep}${verPart}`;
      rightBadgeLen = branchLen + 3 + modelLen + 3 + verLen;
    } else if (branchPart && modelPart && remaining >= branchLen + 3 + modelLen + 4) {
      rightBadge = `${branchPart}${dotSep}${modelPart}`;
      rightBadgeLen = branchLen + 3 + modelLen;
    } else if (modelPart && remaining >= modelLen + 4) {
      rightBadge = modelPart;
      rightBadgeLen = modelLen;
    } else if (branchPart && remaining >= branchLen + 4) {
      rightBadge = branchPart;
      rightBadgeLen = branchLen;
    }

    const rightSuffix = rightBadge && remaining >= rightBadgeLen + 2
      ? `${' '.repeat(remaining - rightBadgeLen - 1)}${rightBadge} `
      : ' '.repeat(remaining);

    return `${rendered}${rightSuffix}${T.reset}`;
  }

  /** Click handling for the tab bar (screen row 0, 0-based column). */
  function tabBarClick(col: number): void {
    if (state.menuActive || state.promptActive || state.inspectorActive) return;
    const layout = tabBarCells(tabs.list(), activeTabId, width());
    const hit = tabBarHit(layout, col);
    if (!hit) return;
    try {
      if (hit.kind === 'plus') {
        // New tabs boot clean (empty transcript and clean runtime).
        newTab();
      } else if (hit.kind === 'close') {
        closeTab(hit.index);
      } else {
        switchTab(hit.index);
      }
    } catch (e) {
      push('error', e instanceof Error ? e.message : String(e));
    }
    scheduleRender();
  }

  /** Switch the active bindings to another tab (state + runtime + caches). */
  function switchTab(index: number): void {
    if (state.menuActive || state.promptActive || state.inspectorActive) return;
    const next = tabs.switchTo(index);
    if (next.id === activeTabId) return;
    activeTabId = next.id;
    state = tabStates.get(activeTabId) as AppState;
    runtime = tabRuntimes.get(activeTabId) as Runtime;
    transCache = [];
    transMw = 0;
    transSeenTrimmed = 0;
    clearSelection();
    scheduleRender();
  }

  /** Open a fresh tab with an isolated runtime (same cwd + config). */
  function newTab(title?: string): void {
    if (state.menuActive || state.promptActive || state.inspectorActive) return;
    const info = tabs.create(title);
    const rt = Runtime.create({ cwd: runtime.cwd, config: runtime.config });
    rt.setPromptUser(tuiPromptUser);
    rt.setApprovalHandler(tuiRequestApproval);
    rt.resetSession();
    try { rt.workspace.clearCheckpoint(); } catch { /* best effort */ }
    const st = freshTabState();
    st.splashDismissed = false;
    st.splashTick = 0;
    st.splashProgress = 0;
    tabStates.set(info.id, st);
    tabRuntimes.set(info.id, rt);
    subscribeTab(info.id, rt);
    activeTabId = info.id;
    state = st;
    runtime = rt;
    transCache = [];
    transMw = 0;
    transSeenTrimmed = 0;
    clearSelection();
    startSpinner();
    scheduleRender();
  }

  /** Minimal non-splash state for tabs 2+: same shape, no intro animation. */
  function freshTabState(): AppState {
    return {
      ...state,
      input: '',
      cursor: 0,
      history: [],
      historyIndex: -1,
      lines: [],
      tasks: new Map(),
      busy: false,
      busyStartedAt: 0,
      doneAt: 0,
      lastDoneElapsed: '',
      spinner: 0,
      scroll: 0,
      promptActive: false,
    /** A secret prompt (API key) is armed: composer input renders masked. */
    promptSecret: false,
      menuActive: false,
      menuItems: [],
      menuSelected: 0,
      menuMark: new Set<number>(),
      currentTool: '',
      currentTask: '',
      activeSubagents: new Map(),
      spawnLedger: new Map(),
      activeToolArgs: new Map(),
      activeToolLine: new Map(),
      tokenVelocity: 0,
      lastUsageAt: 0,
      lastTokens: 0,
      lastStatus: '',
      chatVer: 0,
      trimmed: 0,
      gitDiff: null,
      totalTokens: 0,
      totalCost: 0,
      inTokens: 0,
      outTokens: 0,
      cacheTokens: 0,
      turns: 0,
      activeModel: undefined,
      routingReason: undefined,
      splashTick: 0,
      splashProgress: 0,
      splashBurst: 0,
      splashDismissed: false,
      userScrolled: false,
      selActive: false,
      selStart: null,
      selEnd: null,
      pasting: false,
      autoImproveAbort: false,
      inspectorActive: false,
      inspectorTitle: '',
      inspectorLines: [],
      inspectorScroll: 0,
      dropActive: false,
      dropSelected: 0,
    };
  }

  /** Close a tab by index. Never strands zero tabs. */
  function closeTab(index: number): void {
    if (state.menuActive || state.promptActive || state.inspectorActive) return;
    const tabList = tabs.list();
    const target = tabList[index];
    if (!target) return;
    const closing = target.id;
    const rt = tabRuntimes.get(closing);
    try { rt?.abort('Tab closed by user'); } catch { /* already idle */ }
    const wasLast = tabs.count() === 1;
    const next = tabs.close(closing);
    tabStates.delete(closing);
    tabRuntimes.delete(closing);
    SessionHub.getInstance().unregister(closing);
    if (wasLast) {
      // Fresh slate in place: new runtime + clean checkpoint.
      const rt2 = Runtime.create({ cwd: runtime.cwd, config: runtime.config });
      rt2.setPromptUser(tuiPromptUser);
      rt2.setApprovalHandler(tuiRequestApproval);
      rt2.resetSession();
      try { rt2.workspace.clearCheckpoint(); } catch { /* best effort */ }
      const st2 = freshTabState();
      st2.splashDismissed = false;
      st2.splashTick = 0;
      st2.splashProgress = 0;
      tabStates.set(next.id, st2);
      tabRuntimes.set(next.id, rt2);
      subscribeTab(next.id, rt2);
      startSpinner();
    }
    activeTabId = next.id;
    state = tabStates.get(activeTabId) as AppState;
    runtime = tabRuntimes.get(activeTabId) as Runtime;
    transCache = [];
    transMw = 0;
    transSeenTrimmed = 0;
    clearSelection();
    scheduleRender();
  }

  /** Close the active tab (aborts its run first). Never strands zero tabs. */
  function closeActiveTab(): void {
    const idx = tabs.activeIndex();
    closeTab(idx);
  }

  /** Route one runtime's events into ITS tab's state (badges background tabs). */
  function subscribeTab(tabId: string, rt: Runtime): void {
    rt.events.onAll((e) => onRuntimeEventFor(tabId, e));
    const hub = SessionHub.getInstance();
    const tInfo = tabs.get(tabId);
    hub.register(tabId, tInfo?.title || tabId);
    hub.onMessage(tabId, (msg) => {
      const st = tabStates.get(tabId);
      if (st) {
        pushTo(st, 'system', `◇ [Message from ${msg.from}]: ${msg.content}`);
        if (tabId !== activeTabId) {
          tabs.markUnread(tabId);
        }
        scheduleRender();
      }
    });
  }

  let pendingResolver: ((v: string) => void) | undefined;
  let menuResolver: ((i: number) => void) | undefined;
  let lastCtrlCAt = 0;
  let lastEscAbortAt = 0;

  let schedulerTimer: NodeJS.Timeout | undefined;
  let renderQueued = false;
  let renderPaused = false;
  let pasteBuffer = '';
  let pasteStartAt = 0;
  let pfBadgeCache: { at: number; text: string } | undefined;
  let lastRenderAt = 0;
  let lastUnpauseAt = 0;
  let exited = false;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let cleanupFns: Array<() => void> = [];
  let restoreConsole: (() => void) | null = null;
  /** Incremental transcript cache: stores the wrapped output per source line,
   *  so each frame only re-wraps lines whose text changed (the newly appended
   *  tail + the actively-streaming last line) instead of the whole 500-line
   *  transcript. This is the fix for the freeze while the agent works. */
  let transCache: { text: string; kind: LineKind; out: string[] }[] = [];
  /** Per-assistant-line streaming markdown renderers (Wave S3), keyed by
   *  Line object identity — state.ts mutates the same object as chunks
   *  append. Entries die with their Line (trimmed lines leave state). */
  const streamRenderers = new WeakMap<Line, StreamMarkdownRenderer>();
  let transMw = 0;
  /** How many head-trims the cache has already absorbed (see transcriptLines). */
  let transSeenTrimmed = 0;

  const width = () => process.stdout.columns || 100;
  const height = () => process.stdout.rows || 34;

  const pushTo = (target: AppState, kind: LineKind, text: string, fullContent?: string, metadata?: Line['metadata']) => {
    // Splash stays visible until user sends a message
    const last = target.lines[target.lines.length - 1];
    if (last && last.kind === kind && last.text === text) return;
    target.lines.push({ kind, text, fullContent, metadata });
    target.chatVer++;
    trimTranscript(target);
    if (!target.userScrolled) target.scroll = 0;
    if (target === state) scheduleRender();
  };

  const push = (kind: LineKind, text: string, fullContent?: string, metadata?: Line['metadata']) => {
    pushTo(state, kind, text, fullContent, metadata);
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

  // Background update check — never blocks or delays startup. When a new
  // GitHub release exists, drop a notice into the transcript suggesting
  // /update. Cached 24h; silent on any failure (offline, rate-limit).
  // MCH-TDZ: this block lives AFTER push/scheduleRender declarations — it
  // previously sat above them and a fast fetch threw "Cannot access
  // 'scheduleRender' before initialization" (crash.log, repeated).
  {
    void (async () => {
      const { checkForUpdate, updateNoticeText } = await import('../update-check.js');
      const info = await checkForUpdate(pkg.version);
      const notice = updateNoticeText(info);
      if (notice) {
        push('system', notice + (info.url ? `\n${info.url}` : ''));
        scheduleRender();
      }
    })().catch(() => { /* silent — update check must never disturb a session */ });
  }

  const startSpinner = () => {
    if (spinnerTimer) return;
    // Reduced-motion (MOCHI_REDUCED_MOTION=1, NO_COLOR, or dumb terminal):
    // skip the animated splash entirely and render the final frame once.
    if (prefersReducedMotion() && state.splashTick < SPLASH_TICKS) {
      state.splashTick = SPLASH_TICKS;
      state.splashProgress = 1;
    }
    spinnerTimer = setInterval(() => {
      // Tick EVERY busy tab, not just the active one: the old code advanced
      // only `state` (rebound on tab switch), so a background run's tab went
      // static and looked frozen, and a completion on another tab stopped the
      // timer while this tab was still busy.
      for (const st of tabStates.values()) {
        if (st.busy) st.spinner = prefersReducedMotion() ? 0 : (st.spinner + 1) % 60;
      }
      if (state.splashTick < SPLASH_TICKS) {
        state.splashTick++;
        state.splashProgress = Math.min(1, state.splashTick / SPLASH_TICKS);
        if (state.splashTick >= SPLASH_TICKS) {
          state.splashProgress = 1;
        }
      } else {
        state.splashTick = (state.splashTick + 1) % 60000;
      }
      if (state.splashDismissed && !anyTabBusy() && state.splashProgress >= 1) {
        stopSpinner();
      }
      scheduleRender();
    }, 60);
    // Freeze-guard: if something starves event-driven renders for > 800ms,
    // force a redraw so the TUI can never appear frozen mid-task. Also
    // un-wedges renderPaused (one poisoned frame paused rendering forever):
    // retry at most every 5s so a persistently-throwing frame can't spam.
    schedulerTimer = setInterval(() => {
      if (!anyTabBusy()) return;
      if (Date.now() - lastRenderAt > 800) {
        if (renderPaused && Date.now() - lastUnpauseAt > 5000) {
          lastUnpauseAt = Date.now();
          renderPaused = false;
        }
        scheduleRender();
      }
    }, 300);
  };

  const stopSpinner = (force = false) => {
    if (!spinnerTimer) return;
    // Stop only when no tab is still busy: completions/aborts on one tab must
    // not freeze the spinner of another tab mid-run. `force` (process exit)
    // always stops.
    if (!force && anyTabBusy()) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = undefined; }
  };

  /** True when any tab (active or background) has a run in flight. */
  function anyTabBusy(): boolean {
    for (const st of tabStates.values()) if (st.busy) return true;
    return false;
  }
  // `wrap` and `visibleLen` are imported from ./wrap.js (shared, testable).

  function prettifyToolCall(text: string): string | undefined {
    const m = text.trim().match(/^(shell|read|write|edit|search|git|inspect|glob|memory|delete)\(([\s\S]*)\)$/);
    if (!m) return undefined;
    const [, name, args] = m;
    const get = (key: string) => {
      const r = args.match(new RegExp(`"${key}":\\s*"([^"]+)"`));
      return r?.[1];
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
      transCache[dirty].kind === state.lines[dirty].kind
    ) dirty++;
    for (let i = dirty; i < state.lines.length; i++) {
      transCache[i].text = state.lines[i].text;
      transCache[i].kind = state.lines[i].kind;
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
   *  preserving the active SGR state across line breaks. Escape sequences are
   *  tokenized BEFORE the wrap decision so a sequence is never split in half
   *  (a broken SGR prints its tail — e.g. "230;250m" — as literal text). */
  function wrapAnsi(line: string, max: number): string[] {
    // CR rule (same as wrap()/renderMarkdown): a `\r` would render as a
    // mid-row carriage return and overwrite the row's own content.
    line = line.replace(/\r\n?/g, '\n').replace(/\n/g, ' ');
    if (visibleLen(line) <= max) return [line];
    const rows: string[] = [];
    let cur = '';
    let curLen = 0;
    let lastSpace = -1;
    let sgr = '';
    const parts = line.match(/(\x1b\[[0-9;]*m|[^\n])/g) ?? [];
    let i = 0;
    while (i < parts.length) {
      const p = parts[i];
      if (p.startsWith('\x1b')) {
        cur += p;
        sgr = p === '\x1b[0m' ? '' : p;
        i++;
        continue;
      }
      if (curLen >= max) {
        if (lastSpace > 0) {
          const head = cur.slice(0, lastSpace);
          const tail = cur.slice(lastSpace + 1);
          rows.push(head);
          cur = sgr + tail;
          curLen = visibleLen(tail);
          lastSpace = -1;
          // Re-process THIS character against the fresh row instead of
          // blindly appending: if it starts an escape sequence, the whole
          // sequence must land intact on the new row (the old code did
          // `cur = sgr + tail + p`, splitting an SGR in half when `p`
          // was the ESC that began one).
          continue;
        }
        rows.push(cur);
        cur = sgr;
        curLen = 0;
        continue;
      }
      if (p === ' ') lastSpace = curLen;
      cur += p;
      curLen++;
      i++;
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
        // Prompt chevron + bold high-contrast text; continuation rows indent under text
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`${R.userGutter}${T.bold}❯${T.reset} ${T.bold}${R.userFg}${w}${T.reset}`);
          else rows.push(`  ${R.userFg}${w}${T.reset}`);
        }
        break;
      }
      case 'assistant': {
        // Terminal prose — live markdown rendering (bold, inline code,
        // headings, bullets, code blocks), ANSI-wrapped to viewport width.
        // The renderer is WIDTH-AWARE now (Cline-grade): it wraps at the
        // exact transcript width and emits hanging-indented final rows, so
        // the downstream pass-through must NOT re-wrap (a second wrap would
        // destroy the continuation-line alignment under list markers).
        // Wave S3: streamed through the sealing renderer — completed
        // blocks render once and only the unfinished tail re-parses per
        // frame (per-frame cost used to grow with the whole message).
        // state.ts mutates this same Line object as chunks append, so the
        // WeakMap key is stable for the life of the stream; a width change
        // or a non-append text replacement resets it internally.
        let streamRenderer = streamRenderers.get(line);
        if (!streamRenderer) {
          streamRenderer = createStreamMarkdownRenderer();
          streamRenderers.set(line, streamRenderer);
        }
        const mdRows = streamRenderer.render(cleanText, Math.max(20, maxWidth - 2));
        for (const r of mdRows) {
          rows.push(r);
        }
        break;
      }
      case 'summary': {
        // Pre-rendered summary card (one line, newline-joined). Pass rows
        // through verbatim: no re-wrap, no prettify, no added gutters —
        // renderSummary already wrapped to terminal width, so windowed
        // mode gets identical layout to fullscreen. Only the intentional
        // blank separators inside the card survive (no per-row blanks).
        // For older cards rendered before a window shrink, clamp to maxWidth.
        for (const src of line.text.split('\n')) {
          rows.push(visibleLen(src) > maxWidth ? ellipsize(src, maxWidth) : src);
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
            rows.push(r);
          }
        }
        break;
      }
      case 'error': {
        // ! gutter + [ERR] tag, bold
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`${R.errorMark}${T.bold}! [ERR]${T.reset} ${R.errorText}${w}${T.reset}`);
          else rows.push(`  ${R.errorText}${w}${T.reset}`);
        }
        break;
      }
      case 'system': {
        // Muted secondary info — no per-line glyphs.
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (const w of wrapped) {
          rows.push(`${T.dim}${R.systemText}${w}${T.reset}`);
        }
        break;
      }
      case 'task': {
        // ★ gutter + [TASK] tag
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 4));
        for (let i = 0; i < wrapped.length; i++) {
          const w = wrapped[i];
          if (i === 0) rows.push(`${R.taskMark}${T.bold}★ [TASK]${T.reset} ${R.taskText}${w}${T.reset}`);
          else rows.push(`  ${T.dim}${R.toolGenericName}${w}${T.reset}`);
        }
        break;
      }
      case 'thought': {
        // Hidden reasoning — luminous drawer ribbon: compact, structured,
        // and informative without dominating the transcript.
        const THINK_MAX_ROWS = 3;
        const wrapped = wrap(cleanText, Math.max(10, maxWidth - 6));
        const shown = wrapped.slice(0, THINK_MAX_ROWS);
        const header = `${T.act}⟡${T.reset} ${T.grayDark}Reasoning Trace${T.reset} ${T.violet}· ${wrapped.length} lines${T.reset} ${T.grayDark}(Ctrl+O to expand)${T.reset}`;
        rows.push(visibleLen(header) > maxWidth ? ellipsize(header, maxWidth) : header);
        for (const w of shown) {
          rows.push(`  ${T.act}│${T.reset} ${T.dim}${T.italic}${R.thoughtText}${w}${T.reset}`);
        }
        if (wrapped.length > THINK_MAX_ROWS) {
          const hint = `  ${T.act}└─${T.reset} ${T.grayDark}… (${wrapped.length - THINK_MAX_ROWS} more lines hidden)${T.reset}`;
          rows.push(visibleLen(hint) > maxWidth ? ellipsize(hint, maxWidth) : hint);
        }
        break;
      }
      default: {
        const wrapped = wrap(cleanText, Math.max(10, maxWidth));
        for (const w of wrapped) {
          rows.push(`${R.assistantText}${w}${T.reset}`);
        }
        break;
      }
    }
    rows.push('');
    return rows;
  }

  // ---- Mouse text-selection: highlight + copy ----------------------------
  /** Recompute the same transcript window renderFrame uses, so selection and
   *  scroll clamping agree with what is actually on screen. Delegates to the
   *  shared chromeLayout (single source of truth — see chrome.ts). */
  function transcriptGeometry(w: number): { chatMw: number; availableH: number; contentH: number } {
    const h = height();
    const { chatMw, availableH, contentH } = chromeLayout({ w, h, inputText: state.input, busy: state.busy, topRows: TAB_BAR_ROWS, indent: transcriptIndent(w), panelRows: subagentPanelRowCount(state.spawnLedger.size) });
    return { chatMw, availableH, contentH };
  }

  /** Apply the active selection to one rendered transcript content row. `lineIdx`
   *  is the global line index (0-based) within chatLines/splash; `indent` is the
   *  leading spacing applied at render. Returns the transformed content. */
  function applySelection(content: string, lineIdx: number, indent: number): string {
    if (!state.selActive || !state.selStart || !state.selEnd) return content;
    const isStartTop = state.selStart.row <= state.selEnd.row;
    const top = Math.min(state.selStart.row, state.selEnd.row);
    const bottom = Math.max(state.selStart.row, state.selEnd.row);
    if (lineIdx < top || lineIdx > bottom) return content;

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

    if (lineIdx === top) {
      const from = Math.max(0, startCol - indent);
      if (from >= len) return content;
      return highlightRange(content, from, len);
    }
    if (lineIdx === bottom) {
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
    const { chatMw } = transcriptGeometry(w);
    const indent = transcriptIndent(w);
    const chatLines = transcriptLines(chatMw);
    const showSplash = !state.splashDismissed && state.lines.length === 0;
    const linesSource = showSplash
      ? splashFrame(state.splashTick, w, pkg.version, state.splashProgress, state.splashBurst)
      : chatLines;

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
    for (let idx = topRow; idx <= bottomRow; idx++) {
      if (idx < 0 || idx >= linesSource.length) continue;
      const bare = stripAnsi(linesSource[idx]);
      // Selection columns are terminal CELLS; slicing needs string INDICES.
      // Convert per line (wide chars/tabs make them differ) so copy grabs the
      // visually selected span on CJK/emoji/tabbed rows.
      const maxIdx = bare.length;
      if (topRow === bottomRow) {
        const minCol = Math.min(state.selStart.col, state.selEnd.col);
        const maxCol = Math.max(state.selStart.col, state.selEnd.col);
        const from = cellColToIndex(bare, Math.max(0, minCol - indent));
        const to = cellColToIndex(bare, Math.min(indexToCellCol(bare, maxIdx), sliceEnd(maxCol)));
        lines.push(from < to ? bare.slice(from, to) : '');
      } else if (idx === topRow) {
        const from = cellColToIndex(bare, Math.max(0, startCol - indent));
        lines.push(bare.slice(from));
      } else if (idx === bottomRow) {
        const to = cellColToIndex(bare, Math.min(indexToCellCol(bare, maxIdx), sliceEnd(endCol)));
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
    // silently absorbed if the terminal doesn't support it, so the native
    // fallback below handles the case where the host terminal doesn't have
    // OSC-52 enabled but the user is sitting at a real desktop.
    let osc52Ok = false;
    try {
      osc52Ok = process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    } catch { /* ignore */ }
    // Sync native attempt: execFileSync either copies NOW (reported) or throws
    // ENOENT (tool absent). The old setImmediate fire-and-forget chain could
    // never report success — xclip copies always read back as 'failed'.
    const buf = Buffer.from(text, 'utf8');
    const attempt = (bin: string, args: string[]): boolean => {
      try {
        execFileSync(bin, args, { input: buf, timeout: 2000, stdio: ['pipe', 'ignore', 'ignore'] });
        return true;
      } catch {
        return false;
      }
    };
    const chains: Array<Array<{ bin: string; args: string[]; tag: 'x11' | 'wayland' | 'pbcopy' }>> = process.env.WAYLAND_DISPLAY
      ? [[{ bin: 'wl-copy', args: ['--type', 'text/plain'], tag: 'wayland' }], [{ bin: 'xsel', args: ['-ib'], tag: 'x11' }]]
      : [[{ bin: 'xclip', args: ['-selection', 'clipboard'], tag: 'x11' }], [{ bin: 'pbcopy', args: [], tag: 'pbcopy' }]];
    for (const group of chains) {
      for (const { bin, args, tag } of group) {
        if (attempt(bin, args)) return tag;
      }
    }
    return osc52Ok ? 'osc52' : 'failed';
  }

  function beginSelection(row: number, col: number) {
    state.selStart = { row, col };
    state.selEnd = { row, col };
    state.selActive = true;
    lastFrame = [];
    scheduleRender();
  }

  /** Double-click: select the word under the cursor on the clicked transcript line. */
  function selectWord(lineIdx: number, col: number) {
    const w = width();
    const { chatMw } = transcriptGeometry(w);
    const indent = transcriptIndent(w);
    const chatLines = transcriptLines(chatMw);
    const showSplash = !state.splashDismissed && state.lines.length === 0;
    const linesSource = showSplash
      ? splashFrame(state.splashTick, w, pkg.version, state.splashProgress, state.splashBurst)
      : chatLines;
    const contentCol = col - indent;
    const line = linesSource[lineIdx];
    if (!line) return;
    const bare = stripAnsi(line);
    // Mouse columns are terminal CELLS; word scanning needs string INDICES.
    // Convert once (wide chars/tabs make them differ) so double-click selects
    // the right word on CJK/emoji/tabbed rows.
    const maxCells = indexToCellCol(bare, bare.length);
    if (contentCol < 0 || contentCol > maxCells) return;
    let start = cellColToIndex(bare, contentCol);
    while (start > 0 && !/\s/.test(bare[start - 1])) start--;
    let end = cellColToIndex(bare, contentCol);
    while (end < bare.length && !/\s/.test(bare[end])) end++;
    if (end <= start) end = start + 1;
    state.selStart = { row: lineIdx, col: indent + indexToCellCol(bare, start) };
    state.selEnd = { row: lineIdx, col: indent + indexToCellCol(bare, end) };
    state.selActive = true;
    lastFrame = [];
    scheduleRender();
  }

  /** Triple-click: select the ENTIRE chat line under the cursor, so a long
   *  wrapped message copies in one clean gesture instead of an exact drag. */
  function selectLine(lineIdx: number) {
    const w = width();
    const { chatMw } = transcriptGeometry(w);
    const indent = transcriptIndent(w);
    const chatLines = transcriptLines(chatMw);
    const showSplash = !state.splashDismissed && state.lines.length === 0;
    const linesSource = showSplash
      ? splashFrame(state.splashTick, w, pkg.version, state.splashProgress, state.splashBurst)
      : chatLines;
    const line = linesSource[lineIdx];
    if (!line) return;
    const bare = stripAnsi(line);
    state.selStart = { row: lineIdx, col: indent };
    state.selEnd = { row: lineIdx, col: indent + Math.max(1, indexToCellCol(bare, bare.length)) };
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
        // Silent copy by design: the highlight + OS clipboard ARE the
        // feedback. Announcing "Copied N chars" into the transcript spams the
        // AI's context AND dismisses the splash screen (any transcript line
        // hides it) — a click should never destroy the welcome screen.
        // Only a FAILED copy speaks up (actionable, rare).
        const via = copyToClipboard(t);
        if (via === 'failed') {
          push(
            'system',
            `Selected ${t.length} char${t.length !== 1 ? 's' : ''}, but clipboard copy failed. ` +
              `Install xclip / wl-copy / pbcopy, or hold Shift while dragging for the host terminal's native selection.`,
          );
        }
        scheduleRender();
      } else {
        // Empty drag (splash screen, blank area): stay silent too — a hint
        // line would dismiss the splash the user is still looking at.
        // Tip: /copy works without the mouse.
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
    // Bare `/`: no popup. Dumping the entire command list on a lone slash
    // is noise; the dropdown appears once there's a partial to filter by.
    if (head === '/') return [];
    return COMMANDS.filter((c) => c.name.startsWith(head));
  }

  let lastFrame: string[] = [];
  let lastW = 0;
  let currentOscDark = canvasBg() !== '';

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
      try {
        process.stdout.write(`${RESET}${SHOW}\r\n${T.error}[render error] ${msg}${RESET}\r\n${HIDE}`);
      } catch { /* EIO/EPIPE */ }
      // Back off: only resume renders from a real event (typing, resize), not
      // from an automatic retry, so a persistent bug can't wedge the loop.
      renderPaused = true;
    }
  }

  /** stdout.write that survives a dead/resized TTY. crash.log shows
   *  uncaughtException EIO (read/write) escaping renderFrame — the one crash
   *  class the render-error try/catch can't reach. EIO/EBADF happen when the
   *  pane closes or resizes mid-write; they are transient. Drop the frame,
   *  back off briefly, and let the next scheduleRender() retry on the live
   *  fd. Never let a frame write kill the session. */
  let writeBackoffUntil = 0;
  function safeWrite(payload: string): void {
    if (Date.now() < writeBackoffUntil) return;
    try {
      process.stdout.write(payload);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code ?? '';
      if (code === 'EIO' || code === 'EBADF' || code === 'EPIPE') {
        writeBackoffUntil = Date.now() + 250;
        return; // frame lost, not fatal
      }
      throw e;
    }
  }

  function renderFrame() {
    const w = width();
    const h = height();

    // Single source of truth for chrome geometry (see chrome.ts): tab bar on
    // top, transcript in the middle, composer + status + approve at bottom.
    const indent = transcriptIndent(w);
    // Subagent panel (W3-4): ledger entries reserve rows directly above the
    // status bar; the transcript shrinks so geometry stays single-sourced.
    const ledgerEntries = state.spawnLedger ? [...state.spawnLedger.values()] : [];
    const panelRowsCount = subagentPanelRowCount(ledgerEntries.length);
    const { statusRows, composerRows, bottomRows, contentH, chatMw, availableH } = chromeLayout({
      w, h, inputText: state.input, busy: state.busy, topRows: TAB_BAR_ROWS, indent,
      panelRows: panelRowsCount,
    });

    const chatLines = transcriptLines(chatMw);
    const visible = chatLines.slice(Math.max(0, chatLines.length - availableH - state.scroll), Math.max(0, chatLines.length - state.scroll));

    const rows: string[] = new Array(h).fill('');
    const lead = ' '.repeat(indent);

    // Pinned tab bar (row 0) + breathing room with underglow (row 1): transcript starts at TAB_BAR_ROWS.
    rows[0] = tabBarRow(w);
    if (lastActiveTabRange) {
      const [start, end] = lastActiveTabRange;
      const barLen = Math.max(0, end - start);
      rows[1] = ' '.repeat(start) + `${T.act}${'▔'.repeat(barLen)}${T.reset}`;
    } else {
      rows[1] = '';
    }

    const showSplash = !state.splashDismissed && state.lines.length === 0;
    if (showSplash) {
      const splash = splashFrame(state.splashTick, w, pkg.version, state.splashProgress, state.splashBurst);
      const top = TAB_BAR_ROWS + Math.max(0, Math.floor((contentH - splash.length) / 2));
      for (let i = 0; i < splash.length && i < contentH; i++) {
        // Apply selection to splash rows too so drag-select works from the
        // very first frame (before any chat lines exist).
        const rendered = lead + applySelection(splash[i], i, indent);
        rows[top + i] = visibleLen(rendered) > w ? ellipsize(rendered, w) : rendered;
      }
    } else {
      const windowStart = Math.max(0, chatLines.length - availableH - state.scroll);
      for (let i = 0; i < availableH && i < contentH; i++) {
        const r = TAB_BAR_ROWS + i;
        const lineIdx = windowStart + i;
        const rendered = lead + applySelection(visible[i] ?? '', lineIdx, indent);
        rows[r] = visibleLen(rendered) > w ? ellipsize(rendered, w) : rendered;
      }
    }

    const followRow = TAB_BAR_ROWS + Math.min(contentH - 1, visible.length);

    const toolKey = state.currentTool;
    let note = '';
    if (toolKey) {
      const args = state.activeToolArgs.get(toolKey);
      const desc = args ? describeToolArgs(toolKey, args) : '';
      note = desc ? `${toolKey} ${desc}` : toolKey;
    }
    const elapsedSec = ((Date.now() - (state.busyStartedAt || state.startedAt)) / 1000).toFixed(1) + 's';
    const verb = resolveVerb(state.currentTool, state.currentTask);

    if (state.busy && state.scroll === 0) {
      const r = followRow;
      const busyStr = lead + thinkingLine(state.spinner, note, elapsedSec, verb);
      rows[r] = visibleLen(busyStr) > w ? ellipsize(busyStr, w) : busyStr;
    } else if (state.doneAt && Date.now() - state.doneAt < 2500 && state.scroll === 0) {
      const r = followRow;
      const doneStr = lead + doneLine(state.lastDoneElapsed);
      rows[r] = visibleLen(doneStr) > w ? ellipsize(doneStr, w) : doneStr;
    }

    // autocomplete dropdown floats above the status bar, centered on screen
    const dropItems = currentDropItems();
    if (dropItems.length && !state.menuActive) {
      const pageSize = 6;
      const start = Math.max(0, Math.min(
        state.dropSelected - pageSize + 1,
        dropItems.length - pageSize,
      ));
      const visibleDropItems = dropItems.slice(start, start + pageSize);
      const dd = renderDropdown(
        visibleDropItems.map((c) => ({ name: c.name, hint: c.hint })),
        state.dropSelected - start,
        w - indent,
      );
      const top = h - bottomRows - dd.length - 1;
      for (let i = 0; i < dd.length; i++) {
        const r = top + i;
        if (r >= 0 && r < h) rows[r] = ' '.repeat(Math.max(0, Math.floor((w - visibleLen(dd[i])) / 2))) + dd[i];
      }
    }

    const extra: string[] = [];
    if (kvCache.badge()) extra.push(kvCache.badge());
    // prefetchBadge does a sync readFileSync+JSON.parse per call — cache it
    // for 5s so the 60ms spinner cadence doesn't re-read the ledger file.
    const nowPf = Date.now();
    if (!pfBadgeCache || nowPf - pfBadgeCache.at > 5000) {
      pfBadgeCache = { at: nowPf, text: prefetchBadge(runtime.workspace.dir) };
    }
    if (pfBadgeCache.text) extra.push(pfBadgeCache.text);
    const queued = [...state.tasks.values()].filter((t) => t.status === 'pending').length;
    if (queued) extra.push(`${queued} queued`);
    // Subagent badge superseded by the spawn-ledger panel (W3-4): the panel
    // shows per-child status + token spend, not just a count.
    if (runtime.config.model.provider === 'antigravity') {
      const activeAcct = activeAccountForKr('antigravity');
      if (activeAcct && activeAcct !== 'default') {
        extra.push(`account: ${activeAcct}`);
      }
    }
    const activeModelLabel = (state.activeModel ?? modelShort).split('/').pop() ?? (state.activeModel ?? modelShort);
    const statusModel = {
      modelId: activeModelLabel,
      totalTokens: state.inTokens + state.outTokens + state.cacheTokens,
      totalCost: state.totalCost,
      maxInputTokens: runtime.config.safety.contextBudgetTokens,
      mode: state.uiMode,
      agentMode: runtime.config.mode ?? 'normal',
      reasoningLevel: runtime.getReasoning(),
      workspaceName: projectName,
      gitBranch: branch || null,
      gitDiff: state.gitDiff,
      autoApprove: state.autoApprove,
      extra,
      tokenVelocity: state.tokenVelocity,
      turns: state.turns,
      routingReason: state.routingReason,
    };

    const s1 = h - bottomRows;
    const sbW = Math.max(20, w - indent);
    // Subagent panel rows sit directly above the status bar (the layout
    // already shrank the transcript by exactly this many rows).
    if (panelRowsCount > 0) {
      const panel = renderSubagentPanel(ledgerEntries, sbW, { now: Date.now() });
      for (let i = 0; i < panelRowsCount && i < panel.length; i++) {
        const r = s1 - panelRowsCount + i;
        if (r >= 0 && r < h) rows[r] = lead + panel[i];
      }
    }
    const r1 = statusBarRow1(statusModel, sbW);
    rows[s1] = lead + (visibleLen(r1) > sbW ? ellipsize(r1, sbW) : r1);
    let cTop = s1 + 1;

    if (statusRows >= 2) {
      const r2 = statusBarRow2(statusModel, sbW);
      rows[s1 + 1] = lead + (visibleLen(r2) > sbW ? ellipsize(r2, sbW) : r2);
      cTop = s1 + 2;
    }

    rows[cTop] = composerTopRule(w);
    const visibleTextRows = composerRows - 2;
    // Cursor-following scroll: instead of always pinning the TAIL of a long
    // input (which hides the caret and the text you're actively typing),
    // anchor the visible slice around the cursor's wrapped row. The caret stays
    // on-screen while you type/edit any line; the tail is only pinned when the
    // cursor is already on the last visible row. (This is the multiline-editor
    // scroll the old `slice(-visibleTextRows)` never did.)
    const composerInnerW = Math.max(1, w - 6);
    const composerText = state.promptSecret ? maskSecretInput(state.input) : state.input;
    const composerRawRows = composerText ? wrap(composerText, composerInnerW) : [''];
    const caretRow = Math.max(0, wrap(composerText.slice(0, state.cursor), composerInnerW).length - 1);
    let sliceStart = caretRow - Math.floor((visibleTextRows - 1) / 2);
    sliceStart = Math.max(0, Math.min(Math.max(0, composerRawRows.length - visibleTextRows), sliceStart));
    const shownRows = composerRawRows.slice(sliceStart, sliceStart + visibleTextRows);
    const firstVisibleRow = sliceStart;
    for (let i = 0; i < visibleTextRows; i++) {
      const r = cTop + 1 + i;
      if (r < h) {
        if (i === 0 && !state.input) {
          const placeholder = state.promptSecret
            ? 'Type or paste your key… (Enter submits · Esc cancels)'
            : w >= 65
              ? (state.busy ? 'Working… (type to queue · Esc to cancel)' : 'Message mochi… (Tab: plan/act · /: commands · ⏎: send)')
              : (state.busy ? 'Working… (Esc to cancel)' : 'Message mochi… (/ for commands)');
          rows[r] = composerPlaceholderRow(placeholder, w);
        } else if (i < shownRows.length) {
          // Only the FIRST visible row carries the prompt glyph; wrapped
          // continuation rows render without it so a long input doesn't stack
          // symbols and corrupt the box edge.
          rows[r] = composerRow(shownRows[i], w, i === 0);
        } else {
          rows[r] = composerRow('', w, i === 0);
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
      const menuW = Math.min(Math.max(28, Math.floor(w * 0.76)), Math.max(10, w - 4));
      const mLeft = Math.max(0, Math.floor((w - menuW) / 2));
      const pad = ' '.repeat(mLeft);

      // Windowed scrolling offset
      let scrollOffset = 0;
      if (totalItems > maxVisibleItems) {
        scrollOffset = Math.max(0, Math.min(totalItems - maxVisibleItems, state.menuSelected - Math.floor(maxVisibleItems / 2)));
      }

      // Title bar: ╭── Title [count] ──────────────────────────╮
      const countBadge = totalItems > 1 ? ` [${state.menuSelected + 1}/${totalItems}] ` : ' ';
      const maxTitleLen = Math.max(6, menuW - 5 - visibleLen(countBadge));
      const cleanTitle = visibleLen(state.menuTitle) > maxTitleLen ? ellipsize(state.menuTitle, maxTitleLen) : state.menuTitle;
      const titleText = ` ${cleanTitle} `;
      const ruleWidth = Math.max(0, menuW - 3 - visibleLen(titleText) - visibleLen(countBadge));
      rows[menuTop] = pad + T.rule + '╭─' + T.reset + T.bold + titleText + T.reset + T.grayDark + countBadge + T.reset + T.rule + '─'.repeat(ruleWidth) + '╮' + T.reset;

      const innerW = Math.max(4, menuW - 4);
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
        const availForItem = Math.max(4, innerW - visibleLen(prefix));

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
      let footerHint = ' ↑/↓ scroll · ⏎ select · esc cancel ';
      if (menuW < visibleLen(footerHint) + 4) {
        footerHint = ' ⏎ sel · esc ';
      }
      const footerRule = Math.max(0, menuW - 2 - visibleLen(footerHint));
      const rLeft = Math.floor(footerRule / 2);
      const rRight = Math.max(0, footerRule - rLeft);
      rows[menuTop + 1 + maxVisibleItems] = pad + T.rule + '╰' + '─'.repeat(rLeft) + T.reset + T.grayDark + footerHint + T.reset + T.rule + '─'.repeat(rRight) + '╯' + T.reset;
    }

    // ---- Uncompressed Inspector Pager Overlay (Ctrl+O) ----
    if (state.inspectorActive) {
      const inspW = Math.max(20, Math.min(w - 2, 140));
      const inspLeft = Math.max(0, Math.floor((w - inspW) / 2));
      const pad = ' '.repeat(inspLeft);
      const innerW = Math.max(6, inspW - 4);
      const totalLines = state.inspectorLines.length;
      const visH = Math.max(5, h - 4);
      const maxScroll = Math.max(0, totalLines - visH);
      state.inspectorScroll = Math.max(0, Math.min(maxScroll, state.inspectorScroll));

      // Blank out all rows
      for (let i = 0; i < h; i++) rows[i] = '';

      // Title bar: ╭── 🔍 [title] [Line 1–30 of 120] ───────────────╮
      const rangeBadge = ` [Line ${totalLines === 0 ? 0 : state.inspectorScroll + 1}–${Math.min(totalLines, state.inspectorScroll + visH)} of ${totalLines}] `;
      const maxInspTitle = Math.max(4, innerW - visibleLen(rangeBadge) - 8);
      const titleStr = ` 🔍 ${ellipsize(state.inspectorTitle, maxInspTitle)} `;
      const topRuleW = Math.max(0, inspW - 3 - visibleLen(titleStr) - visibleLen(rangeBadge));
      rows[0] = pad + T.cyan + '╭─' + T.reset + T.bold + titleStr + T.reset + T.grayDark + rangeBadge + T.reset + T.cyan + '─'.repeat(topRuleW) + '╮' + T.reset;

      // Body lines with line numbers: │  12 │ line text                                  │
      const lineNumWidth = Math.max(3, String(totalLines).length);
      for (let i = 0; i < visH; i++) {
        const lineIdx = state.inspectorScroll + i;
        const r = 1 + i;
        if (r >= h - 1) break;
        if (lineIdx < totalLines) {
          const numStr = `${T.grayDark}${String(lineIdx + 1).padStart(lineNumWidth, ' ')} │${T.reset} `;
          const rawLine = state.inspectorLines[lineIdx];
          const availTextW = Math.max(4, innerW - lineNumWidth - 3);
          const truncatedLine = visibleLen(rawLine) > availTextW ? ellipsize(rawLine, availTextW) : rawLine;
          const trail = Math.max(0, availTextW - visibleLen(truncatedLine));
          rows[r] = pad + T.cyan + '│' + T.reset + ' ' + numStr + truncatedLine + ' '.repeat(trail) + ' ' + T.cyan + '│' + T.reset;
        } else {
          rows[r] = pad + T.cyan + '│' + T.reset + ' '.repeat(innerW + 2) + T.cyan + '│' + T.reset;
        }
      }

      // Footer bar: ╰── ↑/↓ scroll · PgUp/PgDn · Home/End · [C]opy · [ESC/Q/Enter] Close ──╯
      let footerHint = ' ↑/↓/PgUp/PgDn scroll · c copy · esc/q/enter close ';
      if (inspW < visibleLen(footerHint) + 4) {
        footerHint = ' c copy · esc close ';
      }
      const footerRule = Math.max(0, inspW - 2 - visibleLen(footerHint));
      const fLeft = Math.floor(footerRule / 2);
      const fRight = Math.max(0, footerRule - fLeft);
      rows[1 + visH] = pad + T.cyan + '╰' + '─'.repeat(fLeft) + T.reset + T.grayDark + footerHint + T.reset + T.cyan + '─'.repeat(fRight) + '╯' + T.reset;
    }

    // Forced-black canvas (opencode parity) on dark themes: every row is
    // painted over explicit black, so the terminal profile color (gray on some
    // setups) can never show through — and a leaked SGR bg can never tint a
    // whole row via EL. canvasBg() picks 24-bit vs 256-palette black by
    // capability (24-bit codes degrade unpredictably on 256-color terms);
    // light themes + NO_COLOR + dumb terms stay transparent. Recomputed per
    // frame so mid-session /theme switches apply instantly.
    const BLACK_BG = canvasBg();
    const forceBlackBg = BLACK_BG !== '';
    if (forceBlackBg !== currentOscDark) {
      currentOscDark = forceBlackBg;
      safeWrite(forceBlackBg ? OSC_BG_BLACK : OSC_BG_RESET);
    }
    let out = `${forceBlackBg ? BLACK_BG : RESET}${HIDE}`;
    if (lastW !== w || lastFrame.length !== h) {
      out += (forceBlackBg ? BLACK_BG : '') + '\x1b[2J';
      lastFrame = [];
    }
    for (let i = 0; i < h; i++) {
      let line = rows[i] ?? '';
      // Strict boundary clamp to prevent terminal auto-wrap on the right edge.
      // Every row (INCLUDING the last) may be exactly w visible columns: the
      // composer's bottom rule └────┘ is w wide and always lands on the last
      // row, so clamping the last row to w-1 ellipsized the corner `┘` into
      // `…` — the "broken rectangle" glitch (2026-10-10). No wrap happens at
      // exactly-w because the next frame write is an explicit CUP escape
      // (`\x1b[r;cH`), which cancels any pending auto-wrap.
      const maxCol = w;
      if (visibleLen(line) > maxCol) {
        line = ellipsize(line, maxCol);
      }
      if (line !== lastFrame[i]) {
        // paintCanvasBg: re-asserts BLACK_BG after every SGR reset so text, spaces,
        // and padding never revert to the terminal profile's default color (the
        // "gray bars everywhere" bug). Trailing EL (\x1b[K) clears the rest of
        // the row on BLACK_BG.
        const painted = forceBlackBg ? paintCanvasBg(line, BLACK_BG) : terminateRow(line);
        out += '\x1b[' + (i + 1) + ';1H' + (forceBlackBg ? BLACK_BG : '') + painted +
          (forceBlackBg ? BLACK_BG : '') + '\x1b[K';
      }
    }
    // Cursor placement: the composer spans the FULL terminal width from col 0,
    // so the caret column is exactly (❯ prefix + 2 spaces) + wrapped col —
    // no transcript indent. Row tracks the cursor's actual wrapped line,
    // scrolled into the visible window like the text itself.
    const beforeCursor = state.input.slice(0, state.cursor);
    const beforeLines = wrap(beforeCursor, composerInnerW);
    const cursorVisualRow = Math.max(0, beforeLines.length - 1);
    // `firstVisibleRow`/`caretRow` are defined above (cursor-following scroll),
    // so the caret row simply = slice offset + caret's position in the window,
    // clamped into the box so a short box can't push it off-screen.
    const cursorRow = cTop + 1 + Math.min(Math.max(0, visibleTextRows - 1), Math.max(0, cursorVisualRow - firstVisibleRow));
    // Empty composer: park the block on the blank cell right after ❯ (col 3),
    // opencode-style (▊Ask…) — otherwise it sits on top of the placeholder's
    // first letter and visibly eats it (`❯ █essage`).
    const cursorCol = !state.input
      ? 3
      : Math.min(Math.max(1, w - 1), 4 + (beforeLines.length ? visibleLen(beforeLines[beforeLines.length - 1]) : 0));
    if (state.inspectorActive) {
      out += '\x1b[' + h + ';1H' + HIDE;
    } else {
      out += '\x1b[' + (cursorRow + 1) + ';' + (cursorCol + 1) + 'H' + SHOW;
    }
    safeWrite(out);
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

    if (line === '/exit' || line === '/quit' || line === 'exit' || line === 'quit' || line === ':q' || line === '/q') {
      if (tabs.count() > 1) {
        closeActiveTab();
      } else {
        exit();
      }
      return;
    }
    if (line === '/help' || line === '/shortcuts' || line === '/keys') { pushHelp(); return; }
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
      // Numeric: copy Nth-most-recent line. Strict digits: parseInt('2 junk')
      // used to silently copy line 2.
      if (!/^\d+$/.test(arg)) {
        push('system', `Usage: /copy [last | err | N] — copies to clipboard`);
        scheduleRender();
        return;
      }
      const n = parseInt(arg, 10);
      if (n > 0 && n <= state.lines.length) {
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
    if (line === '/status' || line === '/changes') { await view(async () => (await import('../repo/git.js')).status(projectRoot)); return; }
    if (line === '/diff') { await view(async () => (await import('../repo/git.js')).diff(projectRoot)); return; }
    if (line === '/mode' || line.startsWith('/mode ')) {
      const specific = line.startsWith('/mode ') ? line.slice(6).trim() : '';
      if (!specific) {
        push('system', `${formatModes(isMode(runtime.config.mode ?? '') ? (runtime.config.mode as AgentMode) : 'normal')}\n\nUsage: /mode <name>`);
        return;
      }
      await view(async () => {
        const res = runtime.setMode(specific);
        return res.startsWith('Unknown')
          ? res
          : `Mode set: ${specific}${res === 'normal' ? '' : `\n${res.trim()}`}`;
      });
      return;
    }
    if (line === '/modes') {
      push('system', formatModes(isMode(runtime.config.mode ?? '') ? (runtime.config.mode as AgentMode) : 'normal'));
      return;
    }
    if (line === '/plugins') {
      const { PluginRegistry } = await import('../plugins.js');
      const records = new PluginRegistry(resolve(projectRoot, '.mochi', 'plugins')).list();
      if (!records.length) { push('system', 'No plugins installed. Use: mochi plugin add <dir>'); return; }
      push('system', records.map((p) => `${p.name} v${p.version} [${p.scope}]${p.enabled ? '' : ' [disabled]'} ${p.description}${p.hooks.length ? ` hooks:${p.hooks.join(',')}` : ''}`).join('\n') + '\n\nManage: mochi plugin info|enable|disable|validate');
      return;
    }
    if (line === '/rules') {
      // Show BOTH rule systems: modular .mochi/rules/ entries and the
      // MOCHI.md behavioral contract. (A second bare-/rules branch below used
      // to be shadowed by this return and never ran.)
      const { loadRules } = await import('../rules.js');
      const { listRules } = await import('../contract.js');
      const all = loadRules(projectRoot);
      const contract = listRules(runtime.cwd);
      const mod = all.length
        ? `🍡 Modular Project Rules (${all.length}):\n` + all.map(r => `• ${r.id.padEnd(16)} "${r.title}"`).join('\n')
        : 'No modular rules found in .mochi/rules/.';
      const con = contract.length
        ? `MOCHI.md contract (${contract.length}):\n` + contract.map((x, i) => `${i + 1}. ${x}`).join('\n')
        : 'No MOCHI.md rules yet. Try: /rules add <rule>';
      push('system', `${mod}\n\n${con}`);
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
        // Truncate like every other runner: full dumps of big repos stall the
        // transcript and the wrap pass. Use `mochi docgen` for the whole file.
        return docs.markdown.slice(0, 12000);
      });
      return;
    }
    if (line === '/profiles') { await view(async () => runtime.profiles().map(p => `${p.name} (${p.role}) model=${p.defaultModel ?? 'coding'} verification=${p.verification ?? 'optional'}`).join('\n')); return; }
    if (line === '/memory') { await view(async () => runtime.memory() || 'No project memory yet.'); return; }
    if (line.startsWith('/rules add ')) { await view(async () => { const { appendRule } = await import('../contract.js'); const rule = line.slice('/rules add '.length).trim(); if (!rule) return 'empty rule'; const r = appendRule(runtime.cwd, rule); return `appended → ${r.file}`; }); return; }
    if (line === '/facts') { await view(async () => { const { memoryDigest } = await import('../memory/memory-store.js'); const d = memoryDigest(); return d || 'No durable facts yet.'; }); return; }
    if (line.startsWith('/fact ')) { await view(async () => { const { addFact } = await import('../memory/memory-store.js'); const stmt = line.slice(6).trim(); if (!stmt) return 'usage: /fact <statement>'; addFact(stmt, 'fact', 'user'); return `remembered: ${stmt}`; }); return; }
    if (line === '/good' || line === '/bad' || line.startsWith('/good ') || line.startsWith('/bad ') || line.startsWith('/feedback ')) {
      const rest = line.startsWith('/feedback ') ? line.slice(10).trim() : '';
      const isGood = line === '/good' || line.startsWith('/good ') || rest.startsWith('good') || rest.startsWith('+1');
      const isBad = line === '/bad' || line.startsWith('/bad ') || rest.startsWith('bad') || rest.startsWith('-1');
      if (isGood || isBad) {
        const verdict: FeedbackVerdict = isGood ? 'good' : 'bad';
        const recent = [...state.lines].reverse().find((l) => l.kind === 'assistant');
        if (recent) {
          const turn = state.lines.filter((l) => l.kind === 'assistant').indexOf(recent);
          recordFeedback({
            ts: Date.now(),
            session: runtime.activeSessionId ?? 'default',
            turn,
            verdict,
            snippet: recent.text.slice(0, 200),
          });
          push('system', `${verdict === 'good' ? '👍 recorded (good)' : '👎 recorded (bad)'} — turn #${turn}`);
          scheduleRender();
        } else {
          push('system', 'No assistant turn yet to rate.');
          scheduleRender();
        }
        return;
      }
    }
    if (line === '/feedback') { await view(async () => { const { recentFeedback } = await import('../observability/feedback.js'); const r = recentFeedback(15); if (r.length === 0) return 'No feedback recorded yet. Use /good or /bad to rate.'; return r.map((e) => `${new Date(e.ts).toISOString().slice(11,16)} ${e.verdict === 'good' ? '👍' : '👎'} turn#${e.turn} "${e.snippet.slice(0,80)}"`).join('\n'); }); return; }
    if (line === '/circle') { await view(async () => {
      const { detectCircle } = await import('../circle.js');
      const { SessionStore } = await import('../state/session-store.js');
      const store = new SessionStore(projectRoot);
      const sid = runtime.activeSessionId;
      const messages = sid ? store.messages(sid).map((m) => ({ role: m.role as 'assistant' | 'user' | 'system' | 'tool', content: m.content })) : [];
      const v = detectCircle(messages, 4);
      return v.circling ? `CIRCLE: ${v.signals.join(' · ')}` : `ok (signals=${v.signals.length})`;
    }); return; }
    if (line === '/tasks') { await view(async () => listTasks()); return; }
    if (line === '/checkpoint') { await view(async () => { const cp = await runtime.checkpoint(); return `${cp.type} ${cp.ref}`; }); return; }
    if (line === '/rollback') { await view(async () => runtime.rollback()); return; }
    if (line.startsWith('/inspect ') || line === '/inspect') {
      const target = line.startsWith('/inspect ') ? line.slice(9).trim() : await ask('Symbol or file to inspect:');
      if (target) {
        push('user', `/inspect ${target}`);
        scheduleRender();
        await view(async () => (await runtime.inspect(target)).summary);
      }
      return;
    }
    if (line.startsWith('/plan ') || line === '/plan') {
      const obj = line.startsWith('/plan ') ? line.slice(6).trim() : await ask('Objective to plan:');
      if (obj) {
        push('user', `/plan ${obj}`);
        push('goal', `Plan: ${obj}`);
        scheduleRender();
        const planText = await run(async () => runtime.plan(obj), true);
        await reviewPlan(obj, typeof planText === 'string' ? planText : '');
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
        await run(async () => {
          // Structured run: task DAG + real stats, not just the flat summary.
          // (`runtime.goal()` discards everything except the final text.)
          const r = await runtime.runGoal(obj);
          const lines: string[] = [`Goal ${r.goalId.slice(0, 8)} — ${r.status.toUpperCase()}`];
          if (r.tasks.length > 1) {
            lines.push('Tasks:');
            r.tasks.forEach((t, i) => {
              const done = t.status === 'done';
              const failed = t.status === 'failed';
              const glyph = done ? `${T.lime}✓${T.reset}` : failed ? `${T.error}✗${T.reset}` : `${T.grayDark}·${T.reset}`;
              lines.push(`  ${glyph} ${i + 1}. ${t.title}${t.status ? ` ${T.grayDark}[${t.status}]${T.reset}` : ''}`);
            });
          }
          lines.push(`${r.summary}`);
          lines.push(`${T.grayDark}tokens ${r.tokensUsed} · $${r.costUsd.toFixed(4)} · ${Math.round(r.durationMs / 1000)}s${T.reset}`);
          return lines.join('\n');
        }, true);
      }
      return;
    }
    if (line.startsWith('/self-train') || line === '/train') {
      // Continuous self-improvement: cycles of self-review (iterate until the
      // work is verified DONE), then a skill-curator pass so lessons persist.
      // Optional: "/self-train <focus>" or "/self-train 5 <focus>".
      const rest = line.replace(/^\/(self-train|train)\s*/, '').trim();
      const numMatch = rest.match(/^(\d+)\s*(.*)$/);
      const cycles = numMatch ? Number(numMatch[1]) : 3;
      const focus = numMatch ? numMatch[2].trim() : rest;
      push('user', line);
      push('goal', `Self-train: ${cycles} cycle(s)${focus ? ` — ${focus}` : ''}`);
      scheduleRender();
      await run(async () => {
        const r = await runtime.selfTrain({
          cycles,
          focus: focus || undefined,
          onProgress: (_i, msg) => { push('system', msg); scheduleRender(); },
        });
        return `${r.report}\n${T.grayDark}tokens ${r.tokensUsed} · $${r.costUsd.toFixed(4)} · ${Math.round(r.durationMs / 1000)}s${T.reset}`;
      }, true);
      return;
    }
    if (line.startsWith('/chameleon') || line.startsWith('/enhance')) {
      // Removed as a standalone command: output landed in the transcript where
      // the agent never saw it (dead-end; /plan covers pre-work it executes).
      // Keep a branch so the input doesn't fall through to free-form chat.
      push('system', '`/chameleon` was removed as a command — its output never reached the agent.\nThe engine still runs automatically (its scaffold is injected into implement/fix/refactor/plan context), and the agent can call the `chameleon` tool mid-task. For goal runs, use `mochi goal --enhance`.');
      return;
    }
    if (line === '/doctor' || line === '/settings') {
      await view(async () => {
        const { describeConfig } = await import('../model/model-manager.js');
        return `${describeConfig(runtime.config)}\n\nmodel: ${runtime.config.model.model}\ncat: config`;
      });
      return;
    }
    if (line === '/usage' || line === '/cost' || line === '/tokens' || line === '/stats') {
      await view(async () => {
        const summary = runtime.usage.summary();
        const recent = runtime.usage.recent();
        const cachePct = state.totalTokens > 0 ? Math.round((state.cacheTokens / state.totalTokens) * 100) : 0;
        // MCH-79: live per-model breakdown from the budget engine, ranked by cost.
        let byModelBlock = '';
        try {
          const snap = runtime.budget?.snapshot(runtime.config.model.model);
          const rows = snap?.byModel ?? [];
          if (rows.length > 0) {
            byModelBlock = '\n\nBy Model (this run, cost-ranked):\n' + rows
              .map((r) => `  ${r.model}: ${r.tokens.toLocaleString()} tok · $${r.costUsd.toFixed(4)} · ${r.calls} call${r.calls === 1 ? '' : 's'}`)
              .join('\n');
          }
        } catch { /* budget ledger is best-effort */ }
        return (
          `Token & Cost Performance:\n` +
          `  Total Tokens: ${state.totalTokens.toLocaleString()} (${state.cacheTokens.toLocaleString()} cached • ${cachePct}% KV cache hit rate)\n` +
          `  Total Cost: $${state.totalCost.toFixed(4)} USD\n` +
          `  Active Model: ${runtime.config.model.model}\n` +
          byModelBlock +
          `\n\nHistorical Usage:\n${summary}\n\nRecent Turns:\n${recent}`
        );
      });
      return;
    }
    if (line === '/known-good') { await view(async () => runtime.recordGood()); return; }
    if (line === '/check') { await view(async () => runtime.knownGood()); return; }
    if (line === '/providers' || line.startsWith('/providers ')) { await providerMenu(line); return; }
    if (line === '/update' || line.startsWith('/update ') || line === '/version' || line.startsWith('/version ')) {
      // /update [--check] — query GitHub releases; without --check, also APPLY
      // (git pull + npm ci + build, or install.sh). /version shows the same
      // status without applying anything.
      const { checkForUpdate, applyUpdate, detectInstallStyle } = await import('../update-check.js');
      const isVersion = line.startsWith('/version');
      const checkOnly = isVersion || line.includes('--check');
      const info = await checkForUpdate(pkg.version, { force: !isVersion });
      const style = detectInstallStyle(projectRoot);
      if (isVersion) {
        push('system', [
          `Mochi v${pkg.version}  (${style === 'git' ? 'git checkout' : 'installer install'} at ${projectRoot})`,
          info.source === 'none'
            ? 'Latest release: unknown (check failed — offline or rate-limited).'
            : info.available
              ? `Latest release: v${info.latest} — UPDATE AVAILABLE${info.url ? ` ${info.url}` : ''}`
              : `Latest release: v${info.latest} — up to date.`,
        ].join('\n'));
        scheduleRender();
        return;
      }
      if (!info.available) {
        push('system', info.source === 'none'
          ? 'Could not reach GitHub to check for updates (offline or rate-limited).'
          : `Already up to date (v${pkg.version}, latest release v${info.latest}).`);
        scheduleRender();
        return;
      }
      push('system', `New release available: v${info.latest} (you have v${pkg.version})${info.url ? `\n${info.url}` : ''}${info.notes ? `\n--- release notes (truncated) ---\n${info.notes.split('\n').slice(0, 12).join('\n')}` : ''}`);
      if (checkOnly) {
        push('system', 'This was a check-only look (no changes made). Run /update (no --check) to install it now.');
        scheduleRender();
        return;
      }
      push('system', 'Updating Mochi — this pulls, installs deps and rebuilds. It can take a few minutes...');
      scheduleRender();
      const result = await applyUpdate(projectRoot, (l) => { push('system', l); scheduleRender(); });
      push(result.ok ? 'system' : 'error', result.detail);
      scheduleRender();
      return;
    }
    if (line === '/login' || line === '/provider') { await loginFlow(); return; }
    if (line === '/onboard' || line === '/setup' || line === '/welcome') {
      const { runInteractiveOnboarding } = await import('./onboard-flow.js');
      await runInteractiveOnboarding(runtime, openMenu, push, scheduleRender, pkg.version);
      return;
    }
    if (line === '/inject' || line === '/adopt') {
      const { runUniversalInjection } = await import('./onboard-flow.js');
      await runUniversalInjection(runtime, push, scheduleRender);
      return;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      const specific = line.startsWith('/model ') ? line.slice(7).trim() : '';
      if (specific) {
        const { normalizeModelName } = await import('../model/router.js');
        const p = providerById(runtime.config.model.provider);
        if (!p) {
          push('error', 'Model switch failed: current provider unknown.');
          scheduleRender();
        } else {
          const normModel = normalizeModelName(specific, p.baseUrl ?? runtime.config.model.baseUrl);
          await switchModel(p.id, normModel);
        }
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
    if (line === '/fallback' || line.startsWith('/fallback ') || line === '/fallbacks' || line.startsWith('/fallbacks ')) {
      const rest = (line.startsWith('/fallback ') ? line.slice(10) : line.startsWith('/fallbacks ') ? line.slice(11) : '').trim();
      await fallbackMenu(rest || undefined);
      return;
    }
    if (line === '/theme' || line.startsWith('/theme ') || line === '/themes') {
      const specific = line.startsWith('/theme ') ? line.slice(7).trim() : '';
      if (specific) {
        const t = setTheme(specific);
        try { applyTheme(specific); } catch { /* best-effort */ }
        push('system', `Theme switched to ${t.name} — saved, it will stick next launch.`);
        scheduleRender();
      } else {
        await themeMenu();
      }
      return;
    }
    if (line === '/skills' || line.startsWith('/skills ') || line === '/skill' || line.startsWith('/skill ')) {
      const specific = (line.startsWith('/skills ') ? line.slice(8) : line.startsWith('/skill ') ? line.slice(7) : '').trim();
      if (specific === 'repo' || specific.startsWith('repo ')) {
        // /skills repo [<name>] — browse the shared skill-library registry:
        // registered sources and their categorized packs, with an install action.
        const { loadRegistry } = await import('../features/skill-registry.js');
        const want = specific === 'repo' ? '' : specific.slice(5).trim();
        const reg = loadRegistry();
        const names = Object.keys(reg.sources).sort();
        if (!names.length) { push('system', 'No skill sources registered. Add one with: mochi skills repo add <name> <source>'); scheduleRender(); return; }
        if (!want) {
          const items = names.map((n) => `${T.cyan}${n.padEnd(20)}${T.reset}  ${T.grayDark}${reg.sources[n].source}${T.reset}`);
          state.menuSelected = 0;
          const idx = await openMenu('Skill Sources (shared library)', items);
          if (idx < 0 || idx >= names.length) return;
          const chosen = names[idx];
          await renderSourcePacks(chosen);
        } else {
          await renderSourcePacks(want);
        }
        return;
      }
      if (specific === 'search' || specific.startsWith('search ')) {
        // /skills search <keywords> — interactive discovery over every loaded
        // skill (local + user + bundled), usage-boosted, picker to preview.
        const q = specific === 'search' ? '' : specific.slice(7).trim();
        const { loadAllSkills, searchSkills, readSkillBody, loadSkillUsage, usageBoostMap } = await import('../skills/skills.js');
        const { skills } = loadAllSkills(projectRoot);
        const runSearch = async (query: string) => {
          const usage = loadSkillUsage(projectRoot);
          const hits = searchSkills(skills, query, { limit: 8, usageBoost: usageBoostMap(usage) });
          if (!hits.length) {
            push('system', `No skills match "${query}". Try broader words (e.g. "test", "review", "deploy") or /skills to browse all ${skills.length}.`);
            scheduleRender();
            return;
          }
          const items = hits.map((h) => `${T.cyan}${h.skill.name.padEnd(24)}${T.reset} ${T.grayDark}${h.snippet.slice(0, 64)}${T.reset}`);
          const idx = await openMenu(`Skills matching "${query}" (${hits.length})`, items);
          if (idx < 0 || idx >= hits.length) return;
          const body = readSkillBody(hits[idx].skill, projectRoot);
          push('system', `=== Skill: ${hits[idx].skill.name} ===\n${body || hits[idx].skill.description}`);
          scheduleRender();
        };
        if (!q) {
          const query = await ask('Search skills for:');
          if (query.trim()) await runSearch(query.trim());
        } else {
          await runSearch(q);
        }
        return;
      }
      if (specific === 'audit') {
        // /skills audit — health view: counts, agent-created vs bundled,
        // usage counters, last curator report. Proves the skill tree is
        // ALIVE instead of just listing it.
        await view(async () => {
          const { loadAllSkills } = await import('../skills/skills.js');
          const { skills } = loadAllSkills(projectRoot);
          const { scanSkills, defaultCuratorConfig, loadCuratorState } = await import('../skills/skill-curator.js');
          const cfg = defaultCuratorConfig();
          const snap = scanSkills(runtime.cwd, cfg);
          const st = loadCuratorState(runtime.cwd);
          const agentCreated = snap.snapshots.filter((s) => s.agentCreated);
          const archivedNote = snap.archive.length ? `${snap.archive.length} due for archive` : 'none due';
          const lines = [
            `Skills: ${skills.length} loaded (${agentCreated.length} agent-created, ${skills.length - agentCreated.length} bundled)`,
            `Stale: ${snap.stale.length ? snap.stale.map((s) => s.name).join(', ') : 'none'} · Archive queue: ${archivedNote}`,
            `Curator: ${st.paused ? 'paused' : 'active'} · ${st.runCount} runs${st.lastSummary ? ` · last: ${st.lastSummary}` : ''}`,
            ``,
            'Recently active agent-created skills:',
            ...(agentCreated.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 8).map((s) =>
              `  ${s.name}${s.category ? ` [${s.category}]` : ''} — ${s.patches} patches`)),
          ];
          return lines.join('\n');
        });
        return;
      }
      if (specific) {
        const { loadAllSkills, readSkillBody } = await import('../skills/skills.js');
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
    if (line === '/mcp' || line.startsWith('/mcp ')) {
      // /mcp [search <q> | add <spec> | remove <id> | test [id] | list] —
      // universal MCP discovery + install (built-in id, npm:<pkg>, uvx:<pkg>,
      // https://… endpoint, cmd:<bin>) into .mcp.json. No YAML hand-editing,
      // no restart dance (doctor picks it up; the next run loads it).
      const rest = (line === '/mcp' ? '' : line.slice(5)).trim();
      const { searchMcpServers, addMcpServerConfig, removeMcpServerConfig, testMcpServerConfig, listConfiguredMcpServers, BUILTIN_MCP_SERVERS } = await import('../tools/mcp-manage.js');
      const [sub, ...words] = rest.split(/\s+/).filter(Boolean);
      const query = words.join(' ');
      if (!sub || sub === 'list') {
        const items = BUILTIN_MCP_SERVERS.map((s) => `${T.cyan}${s.id.padEnd(24)}${T.reset}  ${T.grayDark}${s.description.slice(0, 60)}${T.reset}`);
        const idx = await openMenu(`MCP servers (${BUILTIN_MCP_SERVERS.length} built-in)`, items);
        if (idx >= 0 && idx < BUILTIN_MCP_SERVERS.length) {
          const s = BUILTIN_MCP_SERVERS[idx];
          const pick = await openMenu(s.name, ['Install into .mcp.json', 'Show install guide', 'Back']);
          if (pick === 0) {
            const r = addMcpServerConfig(projectRoot, s.id);
            push('system', r.message);
            scheduleRender();
          } else if (pick === 1) {
            push('system', `## ${s.name}\n${s.description}\n\nSetup: ${s.installHint ?? 'npx-bundled, no setup'}\n${s.env ? 'Env: ' + Object.keys(s.env).join(', ') : ''}`);
            scheduleRender();
          }
        }
        return;
      }
      if (sub === 'search') {
        const q = query || await ask('Search MCP servers for:');
        if (!q.trim()) return;
        const hits = searchMcpServers(q.trim());
        if (!hits.length) {
          push('system', `No MCP servers match "${q.trim()}". Try /mcp list to browse all ${BUILTIN_MCP_SERVERS.length}.`);
          scheduleRender();
          return;
        }
        const idx = await openMenu(`MCP matching "${q.trim()}"`, hits.map((h) => `${T.cyan}${h.server.id.padEnd(24)}${T.reset}  ${T.grayDark}${h.snippet.slice(0, 60)}${T.reset}`));
        if (idx < 0 || idx >= hits.length) return;
        const r = addMcpServerConfig(projectRoot, hits[idx].server.id);
        push('system', r.message);
        scheduleRender();
        return;
      }
      if (sub === 'add') {
        if (!query) { push('error', 'Usage: /mcp add <server-id|npm:<pkg>|uvx:<pkg>|https://…|cmd:<bin> [args]> (see /mcp list)'); scheduleRender(); return; }
        const r = addMcpServerConfig(projectRoot, query);
        push(r.ok ? 'system' : 'error', r.message);
        scheduleRender();
        return;
      }
      if (sub === 'remove') {
        if (!query) {
          const ids = listConfiguredMcpServers(projectRoot);
          if (!ids.length) { push('system', 'Nothing configured in .mcp.json — nothing to remove.'); scheduleRender(); return; }
          const idx = await openMenu('Remove MCP server', ids);
          if (idx < 0 || idx >= ids.length) return;
          const r = removeMcpServerConfig(projectRoot, ids[idx]);
          push(r.ok ? 'system' : 'error', r.message);
          scheduleRender();
          return;
        }
        const r = removeMcpServerConfig(projectRoot, query);
        push(r.ok ? 'system' : 'error', r.message);
        scheduleRender();
        return;
      }
      if (sub === 'test') {
        const ids = query ? [query] : listConfiguredMcpServers(projectRoot);
        if (!ids.length) { push('system', 'Nothing configured in .mcp.json — add a server first (/mcp list).'); scheduleRender(); return; }
        push('system', `◇ testing ${ids.length} MCP server(s)…`);
        scheduleRender();
        for (const id of ids) {
          const r = await testMcpServerConfig(projectRoot, id);
          push(r.ok ? 'system' : 'error', r.message);
          scheduleRender();
        }
        return;
      }
      push('error', `Unknown /mcp command "${sub}". Use: /mcp [list|search <q>|add <spec>|remove <id>|test [id]]`);
      scheduleRender();
      return;
    }
    if (line === '/history' || line === '/sessions') {
      await historySessionMenu();
      return;
    }
    if (line === '/resume' || line.startsWith('/resume ')) {
      const specific = line.slice(7).trim();
      if (specific) {
        await resumeById(specific);
      } else {
        await resumePickerMenu();
      }
      return;
    }
    if (line === '/account' || line.startsWith('/account ') || line === '/accounts' || line.startsWith('/accounts ') || line === '/switch' || line.startsWith('/switch ')) {
      const specific = (
        line.startsWith('/account ') ? line.slice(9)
        : line.startsWith('/accounts ') ? line.slice(10)
        : line.startsWith('/switch ') ? line.slice(8)
        : ''
      ).trim();
      await accountMenu(specific || undefined);
      return;
    }
    if (line === '/collab' || line.startsWith('/collab ') || line === '/send' || line.startsWith('/send ')) {
      const rest = (line.startsWith('/collab ') ? line.slice(8) : line.startsWith('/send ') ? line.slice(6) : '').trim();
      await collabMenu(rest || undefined);
      return;
    }
    if (line === '/expand' || line === '/inspector' || line === '/out' || line === '/output' || line === '/o') {
      await openUncompressedInspectorMenu();
      return;
    }
    if (line === '/rename' || line.startsWith('/rename ')) {
      const specific = line.startsWith('/rename ') ? line.slice(8).trim() : '';
      const { SessionStore } = await import('../state/session-store.js');
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
    if (line === '/tab' || line.startsWith('/tab ')) {
      // /tab [new [title] | close | next | prev | rename <title> | list | N] —
      // opencode-style multi-session control from the keyboard.
      const arg = (line === '/tab' ? '' : line.slice(5)).trim();
      const [sub, ...restWords] = arg.split(/\s+/).filter(Boolean);
      const titleRest = restWords.join(' ');
      try {
        if (!sub || sub === 'list') {
          const rows = tabs.list().map((t) =>
            `${t.id === activeTabId ? '▸' : ' '} ${t.index}: ${t.title}${t.busy ? ' ●running' : ''}${t.unread ? ` [${t.unread} new]` : ''}`);
          push('system', `Tabs (${tabs.count()}/${8}):\n${rows.join('\n')}\n\nAlt+T new · Alt+W close · Alt+1-8 switch · /tab new|close|next|prev|rename|N`);
        } else if (sub === 'new') {
          // Boot clean: no transcript line (it would kill the new splash).
          newTab(titleRest || undefined);
        } else if (sub === 'close') {
          const closing = tabs.activeTab().title;
          closeActiveTab();
          push('system', `Closed "${closing}". Now on ${tabs.activeTab().title}.`);
        } else if (sub === 'next') {
          switchTab((tabs.activeIndex() + 1) % tabs.count());
        } else if (sub === 'prev') {
          switchTab((tabs.activeIndex() - 1 + tabs.count()) % tabs.count());
        } else if (sub === 'rename') {
          if (!titleRest) { push('error', 'Usage: /tab rename <title>'); scheduleRender(); return; }
          tabs.rename(activeTabId, titleRest);
          scheduleRender();
        } else if (/^[1-8]$/.test(sub)) {
          switchTab(Number(sub) - 1);
        } else {
          push('error', `Unknown /tab command "${sub}". Use: /tab [new|close|next|prev|rename|list|N]`);
        }
      } catch (e) {
        push('error', e instanceof Error ? e.message : String(e));
      }
      scheduleRender();
      return;
    }
    if (line === '/close' || line === '/close-tab' || line === '/exit-session') {
      closeActiveTab();
      return;
    }
    if (line === '/new') {
      if (state.lines.length > 0) {
        newTab();
      } else {
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
        state.turns = 0;
        state.activeModel = undefined;
        state.routingReason = undefined;
        state.spawnLedger.clear();
        state.chatVer++;
        try { tabs.rename(activeTabId, 'Session 1'); } catch {}
        tabs.setStatus(activeTabId, 'idle');
        push('system', 'Started a completely fresh session.');
        scheduleRender();
      }
      return;
    }
    if (line === '/clear-all') {
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
      state.turns = 0;
      state.activeModel = undefined;
      state.routingReason = undefined;
      state.spawnLedger.clear();
      state.chatVer++;
      push('system', 'Cleared all session context.');
      scheduleRender();
      return;
    }
    if (line === '/compact' || line.startsWith('/compact ')) {
      // Distilled from Claude Code's `/compact [focus]`: collapse the oldest
      // transcript turns into a short summary while keeping the RECENT tail
      // verbatim (that's what the model still reasons over). An optional focus
      // keyword makes older lines mentioning it survive too. Mirrors the
      // checkpoints the agent loop writes for the model.
      const focus = (line.includes(' ') ? line.slice(line.indexOf(' ') + 1).trim() : '');
      const KEEP_RECENT = 8;
      const kept: TuiLine[] = [];
      const collapsed: string[] = [];
      const target = state.lines.length - KEEP_RECENT;
      for (let i = 0; i < state.lines.length; i++) {
        const l = state.lines[i];
        const text = ('kind' in l ? String(l.text) : String((l as { text?: unknown }).text ?? '')).toLowerCase();
        if (i >= target || (focus && text.includes(focus.toLowerCase()))) {
          kept.push(l);
        } else if (l.kind === 'user' || l.kind === 'assistant' || l.kind === 'tool') {
          const head = String(l.text).trim().replace(/\s+/g, ' ').slice(0, 90);
          if (head) collapsed.push(`[${l.kind}] ${head}`);
        }
      }
      state.lines = kept;
      if (collapsed.length) {
        state.lines.unshift({ kind: 'system', text: `[session compacted: ${collapsed.slice(0, 12).join(' | ')}${collapsed.length > 12 ? ` | … ${collapsed.length - 12} more` : ''}]` });
      }
      state.chatVer++;
      scheduleRender();
      push('system', `Compacted session${focus ? ` (focus: "${focus}")` : ''}: kept ${kept.length} recent/focused line(s), collapsed ${collapsed.length} older turn(s).`);
      return;
    }
    if (line === '/init') { await run(async () => { const { existsSync, writeFileSync } = await import('node:fs'); const { resolve: rp } = await import('node:path'); const p = rp(projectRoot, 'MOCHI.md'); if (existsSync(p)) return 'MOCHI.md already exists.'; writeFileSync(p, `# MOCHI.md\n\nProject instructions for the Mochi coding agent.\n`); return 'Created ' + p; }); return; }
    if (line === '/context' || line.startsWith('/context ')) {
      // Claude-Code-style context health view (distilled): real usage vs the
      // budget, color-coded by band, with guidance at the thresholds where
      // precision actually drops (<70% fine, 70–85% plan compaction, >85% act).
      const budget = runtime.config.safety.contextBudgetTokens || 0;
      const { approxTokens } = await import('../context.js');
      const prose = await approxTokens(state.lines.map((l) => l.text).join('\n'));
      // Add a modest constant for the system prompt + tool schemas the
      // per-line estimate excludes (15% of budget ≈ the stable prefix overhead).
      const used = prose + (budget ? Math.round(budget * 0.15) : 0);
      const pct = budget ? Math.round((used / budget) * 100) : 0;
      const filled = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      const { T } = await import('./view.js');
      const color = pct < 70 ? (T.success ?? '') : pct < 85 ? (T.warning ?? '') : (T.error ?? '');
      const tip = pct < 70
        ? '🟢 Normal — full precision. No action needed.'
        : pct < 85
          ? '🟡 Precision starting to drop. Consider /compact or /clear soon.'
          : '🔴 Hallucination risk spikes. Run /compact now or /clear for a fresh session.';
      push('system', `[context] ${color}${bar}${T.reset} ${used.toLocaleString()} / ${(budget || used).toLocaleString()} tokens (${pct}%)\n${tip}`);
      return;
    }
    if (line.startsWith('/image ') || line === '/image') {
      // MCH-109: attach image file(s) to the NEXT prompt (vision input).
      const rest = line.startsWith('/image ') ? line.slice(7).trim() : '';
      if (!rest) {
        if (pendingImages.length === 0) { push('system', `Usage: /image <path...> — attaches image(s) to your next message. Or: /image clear`); return; }
        const dropped = pendingImages.length;
        pendingImages.length = 0;
        push('system', `○ cleared ${dropped} pending image attachment(s) (listed, not silently dropped)`);
        return;
      }
      for (const p of rest.split(/\s+/)) {
        const { resolve: rp, extname: ext } = await import('node:path');
        const { existsSync: ex } = await import('node:fs');
        const fp = p.startsWith('~/') ? rp(process.env.HOME ?? '~', p.slice(2)) : rp(runtime.cwd, p);
        if (!ex(fp)) { push('error', `Not found: ${p}`); continue; }
        const e = ext(fp).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(e)) { push('error', `Not an image: ${p}`); continue; }
        pendingImages.push(fp);
        push('system', `🖼 attached ${p} (${pendingImages.length} pending — type your message to send, or /image clear)`);
      }
      return;
    }
    if (line === '/review' || line.startsWith('/review ') || line === '/security-review' || line.startsWith('/security-review ')) {
      // Distilled from Claude Code's `/review` + `/security-review`: review the
      // current working-tree diff before commit. `/security-review` skews the
      // prompt to injection/authz/secrets exposure. Reuses the existing
      // `runtime.review` pipeline (mochi review CLI).
      const security = line.startsWith('/security-review');
      const arg = (line.includes(' ') ? line.slice(line.indexOf(' ') + 1).trim() : '').toLowerCase();
      const reviewScope = arg === 'staged' ? '(cached)' : arg === 'last' ? 'HEAD^' : 'HEAD';
      await run(async () => {
        const { promisify } = await import('node:util');
        const { execFile } = await import('node:child_process');
        const exec = promisify(execFile);
        let diff = '';
        try {
          if (reviewScope === '(cached)') {
            const { stdout } = await exec('git', ['diff', '--cached'], { cwd: projectRoot });
            diff = stdout;
          } else if (reviewScope === 'HEAD^') {
            const { stdout } = await exec('git', ['diff', 'HEAD^'], { cwd: projectRoot });
            diff = stdout;
          } else {
            const { stdout } = await exec('git', ['diff', 'HEAD'], { cwd: projectRoot });
            diff = stdout;
          }
        } catch {
          diff = '';
        }
        if (!diff.trim()) return 'No uncommitted diff to review. Commit or stage changes first.';
        const focus = security
          ? 'SECURITY-FOCUSED review of this diff. Prioritize: injection (SQL/command/XSS), authn/authz flaws, secrets or credentials committed, unsafe deserialization, path traversal, and privilege escalation. Flag concrete exploit paths.'
          : 'Review this diff for correctness, regressions, and best practices. Be specific.';
        const summary = await runtime.review(`${focus}\n\n${diff}`);
        const { parseFindings, renderFindings, countBySeverity } = await import('../pipeline.js');
        const findings = parseFindings(summary);
        if (findings.length) {
          const counts = countBySeverity(findings);
          return `${renderFindings(findings)}\n\n${counts.HIGH} HIGH, ${counts.MEDIUM} MEDIUM, ${counts.LOW} LOW, ${counts.INFO} INFO.`;
        }
        return summary;
      });
      return;
    }
if (line === '/branch' || line.startsWith('/branch ')) {
      // Session branching (Hermes-style): create a child session linked to the
      // current one, copying the transcript so the branch keeps full context.
      const title = line.startsWith('/branch ') ? line.slice(8).trim() : undefined;
      push('user', line);
      await run(async () => runtime.branchSession(title || undefined));
      scheduleRender();
      return;
    }
    if (line === '/commit') {
      const msg = await ask('Commit message:');
      if (!msg.trim()) { push('system', 'Commit cancelled.'); return; }
      await run(async () => {
        const { checkpoint } = await import('../repo/git.js');
        const cp = await checkpoint(projectRoot, msg || 'mochi commit');
        return `Committed ${cp.type} ${cp.ref}`;
      });
      return;
    }
    if (line === '/run' || line === '/shell') { push('system', 'Usage: /run <shell command>  (or /shell <shell command>)'); return; }
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
    if (line === '/watch' || line.startsWith('/watch ')) {
      // TUI /watch: run the repo check ONCE right now (same command preference
      // as `mochi watch`: test > typecheck > build). Continuous watching blocks
      // the TUI event loop — use the `mochi watch` CLI for that.
      const arg = line.slice(6).trim();
      await run(async () => {
        const { loadWatchConfig, watchCheckCommand } = await import('../watch.js');
        const cfg = loadWatchConfig(projectRoot);
        if (arg) cfg.testCommand = arg;
        const cmd = watchCheckCommand(cfg);
        if (!cmd) return 'No test/build/typecheck command detected (and none given: /watch <command>).';
        const { runShellString } = await import('../exec.js');
        const r = await runShellString(cmd, { cwd: projectRoot, timeoutMs: 120_000, maxOutput: 64 * 1024 });
        const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-8).join('\n');
        return r.code === 0 ? `watch: PASS \`${cmd}\`` : `watch: FAIL \`${cmd}\` (exit ${r.code})\n${tail}`;
      });
      return;
    }
    if (line === '/bundle' || line.startsWith('/bundle ')) {
      const out = line.slice(7).trim() || 'mochi-bundle.md';
      await run(async () => {
        const { resolve: rp } = await import('node:path');
        const { writeFileSync } = await import('node:fs');
        let gitDiff = '';
        try {
          const { execFileSync } = await import('node:child_process');
          gitDiff = execFileSync('git', ['diff', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
        } catch { gitDiff = '(git diff unavailable)'; }
        const { doctorReport } = await import('../doctor.js');
        const report = await doctorReport({
          version: pkg.version,
          probeProvider: false,
          provider: runtime.config.model.provider,
          baseUrl: runtime.config.model.baseUrl ?? '',
          model: runtime.config.model.model,
          apiKey: (runtime.config.model as { apiKey?: string }).apiKey ?? null,
          workspaceDir: projectRoot,
        });
        const body = [
          `# Mochi Diagnostic Bundle`, ``,
          `- Exports: ${new Date().toISOString()}`,
          `- Provider: ${runtime.config.model.provider} / ${runtime.config.model.model}`,
          `- Usage: ${runtime.usage.summary()}`, ``,
          `## Session transcript`,
          state.lines.map((l) => `### ${l.kind}\n${String(l.text).slice(0, 5000)}`).join('\n\n') || '(empty)', ``,
          `## Git diff`, '```diff', gitDiff.slice(0, 20000), '```', ``,
          `## Doctor`, '```json', JSON.stringify(report, null, 2).slice(0, 20000), '```',
        ].join('\n');
        const full = rp(projectRoot, out);
        writeFileSync(full, body);
        return `Wrote bundle to ${full}`;
      });
      return;
    }
    if (line === '/update') {
      await run(async () => {
        try {
          const res = await fetch('https://api.github.com/repos/xanstomper/mochi/releases/latest', { headers: { 'user-agent': `mochi/${pkg.version}` } });
          if (!res.ok) return `Could not check for updates (HTTP ${res.status}).`;
          const data = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
          const latest = String(data.tag_name ?? '').replace(/^v/i, '');
          const cur = pkg.version.split('.').map(Number);
          const lat = latest.split('.').map(Number);
          let newer = false;
          for (let i = 0; i < 3; i++) { if ((lat[i] ?? 0) !== (cur[i] ?? 0)) { newer = (lat[i] ?? 0) > (cur[i] ?? 0); break; } }
          if (!newer) return `Already up to date (v${pkg.version}).`;
          return `New release available: v${latest} (you have v${pkg.version})\n${data.html_url ?? ''}\n\n${(data.body ?? '').split('\n').slice(0, 15).join('\n')}\n\nUpgrade with: mochi update --apply`;
        } catch (e) {
          return `Update check failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      });
      return;
    }
    if (line === '/explain' || line.startsWith('/explain ')) {
      const target = line.slice(8).trim();
      if (!target) { push('system', 'Usage: /explain <symbol, file, or concept>'); return; }
      await run(async () => {
        const { explainTool } = await import('../tools/explain.js');
        const out = await explainTool.execute({ target }, { cwd: projectRoot } as never);
        return String(out).slice(0, 6000);
      });
      return;
    }
    if (line === '/stop' || line === '/abort' || line === '/skip') {
      // If an auto-improve loop is in flight, abort the loop itself so the
      // agent stops receiving new passes but the current pass can still
      // finish cleanly (vs. nuking its in-progress tool call).
      state.autoImproveAbort = true;
      if (!state.busy) { push('system', 'No in-flight task to stop.'); return; }
      runtime.abort('User stopped/skipped in-flight task');
      push('system', '[STOP] Skipping / stopping in-flight task… (clears when the run unwinds)');
      // NOTE: busy + spinner clear in run()'s finally once the abort actually
      // unwinds. Clearing here first made the UI read idle while work was
      // still running, letting a second run overlap the first.
      scheduleRender();
      return;
    }
    if (line === '/undo') {
      const cp = runtime.workspace.readJson<{ ref: string; type: 'commit' | 'stash'; message: string }>('checkpoints/latest.json');
      if (!cp) { push('system', 'No checkpoint yet. Run /checkpoint first.'); return; }
      await run(async () => {
        const { restore } = await import('../repo/git.js');
        await restore(projectRoot, cp);
        return `Restored ${cp.type} ${cp.ref}`;
      });
      return;
    }
    if (line === '/redo') {
      // Re-dispatch the most recent non-redo input (prompt or /command).
      // There is no forward-restore stack — a checkpoint restore cannot be
      // undone — so redo means "run that again", stated honestly.
      const prev = [...state.history].reverse().find((h) => h.trim() && !h.trim().startsWith('/redo'));
      if (!prev) { push('system', 'Nothing to redo yet.'); return; }
      push('system', `◇ redoing: ${prev.slice(0, 120)}`);
      await handleCommand(prev);
      return;
    }
    // Permission policy slash commands
    if (line === '/yolo' || line === '/yolo on' || line === '/dangerously-skip-permissions' || line === '/dangerously-skip-permissions on') {
      runtime.setPermPolicy('yolo');
      push('system', '[YOLO] YOLO mode ENABLED — all permission prompts bypassed. Type /yolo off to restore.');
      scheduleRender();
      return;
    }
    if (line === '/yolo off' || line === '/dangerously-skip-permissions off') {
      runtime.setPermPolicy('strict');
      push('system', '[SAFE] YOLO mode disabled. Strict permissions restored.');
      scheduleRender();
      return;
    }
    if (line === '/workspace-safe') {
      runtime.setPermPolicy('workspace-safe');
      push('system', '[AUTO] Workspace-safe mode: reads + workspace edits auto-approved, shell requires approval.');
      scheduleRender();
      return;
    }
    if (line === '/rewind') {
      const cpJson = runtime.workspace.readJson<{ ref: string; type: 'commit' | 'stash'; message: string }>('checkpoints/latest.json');
      if (!cpJson) { push('system', 'No checkpoint found. Use /checkpoint first.'); return; }
      await run(async () => {
        const { restore } = await import('../repo/git.js');
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
    if (line === '/tools' || line.startsWith('/tools ')) {
      await toolsMenu(line);
      return;
    }

    // Free-form prompt (already echo:false — agent pushes its own turns via events)
    push('user', line);
    if (/^(Session \d+|New session( \d+)?|tab \d+)$/.test(tabs.activeTab().title)) {
      tabs.rename(activeTabId, slugTitle(line));
    }
    if (state.autoImproveArmed) {
      // Auto-improve is on: run the self-review pipeline. Each pass critically
      // reviews what the previous pass did, verifies it, and makes real fixes —
      // iterating until the model declares the work DONE (verified) or progress
      // converges, instead of repeating a "keep going" nudge. This delegates to
      // Runtime.autoImprove so the TUI and headless paths share ONE behavior.
      const passes = runtime.maxRuns ?? 5;
      state.autoImproveArmed = false;
      state.autoImproveAbort = false;
      await run(async () => {
        const r = await runtime.autoImprove(line, passes, {
          onProgress: (i, lastSummary) => {
            if (state.autoImproveAbort) return;
            push('system', `◇ self-review pass ${i}/${passes}`);
            if (lastSummary) push('assistant', lastSummary);
          },
        });
        push('system', `✓ auto-improve complete: ${r.summaries.length} pass(es), stopped when verified done or converged`);
        return r.finalSummary;
      }, false);
    } else {
      await run(() => runtime.runPrompt(line, { images: pendingImages.splice(0, pendingImages.length) }), false);
    }
  }

    /** Message queue: messages typed while a task runs; drained on completion. */
  const messageQueue: string[] = [];
  /** MCH-109: image paths attached via /image, sent with the next prompt. */
  const pendingImages: string[] = [];

  async function run(fn: () => Promise<string>, echo = true): Promise<string> {
    // Origin capture: the tab that STARTED the run owns its transcript and
    // busy flag even if the user switches tabs mid-run (background runs
    // continue; their events badge the tab unread via onRuntimeEventFor).
    const rs = state;
    const tabId = activeTabId;
    // Reentrancy: a status/config command (/diff, /status, …) can run while a
    // TASK is already in flight on this tab. Tracking whether WE own the busy
    // flag stops a nested command's completion from clearing the outer task's
    // busy state — which let a second overlapping run start and made the
    // composer report "done" while the real task was still running.
    const wasBusy = rs.busy;
    tabs.setStatus(tabId, 'running');
    tabs.setBusy(tabId, true);
    rs.busy = true;
    let busyWatchdog: ReturnType<typeof setTimeout> | null = null;
    if (!wasBusy) {
      rs.busyStartedAt = Date.now();
      startSpinner();
      // Visible liveness watchdog: a run can legitimately take a long time, but a
      // stuck run (no streaming, no tool progress) used to leave the composer in
      // "Working…" forever with no recourse beyond Ctrl-C. After 45s with still
      // no completion we loudly surface an escape hint so the user sees mochi
      // has not frozen silently ("says done and I can't type" family bug).
      busyWatchdog = setTimeout(() => {
        if (rs.busy) {
          try { push('system', '⚠ still working (45s). Press Esc to cancel if it seems stuck.'); }
          catch { /* transcript full / disposed */ }
          scheduleRender();
        }
      }, 45_000);
    }
    scheduleRender();
    let out = '';
    const beforeAssistantCount = rs.lines.filter((l) => l.kind === 'assistant').length;
    try {
      const result = await fn();
      out = result;
      if (!wasBusy) {
        tabs.setStatus(tabId, 'done');
        const elapsed = ((Date.now() - (rs.busyStartedAt || rs.startedAt)) / 1000).toFixed(1) + 's';
        sendSystemNotification('Task Complete', `Completed in ${elapsed}`, 'normal');
      }
      // Echo the final result only when this run produced no assistant line of
      // its own (count-based check — after any prior reply exists, an empty
      // result must still surface; a streamed reply must not be duplicated).
      if (echo || rs.lines.filter((l) => l.kind === 'assistant').length === beforeAssistantCount) {
        if (result && result.trim()) {
          pushTo(rs, 'assistant', result);
        }
      }
    } catch (e) {
      // Provider failures get a clean one-liner instead of a raw error dump,
      // and transient ones (cooldown/network/rate-limit) auto-retry ONCE after
      // the suggested backoff before surfacing. Fatal errors surface as-is.
      const raw = e instanceof Error ? e.message : String(e);
      const pf = describeProviderFailure(e);
      if (pf.kind === 'transient') {
        pushTo(rs, 'system', `◌ ${pf.headline}`);
        scheduleRender();
        await new Promise((res) => setTimeout(res, Math.min(pf.retryAfterMs ?? 2_000, 15_000)));
        try {
          const result = await fn();
          out = result;
          if (!wasBusy) {
            tabs.setStatus(tabId, 'done');
            const elapsed = ((Date.now() - (rs.busyStartedAt || rs.startedAt)) / 1000).toFixed(1) + 's';
            sendSystemNotification('Task Complete', `Completed in ${elapsed}`, 'normal');
          }
          if (echo) pushTo(rs, 'assistant', result);
          pushTo(rs, 'system', '✓ recovered');
        } catch (e2) {
          tabs.setStatus(tabId, 'error');
          const raw2 = e2 instanceof Error ? e2.message : String(e2);
          const pf2 = describeProviderFailure(e2);
          pushTo(rs, 'error', pf2.kind === 'transient' ? `${pf2.headline} (still degraded — raw: ${raw2.slice(0, 160)})` : raw2.slice(0, 400));
          sendSystemNotification('Task Failed', (pf2.headline || raw2).slice(0, 100), 'critical');
        }
      } else {
        tabs.setStatus(tabId, 'error');
        pushTo(rs, 'error', raw.length > 200 ? `${pf.headline} (raw: ${raw.slice(0, 160)})` : raw);
        sendSystemNotification('Task Failed', (pf.headline || raw).slice(0, 100), 'critical');
      }
    } finally {
      if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
      if (wasBusy) {
        // A nested/reentrant command finished — the outer run still owns the
        // tab's busy state and its completion side-effects.
        scheduleRender();
      } else {
        rs.busy = false;
        rs.doneAt = Date.now();
        rs.lastDoneElapsed = ((Date.now() - (rs.busyStartedAt || rs.startedAt)) / 1000).toFixed(1) + 's';
        tabs.setBusy(tabId, false);
        // A run that finished while its tab was in the background badges once
        // (per-event badging would pin the counter at 99 mid-stream).
        if (tabId !== activeTabId) tabs.markUnread(tabId);
        stopSpinner();
        scheduleRender();
        setTimeout(() => {
          if (rs.doneAt && Date.now() - rs.doneAt >= 2500) {
            rs.doneAt = 0;
            scheduleRender();
          }
        }, 2600);
        // Drain the message queue: messages typed mid-run send now, in order.
        // Sequential (not parallel) so each queued message gets a full run.
        // Per-item try/catch: one throwing drain item must not strand the rest
        // with busy already false and no future drain trigger.
        while (messageQueue.length > 0 && !exited) {
          const next = messageQueue.shift()!;
          push('system', `◇ sending queued message (${messageQueue.length + 1} total were queued)`);
          try {
            await handleCommand(next);
          } catch (e) {
            push('error', `queued message failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    return out;
  }

  /** Apply a provider/model switch WITHOUT routing it through the task runner
   *  `run()`. Switching models is a configuration change, not a task: it must
   *  not mark the tab "done", fire a "Task Complete" notification, or push the
   *  config description as an ASSISTANT transcript turn — the old path did all
   *  three, so a model switch read as "it finished and the session broke". It
   *  only updates the status-bar label and reports on a SYSTEM line. */
  async function switchModel(providerId: string, model: string) {
    try {
      const desc = await runtime.useProvider(providerId, model);
      modelShort = model.split('/').pop() ?? model;
      push('system', `[MODEL] ${desc}`);
    } catch (e) {
      push('error', `Model switch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    scheduleRender();
  }

  /** Render the result of a READ-ONLY / informational command (git status,
   *  /usage, /doctor, /memory, …). These are not tasks: the old path ran them
   *  through `run()`, which flipped the composer into "busy", marked the tab
   *  "done" (✓), and fired a "Task Complete" desktop notification for what is
   *  just a text dump. `view()` only appends a SYSTEM line and never touches
   *  busy/done/notifications, so info commands stop reading as task completions.
   *  (The output is deliberately a system line, not an assistant turn — a git
   *  diff is not something the model said.) */
  async function view(fn: () => Promise<string>): Promise<void> {
    try {
      const out = await fn();
      if (out && out.trim()) push('system', out);
    } catch (e) {
      push('error', e instanceof Error ? e.message : String(e));
    }
    scheduleRender();
  }

  /** MCH-65: plan review UX. After /plan renders, show a diff vs the prior
   *  cached plan for this objective (if any) and offer one-key approve /
   *  edit / reject. Approve chains straight into /approve; edit asks for a
   *  replacement objective and re-plans; reject clears the pending plan. */
  async function reviewPlan(objective: string, planText: string) {
    try {
      const { findPriorPlan } = await import('../core/plan-cache.js');
      const prior = findPriorPlan(runtime.workspace.dir, objective);
      if (prior) {
        const prevTaskCount = prior.plan.split('\n').filter((l) => l.startsWith('- [ ]')).length;
        const newTaskCount = planText.split('\n').filter((l) => l.startsWith('- [ ]')).length;
        push('system', `◇ diff vs prior plan (${new Date(prior.savedAt).toLocaleString()}): ${prevTaskCount} → ${newTaskCount} tasks`);
      } else {
        push('system', '◇ no prior plan cached for this objective (first run)');
      }
    } catch { /* plan-cache unavailable — skip diff line */ }
    const choice = await openMenu(
      'Plan review',
      ['[A]pprove — execute now', '[E]dit — revise objective and re-plan', '[R]eject — discard plan'],
    );
    if (choice === 0) {
      push('user', '/approve');
      await run(async () => runtime.approvePlan(), true);
    } else if (choice === 1) {
      const revised = await ask('Revised objective (Enter to keep, empty to cancel):');
      if (revised && revised.trim()) {
        push('user', `/plan ${revised.trim()}`);
        scheduleRender();
        const t = await run(async () => runtime.plan(revised.trim()), true);
        await reviewPlan(revised.trim(), typeof t === 'string' ? t : '');
      }
    } else if (choice === 2) {
      runtime.workspace.writeJson('state/pending-goal.json', {});
      push('system', '✓ plan rejected — pending goal cleared');
    }
  }

  function ask(question: string): Promise<string> {
    return new Promise((res) => {
      // Never orphan a prior waiter: resolve an armed prompt as cancelled
      // ('') before arming a new one, or its handleCommand hangs forever.
      if (pendingResolver) {
        const old = pendingResolver;
        pendingResolver = undefined;
        old('');
      }
      state.promptActive = true;
      state.promptSecret = false;
      pendingResolver = res;
      state.input = '';
      state.cursor = 0;
      sendSystemNotification('Input Required', question.slice(0, 100), 'normal');
      push('system', `? ${question}`);
      scheduleRender();
    });
  }

  /** Secret input dialog (API keys): identical plumbing to ask(), but the
   *  composer renders masked so the secret never shows on screen or scrollback.
   *  The value still resolves only to the caller — never to the transcript. */
  function askSecret(question: string): Promise<string> {
    return new Promise((res) => {
      if (pendingResolver) {
        const old = pendingResolver;
        pendingResolver = undefined;
        old('');
      }
      state.promptActive = true;
      state.promptSecret = true;
      pendingResolver = res;
      state.input = '';
      state.cursor = 0;
      sendSystemNotification('Input Required', question.slice(0, 100), 'normal');
      push('system', `? ${question}`);
      scheduleRender();
    });
  }

  function openMenu(title: string, items: string[], mark?: Set<number>): Promise<number> {
    return new Promise((res) => {
      // Never orphan a prior waiter: cancel an armed menu (-1) before arming
      // a new one, or its handleCommand hangs forever on a dead resolver.
      // Inline (not closeMenu): avoids its auto-improve title side-effects.
      if (menuResolver) {
        const old = menuResolver;
        menuResolver = undefined;
        state.menuActive = false;
        state.menuItems = [];
        old(-1);
      }
      state.menuActive = true;
      state.menuTitle = title;
      state.menuItems = items;
      // Items already carry [ACTIVE] badges — auto-mark them so the panel
      // shows the ● dot without every call site maintaining a Set.
      state.menuMark = mark ?? new Set(items.map((it, i) => (/\[ACTIVE\]/.test(it) ? i : -1)).filter((i) => i >= 0));
      state.menuSelected = Math.min(state.menuSelected, items.length - 1);
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
        runtime.maxRuns = chosen;
        state.autoApprove = true;
        runtime.setPermPolicy('yolo');
        push('system', `Auto improve: ON — up to ${chosen} self-review passes. Each pass reviews + verifies the previous one and iterates until it's verified done, then moves on. Send a message to begin.`);
        state.autoImproveArmed = true;
      } else {
        push('system', 'Auto improve: cancelled — current mode preserved.');
      }
      state.splashDismissed = true;
    }
    menuResolver = undefined;
    scheduleRender();
  }

  /** Interactive ask_question resolver (Claude Code / opencode parity).
   *  Unit lives in ./prompt-menus.js (scripted tests); this stays a binding
   *  adapter so the coverage ratchet keeps meaning something.
   *  NOTE: the menu + transcript lines always render on the ACTIVE tab (the
   *  tool result still returns to the prompting agent either way). Prompting
   *  runs are foreground in practice; a background tab's question surfaces
   *  where the user is looking rather than hijacking tab focus. */
  async function tuiPromptUser(req: import('../tools/user-prompt.js').UserPromptRequest): Promise<import('../tools/user-prompt.js').UserPromptResponse> {
    const { tuiPromptUser } = await import('./prompt-menus.js');
    const qText = req.questions?.[0]?.question || 'Response Needed';
    sendSystemNotification('Action Required', qText.slice(0, 100), 'normal');
    return tuiPromptUser({
      openMenu,
      ask,
      push,
      scheduleRender,
      setMenuSelected: (i: number) => { state.menuSelected = i; },
    }, req);
  }

  /** Interactive approval gate (Claude Code parity): allow once / allow
   *  always this session / deny — plus the W3-4 per-hunk subset decision
   *  when the request carries an edit review. Esc denies. Same active-tab
   *  caveat as tuiPromptUser above; unit in ./prompt-menus.js. */
  async function tuiRequestApproval(req: import('../security/approval.js').ApprovalRequest): Promise<import('../security/approval.js').ApprovalDecisionEx> {
    const { tuiRequestApproval } = await import('./prompt-menus.js');
    const detail = req.summary || req.tool || 'Approval Needed';
    sendSystemNotification('Approval Required', detail.slice(0, 100), 'normal');
    return tuiRequestApproval({
      openMenu,
      ask,
      push,
      scheduleRender,
      setMenuSelected: (i: number) => { state.menuSelected = i; },
    }, req);
  }


  async function runShell(cmd: string) {
    if (!cmd) { push('error', 'No command given'); return; }
    await run(async () => {
      const { runShellString } = await import('../exec.js');
      const r = await runShellString(cmd, { cwd: projectRoot, timeoutMs: 120_000, maxOutput: 2_000_000, signal: runtime.signal });
      const out = `exit_code: ${r.code ?? (r.timedOut ? 124 : 1)}\nstdout:\n${r.stdout || '(empty)'}\nstderr:\n${r.stderr || '(empty)'}` +
        (r.timedOut ? '\n[command timed out]' : r.cancelled ? '\n[command was cancelled]' : '');
      return out.slice(0, 12000);
    });
  }

  async function runTest(extra: string) {
    await run(async () => {
      const { detectRepo } = await import('../repo/repo.js');
      const repo = detectRepo(projectRoot);
      const cmd = extra ? `node --run ${extra} 2>/dev/null || ${repo.testCommand}` : (repo.testCommand ?? 'no test command detected');
      const { runShellString } = await import('../exec.js');
      const r = await runShellString(cmd, { cwd: projectRoot, timeoutMs: 600_000, maxOutput: 2_000_000, signal: runtime.signal });
      const out = `exit code: ${r.code ?? (r.timedOut ? 124 : 1)}\n` + String(r.stdout ?? '').slice(0, 6000) + String(r.stderr ?? '').slice(0, 3000);
      return out;
    });
  }

  /** /tools browser (unit lives in ./tools-menu.js, tested with scripted UI). */
  async function toolsMenu(line: string): Promise<void> {
    const { toolsMenu } = await import('./tools-menu.js');
    await toolsMenu({
      openMenu,
      ask,
      push,
      scheduleRender,
      config: runtime.config,
      workspace: runtime.workspace,
      events: runtime.events,
      signal: runtime.signal,
      projectRoot,
      setMenuSelected: (i: number) => { state.menuSelected = i; },
    }, line);
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
    // Key entry is the shared unit (same replace/keep/OAuth semantics as
    // /providers re-auth) — app.ts never forks its own copy.
    const { authenticateKey } = await import('./providers-menu.js');
    await authenticateKey(authDeps(), prov, model || prov.defaultModel);
  }

  /** Shared key-entry effects for loginFlow and providerMenu (one wiring). */
  function authDeps() {
    return {
      push, scheduleRender, ask, askSecret,
      setMenuSelected: (i: number) => { state.menuSelected = i; },
      readState: () => ({
        activeProvider: runtime.config.model.provider,
        activeModel: runtime.config.model.model,
      }),
      storedKeyFor: (pid: string) => {
        try {
          return storedKeyForProvider(loadKeyring(), pid, runtime.config.model.provider, runtime.config.model.apiKey);
        } catch {
          return pid === runtime.config.model.provider ? runtime.config.model.apiKey : undefined;
        }
      },
      envLookup: (k: string) => process.env[k],
      openUrl: async (url: string) => {
        // Best-effort browser open; the URL itself is always returned so a
        // headless/mobile session can still copy it.
        try {
          const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
          await new Promise<void>((res, rej) =>
            execFile(opener, [url], { timeout: 5000 }, (e) => (e ? rej(e) : res())));
          return `Opened ${url} in your browser.`;
        } catch {
          return `Open this URL in a browser: ${url}`;
        }
      },
      getAmbientKey,
      verifyKey: async (providerId: string, baseUrl: string, kind: import('../model/providers.js').ProviderKind, key: string) => {
        const { verifyApiKey } = await import('../model/auth-verify.js');
        const v = await verifyApiKey({ provider: providerId, baseUrl, apiKey: key, kind });
        return v.ok ? { ok: true, message: 'verified' } : { ok: false, reason: v.reason, message: v.message };
      },
      persistLogin: (id: string, key: string, model: string, source: 'api-key' | 'oauth') => run(() => runtime.loginProvider(id, key, model, source)),
      switchProvider: (id: string, model: string) => run(() => runtime.useProvider(id, model)),
      persistCleared,
      storedAccountsFor: (pid: string) => accountsForKr(pid),
      activeAccountFor: (pid: string) => activeAccountForKr(pid),
      switchAccount: async (pid: string, account: string) => {
        if (!switchAccountKr(pid, account)) throw new Error(`Unknown account "${account}" for ${pid}.`);
        if (pid === runtime.config.model.provider) {
          try {
            const ring = loadKeyring();
            const newKey = ring[pid]?.key;
            runtime.config.model.apiKey = newKey;
            const { loadConfigFile, saveConfigFile } = await import('../model/providers.js');
            const cfg = loadConfigFile() as { model?: { apiKey?: string } };
            if (cfg.model && newKey) cfg.model.apiKey = newKey;
            if (cfg.model && !newKey) delete cfg.model.apiKey;
            saveConfigFile(cfg as never);
            await runtime.useProvider(pid, runtime.config.model.model);
          } catch { /* best effort */ }
        }
        return `Switched active account for ${pid} to "${account}".`;
      },
      deleteAccount: async (pid: string, account: string) => {
        try { deleteAccountKr(pid, account); } catch { /* best effort */ }
      },
    };
  }

  /** OAuth/CLI-sourced tokens: `gh auth token` for GitHub Models (real device
   *  flow, handled by gh) and the huggingface-cli cache for Hugging Face.
   *  Everything else returns undefined (API keys only). Never throws. */
  async function getAmbientKey(id: string): Promise<string | undefined> {
    if (id === 'github-models') {
      try {
        const out = await new Promise<string>((res, rej) =>
          execFile('gh', ['auth', 'token'], { timeout: 8000 }, (e, stdout) => (e ? rej(e) : res(String(stdout).trim()))));
        return out || undefined;
      } catch { return undefined; }
    }
    // Ambient OAuth from other real CLIs the user already logged into.
    try {
      const { codexAmbientToken, geminiAmbientToken, claudeAmbientToken, gcloudAmbientToken } = await import('../model/ambient-auth.js');
      if (id === 'openai') return (await codexAmbientToken())?.token;
      if (id === 'gemini' || id === 'google') return geminiAmbientToken()?.token ?? (await gcloudAmbientToken())?.token;
      if (id === 'anthropic') return claudeAmbientToken()?.token;
    } catch { /* best-effort */ }
    if (id === 'huggingface') {
      try {
        const { readFileSync, existsSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const f = resolve(homedir(), '.cache/huggingface/token');
        if (existsSync(f)) {
          const t = readFileSync(f, 'utf8').trim();
          return t || undefined;
        }
      } catch { /* fall through */ }
      return undefined;
    }
    return undefined;
  }

  function persistCleared(id: string): Promise<void> {
    // Keyring entry first (the owned per-provider store), then the legacy
    // active slot when it belongs to the cleared provider.
    try {
      deleteKeyringKey(id);
    } catch { /* file write is best-effort; runtime state below still lands */ }
    if (id === runtime.config.model.provider) runtime.config.model.apiKey = undefined;
    // Dynamic import keeps the TUI graph lean (same modules cli-auth uses).
    return import('../model/providers.js').then(({ loadConfigFile, saveConfigFile }) => {
      if (id !== runtime.config.model.provider) return;
      const cfg = loadConfigFile() as { model?: { apiKey?: string } };
      if (cfg.model) delete cfg.model.apiKey;
      saveConfigFile(cfg as never);
    });
  }

  async function providerMenu(line = '/providers') {
    // Dedicated /providers browser (extracted unit — app.ts stays a thin
    // dispatcher). Browse details plus key actions: re-authenticate
    // (live-probed, like /login) and clear the stored key.
    const { providersMenu } = await import('./providers-menu.js');
    await providersMenu({ openMenu, ...authDeps() }, line);
  }

  async function modelMenu() {
    // Step 1: select a provider (rows carry live key state so cleared/expired
    // keys are visible here too — a cleared provider reads "key: missing").
    const { keyStateText } = await import('./providers-menu.js');
    const curProvider = runtime.config.model.provider;
    const storedKey = runtime.config.model.apiKey;
    const providerItems = PROVIDERS.map((p) => {
      const active = p.id === curProvider;
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      const key = keyStateText(p, curProvider, (k) => process.env[k], storedKey);
      return `${p.name.padEnd(20)}  ${badge}${T.grayDark}${p.models.length} models · ${key} · ${p.baseUrl}${T.reset}`;
    });
    const curIdx = PROVIDERS.findIndex((p) => p.id === curProvider);
    state.menuSelected = Math.max(0, curIdx);
    const pidx = await openMenu('Select AI Provider', providerItems);
    if (pidx < 0 || pidx >= PROVIDERS.length) return;
    const prov = PROVIDERS[pidx];

    // Step 2: select a model from the chosen provider
    const activeModel = runtime.config.model.model;
    // Compare bare ids: configured ids are often prefixed (opencode/…) while
    // provider lists are bare — without stripping, the ACTIVE badge never
    // highlights and preselect jumps to row 0 even when set correctly.
    const { bareModelId } = await import('../model/startup-check.js');
    const activeBare = bareModelId(activeModel);
    const modelItems = prov.models.map((m) => {
      const active = prov.id === curProvider && (m === activeModel || m === activeBare);
      const badge = active ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${m.padEnd(36)}  ${badge}`;
    });
    const curModelIdx = prov.models.findIndex((m) => m === activeModel || m === activeBare);
    state.menuSelected = Math.max(0, curModelIdx >= 0 ? curModelIdx : 0);
    const midx = await openMenu(`${prov.name} · Select Model`, modelItems);
    if (midx < 0 || midx >= prov.models.length) return;
    const model = prov.models[midx];
    const { normalizeModelName } = await import('../model/router.js');
    const normModel = normalizeModelName(model, prov.baseUrl);

    // Apply the selection — a config change, not a task run (see switchModel).
    await switchModel(prov.id, normModel);
  }

  async function reasoningMenu() {
    const cur = runtime.getReasoning();
    const options: Array<{ level: import('../types.js').ReasoningLevel; label: string; desc: string }> = [
      { level: 'off', label: 'Off', desc: 'Request disabled reasoning overhead where supported by the provider.' },
      { level: 'auto', label: 'Auto', desc: 'Use model-default reasoning effort.' },
      { level: 'low', label: 'Low', desc: 'Fast & agile: minimal reasoning overhead, speedy tool executions.' },
      { level: 'medium', label: 'Medium', desc: 'Balanced: thoughtful analysis, careful edits, reliable verification.' },
      { level: 'high', label: 'High', desc: 'Deep cognitive analysis: edge cases, AST blast radius checking, multi-step verification.' },
      { level: 'max', label: 'Max', desc: 'Maximum reasoning compute: exhaustive decomposition, multi-pass self-critique, full invariant verification.' },
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

  async function fallbackMenu(arg?: string) {
    if (arg) {
      const parts = arg.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      if (sub === 'clear') {
        const msg = runtime.clearFallbacks();
        push('system', `✓ ${msg}`);
        scheduleRender();
        return;
      }
      if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
        const targetProv = parts[1];
        if (!targetProv) {
          push('error', 'Usage: /fallback rm <provider>');
          scheduleRender();
          return;
        }
        const msg = runtime.removeFallback(targetProv);
        push('system', `✓ ${msg}`);
        scheduleRender();
        return;
      }
      if (sub === 'add') {
        const targetProv = parts[1];
        const targetModel = parts[2];
        if (!targetProv) {
          push('error', 'Usage: /fallback add <provider> [model]');
          scheduleRender();
          return;
        }
        const msg = runtime.addFallback(targetProv, targetModel);
        push('system', `✓ ${msg}`);
        scheduleRender();
        return;
      }
      if (sub === 'list' || sub === 'show') {
        const fb = runtime.getFallbacks();
        const primary = runtime.config.model;
        if (fb.length === 0) {
          push('system', `Primary model: ${primary.provider}/${primary.model} · No fallbacks configured.`);
        } else {
          push('system', `Primary: ${primary.provider}/${primary.model}\nFallbacks:\n` + fb.map((f, i) => `  ${i + 1}. ${f.provider} (${f.model})`).join('\n'));
        }
        scheduleRender();
        return;
      }
    }
    const primary = runtime.config.model;
    const fallbacks = runtime.getFallbacks();
    const actions: Array<{ label: string; run: () => Promise<void> }> = [
      {
        label: 'Add a fallback model...',
        run: async () => {
          const available = PROVIDERS.filter((p) => p.id !== primary.provider);
          const provItems = available.map((p) => p.name.padEnd(20) + ' ' + p.id);
          const pIdx = await openMenu('Select Fallback Provider', provItems);
          if (pIdx < 0 || pIdx >= available.length) return;
          const chosenProv = available[pIdx];
          const mIdx = await openMenu(`Select Model for ${chosenProv.name}`, chosenProv.models);
          if (mIdx < 0 || mIdx >= chosenProv.models.length) return;
          const chosenModel = chosenProv.models[mIdx];
          const msg = runtime.addFallback(chosenProv.id, chosenModel);
          push('system', `✓ ${msg}`);
          scheduleRender();
        },
      },
      ...fallbacks.map((fb, idx) => ({
        label: `Remove #${idx + 1}: ${fb.provider} (${fb.model})`,
        run: async () => {
          const msg = runtime.removeFallback(fb.provider);
          push('system', `✓ ${msg}`);
          scheduleRender();
        },
      })),
      ...(fallbacks.length > 0 ? [{
        label: 'Clear all fallbacks',
        run: async () => {
          const msg = runtime.clearFallbacks();
          push('system', `✓ ${msg}`);
          scheduleRender();
        },
      }] : []),
    ];

    const fbList = fallbacks.length ? fallbacks.map((f, i) => `${i + 1}. ${f.provider} (${f.model})`).join(' · ') : 'none';
    const menuTitle = `Fallback Models (Primary: ${primary.provider}/${primary.model} · Active: ${fbList})`;
    const actionIdx = await openMenu(menuTitle, actions.map((a) => a.label));
    if (actionIdx >= 0 && actionIdx < actions.length) {
      await actions[actionIdx].run();
    }
  }

  async function collabMenu(arg?: string) {
    const hub = SessionHub.getInstance();
    const activeTab = tabs.activeTab();
    const peers = hub.listPeers();

    if (arg) {
      const spaceIdx = arg.indexOf(' ');
      if (spaceIdx < 0) {
        push('error', 'Usage: /send <tabNumber|session|all> <message>');
        scheduleRender();
        return;
      }
      const targetStr = arg.slice(0, spaceIdx).trim();
      const message = arg.slice(spaceIdx + 1).trim();
      let targetId = targetStr;
      if (targetStr !== 'all' && targetStr !== 'broadcast') {
        const n = Number(targetStr);
        if (Number.isInteger(n) && n >= 1 && n <= tabs.count()) {
          targetId = tabs.list()[n - 1].id;
        }
      }
      hub.send(activeTab.id, targetId, message);
      push('system', `→ [Sent to ${targetStr}]: ${message}`);
      scheduleRender();
      return;
    }

    const otherPeers = peers.filter((p) => p.id !== activeTab.id);
    if (otherPeers.length === 0) {
      push('system', `No other tabs active. Open another tab with '+' or Alt+2 to collaborate.`);
      scheduleRender();
      return;
    }

    const items = [
      `Broadcast message to ALL tabs (${otherPeers.length})`,
      ...otherPeers.map((p) => {
        const t = tabs.get(p.id);
        const idx = t ? `[Tab ${t.index}] ` : '';
        return `${idx}${p.title} (${p.id})`;
      }),
    ];

    const pickIdx = await openMenu('Inter-Session Collaboration (Send to Peer Tab)', items);
    if (pickIdx < 0) return;

    const targetId = pickIdx === 0 ? 'all' : otherPeers[pickIdx - 1].id;
    const targetName = pickIdx === 0 ? 'All Tabs' : otherPeers[pickIdx - 1].title;

    const msg = await ask(`Message to send to ${targetName}:`);
    if (!msg || !msg.trim()) return;

    hub.send(activeTab.id, targetId, msg.trim());
    push('system', `→ [Sent to ${targetName}]: ${msg.trim()}`);
    scheduleRender();
  }

  async function accountMenu(specificEmail?: string) {
    const provId = runtime.config.model.provider;
    const { listAntigravityAccounts, antigravityAmbientToken } = await import('../model/ambient-auth.js');
    const { accountsFor, activeAccountName, setAccount } = await import('../model/keyring.js');

    if (provId === 'antigravity' || provId === 'google-antigravity') {
      const accs = await listAntigravityAccounts();
      if (accs.length === 0) {
        push('system', 'No Google Antigravity accounts found in ~/.omp/agent/agent.db or keyring.');
        scheduleRender();
        return;
      }
      const curAmbient = await antigravityAmbientToken();
      const active = activeAccountName('antigravity') || curAmbient?.account || accs[0]?.email;

      if (specificEmail) {
        const match = accs.find((a) => a.email.toLowerCase() === specificEmail.toLowerCase());
        if (match) {
          const tok = await antigravityAmbientToken(undefined, match.email);
          if (tok) {
            setAccount('antigravity', match.email, tok.token, 'oauth');
            push('system', `✓ Switched active account to ${match.email}`);
            scheduleRender();
            return;
          }
        }
        push('error', `Account '${specificEmail}' not found. Run /account to select from list.`);
        scheduleRender();
        return;
      }

      const items = accs.map((a) => {
        const isAct = a.email.toLowerCase() === (active ?? '').toLowerCase();
        const badge = isAct ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
        return `${badge}${T.cyan}${a.email.padEnd(30)}${T.reset} ${T.grayDark}· project: ${a.projectId || 'aicode-consumers'}${T.reset}`;
      });

      const chosenIdx = await openMenu(`Select Google Account (${accs.length} available)`, items);
      if (chosenIdx < 0 || chosenIdx >= accs.length) return;
      const chosen = accs[chosenIdx];
      const tok = await antigravityAmbientToken(undefined, chosen.email);
      if (tok) {
        setAccount('antigravity', chosen.email, tok.token, 'oauth');
        push('system', `✓ Switched active account to ${chosen.email}`);
        scheduleRender();
      }
      return;
    }

    const accts = accountsFor(provId);
    if (!accts.length) {
      push('system', `No stored accounts for ${provId}. Authenticate with: /login`);
      scheduleRender();
      return;
    }
    const active = activeAccountName(provId);
    const items = accts.map((name) => {
      const isAct = name === active;
      const badge = isAct ? `${T.lime}[ACTIVE]${T.reset} ` : '        ';
      return `${badge}${T.cyan}${name}${T.reset}`;
    });
    const chosenIdx = await openMenu(`Select Account for ${provId}`, items);
    if (chosenIdx >= 0 && chosenIdx < accts.length) {
      const { switchAccount } = await import('../model/keyring.js');
      switchAccount(provId, accts[chosenIdx]);
      push('system', `✓ Switched active account to ${accts[chosenIdx]}`);
      scheduleRender();
    }
  }

  async function resumePickerMenu() {
    const goals = runtime.workspace.listGoals();
    if (goals.length === 0) {
      push('system', 'No saved goals to resume.');
      scheduleRender();
      return;
    }

    const goalObjs = goals
      .slice(-15)
      .reverse()
      .map((g) => {
        try {
          return runtime.workspace.loadGoal(g.replace(/\.json$/, ''));
        } catch {
          return null;
        }
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);

    if (goalObjs.length === 0) {
      push('system', 'No readable saved goals found.');
      scheduleRender();
      return;
    }

    const items = goalObjs.map((g) => {
      const statBadge = g.status === 'completed'
        ? `${T.lime}✓ Done${T.reset}`
        : g.status === 'failed'
          ? `${T.error}✗ Failed${T.reset}`
          : `${T.cyan}◌ ${g.status}${T.reset}`;
      const title = (g.objective || 'Untitled').slice(0, 36);
      return `${statBadge.padEnd(16)} ${T.cyan}${g.id.slice(0, 8)}${T.reset} ${T.grayDark}· ${title}${T.reset}`;
    });

    const chosenIdx = await openMenu(`Resume a Session / Goal (${goalObjs.length} recent)`, items);
    if (chosenIdx < 0 || chosenIdx >= goalObjs.length) return;
    const chosen = goalObjs[chosenIdx];
    await resumeById(chosen.id);
  }

  async function resumeById(idOrPrefix: string) {
    push('system', `Resuming goal ${idOrPrefix.slice(0, 8)}...`);
    scheduleRender();
    await run(async () => {
      return await runtime.resumeGoal(idOrPrefix);
    }, false);
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
    const idx = await openMenu(`Select Color Theme (${themes.length} Styles)`, items);
    if (idx < 0 || idx >= themes.length) return;
    const chosen = themes[idx];
    setTheme(chosen.id);
    try { applyTheme(chosen.id); } catch { /* best-effort */ }
    push('system', `Theme switched to ${chosen.name} — saved, it will stick next launch.`);
    scheduleRender();
  }

  async function skillsMenu() {
    const { loadAllSkills, readSkillBody } = await import('../skills/skills.js');
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

  /** /skills repo — show a source's categorized packs; selecting installs it. */
  async function renderSourcePacks(sourceName: string) {
    const { getSource, discoverPacks, resolvePackDir } = await import('../features/skill-registry.js');
    const { resolveSourceDir, importSkills } = await import('../features/skill-importer.js');
    const src = getSource(sourceName);
    if (!src) { push('error', `No skill source '${sourceName}'.`); scheduleRender(); return; }
    const res = await resolveSourceDir(src.source);
    if (!res.dir) { push('error', `Source '${sourceName}' unresolvable: ${res.error || 'n/a'}`); scheduleRender(); return; }
    const packs = discoverPacks(res.dir, src.catalogFile);
    if (!packs.length) { push('system', `Source '${sourceName}' has no discoverable packs.`); scheduleRender(); return; }
    const items = packs.map((p) => {
      const tag = p.category ? `${T.lime}${p.category}${T.reset} ` : '';
      const desc = (p.description || '').slice(0, 46);
      return `${tag}${T.cyan}${p.name.padEnd(20)}${T.reset}  ${T.grayDark}${desc}${T.reset}`;
    });
    items.push(`${T.grayDark}← back to sources${T.reset}`);
    state.menuSelected = 0;
    const idx = await openMenu(`Packs in '${sourceName}' (${packs.length})`, items);
    if (idx < 0) return;
    if (idx >= packs.length) {
      // back to the sources list
      return;
    }
    const chosen = packs[idx];
    const srcDir = res.dir!; // res.dir null-checked above
    const pd = resolvePackDir(srcDir, chosen.name, src.catalogFile);
    await run(async () => {
      const rep = await importSkills({ source: pd ?? srcDir, origin: src.name });
      if (rep.imported.length) {
        const warn = rep.warnings.length ? ` (${rep.warnings.length} lint warning(s): ${rep.warnings.map((w) => `${w.name}: ${w.issues.join(', ')}`).join('; ').slice(0, 160)})` : '';
        push('system', `Installed skill '${chosen.name}' from '${sourceName}'.${warn}`);
        return `Installed ${rep.imported.map((i) => i.name).join(', ')} from '${sourceName}'.${warn}`;
      }
      const reasons = rep.skipped.map((s) => s.reason).join('; ') || rep.errors.join('; ');
      push('system', `Skill '${chosen.name}' not newly installed${reasons ? ` (${reasons})` : ''}.`);
      return `Skill '${chosen.name}' not newly installed${reasons ? ` (${reasons})` : ''}.`;
    }, false);
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
    const { SessionStore } = await import('../state/session-store.js');
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
      try { runtime.workspace.clearCheckpoint(); } catch { /* best effort */ }
      state.lines = [];
      state.tasks.clear();
      state.scroll = 0;
      try { tabs.rename(activeTabId, 'New session'); } catch {}
      tabs.setStatus(activeTabId, 'idle');
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
      try { tabs.rename(activeTabId, (chosen.objective || chosen.summary || 'Session').slice(0, 24)); } catch {}
      tabs.setStatus(activeTabId, 'idle');
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

  function openUncompressedViewer(title: string, fullContent: string) {
    state.inspectorActive = true;
    state.inspectorTitle = title;
    state.inspectorLines = fullContent.replace(/\r\n/g, '\n').split('\n');
    state.inspectorScroll = 0;
    lastFrame = [];
    scheduleRender();
  }

  function closeUncompressedViewer() {
    if (!state.inspectorActive) return;
    state.inspectorActive = false;
    state.inspectorLines = [];
    state.inspectorTitle = '';
    state.inspectorScroll = 0;
    lastFrame = [];
    scheduleRender();
  }

  async function openUncompressedInspectorMenu() {
    interface InspectableItem {
      title: string;
      label: string;
      kind: 'thought' | 'code' | 'tool' | 'response' | 'all';
      content: string;
      lineCount: number;
      charCount: number;
    }

    const items: InspectableItem[] = [];

    // Scan all lines in state.lines
    for (let i = 0; i < state.lines.length; i++) {
      const line = state.lines[i];
      if (!line) continue;

      if (line.kind === 'thought' && line.text.trim()) {
        const content = line.fullContent || line.text;
        const contentLines = content.split('\n');
        const firstLine = contentLines[0]?.trim().slice(0, 42) || 'Thinking trace';
        items.push({
          title: `Reasoning (${contentLines.length} lines, ${content.length} chars)`,
          label: `${T.violet}[THOUGHT]${T.reset} ${firstLine}…  ${T.grayDark}${contentLines.length}L · ${content.length}c${T.reset}`,
          kind: 'thought',
          content,
          lineCount: contentLines.length,
          charCount: content.length,
        });
      }

      if (line.kind === 'tool') {
        const full = line.fullContent || line.metadata?.output || line.text;
        const toolName = line.metadata?.tool || 'tool';
        const contentLines = full.split('\n');
        const rawArgs = line.metadata?.args as Record<string, unknown> | undefined;
        const argSummary = typeof rawArgs === 'object' && rawArgs
          ? String(rawArgs?.command ?? rawArgs?.path ?? rawArgs?.query ?? '')
          : '';
        items.push({
          title: `Tool: ${toolName} ${argSummary} (${contentLines.length} lines)`,
          label: `${T.orange}[TOOL]${T.reset} ${toolName}: ${argSummary ? argSummary.slice(0, 35) : 'Output'}  ${T.grayDark}${contentLines.length}L · ${full.length}c${T.reset}`,
          kind: 'tool',
          content: full,
          lineCount: contentLines.length,
          charCount: full.length,
        });
      }

      if (line.kind === 'assistant' && line.text.trim()) {
        const content = line.fullContent || line.text;
        // Check for fenced code blocks
        const codeFences = [...content.matchAll(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g)];
        if (codeFences.length > 0) {
          for (let f = 0; f < codeFences.length; f++) {
            const fence = codeFences[f];
            const lang = fence[1] || 'code';
            const codeBody = fence[2];
            const codeLines = codeBody.split('\n');
            const preview = codeLines[0]?.trim().slice(0, 38) || 'Code snippet';
            items.push({
              title: `Code Block [${lang}] (${codeLines.length} lines)`,
              label: `${T.lime}[CODE:${lang}]${T.reset} ${preview}…  ${T.grayDark}${codeLines.length}L · ${codeBody.length}c${T.reset}`,
              kind: 'code',
              content: codeBody,
              lineCount: codeLines.length,
              charCount: codeBody.length,
            });
          }
        } else {
          const contentLines = content.split('\n');
          if (contentLines.length > 3 || content.length > 200) {
            const preview = contentLines[0]?.trim().slice(0, 42) || 'Assistant response';
            items.push({
              title: `Assistant Response (${contentLines.length} lines, ${content.length} chars)`,
              label: `${T.cyan}[RESPONSE]${T.reset} ${preview}…  ${T.grayDark}${contentLines.length}L · ${content.length}c${T.reset}`,
              kind: 'response',
              content,
              lineCount: contentLines.length,
              charCount: content.length,
            });
          }
        }
      }
    }

    if (items.length === 0) {
      push('system', 'ℹ️ No compressed or hidden text in the current session yet.');
      scheduleRender();
      return;
    }

    // Reverse chronological (newest first)
    const reversed = items.slice().reverse();

    // Option 0: Full uncompressed transcript
    const allSessionLines = state.lines.map((l) => {
      const prefix = `=== [${l.kind.toUpperCase()}] ===`;
      const text = l.fullContent || l.text;
      return `${prefix}\n${text}\n`;
    }).join('\n');

    const menuChoices: string[] = [
      `${T.bold}${T.cyan}📜 [EXPAND ALL] Complete Uncompressed Session Transcript${T.reset}  ${T.grayDark}${state.lines.length} turns${T.reset}`,
      ...reversed.map((it) => it.label),
    ];

    state.menuSelected = 0;
    const choiceIdx = await openMenu('Uncompressed Code & Reasoning Inspector (Ctrl+O)', menuChoices);
    if (choiceIdx < 0) return;

    if (choiceIdx === 0) {
      openUncompressedViewer('Complete Uncompressed Session Transcript', allSessionLines);
    } else {
      const selected = reversed[choiceIdx - 1];
      if (selected) {
        openUncompressedViewer(selected.title, selected.content);
      }
    }
  }

  interface ExportedLine { kind: string; text: string; fullContent?: string }
  interface ExportedSession { app: 'mochi'; version: 1; cwd: string; model: unknown; time: string; lines: ExportedLine[] }

  async function exportSession() {
    const file = await ask('Export path:');
    if (!file.trim()) { push('system', 'Export cancelled.'); return; }
    await run(async () => {
      const { writeFileSync } = await import('node:fs');
      const data: ExportedSession = {
        app: 'mochi',
        version: 1,
        cwd: projectRoot,
        model: runtime.config.model,
        time: new Date().toISOString(),
        lines: state.lines.map((l) => ({
          kind: l.kind,
          text: String(l.text).slice(0, 20_000),
          ...(typeof l.fullContent === 'string' ? { fullContent: l.fullContent.slice(0, 200_000) } : {}),
        })),
      };
      writeFileSync(file, JSON.stringify(data) + '\n');
      return `Exported ${data.lines.length} transcript line(s) to ${file}`;
    });
  }

  async function importFlow() {
    const file = await ask('Import path:');
    if (!file.trim()) { push('system', 'Import cancelled.'); return; }
    await run(async () => {
      const { readFileSync, existsSync } = await import('node:fs');
      if (!existsSync(file)) return `Import failed: no such file: ${file}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return `Import failed: ${file} is not valid JSON.`;
      }
      const lines = (parsed as Partial<ExportedSession>)?.lines;
      if (!Array.isArray(lines) || lines.length === 0) return `Import failed: ${file} has no transcript lines (expected {app:"mochi", lines:[...]}).`;
      const validKinds = new Set(['user', 'assistant', 'system', 'error', 'tool']);
      let n = 0;
      for (const l of lines.slice(0, 500)) {
        if (l && typeof l.text === 'string') {
          state.lines.push({
            kind: (validKinds.has(l.kind) ? l.kind : 'assistant') as LineKind,
            text: l.text.slice(0, 20_000),
            ...(typeof l.fullContent === 'string' ? { fullContent: l.fullContent.slice(0, 200_000) } : {}),
          });
          n++;
        }
      }
      state.chatVer++;
      return `Imported ${n} transcript line(s) from ${file}`;
    });
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
    const w = Math.max(...COMMANDS.map(c => c.name.length));
    const text = COMMANDS.map(c => `${c.name.padEnd(w)}  ${c.hint}`).join('\n');
    const tips =
      `\nCopying text from the transcript:\n` +
      `  Drag with the left mouse button to select text — release copies to clipboard.\n` +
      `  Double-click selects a word; triple-click selects the whole line.\n` +
      `  Shift+drag uses the host terminal's native selection (works in tmux / older terminals).\n` +
      `  /copy [last | err | N] — keyboard fallback: copy last assistant, last error,\n` +
      `    or the Nth-most-recent line. Works on every terminal, no mouse needed.\n` +
      `\nKeyboard shortcuts (also /shortcuts):\n` +
      `  Enter          send / queue the message while a task runs (drains on finish)\n` +
      `  Alt+↑          pop the last queued message back into the composer\n` +
      `  Tab            toggle plan/act mode (Tab on a dropdown completes the command)\n` +
      `  Enter on /his  typeahead: completes the partial command in-box (no send)\n` +
      `  Shift+Tab      auto-improve menu (self-review passes)\n` +
      `  Ctrl+O         uncompressed inspector (full tool output / hidden thinking)\n` +
      `  Esc            stop the current task · Double Esc exits\n` +
      `  Wheel/PgUp/PgDn scroll · Home/End jump to top/bottom\n` +
      `  Up/Down        prompt history`;
    push('system', text + tips);
  }

  function exit() {
    if (exited) return;
    exited = true;
    stopSpinner(true);
    // Restore the tty BEFORE anything else: raw mode (no echo, no canonical
    // line processing) is a termios attribute that outlives the process, so
    // skipping this leaves the user's terminal looking frozen after exit.
    // Every restore step is individually guarded: crash.log shows
    // "setRawMode failed with errno: 5" thrown FROM exit() on a dead tty —
    // an unguarded throw here aborts the restore midway and the terminal is
    // left raw + cursor-hidden + alt-screen = permanently frozen. A failing
    // restore must never win over finishing the restore.
    try { restoreConsole?.(); } catch { /* ignore */ }
    try { process.stdin.setRawMode?.(false); } catch { /* dead tty */ }
    try { process.stdout.write(`${RESET}${SHOW}${AUTOWRAP}${ALT_EXIT}${OSC_BG_RESET}\x1b]0;\x07`); } catch { /* EPIPE */ }
    // Goodbye card (opencode-style): printed AFTER the alt-screen teardown
    // so it persists in scrollback — logo + session id + stats + safety
    // badge (uncensored/admin when privileged). Best-effort, never throws.
    try {
      const w = process.stdout.columns || 80;
      const uncensored = runtime.permPolicy === 'yolo' || runtime.config.safety.mode === 'uncensored';
      const frame = farewellFrame({
        version: pkg.version,
        sessionId: (runtime.activeSessionId ?? activeTabId).slice(0, 8),
        tokens: state.totalTokens,
        costUsd: state.totalCost,
        durationMs: Date.now() - state.startedAt,
        uiMode: state.uiMode,
        safetyMode: runtime.config.safety.mode,
        uncensored,
      }, w);
      process.stdout.write(frame.join('\n') + '\n');
    } catch { /* farewell must never block exit */ }
    try { for (const fn of cleanupFns) fn(); } catch { /* cleanup must not block exit */ }
    try { process.exit(0); } catch { process.exitCode = 0; }
  }

  function onKey(buf: Buffer) {
    const s = buf.toString('utf8');
    renderPaused = false;
    if (state.doneAt) {
      state.doneAt = 0;
      scheduleRender();
    }

    // Bracketed paste: the terminal wraps pasted text in
    // \x1b[200~ ... \x1b[201~ (possibly split across many data chunks).
    // Latch breaker: a split chunk, non-supporting terminal, or interrupted
    // paste could leave `pasting` true forever (dead keyboard that looks
    // frozen). After 10s without the closer, drop the latch and process
    // normally.
    if (state.pasting && Date.now() - pasteStartAt > 10_000) state.pasting = false;
    if (state.pasting || s.includes('\x1b[200~')) {
      if (!state.pasting) {
        state.pasting = true;
        pasteStartAt = Date.now();
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

        if (state.dropActive) {
          const items = currentDropItems();
          if (items.length > 0 && (btn === 64 || btn === 65) && isPress) {
            const delta = btn === 64 ? -1 : 1;
            state.dropSelected = Math.max(0, Math.min(items.length - 1, state.dropSelected + delta));
            lastFrame = [];
            scheduleRender();
            continue;
          }
          if (items.length > 0 && btn === 0 && isPress) {
            const pageSize = 6;
            const start = Math.max(0, Math.min(state.dropSelected - pageSize + 1, items.length - pageSize));
            const visibleCount = Math.min(pageSize, items.length - start);
            const h = height();
            const { bottomRows } = chromeLayout({ w: width(), h, inputText: state.input, busy: state.busy, topRows: TAB_BAR_ROWS, indent: transcriptIndent(width()) });
            const dropTop = h - bottomRows - (visibleCount + 2) - 1;
            const dropWidth = Math.min(width() - transcriptIndent(width()), 64);
            const dropLeft = Math.max(0, Math.floor((width() - dropWidth) / 2));
            const clickedCol = Number(sgrMouse[2]) - 1;
            const itemOffset = row - 1 - (dropTop + 1);
            const insideColumns = clickedCol > dropLeft && clickedCol < dropLeft + dropWidth - 1;
            if (insideColumns && itemOffset >= 0 && itemOffset < visibleCount) {
              state.dropSelected = start + itemOffset;
              lastFrame = [];
              scheduleRender();
            }
            continue;
          }
          // Never let any left-button press/release/drag leak into transcript
          // selection while the palette overlay is open. SGR motion sets bit 32.
          const baseButton = btn & 3;
          const isMotion = (btn & 32) !== 0;
          if (baseButton === 0 || isMotion) continue;
        }

        if (btn === 64 || btn === 65) {
          // Wheel: 64 = scroll up, 65 = scroll down.
          if (isPress) {
            scrollTranscript(btn === 64 ? 3 : -3);
            if (state.selActive && state.selStart) {
              const trow = row - 1 - TAB_BAR_ROWS;
              const w = width();
              const { availableH, contentH, chatMw } = transcriptGeometry(w);
              if (trow >= 0 && trow < contentH) {
                const chatLines = transcriptLines(chatMw);
                const showSplash = !state.splashDismissed && state.lines.length === 0;
                const curWindowStart = showSplash ? 0 : Math.max(0, chatLines.length - availableH - state.scroll);
                const lineIdx = showSplash ? trow : Math.max(0, Math.min(chatLines.length - 1, curWindowStart + trow));
                updateSelection(lineIdx, Number(sgrMouse[2]) - 1);
              }
            }
          }
          continue;
        }

        // Left-button click-drag text selection. Any press starts/extends a
        // selection; the drag motion updates it; the release (lowercase "m")
        // finalizes and copies the selected text to the OS clipboard.
        const col = Number(sgrMouse[2]);
        if (isPress) {
          const isMotion = (btn & 32) !== 0;
          // Screen row 1 (1-based) is the pinned tab bar: clicks switch tabs
          // or hit the opencode-style `+` button — never start selections.
          if (row === 1 && !isMotion && (btn & 3) === 0) {
            tabBarClick(col - 1);
            continue;
          }
          // Screen row 0 is the pinned tab bar — transcript rows start below
          // it, so convert to window-relative rows (never negative).
          const trow = row - 1 - TAB_BAR_ROWS;
          if (trow < 0 && !isMotion) continue;

          const w = width();
          const { availableH, contentH, chatMw } = transcriptGeometry(w);
          const chatLines = transcriptLines(chatMw);
          const showSplash = !state.splashDismissed && state.lines.length === 0;

          if (isMotion) {
            if (trow < 0) {
              scrollTranscript(1);
            } else if (trow >= contentH) {
              scrollTranscript(-1);
            }
            const clampedTrow = Math.max(0, Math.min(contentH - 1, Math.max(0, trow)));
            const curWindowStart = showSplash ? 0 : Math.max(0, chatLines.length - availableH - state.scroll);
            const lineIdx = showSplash ? clampedTrow : Math.max(0, Math.min(chatLines.length - 1, curWindowStart + clampedTrow));
            updateSelection(lineIdx, col - 1);
          } else {
            if (trow < 0 || trow >= contentH) continue;
            const curWindowStart = showSplash ? 0 : Math.max(0, chatLines.length - availableH - state.scroll);
            const lineIdx = showSplash ? trow : Math.max(0, Math.min(chatLines.length - 1, curWindowStart + trow));
            const now = Date.now();
            const r0 = lineIdx;
            if (state.lastClickRow === r0 && now - state.lastClickAt < 500) {
              state.clickCount += 1;
            } else {
              state.clickCount = 1;
            }
            state.lastClickAt = now;
            state.lastClickRow = r0;
            if (state.clickCount >= 3) {
              selectLine(r0);                 // triple-click whole line
              state.clickCount = 0;
            } else if (state.clickCount === 2) {
              selectWord(r0, col - 1);        // double-click word
            } else {
              beginSelection(r0, col - 1);
            }
          }
        } else {
          endSelection();
          state.clickCount = 1;
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
        // Never clobber a real menu's resolver/items: a pending openMenu
        // waiter would hang forever on the replaced resolver.
        if (menuResolver) continue;
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

      // 3.5. Inspector Pager navigation (Ctrl+O)
      if (state.inspectorActive) {
        if (rest.startsWith('\x1b[A') || s[i] === 'k') {
          i += rest.startsWith('\x1b[A') ? 3 : 1;
          state.inspectorScroll = Math.max(0, state.inspectorScroll - 1);
          lastFrame = [];
          scheduleRender();
          continue;
        }
        if (rest.startsWith('\x1b[B') || s[i] === 'j') {
          i += rest.startsWith('\x1b[B') ? 3 : 1;
          state.inspectorScroll = Math.min(Math.max(0, state.inspectorLines.length - 1), state.inspectorScroll + 1);
          lastFrame = [];
          scheduleRender();
          continue;
        }
        if (rest.startsWith('\x1b[5~')) {
          i += 4;
          state.inspectorScroll = Math.max(0, state.inspectorScroll - Math.max(1, height() - 6));
          lastFrame = [];
          scheduleRender();
          continue;
        }
        if (rest.startsWith('\x1b[6~')) {
          i += 4;
          state.inspectorScroll = Math.min(Math.max(0, state.inspectorLines.length - 1), state.inspectorScroll + Math.max(1, height() - 6));
          lastFrame = [];
          scheduleRender();
          continue;
        }
        if (rest.startsWith('\x1b[H') || s[i] === 'g') {
          i += rest.startsWith('\x1b[H') ? 3 : 1;
          state.inspectorScroll = 0;
          lastFrame = [];
          scheduleRender();
          continue;
        }
        if (rest.startsWith('\x1b[F') || s[i] === 'G') {
          i += rest.startsWith('\x1b[F') ? 3 : 1;
          state.inspectorScroll = Math.max(0, state.inspectorLines.length - Math.max(1, height() - 6));
          lastFrame = [];
          scheduleRender();
          continue;
        }
        if (s[i] === 'c' || s[i] === 'C') {
          i++;
          const fullText = state.inspectorLines.join('\n');
          const via = copyToClipboard(fullText);
          push('system', `Copied uncompressed content (${state.inspectorLines.length} lines, ${fullText.length} chars) to clipboard via ${via}.`);
          closeUncompressedViewer();
          continue;
        }
        if (s[i] === 'q' || s[i] === 'Q' || s[i] === '\x1b' || s[i] === '\r' || s[i] === '\n') {
          i++;
          closeUncompressedViewer();
          continue;
        }
        i++;
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
        // MCH-65: bracket-letter shortcuts — items like '[A]pprove' select
        // and activate directly on that letter (case-insensitive).
        const letterIdx = state.menuItems.findIndex((it) => it.toLowerCase().startsWith(`[${ch0.toLowerCase()}]`));
        if (letterIdx >= 0) { i++; closeMenu(letterIdx); continue; }
        i++;
        continue;
      }

      const c = s[i];

      // Ctrl+K: Raycast-style command palette toggle
      if (c === '\u000b') {
        if (state.dropActive) {
          state.dropActive = false;
          state.dropSelected = 0;
        } else {
          state.dropActive = true;
          state.dropSelected = 0;
          if (!state.input.startsWith('/')) {
            state.input = '/' + state.input;
            state.cursor = state.input.length;
          }
        }
        scheduleRender();
        i++;
        continue;
      }

      // Ctrl+O: Drop down uncompressed inspector menu
      if (c === '\u000f') {
        if (state.inspectorActive) {
          closeUncompressedViewer();
        } else if (state.menuActive) {
          closeMenu(-1);
        } else {
          void openUncompressedInspectorMenu();
        }
        i++;
        continue;
      }
      if (c === '\r' || c === '\n') {
        // Bare `/`: nothing to send (the full-list popup is gone by design).
        // Swallow it in the composer so a stray Enter doesn't dispatch "/"
        // to the agent — unless a prompt/menu/inspector owns this keystroke.
        if (state.input.trim() === '/' && !state.menuActive && !state.promptActive && !state.inspectorActive) {
          i++;
          scheduleRender();
          continue;
        }
        if (state.dropActive) {
          const items = currentDropItems();
          const pick = items[Math.min(state.dropSelected, items.length - 1)];
          const takesArg = pick && ['/goal', '/plan', '/team', '/model', '/reasoning', '/theme', '/providers', '/inspect', '/run', '/shell', '/login', '/import', '/rename', '/compact', '/review', '/security-review', '/self-train', '/image'].includes(pick.name);
          // Only hijack Enter when the composer holds the BARE command name
          // (no arguments typed yet) — then expand to "/cmd " for the user to
          // type args. Once arguments exist, Enter must SEND the command
          // (the old condition re-expanded "/goal fix the login bug" back to
          // bare "/goal " and swallowed the send forever).
          const bareCommand = pick && state.input.trim() === pick.name;
          // PREFIX SELECT (typeahead): if the composer holds a bare partial
          // command like `/his`, Enter completes the best match IN-BOX (e.g.
          // `/history`) and does NOT send — the user finishes editing or hits
          // Enter again to run it. Ambiguous prefixes leave the dropdown open
          // and do NOT hijack Enter. Logic lives in the tested pure helper.
          const prefixPick = resolveCommandPrefix(
            state.input,
            items.map((c) => c.name),
            pick?.name,
          );
          if (prefixPick) {
            state.input = prefixPick;
            state.cursor = state.input.length;
            state.dropActive = false;
            state.dropSelected = 0;
            scheduleRender();
            i++;
            continue;
          }
          if (bareCommand && takesArg) {
            state.input = pick.name + ' ';
            state.cursor = state.input.length;
            state.dropActive = false;
            state.dropSelected = 0;
            scheduleRender();
            i++;
            continue;
          }
          if (bareCommand && !takesArg) {
            // Bare no-arg command: complete to the exact name and send immediately.
            state.input = pick.name;
            state.cursor = state.input.length;
            state.dropActive = false;
            state.dropSelected = 0;
            // fall through to the send path below with the completed name
          } else {
            // Args typed: send as-is. Close the dropdown, don't touch the text.
            state.dropActive = false;
            state.dropSelected = 0;
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
            state.promptSecret = false;
            state.input = '';
            state.cursor = 0;
          } else if (state.busy) {
            // MCH-74: mid-run steer FIRST — if a goal run has live agents,
            // deliver immediately (injected at the next loop iteration).
            // Otherwise fall back to the message queue (drains at run end).
            const steerText = text.trim();
            let steered = 0;
            try { steered = runtime.steer(steerText); } catch { /* fall through */ }
            if (steered > 0) {
              push('system', `↯ steered ${steered} running agent(s) — guidance lands at their next iteration`);
            } else {
              messageQueue.push(steerText);
              push('system', `◇ queued (${messageQueue.length}) — sends when the current task finishes. Alt+↑ pops the last queued message.`);
            }
            state.input = '';
            state.cursor = 0;
          } else {
            // First real prompt names a default tab (once — renames stick).
            if (!text.trim().startsWith('/')) tabs.autoTitle(activeTabId, text);
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
        if (rest === '\x1b') {
          // Armed prompt cancels first: ESC answers pending ask() with ''
          // (callers treat it as cancel) instead of leaving it armed until
          // some arbitrary future text answers it.
          if (pendingResolver) {
            const old = pendingResolver;
            pendingResolver = undefined;
            state.promptActive = false;
            state.promptSecret = false;
            old('');
            push('system', 'Cancelled prompt.');
            scheduleRender();
            i++;
            continue;
          }
          if (state.busy) {
            const now = Date.now();
            if (now - lastEscAbortAt < 1500) {
              lastEscAbortAt = 0;
              runtime.abort('User skipped/cancelled task via double ESC');
              push('system', '[STOP] Task cancel requested — clears when the run unwinds.');
              scheduleRender();
              i++;
              continue;
            } else {
              lastEscAbortAt = now;
              push('system', `${T.grayDark}Press ESC again within 1.5s (or Ctrl+C) to cancel running task.${T.reset}`);
              scheduleRender();
              i++;
              continue;
            }
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
        if (rest.length >= 2 && !rest.startsWith('\x1b[') && !rest.startsWith('\x1b]') && !rest.startsWith('\x1bO')) {
          // Alt+key tab control (opencode-style): Alt+1..8 switch, Alt+T new,
          // Alt+W close. Plain CSI/SS3 sequences fall through to handleEscape.
          const alt = rest[1];
          const isTabKey = (alt >= '1' && alt <= '8') || alt === 't' || alt === 'T' || alt === 'w' || alt === 'W';
          if (isTabKey && !state.menuActive && !state.promptActive && !state.inspectorActive) {
            try {
              if (alt >= '1' && alt <= '8') switchTab(Number(alt) - 1);
              else if (alt === 't' || alt === 'T') newTab();
              else closeActiveTab();
            } catch (e) {
              push('error', e instanceof Error ? e.message : String(e));
            }
            i += 2;
            continue;
          }
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
          push('system', '[STOP] Task cancel requested — clears when the run unwinds.');
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
          state.dropSelected = (state.dropSelected + 1) % items.length;
        } else if (items.length === 1 && state.input.startsWith('/') && state.input.trim() !== items[0].name) {
          state.input = items[0].name + ' ';
          state.cursor = state.input.length;
          state.dropActive = false;
          state.dropSelected = 0;
        } else {
          state.uiMode = state.uiMode === 'plan' ? 'act' : 'plan';
          runtime.setPlanMode(state.uiMode === 'plan');
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
      case '\x1b[1;3A': {
          // Alt+Up: pop the last queued message back into the composer for editing.
          const popped = messageQueue.pop();
          if (popped) {
            state.input = popped;
            state.cursor = state.input.length;
            push('system', `◇ un-queued (${messageQueue.length} still queued)`);
          } else {
            push('system', 'Queue is empty.');
          }
          break;
        }
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

  /** Route one runtime's events into ITS tab's state. Background tabs reduce
   *  silently (transcript preserved); only the active tab gets live chrome
   *  side effects (git stats, token meter, spinner splash-cut). */
  function onRuntimeEventFor(tabId: string, event: MochiEvent) {
    const target = tabStates.get(tabId);
    if (!target) return;
    if (event.type === 'agent:completed' || event.type === 'summary:rendered') {
      tabs.setStatus(tabId, 'done');
    }
    const isActive = tabId === activeTabId;
    if (!isActive) {
      reduceEvent(target, event as unknown as Record<string, unknown>);
      if (event.type === 'usage:updated') {
        target.inTokens = event.inputTokens;
        target.outTokens = event.outputTokens;
        target.cacheTokens = event.cacheTokens;
        target.totalTokens = event.totalTokens;
        // usage:updated costUsd is the PER-CALL delta; the status bar shows
        // the run's running total, so accumulate (state resets per run).
        if (event.costUsd !== undefined) target.totalCost += event.costUsd;
      }
      scheduleRender();
      return;
    }
    onRuntimeEvent(event);
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
    // Completion events render nothing through reduceEvent (pure-chat turns
    // return false), so a finished run with a dead spinner tick looked stuck
    // on "thinking". Always frame completion work visibly.
    if (event.type === 'agent:completed' || event.type === 'summary:rendered') {
      scheduleRender();
    }
    // Keep the status bar's git stats + token meter live.
    const type = event.type;
    if (type === 'file:changed' || type === 'tool:completed') void refreshGitStats();
    if (type === 'usage:updated') {
      // REAL provider numbers: input (net of cache hits), output, cache reads, and USD cost.
      state.inTokens = Number(event.type === 'usage:updated' ? event.inputTokens : 0);
      state.outTokens = Number(event.type === 'usage:updated' ? event.outputTokens : 0);
      state.cacheTokens = Number(event.type === 'usage:updated' ? event.cacheTokens : 0);
      state.totalTokens = Number(event.type === 'usage:updated' ? event.totalTokens : 0);
      if (event.type === 'usage:updated' && event.costUsd !== undefined) {
        // Per-call delta (see the background-tab branch): accumulate into
        // the running total the status bar displays.
        state.totalCost += Number(event.type === 'usage:updated' ? (event.costUsd ?? 0) : 0);
      }
      scheduleRender();
    }
  }

  async function start() {
    // Shield the TUI from any rogue background logs, MCP debug stderr, or child processes
    // leaking into the active raw screen / composer input line.
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;
    const origDebug = console.debug;
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    restoreConsole = () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      console.info = origInfo;
      console.debug = origDebug;
      try { process.stderr.write = origStderrWrite; } catch { /* ignore */ }
    };

    const noop = () => {};
    console.log = noop;
    console.warn = noop;
    console.error = noop;
    console.info = noop;
    console.debug = noop;
    (process.stderr.write as NodeJS.WriteStream['write']) = (
      _chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ) => {
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    };

    // Enable SGR mouse reporting. The three modes do different things:
    //   ?1000  — basic press/release (needed for click)
    //   ?1002  — button-event tracking: forwards MOTION events while a button
    //            is held (needed for drag-select to actually update the
    //            highlight between press and release)
    //   ?1006  — SGR encoding so columns >223 don't get truncated
    // Without ?1002 a drag produces only a press+release pair — the user
    // sees no inline highlight, and copy() returns the single character
    // that was clicked. That's the "highlight doesn't work" bug.
    const initialBg = canvasBg();
    const oscBg = initialBg ? OSC_BG_BLACK : '';
    try {
      process.stdout.write(ALT_ENTER + oscBg + NO_AUTOWRAP + HIDE + '\x1b[?1000h\x1b[?1002h\x1b[?1006h' + BRACKET_PASTE_ON + `\x1b]0;mochi · ${projectName}\x07`);
    } catch { /* EPIPE or dead tty */ }
    try { process.stdin.setRawMode?.(true); } catch { /* not a tty / errno 5 */ }
    try { process.stdin.resume(); } catch { /* ignore */ }
    const keyListener = (buf: Buffer) => onKey(buf);
    process.stdin.on('data', keyListener);
    const resizeListener = () => {
      // Re-wrap the newest summary card at the new width so windowed↔fullscreen
      // transitions never leave it overflowing or compressed.
      rewrapSummaries(state, process.stdout.columns || 100);
      scheduleRender();
    };
    process.stdout.on('resize', resizeListener);
    const exitListener = () => {
      // Runs on EVERY exit path including hard crashes (uncaughtException →
      // process.exit). Raw mode and mouse/paste modes must be undone here or
      // the user's terminal is left broken ("frozen") after any crash.
      // Individually guarded: on a dead tty (errno 5 / EPIPE) a throw here
      // skips the remaining resets and the terminal stays frozen.
      try { restoreConsole?.(); } catch { /* ignore */ }
      try { process.stdin.setRawMode?.(false); } catch { /* dead tty */ }
      try {
        process.stdout.write(`${RESET}${SHOW}${AUTOWRAP}${ALT_EXIT}${OSC_BG_RESET}\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b]0;\x07` + BRACKET_PASTE_OFF);
      } catch { /* EPIPE on a dead pane */ }
    };
    process.on('exit', exitListener);
    // External signals (kill, terminal close) bypass the 'exit'-only restore:
    // convert them to the graceful exit() so the tty is always restored.
    const signalExit = () => exit();
    process.on('SIGINT', signalExit);
    process.on('SIGTERM', signalExit);
    process.on('SIGHUP', signalExit);
    subscribeTab(activeTabId, runtime);
    // Interactive mid-task questions (ask_question) resolve through the TUI
    // menu above; every tab runtime gets the same resolver (see newTab).
    // Same for the approval gate (allow/deny menu for mutating tools).
    runtime.setPromptUser(tuiPromptUser);
    runtime.setApprovalHandler(tuiRequestApproval);
    void refreshGitStats(); // seed the status bar diff stats

    // Clean fresh startup: single session tab ready for immediate work
    tabs.rename(activeTabId, 'Session 1');
    tabs.setStatus(activeTabId, 'idle');
    runtime.activeSessionId = undefined;

    // First launch ever: ONE quiet hint line, never an auto-wizard. The old
    // auto-onboarding pushed ~10 system lines about agents/skills/models/MCPs
    // and opened the setup menu before the user typed anything — mochi
    // appearing to "type messages automatically" about MCPs. The full wizard
    // lives on explicit /onboard. The startup model check below covers keys.
    try {
      const { isOnboarded } = await import('../onboarding/import.js');
      if (!isOnboarded() && !initialPrompt) {
        push('system', '◇ First launch? Run /onboard for the 60-second setup (borrows keys, models, skills & MCPs from your other agents). Nothing runs until you ask.');
        scheduleRender();
      }
    } catch { /* onboarding hint is best-effort */ }
    // Startup model health: a missing key or an unknown model id fails EVERY
    // request (401/404 + failover burn), which reads as "loads with a fake
    // model". Say so in one line with the fix; silence when healthy.
    try {
      const { checkStartupModel } = await import('../model/startup-check.js');
      const health = checkStartupModel(runtime.config.model);
      if (!health.ok && health.line) {
        push('system', health.line);
        scheduleRender();
      }
    } catch { /* health check is best-effort */ }
    cleanupFns = [
      () => { try { restoreConsole?.(); } catch { /* ignore */ } },
      () => process.stdin.off('data', keyListener),
      () => process.stdout.off('resize', resizeListener),
      () => process.off('exit', exitListener),
      () => process.off('SIGINT', signalExit),
      () => process.off('SIGTERM', signalExit),
      () => process.off('SIGHUP', signalExit),
    ];
    startSpinner();
    scheduleRender();
    if (initialPrompt) {
      push('user', initialPrompt);
      state.busy = true;
      state.busyStartedAt = Date.now();
      tabs.setBusy(activeTabId, true);
      tabs.setStatus(activeTabId, 'running');
      tabs.autoTitle(activeTabId, initialPrompt);
      startSpinner();
      // echo:false — the agent streams assistant turns already.
      runtime.runPrompt(initialPrompt)
        .then((res) => {
          tabs.setStatus(activeTabId, 'done');
          if (!state.lines.some((l) => l.kind === 'assistant') && res && res.trim()) {
            push('assistant', res);
          }
        })
        .catch((e) => {
          tabs.setStatus(activeTabId, 'error');
          push('error', e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          state.busy = false;
          state.doneAt = Date.now();
          state.lastDoneElapsed = ((Date.now() - (state.busyStartedAt || state.startedAt)) / 1000).toFixed(1) + 's';
          tabs.setBusy(activeTabId, false);
          stopSpinner();
          scheduleRender();
          setTimeout(() => {
            if (state.doneAt && Date.now() - state.doneAt >= 2500) {
              state.doneAt = 0;
              scheduleRender();
            }
          }, 2600);
        });
    }
  }

  void start();
  return new Promise<void>(() => {});
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
