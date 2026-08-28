// Summary renderer (master rebuild Phase 19 + 43): renders a SummaryDocument
// as the Cline/Claude-Code-style structured summary — compact status header,
// one-line metric strip, priority-weighted sections. NO fixed-width box
// drawing: every line is plain content that reflows natively at any terminal
// width (windowed mode included), so the card never looks compressed.
// Structure first: empty sections are never rendered; layout adapts to the
// populated sections.
//
// Color contract: important tool calls, code edits, and prose are color-coded
// semantically instead of all-white — ops bold orange, paths cyan, checks
// green/red, warnings yellow, numbers in the theme's number color.

import { T, R } from './view.js';
import { wrap } from './wrap.js';
import { statusLabel, SEMANTIC_COLOR } from './semantic.js';
import type { Semantic } from './semantic.js';
import type { SummaryDocument, SummaryItem } from '../summary/engine.js';

/** Render the summary as styled transcript lines (caller prints them). */
export function renderSummary(doc: SummaryDocument, width = 80): string[] {
  const lines: string[] = [];
  const status: 'complete' | 'failed' | 'partial' = doc.status;
  const statusKind = status === 'complete' ? 'completed' : status === 'failed' ? 'failed' : 'warning';
  // Content width: leaves room for the transcript's 2-space gutter so lines
  // fit WITHOUT a second wrap pass in the renderer (no mid-ANSI re-splitting,
  // no compressed look in narrow/windowed terminals).
  const textWidth = Math.max(24, width - 2);

  // Compact status header: bold SUMMARY + colored status glyph. No border box.
  lines.push(`${T.bold}SUMMARY${T.reset}  ${statusLabel(statusKind as 'completed' | 'failed' | 'warning')}`);

  // Metric strip: one line of muted labels + colored values (no box cells).
  // Chunks onto multiple strip lines at narrow widths so it never spills
  // past the terminal (windowed mode stays clean).
  if (doc.metrics.length) {
    lines.push(...renderMetricStrip(doc.metrics, textWidth));
  }

  // Exactly one blank line between blocks (never stacks — kills the
  // "lots of enters" wall-of-gaps the per-line renderer produced).
  const gap = () => {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  };

  if (doc.overview) {
    for (const l of wrap(paintNumbers(doc.overview), textWidth)) lines.push(l);
    gap();
  }

  const section = (header: string, semantic: Semantic, items: SummaryItem[], painter: (line: string) => string) => {
    if (!items.length) return;
    gap();
    lines.push(`${SEMANTIC_COLOR[semantic]}${T.bold}${header}${T.reset}`);
    lines.push(`${SEMANTIC_COLOR[semantic]}${'─'.repeat(header.length)}${T.reset}`);
    for (const item of items) {
      for (const l of wrap(item.text, Math.max(10, textWidth - 2))) {
        lines.push(`  ${painter(l)}`);
      }
    }
  };

  section('WHAT CHANGED', 'CHANGE', doc.whatChanged, paintChangeLine);
  section('VERIFICATION', 'TEST', doc.verification, paintVerifyLine);
  section('FAILED', 'ERROR', doc.failures, (l) => `${T.error}${l}${T.reset}`);
  section('WARNINGS', 'WARNING', doc.warnings, (l) => `${T.warning}${l}${T.reset}`);
  section('REFERENCES', 'REFERENCE', doc.references, paintReferenceLine);
  section('NEXT', 'PLAN', doc.next, (l) => `${SEMANTIC_COLOR.PLAN}${l}${T.reset}`);

  return lines;
}

/** Metric strip: "FILES 2 changed · CHECKS 2 passed · …" — chunked to fit
 *  `width` visible columns (chunks only at metric boundaries, never mid-ANSI). */
export function renderMetricStrip(metrics: Array<{ label: string; value: string }>, width = 100): string[] {
  const sep = `${T.grayDark} · ${T.reset}`;
  const cells = metrics.slice(0, 6).map((m) => ({
    text: `${T.grayDark}${m.label}${T.reset} ${metricColor(m.label)}${m.value}${T.reset}`,
    vis: m.label.length + 1 + m.value.length,
  }));
  const out: string[] = [];
  let cur: typeof cells = [];
  let curVis = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push(cur.map((c) => c.text).join(sep));
    cur = [];
    curVis = 0;
  };
  for (const c of cells) {
    const add = cur.length ? 3 + c.vis : c.vis; // " · ".length = 3
    if (curVis + add > Math.max(12, width)) flush();
    cur.push(c);
    curVis += cur.length === 1 ? c.vis : 3 + c.vis;
  }
  flush();
  return out;
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

/** WHAT CHANGED line: "edit: path" → bold-orange op + cyan path, with
 *  "(+a/-d)" diff counts painted green/red. */
function paintChangeLine(line: string): string {
  const opM = /^([a-z][\w-]*):(.*)$/.exec(line);
  if (opM) {
    const op = `${T.orange}${T.bold}${opM[1]}:${T.reset}`;
    return `${op} ${paintPathAndDiff(opM[2].trimStart())}`;
  }
  return paintPathAndDiff(line);
}

function paintPathAndDiff(text: string): string {
  const dM = /^(.*\S)\s*\(\+(\d+)\/-(\d+)\)$/.exec(text);
  if (dM) {
    return `${SEMANTIC_COLOR.FILE}${dM[1]}${T.reset} (${T.success}+${dM[2]}${T.reset}/${T.error}-${dM[3]}${T.reset})`;
  }
  return `${SEMANTIC_COLOR.FILE}${text}${T.reset}`;
}

/** VERIFICATION line: ✓ green / ✗ red glyph, command text in COMMAND teal. */
function paintVerifyLine(line: string): string {
  if (line.startsWith('✓')) return `${T.success}✓${T.reset} ${SEMANTIC_COLOR.COMMAND}${line.slice(1).trim()}${T.reset}`;
  if (line.startsWith('✗')) return `${T.error}✗${T.reset} ${SEMANTIC_COLOR.COMMAND}${line.slice(1).trim()}${T.reset}`;
  return `${SEMANTIC_COLOR.COMMAND}${line}${T.reset}`;
}

/** REFERENCES line: "tool: output" → bold-orange tool name, muted output. */
function paintReferenceLine(line: string): string {
  const m = /^([\w-]+):\s*(.*)$/.exec(line);
  if (m) return `${T.orange}${T.bold}${m[1]}:${T.reset} ${T.grayDark}${m[2]}${T.reset}`;
  return line;
}

/** Bare counts in prose get the theme's number color (orange by default). */
function paintNumbers(text: string): string {
  return text.replace(/\b\d[\d.,]*\b/g, (n) => `${R.codeNumber}${n}${T.reset}`);
}
