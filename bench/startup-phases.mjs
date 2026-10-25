// Startup phase breakdown bench (P2 speed, startup budget).
//
// Runs the REAL built CLI against a disposable fixture repo with
// MOCHI_STARTUP_TRACE=1 and reports, per phase, what loaded in what order at
// what cost — the visibility half of the startup budget. The budget guard
// itself lives in src/startup-budget.test.ts; this bench is the measurement
// tool behind the report numbers.
//
// Run:  npm run bench:startup-phases   (default: 12 runs of `status`)
//       N=20 CASE=version node bench/startup-phases.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = resolve(root, 'dist/cli.js');
const N = Number(process.env.N ?? 12);
const CASE = process.env.CASE ?? 'status';   // status | version | doctor

// Disposable fixture: a small git repo, so findProjectRoot/config discovery
// run against a controlled directory tree (not the mochi repo itself).
const fixture = mkdtempSync(resolve(tmpdir(), 'mochi-startup-'));
writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({ name: 'startup-fixture', version: '1.0.0', type: 'module' }) + '\n');
writeFileSync(resolve(fixture, 'main.ts'), 'export const main = (): number => 1;\n');
spawnSync('git', ['init', '-q'], { cwd: fixture });

const args = CASE === 'version' ? ['--version'] : [CASE];
const phaseTotals = new Map();
const totals = [];
let ok = 0;

for (let i = 0; i < N; i++) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...process.env, MOCHI_STARTUP_TRACE: '1' },
    timeout: 30_000,
  });
  const line = (r.stderr ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{"startupTrace"')).pop();
  if (!line) { console.error(`run ${i}: no startupTrace line (stderr tail: ${(r.stderr ?? '').split('\n').slice(-3).join(' | ')})`); continue; }
  let trace;
  try { trace = JSON.parse(line).startupTrace; } catch { continue; }
  ok++;
  totals.push(trace[trace.length - 1][1]); // last mark = end of measured startup
  for (let j = 0; j < trace.length; j++) {
    const [name, t] = trace[j];
    const prev = j > 0 ? trace[j - 1][1] : 0;
    phaseTotals.set(name, (phaseTotals.get(name) ?? 0) + (t - prev));
  }
}

rmSync(fixture, { recursive: true, force: true });
if (!ok) { console.error('no successful traced runs'); process.exit(1); }

const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\nstartup phase breakdown — ${CASE} (${ok}/${N} runs, fixture repo, ${process.execPath.split('/').slice(-3, -1).join('/')})`);
console.log(`  total (last mark)     : median ${median(totals).toFixed(1)}ms  avg ${(totals.reduce((a, b) => a + b, 0) / ok).toFixed(1)}ms`);
const rows = [...phaseTotals.entries()].map(([name, sum]) => ({ name, avg: sum / ok }));
rows.sort((a, b) => b.avg - a.avg);
console.log('  phase                          avg ms   share');
for (const r of rows) {
  const total = totals.reduce((a, b) => a + b, 0) / ok;
  console.log(`  ${r.name.padEnd(30)} ${r.avg.toFixed(1).padStart(7)}   ${(100 * r.avg / total).toFixed(1)}%`);
}
