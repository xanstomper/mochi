// CLI surface for sleep-time consolidation (`mochi sleeptime …`). Kept out
// of cli.ts (which only dispatches here), mirroring evals/gate-cli.ts.
//
//   mochi sleeptime [--cap <usd>] [--dry-run] [--json] [--night YYYY-MM-DD]
//
// Runs the D11 orchestrator (src/sleeptime/orchestrator.ts) over the current
// workspace: skill repair → curator → frozen-gate integrity → repo health
// scan → curriculum, under a HARD spend cap, idempotent per night, with the
// structured morning report written to .mochi/reports/sleeptime-<night>.{md,json}.
//
// The cap resolves as: --cap flag → MOCHI_SLEEPTIME_CAP_USD env →
// DEFAULT_SLEEPTIME_CAP_USD. Exit codes: 0 = night completed (cap stops and
// duplicates are normal outcomes, reported in the summary), 1 = a step
// failed, 3 = bad arguments / orchestrator error.
import { runSleeptime, DEFAULT_SLEEPTIME_CAP_USD, type SleeptimeReport } from './orchestrator.js';

export interface SleeptimeCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi sleeptime [--cap <usd>] [--dry-run] [--json] [--night YYYY-MM-DD]

Sleep-time consolidation: one nightly pipeline run (skill repair, curator,
frozen-gate integrity, curriculum generation) under a hard spend cap.
Idempotent per night — re-running skips work already done. The morning
report lands in .mochi/reports/sleeptime-<night>.md (JSON alongside).
Cap precedence: --cap → MOCHI_SLEEPTIME_CAP_USD → $${DEFAULT_SLEEPTIME_CAP_USD}.`;

function resolveCapUsd(flags: Record<string, string | boolean>): number {
  const raw = typeof flags.cap === 'string' ? flags.cap : process.env.MOCHI_SLEEPTIME_CAP_USD;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    throw new Error(`bad spend cap "${raw}" — expected a USD amount >= 0`);
  }
  return DEFAULT_SLEEPTIME_CAP_USD;
}

export function printSleeptimeReport(report: SleeptimeReport, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`🌙 ${report.summary}`);
  for (const s of report.steps) {
    console.log(`  ${s.id} [${s.status}]${s.detail ? ` — ${s.detail}` : ''}`);
    for (const u of s.units) {
      if (u.status === 'failed' || u.status === 'skipped-cap') {
        console.log(`    ✗ [${u.status}] ${u.title}: ${u.detail}`);
      }
    }
  }
  if (report.reportPaths) console.log(`  report: ${report.reportPaths.md}`);
}

export async function handleSleeptimeCommand({ positional, flags, cwd }: SleeptimeCliArgs): Promise<void> {
  const sub = positional[1];
  if (sub === 'help' || sub === '--help') {
    console.log(USAGE);
    return;
  }
  if (sub !== undefined && sub !== 'run') {
    console.log(USAGE);
    process.exitCode = 3;
    return;
  }
  try {
    const report = await runSleeptime({
      projectDir: cwd,
      spendCapUsd: resolveCapUsd(flags),
      dryRun: !!flags['dry-run'],
      ...(typeof flags.night === 'string' ? { nightKey: flags.night } : {}),
    });
    printSleeptimeReport(report, !!flags.json);
    const anyFailed = report.steps.some((s) => s.status === 'failed' || s.status === 'partial');
    process.exitCode = anyFailed ? 1 : 0;
  } catch (e) {
    console.error(`sleeptime: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 3;
  }
}
