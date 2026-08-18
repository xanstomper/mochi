import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getFunctionSynapse, findCallers } from '../codegraph.js';
import { writeTool } from './write.js';
import type { ToolContext } from './types.js';

// Some filesystems have sub-second mtime granularity; force the mtime forward so
// the fingerprint always differs between the original file and the edit.
function bumpMtime(p: string): void {
  const now = Date.now() / 1000;
  utimesSync(p, now, now);
}

// Minimal fake ctx satisfying the write tool's expectations.
function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    agentId: 'test',
    events: { emit: () => {} },
  } as unknown as ToolContext;
}

describe('codegraph incremental revalidation', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(`${tmpdir()}/mochi-cpg-`);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('invalidates symbol rows after a real write (no stale defs served)', () => {
    const lib = `${cwd}/lib.ts`;
    writeFileSync(lib, `export function greet(name: string): string {\n  return "hi " + name;\n}\n`);
    bumpMtime(lib);

    // First read returns the ORIGINAL signature.
    expect(getFunctionSynapse(cwd, 'greet')).toContain('return "hi " + name;');

    // Agent edits through the REAL write tool (exact path that bumps the fence).
    writeTool.execute(
      { path: 'lib.ts', content: `export function greet(name: string, loud: boolean): string {\n  return "<new>";\n}\n` },
      makeCtx(cwd),
    );
    bumpMtime(`${cwd}/lib.ts`);

    // Incremental reindex must serve the NEW definition, not the stale one.
    const after = getFunctionSynapse(cwd, 'greet');
    expect(after).toContain('return "<new>";');
    expect(after).not.toContain('return "hi " + name;');
  });

  it('survives repeated edits (each write stays visible, not just the last)', () => {
    const lib = `${cwd}/lib.ts`;
    writeFileSync(lib, `export function greet(name: string): string {\n  return "v1";\n}\n`);
    bumpMtime(lib);
    expect(getFunctionSynapse(cwd, 'greet')).toContain('return "v1";');

    writeTool.execute({ path: 'lib.ts', content: `export function greet(name: string): string {\n  return "v2";\n}\n` }, makeCtx(cwd));
    bumpMtime(lib);
    expect(getFunctionSynapse(cwd, 'greet')).toContain('return "v2";');

    // A second, consecutive edit must ALSO invalidate -- this regressed when a
    // changed file was mis-treated as "gone" and its inserted rows purged.
    writeTool.execute({ path: 'lib.ts', content: `export function greet(name: string): string {\n  return "v3";\n}\n` }, makeCtx(cwd));
    bumpMtime(lib);
    const last = getFunctionSynapse(cwd, 'greet');
    expect(last).toContain('return "v3";');
  });

  it('picks up new call sites in findCallers after an edit', () => {
    writeFileSync(`${cwd}/a.ts`, `import { greet } from "./b";\ngreet();\n`);
    writeFileSync(`${cwd}/b.ts`, `export function greet(name: string): string { return "hi"; }\n`);
    bumpMtime(`${cwd}/a.ts`);
    bumpMtime(`${cwd}/b.ts`);

    const before = findCallers(cwd, 'greet');
    expect(before).toContain('a.ts:2');

    writeTool.execute(
      { path: 'a.ts', content: `import { greet } from "./b";\ngreet();\ngreet(1);\n` },
      makeCtx(cwd),
    );
    bumpMtime(`${cwd}/a.ts`);

    const after = findCallers(cwd, 'greet');
    expect(after).toContain('a.ts:3');
  });
});