import { TOOL_ALIASES, normalizeToolArgs } from '../tools/index.js';
import { T } from './view.js';

const TOOL_NAMES: Record<string, string> = {
  write: 'Write', edit: 'Edit', patch: 'Patch', delete: 'Delete',
  read: 'Read', search: 'Search', glob: 'Glob', inspect: 'Inspect', tree: 'Tree',
  fetch: 'Fetch', shell: 'Shell', git: 'Git',
  verify: 'Verify', perf: 'Perf', test: 'Test',
  memory: 'Memory', skill: 'Skill', subagent: 'Subagent', think: 'Think', todo: 'Todo',
};

function toolColor(tool: string): string {
  if (['write', 'edit', 'patch', 'delete'].includes(tool)) return T.cyan ?? T.fg;
  if (['read', 'search', 'glob', 'inspect', 'tree'].includes(tool)) return T.cyan ?? T.fg;
  if (tool === 'shell' || tool === 'git') return T.orange ?? T.warning ?? T.fg;
  if (['verify', 'perf', 'test'].includes(tool)) return T.success ?? T.lime ?? T.fg;
  if (['memory', 'skill', 'subagent'].includes(tool)) return T.violet ?? T.magenta ?? T.fg;
  return T.fg;
}

function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const padLen = Math.max(0, width - visible.length);
  return s + ' '.repeat(padLen);
}

function truncate(s: string, max: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  if (visible.length <= max) return s;
  let out = '';
  let cells = 0;
  let i = 0;
  while (i < s.length && cells < max - 1) {
    if (s[i] === '\x1b' && s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/)) {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/)![0];
      out += m;
      i += m.length;
      continue;
    }
    out += s[i];
    cells++;
    i++;
  }
  return out + '…';
}

export function describeToolArgs(rawTool: string, rawArgs: unknown): string {
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    const a = normalizeToolArgs(tool, rawArgs as Record<string, unknown>);
    if (a.path) {
      const p = String(a.path);
      if (a.oldText !== undefined && a.newText !== undefined) {
        const oldLines = String(a.oldText).split('\n').length;
        const newLines = String(a.newText).split('\n').length;
        const sign = newLines >= oldLines ? '+' : '';
        return `${p} (${sign}${newLines - oldLines} lines)`;
      }
      if (a.content !== undefined) {
        const lines = String(a.content).split('\n').length;
        return `${p} (${lines} lines)`;
      }
      return p;
    }
    if (a.command) return `$ ${String(a.command).trim()}`;
    if (a.query) return `"${String(a.query)}"`;
    if (a.pattern) return `pattern: ${String(a.pattern)}`;
    if (tool === 'subagent') {
      if (Array.isArray(a.tasks)) return `${a.tasks.length} parallel subtask${a.tasks.length === 1 ? '' : 's'}`;
      const role = (a.role as string) ?? 'coder';
      const prompt = String(a.prompt ?? '').replace(/\s+/g, ' ').slice(0, 60);
      return `[${role}] ${prompt}${prompt.length === 60 ? '…' : ''}`;
    }
  }
  const s = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

export function describeToolOutcome(
  rawTool: string,
  result?: { output?: string; error?: string; durationMs?: number },
): { kind: 'success' | 'error'; summary: string; durationMs?: number } {
  const dur = result?.durationMs ? Math.round(result.durationMs) : undefined;
  if (result?.error) {
    const err = String(result.error).replace(/\s+/g, ' ').slice(0, 120);
    return { kind: 'error', summary: err, durationMs: dur };
  }
  const out = (result?.output ?? '').trim();
  const lines = out.split('\n').filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (/^exit_code:\s*-?\d+$/.test(t)) return false;
    if (/^duration_ms:\s*-?\d+$/.test(t)) return false;
    if (t === '{}' || t === '{ }') return false;
    return true;
  });
  const firstLine = lines[0] ?? '';
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  if (firstLine) {
    const trimmed = firstLine.length > 100 ? firstLine.slice(0, 97) + '…' : firstLine;
    return { kind: 'success', summary: trimmed, durationMs: dur };
  }
  return { kind: 'success', summary: `${tool} completed${out.length === 0 ? ' (no output)' : ''}`, durationMs: dur };
}

export interface ToolCardOptions {
  status?: 'pending' | 'success' | 'error';
  width?: number;
}

