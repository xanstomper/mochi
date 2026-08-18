#!/usr/bin/env node
// Per-task token/cost benchmark. Runs a real multi-turn agent task against the
// configured provider and reports total tokens, cost, and wall time. This is the
// "what does an actual task cost" number (vs. a cold-start microbenchmark).
//
// Usage:
//   node bench/task.mjs                      # default task, current provider
//   MOCHI_TASK="...prompt..." node bench/task.mjs
//   MOCHI_BIN=/path/to/bin MOCHI_TASK="..." node bench/task.mjs   # custom binary/prompt
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// Repo root is two levels up from this script (bench/efficiency...). Use it so a
// default BIN resolves absolutely, independent of the child process's CWD.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(repoRoot, process.env.MOCHI_BIN || 'dist/cli.js');

const TASK = process.env.MOCHI_TASK ||
  'Create a file add.js exporting a function add(a,b){return a+b}, then create add.test.js that imports it and calls console.log(add(2,3)) and run it with node add.test.js. Verify the output is 5.';

const PREFIX = process.env.MOCHI_PREFIX || 'node';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-task-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bench-task', type: 'module', scripts: {} }));
  writeFileSync(join(dir, 'add-source.js'), 'export const seed = 1;\n');
  return dir;
}

function runTask(cwd) {
  const t0 = performance.now();
  const { stdout, stderr, status } = spawnSync(PREFIX, [BIN, '-p', '--verbose', TASK], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env },
  });
  const ms = Math.round(performance.now() - t0);
  const out = (stdout || '') + (stderr || '');
  const tokens = (/Tokens:\s*(\d+)/i.exec(out) || [])[1] || '?';
  const cost = (/Cost:\s*\$([\d.]+)/i.exec(out) || [])[1] || '?';
  const time = (/Time:\s*([\d.]+\s*s)/i.exec(out) || [])[1] || '?';
  const statusLabel = /goal completed/i.test(out) ? 'ok' : (/goal failed/i.test(out) ? 'FAIL' : `exit ${status}`);
  return { ms, tokens, cost, time, statusLabel, out };
}

const dir = setup();
console.log(`Mochi task bench — prompt: ${JSON.stringify(TASK)}\n`);
const r = runTask(dir);
console.log(`${'status'.padEnd(9)} ${r.statusLabel}`);
console.log(`${'tokens'.padEnd(9)} ${r.tokens}`);
console.log(`${'cost'.padEnd(9)}  $${r.cost}`);
console.log(`${'wall ms'.padEnd(9)} ${r.ms}ms  (reported ${r.time})`);
if (r.statusLabel !== 'ok') {
  console.log('\n--- tail ---\n' + r.out.split('\n').slice(-12).join('\n'));
}