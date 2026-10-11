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
import { renderMarkdown, statusBarRow1, statusBarRow2, composerHintRow, composerRow, renderDropdown, type StatusBarModel } from './view.js';
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

  it('renderMarkdown tables never exceed the given width at any terminal size', () => {
    const tableMd = [
      '| Project | Port | Service |',
      '|---|---|---|',
      '| Terminus – multi-agent terminal control plane | 9120 | terminus.service |',
      '| Hermes Dashboard – web UI + agent API | 9119 | hermes-dashboard.service |',
      '| Clash Royale Mission Control – autoplay + vision | 9125 | clash-webui.service |',
    ].join('\n');
    for (const w of WIDTHS) {
      const rows = renderMarkdown(tableMd, w);
      for (const row of rows) {
        expect(visibleLen(row), `width ${w}: table row overflow`)
          .toBeLessThanOrEqual(w);
      }
    }
  });

  it('statusBarRow1 and statusBarRow2 never exceed the given width at any terminal size', () => {
    const model: StatusBarModel = {
      modelId: 'opencode/deepseek-v4-flash-free',
      totalTokens: 148112,
      totalCost: 0.1192,
      maxInputTokens: 200000,
      mode: 'act',
      agentMode: 'spec',
      reasoningLevel: 'high',
      workspaceName: 'jewboy420-workspace-very-long-project-name',
      gitBranch: 'feature/windowed-mode-layout-polish',
      gitDiff: { files: 12, additions: 1420, deletions: 830 },
      autoApprove: true,
      extra: ['⚡ 3 subagents', '92 tok/s'],
    };

    for (const w of WIDTHS) {
      const r1 = statusBarRow1(model, w);
      expect(visibleLen(r1), `width ${w}: statusBarRow1 overflow: ${JSON.stringify(r1)}`).toBeLessThanOrEqual(w);
      // MCH-70+: plan/act toggle moved off row 1 (bars row at wide widths,
      // composer hint at narrow). Row 1 carries model/badges/context only.
      // Guard: row 1 must still show the model and never drop the context bar.
      expect(r1).toMatch(/deepseek|opencode/);

      const r2 = statusBarRow2(model, w);
      expect(visibleLen(r2), `width ${w}: statusBarRow2 overflow: ${JSON.stringify(r2)}`).toBeLessThanOrEqual(w);
    }
  });

  it('composer rows and dropdown never exceed the given width', () => {
    for (const w of WIDTHS) {
      const hint = composerHintRow(' ⏎ send · Tab plan/act · ESC stop · / for commands', w);
      expect(visibleLen(hint), `width ${w}: composerHintRow overflow`).toBeLessThanOrEqual(w);

      const cRow = composerRow('This is a test prompt that might be very long and exceed the terminal width by a lot', w);
      expect(visibleLen(cRow), `width ${w}: composerRow overflow`).toBeLessThanOrEqual(w);

      const dd = renderDropdown([
        { name: '/help', hint: 'Show all commands and keyboard shortcuts' },
        { name: '/mode', hint: 'Switch execution mode (spec/security/codemod)' },
      ], 0, w);
      for (const row of dd) {
        expect(visibleLen(row), `width ${w}: dropdown row overflow`).toBeLessThanOrEqual(w);
      }
    }
  });
});
