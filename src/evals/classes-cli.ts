// CLI surface for the task-class scorecard (`mochi bench classes …`). Kept
// out of cli.ts (which only dispatches here), like the gate's CLI.
//
//   mochi bench classes run [--k 3] [--dry-run | --live] [--class <id[,id]>] [--json]
//   mochi bench classes report [--json]     # latest recorded run (or current state)
//   mochi bench classes history [--json]    # every recorded run, oldest first
//   mochi bench classes check               # fixture integrity + disjointness only
//
// Exit codes: 0 = ok (UNMEASURED classes are information, not failure),
//             3 = infrastructure error (contaminated/tampered fixtures,
//                 malformed inbox result, missing live build).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GateError } from './regression-gate.js';
import {
  CLASS_DEFS, ClassError, classDef, currentStateSummaries, loadScorecardSets, readHistory,
  renderScorecardMd, renderScorecardTable, runScorecard,
  type ScorecardRecord,
} from './class-scorecard.js';

export interface BenchCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi bench classes run [--k 3] [--dry-run | --live] [--class <id[,id]>] [--json] [--keep-work]
  mochi bench classes report [--json]
  mochi bench classes history [--json]
  mochi bench classes check

One honest table for every kind of work: short, medium, complex, swe,
redteam, automation, browser. Every cell is traceable to recorded trials
or an ingested result file; a class with no evidence reports UNMEASURED.
Runs append to bench/classes/history.jsonl (append-only) and write a
report under .mochi/reports/. Fixture disjointness (vs the frozen gate
set, each other, and the eval blocklist) is verified before any run —
see bench/classes/README.md for the fixture/result integration contract.`;

function numFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function historyPath(flags: Record<string, string | boolean>, cwd: string): string {
  return typeof flags.history === 'string' ? resolve(cwd, flags.history) : join(cwd, 'bench', 'classes', 'history.jsonl');
}

function classFilter(flags: Record<string, string | boolean>): string[] | undefined {
  const v = flags.class;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) classDef(id); // validates, throws ClassError on typos
  return ids;
}

function printTableRecord(record: ScorecardRecord): void {
  console.log(`Task-class scorecard — ${record.ts} (git ${record.gitHead?.slice(0, 10) ?? 'unknown'}, ${record.mode}, k=${record.k})`);
  console.log('');
  console.log(renderScorecardTable(record.classes));
  for (const s of record.classes) {
    if (s.status === 'unmeasured') console.log(`  · ${s.label}: UNMEASURED — ${s.note ?? ''}`);
    else if (s.costSynthetic) console.log(`  · ${s.label}: $ costs are SYNTHETIC (price-table estimates over ${record.mode} token counts)`);
  }
}

export async function handleBenchCommand({ positional, flags, cwd }: BenchCliArgs): Promise<void> {
  const surface = positional[1];
  try {
    if (surface !== 'classes') {
      console.log(USAGE);
      if (surface) process.exitCode = 3;
      return;
    }
    const sub = positional[2] ?? 'report';

    if (sub === 'check') {
      const { sets, missing } = await loadScorecardSets(cwd);
      const parts = CLASS_DEFS.filter((d) => d.kind !== 'inbox').map((d) => {
        if (d.kind === 'frozen') return `${d.id}: frozen adapter (${sets.get(d.id)?.tasks.length ?? 0} tasks)`;
        return missing.has(d.id) ? `${d.id}: set missing (UNMEASURED)` : `${d.id}: ${sets.get(d.id)?.tasks.length ?? 0} tasks`;
      }).join('; ');
      console.log(`Scorecard fixtures OK — hashes verified, no eval-blocklist overlap, no content overlap (${parts}).`);
      return;
    }

    if (sub === 'run') {
      const record = await runScorecard({
        repoRoot: cwd,
        k: numFlag(flags, 'k') ?? 3,
        dryRun: !flags.live,
        classIds: classFilter(flags),
        historyPath: historyPath(flags, cwd),
        mochiBin: typeof flags['mochi-bin'] === 'string' ? resolve(cwd, flags['mochi-bin']) : undefined,
      });
      if (flags.json) {
        console.log(JSON.stringify(record, null, 2));
      } else {
        printTableRecord(record);
      }
      const reportsDir = join(cwd, '.mochi', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const stamp = record.ts.replace(/[:.]/g, '-');
      const mdPath = join(reportsDir, `classes-${stamp}.md`);
      const jsonPath = join(reportsDir, `classes-${stamp}.json`);
      writeFileSync(mdPath, renderScorecardMd(record));
      writeFileSync(jsonPath, JSON.stringify(record, null, 2) + '\n');
      console.log(`  report: ${mdPath}`);
      console.log(`  history: ${historyPath(flags, cwd)} (append-only)`);
      return;
    }

    if (sub === 'report') {
      const records = readHistory(historyPath(flags, cwd));
      if (!records.length) {
        const summaries = currentStateSummaries(cwd);
        if (flags.json) { console.log(JSON.stringify({ classes: summaries }, null, 2)); return; }
        console.log('Task-class scorecard — no recorded run yet (current state)');
        console.log('');
        console.log(renderScorecardTable(summaries));
        for (const s of summaries) {
          if (s.status === 'unmeasured') console.log(`  · ${s.label}: UNMEASURED — ${s.note ?? ''}`);
        }
        return;
      }
      const latest = records[records.length - 1];
      if (flags.json) { console.log(JSON.stringify(latest, null, 2)); return; }
      printTableRecord(latest);
      return;
    }

    if (sub === 'history') {
      const records = readHistory(historyPath(flags, cwd));
      if (flags.json) { console.log(JSON.stringify(records, null, 2)); return; }
      if (!records.length) { console.log('No recorded scorecard runs yet.'); return; }
      for (const r of records) {
        const cells = r.classes.map((s) => `${s.classId} ${s.status === 'measured' && s.passRate != null ? `${(s.passRate * 100).toFixed(1)}%` : 'UNMEASURED'}`);
        console.log(`${r.ts}  git ${r.gitHead?.slice(0, 10) ?? 'unknown'}  ${r.mode}  k=${r.k}  ${cells.join(' · ')}`);
      }
      return;
    }

    console.log(USAGE);
    process.exitCode = 3;
  } catch (e) {
    if (e instanceof ClassError || e instanceof GateError) {
      console.error(`bench classes: ${e.message}`);
      process.exitCode = e.exitCode;
      return;
    }
    throw e;
  }
}
