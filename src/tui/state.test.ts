import { describe, expect, it } from 'vitest';
import {
  createTuiState,
  reduceEvent,
  pushLine,
  truncateArgs,
  toolFamily,
  resolveCommandPrefix,
  formatToolInvocation,
  formatToolCompleted,
  rewrapSummaries,
  toAbsLine,
  toRelLine,
  formatRoutingReason,
} from './state.js';
import { STREAM_LINE_CAP } from './state.js';

function ev(partial: Record<string, unknown>): Record<string, unknown> { return partial; }

describe('reduceEvent', () => {
  it('builds an assistant transcript from message + chunks (bus user messages never render)', () => {
    const s = createTuiState();
    // Chatbox ownership: only the composer writes user lines. A message/user
    // event arriving on the bus (history replay, harness cross-talk) must not
    // render as a fake user message in the transcript.
    expect(reduceEvent(s, ev({ type: 'message', role: 'user', content: 'nice' }))).toBe(false);
    expect(s.lines.length).toBe(0);
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
    const toolLines = s.lines.filter((l) => l.kind === 'summary');
    expect(toolLines.length).toBeGreaterThan(0);
    const joined = toolLines.map((l) => l.text).join('\n');
    // Cline-style card: status title instead of a literal "SUMMARY" header;
    // metrics row is lowercase-labeled; section headers keep uppercase.
    expect(joined).toContain('Task Complete');
    expect(joined).toContain('files');
    expect(joined).toContain('WHAT CHANGED');
  });

  it('stores fullContent in TuiLine for uncompressed inspector', () => {
    const s = createTuiState();
    const fullText = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6';
    pushLine(s, 'thought', 'line 1…', fullText);
    const last = s.lines[s.lines.length - 1];
    expect(last.fullContent).toBe(fullText);

    reduceEvent(s, ev({
      type: 'tool:completed',
      tool: 'read',
      result: { toolCallId: 't1', name: 'read', output: 'file contents 12345', durationMs: 10 },
    }));
    const toolLine = s.lines[s.lines.length - 1];
    expect(toolLine.fullContent).toBe('file contents 12345');
  });
});

describe('resolveCommandPrefix (typeahead Enter selection)', () => {
  const cmds = ['/goal', '/history', '/help', '/mode', '/model', '/reasoning', '/review', '/run'];

  it('completes a unique bare partial to the full command', () => {
    expect(resolveCommandPrefix('/his', cmds)).toBe('/history');
    expect(resolveCommandPrefix('/re', cmds, '/review')).toBe('/review'); // ambiguous + highlighted
  });

  it('never hijacks an exact command (caller sends it)', () => {
    expect(resolveCommandPrefix('/history', cmds)).toBeNull();
    expect(resolveCommandPrefix('/goal', cmds)).toBeNull();
  });

  it('does not complete when arguments are already typed', () => {
    expect(resolveCommandPrefix('/goal fix the login bug', cmds)).toBeNull();
    expect(resolveCommandPrefix('/his 3', cmds)).toBeNull();
  });

  it('does not touch non-slash input (normal prompts)', () => {
    expect(resolveCommandPrefix('history of the world', cmds)).toBeNull();
    expect(resolveCommandPrefix('', cmds)).toBeNull();
  });

  it('leaves ambiguous prefixes open when nothing is highlighted', () => {
    // /re matches /reasoning and /review — without a unique highlighted pick, no hijack.
    expect(resolveCommandPrefix('/re', cmds)).toBeNull();
  });

  it('ignores a highlighted pick that is not among the matches', () => {
    expect(resolveCommandPrefix('/his', cmds, '/goal')).toBe('/history'); // unique match wins
    expect(resolveCommandPrefix('/re', cmds, '/goal')).toBeNull();        // bogus highlight → no hijack
  });
});

