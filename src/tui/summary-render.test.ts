import { describe, it, expect } from 'vitest';
import { renderSummary, renderMetricsGrid } from './summary-render.js';
import { STATUS_GLYPH, SEMANTIC_COLOR, paint, paintPriority, statusLabel } from './semantic.js';
import { stripAnsi } from './view.js';
import { visibleLen } from './wrap.js';
import type { SummaryDocument } from '../summary/engine.js';

function sampleDoc(): SummaryDocument {
  return {
    status: 'complete',
    overview: 'Modified 2 files. Verification: 2 passed.',
    metrics: [
      { label: 'FILES', value: '2 changed' },
      { label: 'CHECKS', value: '2 passed' },
      { label: 'TOOLS', value: '5 calls' },
      { label: 'DURATION', value: '21.4s' },
    ],
    whatChanged: [
      { text: 'edit: src/agent/runner.ts', priority: 'P1', detail: 'src/agent/runner.ts' },
      { text: 'write: src/summary/engine.ts', priority: 'P1' },
    ],
    verification: [
      { text: '✓ npm test', priority: 'P1', detail: '4200ms' },
      { text: '✓ npm run build', priority: 'P1' },
    ],
    failures: [],
    warnings: [{ text: 'Large diffs can exceed the viewport', priority: 'P2' }],
    references: [],
    next: [],
    populatedSections: ['overview', 'metrics', 'whatChanged', 'verification', 'warnings'],
  };
}

describe('summary renderer', () => {
  it('renders a header box with a status glyph', () => {
    const lines = renderSummary(sampleDoc(), 80);
    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('SUMMARY');
    expect(plain).toContain(STATUS_GLYPH.completed);
    expect(lines[0]).toContain('╭');
  });

  it('renders all four metrics in a grid', () => {
    const lines = renderSummary(sampleDoc(), 80);
    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('FILES');
    expect(plain).toContain('2 changed');
    expect(plain).toContain('CHECKS');
    expect(plain).toContain('TOOLS');
    expect(plain).toContain('DURATION');
  });

  it('omits empty sections (no empty headers)', () => {
    const doc = sampleDoc();
    doc.failures = [];
    doc.next = [];
    doc.references = [];
    const plain = renderSummary(doc, 80).map(stripAnsi).join('\n');
    expect(plain).not.toContain('FAILED');
    expect(plain).not.toContain('NEXT');
    expect(plain).toContain('WHAT CHANGED');
    expect(plain).toContain('VERIFICATION');
  });

  it('renders failures with P0 weight and failed status glyph', () => {
    const doc = sampleDoc();
    doc.status = 'failed';
    doc.failures = [{ text: 'npm test failed: 2 assertions', priority: 'P0' }];
    const lines = renderSummary(doc, 80);
    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('FAILED');
    expect(plain).toContain(STATUS_GLYPH.failed);
  });

  it('wraps long items at narrow widths without ANSI-length drift', () => {
    const doc = sampleDoc();
    doc.whatChanged = [{ text: 'edit: ' + 'x'.repeat(200), priority: 'P1' }];
    const lines = renderSummary(doc, 40);
    const maxLen = Math.max(...lines.map((l) => visibleLen(l)));
    expect(maxLen).toBeLessThanOrEqual(42);
  });

  it('metrics grid respects column count for 2 metrics', () => {
    const rows = renderMetricsGrid([{ label: 'FILES', value: '1' }, { label: 'CHECKS', value: '2' }], 60);
    expect(rows).toHaveLength(3); // top, body, bottom
  });
});

describe('semantic system', () => {
  it('every semantic category resolves to a non-empty color', () => {
    for (const key of Object.keys(SEMANTIC_COLOR) as Array<keyof typeof SEMANTIC_COLOR>) {
      expect(SEMANTIC_COLOR[key].length).toBeGreaterThan(0);
    }
  });

  it('glyphs are stable', () => {
    expect(STATUS_GLYPH.completed).toBe('✓');
    expect(STATUS_GLYPH.failed).toBe('✗');
    expect(STATUS_GLYPH.running).toBe('●');
    expect(STATUS_GLYPH.canceled).toBe('⊘');
  });

  it('paint wraps text in visible escapes that strip cleanly', () => {
    const s = paint('hello', 'FILE');
    expect(stripAnsi(s)).toBe('hello');
    expect(s).toContain('\x1b[');
    expect(stripAnsi(paintPriority('x', 'P0'))).toBe('x');
  });

  it('statusLabel composes glyph + name', () => {
    expect(stripAnsi(statusLabel('completed'))).toBe('✓ completed');
  });
});