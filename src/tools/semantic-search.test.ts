// Wave J: semantic_search tool surface — ensures the index, labels the
// embedder honestly, returns file-ranked hits.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { semanticSearchTool } from './semantic-search.js';
import type { ToolContext } from './types.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function ctxFor(cwd: string): ToolContext {
  return { cwd, config: undefined } as unknown as ToolContext;
}

describe('semantic_search tool', () => {
  it('finds the concept file and labels the fallback embedder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-semtool-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'lease.ts'), [
      '/** Grants a fencing token to a single holder with a ttl; the heartbeat renewal extends expiry. */',
      'export function acquireFencingLease(state: Record<string, unknown>): Record<string, unknown> {',
      '  return { ...state, owner: "node", expiresAt: Date.now() + 30000 };',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'invoice.ts'), [
      '/** Builds invoice totals and formats the summary for the operator console. */',
      'export function buildInvoiceTotals(rows: Array<Record<string, unknown>>): number {',
      '  return rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);',
      '}',
      '',
    ].join('\n'));
    const out = await semanticSearchTool.execute(
      { query: 'fencing token ttl heartbeat renewal' },
      ctxFor(dir),
    );
    expect(out).toContain('LEXICAL-FALLBACK');
    expect(out).toContain('lease.ts');
    expect(out).toContain('acquireFencingLease');
    expect(out).not.toContain('No matches');
  });

  it('rejects an empty query', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-semtool-'));
    dirs.push(dir);
    await expect(semanticSearchTool.execute({ query: '  ' }, ctxFor(dir))).rejects.toThrow(/No query/);
  });
});
