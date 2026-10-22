#!/usr/bin/env node
// terminalbench.mjs — run Mochi headlessly on Terminal-Bench-style tasks and
// grade each task with the task's OWN tests. Same shape as swebench.mjs:
// frozen task environment in, per-task result record out.
//
// Task layout (one directory per task under --tasks-dir):
//   <task-id>/
//     instruction.md          — the prompt (also accepted: instruction.txt,
//                               or task.yaml with an `instruction:` field —
//                               plain or |-block; crude parse, documented)
//     environment/            — (optional) files copied into the work dir
//     files/                  — (optional) same, if environment/ is absent
//     tests/run-tests.sh      — (preferred) test entry: run with cwd = work
//                               dir, $TB_WORKDIR set; exit 0 = PASS
//     tests/*.py              — (fallback) run with pytest if no run-tests.sh
//     stub.sh                 — (dry-run only) script run INSTEAD of mochi to
//                               prove the plumbing; see --dry-run below
//
// Isolation, stated honestly: official Terminal-Bench runs each task in its
// own Docker container. This thin runner does NOT — it copies the task's files
// into a fresh local directory and runs mochi + tests there with the current
// user's permissions. That is fine for plumbing, smoke tests, and trusted
// task sets on a disposable machine/VM; it is NOT a sandbox. For scored runs
// on untrusted tasks, run this script inside the disposable VM/container of
// your choice. (Improvement plan P0.2 scopes this harness as "thin runner on
// the arena seed" — Docker orchestration is Harbor's job, not this file's.)
//
// Usage:
//   node bench/external/terminalbench.mjs --tasks-dir <dir> [options]
// Options:
//   --tasks-dir <dir>    Directory whose immediate subdirs are tasks. Required
//                        (or --dataset: JSONL with {"task_id", "task_dir"})
//   --dataset <file>     JSONL list of tasks instead of scanning --tasks-dir
//   --out <file>         Results JSONL (default: ./terminalbench-results.jsonl)
//   --limit <n>          Run at most n tasks
//   --only <id,id>       Run only these task ids
//   --timeout <sec>      Per-phase timeout for mochi AND for tests (default: 1800)
//   --model / --provider / --mochi-bin / --no-yolo / --extra-args
//                        Same semantics as swebench.mjs
//   --work-root <dir>    Where per-task work dirs live (default: mkdtemp)
//   --keep-work          Do not delete work dirs afterwards
//   --dry-run            Do NOT invoke mochi (no API key needed). If the task
//                        ships stub.sh, run it as the "agent"; otherwise the
//                        agent phase is a no-op (tests will usually fail —
//                        the record still proves discovery, copying,
//                        test execution, and result writing end-to-end).
//
// Result record per task:
//   {task_id, passed, test_exit_code, test_stdout_tail, agent, duration_ms,
//    instruction_source, run_id, dry_run}
// Exit code: 0 = runner completed (individual task failures are data, in the
// results file — a 0% score is still a successful RUN), 2 = setup/usage error.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_MOCHI_BIN = resolve(REPO_ROOT, process.env.MOCHI_BIN || 'dist/cli.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[key] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

export function discoverTasks(tasksDir) {
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ task_id: e.name, task_dir: join(tasksDir, e.name) }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
}

