// Summary renderer: renders a SummaryDocument as a Cline-style summary CARD —
// a rounded border box with the status in the title border, a one-line metrics
// row inside, and section blocks under clean colored sub-headers. The user
// asked for the Cline "nice chart box" look explicitly; this bordered style
// supersedes the earlier borderless rule FOR SUMMARY CARDS ONLY (menus and
// transcript keep the existing treatment).
//
// Structure first: empty sections are never rendered; layout adapts to the
// populated sections.
//
// Color contract: important tool calls, code edits, and prose are color-coded
// semantically instead of all-white — ops bold orange, paths cyan, checks
// green/red, warnings yellow, numbers in the theme's number color.

import { T, R, stripAnsi, renderMarkdown } from './view.js';
import { wrap, visibleLen } from './wrap.js';
import { SEMANTIC_COLOR } from './semantic.js';
import type { Semantic } from './semantic.js';
import { STATUS_GLYPH } from './semantic.js';
import { truncate } from './cards.js';
import type { SummaryDocument, SummaryItem } from '../summary/engine.js';

/** Render the summary as styled transcript lines (caller prints them). */
export function renderSummary(doc: SummaryDocument, width = 80): string[] {
  const lines: string[] = [];
  const status: 'complete' | 'failed' | 'partial' = doc.status;
  const statusKind: 'completed' | 'failed' | 'warning' =
    status === 'complete' ? 'completed' : status === 'failed' ? 'failed' : 'warning';
  const statusText =
    status === 'complete' ? 'Task Complete' : status === 'failed' ? 'Task Failed' : 'Partially Complete';
  const statusColor =
    status === 'complete' ? SEMANTIC_COLOR.SUCCESS : status === 'failed' ? SEMANTIC_COLOR.ERROR : SEMANTIC_COLOR.WARNING;
  const statusGlyph = STATUS_GLYPH[statusKind];

  // Box geometry: total width ≈ `width` (the transcript content width the
  // caller passes); inner text area = boxW - 4 (│ + 1 space each side).
  const boxW = Math.max(20, Math.min(width, 120));
  const innerW = boxW - 4;

  const border = SEMANTIC_COLOR.CONTEXT; // muted frame color

  // Visible-length truncate + ellipsis (ANSI-safe via cards' truncate).
  const fit = (s: string, max: number): string => (visibleLen(s) > max ? `${truncate(stripAnsi(s), max - 1)}…` : s);

  // Visible-length padEnd: pad to `n` visible columns (ANSI-safe).
  const padEndVis = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - visibleLen(s)));

  // ── Title border: status lives IN the top border line ──
  const title = fit(` ${statusGlyph} ${statusText} `, Math.max(8, boxW - 5));
  const titleVis = visibleLen(title);
  const titleFill = Math.max(0, boxW - 3 - titleVis); // ╭─<title>…─╮
  lines.push(
    `${border}╭─${T.bold}${statusColor}${title}${T.reset}${border}${'─'.repeat(titleFill)}╮${T.reset}`,
  );

  // ── Cline-style narrative lead, if the model wrote one ──
  if (doc.narrative && doc.narrative.trim()) {
    for (const l of narrativeRows(doc.narrative, innerW)) {
      lines.push(`${border}│${T.reset} ${padEndVis(l, innerW)} ${border}│${T.reset}`);
    }
    lines.push(`${border}├${'─'.repeat(boxW - 2)}┤${T.reset}`);
  }

  // ── Overview line (one factual sentence), if present ──
  const emitRow = (text: string): void => {
    for (const l of wrap(text, innerW - 2)) {
      lines.push(`${border}│${T.reset} ${padEndVis(l, innerW)} ${border}│${T.reset}`);
    }
  };

  if (doc.overview) {
    emitRow(doc.overview);
    lines.push(`${border}├${'─'.repeat(boxW - 2)}┤${T.reset}`);
  }

  // ── Metrics row: files n · checks n · tools n · time ──
  if (doc.metrics.length) {
    const cells = doc.metrics.slice(0, 4).map((m) => `${m.label.toLowerCase()} ${m.value}`);
    let row = cells.join(`${border} · ${T.reset}`);
    // Degenerate-narrow fallback: 4 cells → 2 → 1, then hard-clip. A metrics
    // row must never exceed the inner width (it would break the box in
    // windowed panes — the width-harness guard).
    if (visibleLen(row) > innerW - 2) row = cells.slice(0, 2).join(' · ');
    if (visibleLen(row) > innerW - 2) row = cells[0] ?? '';
    if (visibleLen(row) > innerW - 2) row = `${cells[0]?.slice(0, innerW - 5)}…`;
    lines.push(`${border}│${T.reset} ${padEndVis(row, innerW)} ${border}│${T.reset}`);
    lines.push(`${border}├${'─'.repeat(boxW - 2)}┤${T.reset}`);
  }

  // ── Sections: colored sub-header rows + content rows ──
  const section = (header: string, semantic: Semantic, items: SummaryItem[], painter: (line: string) => string) => {
    if (!items.length) return;
    const hdr = ` ${header.toUpperCase()} `;
    const hdrFill = Math.max(0, boxW - 3 - visibleLen(hdr));
    lines.push(`${border}├─${SEMANTIC_COLOR[semantic]}${T.bold}${hdr}${T.reset}${border}${'─'.repeat(hdrFill)}┤${T.reset}`);
    for (const item of items) {
      for (const l of wrap(item.text, innerW - 4)) {
        lines.push(`${border}│${T.reset} ${padEndVis(painter(l), innerW)} ${border}│${T.reset}`);
      }
    }
  };

  section('What Changed', 'CHANGE', doc.whatChanged, paintChangeLine);
  section('Verification', 'TEST', doc.verification, paintVerifyLine);
  section('Failed', 'ERROR', doc.failures, (l) => `${T.error}${l}${T.reset}`);
  section('Warnings', 'WARNING', doc.warnings, (l) => `${T.warning}${l}${T.reset}`);
  section('References', 'REFERENCE', doc.references, paintReferenceLine);
  section('Next Steps', 'PLAN', doc.next, (l) => `${SEMANTIC_COLOR.PLAN}${l}${T.reset}`);

  // Empty card: never emit a lone border pair.
  if (lines.length === 1) {
    lines.push(`${border}│${T.reset}${padEndVis(' No activity recorded', boxW - 3)}${border}│${T.reset}`);
  }

  // ── Bottom border ──
  lines.push(`${border}╰${'─'.repeat(boxW - 2)}╯${T.reset}`);
  return lines;
}

