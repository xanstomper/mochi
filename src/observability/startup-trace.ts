// Startup phase tracer (P2 speed, startup budget) — env-gated, zero-cost
// when off. Marks are performance.now() (ms since process boot), so the
// FIRST mark ("entry-eval") is the node-boot + module-resolution cost before
// the CLI entry itself starts evaluating.
//
//   MOCHI_STARTUP_TRACE=1 mochi status
//     → one stderr line before exit: {"startupTrace":[["entry-eval",12.3],…]}
//
// bench/startup-phases.mjs parses that line and reports the per-phase table
// (what loads, in what order, at what cost) and the total cold start.
const marks: Array<[string, number]> = [];
const T0 = performance.now(); // first evaluation of this module — near entry

/** Record a named startup phase (no-op unless MOCHI_STARTUP_TRACE=1). */
export function startupMark(name: string): void {
  if (process.env.MOCHI_STARTUP_TRACE !== '1') return;
  marks.push([name, performance.now()]);
}

/** Emit the trace once, on process exit. Idempotent. */
let wired = false;
export function startupTraceOnExit(): void {
  if (wired || process.env.MOCHI_STARTUP_TRACE !== '1') return;
  wired = true;
  process.on('exit', () => {
    try {
      process.stderr.write(JSON.stringify({ startupTrace: [['entry-eval', +T0.toFixed(1)], ...marks.map(([n, t]) => [n, +t.toFixed(1)])] }) + '\n');
    } catch { /* tracing must never break the process */ }
  });
}
