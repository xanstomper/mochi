// Summary renderer (master rebuild Phase 19 + 43): renders a SummaryDocument
// as the Cline/Claude-Code-style structured summary — metrics grid box,
// priority-weighted sections, status header. Structure first: empty sections
// are never rendered; layout adapts to the populated sections.

import { T } from './view.js';
import { visibleLen, padEnd } from './view.js';
import { wrap } from './wrap.js';
import { paint, paintPriority, statusLabel, SEMANTIC_COLOR } from './semantic.js';
import type { Semantic } from './semantic.js';
import type { SummaryDocument, SummaryItem } from '../summary/engine.js';

/** Render the summary as styled transcript lines (caller prints them). */
export function renderSummary(doc: SummaryDocument, width = 80): string[] {
  const lines: string[] = [];
  const status: 'complete' | 'failed' | 'partial' = doc.status;
  const statusKind = status === 'complete' ? 'completed' : status === 'failed' ? 'failed' : 'warning';

  // Header box: SUMMARY + status
  const title = ` SUMMARY `;
  const right = statusLabel(statusKind as 'completed' | 'failed' | 'warning');
  const inner = Math.max(24, Math.min(width - 2, 60));
  const titleLen = visibleLen(title);
  const rightLen = visibleLen(right);
  const pad = Math.max(1, inner - titleLen - rightLen - 1);
  lines.push(`${T.grayDark}╭${'─'.repeat(inner)}╮${T.reset}`);
  lines.push(`${T.grayDark}│${T.reset}${T.bold}${title}${T.reset}${' '.repeat(pad)}${right}${T.reset} ${T.grayDark}│${T.reset}`);
  lines.push(`${T.grayDark}╰${'─'.repeat(inner)}╯${T.reset}`);

  // Metrics grid (2 columns of label/value cells)
  if (doc.metrics.length) {
    lines.push(...renderMetricsGrid(doc.metrics, Math.min(width - 2, inner)));
    lines.push('');
  }

  const section = (header: string, semantic: Semantic, items: SummaryItem[]) => {
    if (!items.length) return;
    lines.push(`${SEMANTIC_COLOR[semantic]}${header}${T.reset}`);
    lines.push(`${T.grayDark}${'─'.repeat(Math.min(header.length + 2, inner))}${T.reset}`);
    for (const item of items) {
      lines.push(...wrapPriorityItem(item, inner));
    }
    lines.push('');
  };

  if (doc.overview) {
    const wrappedOverview = wrap(doc.overview, inner);
    for (const l of wrappedOverview) {
      lines.push(`${T.fg}${l}${T.reset}`);
    }
    lines.push('');
  }
  section('WHAT CHANGED', 'CHANGE', doc.whatChanged);
  section('VERIFICATION', 'TEST', doc.verification);
  section('FAILED', 'ERROR', doc.failures);
  section('WARNINGS', 'WARNING', doc.warnings);
  section('REFERENCES', 'REFERENCE', doc.references);
  section('NEXT', 'PLAN', doc.next);

  return lines;
}

/** 2-column metrics grid: ┌ FILES ────┬ TESTS ───┐ style cells. */
export function renderMetricsGrid(metrics: Array<{ label: string; value: string }>, width: number): string[] {
  const cells = metrics.slice(0, 4).map((m) => ({
    label: m.label,
    value: m.value,
    color: metricColor(m.label),
  }));
  const rows: string[] = [];
  const cols = width < 50 ? 2 : cells.length >= 3 ? 3 : Math.max(1, cells.length);
  const colWidth = Math.max(8, Math.floor((width - (cols * 2)) / cols));
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    const top = row.map(() => `${T.grayDark}┌${'─'.repeat(colWidth)}┐${T.reset}`).join('');
    const body = row.map((c) => {
      const content = `${c.label} ${c.value}`;
      const rem = Math.max(0, colWidth - visibleLen(content));
      return `${T.grayDark}│${T.reset}${T.gray}${c.label}${T.reset} ${c.color}${c.value}${T.reset}${' '.repeat(rem)}${T.grayDark}│${T.reset}`;
    }).join('');
    const bot = row.map(() => `${T.grayDark}└${'─'.repeat(colWidth)}┘${T.reset}`).join('');
    if (i === 0) rows.push(top);
    rows.push(body);
    rows.push(bot);
  }
  return rows;
}

function metricColor(label: string): string {
  switch (label) {
    case 'FILES': return SEMANTIC_COLOR.FILE;
    case 'CHECKS': return SEMANTIC_COLOR.TEST;
    case 'TOOLS': return SEMANTIC_COLOR.TOOL;
    case 'DURATION': return SEMANTIC_COLOR.PERFORMANCE;
    default: return T.fg;
  }
}

/** Wrap a summary item at width, keeping its priority weight on every line. */
function wrapPriorityItem(item: SummaryItem, width: number): string[] {
  const maxLine = Math.max(10, width - 4);
  const plain = item.text;
  const wrapped = wrap(plain, maxLine);
  return wrapped.map((l) => `  ${paintPriority(l, item.priority)}`);
}