describe('plain-text tool formatters', () => {
  it('formats invocation rows across tools, aliases, and fallbacks', () => {
    expect(formatToolInvocation('edit', { path: 'src/foo.ts', oldText: 'a', newText: 'b' })).toBe('edit: src/foo.ts');
    expect(formatToolInvocation('write', { path: 'greeting.txt', content: 'hi' })).toBe('write: greeting.txt');
    expect(formatToolInvocation('read', { file_path: 'docs/a.md' })).toBe('read: docs/a.md'); // arg alias → path
    expect(formatToolInvocation('bash', { command: 'npm test' })).toBe('shell: npm test'); // tool alias
    const long = formatToolInvocation('shell', { command: 'x'.repeat(300) });
    expect(long.startsWith('shell: ')).toBe(true);
    expect(long.length).toBeLessThanOrEqual('shell: '.length + 120 + 3);
    expect(formatToolInvocation('search', { query: 'TODO' })).toBe('search: "TODO"');
    expect(formatToolInvocation('glob', { pattern: '**/*.ts' })).toBe('glob: "**/*.ts"');
    expect(formatToolInvocation('subagent', { tasks: [{}, {}] })).toBe('subagents: 2 parallel tasks');
    expect(formatToolInvocation('subagent', { tasks: 'single' })).toBe('subagents: 1 parallel tasks');
    expect(formatToolInvocation('subagent', { prompt: 'review this', role: 'reviewer' })).toBe('subagent (reviewer): "review this"');
    expect(formatToolInvocation('subagent', { prompt: 'go' })).toBe('subagent (coder): "go"');
    expect(formatToolInvocation('bg_task', { action: 'kill', task_id: 't7' })).toBe('bg_task: kill t7');
    expect(formatToolInvocation('bg_task', {})).toBe('bg_task: list');
    // Fallbacks: object without recognizable fields, and non-object args.
    expect(formatToolInvocation('weird_tool', { foo: 1 })).toBe('weird_tool: ({"foo":1})');
    expect(formatToolInvocation('weird_tool', 'plain string arg')).toBe('weird_tool: (plain string arg)');
  });

  it('formats completion rows for ok, error, and degenerate outputs', () => {
    expect(formatToolCompleted('shell', { output: 'built ok', durationMs: 42 })).toBe('[OK] built ok (42ms)');
    expect(formatToolCompleted('shell', { error: 'command timed out', durationMs: 10 })).toBe('[ERR] shell failed: command timed out (10ms)');
    // Long first line → generic outcome row.
    expect(formatToolCompleted('read', { output: 'x'.repeat(200) })).toBe('[OK] read completed');
    // Shell markers and JSON payloads never surface as the headline.
    expect(formatToolCompleted('shell', { output: 'exit_code: 1\nstderr text' })).toBe('[OK] shell completed');
    expect(formatToolCompleted('shell', { output: '{"ok":true}' })).toBe('[OK] shell completed');
    // Empty/absent result, and no duration → no timing suffix.
    expect(formatToolCompleted('edit')).toBe('[OK] edit completed');
    expect(formatToolCompleted('shell', { output: 'plain' })).toBe('[OK] plain');
  });

  it('truncates args for display in both string and object forms', () => {
    expect(truncateArgs({ a: 1 })).toBe('{"a":1}');
    expect(truncateArgs('y'.repeat(200)).length).toBe(123); // 120 + '...'
    expect(truncateArgs('short')).toBe('short');
  });
});

describe('toolFamily + pushLine collapse edges', () => {
  it('never collapses rows whose text has no recognizable tool word', () => {
    const s = createTuiState();
    pushLine(s, 'tool', 'mystery row one');
    pushLine(s, 'tool', 'mystery row two');
    expect(s.lines.filter((l) => l.kind === 'tool').length).toBe(2);
    expect(toolFamily('mystery row')).toBe('');
    expect(toolFamily('\x1b[32m┌ shell — echo\x1b[0m')).toBe('shell'); // ANSI stripped first
  });

  it('collapses same-family rows and carries fullContent/metadata forward', () => {
    const s = createTuiState();
    pushLine(s, 'tool', '┌ edit — a.ts', 'full-1');
    pushLine(s, 'tool', '┌ edit — b.ts', 'full-2', { tool: 'edit' });
    const tools = s.lines.filter((l) => l.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0].fullContent).toBe('full-2');
    expect(tools[0].metadata).toEqual({ tool: 'edit' });
    // summary lines are exempt from tool-family collapsing
    pushLine(s, 'summary', 'a summary card');
    pushLine(s, 'tool', '┌ edit — c.ts');
    expect(s.lines.filter((l) => l.kind === 'summary').length).toBe(1);
  });
});

