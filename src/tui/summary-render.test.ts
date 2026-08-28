import { describe, it, expect } from 'vitest';
import { renderSummary, renderMetricStrip } from './summary-render.js';
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
  it('renders a compact header with a status glyph (no border box)', () => {
    const lines = renderSummary(sampleDoc(), 80);
    const plain = lines.map(stripAnsi).join('\n');
    expect(plain).toContain('SUMMARY');
    expect(plain).toContain(STATUS_GLYPH.completed);
    // No fixed-width box drawing anywhere in the card.
    expect(plain).not.toContain('╭');
    expect(plain).not.toContain('┌');
  });

  it('renders all four metrics on one strip line', () => {
    const lines = renderSummary(sampleDoc(), 80);
    const strip = lines.filter((l) => stripAnsi(l).includes('FILES'));
    expect(strip).toHaveLength(1);
    const plain = stripAnsi(strip[0]);
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

  it('renders failures with failed status glyph', () => {
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
    expect(maxLen).toBeLessThanOrEqual(40);
  });

  it('never emits stacked blank lines (compressed look)', () => {
    const lines = renderSummary(sampleDoc(), 80);
    for (let i = 1; i < lines.length; i++) {
      if (stripAnsi(lines[i]).trim() === '') {
        expect(stripAnsi(lines[i - 1]).trim()).not.toBe('');
      }
    }
  });

  it('color-codes change ops, paths, and verification commands (not all white)', () => {
    const lines = renderSummary(sampleDoc(), 80);
    const changeLine = lines.find((l) => stripAnsi(l).includes('runner.ts')) ?? '';
    expect(changeLine).toContain('\x1b[');
    const verifyLine = lines.find((l) => stripAnsi(l).includes('npm test')) ?? '';
    expect(verifyLine).toContain('\x1b[');
  });

  it('metric strip composes label/value pairs with separators', () => {
    const strip = renderMetricStrip([{ label: 'FILES', value: '2 changed' }, { label: 'CHECKS', value: '2 passed' }]);
    expect(strip).toHaveLength(1);
    const plain = stripAnsi(strip[0]);
    expect(plain).toContain('FILES 2 changed');
    expect(plain).toContain('·');
  });

  it('metric strip chunks at narrow widths instead of spilling', () => {
    const strip = renderMetricStrip([
      { label: 'FILES', value: '12 changed' },
      { label: 'CHECKS', value: '30 passed, 2 failed' },
      { label: 'TOOLS', value: '48 calls' },
      { label: 'DURATION', value: '125.4s' },
    ], 30);
    for (const l of strip) expect(visibleLen(l)).toBeLessThanOrEqual(30);
    expect(strip.length).toBeGreaterThan(1);
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
