// `mochi routing [show|derive]` — inspect and rebuild the measured routing
// table that the agent loop consults (src/observability/routing-table.ts).
//
//   mochi routing                 # show the stored table (default)
//   mochi routing show [--json]
//   mochi routing derive [--min-samples N] [--json]
//
// The table is derived from THIS workspace's exported trajectories: per task
// kind × model, how many runs, how many the verifier marked solved, and the
// cost per solve. A cold start (no table) is normal and leaves the configured
// model untouched. MOCHI_ROUTING=0 disables routing at run time.
import { resolve } from 'node:path';
import {
  DEFAULT_ROUTING_MIN_SAMPLES,
  deriveRoutingTable,
  loadRoutingTable,
  routingTablePath,
  refreshRoutingTable,
  type RoutingTable,
} from './routing-table.js';

export interface RoutingCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi routing [show] [--json]            show the measured routing table
  mochi routing derive [--min-samples N]   rebuild it from exported trajectories

Notes:
  The table lives at .mochi/state/routing-table.json and only steers runs when
  a cell has at least --min-samples runs (default ${DEFAULT_ROUTING_MIN_SAMPLES}).
  An explicitly configured/pinned model is never overridden.`;

export async function handleRoutingCommand(args: RoutingCliArgs): Promise<void> {
  const sub = (args.positional[1] ?? 'show').toLowerCase();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return;
  }
  const workspace = resolve(args.cwd, '.mochi');
  const minSamplesFlag = args.flags['min-samples'];
  const minSamples = typeof minSamplesFlag === 'string' && Number.isFinite(Number(minSamplesFlag))
    ? Math.max(1, Math.floor(Number(minSamplesFlag)))
    : DEFAULT_ROUTING_MIN_SAMPLES;

  if (sub === 'derive') {
    const table = deriveRoutingTable(workspace, { minSamples });
    if (args.flags.json) {
      console.log(JSON.stringify(table, null, 2));
      return;
    }
    console.log(`Derived ${table.cells.length} cell(s) from exported trajectories → ${routingTablePath(workspace)}`);
    printTable(table);
    return;
  }

  if (sub !== 'show') {
    console.error(`routing: unknown subcommand '${sub}'`);
    console.log(USAGE);
    process.exitCode = 3;
    return;
  }

  const table = loadRoutingTable(workspace);
  if (!table) {
    console.log(`No routing table at ${routingTablePath(workspace)} — the configured model stays in place.`);
    console.log('Run `mochi routing derive` after a few exported runs to build one.');
    return;
  }
  if (args.flags.json) {
    console.log(JSON.stringify(table, null, 2));
    return;
  }
  const ageMin = table.derivedAt > 0 ? Math.round((Date.now() - table.derivedAt) / 60_000) : null;
  console.log(`Routing table — ${table.cells.length} cell(s), min ${table.minSamples} runs/cell`
    + (ageMin === null ? '' : `, derived ${ageMin}m ago`));
  printTable(table);
}

function printTable(table: { cells: Array<{ taskKind: string; model: string; runs: number; solved: number; solveRate: number; costPerSolveUsd: number | null; sufficient: boolean }> }): void {
  if (table.cells.length === 0) {
    console.log('  (no cells — no exported run carried a model attribution)');
    return;
  }
  const kindWidth = Math.max(8, ...table.cells.map((c) => c.taskKind.length));
  const modelWidth = Math.max(8, ...table.cells.map((c) => c.model.length));
  console.log(`  ${'kind'.padEnd(kindWidth)}  ${'model'.padEnd(modelWidth)}  runs  solved  rate    $/solve  usable`);
  for (const c of table.cells) {
    const rate = `${Math.round(c.solveRate * 100)}%`.padEnd(6);
    const cost = c.costPerSolveUsd === null ? '—'.padEnd(8) : `$${c.costPerSolveUsd.toFixed(4)}`.padEnd(8);
    console.log(`  ${c.taskKind.padEnd(kindWidth)}  ${c.model.padEnd(modelWidth)}  ${String(c.runs).padStart(4)}  ${String(c.solved).padStart(6)}  ${rate}  ${cost}  ${c.sufficient ? 'yes' : 'no'}`);
  }
}

export interface CostsCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const COSTS_USAGE = `Usage:
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
  lines.push(`Routing table — derived ${new Date(table.derivedAt).toISOString()} (min samples ${table.minSamples}).`);
  if (!table.cells.length) {
    lines.push('No cells yet: no attributable run history. Routing keeps the configured default until runs accumulate.');
    return lines.join('\n');
  }
  const kinds = [...new Set(table.cells.map((c) => c.taskKind))].sort();
  for (const kind of kinds) {
    lines.push('');
    lines.push(`kind: ${kind}`);
    lines.push('  model                          runs  solved  rate     cost/solve  status');
    for (const c of table.cells.filter((x) => x.taskKind === kind)) {
      const status = !c.sufficient
        ? 'INSUFFICIENT-DATA'
        : c.costPerSolveUsd === null
            ? 'no measured solve'
            : 'PROVEN';
      const flags = '';
      lines.push(
        `  ${c.model.padEnd(30)} ${String(c.runs).padStart(4)}  ${String(c.solved).padStart(6)}  ${(c.solveRate * 100).toFixed(0).padStart(4)}%  ${fmtUsd(c.costPerSolveUsd).padStart(10)}  ${status}${flags ? ` (${flags})` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export async function handleCostsCommand(args: CostsCliArgs): Promise<void> {
  const sub = args.positional[1] ?? 'routing';
  if (sub !== 'routing') {
    console.log(COSTS_USAGE);
    return;
  }
  const stateDir = resolve(args.cwd, '.mochi');
  const minSamples = typeof args.flags['min-samples'] === 'string' && Number.isFinite(Number(args.flags['min-samples']))
    ? Number(args.flags['min-samples'])
    : undefined;
  let table = loadRoutingTable(stateDir);
  if (args.flags.rebuild || !table) {
    table = refreshRoutingTable(stateDir, { ...(minSamples !== undefined ? { minSamples } : {}) }) ?? table;
    if (!args.flags.rebuild && table.cells.length === 0) {
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
