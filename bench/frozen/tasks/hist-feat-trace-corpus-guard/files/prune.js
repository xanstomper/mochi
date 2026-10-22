// Frozen-task fixture: trace pruning from src/observability/trace.ts as of
// b0b113c^ (the parent of the corpus-protection feature). Verbatim apart from
// TypeScript types and the CommonJS export. Policy: keep the newest maxFiles
// runs AND stay under maxBytes total — oldest first out. There is NO
// exception for completed-but-unexported runs: age/cap pressure destroys the
// only copy of a finished run's step-level record before its trajectory
// export is built from it.
const { existsSync, readdirSync, unlinkSync, statSync } = require('node:fs');
const { resolve } = require('node:path');

/** Retention policy for `<workspace>/traces`: keep the newest `maxFiles`
 *  runs AND stay under `maxBytes` total — oldest first out. Best-effort and
 *  never throws (a janitor must never break the agent). Returns the number
 *  of files removed. */
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
    for (const p of victims) {
      try { unlinkSync(p); removed++; } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  return removed;
}

module.exports = { pruneTraces };
