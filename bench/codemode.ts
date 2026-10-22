#!/usr/bin/env tsx
// Code Mode spike — comparison runner.
// Usage: ./node_modules/.bin/tsx bench/codemode.ts [--repeats N] [--json]
// Prints measured direct-vs-codemode numbers per fixture task (tokens are
// counted with the repo's own approxTokens on provider-shaped payloads;
// latency beyond local wall time is MODELED per-turn, clearly labeled).
import { runComparison } from '../src/codemode/harness.js';

const args = process.argv.slice(2);
const repeats = Math.max(1, Number(args[args.indexOf('--repeats') + 1]) || 3);
const asJson = args.includes('--json');

const rows = await runComparison(undefined, repeats);

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);
console.log(`Code Mode spike — direct vs programmatic tool calls (median of ${repeats} runs)\n`);
console.log(
  pad('task', 26) + padL('mode', 9) + padL('ok', 4) + padL('turns', 6) + padL('calls', 6) +
  padL('in tok', 9) + padL('out tok', 9) + padL('total', 9) + padL('tool ms', 9) + padL('wall ms', 9),
);
for (const r of rows) {
  for (const m of [r.direct, r.codemode]) {
    console.log(
      pad(`${r.taskId} ${r.name}`, 26) + padL(m.mode, 9) + padL(m.ok ? 'yes' : 'NO', 4) +
      padL(m.turns, 6) + padL(m.toolCalls, 6) + padL(m.inputTokens, 9) + padL(m.outputTokens, 9) +
      padL(m.inputTokens + m.outputTokens, 9) + padL(m.toolMs, 9) + padL(m.wallMs, 9),
    );
  }
  console.log(pad('', 26) + `  Δ total tokens (codemode vs direct): ${r.totalTokenDeltaPct}%   Δ input: ${r.inputTokenDeltaPct}%`);
}
const dIn = rows.reduce((s, r) => s + r.direct.inputTokens, 0);
const cIn = rows.reduce((s, r) => s + r.codemode.inputTokens, 0);
const dTot = rows.reduce((s, r) => s + r.direct.inputTokens + r.direct.outputTokens, 0);
const cTot = rows.reduce((s, r) => s + r.codemode.inputTokens + r.codemode.outputTokens, 0);
const dTurns = rows.reduce((s, r) => s + r.direct.turns, 0);
const cTurns = rows.reduce((s, r) => s + r.codemode.turns, 0);
console.log(`\nAggregate: input ${dIn} -> ${cIn} (${Math.round(((cIn - dIn) / dIn) * 1000) / 10}%), total ${dTot} -> ${cTot} (${Math.round(((cTot - dTot) / dTot) * 1000) / 10}%), model turns ${dTurns} -> ${cTurns}`);
console.log('\nMODELED latency (measured local wall + turns × per-turn model latency L):');
for (const L of [800, 2000, 5000]) {
  const d = rows.reduce((s, r) => s + r.direct.wallMs + r.direct.turns * L, 0);
  const c = rows.reduce((s, r) => s + r.codemode.wallMs + r.codemode.turns * L, 0);
  console.log(`  L=${L}ms/turn: direct ${d}ms vs codemode ${c}ms across all tasks`);
}
