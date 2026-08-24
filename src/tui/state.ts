import { TOOL_ALIASES, normalizeToolArgs } from '../tools/index.js';

export type LineKind = 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'task' | 'goal' | 'plain' | 'thought';

export interface TuiLine {
  kind: LineKind;
  text: string;
}

export interface TuiTask {
  id: string;
  title: string;
  role: string;
  status: string;
  stopReason?: string;
}

export interface TuiState {
  lines: TuiLine[];
  tasks: Map<string, TuiTask>;
  currentTask: string;
  currentTool: string;
  chatVer: number;
  /** Max transcript lines; oldest are dropped. */
  limit: number;
}

export function createTuiState(limit = 500): TuiState {
  return { lines: [], tasks: new Map(), currentTask: '', currentTool: '', chatVer: 0, limit };
}

/** Truncate long args for display without losing the tool identity. */
export function truncateArgs(args: unknown): string {
  let s = typeof args === 'string' ? args : JSON.stringify(args);
  if (s.length > 120) s = s.slice(0, 120) + '...';
  return s;
}

export function formatToolInvocation(rawTool: string, rawArgs: unknown): string {
  const tool = TOOL_ALIASES[rawTool] || rawTool;
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    const a = normalizeToolArgs(tool, rawArgs as Record<string, unknown>);
    if (a.path) {
      if (a.oldText && a.newText) return `edit: ${a.path}`;
      if (a.content !== undefined) return `write: ${a.path}`;
      return `${tool}: ${a.path}`;
    }
    if (a.command) return `shell: ${truncateArgs(a.command)}`;
    if (a.query) return `search: "${truncateArgs(a.query)}"`;
    if (a.pattern) return `glob: "${truncateArgs(a.pattern)}"`;
    if (tool === 'subagent') {
      if (a.tasks) return `subagents: ${Array.isArray(a.tasks) ? a.tasks.length : 1} parallel tasks`;
      if (a.prompt) return `subagent (${a.role ?? 'coder'}): "${truncateArgs(a.prompt)}"`;
    }
    if (tool === 'bg_task') {
      return `bg_task: ${a.action ?? 'list'} ${a.task_id ?? ''}`.trim();
    }
  }
  return `${rawTool}: (${truncateArgs(rawArgs)})`;
}

export function formatToolCompleted(tool: string, result?: { output?: string; error?: string; durationMs?: number }): string {
  const dur = result?.durationMs ? ` (${Math.round(result.durationMs)}ms)` : '';
  if (result?.error) {
    return `[ERR] ${tool} failed: ${String(result.error).slice(0, 120)}${dur}`;
  }
  const out = (result?.output ?? '').trim();
  const firstLine = out.split('\n')[0] ?? '';
  if (firstLine.length > 0 && firstLine.length < 90 && !firstLine.includes('exit_code:') && !firstLine.startsWith('{')) {
    return `[OK] ${firstLine}${dur}`;
  }
  return `[OK] ${tool} completed${dur}`;
}

export function pushLine(state: TuiState, kind: LineKind, text: string): void {
  // Collapse duplicate tool lines into their changing args (live tools update
  // in place instead of stacking one line per call).
  if (kind === 'tool' && state.lines.length && state.lines[state.lines.length - 1].kind === 'tool') {
    const prev = state.lines[state.lines.length - 1];
    if (prev.text.includes(':') || prev.text.startsWith(text.slice(0, 8))) {
      prev.text = text;
      return;
    }
  }
  state.lines.push({ kind, text });
  if (state.lines.length > state.limit) state.lines.splice(0, state.lines.length - state.limit);
}

/** Apply one runtime event to the TUI state. Returns true when a re-render
 *  is warranted (any event that changes visible state). */
