#!/usr/bin/env node
// MCH-lazy 14 proof harness: tokens per task on a FIXED fixture task set,
// measured identically at base and tip with the same provider accounting.
//
// Usage:
//   node bench/lazy-proof.mjs --bin /abs/path/to/dist/cli.js --out /abs/path/results.json [--runs 2] [--label name]
//
// Fixture (rebuilt fresh per run): a small npm git repo with
//   - src/parser.js: ~1060 lines; parseQux (line ~834) calls parseBar (~line 423)
//   - src/calc.js: mul() has a seeded bug (a+b), sub() off by one
//   - tests/run.js: verbose vitest-style runner, 11 failing until calc.js fixed
//   - 12 uncommitted multi-file edits (~28KB raw `git diff`)
//
// Tasks (byte-identical strings across revisions):
//   T1 file-surface : read the big file, compute parseQux(7), write answer.txt
//   T2 diff-surface : git tool diff, write CHANGES.md with per-file deltas
//   T3 test-surface : verify tool (test), fix src/calc.js until the suite passes
//
// Accounting (identical parse at base and tip): `mochi -p --json` returns
// { status, success, tokensUsed, costUsd, durationMs } — the provider usage
// the run reported. Task success = success === true (or artifacts verified).

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeFixture } from './lazy-fixture-lib.mjs';

const argv = process.argv.slice(2);
function argOf(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const BIN = resolve(argOf('--bin') || 'dist/cli.js');
const OUT = argOf('--out');
const RUNS = Number(argOf('--runs') ?? 2);
const PREFIX = process.env.MOCHI_PREFIX || 'node';
const TIMEOUT_MS = Number(process.env.MOCHI_PROOF_TIMEOUT_MS ?? 420_000);
const SPACING_S = Number(process.env.MOCHI_PROOF_SPACING_S ?? 40);

// ── tasks (byte-identical strings for every revision) ───────────────────────

const TASKS = [
  {
    id: 'T1-lazy-file',
    prompt: 'Use the read tool to inspect src/parser.js in this repo. Then work out what the function parseQux returns for input 7 (it calls another function in the same file you must also inspect). Write ONLY that resulting number to answer.txt. Then finish.',
  },
  {
    id: 'T2-lazy-diff',
    prompt: 'Use the git tool (subcommand "diff", not a shell command) to see the pending changes in this repo, then write a file CHANGES.md with one line per changed file in the format "<path> +<added>/-<deleted>" (line deltas per file). Then finish.',
  },
  {
    id: 'T3-lazy-test',
    prompt: 'Run the test suite of this repo (npm test works). Some tests fail because of bugs in src/calc.js. Fix src/calc.js (minimum change), run the suite again until it passes, then finish.',
  },
];

// ── runner ──────────────────────────────────────────────────────────────────

function runTask(task, fixtureDir) {
  const t0 = Date.now();
  const { stdout, stderr, status } = spawnSync(PREFIX, [BIN, '-p', '--json', task.prompt], {
    cwd: fixtureDir,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: { ...process.env },
  });
  const out = (stdout || '') + (stderr || '');
  let detail = {};
  try {
    // The JSON document is the whole stdout; stderr may be interleaved before it.
    const start = out.indexOf('{');
    if (start >= 0) detail = JSON.parse(out.slice(start));
  } catch { /* fall back to regexes below */ }
  const fallbackTotal = (/\Tokens:\s*([\d,]+)\s+total/i.exec(out) || [])[1];
  const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));
  return {
    status: detail.status ?? 'no-json',
    success: detail.success === true,
    stopReason: detail.stopReason ?? null,
    tokensTotal: num(detail.tokensUsed ?? fallbackTotal),
    tokensIn: null,
    tokensOut: null,
    costUsd: detail.costUsd ?? null,
    wallMs: Date.now() - t0,
    exitStatus: status,
    tail: out.split('\n').slice(-14).join('\n'),
  };
}

/** Provider-infrastructure failure (rate limit / dead failover chain), NOT a
 *  task failure: zero tokens + the model-error markers. These are retried. */
function isProviderFailure(res) {
  if (res.tokensTotal != null && res.tokensTotal > 0) return false;
  return /Model request failed|marked dead|cooling down|429|rate limit|Invalid or expired API key/i.test(res.tail ?? '');
}

// ── main ────────────────────────────────────────────────────────────────────

console.log(`lazy-proof: bin=${BIN} runs=${RUNS}`);
const results = [];
for (let r = 0; r < RUNS; r++) {
  for (const task of TASKS) {
    let res = null;
    let evidence = {};
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const dir = makeFixture();
      process.stdout.write(`run ${r + 1}/${RUNS} ${task.id}${attempt > 1 ? ` (retry ${attempt - 1})` : ''} … `);
      try {
        res = runTask(task, dir);
        evidence = {};
        for (const f of ['answer.txt', 'CHANGES.md', join('src', 'calc.js'), join('tests', 'run.js')]) {
          const p = join(dir, f);
          if (existsSync(p)) evidence[f] = readFileSync(p, 'utf8').slice(0, 2000);
        }
      } catch (err) {
        res = { status: `ERROR: ${err.message}`, success: false, tokensTotal: null, tokensIn: null, tokensOut: null, wallMs: 0, tail: String(err) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (isProviderFailure(res) && attempt < MAX_ATTEMPTS) {
        console.log(`provider failure — waiting 60s before retry`);
        spawnSync('bash', ['-c', 'sleep 60']);
        res = null;
        continue;
      }
      break;
    }
    console.log(`${res.status} success=${res.success} tokens=${res.tokensTotal} ${Math.round(res.wallMs / 1000)}s`);
    results.push({ run: r + 1, task: task.id, ...res, tail: undefined, evidence });
    if (res.status !== 'completed') {
      console.log('  tail: ' + (res.tail || '').replace(/\n/g, '\n         '));
    }
    // Space runs out: freeinference rate-limits short bursts hard, and a
    // poisoned burst fails every subsequent run through the stale-keyed
    // failover chain.
    spawnSync('bash', ['-c', `sleep ${SPACING_S}`]);
  }
}
const json = JSON.stringify({ bin: BIN, label: argOf('--label') || BIN, runs: RUNS, tasks: TASKS.map((t) => t.id), results }, null, 2);
if (OUT) {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
} else {
  console.log(json);
}
