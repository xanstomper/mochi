import { TOOL_ALIASES, normalizeToolArgs } from '../tools/index.js';
import { T, R } from './view.js';

const TOOL_NAMES: Record<string, string> = {
  write: 'write', edit: 'edit', patch: 'patch', delete: 'delete',
  read: 'read', search: 'search', glob: 'glob', inspect: 'inspect', tree: 'tree',
  fetch: 'fetch', shell: 'shell', git: 'git',
  verify: 'verify', perf: 'perf', test: 'test',
  memory: 'memory', skill: 'skill', subagent: 'subagent', think: 'think', todo: 'todo',
};

// Semantic color roles for tool categories
function toolColor(tool: string): string {
  const t = TOOL_ALIASES[tool] || tool;
  if (['write', 'edit', 'patch', 'delete'].includes(t)) return R.toolWriteName ?? T.cyan ?? T.fg;
  if (['read', 'search', 'glob', 'inspect', 'tree'].includes(t)) return R.toolReadName ?? T.cyan ?? T.fg;
  if (['fetch', 'web_search'].includes(t)) return T.violet ?? T.fg;
  if (t === 'shell' || t === 'git') return R.toolShellName ?? T.orange ?? T.warning ?? T.fg;
  if (['verify', 'perf', 'test'].includes(t)) return R.toolTestName ?? T.success ?? T.lime ?? T.fg;
  if (['memory', 'skill', 'subagent'].includes(t)) return T.violet ?? T.fg;
  return R.toolGenericName ?? T.fg;
}

// File operation glyph
function toolGlyph(tool: string): string {
  const t = TOOL_ALIASES[tool] || tool;
  if (t === 'write' || t === 'create') return '+';
  if (t === 'edit' || t === 'patch') return '~';
  if (t === 'delete') return '−';
  if (t === 'read') return '←';
  if (['search', 'glob', 'inspect', 'tree'].includes(t)) return '◇';
  if (t === 'shell' || t === 'git' || t === 'bash') return '→';
  if (['fetch', 'web_search'].includes(t)) return '↗';
  if (['verify', 'perf', 'test'].includes(t)) return '✓';
  return '◇';
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

function padEnd(s: string, n: number): string {
  const vis = visibleLen(s);
  if (vis >= n) return s;
  return s + ' '.repeat(n - vis);
}

function truncate(s: string, max: number): string {
  const vis = visibleLen(s);
  if (vis <= max) return s;
  let out = '';
  let cells = 0;
  let i = 0;
  while (i < s.length && cells < max - 1) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    cells++;
    i++;
  }
  return out + T.reset + '…';
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

export function describeToolArgs(rawTool: string, rawArgs: unknown): string {
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    const a = normalizeToolArgs(tool, rawArgs as Record<string, unknown>);
    if (a.path) {
      const p = String(a.path);
      if (a.oldText !== undefined && a.newText !== undefined) {
        const oldLines = String(a.oldText).split('\n');
        const newLines = String(a.newText).split('\n');
        const max = Math.max(oldLines.length, newLines.length);
        let added = 0, removed = 0;
        for (let i = 0; i < max; i++) {
          if (oldLines[i] !== newLines[i]) {
            if (newLines[i] !== undefined) added++;
            if (oldLines[i] !== undefined) removed++;
          }
        }
        return `${p} (+${added}/-${removed})`;
      }
      if (a.content !== undefined) {
        const lines = String(a.content).split('\n').length;
        return `${p} (${lines} lines)`;
      }
      return p;
    }
    if (a.command) return `$ ${String(a.command).trim()}`;
    if (a.query) return `"${String(a.query)}"`;
    if (a.pattern) return `${String(a.pattern)}`;
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
  status?: 'pending' | 'running' | 'success' | 'error';
  width?: number;
}

function renderInlineDiff(oldText: string, newText: string, width: number): string[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  let added = 0;
  let removed = 0;

  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      // context line, only show if few unchanged around changes
      if (out.length > 0 && out.length < 5) {
        out.push(`  ${T.grayDark}${truncate(o, width - 4)}${T.reset}`);
      }
    } else if (o !== undefined && n !== undefined) {
      out.push(`  ${T.error}-${T.reset} ${truncate(o, width - 4)}`);
      out.push(`  ${T.success}+${T.reset} ${truncate(n, width - 4)}`);
      removed++;
      added++;
    } else if (n !== undefined) {
      out.push(`  ${T.success}+${T.reset} ${truncate(n, width - 4)}`);
      added++;
    } else if (o !== undefined) {
      out.push(`  ${T.error}-${T.reset} ${truncate(o, width - 4)}`);
      removed++;
    }
    if (out.length >= 12) break;
  }

  const summary = `${T.grayDark}${added} change${added === 1 ? '' : 's'} · ${added} added · ${removed} removed${T.reset}`;
  out.push(`  ${T.grayDark}↳${T.reset} ${summary}`);
  return out;
}