/** Cline-voice narrative lead rendered through the markdown renderer (bold,
 *  inline code, etc.), then hard-wrapped to the card's content width so no
 *  row ever overflows the box (the width-harness invariant). */
function narrativeRows(text: string, innerW: number): string[] {
  const out: string[] = [];
  for (const l of renderMarkdown(text, innerW - 2)) {
    const row = stripAnsi(l);
    if (row === '') continue;
    out.push(`${' '.repeat(Math.max(0, row.length - visibleLen(row)))}${row}`);
  }
  return out;
}

/** Metric strip: "FILES 2 changed · CHECKS 2 passed · …" — chunked to fit
 *  `width` visible columns (chunks only at metric boundaries, never mid-ANSI). */
export function renderMetricStrip(metrics: Array<{ label: string; value: string }>, width = 100): string[] {
  const sep = `${T.grayDark} · ${T.reset}`;
  const maxW = Math.max(12, width);
  const cells = metrics.slice(0, 6).map((m) => {
    let vis = m.label.length + 1 + m.value.length;
    let value = m.value;
    // A single cell must NEVER exceed the width (it would hard-wrap mid-ANSI
    // in windowed panes). Clamp the value portion, keeping the label intact.
    const cellMax = Math.max(8, maxW - m.label.length - 1);
    if (m.label.length + 1 + value.length > cellMax) {
      const keep = Math.max(1, cellMax - m.label.length - 1 - 1);
      value = value.slice(0, keep) + '…';
      vis = m.label.length + 1 + value.length;
    }
    return {
      text: `${T.grayDark}${m.label}${T.reset} ${metricColor(m.label)}${value}${T.reset}`,
      vis,
    };
  });
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
    if (curVis + add > maxW) flush();
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

void paintNumbers;
