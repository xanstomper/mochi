// CLI surface for cost-per-solve routing (`mochi costs …`). Kept out of
// cli.ts (which only dispatches here), following the gate-cli pattern.
//
//   mochi costs routing              # print the stored routing table
//   mochi costs routing --rebuild    # re-derive it from the run traces first
//   mochi costs routing --json       # machine-readable table
//
// The table is derived from THIS workspace's recorded run history
// (.mochi/traces) by the same stats pass the sleep-time orchestrator runs.
// Until enough runs exist, cells read INSUFFICIENT-DATA and routing keeps
// the configured default — the table shows that honestly instead of
// dressing a guess up as a measurement.
import { resolve } from 'node:path';
import {
  loadRoutingTable, refreshRoutingTable,
  type RoutingTable,
} from './routing-table.js';

export interface CostsCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi costs routing [--rebuild] [--min-samples <n>] [--json]

The routing table holds, per (task kind × model), the MEASURED
cost-per-solve from this workspace's run traces: total recorded cost of
every run that started on the model, divided by the runs the verifier
passed. Runs start on the cheapest PROVEN model for their kind and
escalate up the measured ladder only on failure evidence. Cells below
--min-samples runs are INSUFFICIENT-DATA and never steer routing.`;

function fmtUsd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(4)}`;
}

export function renderRoutingTableMd(table: RoutingTable): string {
  const lines: string[] = [];
  lines.push(`Routing table — derived ${new Date(table.derivedAt).toISOString()} from ${table.runsConsidered} runs (${table.runsSkipped} skipped: no usage records), min samples ${table.minSamples}.`);
  if (!table.cells.length) {
    lines.push('No cells yet: no attributable run history. Routing keeps the configured default until runs accumulate.');
    return lines.join('\n');
  }
  const kinds = [...new Set(table.cells.map((c) => c.kind))].sort();
  for (const kind of kinds) {
    lines.push('');
    lines.push(`kind: ${kind}`);
    lines.push('  model                          runs  solved  rate     cost/solve  status');
    for (const c of table.cells.filter((x) => x.kind === kind)) {
      const status = !c.sufficient
        ? 'INSUFFICIENT-DATA'
        : !c.priced
          ? 'unpriced (never a target)'
          : c.costPerSolveUsd === null
            ? 'no measured solve'
            : 'PROVEN';
      const flags = [
        c.escalatedRuns ? `${c.escalatedRuns} escalated` : '',
        c.costIncomplete ? 'cost coverage incomplete' : '',
      ].filter(Boolean).join(', ');
      lines.push(
        `  ${c.model.padEnd(30)} ${String(c.runs).padStart(4)}  ${String(c.solvedRuns).padStart(6)}  ${(c.solveRate * 100).toFixed(0).padStart(4)}%  ${fmtUsd(c.costPerSolveUsd).padStart(10)}  ${status}${flags ? ` (${flags})` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export async function handleCostsCommand(args: CostsCliArgs): Promise<void> {
  const sub = args.positional[1] ?? 'routing';
  if (sub !== 'routing') {
    console.log(USAGE);
    return;
  }
  const stateDir = resolve(args.cwd, '.mochi');
  const minSamples = typeof args.flags['min-samples'] === 'string' && Number.isFinite(Number(args.flags['min-samples']))
    ? Number(args.flags['min-samples'])
    : undefined;
  let table = loadRoutingTable(stateDir);
  if (args.flags.rebuild || !table) {
    table = refreshRoutingTable(stateDir, { ...(minSamples !== undefined ? { minSamples } : {}) });
    if (!args.flags.rebuild && table.runsConsidered === 0) {
      // First-ever look with no history: say so plainly, and leave the
      // (empty) table persisted so the state is inspectable either way.
      console.log('No routing table yet and no run history to derive one from. Routing stays on the configured default until runs accumulate (the sleep-time pass re-derives the table as history grows).');
      return;
    }
  }
  if (args.flags.json) {
    console.log(JSON.stringify(table, null, 2));
    return;
  }
  console.log(renderRoutingTableMd(table));
}
