// Startup budget guard (P2 speed, queue item 7 / task 1).
//
// COLD-START BUDGET (same machine, same toolchain — see
// ~/campaign/p2-speed-report.md for the full measurement):
//   info path   `mochi --version`  : median wall time <= 90ms   (measured ~50ms)
//   light cmd   `mochi status`     : median wall time <= 200ms  (measured ~110ms;
//                                  was 360-560ms before the lazy goal engine)
// `status` exercises the FULL startup path the light commands share — args,
// config load, workspace init, engine dispatch — without needing a model
// provider. A regression past budget (e.g. re-adding a heavy static import
// to cli.ts/runtime.ts, or eager goal-engine construction) fails here.
//
// The bench half (phase table) is npm run bench:startup-phases.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = resolve(ROOT, 'dist', 'cli.js');
const hasDist = existsSync(BIN);

// Budgets are medians over N spawns — a single slow run (CI jitter, disk)
// must not fail the gate, but a systematic regression must.
const RUNS = Number(process.env.STARTUP_BUDGET_RUNS ?? 9);
export const STARTUP_BUDGET_VERSION_MS = 90;
export const STARTUP_BUDGET_STATUS_MS = 200;

interface RunResult { wallMs: number; ok: boolean }

function runOnce(args: string[], cwd: string): RunResult {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  const wallMs = performance.now() - t0;
  return { wallMs, ok: r.status === 0 };
}

const median = (arr: number[]): number => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe.skipIf(!hasDist)('startup budget', () => {
  it('information path: `mochi --version` cold start within budget', () => {
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = runOnce(['--version'], ROOT);
      expect(r.ok, '--version must exit 0').toBe(true);
      times.push(r.wallMs);
    }
    const med = median(times);
    expect(med, `--version median cold start ${med.toFixed(1)}ms over ${RUNS} runs exceeds the ${STARTUP_BUDGET_VERSION_MS}ms budget (runs: ${times.map((t) => t.toFixed(0)).join(', ')})`)
      .toBeLessThanOrEqual(STARTUP_BUDGET_VERSION_MS);
  });

  it('light command: `mochi status` cold start within budget', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'mochi-budget-'));
    writeFileSync(resolve(fixture, 'package.json'), '{"name":"budget-fixture","version":"1.0.0","type":"module"}\n');
    try {
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const r = runOnce(['status'], fixture);
        expect(r.ok, 'status must exit 0').toBe(true);
        times.push(r.wallMs);
      }
      const med = median(times);
      expect(med, `status median cold start ${med.toFixed(1)}ms over ${RUNS} runs exceeds the ${STARTUP_BUDGET_STATUS_MS}ms budget (runs: ${times.map((t) => t.toFixed(0)).join(', ')})`)
        .toBeLessThanOrEqual(STARTUP_BUDGET_STATUS_MS);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('light commands do not build the goal engine (the lazy-load stays lazy)', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'mochi-lazy-'));
    writeFileSync(resolve(fixture, 'package.json'), '{"name":"lazy-fixture","version":"1.0.0","type":"module"}\n');
    try {
      const r = spawnSync(process.execPath, [BIN, 'status'], {
        cwd: fixture, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, MOCHI_STARTUP_TRACE: '1' },
      });
      const line = (r.stderr ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{"startupTrace"')).pop();
      expect(line, 'MOCHI_STARTUP_TRACE=1 must produce a startupTrace line').toBeTruthy();
      const phases = JSON.parse(line!).startupTrace.map(([n]: [string]) => n);
      // The lazy goal engine must NOT be built on a light command — that is
      // the whole startup-budget mechanism. If someone re-couples the eager
      // construction this fails.
      expect(phases).not.toContain('runtime:goals-build-start');
      // And the phases that MUST exist did.
      expect(phases).toContain('runtime:config-loaded');
      expect(phases).toContain('runtime-ready');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
