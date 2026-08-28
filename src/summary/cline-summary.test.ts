import { describe, it, expect } from 'vitest';
import { renderProgressBar, renderAsciiBoxGrid, renderClineMarkdown } from './cline-summary.js';
import type { SummaryDocument } from './engine.js';

describe('Cline-Grade Summary & Markdown Presentation Engine', () => {
  it('renders ASCII progress bars accurately', () => {
    const full = renderProgressBar(10, 10, 10);
    expect(full).toBe('[██████████] 100% (10/10)');

    const half = renderProgressBar(5, 10, 10);
    expect(half).toBe('[█████░░░░░] 50% (5/10)');
  });

  it('renders metric box grid cards with clean borders', () => {
    const grid = renderAsciiBoxGrid([
      { label: 'FILES', value: '7 changed' },
      { label: 'TESTS', value: '184 passed' },
    ]);
    expect(grid).toContain('┌──────────────┐');
    expect(grid).toContain('FILES');
    expect(grid).toContain('184 passed');
    expect(grid).toContain('└──────────────┘');
  });

  it('renders complete structured Markdown with box header, tables, and files', () => {
    const doc: SummaryDocument = {
      status: 'complete',
      overview: 'Completed payment webhook overhaul successfully.',
      metrics: [
        { label: 'FILES', value: '3 changed' },
        { label: 'CHECKS', value: '42 passed' },
      ],
      whatChanged: [
        { text: 'Added signature verification', priority: 'P1' },
      ],
      files: [
        { path: 'src/webhook.ts', op: 'modified' },
        { path: 'src/webhook.test.ts', op: 'added' },
      ],
      verification: [
        { text: 'npm test', priority: 'P1', detail: '420ms' },
      ],
      failures: [],
      warnings: [],
      references: [],
      next: [{ text: 'Deploy to staging', priority: 'P2' }],
      populatedSections: ['overview', 'metrics', 'whatChanged', 'files', 'verification', 'next'],
    };

    const md = renderClineMarkdown(doc);
    expect(md).toContain('SUMMARY');
    expect(md).toContain('✓ COMPLETE');
    expect(md).toContain('| **FILES** | `3 changed` |');
    expect(md).toContain('#### 📦 What Changed');
    expect(md).toContain('#### 📄 Files');
    expect(md).toContain('`src/webhook.ts`');
    expect(md).toContain('`src/webhook.test.ts`');
    expect(md).toContain('#### 🧪 Verification');
    expect(md).toContain('#### ➡️ Next Steps');
  });
});
