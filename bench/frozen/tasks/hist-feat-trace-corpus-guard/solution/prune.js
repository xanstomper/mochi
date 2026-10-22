// Canned solution: trace pruning with the corpus-protection exception,
// ported from src/observability/trace.ts as of b0b113c (feat(retention):
// never prune or GC a completed run's trace before its trajectory is
// exported). The three guard helpers are the fix's own, verbatim apart from
// TypeScript types; pruneTraces is the fixture's version plus the fix's
// victim-sparing block.
const { existsSync, readdirSync, readFileSync, unlinkSync, statSync } = require('node:fs');
const { basename, resolve } = require('node:path');

/** Run ids that already have a durable trajectory export on disk.
 *  Exports live at `<workspace>/exports/trajectory-<runId>.jsonl` and survive
 *  trace pruning, so once an export exists the raw trace is redundant. This
 *  scans file *names* only (no contents) once per prune/GC pass — cheap, and
 *  with no index file to keep in sync or repair if it is lost/corrupted. */
function exportedTrajectoryRunIds(workspaceDir) {
  const ids = new Set();
  try {
    const dir = resolve(workspaceDir, 'exports');
    if (!existsSync(dir)) return ids;
    for (const f of readdirSync(dir)) {
      const m = /^trajectory-(.+)\.jsonl$/.exec(f);
      if (m) ids.add(m[1]);
    }
  } catch { /* best effort: no readable exports dir => nothing is exported */ }
  return ids;
}

/** True when a trace file records a terminal outcome — a `task:completed`
 *  or `task:failed` entry. Such a run is finished: its trace is a
 *  completed-run record (the distillation / SFT corpus), not leftover debris
 *  from a crashed or still-running process. Malformed lines are skipped; an
 *  unreadable file counts as not-completed. */
function traceFileHasTerminalEvent(filePath) {
  try {
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const kind = JSON.parse(line).kind;
        if (kind === 'task:completed' || kind === 'task:failed') return true;
      } catch { /* skip malformed line */ }
    }
  } catch { /* unreadable => not completed */ }
  return false;
}

/** Corpus protection: a completed run's trace must not be deleted until its
 *  trajectory export exists, because the raw trace is the only copy of the
 *  step-level record the export is built from. Incomplete / crashed runs (no
 *  terminal event) get no protection, so disk stays bounded by the size of
 *  the unexported-completed corpus, not by all history. `exported` is the
 *  set from exportedTrajectoryRunIds(), scanned once by the caller so a pass
 *  over many files costs one readdir. */
function isUnexportedCompletedTrace(workspaceDir, filePath, exported) {
  const runId = basename(filePath, '.jsonl');
  if ((exported ?? exportedTrajectoryRunIds(workspaceDir)).has(runId)) return false;
  return traceFileHasTerminalEvent(filePath);
}

/** Retention policy for `<workspace>/traces`: keep the newest `maxFiles`
 *  runs AND stay under `maxBytes` total — oldest first out. Best-effort and
 *  never throws (a janitor must never break the agent). Returns the number
 *  of files removed.
 *
 *  Exception (corpus protection): a trace whose run completed but whose
 *  trajectory has not been exported yet is never pruned, even when that
 *  leaves the directory over the file/byte caps — the caps are a disk
 *  hygiene bound, the unexported corpus is the training/eval data. Only
 *  would-be victims are content-checked for a terminal event, so the
 *  common prune pass still costs just stats plus one exports readdir. */
function pruneTraces(workspaceDir, maxFiles = 100, maxBytes = 32 * 1024 * 1024) {
  let removed = 0;
  try {
    const dir = resolve(workspaceDir, 'traces');
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = resolve(dir, f);
        try {
          const st = statSync(p);
          return { p, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    const victims = new Set();
    for (let i = maxFiles; i < files.length; i++) victims.add(files[i].p);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of [...files].reverse()) {
      if (total <= maxBytes) break;
      if (!victims.has(f.p)) {
        victims.add(f.p);
        total -= f.size;
      }
    }
    // Spare unexported completed traces (see isUnexportedCompletedTrace):
    // they stay until exported, after which the export is the durable
    // record and the raw trace may be pruned like any other.
    if (victims.size) {
      const exported = exportedTrajectoryRunIds(workspaceDir);
      for (const p of [...victims]) {
        if (isUnexportedCompletedTrace(workspaceDir, p, exported)) victims.delete(p);
      }
    }
    for (const p of victims) {
      try { unlinkSync(p); removed++; } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  return removed;
}

module.exports = { pruneTraces, exportedTrajectoryRunIds, traceFileHasTerminalEvent, isUnexportedCompletedTrace };
