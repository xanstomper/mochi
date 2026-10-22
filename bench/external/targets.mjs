#!/usr/bin/env node
// targets.mjs — adapters for the two current external eval targets:
// Terminal-Bench 4.0 (Harbor task format) and SWE-bench Pro V2 (public set,
// incl. the 51-task Hard split). They sit ALONGSIDE swebench.mjs /
// terminalbench.mjs and feed those runners; they do not reimplement them.
//
//   Terminal-Bench 4.0 task layout (one directory per task):
//     task.toml            — [task] name "org/name" + version; [metadata]
//                            difficulty/tags/languages; [agent] timeout_sec;
//                            [verifier] timeout_sec; [environment] resources
//     instruction.md       — the prompt given to the agent
//     environment/         — Dockerfile (+ optional docker-compose.yaml) and
//                            any files baked into the task environment
//     tests/test.sh        — the verifier entry (exit 0 = PASS)
//     solution/solve.sh    — (optional) reference/oracle solution
//   TB 4.0 ships 66 tasks with a flat 8h agent timeout. This adapter parses
//   and validates that layout, enumerates tasks, and — for a run —
//   materializes a shadow task in the terminalbench.mjs layout (instruction
//   + plain environment files + a run-tests.sh wrapper around test.sh) and
//   invokes terminalbench.mjs on it. As with terminalbench.mjs itself, the
//   Docker build is NOT performed: environment files are copied, the
//   Dockerfile is not. Scored TB 4.0 runs belong in Harbor/Docker; this is
//   the plumbing + smoke path, stated plainly.
//
//   SWE-bench Pro V2 instance layout (JSONL, SWE-bench schema):
//     {instance_id, repo, base_commit, problem_statement, FAIL_TO_PASS,
//      PASS_TO_PASS, [patch, test_patch, environment_setup_commit, ...]}
//   V2 is Scale's revised public split of SWE-bench Pro: 642 tasks after
//   repair/retirement of 480 of the original 731, plus a separate 51-task
//   Hard split (arXiv:2610.24206). This adapter validates + normalizes
//   records into the exact dataset shape swebench.mjs consumes. The gold
//   `patch` / `test_patch` fields are DROPPED during normalization — the
//   runner never needs them and an emitted eval dataset must not carry the
//   answers around.
//
// EVAL-ONLY DISCIPLINE (the frozen gate's rule, applied here): these are
// evaluation sets. Loading them for anything other than evaluation —
// training, practice, curriculum generation, distillation — is a HARD
// ERROR here, not a warning: run/emit entry points require purpose 'eval'
// and throw otherwise. Both targets are named in eval_blocklist.json;
// instance-level blocklist expansion still happens from the canonical
// releases via blocklist.mjs, never from memory.
//
// CLI:
//   node targets.mjs list     --target tb4 --tasks-dir <dir>
//   node targets.mjs validate --target tb4 --tasks-dir <dir>
//   node targets.mjs run      --target tb4 --tasks-dir <dir> --purpose eval [--dry-run] [--out f] [--model m] [--timeout sec]
//   node targets.mjs list     --target swebench-pro-v2 --dataset <file.jsonl>
//   node targets.mjs validate --target swebench-pro-v2 --dataset <file.jsonl>
//   node targets.mjs emit-dataset --target swebench-pro-v2 --dataset <file.jsonl> --purpose eval --split <all|public|hard> [--ids <file>] --out <file.jsonl>
// Exit codes: 0 ok · 1 validation/selection failed · 2 usage/setup error · 3 eval-purpose refusal.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBlocklist, readRecordsFile } from './blocklist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TB4_TARGET = 'terminal-bench-4.0';
export const PRO_V2_TARGET = 'swe-bench-pro-v2';
/** Documented sizes (Scale/arXiv for Pro V2; TB 4.0 leaderboard materials). */
export const TB4_TASK_COUNT = 66;
export const PRO_V2_PUBLIC_COUNT = 642;
export const PRO_V2_HARD_COUNT = 51;

