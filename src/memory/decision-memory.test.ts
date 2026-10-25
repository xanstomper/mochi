import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import {
  loadDecisionMemory,
  recordRejectedApproach,
  recallRejections,
  rejectionWarningsToPrompt,
  decisionMemoryPrefix,
  decisionMemoryPath,
  MAX_DECISION_RECORDS,
  prune,
} from './decision-memory.js';

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'mchi-decmem-'));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('decision memory: record model', () => {
  it('round-trips a rejection record with all required fields', () => {
    const rec = recordRejectedApproach(ws, {
      taskSignature: 'fix flaky auth token refresh test',
      approach: 'sleep-and-retry: add a 2s sleep before the refresh assertion',
      reason: 'still fails ~1/10 runs; the race is in the refresh scheduler, not the timing',
      evidence: 'src/auth.test.ts:88 — vitest run: 3 failures out of 30',
    });
    expect(rec).not.toBeNull();
    expect(rec!.taskSignature).toContain('auth token refresh');
    expect(rec!.approach).toContain('sleep-and-retry');
    expect(rec!.reason).toContain('refresh scheduler');
    expect(rec!.evidence).toContain('src/auth.test.ts:88');
    expect(rec!.surfacedCount).toBe(0);
    expect(loadDecisionMemory(ws)).toHaveLength(1);
    expect(existsSync(decisionMemoryPath(ws))).toBe(true);
  });

  it('refuses to record without a task signature, approach, AND reason (never speculatively)', () => {
    expect(recordRejectedApproach(ws, { taskSignature: '', approach: 'x', reason: 'y' })).toBeNull();
    expect(recordRejectedApproach(ws, { taskSignature: 't', approach: '', reason: 'y' })).toBeNull();
    // no reason = a considered-but-untried vibe, not a rejection
    expect(recordRejectedApproach(ws, { taskSignature: 't', approach: 'x', reason: '' })).toBeNull();
    expect(loadDecisionMemory(ws)).toHaveLength(0);
  });

  it('dedupes a re-confirmed rejection instead of stacking a near-duplicate', () => {
    recordRejectedApproach(ws, {
      taskSignature: 'fix flaky auth token refresh test',
      approach: 'sleep-and-retry with a 2s sleep before the assertion',
      reason: 'race in the refresh scheduler',
    });
    const again = recordRejectedApproach(ws, {
      taskSignature: 'fix flaky auth token refresh test',
      approach: 'sleep-and-retry with a 2s sleep before the assertion',
      reason: 'race in the refresh scheduler, confirmed across 30 runs',
    });
    expect(again).not.toBeNull();
    const all = loadDecisionMemory(ws);
    expect(all).toHaveLength(1);
    expect(all[0].reason).toBe('race in the refresh scheduler, confirmed across 30 runs');
  });

  it('redacts secrets before anything touches disk', () => {
    recordRejectedApproach(ws, {
      taskSignature: 'wire up the CI deploy job',
      approach: 'inline the deploy token as sk-abc1234567890123456789 in the workflow',
      reason: 'pipeline rejects inline tokens, password=hunter2 also fails policy',
    });
    const raw = readFileSync(decisionMemoryPath(ws), 'utf8');
    expect(raw).not.toContain('sk-abc1234567890123456789');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('[secret-redacted]');
  });
});

