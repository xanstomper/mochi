import { TOOL_ALIASES, normalizeToolArgs } from '../tools/index.js';
import { formatToolInvocationCard, formatToolCompletedCard, renderTurnSummaryCard } from './cards.js';

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

export interface ActiveSubagentInfo {
  id: string;
  role: string;
  prompt: string;
  startedAt: number;
}

export interface TuiState {
  lines: TuiLine[];
  tasks: Map<string, TuiTask>;
  activeSubagents: Map<string, ActiveSubagentInfo>;
  /** Args of in-flight tool calls, keyed by tool_call_id (or tool name as
   *  fallback). Stored at tool:called time so the matching tool:completed
   *  can render a complete card showing both the call and the result. */
  activeToolArgs: Map<string, unknown>;
  /** ABSOLUTE line id of each in-flight tool card, keyed by tool_call_id.
   *  Absolute = (index at push time + trimmed-so-far), so the id stays valid
   *  even after head trims shift array indices. Used to replace the matching
   *  pending card on tool:completed instead of stomping whatever is last
   *  (which broke parallel/interleaved tool execution). */
  activeToolLine: Map<string, number>;
  currentTask: string;
  currentTool: string;
  chatVer: number;
  /** Total lines ever dropped from the head by limit trims. Wrap caches and
   *  absolute card ids need this to realign across splices. */
  trimmed: number;
  /** Dedupe signature of the most recent tool:called (dual-emitter guard). */
  lastToolCallSig?: { sig: string; at: number };
  /** Max transcript lines; oldest are dropped. */
  limit: number;
  tokenVelocity?: number;
  lastUsageAt?: number;
  lastTokens?: number;
}

/**
 * Soft cap on a single streaming line. Assistant text and reasoning/thinking
 * are each appended token-by-token into ONE line, and every render re-wraps
 * that actively-streaming line (see transcriptLines). Leaving it unbounded
 * makes per-frame wrap cost grow linearly with the line, and since it grows
 * every frame, total work is quadratic — a real freeze under long streaming
 * reasoning. Rolling past-gap content into a fresh line keeps wrap cost
 * bounded while still rendering continuously.
 */
export const STREAM_LINE_CAP = 16_000;

export function createTuiState(limit = 500): TuiState {
  return {
    lines: [],
    tasks: new Map(),
    activeSubagents: new Map(),
    activeToolArgs: new Map(),
    activeToolLine: new Map(),
    currentTask: '',
    currentTool: '',
    chatVer: 0,
    trimmed: 0,
    limit,
  };
}

/** Drop oldest lines past the limit, tracking how many were removed so wrap
 *  caches and absolute card ids can realign across index-shifting splices. */
export function trimTranscript(state: TuiState): void {
  if (state.lines.length <= state.limit) return;
  const removed = state.lines.length - state.limit;
  state.lines.splice(0, removed);
  state.trimmed += removed;
}

/** Convert a current array index to its stable absolute id (trim-immune). */
export function toAbsLine(state: TuiState, idx: number): number {
  return idx + state.trimmed;
}

/** Convert an absolute id back to the current index, or undefined if that
 *  line was trimmed away since the id was minted. */
export function toRelLine(state: TuiState, abs: number): number | undefined {
  const idx = abs - state.trimmed;
  return idx >= 0 && idx < state.lines.length ? idx : undefined;
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
  // Collapse consecutive tool cards of the SAME tool family while streaming
  // (live tools update in place instead of stacking one line per call).
  // Card text is ANSI-wrapped, so identity comes from the tool WORD somewhere
  // in the line, never from raw prefixes. The old `prev.text.includes(':')`
  // test matched virtually every formatted card (headers all contain ':'),
  // silently swallowing a second unrelated call's pending card.
  if (kind === 'tool' && state.lines.length && state.lines[state.lines.length - 1].kind === 'tool') {
    const prev = state.lines[state.lines.length - 1];
    const prevFamily = toolFamily(prev.text);
    if (prevFamily !== '' && prevFamily === toolFamily(text)) {
      prev.text = text;
      return;
    }
  }
  state.lines.push({ kind, text });
  trimTranscript(state);
}

