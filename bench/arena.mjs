#!/usr/bin/env node
// MCH-90: Harness Arena — head-to-head task suite across coding harnesses.
// Each harness gets the same fresh temp repo + same prompt per task; results
// scored by a mechanical checker (files exist, content correct, tests pass),
// NOT by vibes. Usage:
//   node bench/arena.mjs                    # all tasks, all harnesses
//   node bench/arena.mjs --harnesses mochi,codex --tasks f1,b1
//   ARENA_TIMEOUT=300 ARENA_ROUNDS=1 node bench/arena.mjs
// Env: FREEINFERENCE_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY as each CLI needs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOCHI_BIN = resolve(REPO, process.env.MOCHI_BIN || 'dist/cli.js');
const TIMEOUT_MS = (Number(process.env.ARENA_TIMEOUT || 300)) * 1000;

// ---------- Task suite: id -> { prompt, setup(dir), check(dir) -> [ok, detail] } ----------
const TASKS = {
  // Feature: write code + test and actually run it
  f1: {
    name: 'feature-add-test',
    prompt: 'Create add.js exporting function add(a,b) that returns a+b, then create add.test.js that imports it and prints add(2,3). Run it with node add.test.js and make sure the output is 5.',
    check(dir) {
      if (!existsSync(join(dir, 'add.js'))) return [false, 'add.js missing'];
      if (!existsSync(join(dir, 'add.test.js'))) return [false, 'add.test.js missing'];
      const r = spawnSync('node', ['add.test.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
      return r.stdout.trim().endsWith('5') ? [true, 'printed 5'] : [false, `ran but printed ${JSON.stringify(r.stdout.trim().slice(0, 40))}`];
    },
  },
  // Bugfix: seeded buggy code the agent must find and fix
  b1: {
    name: 'bugfix-off-by-one',
    setup(dir) {
      writeFileSync(join(dir, 'sum.js'), 'function sum(arr){ let s=0; for(let i=0;i<=arr.length;i++){ s+=arr[i]; } return s; }\nmodule.exports={sum};\n');
      writeFileSync(join(dir, 'run.js'), 'const {sum}=require("./sum.js"); console.log(sum([1,2,3,4]));\n');
    },
    prompt: 'run.js prints NaN instead of 10. Fix the bug in sum.js (do not change run.js), then run "node run.js" and confirm it prints 10.',
    check(dir) {
      const r = spawnSync('node', ['run.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
      return r.stdout.trim() === '10' ? [true, 'prints 10'] : [false, `prints ${JSON.stringify(r.stdout.trim().slice(0, 40))}`];
    },
  },
  // Refactor: rename across files, behavior preserved
  r1: {
    name: 'refactor-rename',
    setup(dir) {
      writeFileSync(join(dir, 'calc.js'), 'function calcTotal(items){ let t=0; for(const it of items){ t+=it.price*it.qty; } return t; }\nmodule.exports={calcTotal};\n');
      writeFileSync(join(dir, 'app.js'), 'const {calcTotal}=require("./calc.js"); console.log(calcTotal([{price:2,qty:3},{price:5,qty:1}]));\n');
    },
    prompt: 'Rename function calcTotal to computeCartTotal in calc.js AND update app.js to use the new name. Then run "node app.js" and confirm it still prints 11.',
    check(dir) {
      const c = readFileSync(join(dir, 'calc.js'), 'utf8');
      const a = readFileSync(join(dir, 'app.js'), 'utf8');
      if (c.includes('calcTotal') || a.includes('calcTotal')) return [false, 'old name still present'];
      const r = spawnSync('node', ['app.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
      return r.stdout.trim() === '11' ? [true, 'renamed + prints 11'] : [false, `prints ${JSON.stringify(r.stdout.trim().slice(0, 40))}`];
    },
  },
  // Research: read seeded codebase, answer a question into a file
  q1: {
    name: 'codebase-question',
    setup(dir) {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/auth.js'), 'const SALT=process.env.AUTH_SALT||"pepper";\nfunction hash(pw){ let h=0; for(const c of pw+SALT){ h=(h*31+c.charCodeAt(0))|0; } return h; }\nmodule.exports={hash};\n');
      writeFileSync(join(dir, 'src/server.js'), 'const {hash}=require("./auth.js");\nfunction login(pw){ return hash(pw)===1337; }\nmodule.exports={login};\n');
    },
    prompt: 'Read the src/ directory. Which exact environment variable name does the auth salt come from, and what is the fallback value? Write the answer as two lines "VAR=<name>" and "FALLBACK=<value>" into answer.txt.',
    check(dir) {
      if (!existsSync(join(dir, 'answer.txt'))) return [false, 'answer.txt missing'];
      const t = readFileSync(join(dir, 'answer.txt'), 'utf8');
      const ok = /VAR\s*=\s*AUTH_SALT/i.test(t) && /FALLBACK\s*=\s*pepper/i.test(t);
      return ok ? [true, 'both facts correct'] : [false, `wrong: ${JSON.stringify(t.trim().slice(0, 80))}`];
    },
  },
};

// ---------- Harness adapters: { cmd(dir, prompt) -> spawnSync args } ----------
const ADAPTERS = {
  mochi: { cmd: (dir, p) => ({ file: 'node', args: [MOCHI_BIN, '-p', p], env: {} }) },
  codex: { cmd: (dir, p) => ({ file: 'codex', args: ['exec', '--full-auto', '--skip-git-repo-check', p], env: {} }) },
  claude: { cmd: (dir, p) => ({ file: 'claude', args: ['-p', '--dangerously-skip-permissions', p], env: {} }) },
  crush: { cmd: (dir, p) => ({ file: 'crush', args: ['run', p], env: {} }) },
  opencode: { cmd: (dir, p) => ({ file: 'opencode', args: ['run', p], env: {} }) },
  gemini: { cmd: (dir, p) => ({ file: 'gemini', args: ['-p', p, '--yolo'], env: {} }) },
  jcode: { cmd: (dir, p) => ({ file: 'jcode', args: ['run', p], env: {} }) },
};

// Rivals that fail auth/config on this box — recorded so the scorecard is
// honest about why they're absent rather than silently skipped.
const UNAVAILABLE_NOTE = {};

function available(h) {
  const a = ADAPTERS[h];
  const probe = spawnSync(a.cmd(mkdtempSync(join(tmpdir(), 'arena-probe-')), 'noop').file, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return probe.status === 0 || !probe.error;
}

function runHarness(h, taskId, task, baseDir, round) {
  // Fresh dir per (round, harness, task) — round 2+ must not race round 1's leftovers.
  const dir = join(baseDir, `r${round}-${h}-${taskId}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'arena', type: 'commonjs' }));
  if (task.setup) task.setup(dir);
  const { file, args, env } = ADAPTERS[h].cmd(dir, task.prompt);
  const t0 = performance.now();
  const r = spawnSync(file, args, { cwd: dir, encoding: 'utf8', timeout: TIMEOUT_MS, env: { ...process.env, ...env } });
  const ms = Math.round(performance.now() - t0);
  const [ok, detail] = task.check(dir);
  return { harness: h, task: taskId, name: task.name, ok, detail, ms, exit: r.status, timedOut: r.error?.code === 'ETIMEDOUT' };
}

// ---------- Main ----------
const argH = (process.argv.find((a) => a.startsWith('--harnesses=')) || '').split('=')[1];
const argT = (process.argv.find((a) => a.startsWith('--tasks=')) || '').split('=')[1];
const harnesses = (argH ? argH.split(',') : Object.keys(ADAPTERS)).filter((h) => ADAPTERS[h]);
const taskIds = argT ? argT.split(',') : Object.keys(TASKS);
const rounds = Number(process.env.ARENA_ROUNDS || 1);
const baseDir = mkdtempSync(join(tmpdir(), 'arena-'));

const results = [];
for (let round = 0; round < rounds; round++) {
  for (const t of taskIds) {
    const task = TASKS[t];
    if (!task) { console.error(`unknown task ${t}`); process.exit(2); }
    for (const h of harnesses) {
      process.stdout.write(`round ${round + 1} ${h.padEnd(9)} ${t} ... `);
      const r = runHarness(h, t, task, baseDir, round);
      results.push(r);
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${(r.ms / 1000).toFixed(1)}s  ${r.detail}${r.timedOut ? ' [TIMEOUT]' : ''}`);
    }
  }
}

// Scorecard: pass rate + median time per harness
const score = {};
for (const r of results) {
  score[r.harness] ??= { pass: 0, total: 0, ms: [] };
  score[r.harness].total++;
  if (r.ok) score[r.harness].pass++;
  score[r.harness].ms.push(r.ms);
}
console.log('\n=== SCORECARD ===');
console.log('harness    pass     median-time');
for (const [h, s] of Object.entries(score).sort((a, b) => (b[1].pass / b[1].total) - (a[1].pass / a[1].total))) {
  const med = s.ms.sort((a, b) => a - b)[Math.floor(s.ms.length / 2)];
  console.log(`${h.padEnd(10)} ${s.pass}/${s.total}     ${(med / 1000).toFixed(1)}s`);
}
writeFileSync(join(REPO, 'bench', 'arena-results.json'), JSON.stringify({ when: new Date().toISOString(), rounds, results, score }, null, 2));
console.log(`\nresults -> bench/arena-results.json  (workdirs under ${baseDir})`);
