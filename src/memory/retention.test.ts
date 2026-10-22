import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runRetention } from './retention.js';

let ws: string;
beforeEach(() => { ws = mkdtempSync(resolve(tmpdir(), 'mochi-ret-')); mkdirSync(resolve(ws, 'state'), { recursive: true }); mkdirSync(resolve(ws, 'traces'), { recursive: true }); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('retention', () => {
  it('prunes state + trace files older than the age threshold', () => {
    const oldFile = resolve(ws, 'state', 'old.json');
    writeFileSync(oldFile, '{}');
    // force mtime to 60 days ago
    const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, past, past);
    const r = runRetention({ workspaceDir: ws, maxAgeDays: 14 });
    expect(r.state.deletedFiles).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
  });

  it('never prunes recent files', () => {
    const f = resolve(ws, 'state', 'recent.json');
    writeFileSync(f, '{}');
    const r = runRetention({ workspaceDir: ws, maxAgeDays: 14 });
    expect(r.state.remainingFiles).toBe(1);
    expect(existsSync(f)).toBe(true);
  });

  it('skips subdirectories and hidden files', () => {
    mkdirSync(resolve(ws, 'state', 'subdir'));
    writeFileSync(resolve(ws, 'state', '.hidden'), '{}');
    const r = runRetention({ workspaceDir: ws, maxAgeDays: 0 });
    expect(r.state.deletedFiles).toBe(0);
  });

  it('does not GC a completed trace whose trajectory has not been exported', () => {
    const f = resolve(ws, 'traces', 'done.jsonl');
    writeFileSync(f, [
      JSON.stringify({ t: 1, kind: 'task:started' }),
      JSON.stringify({ t: 2, kind: 'task:completed', stopReason: 'completed' }),
    ].join('\n') + '\n');
    const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(f, past, past);
    const r = runRetention({ workspaceDir: ws, maxAgeDays: 14 });
    expect(r.traces.deletedFiles).toBe(0);
    expect(r.traces.remainingFiles).toBe(1);
    expect(existsSync(f)).toBe(true);
  });

  it('GCs old traces that are exported, and old traces that never completed', () => {
    const exported = resolve(ws, 'traces', 'exp.jsonl');
    writeFileSync(exported, JSON.stringify({ t: 1, kind: 'task:failed', stopReason: 'tool_loop' }) + '\n');
    mkdirSync(resolve(ws, 'exports'), { recursive: true });
    writeFileSync(resolve(ws, 'exports', 'trajectory-exp.jsonl'), '{}\n');
    const crashed = resolve(ws, 'traces', 'crash.jsonl');
    writeFileSync(crashed, JSON.stringify({ t: 1, kind: 'task:started' }) + '\n');
    const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(exported, past, past);
    utimesSync(crashed, past, past);
    const r = runRetention({ workspaceDir: ws, maxAgeDays: 14 });
    expect(r.traces.deletedFiles).toBe(2);
    expect(existsSync(exported)).toBe(false);
    expect(existsSync(crashed)).toBe(false);
  });

  it('returns a logPath even when nothing was deleted', () => {
    const r = runRetention({ workspaceDir: ws, maxAgeDays: 14 });
    expect(r.logPath).toContain('retention.log');
  });
});