/** Which tool a formatted card/line refers to ("shell", "edit", ...), or ''
 *  when no recognizable tool word is present (never collapses unknowns). */
const TOOL_WORD_RE = /\b(shell|edit|write|read|delete|patch|search|glob|git|inspect|memory|fetch|web_search|bg_task|subagent)\b/i;
export function toolFamily(text: string): string {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const m = plain.match(TOOL_WORD_RE);
  return m ? m[1].toLowerCase() : '';
}

/** Stable signature of a tool-call payload for duplicate detection. */
function safeArgsSig(args: unknown): string {
  try {
    return JSON.stringify(args ?? null);
  } catch {
    return String(args);
  }
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
      if (last && last.kind === 'assistant') {
        // Streaming line-overflow guard: a huge single assistant response is
        // one logical text but would become one gigantic string that every
        // frame fully re-wraps (the freeze/"bottles up" during long outputs).
        // Roll it into a fresh line once it passes a soft cap so wrap cost
        // stays bounded while still rendering continuously.
        if (last.text.length > STREAM_LINE_CAP) pushLine(state, 'assistant', content);
        else last.text += content;
      } else {
        pushLine(state, 'assistant', content);
      }
      state.chatVer++;
      return true;
    }
    case 'tool:called': {
      state.currentTool = String(event.tool ?? '');
      const key = String(event.tool_call_id ?? event.callId ?? event.tool ?? '');
      // Duplicate-call guard: some flows emit tool:called from BOTH the agent
      // loop and the tool executor (same id/args milliseconds apart). Without
      // this, the TUI stacked TWO pending cards per call — the visible half
      // of the "deduping" bug. A repeat with identical key+args while the
      // first card is still pending updates that card in place instead.
      if (state.lastToolCallSig) {
        const sig = key + '\u0000' + safeArgsSig(event.args);
        if (sig === state.lastToolCallSig.sig && Date.now() - state.lastToolCallSig.at < 1500) {
          return false;
        }
        state.lastToolCallSig = { sig, at: Date.now() };
      } else {
        state.lastToolCallSig = { sig: key + '\u0000' + safeArgsSig(event.args), at: Date.now() };
      }
      state.activeToolArgs.set(key, event.args);
      const cardText = formatToolInvocationCard(state.currentTool, event.args);
      // Track the line index so the matching tool:completed can replace
      // THIS card (not "the last tool line") when several tool calls are
      // in flight concurrently. Without this, parallel tools stomp on
      // each other: t1 calls push, t2 calls push, t1 completes and
      // overwrites t2's pending card with t1's outcome.
      const idx = state.lines.length;
      state.activeToolLine.set(key, toAbsLine(state, idx));
      state.lines.push({ kind: 'tool', text: cardText });
      trimTranscript(state);
      state.chatVer++;
      return true;
    }
    case 'tool:completed': {
      state.currentTool = '';
      // Pull the args back out so the card can show path / command / etc.
      // alongside the outcome line.
      const callId = String((event.result as any)?.toolCallId ?? '');
      const fallbackKey = String(event.tool ?? '');
      const lookupKey = (callId && state.activeToolLine.has(callId)) ? callId : fallbackKey;
      // Even if we don't have the args, the completed card uses the tool
      // name to fall back to a minimal args row (path/command empty).
      const args =
        (callId && state.activeToolArgs.get(callId)) ??
        state.activeToolArgs.get(fallbackKey);
      const formatted = formatToolCompletedCard(
        String(event.tool ?? ''),
        args,
        event.result as any,
      );
      // Capture the pending card's ABSOLUTE line id BEFORE cleaning up the
      // maps. The old code deleted the key first and only then read it back,
      // so indexed replacement was dead code and every completion fell
      // through to stomp-or-append on whatever card happened to be last —
      // interleaved calls got each other's outcomes (the "deduped/duplicated
      // tool cards" bug).
      const pendingAbs = state.activeToolLine.get(lookupKey);
      if (callId) {
        state.activeToolArgs.delete(callId);
        state.activeToolLine.delete(callId);
      }
      if (state.activeToolLine.has(fallbackKey)) state.activeToolLine.delete(fallbackKey);
      // Replace the matching pending card by absolute id; otherwise append.
      const rel = pendingAbs !== undefined ? toRelLine(state, pendingAbs) : undefined;
      if (rel !== undefined && state.lines[rel]?.kind === 'tool') {
        state.lines[rel].text = formatted;
      } else {
        // Promote: the matching tool:called may have been trimmed from the
        // head of the buffer (limit reached) or never recorded because the
        // event arrived before its call. Either way just append.
        const last = state.lines[state.lines.length - 1];
        if (last && last.kind === 'tool') {
          last.text = formatted;
        } else {
          pushLine(state, 'tool', formatted);
        }
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
        // Reasoning streams token-by-token into one 'thought' line. Without a
        // cap (unlike assistant text above) it grew unboundedly, and since
        // every render re-wraps the actively-streaming line this made per-frame
        // work grow each frame — quadratic, a hard freeze during long
        // reasoning. Roll past-cap content into a fresh line so re-wrap cost
        // stays bounded (visually identical: thoughts flow continuously).
        if (last.text.length > STREAM_LINE_CAP) pushLine(state, 'thought', content);
        else last.text += content;
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
      const subId = String(event.agentId ?? event.id ?? Math.random().toString());
      const role = String(event.role ?? 'subagent');
      const prompt = String(event.prompt ?? '').slice(0, 80);
      state.activeSubagents.set(subId, { id: subId, role, prompt, startedAt: Date.now() });
      pushLine(state, 'system', `◇ subagent  [${role}] ${prompt}`);
      return true;
    }
    case 'subagent:completed': {
      const subId = String(event.agentId ?? event.id ?? '');
      if (subId) state.activeSubagents.delete(subId);
      const role = String(event.role ?? 'subagent');
      const status = event.success ? 'succeeded' : 'failed';
      const summary = String(event.summary ?? '').slice(0, 100);
      pushLine(state, event.success ? 'system' : 'error', `${event.success ? '✓' : '×'} subagent  ${role}: ${summary}`);
      return true;
    }
    case 'usage:updated': {
      const now = Date.now();
      const currentTotal = Number(event.totalTokens ?? 0);
      if (state.lastUsageAt && state.lastTokens && now > state.lastUsageAt) {
        const elapsedSec = (now - state.lastUsageAt) / 1000;
        const diff = currentTotal - state.lastTokens;
        if (diff > 0 && elapsedSec > 0.1) {
          state.tokenVelocity = Math.round(diff / elapsedSec);
        }
      }
      state.lastUsageAt = now;
      state.lastTokens = currentTotal;
      return false;
    }
    case 'file:changed': {
      const opGlyph: Record<string, string> = { create: '+', write: '+', edit: '~', patch: '~', delete: '−', read: '←', move: '→', rename: '→' };
      const glyph = opGlyph[String(event.operation ?? '')] ?? '•';
      pushLine(state, 'system', `${glyph} ${event.operation}  ${event.path}`);
      return true;
    }
    case 'error':
      pushLine(state, 'error', String(event.error ?? ''));
      return true;
    case 'summary:rendered': {
      // Render the post-turn "what I did" summary as a Cline-style card.
      // Skip when the turn was a no-op (zero tool calls) — a summary card
      // for "the model said hi" is noise.
      const files = Array.isArray(event.filesModified) ? (event.filesModified as unknown[]).map((f) => String(f)) : [];
      const tcTotal = Number(event.toolCallsTotal ?? 0);
      if (tcTotal === 0 && files.length === 0) return false;
      const summary = renderTurnSummaryCard({
        success: Boolean(event.success),
        stopReason: String(event.stopReason ?? ''),
        durationMs: Number(event.durationMs ?? 0),
        toolCallsTotal: tcTotal,
        tokensUsed: event.tokensUsed !== undefined ? Number(event.tokensUsed) : undefined,
        filesModified: files,
        summary: String(event.summary ?? ''),
      });
      pushLine(state, 'tool', summary);
      return true;
    }
    default:
      return false;
  }
}