export function readInstruction(taskDir) {
  for (const name of ['instruction.md', 'instruction.txt']) {
    const p = join(taskDir, name);
    if (existsSync(p)) return { text: readFileSync(p, 'utf8').trim(), source: name };
  }
  const yaml = join(taskDir, 'task.yaml');
  if (existsSync(yaml)) {
    const text = readFileSync(yaml, 'utf8');
    // Crude YAML: `instruction: "..."` / `instruction: '...'` / block scalar.
    const block = /^instruction:\s*[|>]-?\s*\n((?:[ \t]+.*\n?)+)/m.exec(text);
    if (block) return { text: block[1].replace(/^[ \t]+/gm, '').trim(), source: 'task.yaml (block)' };
    const inline = /^instruction:\s*(.+)$/m.exec(text);
    if (inline) return { text: inline[1].trim().replace(/^["']|["']$/g, ''), source: 'task.yaml' };
  }
  return null;
}

export function prepareWorkdir(taskDir, work) {
  mkdirSync(work, { recursive: true });
  for (const sub of ['environment', 'files']) {
    const src = join(taskDir, sub);
    if (existsSync(src)) { cpSync(src, work, { recursive: true }); return sub; }
  }
  return null;
}

export function findTestCommand(taskDir, work) {
  const shell = join(taskDir, 'tests', 'run-tests.sh');
  if (existsSync(shell)) return { file: 'bash', args: [shell], label: 'tests/run-tests.sh' };
  const testsDir = join(taskDir, 'tests');
  if (existsSync(testsDir)) {
    const pys = readdirSync(testsDir).filter((f) => f.endsWith('.py')).sort();
    if (pys.length) {
      // Copy tests beside the work dir layout TB uses: tests run against the
      // work dir as cwd, with the test files referenced by absolute path.
      return { file: 'python3', args: ['-m', 'pytest', '-q', ...pys.map((f) => join(testsDir, f))], label: `pytest ${pys.join(',')}` };
    }
  }
  return null;
}

function runPhase(file, args, { cwd, timeoutMs, env = {} }) {
  const r = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, timedOut: !!r.error && r.error.code === 'ETIMEDOUT', error: r.error ? String(r.error.message || r.error) : null, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let tasks = [];
  if (args.dataset) {
    const text = readFileSync(resolve(String(args.dataset)), 'utf8').trim();
    const rows = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    tasks = rows.map((r) => ({ task_id: r.task_id || r.id || basename(String(r.task_dir)), task_dir: resolve(dirname(resolve(String(args.dataset))), String(r.task_dir)) }));
  } else if (args['tasks-dir']) {
    tasks = discoverTasks(resolve(String(args['tasks-dir'])));
  } else {
    console.error('error: --tasks-dir <dir> or --dataset <file.jsonl> is required (see header)');
    return 2;
  }
  if (args.only) { const want = new Set(String(args.only).split(',')); tasks = tasks.filter((t) => want.has(t.task_id)); }
  if (args.limit) tasks = tasks.slice(0, Number(args.limit));
  if (!tasks.length) { console.error('error: no tasks found'); return 2; }

  const outPath = resolve(String(args.out || 'terminalbench-results.jsonl'));
  mkdirSync(dirname(outPath), { recursive: true });
  const runId = String(args['run-id'] || new Date().toISOString().replace(/[:.]/g, '-'));
  const timeoutMs = Number(args.timeout || 1800) * 1000;
  const workRoot = args['work-root'] ? resolve(String(args['work-root'])) : mkdtempSync(join(tmpdir(), 'mochi-tbench-'));
  mkdirSync(workRoot, { recursive: true });

  console.log(`terminalbench: ${tasks.length} task(s), run_id=${runId}, work=${workRoot}${args['dry-run'] ? ' [DRY RUN — mochi not invoked]' : ''}`);
  let passedCount = 0;
  for (const task of tasks) {
    const t0 = performance.now();
    const work = join(workRoot, task.task_id.replace(/[^A-Za-z0-9._-]/g, '_'));
    const record = { task_id: task.task_id, run_id: runId, dry_run: !!args['dry-run'], passed: false };
    try {
      const instruction = readInstruction(task.task_dir);
      if (!instruction) throw new Error(`no instruction found in ${task.task_dir} (instruction.md / instruction.txt / task.yaml)`);
      record.instruction_source = instruction.source;
      record.environment_copied_from = prepareWorkdir(task.task_dir, work);

      // ---- agent phase ----
      if (args['dry-run']) {
        const stub = join(task.task_dir, 'stub.sh');
        if (existsSync(stub)) {
          const r = runPhase('bash', [stub], { cwd: work, timeoutMs, env: { TB_WORKDIR: work } });
          record.agent = { stub: 'stub.sh', exit: r.status, timed_out: r.timedOut };
          if (r.status !== 0) throw new Error(`stub.sh exited ${r.status}: ${r.stderr.slice(-300)}`);
        } else {
          record.agent = { stub: null, note: 'dry-run no-op: task has no stub.sh' };
        }
      } else {
        const mochiArgs = [args['mochi-bin'] ? resolve(String(args['mochi-bin'])) : DEFAULT_MOCHI_BIN, '-p'];
        if (!args['no-yolo']) mochiArgs.push('--yolo');
        if (args.model) mochiArgs.push('--model', String(args.model));
        if (args.provider) mochiArgs.push('--provider', String(args.provider));
        if (args['extra-args']) mochiArgs.push(...String(args['extra-args']).split(' ').filter(Boolean));
        mochiArgs.push(instruction.text);
        const r = runPhase('node', mochiArgs, { cwd: work, timeoutMs });
        record.agent = { exit: r.status, timed_out: r.timedOut, stdout_tail: r.stdout.slice(-2000), stderr_tail: r.stderr.slice(-1000) };
        if (r.error && !r.timedOut) throw new Error(r.error);
      }

      // ---- test phase (the task's own tests are the only judge) ----
      const testCmd = findTestCommand(task.task_dir, work);
      if (!testCmd) throw new Error(`no tests found in ${task.task_dir} (tests/run-tests.sh or tests/*.py)`);
      const t = runPhase(testCmd.file, testCmd.args, { cwd: work, timeoutMs, env: { TB_WORKDIR: work } });
      record.test_command = testCmd.label;
      record.test_exit_code = t.status;
      record.test_timed_out = t.timedOut;
      record.test_stdout_tail = t.stdout.slice(-2000);
      record.test_stderr_tail = t.stderr.slice(-1000);
      record.passed = t.status === 0 && !t.timedOut;
    } catch (err) {
      record.error = String(err?.message || err).slice(0, 500);
      record.passed = false;
    } finally {
      record.duration_ms = Math.round(performance.now() - t0);
      if (record.passed) passedCount++;
      appendFileSync(outPath, JSON.stringify(record) + '\n');
      console.log(`  ${record.passed ? 'PASS' : 'FAIL'}  ${task.task_id} (${record.duration_ms}ms)${record.error ? ` — ${record.error}` : ''}`);
      if (!args['keep-work'] && existsSync(work)) rmSync(work, { recursive: true, force: true });
    }
  }
  console.log(`terminalbench: ${passedCount}/${tasks.length} passed → ${outPath}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(2); });
}
