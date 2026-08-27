import { describe, expect, it } from 'vitest';
import { createTuiState, reduceEvent, pushLine, truncateArgs } from './state.js';
import { STREAM_LINE_CAP } from './state.js';

function ev(partial: Record<string, unknown>): Record<string, unknown> { return partial; }

describe('reduceEvent', () => {
  it('builds an assistant transcript from message + chunks', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'message', role: 'user', content: 'nice' }));
    reduceEvent(s, ev({ type: 'message:chunk', content: 'Hello ' }));
    reduceEvent(s, ev({ type: 'message:chunk', content: 'world' }));
    expect(s.lines.map((l) => l.text).join('|')).toContain('Hello world');
    expect(s.chatVer).toBe(2);
  });

  it('rolls a huge streamed assistant line into a fresh line to bound wrap cost', () => {
    const s = createTuiState();
    // Seed a base assistant line, then push chunks past the 16k streaming cap.
    reduceEvent(s, ev({ type: 'message', role: 'assistant', content: 'start' }));
    // ~11 chars per chunk; need to cross the 16k cap, so push plenty.
    for (let i = 0; i < 2000; i++) {
      const chunk = `chunk${i.toString().padStart(5, '0')} `;
      reduceEvent(s, ev({ type: 'message:chunk', content: chunk }));
    }
    const assistantLines = s.lines.filter((l) => l.kind === 'assistant');
    expect(assistantLines.length).toBeGreaterThanOrEqual(2);
    const longest = Math.max(...assistantLines.map((l) => l.text.length));
    expect(longest).toBeLessThanOrEqual(STREAM_LINE_CAP + 500);
  });

  it('rolls a huge streamed reasoning/thought line into fresh lines to keep re-wrap cost bounded (freeze fix)', () => {
    const s = createTuiState();
    // Reasoning streams token-by-token into a single 'thought' line; without
    // a cap it grew unboundedly and every render re-wrapped it — quadratic
    // work and a hard freeze under long reasoning. Verify rollover happens.
    reduceEvent(s, ev({ type: 'agent:reasoning', content: 'prethink:' }));
    const chunk = 'reasoning token reasoning token ';
    for (let i = 0; i < 2000; i++) reduceEvent(s, ev({ type: 'agent:reasoning', content: chunk }));
    const thoughtLines = s.lines.filter((l) => l.kind === 'thought');
    // Multiple thought lines => rollover fired; none may be unbounded.
    expect(thoughtLines.length).toBeGreaterThanOrEqual(2);
    const longest = Math.max(...thoughtLines.map((l) => l.text.length));
    expect(longest).toBeLessThanOrEqual(STREAM_LINE_CAP + 500);
    // Content still flows across the rolled lines (nothing dropped by the cap).
    const joined = thoughtLines.map((l) => l.text).join('');
    expect(joined).toContain('prethink:');
    expect(joined.length).toBeGreaterThan(STREAM_LINE_CAP);
  });

  it('tracks tasks through created -> started -> completed with stopReason', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'task:created', task: { id: 't1', title: 'Fix', role: 'coder', status: 'pending' } }));
    expect(s.tasks.get('t1')?.status).toBe('pending');
    reduceEvent(s, ev({ type: 'task:started', task: { id: 't1', title: 'Fix' } }));
    expect(s.tasks.get('t1')?.status).toBe('running');
    reduceEvent(s, ev({ type: 'task:completed', task: { id: 't1', title: 'Fix' }, stopReason: 'completed' }));
    const done = s.tasks.get('t1');
    expect(done?.status).toBe('done');
    expect(done?.stopReason).toBe('completed');
  });

  it('records failures with stopReason and error lines', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'task:failed', task: { id: 't2', title: 'Break' }, reason: 'verify failed', stopReason: 'verification_failed' }));
    expect(s.tasks.get('t2')?.status).toBe('failed');
    expect(s.tasks.get('t2')?.stopReason).toBe('verification_failed');
    expect(s.lines.some((l) => l.kind === 'error' && l.text.includes('Break'))).toBe(true);
  });

  it('renders tool calls as boxed cards and truncates huge args inside them', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'tool:called', tool: 'shell', args: { command: 'x'.repeat(500) } }));
    const last = s.lines[s.lines.length - 1];
    expect(last.kind).toBe('tool');
    // Card is multi-line: header, body, footer. Even with a 500-char
    // command the body line must be visibly truncated so it never wraps
    // and breaks the grid alignment.
    const lines = last.text.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const bodyLine = lines[1] ?? '';
    // The visible cells of the body line (ignoring ANSI) must fit inside
    // the card's interior width — ~50 chars.
    const visible = bodyLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    expect(visible.length).toBeLessThanOrEqual(64);
    expect(visible).toContain('…'); // ellipsis marks truncation
    expect(truncateArgs('short')).toBe('short');
  });

  it('renders tool completions as cards with outcome line', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'tool:called', tool: 'edit', tool_call_id: 'c1', args: { path: 'src/foo.ts', oldText: 'a', newText: 'b' } }));
    reduceEvent(s, ev({
      type: 'tool:completed',
      tool: 'edit',
      result: { toolCallId: 'c1', name: 'edit', output: 'updated src/foo.ts', durationMs: 42 },
    }));
    const last = s.lines[s.lines.length - 1];
    expect(last.kind).toBe('tool');
    expect(last.text).toContain('EDIT');
    expect(last.text).toContain('src/foo.ts');
    expect(last.text).toContain('42ms');
    expect(last.text).toContain('updated src/foo.ts');
  });

  it('tracks subagent lifecycle events and active map', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'subagent:started', agentId: 'sub-1', role: 'architect', prompt: 'Design database schema' }));
    expect(s.lines.some((l) => l.kind === 'system' && l.text.includes('┌── [Subagent: architect] started'))).toBe(true);
    expect(s.activeSubagents.has('sub-1')).toBe(true);
    expect(s.activeSubagents.get('sub-1')?.role).toBe('architect');

    reduceEvent(s, ev({ type: 'subagent:completed', agentId: 'sub-1', role: 'architect', success: true, summary: 'Schema design complete' }));
    expect(s.lines.some((l) => l.kind === 'system' && l.text.includes('└── [Subagent: architect] succeeded'))).toBe(true);
    expect(s.activeSubagents.has('sub-1')).toBe(false);

    reduceEvent(s, ev({ type: 'subagent:completed', agentId: 'sub-2', role: 'tester', success: false, summary: 'Tests failed' }));
    expect(s.lines.some((l) => l.kind === 'error' && l.text.includes('└── [Subagent: tester] failed'))).toBe(true);
  });

  it('caps the transcript at the configured limit, dropping oldest', () => {
    const s = createTuiState(3);
    for (let i = 0; i < 10; i++) pushLine(s, 'system', `line${i}`);
    expect(s.lines.length).toBe(3);
    expect(s.lines[0].text).toBe('line7');
    expect(s.lines[2].text).toBe('line9');
  });
});