#!/usr/bin/env node
// swebench.mjs — run Mochi headlessly on SWE-bench-style instances and emit
// predictions in the OFFICIAL SWE-bench format:
//   {"instance_id": "...", "model_name_or_path": "...", "model_patch": "..."}
// Scoring is NOT reimplemented here. Predictions are graded by the official
// harness (see score-swebench.md):
//   python -m swebench.harness.run_evaluation \
//     --dataset_name SWE-bench/SWE-bench_Verified --split test \
//     --predictions_path predictions.jsonl --max_workers 8 --run_id <id>
// or pass --score here and this script shells out to exactly that command.
//
// Contamination / leakage rules baked in (improvement plan P0.2,
// dataset-catalog.md §6 rule 4): the agent NEVER sees git history past the
// base commit. Each instance is materialised by cloning its source repo,
// checking out base_commit, then SQUASHING history into a single fresh
// "base snapshot" commit. Agents have "solved" SWE tasks by reading the future
// fix commit from history — that is a harness bug, and this runner refuses to
// ship it. Trade-off, stated honestly: the agent also loses legitimate
// pre-base history (blame/log archaeology). That is the price of a clean eval.
//
// Source repos resolve in this order per instance:
//   1. instance.repo_path           — a local git repo / path (tests, mirrors)
//   2. --repos-dir/<owner>__<repo>  — pre-cloned mirror directory
//      --repos-dir/<repo-basename>  — same, flat layout
//   3. --clone                      — git clone https://github.com/<repo>.git
//                                     into --repo-cache (needs network)
//
// Usage:
//   node bench/external/swebench.mjs --dataset instances.jsonl [options]
// Options:
//   --dataset <file>     JSONL (or JSON array) of instances. Required fields:
//                        instance_id, repo, base_commit, problem_statement.
//                        FAIL_TO_PASS / PASS_TO_PASS are carried through to the
//                        results file (scoring itself uses the official set).
//   --out <file>         Predictions JSONL (default: ./swebench-predictions.jsonl)
//   --results <file>     Per-instance run detail JSONL (default: <out>.results.jsonl)
//   --model-name <name>  model_name_or_path stamped on predictions
//                        (default: mochi/<--model or 'default'>)
//   --model <id>         Passed to mochi as --model
//   --provider <name>    Passed to mochi as --provider
//   --mochi-bin <path>   Mochi CLI entry (default: <repo>/dist/cli.js, or $MOCHI_BIN)
//   --limit <n>          Run at most n instances
//   --only <id,id>       Run only these instance_ids
//   --timeout <sec>      Per-instance mochi timeout (default: 1800)
//   --work-root <dir>    Where per-instance worktrees live (default: mkdtemp)
//   --keep-work          Do not delete worktrees afterwards (debugging / audit)
//   --resume             Skip instance_ids already present in --out
//   --no-yolo            Do not pass --yolo to mochi (default: --yolo, because a
//                        disposable frozen worktree is a sandbox and an
//                        approval prompt would hang a headless run forever)
//   --extra-args "<...>" Extra raw args appended to the mochi invocation
//   --dry-run            Do NOT invoke mochi (no API key needed). Apply a stub
//                        patch instead to prove the plumbing end-to-end:
//                        instance.stub_patch (diff file, relative to the
//                        dataset file's directory) or --stub-patch <file>, or
//                        fall back to creating MOCHI_DRY_RUN_STUB.md.
//   --stub-patch <file>  Diff applied to every instance in --dry-run mode
//   --score              After running, shell out to the official SWE-bench
//                        evaluation harness (needs python + `pip install swebench`)
//   --score-dataset <hf> Dataset name for --score (default: SWE-bench/SWE-bench_Verified)
//   --run-id <id>        run_id for --score / results metadata (default: timestamp)
//
// Exit code: 0 when every attempted instance produced a prediction record
// (an empty patch is a legitimate prediction — the agent may fail), 2 on
// setup/usage errors, 1 when an instance errored before a patch could be
// captured (its record is still written, with an empty patch + status).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_MOCHI_BIN = resolve(REPO_ROOT, process.env.MOCHI_BIN || 'dist/cli.js');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'mochi-bench', GIT_AUTHOR_EMAIL: 'bench@mochi.local',
  GIT_COMMITTER_NAME: 'mochi-bench', GIT_COMMITTER_EMAIL: 'bench@mochi.local',
  GIT_TERMINAL_PROMPT: '0',
};

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

function git(args, cwd, { ok = true } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 600_000 });
  if (ok && r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  return r;
}