export function renderToolCard(
  rawTool: string,
  rawArgs: unknown,
  outcome?: { kind: 'success' | 'error'; summary: string; durationMs?: number },
  opts: ToolCardOptions = {},
): string {
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  const name = TOOL_NAMES[tool] ?? tool;
  const color = toolColor(tool);
  const glyph = toolGlyph(tool);
  const effective = opts.status ?? (outcome ? (outcome.kind === 'success' ? 'success' : 'error') : 'pending');

  const statusGlyph = effective === 'success' ? '✓' : effective === 'error' ? '×' : effective === 'running' ? '◌' : glyph;
  const statusColor = effective === 'success' ? (T.success ?? T.lime)
    : effective === 'error' ? (T.error ?? '#f87171')
    : effective === 'running' ? (T.cyan ?? T.fg)
    : (T.grayDark ?? T.fg);

  const width = opts.width ?? (process.stdout.columns || 100);
  const dur = outcome?.durationMs !== undefined ? formatDuration(outcome.durationMs) : '';
  const argsText = describeToolArgs(rawTool, rawArgs);

  const primary = `${statusColor}${statusGlyph}${T.reset} ${color}${name}${T.reset} ${T.dim}${argsText}${T.reset}`;
  const durText = dur ? `${T.grayDark}${dur}${T.reset}` : '';
  const durVis = visibleLen(durText);

  let line = primary;
  if (dur && visibleLen(primary) + durVis < width - 4) {
    line = padEnd(primary, width - 4 - durVis) + ' ' + durText;
  }

  const lines: string[] = [line];

  // Edit/patch: render a compact inline diff
  const args = typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : null;
  if ((tool === 'edit' || tool === 'patch') && args?.oldText && args?.newText) {
    lines.push(...renderInlineDiff(String(args.oldText), String(args.newText), width));
  } else if (outcome) {
    const summaryColor = outcome.kind === 'error' ? (T.error) : (T.grayDark);
    const meta = `  ${T.grayDark}↳${T.reset} ${summaryColor}${truncate(outcome.summary, width - 6)}${T.reset}`;
    lines.push(meta);
  }

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

export function renderTurnSummaryCard(s: TurnSummary): string {
  const width = process.stdout.columns || 100;
  const ok = s.success;
  const statusColor = ok ? (T.success ?? T.lime) : (T.error ?? '#f87171');
  const icon = ok ? '✓' : '×';
  const rule = '─'.repeat(Math.max(0, Math.min(width - 2, 70)));

  const lines: string[] = [
    `${T.grayDark}${rule}${T.reset}`,
    `${statusColor}${icon}${T.reset} ${T.bold}${ok ? 'Done' : 'Stopped'}${T.reset}${T.grayDark} · ${formatDuration(s.durationMs)} · ${s.toolCallsTotal} tool${s.toolCallsTotal === 1 ? '' : 's'}${s.tokensUsed ? ` · ${s.tokensUsed.toLocaleString()} tokens` : ''}${T.reset}`,
  ];

  if (s.summary) {
    const firstLine = s.summary.trim().split('\n').map((l) => l.trim()).find((l) => l) ?? '';
    if (firstLine) {
      lines.push(`${T.fg}${truncate(firstLine, width - 4)}${T.reset}`);
    }
  }

  if (s.filesModified.length > 0) {
    const labels = s.filesModified.map((f) => f.length > 36 ? '…' + f.slice(-35) : f);
    const total = labels.length;
    let shown = labels.slice(0, 5);
    let remaining = total - shown.length;
    let text = shown.join(', ');
    if (remaining > 0) text += ` (+${remaining} more)`;
    while (visibleLen(text) > width - 14 && shown.length > 1) {
      shown = shown.slice(0, -1);
      remaining = total - shown.length;
      text = shown.join(', ');
      if (remaining > 0) text += ` (+${remaining} more)`;
    }
    text = truncate(text, width - 14);
    lines.push(`${T.cyan}~${T.reset} ${T.dim}files:${T.reset} ${text}`);
  }

  return lines.join('\n');
}