// ---------------------------------------------------------------------------
// Eval-only guard
// ---------------------------------------------------------------------------

const NON_EVAL_PURPOSE = /train|practice|curricul|sft|distill|fine.?tun|synthetic/i;

/** Fail closed: only an explicit evaluation purpose may touch these sets. */
export function assertEvalPurpose(target, purpose) {
  if (purpose === 'eval' || purpose === 'evaluation') return;
  const why = purpose && NON_EVAL_PURPOSE.test(String(purpose))
    ? `"${purpose}" would put eval instances into a training/practice path — that is contamination (dataset-catalog.md §6)`
    : `purpose must be declared as "eval" (got ${purpose === undefined ? 'none' : `"${purpose}"`}) — undeclared use fails closed`;
  throw new Error(`[targets] REFUSED ${target}: ${why}. These are evaluation sets, never training data.`);
}

/** Ingestion-side audit helper: which of these records does the blocklist hit? */
export function checkAgainstBlocklist(records, blocklist) {
  const hits = [];
  for (const record of records) {
    const hit = blocklist.isBlocked(record);
    if (hit) hits.push({ record, ...hit });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Minimal TOML reader/writer (subset: sections, dotted keys, scalars,
// single-line arrays — everything Harbor task.toml files use in practice)
// ---------------------------------------------------------------------------

function stripTomlComment(line) {
  let inBasic = false, inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inBasic) { if (c === '\\') i++; else if (c === '"') inBasic = false; }
    else if (inLiteral) { if (c === "'") inLiteral = false; }
    else if (c === '"') inBasic = true;
    else if (c === "'") inLiteral = true;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTomlArray(inner).map(parseTomlValue);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[+-]?[\d_]+$/.test(v)) return Number(v.replace(/_/g, ''));
  if (/^[+-]?[\d_]*\.[\d_]+([eE][+-]?\d+)?$/.test(v) || /^[+-]?[\d_]+[eE][+-]?\d+$/.test(v)) return Number(v.replace(/_/g, ''));
  return v; // datetimes and anything unrecognized stay strings — tolerant by design
}

function splitTomlArray(inner) {
  const parts = [];
  let depth = 0, inBasic = false, inLiteral = false, cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inBasic) { cur += c; if (c === '\\') cur += inner[++i] ?? ''; else if (c === '"') inBasic = false; continue; }
    if (inLiteral) { cur += c; if (c === "'") inLiteral = false; continue; }
    if (c === '"') inBasic = true;
    else if (c === "'") inLiteral = true;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

export function parseToml(text) {
  const root = {};
  let section = root;
  const assign = (obj, path, value) => {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] ??= {};
    cur[path[path.length - 1]] = value;
  };
  for (const rawLine of String(text).split('\n')) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      const path = sec[1].split('.').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      section = root;
      for (const p of path) section = section[p] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue; // tolerant: ignore lines we cannot understand
    const keyPath = line.slice(0, eq).split('.').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    assign(section, keyPath, parseTomlValue(line.slice(eq + 1)));
  }
  return root;
}