export function reduceEvent(state: TuiState, event: Record<string, unknown>): boolean {
  const type = String(event.type);
  switch (type) {
    case 'message': {
      const role = String(event.role);
      const content = event.content as string | undefined;
      if (!content) return false;
      const last = state.lines[state.lines.length - 1];
      if (last && last.kind === role && (last.text === content || last.text.endsWith(content))) {
        return false;
      }
      if (role === 'assistant') pushLine(state, 'assistant', content);
      else if (role === 'system') pushLine(state, 'system', content);
      return true;
    }
    case 'message:chunk': {
      const content = event.content as string | undefined;
      if (!content) return false;
      const last = state.lines[state.lines.length - 1];
      if (last && last.kind === 'assistant') last.text += content;
      else pushLine(state, 'assistant', content);
      state.chatVer++;
      return true;
    }
    case 'tool:called': {
      state.currentTool = String(event.tool ?? '');
      pushLine(state, 'tool', formatToolInvocation(state.currentTool, event.args));
      return true;
    }
    case 'tool:completed': {
      state.currentTool = '';
      const formatted = formatToolCompleted(String(event.tool ?? ''), event.result as any);
      const last = state.lines[state.lines.length - 1];
      if (last && last.kind === 'tool') {
        last.text = formatted;
      } else {
        pushLine(state, 'tool', formatted);
      }
      return true;
    }
    case 'tool:failed':
      state.currentTool = '';
      pushLine(state, 'error', `[ERR] ${event.tool} failed: ${String(event.error).slice(0, 400)}`);
      return true;
    case 'goal:created': {
      const objective = (event.goal as { objective?: string } | undefined)?.objective;
      if (objective) pushLine(state, 'goal', objective);
      return Boolean(objective);
    }
    case 'task:created': {
      const t = event.task as Partial<TuiTask> & { id?: string; title?: string; role?: string; status?: string };
      if (t.id) state.tasks.set(t.id, { id: t.id, title: t.title ?? '', role: t.role ?? 'coder', status: t.status ?? 'pending' });
      return true;
    }
    case 'task:started': {
      const t = event.task as Partial<TuiTask> & { id?: string; title?: string; role?: string };
      state.currentTask = t.title ?? '';
      if (t.id) {
        const prev = state.tasks.get(t.id);
        state.tasks.set(t.id, { id: t.id, title: t.title ?? '', role: t.role ?? prev?.role ?? 'coder', status: 'running' });
      }
      return true;
    }
    case 'task:completed': {
      const t = event.task as Partial<TuiTask> & { id?: string; title?: string; output?: string };
      if (state.currentTask === t.title) state.currentTask = '';
      if (t.id) {
        const prev = state.tasks.get(t.id);
        state.tasks.set(t.id, {
          id: t.id, title: t.title ?? prev?.title ?? '', role: prev?.role ?? 'coder', status: 'done',
          stopReason: event.stopReason as string | undefined,
        });
      }
      return true;
    }
    case 'agent:reasoning': {
      const content = event.content as string | undefined;
      if (!content) return false;
      const last = state.lines[state.lines.length - 1];
      if (last && last.kind === 'thought') {
        last.text += content;
      } else {
        pushLine(state, 'thought', content);
      }
      state.chatVer++;
      return true;
    }
    case 'task:failed': {
      const t = event.task as Partial<TuiTask> & { id?: string; title?: string };
      if (state.currentTask === t.title) state.currentTask = '';
      if (t.id) {
        const prev = state.tasks.get(t.id);
        state.tasks.set(t.id, {
          id: t.id, title: t.title ?? prev?.title ?? '', role: prev?.role ?? 'coder', status: 'failed',
          stopReason: event.stopReason as string | undefined,
        });
      }
      if (event.reason) pushLine(state, 'error', `[ERR] ${t.title}: ${String(event.reason ?? '').slice(0, 400)}`);
      return true;
    }
    case 'subagent:started': {
      const role = String(event.role ?? 'subagent');
      const prompt = String(event.prompt ?? '').slice(0, 80);
      pushLine(state, 'system', `[Subagent] ${role} started: "${prompt}"`);
      return true;
    }
    case 'subagent:completed': {
      const role = String(event.role ?? 'subagent');
      const status = event.success ? 'succeeded' : 'failed';
      const summary = String(event.summary ?? '').slice(0, 100);
      pushLine(state, event.success ? 'system' : 'error', `[Subagent] ${role} ${status}: ${summary}`);
      return true;
    }
    case 'file:changed':
      pushLine(state, 'system', `${event.operation} ${event.path}`);
      return true;
    case 'error':
      pushLine(state, 'error', String(event.error ?? ''));
      return true;
    default:
      return false;
  }
}