import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inspectTool } from './inspect.js';
import { writeTool } from './write.js';
import type { ToolContext } from './types.js';

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    agentId: 'test',
    events: { emit: () => {} },
  } as unknown as ToolContext;
}

// Force mtime forward so fingerprints used by ingest differ across writes.
function bumpMtime(p: string): void {
  const now = Date.now() / 1000;
  utimesSync(p, now, now);
}

describe('inspect tool mutation-fenced cache', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(() => {
    cwd = mkdtempSync(`${tmpdir()}/mochi-inspect-`);
    ctx = makeCtx(cwd);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('serves an identical repeat inspect from cache and invalidates after a write', async () => {
    writeFileSync(
      `${cwd}/calc.ts`,
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    bumpMtime(`${cwd}/calc.ts`);

    const first = await inspectTool.execute({ query: 'add', limit: 5 }, ctx);
    const second = await inspectTool.execute({ query: 'add', limit: 5 }, ctx);
    // Same generation + same query, so the second call is served from cache verbatim.
    expect(second).toBe(first);

    // A real write bumps the mutation generation, so the cached result MUST be
    // thrown away and a fresh (now-different) result computed.
    await writeTool.execute(
      { path: 'calc.ts', content: `export function mul(a: number, b: number): number {\n  return a * b;\n}\n` },
      ctx,
    );
    bumpMtime(`${cwd}/calc.ts`);

    const afterWrite = await inspectTool.execute({ query: 'add', limit: 5 }, ctx);
    // The symbol "add" is gone; the cache must not leak the stale result, so the
    // inspected output must differ and must no longer name a symbol "add".
    expect(afterWrite).not.toBe(first);
    expect(afterWrite).not.toContain('"name": "add"');
    expect(afterWrite).toContain('Symbols: (none)');
  });
});