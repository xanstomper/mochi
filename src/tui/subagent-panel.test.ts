// Subagent panel renderer (W3-4): spawn-ledger rows — per-child status +
// token spend — in the existing tui component-test style (pure renderer,
// scripted inputs, stripAnsi assertions).
import { describe, it, expect } from 'vitest';
import { renderSubagentPanel, subagentPanelRowCount, spawnLedgerPanelOrder } from './subagent-panel.js';
import { visibleLen } from './view.js';
import type { SpawnLedgerEntry } from './state.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function entry(over: Partial<SpawnLedgerEntry> = {}): SpawnLedgerEntry {
  return {
    id: 'agent-1-sub-1a2b3c4d',
    role: 'coder',
    prompt: 'fix the flaky test',
    startedAt: 1_000,
    status: 'running',
    tokens: 0,
    ...over,
  };
}

describe('subagentPanelRowCount', () => {
  it('is zero for an empty ledger', () => {
    expect(subagentPanelRowCount(0)).toBe(0);
  });

  it('grows with entries up to the row cap, then adds one more-row line', () => {
    expect(subagentPanelRowCount(1)).toBe(1);
    expect(subagentPanelRowCount(4)).toBe(4);
    expect(subagentPanelRowCount(6)).toBe(5); // 4 children + '+2 more'
  });
});

describe('spawnLedgerPanelOrder', () => {
  it('runs live children first (longest-running on top), finished most-recent first', () => {
    const ordered = spawnLedgerPanelOrder([
      entry({ id: 'done-old', status: 'done', endedAt: 2_000 }),
      entry({ id: 'run-2', status: 'running', startedAt: 5_000 }),
      entry({ id: 'run-1', status: 'running', startedAt: 3_000 }),
      entry({ id: 'failed-new', status: 'failed', endedAt: 9_000 }),
      entry({ id: 'done-new', status: 'done', endedAt: 8_000 }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(['run-1', 'run-2', 'failed-new', 'done-new', 'done-old']);
  });
});

describe('renderSubagentPanel', () => {
  it('renders one row per child with status and token spend', () => {
    const rows = renderSubagentPanel(
      [entry({ tokens: 1234 })],
      90,
      { now: 46_000 },
    );
    expect(rows).toHaveLength(1);
    const plain = strip(rows[0]);
    expect(plain).toContain('◆');
    expect(plain).toContain('coder');
    expect(plain).toContain('#3c4d');
    expect(plain).toContain('running');
    expect(plain).toContain('1.2k tok');
    expect(plain).toContain('45s'); // (46_000 - 1_000) / 1000
  });

  it('shows finished children with their outcome glyph and final tokens', () => {
    const rows = renderSubagentPanel(
      [
        entry({ id: 'a-done', status: 'done', tokens: 3400, endedAt: 5_000 }),
        entry({ id: 'b-fail', status: 'failed', tokens: 120, endedAt: 6_000 }),
      ],
      90,
      { now: 9_000 },
    );
    expect(rows).toHaveLength(2);
    // Finished children render most-recent first: the failed child (endedAt
    // 6_000) takes row 0.
    expect(strip(rows[0])).toContain('×');
    expect(strip(rows[0])).toContain('failed');
    expect(strip(rows[1])).toContain('✓');
    expect(strip(rows[1])).toContain('3.4k tok');
    // No elapsed-time suffix for finished children: the row ends with the
    // token spend, not a seconds figure.
    expect(strip(rows[1]).trim()).toMatch(/tok$/);
    expect(strip(rows[1]).trim()).not.toMatch(/\d+s$/);
  });

  it('bounds the panel and summarizes the overflow', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      entry({ id: `child-${i}`, status: 'done', tokens: 10 * (i + 1), endedAt: 2_000 + i }));
    const rows = renderSubagentPanel(many, 90, { maxRows: 4 });
    expect(rows).toHaveLength(5);
    expect(strip(rows[4])).toContain('+2 more children');
  });

  it('compacts rows on narrow terminals', () => {
    const row = renderSubagentPanel([entry({ tokens: 500 })], 44, { now: 3_000 })[0];
    const plain = strip(row);
    expect(plain).toContain('coder');
    expect(plain).toContain('500 tok');
    expect(plain).not.toContain('#c4d');
    const tiny = renderSubagentPanel([entry({ tokens: 500 })], 30, { now: 3_000 })[0];
    expect(strip(tiny)).not.toContain('running');
  });

  it('every row fits and pads to the full width (no ghost chars on overwrite frames)', () => {
    const rows = renderSubagentPanel(
      [
        entry({ role: 'an-uncomfortably-long-role-name', tokens: 123_456 }),
        entry({ status: 'done', tokens: 42, endedAt: 2_000 }),
      ],
      50,
      { now: 3_000 },
    );
    for (const r of rows) {
      expect(visibleLen(r)).toBe(50);
    }
  });

  it('empty ledger renders no rows', () => {
    expect(renderSubagentPanel([], 90)).toEqual([]);
  });
});
