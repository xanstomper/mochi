import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  loadSpeculationMemory, recordSpeculationOutcome, retrieveSpeculationMemory, speculationMemoryToPrompt,
} from './speculative.js';

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'mchi-specmem-'));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('speculation memory', () => {
  it('round-trips records', () => {
    expect(loadSpeculationMemory(ws)).toHaveLength(0);
    recordSpeculationOutcome(ws, { strategyClass: 'reproduce-minimal', taskTitle: 'fix login crash on submit', outcome: 'resolved', atMs: 1 });
    recordSpeculationOutcome(ws, { strategyClass: 'bisect', taskTitle: 'fix flaky payment test', outcome: 'unresolved', atMs: 2 });
    const all = loadSpeculationMemory(ws);
    expect(all).toHaveLength(2);
    expect(all[1].outcome).toBe('unresolved');
  });

  it('retrieves by >=2 keyword overlap, newest first', () => {
    recordSpeculationOutcome(ws, { strategyClass: 'root-cause-first', taskTitle: 'fix login crash when session expires', outcome: 'resolved', atMs: 1 });
    recordSpeculationOutcome(ws, { strategyClass: 'bisect', taskTitle: 'upgrade webpack build pipeline', outcome: 'resolved', atMs: 2 });
    recordSpeculationOutcome(ws, { strategyClass: 'state-inspection', taskTitle: 'login session redirect loop after crash fix', outcome: 'resolved', atMs: 3 });
    const hits = retrieveSpeculationMemory(ws, 'login crash session handling broken');
    expect(hits.map((h) => h.strategyClass)).toContain('root-cause-first');
    expect(hits[0].atMs).toBe(3); // newest matching first
    // no overlap -> nothing
    expect(retrieveSpeculationMemory(ws, 'design database schema migration plan')).toHaveLength(0);
  });

  it('renders a prompt hint', () => {
    expect(speculationMemoryToPrompt([])).toBe('');
    const p = speculationMemoryToPrompt([{ strategyClass: 'bisect', taskTitle: 'some task title here', outcome: 'unresolved', atMs: 1 }]);
    expect(p).toContain('[unresolved]');
    expect(p).toContain('bisect');
  });
});
