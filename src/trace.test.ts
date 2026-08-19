import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventBus } from './events.js';
import { TraceRecorder, readTrace, formatTrace } from './trace.js';

describe('TraceRecorder', () => {
  it('captures events to a trace file and redacts secrets', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-trace-'));
    const bus = new EventBus();
    const rec = new TraceRecorder(dir, 'run1').attach(bus);
    bus.emit({ type: 'task:started', task: { id: 't1', title: 'Fix' } as any, agentId: 'a' });
    bus.emit({ type: 'tool:called', tool: 'shell', args: { command: 'curl -H "Authorization: Bearer sk-ABCDEFGHIJKLMNOPQRST" https://x' }, agentId: 'a' });
    bus.emit({ type: 'tool:completed', tool: 'write', result: { toolCallId: '', name: 'write', output: 'ok', durationMs: 1 }, agentId: 'a' });
    rec.log({ t: Date.now(), kind: 'goal:summary', status: 'completed' });
    rec.close();

    const entries = readTrace(dir, 'run1');
    expect(entries.length).toBe(4);
    const tool = entries.find((e) => e.kind === 'tool:called');
    expect(JSON.stringify(tool)).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV');
    expect(JSON.stringify(tool)).toContain('redacted');
    const summary = entries.find((e) => e.kind === 'goal:summary');
    expect(summary?.status).toBe('completed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not fail when events fire after close (best-effort)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-trace2-'));
    const bus = new EventBus();
    const rec = new TraceRecorder(dir, 'run2').attach(bus);
    rec.close();
    expect(() => bus.emit({ type: 'agent:log', agentId: 'a', message: 'x' })).not.toThrow();
    expect(existsSync(resolve(dir, 'traces', 'run2.jsonl'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('formatTrace renders a readable transcript', () => {
    const out = formatTrace([
      { t: 1, kind: 'task:started', task: { title: 'Do it' } },
      { t: 2, kind: 'tool:called', tool: 'edit', args: { path: 'a.ts' } },
      { t: 3, kind: 'task:completed', stopReason: 'completed' },
    ]);
    expect(out).toContain('Do it');
    expect(out).toContain('tool edit');
    expect(out).toContain('completed');
  });
});

function format<T>(_x: T): string; function format(entries: unknown[]): string { void entries; return ''; }