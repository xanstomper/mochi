// Sleeptime integration for the proactive repo health scan (Wave O3).
// The scan runs as one step of the EXISTING sleeptime pipeline — the
// daemon/cron schedule that already runs `mochi sleeptime` nightly picks
// it up with no second scheduler — and its digest headline lands in the
// morning report alongside repair/curator/gate/curriculum. The scan is
// model-free and $0; it declares no estimated usage, so it can never be
// stopped by (or counted against) the nightly spend cap. Per-night
// idempotency comes from the orchestrator's ledger (unit key
// 'health:scan'); the scan's own HEAD-keyed test cache makes re-runs
// cheap when the tree has not moved.
import type { PlannedStep, SleeptimeStep, SleeptimeStepContext, UnitOutcome } from '../sleeptime/orchestrator.js';
import { runHealthScan, type HealthScanOptions } from './health-scan.js';

export function createHealthScanStep(scanOpts: HealthScanOptions = {}): SleeptimeStep {
  return {
    id: 'health',
    title: 'Repo health scan',
    plan(): PlannedStep {
      return {
        units: [{ key: 'health:scan', title: 'Scan repo health (tests, deps, TODOs, dead code, hotspots)' }],
        note: 'proactive, read-only repo scan; digest in this report + .mochi/health/digest.md',
      };
    },
    async execute(_unit, ctx: SleeptimeStepContext): Promise<UnitOutcome> {
      const result = await runHealthScan(ctx.projectDir, { ...scanOpts, now: ctx.now });
      const top = result.findings.slice(0, 3).map((f) => `[${f.check}] ${f.title}`).join(' · ');
      return {
        detail: result.allClear
          ? `${result.headline} ${result.checks.filter((c) => c.status !== 'skipped').map((c) => c.note).join('; ')}. Digest: ${result.paths.digest}`
          : `${result.headline}${top ? ` Top: ${top}.` : ''} Digest: ${result.paths.digest}`,
      };
    },
  };
}