function tomlScalar(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlScalar).join(', ')}]`;
  throw new Error(`cannot serialize ${typeof v} to TOML subset`);
}

/** Serialize the parser's subset back to TOML (used for round-trip checks). */
export function stringifyToml(obj) {
  const lines = [];
  const emit = (o, prefix) => {
    const scalars = Object.entries(o).filter(([, v]) => v === null || typeof v !== 'object' || Array.isArray(v));
    const tables = Object.entries(o).filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
    for (const [k, v] of scalars) if (v !== null) lines.push(`${k} = ${tomlScalar(v)}`);
    for (const [k, v] of tables) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`[${prefix ? `${prefix}.` : ''}${k}]`);
      emit(v, prefix ? `${prefix}.${k}` : k);
    }
  };
  emit(obj, '');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Terminal-Bench 4.0 (Harbor format)
// ---------------------------------------------------------------------------

export function discoverTb4Tasks(tasksDir) {
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(tasksDir, e.name, 'task.toml')))
    .map((e) => join(tasksDir, e.name))
    .sort();
}

/** Load + validate one TB4 task dir. Never throws for a malformed task —
 *  returns { descriptor|null, errors, warnings } so enumeration can report
 *  every problem at once. */
export function loadTb4Task(taskDir) {
  const errors = [];
  const warnings = [];
  const tomlPath = join(taskDir, 'task.toml');
  if (!existsSync(tomlPath)) return { descriptor: null, errors: [`${taskDir}: missing task.toml`], warnings };
  let toml;
  try { toml = parseToml(readFileSync(tomlPath, 'utf8')); }
  catch (err) { return { descriptor: null, errors: [`${taskDir}: task.toml unparsable: ${err.message}`], warnings }; }

  const taskMeta = toml.task ?? {};
  const meta = { ...(taskMeta ?? {}), ...(toml.metadata ?? {}) }; // [metadata] wins for descriptive fields
  const name = typeof taskMeta.name === 'string' ? taskMeta.name : '';
  if (!name) errors.push(`${taskDir}: task.toml [task] name is required (Harbor format "org/name")`);
  else if (!/^[^/\s]+\/[^/\s]+$/.test(name)) errors.push(`${taskDir}: [task] name "${name}" is not in "org/name" form`);
  if (!taskMeta.version) warnings.push(`${taskDir}: [task] version missing (publishing requires it; local runs tolerate)`);

  const instructionPath = join(taskDir, 'instruction.md');
  let instruction = '';
  if (!existsSync(instructionPath)) errors.push(`${taskDir}: missing instruction.md`);
  else {
    instruction = readFileSync(instructionPath, 'utf8').trim();
    if (!instruction) errors.push(`${taskDir}: instruction.md is empty`);
  }

  const testSh = join(taskDir, 'tests', 'test.sh');
  if (!existsSync(testSh)) errors.push(`${taskDir}: missing tests/test.sh (the TB4 verifier entry)`);

  const envDir = join(taskDir, 'environment');
  const hasEnv = existsSync(envDir);
  if (!hasEnv) warnings.push(`${taskDir}: no environment/ directory (Harbor marks it required)`);
  const needsDocker = hasEnv && (existsSync(join(envDir, 'Dockerfile')) || existsSync(join(envDir, 'docker-compose.yaml')));

  if (errors.length) return { descriptor: null, errors, warnings };
  const shortName = name.split('/')[1];
  const descriptor = {
    target: TB4_TARGET,
    eval_only: true,
    task_id: shortName,
    name,
    version: taskMeta.version ?? null,
    task_dir: taskDir,
    instruction,
    difficulty: meta.difficulty ?? null,
    task_type: meta.task_type ?? null,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    languages: Array.isArray(meta.languages) ? meta.languages : [],
    agent_timeout_sec: toml.agent?.timeout_sec ?? null,
    verifier_timeout_sec: toml.verifier?.timeout_sec ?? null,
    environment: toml.environment ?? {},
    needs_docker: needsDocker,
    has_solution: existsSync(join(taskDir, 'solution', 'solve.sh')),
  };
  return { descriptor, errors, warnings };
}

export function enumerateTb4(tasksDir, { strict = false } = {}) {
  const tasks = [];
  const invalid = [];
  const warnings = [];
  for (const dir of discoverTb4Tasks(tasksDir)) {
    const { descriptor, errors, warnings: w } = loadTb4Task(dir);
    warnings.push(...w);
    if (descriptor) tasks.push(descriptor);
    else {
      invalid.push({ task_dir: dir, errors });
      if (strict) throw new Error(`[targets] invalid TB4 task: ${errors.join('; ')}`);
    }
  }
  return { tasks, invalid, warnings };
}

const shellQuote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;

/** Materialize a terminalbench.mjs-shaped shadow of a TB4 task: instruction
 *  + plain environment files (Dockerfile/compose EXCLUDED — the thin runner
 *  does not build images, and pretending otherwise would be dishonest) +
 *  a run-tests.sh wrapper around the task's tests/test.sh. When the task
 *  ships solution/solve.sh, a stub.sh runs it so terminalbench --dry-run is
 *  a true oracle smoke through the existing harness. */
export function materializeTb4Shadow(descriptor, shadowRoot) {
  const dir = join(shadowRoot, descriptor.task_id.replace(/[^A-Za-z0-9._-]/g, '_'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  cpSync(join(descriptor.task_dir, 'instruction.md'), join(dir, 'instruction.md'));
  const envDir = join(descriptor.task_dir, 'environment');
  if (existsSync(envDir)) {
    const filesDir = join(dir, 'files');
    mkdirSync(filesDir, { recursive: true });
    for (const entry of readdirSync(envDir, { withFileTypes: true })) {
      if (entry.name === 'Dockerfile' || entry.name.startsWith('docker-compose')) continue;
      cpSync(join(envDir, entry.name), join(filesDir, entry.name), { recursive: true });
    }
  }
  writeFileSync(join(dir, 'tests', 'run-tests.sh'),
    `#!/bin/sh\n# generated by targets.mjs: TB4 verifies via tests/test.sh (Harbor layout).\nexec bash ${shellQuote(join(descriptor.task_dir, 'tests', 'test.sh'))}\n`);
  if (descriptor.has_solution) {
    writeFileSync(join(dir, 'stub.sh'),
      `#!/bin/sh\n# oracle stand-in for terminalbench --dry-run: runs the task's reference solution.\nexec bash ${shellQuote(join(descriptor.task_dir, 'solution', 'solve.sh'))}\n`);
  }
  return { task_id: descriptor.task_id, task_dir: dir };
}

