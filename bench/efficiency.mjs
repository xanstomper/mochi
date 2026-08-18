#!/usr/bin/env node
// Efficiency benchmark: measures cold-start wall time and peak resident memory
// for Mochi's CLI (Node + Bun) and optionally a comparator like jcode, then
// prints a compact comparison table. This is the measurable "lightweight /
// hardware-friendly" proof.
//
// Usage:
//   node bench/efficiency.mjs            # Mochi via Node + Bun
//   MOCHI_BIN=./dist/cli.js node bench/efficiency.mjs
//   COMPARE_BIN=/path/to/jcode node bench/efficiency.mjs   # add a comparator

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_ARG = process.env.MOCHI_BIN ? [] : ['--version'];

const RUNS = Number(process.env.RUNS ?? 15);

function measureTime(cmd, args, cwd) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd, stdio: 'ignore', encoding: 'utf8' });
  const ms = performance.now() - t0;
  return { ms, status: r.status, ok: r.status === 0 };
}

function measureMem(cmd, args, cwd) {
  // /usr/bin/time -v gives "Maximum resident set size (kbytes)".
  const r = spawnSync('/usr/bin/time', ['-v', cmd, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  const err = r.stderr || '';
  const m = err.match(/Maximum resident set size \(kbytes\): (\d+)/);
  return m ? Number(m[1]) : null;
}

function bench(target) {
  const { label, cmd, args } = target;
  let times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = measureTime(cmd, args, root);
    if (t.ok) times.push(t.ms);
  }
  const mems = [];
  for (let i = 0; i < Math.max(1, Math.min(3, RUNS)); i++) {
    const m = measureMem(cmd, args, root);
    if (m) mems.push(m);
  }
  const avgTime = times.length ? (times.reduce((a, b) => a + b, 0) / times.length) : NaN;
  const avgMem = mems.length ? Math.round(mems.reduce((a, b) => a + b, 0) / mems.length) : 0;
  return { label, avgTime, avgMem, ok: times.length > 0 };
}

// Default targets: Mochi CLI under Node and Bun (when available).
const targets = [];

let nodeCmd;
try { nodeCmd = spawnSync('node', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] }).status === 0 ? 'node' : null; } catch { nodeCmd = null; }
if (nodeCmd) targets.push({ label: 'mochi (node)', cmd: 'node', args: ['dist/cli.js', ...VERSION_ARG] });

let bunCmd;
try { bunCmd = spawnSync('bun', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] }).status === 0 ? 'bun' : null; } catch { bunCmd = null; }
if (bunCmd) targets.push({ label: 'mochi (bun)', cmd: 'bun', args: ['dist/cli.js', ...VERSION_ARG] });

// Optional comparator from env, e.g. MOCHI_COMPARE=.../jcode
if (process.env.MOCHI_COMPARE) {
  targets.push({ label: 'compare', cmd: process.env.MOCHI_COMPARE, args: ['--version'] });
}

const rows = [];
for (const t of targets) {
  const r = bench(t);
  rows.push(r);
  console.log(`${r.label.padEnd(14)} ${r.avgTime.toFixed(1).padStart(8)}ms ${String(r.avgMem).padStart(7)}KB  ${r.avgMem ? '' : '(mem n/a)'}`);
}

if (rows.length >= 2) {
  const node = rows.find((r) => r.label === 'mochi (node)');
  const bun = rows.find((r) => r.label === 'mochi (bun)');
  if (node && bun) {
    console.log(`\nBun vs Node: time ${(bun.avgTime / node.avgTime * 100).toFixed(1)}%, mem ${(bun.avgMem / node.avgMem * 100).toFixed(1)}%`);
  }
}