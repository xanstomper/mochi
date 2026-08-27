#!/usr/bin/env npx tsx
// Render-cost micro-harness for the TUI state machine. Drives reduceEvent
// the same way app.ts does (including head-trims past `limit`) and reports
// per-event timings so regressions like the two freeze bugs are loud:
//   1. unbounded streaming lines (fixed via STREAM_LINE_CAP rollovers)
//   2. full-transcript re-wrap churn past the line cap (trim-induced)
// Run: npx tsx src/tui/render-harness.ts
import { performance } from 'node:perf_hooks';
import { createTuiState, reduceEvent, type TuiState } from './state.js';

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

interface Result { label: string; times: number[]; blocked: number; extra: string }

function report(name: string, times: number[], blocked: number, extra?: string): void {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const p50 = sorted[Math.floor(n * 0.5)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const p99 = sorted[Math.floor(n * 0.99)];
  const max = sorted[n - 1];
  const avg = times.reduce((a: number, b: number) => a + b, 0) / n;
  console.log(`\n${name}${extra ? ' — ' + extra : ''}`);
  console.log(`  N=${n}  avg=${avg.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms  max=${max.toFixed(2)}ms  BLOCKED>100ms=${blocked}`);
}

const CHUNK = 'reasoning token reasoning token ';

function buildReasoning(eps = 200): Result {
  const state: TuiState = createTuiState(500);
  let total = 0;
  let blocked = 0;
  const times: number[] = [];
  for (let i = 0; i < eps * 3; i++) {
    const dt = timeMs(() => reduceEvent(state, { type: 'agent:reasoning', content: CHUNK }));
    times.push(dt);
    if (dt > 100) blocked++;
    total += CHUNK.length;
  }
  return { label: 'Reasoning stream', times, blocked, extra: '~' + ((total / 1024) | 0) + 'KB' };
}

function buildTools(eps = 200): Result {
  const state: TuiState = createTuiState(500);
  let blocked = 0;
  const times: number[] = [];
  for (let i = 0; i < eps * 3; i++) {
    const id = 'tc_' + i;
    const isShell = i % 3 === 0;
    const dt = timeMs(() => {
      reduceEvent(state, {
        type: 'tool:called', tool: isShell ? 'shell' : 'edit', tool_call_id: id,
        args: isShell ? { command: 'echo test' } : { path: 'src/f.ts' },
      });
      reduceEvent(state, {
        type: 'tool:completed', tool: isShell ? 'shell' : 'edit',
        result: { toolCallId: id, name: isShell ? 'shell' : 'edit', output: 'ok', durationMs: 5 },
      });
    });
    times.push(dt);
    if (dt > 100) blocked++;
  }
  return { label: 'Tool call+complete pairs', times, blocked, extra: eps * 3 + ' calls' };
}

/** Streaming WELL past the 500-line cap: exercises head-trims while lines
 *  keep arriving. Before the trim-realignment fix every post-trim frame paid
 *  a full-transcript re-wrap; here each reduceEvent must stay O(changed). */
function buildPostCap(eps = 400): Result {
  const state: TuiState = createTuiState(500);
  let blocked = 0;
  const times: number[] = [];
  for (let i = 0; i < eps; i++) {
    // structural change (new line -> trims once full) every event
    const dt = timeMs(() => {
      reduceEvent(state, { type: 'subagent:started', agentId: 'a' + i, role: 'coder', prompt: 'post-cap filler ' + i });
      reduceEvent(state, { type: 'agent:reasoning', content: ' tail mutation' });
    });
    times.push(dt);
    if (dt > 100) blocked++;
  }
  return { label: 'Post-cap churn (trims streaming)', times, blocked, extra: `${eps} events, ${state.trimmed} lines trimmed` };
}

function main(): void {
  console.log('Render harness v2');
  const results: Result[] = [buildReasoning(), buildTools(), buildPostCap()];
  for (const r of results) report(r.label, r.times, r.blocked, r.extra);
  const any = results.some((r) => r.blocked > 0);
  console.log(any ? '\nBLOCKED >100ms detected' : '\nAll events <100ms');
}

main();
