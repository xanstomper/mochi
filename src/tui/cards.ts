import { TOOL_ALIASES, normalizeToolArgs } from '../tools/index.js';
import { T } from './view.js';

/**
 * Cline-style boxed tool cards.
 *
 * The default agent transcript just shows one line per tool call
 * (`▷ edit: src/foo.ts`) which is fine for status but impossible to
 * scan once a turn runs several tools in parallel — the user can no
 * longer tell at a glance which file was edited, which command ran,
 * and what came back. This module renders each tool call as a small
 * framed card with a status icon, the tool name, the key argument(s),
 * and the first useful line of output (success) or error (failure).
 *
 * The whole card is a single string with embedded newlines and ANSI
 * codes, so the existing `wrapLine` / transcript machinery renders
 * it without any changes — each wrapped row becomes a card row.
 *
 * Width is bounded so a tool call never wraps awkwardly: long paths
 * and commands are truncated to the card width minus the gutter that
 * the renderer prepends on every row.
 */

const TOOL_ICONS: Record<string, string> = {
  write: '✎', edit: '✎', patch: '✎', delete: '✕',
  read: '○', search: '○', glob: '○', inspect: '○', tree: '○',
  fetch: '↓', shell: '▷', git: '▷',
  verify: '✓', perf: '✓', test: '✓',
  memory: '◌', skill: '◌', subagent: '◆', think: '◌', todo: '☐',
};

const TOOL_NAMES: Record<string, string> = {
  write: 'WRITE', edit: 'EDIT', patch: 'PATCH', delete: 'DELETE',
  read: 'READ', search: 'SEARCH', glob: 'GLOB', inspect: 'INSPECT', tree: 'TREE',
  fetch: 'FETCH', shell: 'SHELL', git: 'GIT',
  verify: 'VERIFY', perf: 'PERF', test: 'TEST',
  memory: 'MEMORY', skill: 'SKILL', subagent: 'SUBAGENT', think: 'THINK', todo: 'TODO',
};

/** Map a tool to a semantic color token (theme-aware). */
function toolColor(tool: string): string {
  if (['write', 'edit', 'patch', 'delete'].includes(tool)) return T.cyan ?? T.fg;
  if (['read', 'search', 'glob', 'inspect', 'tree'].includes(tool)) return T.fg;
  if (tool === 'shell' || tool === 'git') return T.orange ?? T.warning ?? T.fg;
  if (['verify', 'perf', 'test'].includes(tool)) return T.success ?? T.lime ?? T.fg;
  if (['memory', 'skill', 'subagent'].includes(tool)) return T.magenta ?? T.violet ?? T.pink ?? T.fg;
  return T.fg;
}
/** Pick a one-line description of a tool call's arguments. Returns the
 *  raw single string the card will display; never wraps inside. */
export function describeToolArgs(rawTool: string, rawArgs: unknown): string {
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    const a = normalizeToolArgs(tool, rawArgs as Record<string, unknown>);
    if (a.path) {
      const p = String(a.path);
      if (a.oldText !== undefined && a.newText !== undefined) {
        const oldLen = String(a.oldText).length;
        const newLen = String(a.newText).length;
        const delta = newLen - oldLen;
        const sign = delta > 0 ? '+' : delta < 0 ? '' : '±';
        return `${p}  ${sign}${delta}`;
      }
      if (a.content !== undefined) {
        const lines = String(a.content).split('\n').length;
        return `${p}  (${lines} line${lines === 1 ? '' : 's'})`;
      }
      return p;
    }
    if (a.command) {
      const cmd = String(a.command).trim();
      return `$ ${cmd}`;
    }
    if (a.query) return `"${String(a.query)}"`;
    if (a.pattern) return `pattern: ${String(a.pattern)}`;
    if (tool === 'subagent') {
      if (Array.isArray(a.tasks)) return `${a.tasks.length} parallel subtask${a.tasks.length === 1 ? '' : 's'}`;
      const role = (a.role as string) ?? 'coder';
      const prompt = String(a.prompt ?? '').replace(/\s+/g, ' ').slice(0, 60);
      return `[${role}] ${prompt}${prompt.length === 60 ? '…' : ''}`;
    }
    if (tool === 'bg_task') {
      const action = (a.action as string) ?? 'list';
      const id = (a.task_id as string) ?? '';
      return `${action}${id ? ' ' + id : ''}`;
    }
  }
  const s = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

