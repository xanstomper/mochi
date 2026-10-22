// CLI surface for the proactive repo health scan (`mochi health`). Kept
// out of cli.ts (which only dispatches here), mirroring sleeptime/cli.ts.
//
//   mochi health [--json] [--force] [--offline]
//
// Runs one read-only scan NOW (the same scan the sleeptime pipeline runs
// nightly) and prints the digest. Test results are cached by HEAD —
// --force re-runs the test command anyway. --offline skips the dependency
// probe instead of letting it discover the network is gone. Exit codes:
// 0 = no high-severity findings, 1 = at least one high finding,
// 3 = bad arguments / scan error.
import { runHealthScan, type HealthScanResult } from './health-scan.js';

export interface HealthCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi health [--json] [--force] [--offline]

Proactive repo health scan: tests on HEAD (cached by HEAD hash), lockfile
age + dependency probe, TODO/FIXME delta, dead-code candidates, and churn
hotspots — ranked into one digest with evidence and expiry per finding.
Read-only: state lands in .mochi/health/, findings mirror into project
memory. The same scan runs nightly inside 'mochi sleeptime'.`;

export function printHealthDigest(result: HealthScanResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.digest.trimEnd());
}

export async function handleHealthCommand({ positional, flags, cwd }: HealthCliArgs): Promise<void> {
  const sub = positional[1];
  if (sub === 'help' || sub === '--help') {
    console.log(USAGE);
    return;
  }
  if (sub !== undefined) {
    console.log(USAGE);
    process.exitCode = 3;
    return;
  }
  try {
    const result = await runHealthScan(cwd, {
      forceTests: !!flags.force,
      offline: !!flags.offline,
    });
    printHealthDigest(result, !!flags.json);
    process.exitCode = result.findings.some((f) => f.severity === 'high') ? 1 : 0;
  } catch (e) {
    console.error(`health: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 3;
  }
}
