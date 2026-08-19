import { describe, expect, it } from 'vitest';
import { createTuiState, reduceEvent, pushLine, truncateArgs } from './state.js';

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

  it('renders tool calls compactly and truncates huge args', () => {
    const s = createTuiState();
    reduceEvent(s, ev({ type: 'tool:called', tool: 'shell', args: { command: 'x'.repeat(500) } }));
    const last = s.lines[s.lines.length - 1];
    expect(last.kind).toBe('tool');
    expect(last.text.length).toBeLessThanOrEqual(220);
    expect(truncateArgs('short')).toBe('short');
  });

  it('caps the transcript at the configured limit, dropping oldest', () => {
    const s = createTuiState(3);
    for (let i = 0; i < 10; i++) pushLine(s, 'system', `line${i}`);
    expect(s.lines.length).toBe(3);
    expect(s.lines[0].text).toBe('line7');
    expect(s.lines[2].text).toBe('line9');
  });
});