export function readDataset(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * Materialise a repo FROZEN at base_commit: clone → checkout → squash history
 * into one snapshot commit. Nothing from after base_commit survives: no fix
 * commit, no future branches, no remote refs.
 */
export function freezeWorktree({ src, baseCommit, dest }) {
  git(['clone', '--quiet', src, dest], dirname(dest));
  git(['checkout', '--quiet', '--detach', baseCommit], dest);
  const head = git(['rev-parse', 'HEAD'], dest).stdout.trim();
  if (head !== baseCommit && !baseCommit.startsWith(head.slice(0, baseCommit.length))) {
    // Short SHAs: accept when the resolved HEAD starts with the requested prefix.
    if (!head.startsWith(baseCommit)) throw new Error(`freeze failed: HEAD ${head} != base_commit ${baseCommit}`);
  }
  rmSync(join(dest, '.git'), { recursive: true, force: true });
  git(['init', '--quiet', '-b', 'main'], dest);
  git(['add', '-A'], dest);
  git(['commit', '--quiet', '-m', `base snapshot @ ${baseCommit}`], dest);
  return { head };
}

/** Capture everything the agent changed as a unified diff (untracked included). */
export function capturePatch(work) {
  // Mochi's own run state must never leak into a prediction patch.
  const mochiDir = join(work, '.mochi');
  if (existsSync(mochiDir)) rmSync(mochiDir, { recursive: true, force: true });
  git(['add', '-A'], work);
  const diff = git(['diff', '--cached', '--binary'], work).stdout;
  return diff;
}

export function buildPrompt(instance) {
  return [
    'Fix the following issue in this repository. The repository is checked out at the exact commit where the issue occurs; there is no later history available.',
    '',
    instance.problem_statement,
    '',
    'Rules: make the smallest correct change to the source code; do not modify or delete existing tests; run the relevant tests yourself before finishing to confirm the fix.',
  ].join('\n');
}

/** The exact headless invocation, verified against src/cli.ts / src/cli-flags.ts
 *  and bench/arena.mjs: -p/--print takes the NEXT argv as the positional prompt. */
export function mochiCommand({ mochiBin, prompt, model, provider, yolo = true, extraArgs = [] }) {
  const args = [mochiBin, '-p'];
  if (yolo) args.push('--yolo');
  if (model) args.push('--model', model);
  if (provider) args.push('--provider', provider);
  args.push(...extraArgs, prompt);
  return { file: 'node', args };
}

function resolveSourceRepo(instance, opts) {
  if (instance.repo_path) return resolve(String(instance.repo_path));
  if (opts.reposDir) {
    const slugged = join(opts.reposDir, String(instance.repo).replace('/', '__'));
    if (existsSync(slugged)) return slugged;
    const flat = join(opts.reposDir, basename(String(instance.repo)));
    if (existsSync(flat)) return flat;
  }
  if (opts.clone) {
    const dest = join(opts.repoCache, String(instance.repo).replace('/', '__'));
    if (!existsSync(dest)) {
      mkdirSync(opts.repoCache, { recursive: true });
      git(['clone', '--quiet', `https://github.com/${instance.repo}.git`, dest], opts.repoCache);
    }
    return dest;
  }
  return null;
}

function applyStubPatch(work, instance, opts, datasetDir) {
  const stub = opts.stubPatch || instance.stub_patch;
  if (stub) {
    const stubPath = resolve(datasetDir, String(stub));
    const r = spawnSync('git', ['apply', '--whitespace=nowarn', stubPath], { cwd: work, encoding: 'utf8', env: GIT_ENV });
    if (r.status !== 0) throw new Error(`stub patch ${stubPath} did not apply: ${(r.stderr || '').slice(0, 300)}`);
    return `stub patch ${stubPath}`;
  }
  writeFileSync(join(work, 'MOCHI_DRY_RUN_STUB.md'), `Dry-run stub for ${instance.instance_id} @ ${instance.base_commit}\n`);
  return 'stub marker file MOCHI_DRY_RUN_STUB.md';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset) { console.error('error: --dataset <instances.jsonl> is required (see header)'); return 2; }
  const datasetPath = resolve(String(args.dataset));
  const datasetDir = dirname(datasetPath);
  let instances = readDataset(datasetPath);
  const required = ['instance_id', 'repo', 'base_commit', 'problem_statement'];
  for (const inst of instances) {
    const missing = required.filter((k) => inst[k] === undefined || inst[k] === '');
    if (missing.length) { console.error(`error: instance ${inst.instance_id ?? '?'} missing fields: ${missing.join(', ')}`); return 2; }
  }
  if (args.only) { const want = new Set(String(args.only).split(',')); instances = instances.filter((i) => want.has(i.instance_id)); }
  if (args.limit) instances = instances.slice(0, Number(args.limit));

  const outPath = resolve(String(args.out || 'swebench-predictions.jsonl'));
  const resultsPath = resolve(String(args.results || `${outPath}.results.jsonl`));
  const runId = String(args['run-id'] || new Date().toISOString().replace(/[:.]/g, '-'));
  const timeoutMs = Number(args.timeout || 1800) * 1000;
  const modelName = String(args['model-name'] || `mochi/${args.model || 'default'}${args['dry-run'] ? '-dry-run' : ''}`);
  const workRoot = args['work-root'] ? resolve(String(args['work-root'])) : mkdtempSync(join(tmpdir(), 'mochi-swebench-'));
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });

  const done = new Set();
  if (args.resume && existsSync(outPath)) {
    for (const line of readFileSync(outPath, 'utf8').split('\n')) { if (line.trim()) { try { done.add(JSON.parse(line).instance_id); } catch {} } }
  }

  const opts = {
    reposDir: args['repos-dir'] ? resolve(String(args['repos-dir'])) : null,
    clone: !!args.clone,
    repoCache: args['repo-cache'] ? resolve(String(args['repo-cache'])) : join(workRoot, '.repo-cache'),
    stubPatch: args['stub-patch'] ? String(args['stub-patch']) : null,
  };

  console.log(`swebench: ${instances.length} instance(s), run_id=${runId}, work=${workRoot}${args['dry-run'] ? ' [DRY RUN — mochi not invoked]' : ''}`);
  let errors = 0;
  for (const instance of instances) {
    if (done.has(instance.instance_id)) { console.log(`  skip (resume) ${instance.instance_id}`); continue; }
    const t0 = performance.now();
    const work = join(workRoot, String(instance.instance_id).replace(/[^A-Za-z0-9._-]/g, '_'));
    const record = { instance_id: instance.instance_id, repo: instance.repo, base_commit: instance.base_commit, run_id: runId, dry_run: !!args['dry-run'] };
    try {
      const src = resolveSourceRepo(instance, opts);
      if (!src) throw new Error(`no source repo for ${instance.repo}: set instance.repo_path, --repos-dir, or --clone`);
      freezeWorktree({ src, baseCommit: String(instance.base_commit), dest: work });
      record.frozen_head = git(['rev-parse', 'HEAD'], work).stdout.trim();

      if (args['dry-run']) {
        record.agent = applyStubPatch(work, instance, opts, datasetDir);
      } else {
        const cmd = mochiCommand({
          mochiBin: args['mochi-bin'] ? resolve(String(args['mochi-bin'])) : DEFAULT_MOCHI_BIN,
          prompt: buildPrompt(instance),
          model: args.model ? String(args.model) : undefined,
          provider: args.provider ? String(args.provider) : undefined,
          yolo: !args['no-yolo'],
          extraArgs: args['extra-args'] ? String(args['extra-args']).split(' ').filter(Boolean) : [],
        });
        const r = spawnSync(cmd.file, cmd.args, { cwd: work, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env }, maxBuffer: 64 * 1024 * 1024 });
        record.agent = { exit: r.status, timed_out: !!r.error && r.error.code === 'ETIMEDOUT', stdout_tail: (r.stdout || '').slice(-2000), stderr_tail: (r.stderr || '').slice(-1000) };
        if (r.error && r.error.code !== 'ETIMEDOUT') throw r.error;
      }
      const patch = capturePatch(work);
      appendFileSync(outPath, JSON.stringify({ instance_id: instance.instance_id, model_name_or_path: modelName, model_patch: patch }) + '\n');
      record.status = patch.trim() ? 'patch_captured' : 'empty_patch';
      record.patch_bytes = Buffer.byteLength(patch);
      if (Array.isArray(instance.FAIL_TO_PASS)) record.fail_to_pass = instance.FAIL_TO_PASS;
      if (Array.isArray(instance.PASS_TO_PASS)) record.pass_to_pass = instance.PASS_TO_PASS;
    } catch (err) {
      errors++;
      record.status = 'error';
      record.error = String(err?.message || err).slice(0, 500);
      appendFileSync(outPath, JSON.stringify({ instance_id: instance.instance_id, model_name_or_path: modelName, model_patch: '' }) + '\n');
    } finally {
      record.duration_ms = Math.round(performance.now() - t0);
      appendFileSync(resultsPath, JSON.stringify(record) + '\n');
      console.log(`  ${record.status.padEnd(15)} ${instance.instance_id} (${record.duration_ms}ms${record.patch_bytes ? `, patch ${record.patch_bytes}B` : ''})`);
      if (!args['keep-work'] && existsSync(work)) rmSync(work, { recursive: true, force: true });
    }
  }
  console.log(`predictions → ${outPath}\nresults     → ${resultsPath}`);

  if (args.score) {
    const scoreArgs = ['-m', 'swebench.harness.run_evaluation', '--dataset_name', String(args['score-dataset'] || 'SWE-bench/SWE-bench_Verified'), '--split', 'test', '--predictions_path', outPath, '--max_workers', String(args['score-workers'] || 8), '--run_id', runId];
    console.log(`scoring: python3 ${scoreArgs.join(' ')}`);
    const s = spawnSync('python3', scoreArgs, { stdio: 'inherit', cwd: REPO_ROOT });
    if (s.error || s.status !== 0) {
      console.error('official scoring did not run (is `pip install swebench` done, and Docker available?). The predictions file above is unaffected — score it later with the command in score-swebench.md.');
    }
  }
  return errors ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(2); });
}
