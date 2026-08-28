// Cline-Grade Summary & Markdown Presentation Engine for Mochi
// Renders rich, high-density structured summaries with grid boxes,
// semantic color-coding, structured file operations, tables, and progress charts.

import type { SummaryDocument, SummaryItem } from './engine.js';

/** Render a text-based progress bar: [████████████████████] 100% (184/184) */
export function renderProgressBar(passed: number, total: number, barLength = 20): string {
  if (total <= 0) return '[────────────────────] 0%';
  const ratio = Math.min(1, Math.max(0, passed / total));
  const filled = Math.round(ratio * barLength);
  const empty = barLength - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const pct = Math.round(ratio * 100);
  return `[${bar}] ${pct}% (${passed}/${total})`;
}

/** Render a structured ASCII grid of metric boxes */
export function renderAsciiBoxGrid(metrics: Array<{ label: string; value: string }>): string {
  if (!metrics.length) return '';
  const cells = metrics.map((m) => {
    const label = m.label.padEnd(12);
    const val = m.value.padEnd(12);
    return { label, val };
  });

  const lines: string[] = [];
  const top = cells.map(() => '┌──────────────┐').join(' ');
  const labels = cells.map((c) => `│ ${c.label} │`).join(' ');
  const values = cells.map((c) => `│ ${c.val} │`).join(' ');
  const bot = cells.map(() => '└──────────────┘').join(' ');

  lines.push(top, labels, values, bot);
  return lines.join('\n');
}

/** Render a full Cline-Grade Markdown document from a SummaryDocument */
export function renderClineMarkdown(doc: SummaryDocument): string {
  const md: string[] = [];

  // Header Box
  const statusEmoji = doc.status === 'complete' ? '✓ COMPLETE' : doc.status === 'failed' ? '✗ FAILED' : '⚠ PARTIAL';
  md.push(`### ╭────────────────────────────────────────────╮`);
  md.push(`### │ SUMMARY                          ${statusEmoji.padEnd(11)} │`);
  md.push(`### ╰────────────────────────────────────────────╯\n`);

  // Metric Table / Grid
  if (doc.metrics.length) {
    md.push('| Metric | Value |');
    md.push('| :--- | :--- |');
    for (const m of doc.metrics) {
      md.push(`| **${m.label}** | \`${m.value}\` |`);
    }
    md.push('');
  }

  // Overview
  if (doc.overview && doc.overview !== 'No substantive activity recorded.') {
    md.push(`> **Overview**: ${doc.overview}\n`);
  }

  // What Changed
  if (doc.whatChanged.length) {
    md.push('#### 📦 What Changed');
    for (const item of doc.whatChanged) {
      md.push(`- ✓ ${item.text}`);
    }
    md.push('');
  }

  // Files categorized
  if (doc.files && doc.files.length) {
    md.push('#### 📄 Files');
    const modified = doc.files.filter((f) => f.op === 'modified');
    const added = doc.files.filter((f) => f.op === 'added');
    const deleted = doc.files.filter((f) => f.op === 'deleted');

    if (modified.length) {
      md.push('**Modified**');
      for (const f of modified) md.push(`  - \`${f.path}\``);
    }
    if (added.length) {
      md.push('**Added**');
      for (const f of added) md.push(`  - \`${f.path}\``);
    }
    if (deleted.length) {
      md.push('**Deleted**');
      for (const f of deleted) md.push(`  - \`${f.path}\``);
    }
    md.push('');
  }

  // Verification & Checks
  if (doc.verification.length) {
    md.push('#### 🧪 Verification');
    for (const item of doc.verification) {
      const icon = item.text.startsWith('✓') || item.text.startsWith('✗') ? '' : '✓ ';
      md.push(`- ${icon}${item.text}${item.detail ? ` *(${item.detail})*` : ''}`);
    }
    md.push('');
  }

  // Failures & Warnings
  if (doc.failures.length) {
    md.push('#### ❌ Failures');
    for (const item of doc.failures) {
      md.push(`- ⚠️ **${item.text}**`);
    }
    md.push('');
  }

  if (doc.warnings.length) {
    md.push('#### ⚠️ Warnings');
    for (const item of doc.warnings) {
      md.push(`- ℹ️ ${item.text}`);
    }
    md.push('');
  }

  // Next Steps
  if (doc.next.length) {
    md.push('#### ➡️ Next Steps');
    for (const item of doc.next) {
      md.push(`- → ${item.text}`);
    }
    md.push('');
  }

  return md.join('\n');
}
