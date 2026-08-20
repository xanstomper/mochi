import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { findProjectRoot } from '../repo.js';
import type { Runtime } from '../runtime.js';
import type { MochiEvent } from '../types.js';
import { PROVIDERS, providerById, providerByName } from '../providers.js';
import { reduceEvent } from './state.js';
import pkg from '../../package.json' with { type: 'json' };
import { kvCache } from '../kv-cache.js';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ALT_ENTER = '\x1b[?1049h';
const ALT_EXIT = '\x1b[?1049l';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const PINK = '\x1b[38;2;255;175;209m';
const CYAN = '\x1b[38;2;137;220;235m';
const GREEN = '\x1b[38;2;152;195;121m';
const RED = '\x1b[38;2;224;108;117m';
const GREY = '\x1b[38;2;120;120;120m';
const YELLOW = '\x1b[38;2;229;192;123m';
const BLUE = '\x1b[38;2;97;175;239m';
const UNDERLINE = '\x1b[4m';
const BG = '\x1b[48;2;50;60;80m';
const BG_USER = '\x1b[48;2;75;50;75m';
const BG_ASSISTANT = '\x1b[48;2;35;48;68m';
const BG_COMPOSER = '\x1b[48;2;22;24;38m';

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
  let chatCache: { ver: number; mw: number; lines: string[] } | null = null;

  const width = () => process.stdout.columns || 100;
  const height = () => process.stdout.rows || 34;

  const push = (kind: LineKind, text: string) => {
    state.lines.push({ kind, text });
    state.chatVer++;
    if (state.lines.length > state.limit) state.lines.splice(0, state.lines.length - state.limit);
    state.scroll = 0;
    scheduleRender();
  };

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  };

  const startSpinner = () => {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      state.spinner = (state.spinner + 1) % SPINNER.length;
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

  function colorizeMarkdown(text: string): string {
    return text
      .replace(/^(#{1,6})\s+(.*)$/, (_, __, title) => `${YELLOW}${BOLD}${title}${RESET}`)
      .replace(/\*\*(.*?)\*\*/g, `${BOLD}$1${RESET}`)
      .replace(/https?:\/\/[^\s]+/g, (url) => `${BLUE}${UNDERLINE}${url}${RESET}`)
      .replace(/^(\s*)-\s+(.*)$/, (_, indent, rest) => `${indent}${GREY}•${RESET} ${rest}`);
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

  function inputLines(): { lines: string[]; cursorRow: number; cursorCol: number } {
    const inner = width() - 6;
    if (!state.input) return { lines: [''], cursorRow: 0, cursorCol: 0 };
    const before = state.input.slice(0, state.cursor);
    const after = state.input.slice(state.cursor);
    const beforeLines = wrap(before, inner);
    const afterLines = wrap(after, inner);
    const cursorLine = beforeLines[beforeLines.length - 1] ?? '';
    const lines = [...beforeLines.slice(0, -1), cursorLine + (afterLines[0] ?? ''), ...afterLines.slice(1)];
    return {
      lines,
      cursorRow: beforeLines.length - 1,
      cursorCol: Math.min(cursorLine.length, inner),
    };
  }

  function taskTree(): string[] {
    if (state.tasks.size === 0) return [];
    const out: string[] = [];
    const roots = [...state.tasks.values()];
    for (const task of roots) {
      const icon = task.status === 'done' ? '✓' : task.status === 'failed' ? '✗' : task.status === 'running' ? '◐' : '○';
      const color = task.status === 'done' ? GREEN : task.status === 'failed' ? RED : task.status === 'running' ? CYAN : GREY;
      out.push(`${color}${icon}${RESET} ${task.title}${DIM} (${task.role})${RESET}`);
    }
    return out;
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

  function prefixFor(kind: LineKind): { text: string; displayLength: number } {
    switch (kind) {
      case 'user': return { text: `${PINK}>${RESET} `, displayLength: 2 };
      case 'assistant': return { text: '', displayLength: 0 };
      case 'tool': return { text: `${DIM}·${RESET} `, displayLength: 2 };
      case 'task': return { text: `${DIM}·${RESET} `, displayLength: 2 };
      case 'goal': return { text: `${PINK}●${RESET} `, displayLength: 2 };
      case 'error': return { text: `${RED}✗${RESET} `, displayLength: 2 };
      case 'system': return { text: `${DIM}·${RESET} `, displayLength: 2 };
      default: return { text: '  ', displayLength: 2 };
    }
  }

  function pad(s: string, n: number): string {
    const vis = (s || '').replace(/\x1b\[[0-9;]*m/g, '');
    if (vis.length === n) return s;
    if (vis.length > n) return s.slice(0, n);
    return s + ' '.repeat(n - vis.length);
  }

  function renderChat(maxWidth: number): string[] {
    const out: string[] = [];
    for (const line of state.lines) {
      if (line.kind === 'goal') continue;
      if (line.kind === 'system' && line.text.startsWith('Tokens used:')) continue;
      const text = prettifyToolCall(line.text) ?? line.text;
      if (!text.trim()) continue;
      if (line.kind === 'user') {
        out.push(...roundedBox(text, maxWidth, 'right', 'You', PINK, BG_USER));
      } else if (line.kind === 'assistant') {
        out.push(...roundedBox(text, maxWidth, 'left', 'AI', CYAN, BG_ASSISTANT));
      } else {
        const prefix = prefixFor(line.kind);
        const wrapped = wrap(text, maxWidth - prefix.displayLength);
        for (let i = 0; i < wrapped.length; i++) {
          const content = colorizeMarkdown(wrapped[i]);
          const txt = i === 0 ? prefix.text + CYAN + content + RESET : ' '.repeat(prefix.displayLength) + CYAN + content + RESET;
          out.push(pad(txt, maxWidth));
        }
        out.push('');
      }
    }
    return out;
  }

  function roundedBox(text: string, maxWidth: number, align: 'left' | 'right', label: string, fg: string, bg: string): string[] {
    const textVis = Math.max(1, visibleLen(text));
    const labelVis = visibleLen(label);
    const minInner = Math.max(textVis + 2, labelVis + 4);
    const boxW = Math.min(Math.max(20, minInner), Math.floor(maxWidth * 0.92));
    const innerW = boxW - 2;
    const contentW = innerW - 2;
    const leftPad = align === 'right' ? Math.max(0, maxWidth - boxW) : 0;
    const wrapped = wrap(text, contentW);
    const lines: string[] = [];

    const topFill = Math.max(0, innerW - labelVis - 2);
    const topLabel = align === 'right'
      ? '─'.repeat(topFill) + ' ' + label + ' '
      : ' ' + label + ' ' + '─'.repeat(topFill);
    const top = ' '.repeat(leftPad) + bg + fg + '╭' + topLabel + '╮' + RESET + ' '.repeat(Math.max(0, maxWidth - leftPad - boxW));
    lines.push(pad(top, maxWidth));

    for (const wline of wrapped) {
      const content = colorizeMarkdown(wline);
      const fill = Math.max(0, contentW - visibleLen(content));
      const row = ' '.repeat(leftPad) + bg + fg + '│ ' + RESET + bg + content + bg + fg + ' │' + RESET + ' '.repeat(Math.max(0, maxWidth - leftPad - boxW));
      lines.push(pad(row, maxWidth));
    }

    const bottom = ' '.repeat(leftPad) + bg + fg + '╰' + '─'.repeat(innerW) + '╯' + RESET + ' '.repeat(Math.max(0, maxWidth - leftPad - boxW));
    lines.push(pad(bottom, maxWidth));
    lines.push('');
    return lines;
  }

  function composerState(): { rows: string[]; cursorRow: number; cursorCol: number; height: number } {
    const w = width();
    const innerW = Math.max(20, w - 6);
    const raw = state.input;
    const wrapped = raw ? wrap(raw, innerW) : [''];
    const placeholder = GREY + 'Send a message…' + RESET;
    const displayRows = raw ? wrapped.map(colorizeMarkdown) : [placeholder];
    const maxRows = 6;
    let cursorRow = 0;
    let cursorCol = 0;
    if (raw) {
      const before = raw.slice(0, state.cursor);
      const beforeLines = wrap(before, innerW);
      cursorRow = beforeLines.length - 1;
      cursorCol = visibleLen(beforeLines[beforeLines.length - 1] ?? '');
    }
    let visibleRows = displayRows;
    if (displayRows.length > maxRows) {
      visibleRows = displayRows.slice(-maxRows);
      const firstVisible = displayRows.length - maxRows;
      if (cursorRow < firstVisible) cursorRow = visibleRows.length - 1;
      else cursorRow -= firstVisible;
    }
    const height = Math.min(8, Math.max(3, visibleRows.length + 2));
    while (visibleRows.length < height - 2) visibleRows.push('');
    return { rows: visibleRows, cursorRow, cursorCol, height };
  }

  function buildHeader(w: number): string {
    const yoloBadge = (runtime as any).__permPolicy === 'yolo'
      ? ' ' + '\x1b[38;2;255;100;0m' + '\x1b[1m' + '⚡ YOLO' + RESET
      : (runtime as any).__permPolicy === 'workspace-safe'
        ? ' ' + YELLOW + '🔓 AUTO' + RESET
        : '';
    const left = ' ' + PINK + BOLD + '🍡 mochi' + RESET + ' ' + DIM + pkg.version + RESET + yoloBadge;
    const right = ' ' + DIM + projectName + RESET + (branch ? ' ' + GREY + branch + RESET : '') + ' ' + GREY + '·' + RESET + ' ' + CYAN + modelShort + RESET + ' ';
    const sp = Math.max(1, w - visibleLen(left) - visibleLen(right));
    return pad(left + ' '.repeat(sp) + right, w);
  }

  function ctxBar(w: number): string {
    const used = state.lines.length * 4;
    const budget = runtime.config.safety.contextBudgetTokens || 120000;
    const pct = Math.max(0, Math.min(1, used / budget));
    const width = 10;
    const filled = Math.round(pct * width);
    const bar = GREEN + '█'.repeat(filled) + GREY + '░'.repeat(width - filled) + RESET;
    const color = pct > 0.8 ? RED : pct > 0.5 ? YELLOW : DIM;
    return ' ' + bar + ' ' + color + Math.round(pct * 100) + '%' + RESET;
  }

  function buildStatus(w: number): string {
    const queued = [...state.tasks.values()].filter(t => t.status === 'pending').length;
    const permBadge = (runtime as any).__permPolicy === 'yolo'
      ? ' ' + '\x1b[38;2;255;100;0m' + '[⚡ PERMS BYPASSED]' + RESET
      : '';
    const left = state.busy
      ? CYAN + SPINNER[state.spinner] + RESET + ' thinking… ' + DIM + (state.currentTool || state.currentTask || '') + RESET
      : GREEN + '●' + RESET + ' ready' + permBadge;
    const cacheBadge = kvCache.badge() ? ' ' + GREY + '·' + RESET + ' ' + kvCache.badge() : '';
    const right = DIM + 'tokens' + RESET + ' ' + (state.lines.length * 4) + ' ' + GREY + '·' + RESET + ' ' + DIM + formatDuration(Date.now() - state.startedAt) + RESET + cacheBadge + (queued ? ' ' + GREY + '·' + RESET + ' ' + DIM + queued + ' queued' + RESET : '') + ctxBar(w);
    const sp = Math.max(1, w - visibleLen(left) - visibleLen(right));
    return pad(left + ' '.repeat(sp) + right, w);
  }

  function buildSidebar(sideW: number, contentH: number): string[] {
    const side: string[] = [];
    if (sideW === 0) return side;
    const inner = sideW - 2;
    const lastUser = [...state.lines].reverse().find(l => l.kind === 'user')?.text ?? '';
    side.push(PINK + '╔' + '═'.repeat(inner) + '╗' + RESET);
    side.push(PINK + '║' + RESET + ' ' + BOLD + 'MOCHI' + RESET + ' ' + DIM + 'sidebar' + ' '.repeat(Math.max(0, inner - 10)) + PINK + '║' + RESET);
    side.push(PINK + '╠' + '═'.repeat(inner) + '╣' + RESET);
    if (lastUser) {
      const qLines = wrap(lastUser, inner - 4);
      for (const ql of qLines) {
        const fill = Math.max(0, inner - 2 - visibleLen(ql));
        side.push(PINK + '║' + RESET + ' ' + YELLOW + BOLD + ql + RESET + ' '.repeat(fill) + PINK + '║' + RESET);
      }
      side.push(PINK + '║' + ' '.repeat(inner) + '║' + RESET);
    }
    side.push(PINK + '║' + RESET + ' ' + BOLD + 'Status' + RESET + ' '.repeat(Math.max(0, inner - 7)) + PINK + '║' + RESET);
    if (state.busy) {
      side.push(PINK + '║' + RESET + ' ' + CYAN + SPINNER[state.spinner] + RESET + ' working…' + ' '.repeat(Math.max(0, inner - 13)) + PINK + '║' + RESET);
    } else {
      side.push(PINK + '║' + RESET + ' ' + GREEN + '●' + RESET + ' ready' + ' '.repeat(Math.max(0, inner - 8)) + PINK + '║' + RESET);
    }
    if (state.busy && state.currentTool) {
      side.push(PINK + '║' + RESET + ' ' + DIM + state.currentTool + RESET + ' '.repeat(Math.max(0, inner - 1 - visibleLen(state.currentTool))) + PINK + '║' + RESET);
    }
    side.push(PINK + '║' + ' '.repeat(inner) + '║' + RESET);
    side.push(PINK + '║' + RESET + ' ' + BOLD + 'Details' + RESET + ' '.repeat(Math.max(0, inner - 8)) + PINK + '║' + RESET);
    side.push(PINK + '║' + RESET + ' ' + DIM + 'time' + RESET + '  ' + formatDuration(Date.now() - state.startedAt) + ' '.repeat(Math.max(0, inner - 7 - visibleLen(formatDuration(Date.now() - state.startedAt)))) + PINK + '║' + RESET);
    side.push(PINK + '║' + RESET + ' ' + DIM + 'model' + RESET + ' ' + CYAN + modelShort + RESET + ' '.repeat(Math.max(0, inner - 7 - visibleLen(modelShort))) + PINK + '║' + RESET);
    side.push(PINK + '║' + RESET + ' ' + DIM + 'tokens' + RESET + ' ' + String(state.lines.length * 4) + ' '.repeat(Math.max(0, inner - 8 - String(state.lines.length * 4).length)) + PINK + '║' + RESET);
    side.push(PINK + '║' + RESET + ' ' + DIM + 'budget' + RESET + ' ' + (runtime.config.safety.contextBudgetTokens / 1000).toFixed(0) + 'k' + ' '.repeat(Math.max(0, inner - 9 - (runtime.config.safety.contextBudgetTokens / 1000).toFixed(0).length)) + PINK + '║' + RESET);
    // KV Cache status
    const cacheLabel = kvCache.badge() || 'unknown';
    side.push(PINK + '║' + RESET + ' ' + DIM + 'cache' + RESET + ' ' + cacheLabel + ' '.repeat(Math.max(0, inner - 7 - visibleLen(cacheLabel))) + PINK + '║' + RESET);
    // Permission policy
    const permLabel = (runtime as any).__permPolicy === 'yolo' ? '\x1b[38;2;255;100;0m⚡ YOLO\x1b[0m' : (runtime as any).__permPolicy === 'workspace-safe' ? YELLOW + '🔓 auto' + RESET : GREEN + '🛡️  safe' + RESET;
    side.push(PINK + '║' + RESET + ' ' + DIM + 'perms' + RESET + ' ' + permLabel + ' '.repeat(Math.max(0, inner - 12)) + PINK + '║' + RESET);
    side.push(PINK + '║' + ' '.repeat(inner) + '║' + RESET);
    if (state.tasks.size > 0) {
      side.push(PINK + '║' + RESET + ' ' + BOLD + 'Tasks' + RESET + ' '.repeat(Math.max(0, inner - 6)) + PINK + '║' + RESET);
      const order: Record<string, number> = { running: 0, pending: 1, done: 2, failed: 3 };
      const all = [...state.tasks.values()].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
      const pendingCount = all.filter(t => t.status === 'pending').length;
      for (const t of all.slice(0, contentH - 16)) {
        const ic = t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : t.status === 'running' ? '◐' : '○';
        const col = t.status === 'done' ? GREEN : t.status === 'failed' ? RED : t.status === 'running' ? CYAN : GREY;
        const line = ` ${col}${ic}${RESET} ${t.title}`;
        side.push(PINK + '║' + RESET + pad(line, inner) + PINK + '║' + RESET);
      }
      side.push(PINK + '║' + RESET + ' ' + DIM + pendingCount + ' queued' + RESET + ' '.repeat(Math.max(0, inner - 10 - String(pendingCount).length)) + PINK + '║' + RESET);
      side.push(PINK + '║' + ' '.repeat(inner) + '║' + RESET);
    }
    while (side.length < contentH) side.push(PINK + '║' + ' '.repeat(inner) + '║' + RESET);
    side[side.length - 1] = PINK + '╚' + '═'.repeat(inner) + '╝' + RESET;
    return side.slice(0, contentH);
  }

  let lastFrame: string[] = [];
  let lastW = 0;

  function render() {
    if (exited) return;
    const w = width();
    const h = height();
    const sideW = w >= 110 ? Math.max(44, Math.floor(w * 0.34)) : 0;
    const mainW = w - sideW - (sideW ? 2 : 0);
    const composer = composerState();
    const composerHeight = composer.height;
    const composerTop = h - composerHeight + 1;
    const statusRow = composerTop - 1;
    const contentTop = 2;
    const contentBottom = statusRow - 1;
    const contentH = Math.max(1, contentBottom - contentTop + 1);

    const chatMw = mainW - 2;
    if (!chatCache || chatCache.ver !== state.chatVer || chatCache.mw !== chatMw) {
      chatCache = { ver: state.chatVer, mw: chatMw, lines: renderChat(chatMw) };
    }
    const chatLines = chatCache.lines;
    const visible = chatLines.slice(Math.max(0, chatLines.length - contentH - state.scroll), Math.max(0, chatLines.length - state.scroll));
    const sideRows = buildSidebar(sideW, contentH);

    const rows: string[] = new Array(h).fill('');

    rows[0] = buildHeader(w);

    for (let i = 0; i < contentH; i++) {
      const r = contentTop + i - 1;
      const left = visible[i] ?? '';
      if (sideW > 0) {
        const right = sideRows[i] ?? '';
        rows[r] = pad(left, mainW) + ' ' + right;
      } else {
        rows[r] = pad(left, w);
      }
    }

    if (state.input.startsWith('/') && !state.menuActive) {
      const palette = COMMANDS.filter(c => c.name.startsWith(state.input.split(' ')[0])).slice(0, 5);
      const pTop = Math.max(contentTop, contentBottom - palette.length - 1);
      for (let pi = 0; pi < palette.length; pi++) {
        const r = pTop + pi - 1;
        const c = palette[pi];
        const line = ' ' + CYAN + c.name.padEnd(14) + RESET + ' ' + DIM + c.hint + RESET;
        if (r >= 0 && r < h) rows[r] = pad(line, mainW - 2);
      }
    }

    rows[statusRow - 1] = buildStatus(w);

    const title = ' Message ';
    rows[composerTop - 1] = CYAN + '╔' + title + '═'.repeat(Math.max(0, w - 2 - title.length)) + '╗' + RESET;
    const innerW = Math.max(20, w - 6);
    for (let i = 0; i < composerHeight - 2; i++) {
      const r = composerTop + i;
      if (r >= 0 && r < h) rows[r] = CYAN + '║ ' + RESET + BG_COMPOSER + pad(composer.rows[i] ?? '', innerW) + RESET + CYAN + ' ║' + RESET;
    }
    rows[h - 1] = CYAN + '╚' + '═'.repeat(w - 2) + '╝' + RESET;

    if (state.menuActive) {
      const menuH = Math.min(state.menuItems.length + 4, contentH - 2);
      const menuTop = Math.max(contentTop, Math.floor((contentTop + contentBottom) / 2 - menuH / 2));
      const menuW = Math.min(Math.max(50, Math.floor(w * 0.5)), w - 8);
      const mLeft = Math.floor((w - menuW - 2) / 2);
      rows[menuTop - 1] = PINK + '╔' + '═'.repeat(menuW - 2) + '╗' + RESET;
      rows[menuTop] = PINK + '║' + RESET + ' ' + BOLD + state.menuTitle + RESET + ' ' + DIM + '↑/↓ · Enter · Esc' + RESET + ' '.repeat(Math.max(0, menuW - 6 - visibleLen(state.menuTitle) - 20)) + PINK + '║' + RESET;
      rows[menuTop + 1] = PINK + '╠' + '═'.repeat(menuW - 2) + '╣' + RESET;
      for (let mi = 0; mi < menuH - 4 && menuTop + 3 + mi < contentBottom; mi++) {
        const r = menuTop + 3 + mi - 1;
        const sel = mi === state.menuSelected;
        const item = state.menuItems[mi] ?? '';
        const mark = state.menuMark.has(mi);
        const row = (sel ? PINK + '➤ ' : '  ') + (mark ? PINK + '● ' : '   ') + (sel ? BOLD : '') + item + RESET;
        rows[r] = PINK + '║' + RESET + ' ' + pad(row, menuW - 6) + PINK + '║' + RESET;
      }
      rows[menuTop + menuH - 2] = PINK + '╚' + '═'.repeat(menuW - 2) + '╝' + RESET;
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
    const cursorRow = composerTop + 1 + composer.cursorRow;
    const cursorCol = 3 + composer.cursorCol;
    out += '\x1b[' + cursorRow + ';' + cursorCol + 'H' + SHOW;
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
        const { formatModes } = await import('../modes.js');
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
      const { formatModes } = await import('../modes.js');
      push('system', formatModes((runtime.config.mode as any) ?? 'normal'));
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
      if (c === '\x1b' && s[i + 1] === '\x1b') {
        if (state.busy) {
          state.busy = false;
          stopSpinner();
          push('system', 'Stopped.');
          if (state.menuActive) closeMenu(-1);
        } else {
          exit();
        }
        scheduleRender();
        i += 2;
        continue;
      }
      if (c === '\x1b' && s[i + 1] === '\x1b') {
        if (state.busy) {
          state.busy = false;
          stopSpinner();
          push('system', 'Stopped.');
          if (state.menuActive) closeMenu(-1);
        } else {
          exit();
        }
        scheduleRender();
        i += 2;
        continue;
      }
      if (c === '\x1b') {
        const rest = s.slice(i);
        const m = rest.match(/^\x1b\[[0-9]*[A-Za-z~]/);
        if (m) {
          handleEscape(m[0]);
          i += m[0].length;
          continue;
        }
        if (rest === '\x1b') {
          const now = Date.now();
          if (now - lastEscAt < 400) {
            if (state.busy) {
              state.busy = false;
              stopSpinner();
              push('system', 'Stopped.');
              if (state.menuActive) closeMenu(-1);
            } else {
              exit();
            }
          } else {
            lastEscAt = now;
            state.input = '';
            state.cursor = 0;
            if (state.menuActive) closeMenu(-1);
          }
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
      case '\x1b[A': historyPrev(); break;
      case '\x1b[B': historyNext(); break;
      case '\x1b[5~': state.scroll = Math.min(state.lines.length, state.scroll + 10); break;
      case '\x1b[6~': state.scroll = Math.max(0, state.scroll - 10); break;
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

  function onRuntimeEvent(event: MochiEvent) {
    // Delegate to the pure, tested reducer (src/tui/state.ts): it maintains
    // the transcript, task tree, current tool, and stop reasons exactly as the
    // tests assert. Non-rendering events return false and skip the redraw.
    if (reduceEvent(state, event as unknown as Record<string, unknown>)) {
      state.scroll = 0;
      scheduleRender();
    }
  }

  function start() {
    process.stdout.write(ALT_ENTER + HIDE);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const keyListener = (buf: Buffer) => onKey(buf);
    process.stdin.on('data', keyListener);
    const resizeListener = () => scheduleRender();
    process.stdout.on('resize', resizeListener);
    const exitListener = () => {
      process.stdout.write(`${RESET}${SHOW}${ALT_EXIT}`);
    };
    process.on('exit', exitListener);
    runtime.events.onAll(onRuntimeEvent);
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