/** Run TB4 tasks through the EXISTING terminalbench.mjs runner (shadow
 *  layout + --dataset). Returns the runner's exit code and output. */
export function runTb4({ tasksDir, out, dryRun = false, model, provider, timeoutSec, keepWork = false } = {}) {
  assertEvalPurpose(TB4_TARGET, 'eval');
  const { tasks, invalid } = enumerateTb4(tasksDir, { strict: false });
  if (invalid.length) throw new Error(`[targets] ${invalid.length} invalid TB4 task(s): ${invalid.flatMap((i) => i.errors).join('; ')}`);
  if (!tasks.length) throw new Error(`[targets] no TB4 tasks found under ${tasksDir}`);
  const shadowRoot = mkdtempSync(join(tmpdir(), 'mochi-tb4-shadow-'));
  const rows = tasks.map((t) => materializeTb4Shadow(t, shadowRoot));
  const datasetPath = join(shadowRoot, 'dataset.jsonl');
  writeFileSync(datasetPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const args = [join(HERE, 'terminalbench.mjs'), '--dataset', datasetPath, '--work-root', join(shadowRoot, 'work')];
  if (out) args.push('--out', resolve(String(out)));
  if (dryRun) args.push('--dry-run');
  if (model) args.push('--model', String(model));
  if (provider) args.push('--provider', String(provider));
  if (timeoutSec) args.push('--timeout', String(timeoutSec));
  if (keepWork) args.push('--keep-work');
  const r = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 2, stdout: r.stdout || '', stderr: r.stderr || '', shadowRoot, tasks: tasks.length };
}

// ---------------------------------------------------------------------------
// SWE-bench Pro V2
// ---------------------------------------------------------------------------

function coerceTestList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return [];
    try { const parsed = JSON.parse(t); if (Array.isArray(parsed)) return parsed.map((v) => String(v)); } catch { /* fall through */ }
    return [t];
  }
  return null;
}

