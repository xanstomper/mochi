// Subagent panel (W3-4): renders the spawn ledger — one row per child agent
// (running or finished) with its live token spend — as a bounded block pinned
// directly above the status bar. Pure renderer: entries in, rows out, every
// TUI effect stays in app.ts. Fed by state.spawnLedger, which is reduced from
// the same spawn events the agent-forge ledger records from
// (subagent:started / subagent:completed) plus each child's usage:updated.
import { T, visibleLen, ellipsize, padEnd } from './view.js';
import type { SpawnLedgerEntry } from './state.js';

/** Rows the panel will occupy for `entryCount` ledger entries: at most
 *  `maxRows` children plus one `+N more` summary row when truncated. The
 *  chrome layout consumes this to reserve geometry BEFORE rendering. */
export function subagentPanelRowCount(entryCount: number, maxRows = 4): number {
  if (entryCount <= 0) return 0;
  return Math.min(entryCount, maxRows) + (entryCount > maxRows ? 1 : 0);
}

/** Compact token figure: 1234 → '1.2k'. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function statusGlyph(status: SpawnLedgerEntry['status']): string {
  switch (status) {
    case 'running': return `${T.warning}◆${T.reset}`;
    case 'done': return `${T.success}✓${T.reset}`;
    case 'failed': return `${T.error}×${T.reset}`;
  }
}

function statusWord(status: SpawnLedgerEntry['status']): string {
  switch (status) {
    case 'running': return `${T.warning}running${T.reset}`;
    case 'done': return `${T.grayDark}done${T.reset}`;
    case 'failed': return `${T.error}failed${T.reset}`;
  }
}

/** Panel row order: live children first (longest-running on top — the one
 *  that needs attention), then finished children, most recent first. */
export function spawnLedgerPanelOrder(entries: SpawnLedgerEntry[]): SpawnLedgerEntry[] {
  const running = entries.filter((e) => e.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
  const finished = entries.filter((e) => e.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return [...running, ...finished];
}

/** Render the spawn-ledger panel. Bounded by maxRows; when more children
 *  exist, the last row is a `+N more` line so the panel never eats the
 *  transcript. */
export function renderSubagentPanel(
  entries: SpawnLedgerEntry[],
  width: number,
  opts: { now?: number; maxRows?: number } = {},
): string[] {
  if (entries.length === 0) return [];
  const now = opts.now ?? Date.now();
  const maxRows = opts.maxRows ?? 4;
  const ordered = spawnLedgerPanelOrder(entries);
  const shown = ordered.slice(0, maxRows);
  const rows: string[] = [];
  for (const e of shown) {
    const glyph = statusGlyph(e.status);
    const role = `${T.fg}${ellipsize(e.role, 14)}${T.reset}`;
    const id = `${T.grayDark}#${e.id.slice(-4)}${T.reset}`;
    const state = statusWord(e.status);
    const spend = `${T.gray}${fmtTokens(e.tokens)} tok${T.reset}`;
    if (width >= 64) {
      const elapsed = e.status === 'running'
        ? ` ${T.grayDark}${Math.max(0, Math.round((now - e.startedAt) / 1000))}s${T.reset}`
        : '';
      rows.push(`${glyph} ${role}${id} ${T.grayDark}·${T.reset} ${state} ${T.grayDark}·${T.reset} ${spend}${elapsed}`);
    } else if (width >= 40) {
      rows.push(`${glyph} ${role} ${state} ${spend}`);
    } else {
      rows.push(`${glyph} ${role} ${spend}`);
    }
  }
  const more = ordered.length - shown.length;
  if (more > 0) rows.push(`${T.grayDark}  +${more} more child${more === 1 ? '' : 'ren'}${T.reset}`);
  // Every row fits its width: ellipsize by VISIBLE length (ANSI-safe), then
  // pad to the bar width so overwrite-style frames don't leave ghost chars.
  return rows.map((r) => padEnd(visibleLen(r) > width ? ellipsize(r, width) : r, width));
}