describe('absolute line id helpers', () => {
  it('round-trips ids across trims and reports trimmed-away lines', () => {
    const s = createTuiState(3);
    expect(toAbsLine(s, 0)).toBe(0);
    pushLine(s, 'system', 'l0');
    pushLine(s, 'system', 'l1');
    pushLine(s, 'system', 'l2');
    pushLine(s, 'system', 'l3'); // trims l0
    expect(s.trimmed).toBe(1);
    expect(toAbsLine(s, 0)).toBe(1);
    expect(toRelLine(s, 1)).toBe(0); // l1 sits at index 0 now
    expect(toRelLine(s, 0)).toBeUndefined(); // l0 was trimmed away
    expect(toRelLine(s, 999)).toBeUndefined(); // never minted
  });
});

describe('reduceEvent remaining branches', () => {
  it('emits goal, tool:failed, error, and file:changed lines', () => {
    const s = createTuiState();
    expect(reduceEvent(s, ev({ type: 'goal:created', goal: { objective: 'Ship the release' } }))).toBe(true);
    expect(s.lines.some((l) => l.kind === 'goal' && l.text === 'Ship the release')).toBe(true);
    expect(reduceEvent(s, ev({ type: 'goal:created' }))).toBe(false);

    expect(reduceEvent(s, ev({ type: 'tool:failed', tool: 'shell', error: 'command timed out' }))).toBe(true);
    expect(s.lines.some((l) => l.kind === 'error' && l.text.includes('shell failed: command timed out'))).toBe(true);

    expect(reduceEvent(s, ev({ type: 'error', error: 'provider exploded' }))).toBe(true);
    expect(s.lines[s.lines.length - 1].text).toBe('provider exploded');

    expect(reduceEvent(s, ev({ type: 'file:changed', operation: 'create', path: 'new.ts' }))).toBe(true);
    expect(s.lines[s.lines.length - 1].text).toBe('+ create  new.ts');
    reduceEvent(s, ev({ type: 'file:changed', operation: 'teleport', path: 'x.ts' }));
    expect(s.lines[s.lines.length - 1].text).toBe('• teleport  x.ts'); // unknown op → bullet

    expect(reduceEvent(s, ev({ type: 'no:such:event' }))).toBe(false); // default arm
  });

  it('computes token velocity from usage:updated deltas', () => {
    const s = createTuiState();
    expect(reduceEvent(s, ev({ type: 'usage:updated', totalTokens: 100 }))).toBe(false);
    expect(s.lastTokens).toBe(100);
    expect(s.tokenVelocity).toBeUndefined(); // first sample: no baseline yet
    s.lastUsageAt = Date.now() - 2000;
    reduceEvent(s, ev({ type: 'usage:updated', totalTokens: 500 }));
    expect(s.tokenVelocity).toBe(200); // 400 tokens over ~2s
    expect(s.lastTokens).toBe(500);
    // Non-increasing totals never move the velocity.
    const v = s.tokenVelocity;
    s.lastUsageAt = Date.now() - 2000;
    reduceEvent(s, ev({ type: 'usage:updated', totalTokens: 500 }));
    expect(s.tokenVelocity).toBe(v);
  });

  it('drops empty message/reasoning events and tracks currentTask clearing', () => {
    const s = createTuiState();
    expect(reduceEvent(s, ev({ type: 'message', role: 'assistant' }))).toBe(false);
    expect(reduceEvent(s, ev({ type: 'message:chunk' }))).toBe(false);
    expect(reduceEvent(s, ev({ type: 'agent:reasoning' }))).toBe(false);

    reduceEvent(s, ev({ type: 'task:started', task: { title: 'Do the thing' } })); // no id: title only
    expect(s.currentTask).toBe('Do the thing');
    reduceEvent(s, ev({ type: 'task:completed', task: { title: 'Do the thing' } }));
    expect(s.currentTask).toBe('');
    reduceEvent(s, ev({ type: 'task:failed', task: { title: 'nope' }, reason: 'bad' }));
    expect(s.lines[s.lines.length - 1].text).toContain('nope');
    // task:created without an id is still a render signal
    expect(reduceEvent(s, ev({ type: 'task:created', task: {} }))).toBe(true);
    // subagent:start without an id still registers under some key
    reduceEvent(s, ev({ type: 'subagent:started', prompt: 'x' }));
    expect(s.activeSubagents.size).toBe(1);
  });

  it('routes tool:completed without a pending card via append and promote', () => {
    // No prior tool:called at all → append path.
    const a = createTuiState();
    reduceEvent(a, ev({ type: 'tool:completed', tool: 'read', result: { toolCallId: 'ghost', output: 'late' } }));
    const appended = a.lines[a.lines.length - 1];
    expect(appended.kind).toBe('tool');
    expect(appended.fullContent).toBe('late');
    // Last line is a tool card but not the matching pending → promote in place.
    const b = createTuiState();
    pushLine(b, 'tool', '┌ read — a.ts');
    reduceEvent(b, ev({ type: 'tool:completed', tool: 'read', result: { output: 'zzz' } }));
    expect(b.lines.length).toBe(1);
    expect(b.lines[0].fullContent).toBe('zzz');
    expect(b.lines[0].text).not.toBe('┌ read — a.ts');
  });
});