/** Which split of Pro V2 a record belongs to, from its own fields only.
 *  Returns 'hard' | 'public' | null (no signal — never guessed). */
export function proV2SplitOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.hard === true) return 'hard';
  for (const key of ['split', 'subset', 'tier']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase() === 'hard' ? 'hard' : 'public';
  }
  return null;
}

export function validateProV2Record(rec) {
  const errors = [];
  const id = typeof rec?.instance_id === 'string' ? rec.instance_id : '';
  if (!id) errors.push('instance_id missing');
  if (typeof rec?.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(rec.repo)) errors.push(`${id || '?'}: repo must be "owner/name"`);
  if (typeof rec?.base_commit !== 'string' || !/^[0-9a-f]{40}$/i.test(rec.base_commit)) errors.push(`${id || '?'}: base_commit must be a full 40-char SHA`);
  if (typeof rec?.problem_statement !== 'string' || !rec.problem_statement.trim()) errors.push(`${id || '?'}: problem_statement empty`);
  const f2p = coerceTestList(rec?.FAIL_TO_PASS);
  if (!f2p || f2p.length === 0) errors.push(`${id || '?'}: FAIL_TO_PASS must be a non-empty list`);
  if (coerceTestList(rec?.PASS_TO_PASS) === null) errors.push(`${id || '?'}: PASS_TO_PASS must be a list (possibly empty)`);
  return errors;
}

/** Normalize into the swebench.mjs dataset shape. Gold patch/test_patch are
 *  dropped on purpose (see header). Stamps target + eval_only provenance. */
export function normalizeProV2Record(rec) {
  return {
    instance_id: rec.instance_id,
    repo: rec.repo,
    base_commit: rec.base_commit,
    problem_statement: rec.problem_statement,
    FAIL_TO_PASS: coerceTestList(rec.FAIL_TO_PASS) ?? [],
    PASS_TO_PASS: coerceTestList(rec.PASS_TO_PASS) ?? [],
    ...(rec.environment_setup_commit ? { environment_setup_commit: rec.environment_setup_commit } : {}),
    target: PRO_V2_TARGET,
    eval_only: true,
    split: proV2SplitOf(rec),
  };
}

/** Select a split. Hard-split membership is taken ONLY from record fields or
 *  an explicit id list — if neither signal exists anywhere, this THROWS
 *  rather than guessing which tasks are "hard". */
export function selectProV2Split(records, split, { ids } = {}) {
  if (!split || split === 'all') return { records, signal: 'all' };
  const want = String(split).toLowerCase();
  if (want !== 'hard' && want !== 'public') throw new Error(`[targets] unknown Pro V2 split "${split}" (all|public|hard)`);
  const idSet = ids ? new Set(ids) : null;
  const anyFieldSignal = records.some((r) => proV2SplitOf(r) !== null);
  const selected = records.filter((r) => proV2SplitOf(r) === want || (idSet && idSet.has(r.instance_id) && want === 'hard'));
  if (want === 'hard' && selected.length === 0 && !anyFieldSignal && !idSet) {
    throw new Error('[targets] cannot determine Hard-split membership: no record carries a split/subset/tier field and no --ids list was given. Refusing to guess — supply the canonical Hard instance IDs.');
  }
  return { records: selected, signal: anyFieldSignal && idSet ? 'record-fields+ids-file' : anyFieldSignal ? 'record-fields' : idSet ? 'ids-file' : 'none' };
}

