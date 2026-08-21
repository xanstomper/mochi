// Pure TUI state + event reducer, extracted from app.ts so the transcript and
// task-tree logic is unit-testable without a terminal. The TUI feeds every
// MochiEvent through reduceEvent and re-renders. Keeping this free of I/O is
// what lets tests drive a full agent run and assert the rendered state.

export type LineKind = 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'task' | 'goal' | 'plain';

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
  if (s.length > 200) s = s.slice(0, 200) + '...';
  return s;
}

export function pushLine(state: TuiState, kind: LineKind, text: string): void {
  // Collapse duplicate tool lines into their changing args (live tools update
  // in place instead of stacking one line per call).
  if (kind === 'tool' && state.lines.length && state.lines[state.lines.length - 1].kind === 'tool') {
    const prev = state.lines[state.lines.length - 1];
    if (prev.text.startsWith(text.slice(0, 8))) {
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
      pushLine(state, 'tool', `${state.currentTool}(${truncateArgs(event.args)})`);
      return true;
    }
    case 'tool:completed':
      state.currentTool = '';
      return true;
    case 'tool:failed':
      pushLine(state, 'error', `${event.tool}: ${String(event.error).slice(0, 400)}`);
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
      if (event.reason) pushLine(state, 'error', `✗ ${t.title}: ${String(event.reason ?? '').slice(0, 400)}`);
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