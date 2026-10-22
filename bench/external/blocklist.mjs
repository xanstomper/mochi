#!/usr/bin/env node
// eval_blocklist — contamination guard for Mochi training-data ingestion.
//
// Loads bench/external/eval_blocklist.json and answers one question for any
// candidate training record: "could this item (or the fix for it) appear in an
// evaluation Mochi reports?" If yes, the item is dropped AND the drop is
// logged. An unlogged drop is treated as a bug: the filter run itself must be
// auditable (dataset-catalog.md §6, improvement plan P0.2).
//
// Matching rules (first hit wins):
//   1. instance_id / task_id — exact match against the expanded instance set.
//   2. base_commit — exact match against the expanded base-commit set. A git
//      SHA is globally unique, so a commit match is decisive on its own.
//   3. (repo, base_commit) pair — exact match against the expanded pair set.
// Repo name ALONE never blocks: SWE-bench's train split legitimately uses the
// same repos (e.g. django/django) as its test split. Blocking by repo alone
// would nuke valid training data; matching by commit cannot.
//
// The seed JSON ships dataset identifiers + repo names but EMPTY instance
// lists (no fabricated IDs). Populate them per dataset:
//   node blocklist.mjs expand ~/data/SWE-bench_Verified.jsonl --dataset swe-bench-verified
// For Terminal-Bench, point expand at a file listing task-dir names, one
// {"instance_id": "<task-dir-name>"} per line (a `ls` of the registry works:
//   ls tasks/ | sed 's/.*/{&}/' — see README.md for the exact recipe), or use a
// JSONL exported from the Harbor dataset.
//
// CLI:
//   node blocklist.mjs coverage [--blocklist <path>]
//   node blocklist.mjs expand <dataset.jsonl> --dataset <id> [--blocklist <path>] [--out <path>]
//   node blocklist.mjs check <records.jsonl> [--blocklist <path>]
//   node blocklist.mjs filter <in.jsonl> <kept.jsonl> [--log <drops.jsonl>]
//
// Library:
//   import { loadBlocklist, createBlocklist } from './blocklist.mjs';
//   const bl = loadBlocklist();                       // default path beside this file
//   bl.isBlocked({ instanceId, repo, baseCommit });   // false | {blocked, reason, ...}
//   const { kept, dropped } = bl.filterRecords(records, { source: 'swe-gym.jsonl' });

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BLOCKLIST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'eval_blocklist.json');