/** Validate + normalize + split-select a Pro V2 dataset file's records. */
export function emitProV2Dataset(records, { split = 'all', ids } = {}) {
  assertEvalPurpose(PRO_V2_TARGET, 'eval');
  const errors = records.flatMap((r) => validateProV2Record(r));
  if (errors.length) throw new Error(`[targets] invalid SWE-bench Pro V2 record(s): ${errors.slice(0, 10).join('; ')}${errors.length > 10 ? ` …and ${errors.length - 10} more` : ''}`);
  const { records: selected, signal } = selectProV2Split(records, split, { ids });
  return { records: selected.map(normalizeProV2Record), signal, total: records.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      out[a.slice(2)] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const [cmd] = args._;
  const target = String(args.target || '');
  try {
    if (target === TB4_TARGET || target === 'tb4') {
      if (!args['tasks-dir']) { console.error('error: --tasks-dir <dir> is required for tb4'); return 2; }
      const tasksDir = resolve(String(args['tasks-dir']));
      if (cmd === 'list') {
        const { tasks, invalid, warnings } = enumerateTb4(tasksDir);
        for (const t of tasks) {
          const { instruction, ...meta } = t; // metadata only — list never prints eval content
          console.log(JSON.stringify(meta));
        }
        for (const w of warnings) console.error(`warning: ${w}`);
        if (invalid.length) { console.error(`${invalid.length} invalid task(s)`); return 1; }
        console.error(`${tasks.length} TB4 task(s) under ${tasksDir}`);
        return 0;
      }
      if (cmd === 'validate') {
        const { tasks, invalid, warnings } = enumerateTb4(tasksDir);
        for (const w of warnings) console.error(`warning: ${w}`);
        for (const i of invalid) for (const e of i.errors) console.error(`INVALID: ${e}`);
        console.log(`tb4: ${tasks.length} valid, ${invalid.length} invalid`);
        return invalid.length ? 1 : 0;
      }
      if (cmd === 'run') {
        assertEvalPurpose(TB4_TARGET, args.purpose ? String(args.purpose) : undefined);
        const r = runTb4({ tasksDir, out: args.out, dryRun: !!args['dry-run'], model: args.model, provider: args.provider, timeoutSec: args.timeout, keepWork: !!args['keep-work'] });
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        return r.status;
      }
    }
    if (target === PRO_V2_TARGET || target === 'swebench-pro-v2' || target === 'pro-v2') {
      if (!args.dataset) { console.error('error: --dataset <file.jsonl> is required for swebench-pro-v2'); return 2; }
      const records = readRecordsFile(resolve(String(args.dataset)));
      if (cmd === 'list') {
        for (const r of records) console.log(JSON.stringify({ instance_id: r.instance_id, repo: r.repo, split: proV2SplitOf(r), target: PRO_V2_TARGET, eval_only: true }));
        console.error(`${records.length} Pro V2 record(s)`);
        return 0;
      }
      if (cmd === 'validate') {
        const errors = records.flatMap((r) => validateProV2Record(r));
        for (const e of errors) console.error(`INVALID: ${e}`);
        console.log(`swebench-pro-v2: ${records.length} record(s), ${errors.length} error(s)`);
        return errors.length ? 1 : 0;
      }
      if (cmd === 'emit-dataset') {
        assertEvalPurpose(PRO_V2_TARGET, args.purpose ? String(args.purpose) : undefined);
        if (!args.out) { console.error('error: --out <file.jsonl> is required'); return 2; }
        const ids = args.ids ? readFileSync(resolve(String(args.ids)), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : undefined;
        const { records: emitted, signal, total } = emitProV2Dataset(records, { split: args.split ? String(args.split) : 'all', ids });
        writeFileSync(resolve(String(args.out)), emitted.map((r) => JSON.stringify(r)).join('\n') + '\n');
        console.log(`swebench-pro-v2: emitted ${emitted.length}/${total} record(s) (split=${args.split || 'all'}, signal=${signal}) → ${args.out}`);
        return 0;
      }
    }
    console.error('usage: targets.mjs <list|validate|run|emit-dataset> --target <tb4|swe-bench-pro-v2> … (see file header)');
    return 2;
  } catch (err) {
    console.error(String(err?.message || err));
    return /REFUSED/.test(String(err?.message || err)) ? 3 : 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
