import { describe, expect, it } from 'vitest';
import { createTuiState, reduceEvent, pushLine, truncateArgs, toolFamily } from './state.js';
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

  it('does not duplicate streaming text when the same tail is re-delivered (the spam fix)', () => {
    // Free-tier models occasionally re-send their last ~200 chars after a
    // long tool sequence. The old endsWith() dedup matched even for
    // distinct repeated lines that happened to share a tail, which is what
    // produced the visible "spamming the same line" bug. The new dedup
    // is strict: only an EXACT-match or full-buffer-restart is treated as
    // a re-delivery; a true duplicate is filtered, a continuation still
    // appends.
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'message', role: 'assistant', content: 'Hi' }));
    reduceEvent(s, ev({ type: 'message:chunk', content: ' there' })); // "Hi there"
    // Re-deliver exact same tail — should NOT append a second time.
    const before = s.lines[s.lines.length - 1].text;
    reduceEvent(s, ev({ type: 'message:chunk', content: ' there' }));
    const after = s.lines[s.lines.length - 1].text;
    expect(after).toBe(before);
    // Provider restarts the buffer: chunk equals accumulated text → replace.
    reduceEvent(s, ev({ type: 'message:chunk', content: 'Hi there' }));
    expect(s.lines[s.lines.length - 1].text).toBe('Hi there');
    // Normal continuation still appends.
    reduceEvent(s, ev({ type: 'message:chunk', content: ', world' }));
    expect(s.lines[s.lines.length - 1].text).toBe('Hi there, world');
  });

  it('filters redundant message events that just repeat the assistant line tail', () => {
    // A common pattern: same `message` event fired at the start of a
    // stream AND at the end as a flush. The old endsWith() check matched
    // both the legitimate 1-char progress and the eventual identical
    // full-line re-emit. The new dedup uses a small-suffix window so
    // tiny in-flight progress still flows but full re-emits are dropped.
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'message', role: 'assistant', content: 'hello world' }));
    // Tail of length 8 already in last line — filtered.
    reduceEvent(s, ev({ type: 'message', role: 'assistant', content: 'lo world' }));
    // Distinct text — still appended (no false dedup).
    reduceEvent(s, ev({ type: 'message', role: 'assistant', content: 'next turn' }));
    const texts = s.lines.filter((l) => l.kind === 'assistant').map((l) => l.text);
    expect(texts).toEqual(['hello world', 'next turn']);
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

  it('renders tool calls as compact semantic rows and truncates huge args', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'tool:called', tool: 'shell', args: { command: 'x'.repeat(500) } }));
    const last = s.lines[s.lines.length - 1];
    expect(last.kind).toBe('tool');
    // Compact row: even with a 500-char command the row must be visibly
    // truncated so it never wraps and breaks the grid alignment.
    const lines = last.text.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const visible = lines.map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/…/g, 'x'));
    for (const v of visible) expect(v.length).toBeLessThanOrEqual(104);
    expect(lines.join('\n')).toContain('…'); // ellipsis marks truncation
    expect(truncateArgs('short')).toBe('short');
  });

  it('renders tool completions as compact rows with outcome line', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'tool:called', tool: 'edit', tool_call_id: 'c1', args: { path: 'src/foo.ts', oldText: 'a', newText: 'b' } }));
    reduceEvent(s, ev({
      type: 'tool:completed',
      tool: 'edit',
      result: { toolCallId: 'c1', name: 'edit', output: 'updated src/foo.ts', durationMs: 42 },
    }));
    const last = s.lines[s.lines.length - 1];
    expect(last.kind).toBe('tool');
    expect(last.text).toContain('edit');
    expect(last.text).toContain('src/foo.ts');
    expect(last.text).toContain('42ms');
    expect(last.text).toContain('1 change'); // inline diff outcome line
  });

  it('tracks subagent lifecycle events and active map', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'subagent:started', agentId: 'sub-1', role: 'architect', prompt: 'Design database schema' }));
    expect(s.lines.some((l) => l.kind === 'system' && l.text.includes('◇ subagent') && l.text.includes('[architect]'))).toBe(true);
    expect(s.activeSubagents.has('sub-1')).toBe(true);
    expect(s.activeSubagents.get('sub-1')?.role).toBe('architect');

    reduceEvent(s, ev({ type: 'subagent:completed', agentId: 'sub-1', role: 'architect', success: true, summary: 'Schema design complete' }));
    expect(s.lines.some((l) => l.kind === 'system' && l.text.includes('✓ subagent') && l.text.includes('Schema design complete'))).toBe(true);
    expect(s.activeSubagents.has('sub-1')).toBe(false);

    reduceEvent(s, ev({ type: 'subagent:completed', agentId: 'sub-2', role: 'tester', success: false, summary: 'Tests failed' }));
    expect(s.lines.some((l) => l.kind === 'error' && l.text.includes('× subagent') && l.text.includes('Tests failed'))).toBe(true);
  });

  it('caps the transcript at the configured limit, dropping oldest', () => {
    const s = createTuiState(3);
    for (let i = 0; i < 10; i++) pushLine(s, 'system', `line${i}`);
    expect(s.lines.length).toBe(3);
    expect(s.lines[0].text).toBe('line7');
    expect(s.lines[2].text).toBe('line9');
  });
});
describe('tool card routing (freeze/dedupe fix regressions)', () => {
  it('replaces the NON-last pending card when an interleaved call completes first', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'tool:called', tool: 'shell', tool_call_id: 'c1', args: { command: 'sleep 5' } }));
    reduceEvent(s, ev({ type: 'message', role: 'system', content: 'noise between calls' }));
    reduceEvent(s, ev({ type: 'tool:called', tool: 'edit', tool_call_id: 'c2', args: { path: 'a.ts' } }));
    // c1 finishes while c2 (the LAST card) is still pending:
    reduceEvent(s, ev({ type: 'tool:completed', tool: 'shell', result: { toolCallId: 'c1', name: 'shell', output: 'done-1', durationMs: 1 } }));
    const shellCard = s.lines.find((l) => l.kind === 'tool' && l.text.includes('done-1'));
    expect(shellCard).toBeDefined(); // landed on ITS OWN line...
    const last = s.lines[s.lines.length - 1];
    expect(last.kind).toBe('tool');
    expect(last.text).not.toContain('done-1'); // ...and did NOT stomp c2's pending card
    // Then c2 completes and lands on its own surviving card too.
    reduceEvent(s, ev({ type: 'tool:completed', tool: 'edit', result: { toolCallId: 'c2', name: 'edit', output: 'patched a.ts', durationMs: 2 } }));
    expect(s.lines.some((l) => l.kind === 'tool' && l.text.includes('patched a.ts'))).toBe(true);
  });

  it('keeps card ids valid across limit trims (absolute ids)', () => {
    const s = createTuiState(4);
    reduceEvent(s, ev({ type: 'tool:called', tool: 'shell', tool_call_id: 'old', args: { command: 'x' } }));
    // Push enough lines to trim the old card out of the window entirely.
    for (let i = 0; i < 10; i++) pushLine(s, 'system', `filler-${i}`);
    reduceEvent(s, ev({ type: 'tool:completed', tool: 'shell', result: { toolCallId: 'old', name: 'shell', output: 'late result', durationMs: 3 } }));
    // Trimmed-away card must not silently rewrite some unrelated row; the
    // outcome still surfaces via the append/promote path.
    expect(s.lines.some((l) => l.kind === 'tool' && l.text.includes('late result'))).toBe(true);
    expect(s.trimmed).toBeGreaterThan(0);
  });

  it('does not swallow an unrelated consecutive tool card under pushLine collapse', () => {
    const s = createTuiState();
    pushLine(s, 'tool', '┌ shell — echo one');
    pushLine(s, 'tool', '┌ edit — src/a.ts'); // different family: must stay its own line
    const families = new Set(s.lines.filter((l) => l.kind === 'tool').map((l) => toolFamily(l.text)));
    expect(families.size).toBe(2);
    // Same family still collapses (live update behavior preserved):
    pushLine(s, 'tool', '┌ edit — src/b.ts');
    const editLines = s.lines.filter((l) => l.kind === 'tool' && l.text.includes('edit')).length;
    expect(editLines).toBe(1);
  });

  it('tracks trimmed totals for cache realignment', () => {
    const s = createTuiState(3);
    expect(s.trimmed).toBe(0);
    for (let i = 0; i < 7; i++) pushLine(s, 'system', `line${i}`);
    expect(s.lines.length).toBe(3);
    expect(s.trimmed).toBe(4);
  });
});