describe('summary:rendered fallback + rewrap', () => {
  const longDoc = {
    status: 'complete',
    overview: ('Refactored the auth module end to end and verified every path. ').repeat(8),
    metrics: [{ label: 'FILES', value: '3 changed' }],
    whatChanged: [{ text: 'edit: src/auth.ts', priority: 'P1' }],
    verification: [{ text: '✓ npm test', priority: 'P1' }],
    failures: [],
    warnings: [],
    references: [],
    next: [],
    populatedSections: ['overview', 'metrics', 'whatChanged', 'verification'],
  };

  it('skips no-op turns and falls back to the plain turn-summary card without a doc', () => {
    const s = createTuiState();
    // Zero tools + zero files (and non-array filesModified) → no card at all.
    expect(reduceEvent(s, ev({ type: 'summary:rendered', success: true, stopReason: 'end_turn', durationMs: 10, toolCallsTotal: 0, filesModified: 'nope' }))).toBe(false);
    expect(s.lines.length).toBe(0);
    // With work to report but no doc → plain renderTurnSummaryCard path.
    expect(reduceEvent(s, ev({ type: 'summary:rendered', success: true, stopReason: 'end_turn', durationMs: 1200, toolCallsTotal: 1, filesModified: ['a.ts'], summary: 'Did a thing' }))).toBe(true);
    const last = s.lines[s.lines.length - 1];
    expect(last.kind).toBe('tool');
    expect(last.text).toContain('a.ts');
  });

  it('rewraps only the newest summary card when the width changes', () => {
    const s = createTuiState();
    expect(rewrapSummaries(s, 80)).toBe(false); // no doc yet
    reduceEvent(s, ev({
      type: 'summary:rendered',
      success: true,
      stopReason: 'completed',
      durationMs: 900,
      toolCallsTotal: 2,
      filesModified: ['src/auth.ts'],
      summary: 'Done',
      doc: longDoc,
    }));
    expect(s.lines.some((l) => l.kind === 'summary')).toBe(true);
    const w = (process.stdout.columns || 80) + 7; // guaranteed different width
    expect(rewrapSummaries(s, w)).toBe(true); // re-rendered at new width
    expect(rewrapSummaries(s, w)).toBe(false); // same width → text unchanged
    // Once the summary line itself is trimmed away, rewrap reports false.
    for (let i = 0; i < 600; i++) pushLine(s, 'system', `filler-${i}`);
    expect(s.lines.some((l) => l.kind === 'summary')).toBe(false);
    expect(rewrapSummaries(s, w)).toBe(false);
  });
});