/** Pick a one-line description of the tool's outcome for the card body. */
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
  // Strip the noisy "exit_code: 0" / JSON wrapper lines that the harness
  // often prepends — show the actual content instead.
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
  return {
    kind: 'success',
    summary: `${tool} completed${out.length === 0 ? ' (no output)' : ''}`,
    durationMs: dur,
  };
}

/** Pad a string to `width` visible cells (ignoring ANSI). */
function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const padLen = Math.max(0, width - visible.length);
  return s + ' '.repeat(padLen);
}

/** Truncate to `max` visible cells with an ellipsis. */
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

export interface ToolCardOptions {
  status?: 'pending' | 'success' | 'error';
  width?: number;
}

/** Build a multi-line boxed card for a single tool invocation. The output
 *  is a single string with embedded `\n` so the existing wrapLine
 *  infrastructure renders each row separately. */
export function renderToolCard(
  rawTool: string,
  rawArgs: unknown,
  outcome?: { kind: 'success' | 'error'; summary: string; durationMs?: number },
  opts: ToolCardOptions = {},
): string {
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  const name = TOOL_NAMES[tool] ?? tool.toUpperCase();
  const color = toolColor(tool);

  let statusIcon = '○';
  let statusColor = T.gray;
  // Resolve effective status: explicit opts.status wins, otherwise infer from
  // the outcome (success → ✓, error → ✗), otherwise stay pending (○).
  const effective = opts.status ?? (outcome ? (outcome.kind === 'success' ? 'success' : 'error') : 'pending');
  if (effective === 'success') {
    statusIcon = '✓';
    statusColor = T.success ?? T.lime ?? T.fg;
  } else if (effective === 'error') {
    statusIcon = '✗';
    statusColor = T.error ?? T.warning ?? '#f87171';
  } else {
    statusIcon = '○';
    statusColor = T.gray;
  }

  const dur = outcome?.durationMs !== undefined ? `${outcome.durationMs}ms` : '';
  const headerRight = dur ? ` ${dur}` : '';

  const width = opts.width ?? 56;
  const inner = width - 4;

  const headerInner = ` ${statusColor}${statusIcon}${T.reset} ${color}${T.bold}${name}${T.reset}${T.grayDark}${headerRight}${T.reset}`;
  const visibleHeader = headerInner.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const headerPad = ' '.repeat(Math.max(0, inner - visibleHeader.length));
  const headerLine = `  ◈  ${statusColor}${statusIcon}${T.reset}  ${color}${T.bold}${name}${T.reset}${T.dim}${headerRight}${T.reset}`;

  const argText = describeToolArgs(rawTool, rawArgs);
  const lines: string[] = [headerLine];

  const argPadded = pad(truncate(argText, inner), inner);
  lines.push(`  ${argPadded}`);

  if (outcome) {
    const marker = outcome.kind === 'error' ? `${T.error}✗${T.reset}` : `${T.success ?? T.lime}→${T.reset}`;
    const summaryText = truncate(outcome.summary, inner - 2);
    const body = ` ${marker} ${summaryText}`;
    const bodyPadded = pad(body, inner);
    lines.push(`  ${marker} ${summaryText}`);
  }

  const bottom = `  ◈${T.dim}${T.grayDark}${'━'.repeat(Math.max(0, width - 6))}${T.reset}`;
  lines.push(bottom);

  return lines.join('\n');
}

/** Convenience: format a tool invocation as a "pending" card. */
export function formatToolInvocationCard(rawTool: string, rawArgs: unknown): string {
  return renderToolCard(rawTool, rawArgs);
}