describe('duplicate tool:called guard (dual-emitter dedupe)', () => {
  it('collapses a back-to-back re-emit of the same call into ONE pending card', () => {
    const s = createTuiState();
    const call = { type: 'tool:called', tool: 'read', tool_call_id: 'c9', args: { path: 'a.ts' } };
    reduceEvent(s, ev(call));
    reduceEvent(s, ev(call)); // loop + executor double-fire
    const cards = s.lines.filter((l) => l.kind === 'tool');
    expect(cards.length).toBe(1);
  });

  it('still shows DISTINCT calls as separate cards', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'tool:called', tool: 'read', tool_call_id: 'x1', args: { path: 'a.ts' } }));
    reduceEvent(s, ev({ type: 'tool:called', tool: 'read', tool_call_id: 'x2', args: { path: 'b.ts' } }));
    expect(s.lines.filter((l) => l.kind === 'tool').length).toBe(2);
  });

  it('renders rich structured summary when doc is present in summary:rendered', () => {
    const s = createTuiState();
    const doc = {
      status: 'complete',
      overview: 'Refactored auth module.',
      metrics: [{ label: 'FILES', value: '2 changed' }],
      whatChanged: [{ text: 'edit: src/auth.ts', priority: 'P1' }],
      verification: [{ text: '✓ npm test', priority: 'P1' }],
      failures: [],
      warnings: [],
      references: [],
      next: [],
      populatedSections: ['overview', 'metrics', 'whatChanged', 'verification'],
    };
    reduceEvent(s, ev({
      type: 'summary:rendered',
      agentId: 'a1',
      success: true,
      stopReason: 'completed',
      durationMs: 1200,
      toolCallsTotal: 3,
      filesModified: ['src/auth.ts'],
      summary: 'Done',
      doc,
    }));
    const toolLines = s.lines.filter((l) => l.kind === 'tool');
    expect(toolLines.length).toBeGreaterThan(0);
    const joined = toolLines.map((l) => l.text).join('\n');
    expect(joined).toContain('SUMMARY');
    expect(joined).toContain('FILES');
    expect(joined).toContain('WHAT CHANGED');
  });
});