describe('status line live stats (W3-4)', () => {
  it('usage:updated counts a live turn and records the active model', () => {
    const s = createTuiState();
    expect(s.turns).toBe(0);
    reduceEvent(s, ev({ type: 'usage:updated', agentId: 'root', inputTokens: 10, outputTokens: 5, cacheTokens: 0, totalTokens: 15, model: 'gpt-5.1' }));
    expect(s.turns).toBe(1);
    expect(s.activeModel).toBe('gpt-5.1');
    // A second call increments; an event WITHOUT a model label keeps the
    // previous active model (failover endpoints stop sending usage metadata).
    reduceEvent(s, ev({ type: 'usage:updated', agentId: 'root', inputTokens: 10, outputTokens: 5, cacheTokens: 0, totalTokens: 15 }));
    expect(s.turns).toBe(2);
    expect(s.activeModel).toBe('gpt-5.1');
  });

  it('routing:decision records the compact evidence reason and re-renders', () => {
    const s = createTuiState();
    expect(reduceEvent(s, ev({
      type: 'routing:decision', agentId: 'root', taskKind: 'bugfix', model: 'gpt-5.1-mini',
      source: 'routed', fromModel: 'deepseek-v4', costPerSolveUsd: 0.0021, solveRate: 0.91, samples: 14,
    }))).toBe(true);
    expect(s.routingReason).toBe('routed gpt-5.1-mini←deepseek-v4: cps $0.0021 · 91% solve · 14 runs');
    // A routed decision IS the live active model, before the next usage event.
    expect(s.activeModel).toBe('gpt-5.1-mini');
  });

  it('routing:decision covers every source kind', () => {
    const mk = (source: string, extra: Record<string, unknown> = {}) => {
      const s = createTuiState();
      reduceEvent(s, ev({ type: 'routing:decision', agentId: 'root', taskKind: 'k', model: 'm', source, ...extra }));
      return s.routingReason;
    };
    expect(mk('pinned')).toBe('pinned');
    expect(mk('insufficient-data')).toBe('no routing data');
    expect(mk('already-optimal', { costPerSolveUsd: 0.5, solveRate: 1, samples: 3 })).toBe('optimal: cps $0.5000 · 100% solve · 3 runs');
    expect(mk('routed')).toBe('routed m: '); // no measured evidence in the cell yet
  });

  it('routing:escalated and -blocked record trigger/block reasons', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'routing:escalated', agentId: 'root', taskKind: 'k', fromModel: 'a', toModel: 'b', trigger: 'verify_failures', solveRate: 0.5 }));
    expect(s.routingReason).toBe('↑ b (verify_failures · 50%)');
    // An escalation does not change what the run is running on its own — the
    // loop's setActiveModel does; the badge only reports the trigger.
    const s2 = createTuiState();
    reduceEvent(s2, ev({ type: 'routing:escalation-blocked', agentId: 'root', taskKind: 'k', fromModel: 'a', toModel: 'b', trigger: 'same_failure', reason: 'budget exhausted' }));
    expect(s2.routingReason).toBe('↑ blocked: budget exhausted');
  });

  it('formatRoutingReason is undefined for non-routing events', () => {
    expect(formatRoutingReason(ev({ type: 'usage:updated' }))).toBeUndefined();
    expect(formatRoutingReason(ev({ type: 'message', role: 'assistant', content: 'x' }))).toBeUndefined();
  });
});

