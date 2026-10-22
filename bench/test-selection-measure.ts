// P4 measurement harness (run with tsx; not part of the vitest suite):
//   node_modules/.bin/tsx bench/test-selection-measure.ts [repoDir] [worktreeDir] [maxSamples]
//
// Part 1 — historical diffs: for a sample of real commits, compare the
// legacy MCH-72 selector (selectRelatedTests) against the blast-radius
// selector (selectBlastRadiusTests) on the tree AT that commit: selected
// counts, fraction of the suite, selection latency.
// Part 2 (mutation recall) is driven separately — see RESULT.md.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectRelatedTests, isCodeFile, normalizeRel } from '../src/core/test-select.js';
import { buildImportGraph, selectBlastRadiusTests } from '../src/core/test-selection.js';

const repo = resolve(process.argv[2] ?? process.cwd());
const wt = process.argv[3] ?? '/tmp/ts-measure-wt';
const maxSamples = Number(process.argv[4] ?? 15);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

if (!existsSync(wt)) {
  git(repo, ['worktree', 'add', '--detach', wt, 'HEAD']);
}

const log = git(repo, ['log', '--format=%H', '-n', '120']).trim().split('\n');
interface Row {
  sha: string;
  subject: string;
  changed: number;
  totalTests: number;
  legacy: number;
  legacyMs: number;
  blast: number;
  blastMs: number;
  graphMs: number;
  blastOnly: string[];
  fullRun: boolean;
  fullReason?: string;
}
const rows: Row[] = [];
for (const sha of log) {
  if (rows.length >= maxSamples) break;
  const changed = git(repo, ['show', '--name-only', '--format=', sha])
    .split('\n')
    .map((s) => normalizeRel(s.trim()))
    .filter((f) => f.startsWith('src/') && isCodeFile(f) && !f.includes('/.revtmp'));
  // Cap at the legacy selector's own 12-file limit so both selectors are
  // compared on diffs the legacy policy would actually attempt.
  if (changed.length === 0 || changed.length > 12) continue;
  const subject = git(repo, ['show', '-s', '--format=%s', sha]).trim();
  git(repo, ['-C', wt, 'checkout', '-q', sha]);
  const g0 = Date.now();
  const graph = buildImportGraph(wt);
  const graphMs = Date.now() - g0;
  const t0 = Date.now();
  const legacy = selectRelatedTests(wt, changed);
  const legacyMs = Date.now() - t0;
  const t1 = Date.now();
  const blast = selectBlastRadiusTests(wt, changed, { graph, smoke: [] });
  const blastMs = Date.now() - t1;
  const legacySet = new Set(legacy.tests);
  rows.push({
    sha: sha.slice(0, 7),
    subject: subject.slice(0, 64),
    changed: changed.length,
    totalTests: graph.testFiles.length,
    legacy: legacy.tests.length,
    legacyMs,
    blast: blast.tests.length,
    blastMs,
    graphMs,
    blastOnly: blast.tests.filter((t) => !legacySet.has(t)),
    fullRun: blast.fullRun,
    ...(blast.fullRun ? { fullReason: blast.reasons[0] } : {}),
  });
}
git(repo, ['-C', wt, 'checkout', '-q', 'HEAD']);
console.log(JSON.stringify(rows, null, 2));
