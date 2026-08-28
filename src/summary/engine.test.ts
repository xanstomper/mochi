import { describe, it, expect } from 'vitest';
import { classify, dedupe, summarize } from './engine.js';
import { compactSession, compactToPrompt } from './compact.js';
import type { MochiEvent } from '../types.js';

const ts = (n: number) => 1_700_000_000_000 + n;

describe('summary engine — classification', () => {
  it('assigns P0 to failures, P1 to changes/verification, P4 to noise', () => {
    expect(classify({ type: 'error', error: 'boom' }).priority).toBe('P0');
    expect(classify({ type: 'file:changed', path: 'a.ts', operation: 'edit', agentId: 'x' }).priority).toBe('P1');
    expect(classify({ type: 'command:completed', command: 'npm test', executionId: 'e', exitCode: 0, durationMs: 10, truncated: false }).priority).toBe('P1');
    expect(classify({ type: 'message:chunk', content: 'x', agentId: 'a' }).category).toBe('noise');
  });

  it('dedupes repeated tool completions, keeps first', () => {
    const events: MochiEvent[] = [
      { type: 'tool:completed', tool: 'search', result: { callId: '1', name: 'search', output: 'a', durationMs: 1, truncated: false, rawTokensEstimate: 1 }, agentId: 'a' },
      { type: 'tool:completed', tool: 'search', result: { callId: '2', name: 'search', output: 'b', durationMs: 1, truncated: false, rawTokensEstimate: 1 }, agentId: 'a' },
    ];
    expect(dedupe(events.map(classify))).toHaveLength(1);
  });
});

describe('summary engine — summarize', () => {
  it('multi-file task: metrics + sections derived from real events', () => {
    const events: MochiEvent[] = [
      { type: 'file:changed', path: 'src/a.ts', operation: 'edit', agentId: 'a', timestamp: ts(0) },
      { type: 'file:changed', path: 'src/b.ts', operation: 'write', agentId: 'a', timestamp: ts(100) },
      { type: 'file:changed', path: 'src/c.ts', operation: 'edit', agentId: 'a', timestamp: ts(200) },
      { type: 'command:completed', command: 'npm test', executionId: 'e1', exitCode: 0, durationMs: 4200, truncated: false, timestamp: ts(300) },
      { type: 'command:completed', command: 'npm run build', executionId: 'e2', exitCode: 0, durationMs: 1200, truncated: false, timestamp: ts(400) },
      { type: 'task:completed', task: { id: 't1' } as never, agentId: 'a', timestamp: ts(500) },
    ];
    const doc = summarize(events, { goal: 'add feature' });
    expect(doc.status).toBe('complete');
    expect(doc.metrics.find((m) => m.label === 'FILES')?.value).toBe('3 changed');
    expect(doc.metrics.find((m) => m.label === 'CHECKS')?.value).toBe('2 passed');
    expect(doc.verification).toHaveLength(2);
    expect(doc.overview).toContain('Modified 3 files');
  });

  it('failed task: status failed, failures populated, no fabricated success', () => {
    const events: MochiEvent[] = [
      { type: 'command:failed', command: 'npm test', executionId: 'e1', error: '2 tests failed', durationMs: 900, timestamp: ts(0) },
      { type: 'error', error: 'build broke', timestamp: ts(10) },
    ];
    const doc = summarize(events);
    expect(doc.status).toBe('failed');
    expect(doc.failures.length).toBeGreaterThanOrEqual(2);
    expect(doc.metrics.find((m) => m.label === 'CHECKS')?.value).toContain('1 failed');
  });

  it('mixed session: partial status', () => {
    const events: MochiEvent[] = [
      { type: 'command:completed', command: 'lint', executionId: 'e1', exitCode: 0, durationMs: 100, truncated: false, timestamp: ts(0) },
      { type: 'command:completed', command: 'test', executionId: 'e2', exitCode: 1, durationMs: 100, truncated: false, timestamp: ts(10) },
    ];
    expect(summarize(events).status).toBe('partial');
  });

  it('no verification data → no CHECKS metric (never fabricate)', () => {
    const events: MochiEvent[] = [
      { type: 'agent:reasoning', content: 'thinking', agentId: 'a', timestamp: ts(0) },
    ];
    const doc = summarize(events);
    expect(doc.metrics.find((m) => m.label === 'CHECKS')).toBeUndefined();
    expect(doc.populatedSections).not.toContain('verification');
  });

  it('empty sections omitted (no empty headers)', () => {
    const doc = summarize([{ type: 'error', error: 'x', timestamp: ts(0) }]);
    expect(doc.populatedSections).not.toContain('whatChanged');
    expect(doc.populatedSections).not.toContain('references');
  });

  it('huge conversation stays fast and bounded', () => {
    const events: MochiEvent[] = [];
    for (let i = 0; i < 10_000; i++) {
      events.push({ type: 'message:chunk', content: 'x', agentId: 'a', timestamp: ts(i) });
      if (i % 100 === 0) events.push({ type: 'file:changed', path: `f${i}.ts`, operation: 'edit', agentId: 'a', timestamp: ts(i) });
    }
    const t0 = performance.now();
    const doc = summarize(events);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(doc.metrics.find((m) => m.label === 'FILES')?.value).toBe('100 changed');
  });
});

describe('session compaction', () => {
  it('preserves files/errors/decisions, drops conversational noise', () => {
    const events: MochiEvent[] = [
      { type: 'message:chunk', content: 'noise', agentId: 'a' },
      { type: 'file:changed', path: 'src/loop.ts', operation: 'edit', agentId: 'a' },
      { type: 'error', error: 'TS2345 at line 42', timestamp: ts(1) },
      { type: 'agent:reasoning', content: 'Decision: use frame batching because chunks overwhelm render', agentId: 'a' },
      { type: 'command:completed', command: 'npm test', executionId: 'e', exitCode: 0, durationMs: 10, truncated: false },
    ];
    const ctx = compactSession(events, { goal: 'fix renderer', constraints: ['no new deps'] });
    expect(ctx.goal).toBe('fix renderer');
    expect(ctx.constraints).toContain('no new deps');
    expect(ctx.files.some((f) => f.includes('src/loop.ts'))).toBe(true);
    expect(ctx.unresolved.some((u) => u.includes('TS2345'))).toBe(true);
    expect(ctx.decisions.some((d) => d.includes('frame batching'))).toBe(true);
    expect(ctx.references.some((r) => r.includes('npm test'))).toBe(true);
    expect(ctx.isEmpty).toBe(false);
  });

  it('renders the SESSION CONTEXT block with no empty sections', () => {
    const ctx = compactSession([{ type: 'error', error: 'x', timestamp: ts(0) }]);
    const text = compactToPrompt(ctx);
    expect(text).toContain('SESSION CONTEXT');
    expect(text).toContain('UNRESOLVED');
    expect(text).not.toContain('CONSTRAINTS');
    expect(text).not.toContain('GOAL');
  });

  it('compaction of pure noise reports isEmpty so callers keep raw transcript', () => {
    const ctx = compactSession([{ type: 'message:chunk', content: 'z', agentId: 'a' }]);
    expect(ctx.isEmpty).toBe(true);
    expect(compactToPrompt(ctx)).toBe('');
  });
});