describe('spawn ledger (W3-4 subagent panel feed)', () => {
  it('subagent:started opens a running ledger entry', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'subagent:started', agentId: 'a-sub-1', parentId: 'root', role: 'coder', prompt: 'fix it' }));
    const e = s.spawnLedger.get('a-sub-1');
    expect(e).toBeDefined();
    expect(e!.status).toBe('running');
    expect(e!.role).toBe('coder');
    expect(e!.tokens).toBe(0);
    // activeSubagents still tracks live children for the transcript lines.
    expect(s.activeSubagents.has('a-sub-1')).toBe(true);
  });

  it('child usage:updated accumulates token spend while running', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'subagent:started', agentId: 'a-sub-1', parentId: 'root', role: 'coder', prompt: 'fix it' }));
    reduceEvent(s, ev({ type: 'usage:updated', agentId: 'a-sub-1', inputTokens: 100, outputTokens: 20, cacheTokens: 0, totalTokens: 120 }));
    reduceEvent(s, ev({ type: 'usage:updated', agentId: 'a-sub-1', inputTokens: 100, outputTokens: 30, cacheTokens: 0, totalTokens: 130 }));
    expect(s.spawnLedger.get('a-sub-1')!.tokens).toBe(250);
    // The ROOT's own usage does not bill any child.
    reduceEvent(s, ev({ type: 'usage:updated', agentId: 'root', inputTokens: 1, outputTokens: 1, cacheTokens: 0, totalTokens: 2 }));
    expect(s.spawnLedger.get('a-sub-1')!.tokens).toBe(250);
  });

  it('subagent:completed closes the entry with outcome + authoritative tokens', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'subagent:started', agentId: 'a-sub-1', parentId: 'root', role: 'coder', prompt: 'fix it' }));
    reduceEvent(s, ev({ type: 'usage:updated', agentId: 'a-sub-1', inputTokens: 100, outputTokens: 20, cacheTokens: 0, totalTokens: 120 }));
    reduceEvent(s, ev({ type: 'subagent:completed', agentId: 'a-sub-1', parentId: 'root', role: 'coder', success: true, summary: 'done', tokensUsed: 300 }));
    const e = s.spawnLedger.get('a-sub-1');
    expect(e!.status).toBe('done');
    expect(e!.endedAt).toBeDefined();
    expect(e!.tokens).toBe(300); // tokensUsed replaces the running estimate
    expect(s.activeSubagents.has('a-sub-1')).toBe(false);
  });

  it('failed children keep their status and accumulated tokens when no final count arrives', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'subagent:started', agentId: 'a-sub-1', parentId: 'root', role: 'reviewer', prompt: 'review' }));
    reduceEvent(s, ev({ type: 'usage:updated', agentId: 'a-sub-1', inputTokens: 50, outputTokens: 10, cacheTokens: 0, totalTokens: 60 }));
    reduceEvent(s, ev({ type: 'subagent:completed', agentId: 'a-sub-1', parentId: 'root', role: 'reviewer', success: false, summary: 'boom', tokensUsed: 0 }));
    const e = s.spawnLedger.get('a-sub-1');
    expect(e!.status).toBe('failed');
    expect(e!.tokens).toBe(60);
  });

  it('evicts the oldest finished entries past the cap but never a running child', () => {
    const s = createTuiState(500);
    for (let i = 0; i < 70; i++) {
      reduceEvent(s, ev({ type: 'subagent:started', agentId: `child-${i}`, parentId: 'root', role: 'coder', prompt: 'p' }));
      reduceEvent(s, ev({ type: 'subagent:completed', agentId: `child-${i}`, parentId: 'root', role: 'coder', success: true, summary: 'ok', tokensUsed: i }));
    }
    // One live child that must survive.
    reduceEvent(s, ev({ type: 'subagent:started', agentId: 'child-live', parentId: 'root', role: 'coder', prompt: 'p' }));
    expect(s.spawnLedger.size).toBe(64);
    expect(s.spawnLedger.has('child-live')).toBe(true);
    expect(s.spawnLedger.has('child-0')).toBe(false); // oldest finished evicted
    expect(s.spawnLedger.has('child-69')).toBe(true); // newest kept
  });
});
