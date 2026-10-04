// Render width harness — the permanent guard for the "windowed mode overflow"
// bug class. Every renderer that produces transcript rows must emit rows whose
// VISIBLE length (ANSI-stripped) never exceeds the width it was given, at any
// terminal width. This pins:
//   - renderSummary / renderMetricStrip at widths 26–110
//   - wrap() hard-splits overlong tokens (ANSI-aware)
// A failure here is how rows hard-wrap mid-ANSI in windowed panes and smear
// text across the status area — never ship a renderer that fails this file.
import { describe, it, expect } from 'vitest';
import { visibleLen, wrap } from './wrap.js';
import { renderSummary, renderMetricStrip } from './summary-render.js';
import type { SummaryDocument } from '../summary/engine.js';

const WIDTHS = [26, 30, 40, 50, 56, 60, 70, 80, 90, 100, 110];

function makeDoc(): SummaryDocument {
  return {
    status: 'complete',
    goal: 'Refactor the auth middleware and add regression tests for token refresh',
    overview: 'Modified 4 files, ran the focused vitest subset, all checks passed after fixing two imports.',
    files: [
      { path: 'src/auth/middleware.ts', op: 'modified' },
      { path: 'src/auth/tokens.ts', op: 'modified' },
      { path: 'src/auth/middleware.test.ts', op: 'added' },
      { path: 'src/auth/README.md', op: 'modified' },
    ],
    whatChanged: [
      { text: 'edit: src/auth/middleware.ts (+42/-18)' },
      { text: 'write: src/auth/middleware.test.ts (86 lines)' },
    ],
    verification: [
      { text: 'npx vitest run src/auth/middleware.test.ts — ✓' },
      { text: 'npx tsc --noEmit — ✓' },
    ],
    failures: [],
    warnings: [],
    references: [],
    next: [],
    metrics: [
      { label: 'FILES', value: '4 changed' },
      { label: 'CHECKS', value: '2 passed' },
      { label: 'TOKENS', value: '48,112' },
      { label: 'COST', value: '$0.0192' },
      { label: 'DURATION', value: '3m 42s' },
    ],
    populatedSections: ['overview', 'files', 'whatChanged', 'verification', 'metrics'],
  } as unknown as SummaryDocument;
}

describe('render width harness (windowed-overflow guard)', () => {
  it('renderSummary rows never exceed the given width at any terminal size', () => {
    const doc = makeDoc();
    for (const w of WIDTHS) {
      const rows = renderSummary(doc, w);
      for (const row of rows) {
        expect(visibleLen(row), `width ${w}: row too wide: ${JSON.stringify(row.slice(0, 80))}`)
          .toBeLessThanOrEqual(w);
      }
    }
  });

  it('renderMetricStrip rows never exceed the given width', () => {
    const metrics = [
      { label: 'FILES', value: '4 changed' },
      { label: 'CHECKS', value: '12 passed · 1 skipped' },
      { label: 'TOKENS', value: '148,112' },
      { label: 'COST', value: '$0.1192' },
      { label: 'DURATION', value: '13m 42s' },
      { label: 'TOOL CALLS', value: '37' },
    ];
    for (const w of WIDTHS) {
      const rows = renderMetricStrip(metrics, w);
      for (const row of rows) {
        expect(visibleLen(row), `width ${w}: strip row too wide`)
          .toBeLessThanOrEqual(w);
      }
    }
  });

  it('wrap() hard-splits unbreakable tokens to the exact width (ANSI-aware)', () => {
    const long = 'x'.repeat(200);
    const colored = `\x1b[38;2;250;178;131mbold-start\x1b[0m ${'y'.repeat(150)} end`;
    for (const w of WIDTHS) {
      for (const text of [long, colored]) {
        for (const row of wrap(text, w)) {
          expect(visibleLen(row), `width ${w}: wrapped row overflow`)
            .toBeLessThanOrEqual(w);
        }
      }
    }
  });
});