const normId = (v) => (v == null ? '' : String(v).trim());
const normRepo = (v) => normId(v).toLowerCase().replace(/\.git$/, '').replace(/^https?:\/\/github\.com\//, '');
const normCommit = (v) => normId(v).toLowerCase();
const pairKey = (repo, commit) => `${normRepo(repo)}@${normCommit(commit)}`;

/** Pull the candidate identifiers out of a record in any of the shapes the
 *  ingestion pipeline sees (SWE-bench instances, trajectory records, TB tasks). */
export function extractIds(record) {
  if (!record || typeof record !== 'object') return { instanceId: '', repo: '', baseCommit: '' };
  return {
    instanceId: normId(record.instance_id ?? record.instanceId ?? record.task_id ?? record.taskId ?? record.id),
    repo: normRepo(record.repo ?? record.repo_name ?? record.repository),
    baseCommit: normCommit(record.base_commit ?? record.baseCommit ?? record.base_commit_hash ?? record.commit),
  };
}

/** Build a matcher from parsed blocklist data (the JSON file's contents). */
export function createBlocklist(data, { source = '<memory>' } = {}) {
  const instanceIds = new Set();
  const baseCommits = new Set();
  const pairs = new Set();
  const datasetByInstance = new Map();

  const addInstance = (datasetId, id) => { if (id) { instanceIds.add(id); datasetByInstance.set(id, datasetId); } };
  const addCommit = (sha) => { if (sha) baseCommits.add(sha); };
  const addPair = (repo, commit) => { if (repo && commit) pairs.add(pairKey(repo, commit)); };

  for (const ds of data?.datasets ?? []) {
    for (const id of ds.instance_ids ?? []) addInstance(ds.id, normId(id));
    for (const sha of ds.base_commits ?? []) { addCommit(normCommit(sha)); }
    // A dataset entry may also carry explicit pairs.
    for (const p of ds.repo_commit_pairs ?? []) addPair(p.repo, p.base_commit);
  }
  const extra = data?.extra_blocked ?? {};
  for (const id of extra.instance_ids ?? []) addInstance('extra_blocked', normId(id));
  for (const sha of extra.base_commits ?? []) addCommit(normCommit(sha));
  for (const p of extra.repo_commit_pairs ?? []) addPair(p.repo, p.base_commit);

  function isBlocked(candidate) {
    const { instanceId, repo, baseCommit } = extractIds(candidate);
    if (instanceId && instanceIds.has(instanceId)) {
      return { blocked: true, reason: 'instance_id', matched: instanceId, dataset: datasetByInstance.get(instanceId) ?? null };
    }
    if (baseCommit && baseCommits.has(baseCommit)) {
      return { blocked: true, reason: 'base_commit', matched: baseCommit, dataset: null };
    }
    if (repo && baseCommit && pairs.has(pairKey(repo, baseCommit))) {
      return { blocked: true, reason: 'repo+base_commit', matched: pairKey(repo, baseCommit), dataset: null };
    }
    return false;
  }

  /**
   * Filter an array of records. EVERY dropped record is logged — via the
   * supplied logger (function receiving one object per drop) and in the
   * returned `dropped` array. Default logger writes to stderr.
   */
  function filterRecords(records, { source: src = 'unknown', logger, log } = {}) {
    const emit = typeof logger === 'function' ? logger
      : typeof log === 'function' ? log
      : (entry) => console.error(`[blocklist] DROP ${JSON.stringify(entry)}`);
    const kept = [];
    const dropped = [];
    for (const record of records) {
      const hit = isBlocked(record);
      if (hit) {
        const entry = { source: src, ...extractIds(record), reason: hit.reason, matched: hit.matched, dataset: hit.dataset, at: new Date().toISOString() };
        dropped.push({ record, ...entry });
        emit(entry);
      } else {
        kept.push(record);
      }
    }
    return { kept, dropped };
  }

  function coverage() {
    return (data?.datasets ?? []).map((ds) => ({
      id: ds.id,
      name: ds.name,
      split: ds.split,
      expected_count: ds.expected_count ?? null,
      expanded_instances: (ds.instance_ids ?? []).length,
      expanded_base_commits: (ds.base_commits ?? []).length,
      repos_listed: (ds.repos ?? []).length,
      expanded: (ds.instance_ids ?? []).length > 0,
    }));
  }

  return { isBlocked, filterRecords, coverage, sets: { instanceIds, baseCommits, pairs }, data, source };
}

/** Load + parse the blocklist JSON (default: eval_blocklist.json beside this file). */
export function loadBlocklist(path = DEFAULT_BLOCKLIST_PATH) {
  if (!existsSync(path)) throw new Error(`blocklist not found: ${path}`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return createBlocklist(data, { source: path });
}

/**
 * Expand blocklist data with every instance_id / repo / base_commit found in a
 * downloaded dataset file (JSONL or a JSON array). Mutates and returns `data`,
 * plus a report. This is the ONLY supported way instance IDs enter the file —
 * from the canonical dataset, never from memory.
 */
export function expandBlocklistData(data, records, datasetId) {
  const ds = (data.datasets ?? []).find((d) => d.id === datasetId);
  if (!ds) throw new Error(`unknown dataset id "${datasetId}" — known: ${(data.datasets ?? []).map((d) => d.id).join(', ')}`);
  ds.instance_ids = ds.instance_ids ?? [];
  ds.base_commits = ds.base_commits ?? [];
  ds.repo_commit_pairs = ds.repo_commit_pairs ?? [];
  const seenIds = new Set(ds.instance_ids);
  const seenCommits = new Set(ds.base_commits);
  const seenPairs = new Set(ds.repo_commit_pairs.map((p) => pairKey(p.repo, p.base_commit)));
  let addedIds = 0, addedCommits = 0, addedPairs = 0, rows = 0;
  for (const rec of records) {
    rows++;
    const { instanceId, repo, baseCommit } = extractIds(rec);
    if (instanceId && !seenIds.has(instanceId)) { seenIds.add(instanceId); ds.instance_ids.push(instanceId); addedIds++; }
    if (baseCommit && !seenCommits.has(baseCommit)) { seenCommits.add(baseCommit); ds.base_commits.push(baseCommit); addedCommits++; }
    if (repo && baseCommit && !seenPairs.has(pairKey(repo, baseCommit))) {
      seenPairs.add(pairKey(repo, baseCommit));
      ds.repo_commit_pairs.push({ repo, base_commit: baseCommit });
      addedPairs++;
    }
  }
  ds.instance_ids.sort();
  ds.base_commits.sort();
  return { dataset: datasetId, rows, addedIds, addedCommits, addedPairs, totalInstances: ds.instance_ids.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function readRecordsFile(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function parseCli(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

function main(argv) {
  const args = parseCli(argv);
  const [cmd, a, b] = args._;
  const blocklistPath = args.blocklist ? resolve(String(args.blocklist)) : DEFAULT_BLOCKLIST_PATH;

  if (cmd === 'coverage') {
    const bl = loadBlocklist(blocklistPath);
    for (const c of bl.coverage()) {
      console.log(`${c.expanded ? 'EXPANDED ' : 'SEED-ONLY'} ${c.id} (${c.split}) — ${c.expanded_instances} instance IDs, ${c.expanded_base_commits} base commits, ${c.repos_listed} repos listed, expected ~${c.expected_count ?? '?'}`);
    }
    const unexpanded = bl.coverage().filter((c) => !c.expanded);
    if (unexpanded.length) console.error(`\nwarning: ${unexpanded.length} dataset(s) are seed-only — instance-level matching is NOT active for them yet.`);
    return 0;
  }

  if (cmd === 'expand') {
    if (!a || !args.dataset) { console.error('usage: blocklist.mjs expand <dataset.jsonl> --dataset <id> [--out <path>]'); return 2; }
    const data = JSON.parse(readFileSync(blocklistPath, 'utf8'));
    const report = expandBlocklistData(data, readRecordsFile(resolve(a)), String(args.dataset));
    data.updated = new Date().toISOString().slice(0, 10);
    const outPath = args.out ? resolve(String(args.out)) : blocklistPath;
    writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`expanded ${report.dataset}: ${report.rows} rows → +${report.addedIds} instance IDs, +${report.addedCommits} base commits, +${report.addedPairs} repo+commit pairs (total ${report.totalInstances} IDs) → ${outPath}`);
    return 0;
  }

  if (cmd === 'check' || cmd === 'filter') {
    if (!a) { console.error(`usage: blocklist.mjs ${cmd} <records.jsonl> ${cmd === 'filter' ? '<kept.jsonl>' : ''} [--log <drops.jsonl>]`); return 2; }
    const bl = loadBlocklist(blocklistPath);
    const records = readRecordsFile(resolve(a));
    const logPath = args.log ? resolve(String(args.log)) : null;
    const { kept, dropped } = bl.filterRecords(records, {
      source: a,
      logger: (entry) => { console.error(`[blocklist] DROP ${JSON.stringify(entry)}`); if (logPath) appendFileSync(logPath, JSON.stringify(entry) + '\n'); },
    });
    console.log(`${a}: ${records.length} records → ${kept.length} kept, ${dropped.length} dropped (all drops logged)`);
    if (cmd === 'filter') {
      if (!b) { console.error('filter requires an output path for the kept records'); return 2; }
      writeFileSync(resolve(b), kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
      console.log(`kept records written to ${b}`);
    }
    return dropped.length && cmd === 'check' ? 1 : 0;
  }

  console.error('usage: blocklist.mjs <coverage|expand|check|filter> …  (see file header)');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