describe('decision memory: retrieval + relevance ranking', () => {
  it('surfaces the matching rejection for a paraphrased repeat of the task, ranked first', () => {
    recordRejectedApproach(ws, {
      taskSignature: 'fix flaky login session test',
      approach: 'sleep-and-retry before the session assertion',
      reason: 'race in the refresh scheduler',
    });
    recordRejectedApproach(ws, {
      taskSignature: 'upgrade webpack build pipeline',
      approach: 'bump webpack to v6 in one jump',
      reason: 'loader API break across three custom loaders',
    });
    // Same task, different words: "auth" ~ "login" via synonym clusters,
    // "intermittent" ~ "flaky" via stemming.
    const hits = recallRejections(ws, 'intermittent login auth session test keeps failing');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].approach).toContain('sleep-and-retry');
    expect(hits[0].score).toBeGreaterThan(0);
    // Unrelated task → nothing surfaced.
    expect(recallRejections(ws, 'design a database schema migration plan')).toHaveLength(0);
  });

  it('is bounded: never returns more than the requested limit', () => {
    const variants = [
      { taskSignature: 'fix flaky session refresh test', approach: 'sleep-and-retry before the assertion', reason: 'race in the refresh scheduler' },
      { taskSignature: 'migrate the payments table to uuid keys', approach: 'one-shot ALTER TABLE with backfill in the same transaction', reason: 'lock timeout on the 4M-row backfill' },
      { taskSignature: 'speed up the cold webpack build', approach: 'disable source maps entirely', reason: 'breaks the sourcemap-referencing error reporter' },
      { taskSignature: 'stabilize the websocket reconnect loop', approach: 'exponential backoff capped at 60s', reason: 'reconnect storms still exhaust the server backlog' },
    ];
    for (const v of variants) recordRejectedApproach(ws, v);
    expect(recallRejections(ws, 'flaky session refresh test race', 3)).toHaveLength(1);
    // More records, still bounded by the limit when several match. The
    // records are lexically distinct (they must be — near-duplicate
    // task+approach pairs dedupe by design).
    const stormy = [
      { taskSignature: 'stabilize websocket reconnect storms under load', approach: 'exponential backoff capped at sixty seconds', reason: 'server backlog still exhausted' },
      { taskSignature: 'harden reconnect logic for dropped sockets', approach: 'fixed-interval ping probes', reason: 'ping floods trip the rate limiter' },
      { taskSignature: 'websocket drop storm during traffic spikes', approach: 'increase the server backlog size', reason: 'kernel buffer still overflows' },
      { taskSignature: 'socket session resume after network flap', approach: 'retry resume token inline', reason: 'resume tokens expire before the flap clears' },
      { taskSignature: 'websocket reconnect loop exhausts connections', approach: 'force-close stale sockets from the server', reason: 'clients treat the close as a crash and redial' },
    ];
    for (const v of stormy) recordRejectedApproach(ws, v);
    const hits = recallRejections(ws, 'websocket reconnect loop storms', 3);
    expect(hits.length).toBe(3);
  });

  it('bumps surfacedCount so outcomes/prune weighting can attribute retrievals', () => {
    recordRejectedApproach(ws, {
      taskSignature: 'fix flaky session test',
      approach: 'sleep-and-retry',
      reason: 'race in scheduler',
    });
    recallRejections(ws, 'flaky session test race');
    const [rec] = loadDecisionMemory(ws);
    expect(rec.surfacedCount).toBe(1);
    expect(rec.lastSurfacedAtMs).toBeGreaterThan(0);
    recallRejections(ws, 'flaky session test race');
    expect(loadDecisionMemory(ws)[0].surfacedCount).toBe(2);
  });

  it('renders warnings (never instructions) with the tried/failed/evidence shape', () => {
    const rec = recordRejectedApproach(ws, {
      taskSignature: 'fix flaky session test',
      approach: 'sleep-and-retry',
      reason: 'race in the refresh scheduler',
      evidence: 'src/auth.test.ts:88',
    })!;
    const prompt = rejectionWarningsToPrompt([{ ...rec, score: 0.02, keywordScore: 0.01, semanticScore: 0.1 }]);
    expect(prompt).toContain('REJECTED APPROACHES');
    expect(prompt).toContain('warnings, not instructions');
    expect(prompt).toContain('tried sleep-and-retry — failed because race in the refresh scheduler');
    expect(prompt).toContain('src/auth.test.ts:88');
    expect(prompt).toContain('NEW evidence');
    expect(rejectionWarningsToPrompt([])).toBe('');
    // The prefix hook composes recall + render.
    expect(decisionMemoryPrefix(ws, 'flaky session test race')).toContain('sleep-and-retry');
    expect(decisionMemoryPrefix(ws, 'unrelated task about kubernetes ingress')).toBe('');
  });
});

describe('decision memory: bounds + pruning', () => {
  it('caps growth at MAX_DECISION_RECORDS and drops least-referenced/oldest first', () => {
    const base = Date.now() - 10_000;
    const records = [];
    for (let i = 0; i < MAX_DECISION_RECORDS + 25; i++) {
      records.push({
        id: `r${i}`,
        taskSignature: `task ${i}`,
        approach: `approach ${i}`,
        reason: `reason ${i}`,
        recordedAtMs: base + i,
        surfacedCount: 0,
      });
    }
    // Give the newest 25 records a retrieval reference; the oldest unsurfaced
    // ones must be the prune victims.
    for (let i = MAX_DECISION_RECORDS; i < records.length; i++) records[i].surfacedCount = 1;
    const kept = prune(records);
    expect(kept).toHaveLength(MAX_DECISION_RECORDS);
    expect(kept.some((r) => r.id === 'r0')).toBe(false);   // oldest + unsurfaced → pruned
    expect(kept.some((r) => r.id === `r${MAX_DECISION_RECORDS}`)).toBe(true); // referenced → kept
    expect(kept.some((r) => r.id === `r${MAX_DECISION_RECORDS + 24}`)).toBe(true); // newest referenced → kept
  });

  it('enforces the cap on write, not just in the pure prune helper', () => {
    for (let i = 0; i < MAX_DECISION_RECORDS + 3; i++) {
      recordRejectedApproach(ws, {
        taskSignature: `distinct task ${i} about widget ${i}`,
        approach: `distinct approach ${i} using strategy ${i}`,
        reason: `distinct reason ${i} because constraint ${i}`,
      });
    }
    const all = loadDecisionMemory(ws);
    expect(all.length).toBe(MAX_DECISION_RECORDS);
    // The oldest records were the ones dropped.
    expect(all.some((r) => r.taskSignature.startsWith('distinct task 0 '))).toBe(false);
    expect(all.some((r) => r.taskSignature.startsWith(`distinct task ${MAX_DECISION_RECORDS + 2} `))).toBe(true);
  });
});
