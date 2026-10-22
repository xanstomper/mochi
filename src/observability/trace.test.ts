import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventBus } from '../events.js';
import { TraceRecorder, readTrace, formatTrace, pruneTraces } from './trace.js';

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

  it('pruneTraces keeps newest files and enforces the byte cap', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-trace-prune-'));
    const tdir = resolve(dir, 'traces');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tdir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(resolve(tdir, `run${i}.jsonl`), JSON.stringify({ t: i, kind: 'x' }) + '\n');
      // Ensure distinct mtimes (oldest = run0).
      await new Promise((r) => setTimeout(r, 5));
    }
    const removed = pruneTraces(dir, 3, 1024 * 1024);
    expect(removed).toBe(2);
    expect(existsSync(resolve(tdir, 'run4.jsonl'))).toBe(true);
    expect(existsSync(resolve(tdir, 'run0.jsonl'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('pruneTraces spares completed-but-unexported traces over the file and byte caps, and prunes them once exported', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-trace-corpus-'));
    const tdir = resolve(dir, 'traces');
    mkdirSync(tdir, { recursive: true });
    const write = async (name: string, kinds: string[]) => {
      writeFileSync(resolve(tdir, `${name}.jsonl`), kinds.map((kind, i) => JSON.stringify({ t: i, kind })).join('\n') + '\n');
      await new Promise((r) => setTimeout(r, 5)); // distinct mtimes, oldest first
    };
    await write('runDone', ['task:started', 'task:completed']);
    await write('runFailed', ['task:started', 'task:failed']);
    await write('runA', ['task:started']);
    await write('runB', ['task:started']);
    await write('runC', ['task:started']);

    // File cap: oldest 3 are victims, but the two finished runs are the
    // unexported corpus — only the incomplete runA goes.
    expect(pruneTraces(dir, 2, 1024 * 1024)).toBe(1);
    expect(existsSync(resolve(tdir, 'runDone.jsonl'))).toBe(true);
    expect(existsSync(resolve(tdir, 'runFailed.jsonl'))).toBe(true);
    expect(existsSync(resolve(tdir, 'runA.jsonl'))).toBe(false);

    // Byte cap: a 1-byte cap makes every file a victim; finished runs
    // still survive, incomplete ones do not.
    expect(pruneTraces(dir, 100, 1)).toBe(2);
    expect(existsSync(resolve(tdir, 'runDone.jsonl'))).toBe(true);
    expect(existsSync(resolve(tdir, 'runFailed.jsonl'))).toBe(true);
    expect(existsSync(resolve(tdir, 'runB.jsonl'))).toBe(false);
    expect(existsSync(resolve(tdir, 'runC.jsonl'))).toBe(false);

    // Once exported, the export is the durable record and the raw traces
    // may be pruned like any other file.
    mkdirSync(resolve(dir, 'exports'), { recursive: true });
    writeFileSync(resolve(dir, 'exports', 'trajectory-runDone.jsonl'), '{}\n');
    writeFileSync(resolve(dir, 'exports', 'trajectory-runFailed.jsonl'), '{}\n');
    expect(pruneTraces(dir, 100, 1)).toBe(2);
    expect(existsSync(resolve(tdir, 'runDone.jsonl'))).toBe(false);
    expect(existsSync(resolve(tdir, 'runFailed.jsonl'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('pruneTraces still prunes incomplete (crashed / unfinished) traces', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-trace-incomplete-'));
    const tdir = resolve(dir, 'traces');
    mkdirSync(tdir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      // No task:completed / task:failed terminal event.
      writeFileSync(resolve(tdir, `crash${i}.jsonl`), JSON.stringify({ t: i, kind: 'task:started' }) + '\n');
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pruneTraces(dir, 1, 1024 * 1024)).toBe(2);
    expect(existsSync(resolve(tdir, 'crash2.jsonl'))).toBe(true);
    expect(existsSync(resolve(tdir, 'crash0.jsonl'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('pruneTraces never throws on a missing directory', () => {
    expect(pruneTraces(resolve(tmpdir(), 'mochi-trace-missing-xyz'))).toBe(0);
  });
});

function format<T>(_x: T): string; function format(entries: unknown[]): string { void entries; return ''; }