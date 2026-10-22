// CLI surface for the frozen regression gate (`mochi gate …`). Kept out of
// cli.ts (which only dispatches here) so the gate stays reviewable as a unit.
//
//   mochi gate run [--k 3] [--dry-run] [--diff <ref>] [--json] [--keep-work]
//   mochi gate baseline [--k 3] [--dry-run]     # explicit; never automatic
//   mochi gate freeze                           # re-pin hashes after a deliberate set change
//   mochi gate check                            # integrity + blocklist only
//
// Exit codes: 0 = PASS (or successful baseline/freeze/check),
//             1 = BLOCKED, 2 = PASS-WITH-OBJECTIONS (promotion still blocked),
//             3 = gate infrastructure error (tampered set, blocklist overlap,
//                 missing/mismatched baseline, bad diff ref).
import { join, resolve } from 'node:path';
import { createProvider } from '../model/router.js';
import type { ModelConfig } from '../types.js';
import {
  GateError, aggregate, assertNoBlocklistOverlap, freezeFrozenSet, loadBaseline,
  loadFrozenSet, passAt1, runGate, runGateForChange, updateBaseline,
  type GateReport, type ModelCaller,
} from './regression-gate.js';

export interface GateCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi gate run [--k 3] [--dry-run] [--diff <git-ref>] [--json] [--keep-work] [--timeout <sec>]
  mochi gate baseline [--k 3] [--dry-run]
  mochi gate freeze
  mochi gate check

The frozen regression gate (bench/frozen/) runs a hash-pinned task set against
the current build and compares it with the stored baseline under
distillation-pipeline §5.3 thresholds. 'baseline' is explicit and is never
updated by 'run'. Set MOCHI_GATE_ANALYSER_MODEL=provider/model (ideally a
different model family than the default) to enable the model analyser;
without it, a deterministic diff-risk checklist still applies.`;

function numFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function buildModelCaller(): ModelCaller | null {
  const spec = process.env.MOCHI_GATE_ANALYSER_MODEL;
  if (!spec || !spec.includes('/')) return null;
  const [provider, ...rest] = spec.split('/');
  const model = rest.join('/');
  const cfg: ModelConfig = { provider, baseUrl: '', model };
  return async ({ system, user }) => {
    const p = createProvider(cfg, 'review');
    const res = await p.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      [],
      { temperature: 0 },
    );
    return res.content ?? '';
  };
}

function printReport(report: GateReport, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const c = report.comparison;
  console.log(`GATE ${report.verdict} — pass@1 ${(c.basePassAt1 * 100).toFixed(1)}% → ${(c.chalPassAt1 * 100).toFixed(1)}% (Δ ${c.deltaPp >= 0 ? '+' : ''}${c.deltaPp.toFixed(1)}pp, 95% CI ${(c.ci95.low * 100).toFixed(1)}..${(c.ci95.high * 100).toFixed(1)}pp)`);
  console.log(`  frozen set v${report.setVersion} (${report.taskCount} tasks × k=${report.k})${report.dryRun ? ' [dry-run]' : ''}; analyser: ${report.analyserNote}`);
  for (const f of c.failures) console.log(`  ✗ ${f}`);
  for (const ob of report.objections) console.log(`  ⚠ [${ob.severity}/${ob.source}] ${ob.claim}`);
  if (report.reportPaths) console.log(`  report: ${report.reportPaths.md}`);
  console.log(`  ${report.powerNote}`);
}

export async function handleGateCommand({ positional, flags, cwd }: GateCliArgs): Promise<void> {
  const sub = positional[1];
  const frozenDir = typeof flags['frozen-dir'] === 'string' ? resolve(cwd, flags['frozen-dir']) : join(cwd, 'bench', 'frozen');
  const blocklistPath = join(cwd, 'bench', 'external', 'eval_blocklist.json');
  try {
    if (!sub) {
      console.log(USAGE);
      return;
    }
    if (sub === 'freeze') {
      const m = freezeFrozenSet(frozenDir);
      console.log(`Frozen set re-pinned: v${m.version}, ${m.tasks.length} tasks, set hash ${m.setHash.slice(0, 16)}…`);
      console.log('Any existing baseline is now invalid (set hash changed) — take a new one with `mochi gate baseline`.');
      return;
    }
    if (sub === 'check') {
      const set = loadFrozenSet(frozenDir);
      await assertNoBlocklistOverlap(set, blocklistPath);
      console.log(`Frozen set OK: v${set.manifest.version}, ${set.tasks.length} tasks, all hashes verified, no eval-blocklist overlap.`);
      return;
    }
    if (sub === 'baseline') {
      const b = await updateBaseline({
        repoRoot: cwd,
        frozenDir,
        k: numFlag(flags, 'k'),
        dryRun: !!flags['dry-run'],
        keepWork: !!flags['keep-work'],
        timeoutMs: (numFlag(flags, 'timeout') ?? 300) * 1000,
        mochiBin: typeof flags['mochi-bin'] === 'string' ? resolve(cwd, flags['mochi-bin']) : undefined,
      });
      const p = passAt1(aggregate(b.results, loadFrozenSet(frozenDir)));
      console.log(`Baseline stored: ${join(frozenDir, 'baseline.json')} — pass@1 ${(p * 100).toFixed(1)}% over ${b.results.trials.length} trials at git ${b.gitHead ?? 'unknown'}${b.dryRun ? ' [dry-run]' : ''}.`);
      return;
    }
    if (sub === 'run') {
      const opts = {
        repoRoot: cwd,
        frozenDir,
        k: numFlag(flags, 'k'),
        dryRun: !!flags['dry-run'],
        keepWork: !!flags['keep-work'],
        timeoutMs: (numFlag(flags, 'timeout') ?? 300) * 1000,
        mochiBin: typeof flags['mochi-bin'] === 'string' ? resolve(cwd, flags['mochi-bin']) : undefined,
        modelCaller: buildModelCaller(),
      };
      // Default diff for the analyser: baseline commit → now (the challenger
      // is everything since the incumbent was measured). --diff overrides.
      let report: GateReport;
      const diffFlag = typeof flags.diff === 'string' ? flags.diff : null;
      if (diffFlag) {
        report = await runGateForChange(diffFlag, opts);
      } else {
        let head: string | null = null;
        try { head = loadBaseline(join(frozenDir, 'baseline.json')).gitHead; } catch { /* runGate will raise the proper error */ }
        report = head ? await runGateForChange(head, opts) : await runGate(opts);
      }
      printReport(report, !!flags.json);
      process.exitCode = report.verdict === 'PASS' ? 0 : report.verdict === 'PASS-WITH-OBJECTIONS' ? 2 : 1;
      return;
    }
    console.log(USAGE);
    process.exitCode = 3;
  } catch (e) {
    if (e instanceof GateError) {
      console.error(`gate: ${e.message}`);
      process.exitCode = e.exitCode;
      return;
    }
    throw e;
  }
}