/** Convenience: format a tool completion as a card with outcome. */
export function formatToolCompletedCard(
  rawTool: string,
  rawArgs: unknown,
  result?: { output?: string; error?: string; durationMs?: number },
): string {
  const outcome = describeToolOutcome(rawTool, result);
  return renderToolCard(rawTool, rawArgs, outcome, { status: outcome.kind });
}

/** "What I did" summary card shown after the agent finishes a turn.
 *  Gives the user a one-glance view of: total time, tool calls made,
 *  files touched, and the first line of the final summary. */
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
  const width = 64;
  const inner = width - 4;
  const ok = s.success;
  const icon = ok ? '✓' : '✗';
  const iconColor = ok ? (T.success ?? T.lime ?? T.fg) : (T.error ?? '#ff5555');
  const label = ok ? 'TURN COMPLETE' : `TURN STOPPED: ${s.stopReason ?? 'aborted'}`;
  const dur = `${Math.round(s.durationMs)}ms`;
  const headerRight = ` ${dur} · ${s.toolCallsTotal} tool${s.toolCallsTotal === 1 ? '' : 's'}`;

  const headerInner = ` ${iconColor}${icon}${T.reset} ${T.bold}${label}${T.reset}${T.grayDark}${headerRight}${T.reset}`;
  const visH = headerInner.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const padH = ' '.repeat(Math.max(0, inner - visH.length));
  const headerLine = `  ◈  ${iconColor}${icon}${T.reset}  ${T.bold}${label}${T.reset}${T.dim}${headerRight}${T.reset}`;

  const lines: string[] = [headerLine];

  // Summary line — first non-empty line of the agent's final answer.
  if (s.summary) {
    const firstLine = s.summary.trim().split('\n').map((l) => l.trim()).find((l) => l) ?? '';
    if (firstLine) {
      const marker = `${iconColor}▸${T.reset}`;
      const text = truncate(firstLine, inner - 2);
      const body = ` ${marker} ${text}`;
      lines.push(`  ${pad(body, inner)}`);
    }
  }

  // Files modified (only show if there are some)
  if (s.filesModified.length > 0) {
    const marker = `${T.cyan}▸${T.reset}`;
    // " files: " prefix is 8 visible cells, plus 1 for the marker space.
    const overhead = 9;
    const budget = inner - overhead;
    // Build the candidate text. Try the natural first-N view first and
    // back off (showing fewer names) if the "+N more" suffix would be
    // chopped by truncation. Always preserve the suffix when present.
    const labels = s.filesModified.map((f) => f.length > 30 ? '…' + f.slice(-29) : f);
    const total = labels.length;
    let shown = labels.slice(0, 4);
    let remaining = total - shown.length;
    let text = shown.join(', ');
    if (remaining > 0) text += ` (+${remaining} more)`;
    // If too long, drop one file at a time until it fits.
    while (text.length > budget && shown.length > 1) {
      shown = shown.slice(0, -1);
      remaining = total - shown.length;
      text = shown.join(', ');
      if (remaining > 0) text += ` (+${remaining} more)`;
    }
    text = truncate(text, budget);
    const body = ` ${marker} files: ${text}`;
    lines.push(`  ${pad(body, inner)}`);
  }

  // Tokens used (only if reported)
  if (s.tokensUsed !== undefined && s.tokensUsed > 0) {
    const marker = `${T.magenta ?? T.fg}▸${T.reset}`;
    const text = `${s.tokensUsed.toLocaleString()} tokens`;
    const body = ` ${marker} ${text}`;
    lines.push(`  ${pad(body, inner)}`);
  }

  // Clean bottom separator — diamond + muted rule, no ugly box border
  lines.push(`  ${T.dim}${T.grayDark}◈${T.reset}  ${T.dim}${T.grayDark}${'━'.repeat(Math.max(0, width - 6))}${T.reset}`);

  return lines.join('\n');
}