// Cline-style tool card: rounded corners, strong semantic colors, clean body.
export function renderToolCard(
  rawTool: string,
  rawArgs: unknown,
  outcome?: { kind: 'success' | 'error'; summary: string; durationMs?: number },
  opts: ToolCardOptions = {},
): string {
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  const name = TOOL_NAMES[tool] ?? tool;
  const color = toolColor(tool);
  const effective = opts.status ?? (outcome ? (outcome.kind === 'success' ? 'success' : 'error') : 'pending');
  const statusIcon = effective === 'success' ? '✓' : effective === 'error' ? '✗' : '○';
  const statusColor = effective === 'success' ? (T.success ?? T.lime) : effective === 'error' ? (T.error ?? '#f87171') : T.grayDark;

  const width = opts.width ?? 64;
  const inner = width - 4;

  const dur = outcome?.durationMs !== undefined ? `${outcome.durationMs}ms` : '';
  const headerText = `${statusColor}${statusIcon}${T.reset} ${T.bold}${name}${T.reset}${T.grayDark}${dur ? ` · ${dur}` : ''}${T.reset}`;
  const headerVis = headerText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const headerPad = ' '.repeat(Math.max(0, inner - headerVis.length));

  const top = `${T.grayDark}  ╭${'─'.repeat(inner)}╮${T.reset}`;
  const header = `${T.grayDark}  │${T.reset} ${color}${headerText}${headerPad}${T.grayDark} │${T.reset}`;

  const argText = describeToolArgs(rawTool, rawArgs);
  const argLine = `${T.grayDark}  │${T.reset} ${T.dim}${argText}${T.reset}${' '.repeat(Math.max(0, inner - 1 - argText.length))}${T.grayDark}│${T.reset}`;

  const lines: string[] = [top, header, argLine];

  if (outcome) {
    const summaryText = truncate(outcome.summary, inner - 2);
    const summaryColor = outcome.kind === 'error' ? T.error : T.fg;
    const summaryLine = `${T.grayDark}  │${T.reset} ${summaryColor}${summaryText}${T.reset}${' '.repeat(Math.max(0, inner - 1 - outcome.summary.slice(0, inner).length))}${T.grayDark}│${T.reset}`;
    lines.push(summaryLine);
  }

  const bottom = `${T.grayDark}  ╰${'─'.repeat(inner)}╯${T.reset}`;
  lines.push(bottom);

  return lines.join('\n');
}

export function formatToolInvocationCard(rawTool: string, rawArgs: unknown): string {
  return renderToolCard(rawTool, rawArgs);
}

export function formatToolCompletedCard(
  rawTool: string,
  rawArgs: unknown,
  result?: { output?: string; error?: string; durationMs?: number },
): string {
  const outcome = describeToolOutcome(rawTool, result);
  return renderToolCard(rawTool, rawArgs, outcome, { status: outcome.kind });
}

export interface TurnSummary {
  success: boolean;
  stopReason?: string;
  durationMs: number;
  toolCallsTotal: number;
  tokensUsed?: number;
  filesModified: string[];
  summary: string;
}

// Cline-style turn summary card: rounded box, strong colors, clear metrics.
export function renderTurnSummaryCard(s: TurnSummary): string {
  const width = 68;
  const inner = width - 4;
  const ok = s.success;
  const statusColor = ok ? (T.success ?? T.lime) : (T.error ?? '#f87171');
  const label = ok ? 'Task complete' : `Task stopped: ${s.stopReason ?? 'aborted'}`;
  const dur = `${Math.round(s.durationMs)}ms`;
  const tools = `${s.toolCallsTotal} tool${s.toolCallsTotal === 1 ? '' : 's'}`;

  const headerText = `${statusColor}${ok ? '✓' : '✗'}${T.reset} ${T.bold}${label}${T.reset}${T.grayDark}  ${dur} · ${tools}${T.reset}`;
  const headerVis = headerText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const headerPad = ' '.repeat(Math.max(0, inner - headerVis.length));

  const top = `${T.grayDark}  ╭${'─'.repeat(inner)}╮${T.reset}`;
  const header = `${T.grayDark}  │${T.reset} ${headerText}${headerPad}${T.grayDark} │${T.reset}`;

  const lines: string[] = [top, header];

  if (s.summary) {
    const firstLine = s.summary.trim().split('\n').map((l) => l.trim()).find((l) => l) ?? '';
    if (firstLine) {
      const text = truncate(firstLine, inner - 2);
      const body = `${T.grayDark}  │${T.reset} ${statusColor}▸${T.reset} ${text}${' '.repeat(Math.max(0, inner - 3 - text.length))}${T.grayDark}│${T.reset}`;
      lines.push(body);
    }
  }

  if (s.filesModified.length > 0) {
    const labels = s.filesModified.map((f) => f.length > 30 ? '…' + f.slice(-29) : f);
    const total = labels.length;
    let shown = labels.slice(0, 4);
    let remaining = total - shown.length;
    let text = shown.join(', ');
    if (remaining > 0) text += ` (+${remaining} more)`;
    while (text.length > inner - 11 && shown.length > 1) {
      shown = shown.slice(0, -1);
      remaining = total - shown.length;
      text = shown.join(', ');
      if (remaining > 0) text += ` (+${remaining} more)`;
    }
    text = truncate(text, inner - 11);
    const body = `${T.grayDark}  │${T.reset} ${T.cyan}✎${T.reset} ${T.dim}files:${T.reset} ${text}${' '.repeat(Math.max(0, inner - 10 - text.length))}${T.grayDark}│${T.reset}`;
    lines.push(body);
  }

  if (s.tokensUsed !== undefined && s.tokensUsed > 0) {
    const text = `${s.tokensUsed.toLocaleString()} tokens`;
    const body = `${T.grayDark}  │${T.reset} ${T.magenta ?? T.fg}◈${T.reset} ${T.dim}tokens:${T.reset} ${text}${' '.repeat(Math.max(0, inner - 11 - text.length))}${T.grayDark}│${T.reset}`;
    lines.push(body);
  }

  const bottom = `${T.grayDark}  ╰${'─'.repeat(inner)}╯${T.reset}`;
  lines.push(bottom);

  return lines.join('\n');
}
