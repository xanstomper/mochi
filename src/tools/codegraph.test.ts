import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getFunctionSynapse, findCallers, hasSqlite, querySymbolGraph, typeHierarchy } from '../repo/codegraph.js';
import { writeTool } from './write.js';
import type { ToolContext } from './types.js';

// node:sqlite exists only on Node >= 22.5; on older runtimes the codegraph
// degrades to "index unavailable" and these tests cannot assert anything.
const maybeDescribe = hasSqlite() ? describe : describe.skip;

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

maybeDescribe('codegraph incremental revalidation', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(`${tmpdir()}/mochi-cpg-`);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('invalidates symbol rows after a real write (no stale defs served)', async () => {
    const lib = `${cwd}/lib.ts`;
    writeFileSync(lib, `export function greet(name: string): string {\n  return "hi " + name;\n}\n`);
    bumpMtime(lib);

    // First read returns the ORIGINAL signature.
    expect(await getFunctionSynapse(cwd, 'greet')).toContain('return "hi " + name;');

    // Agent edits through the REAL write tool (exact path that bumps the fence).
    writeTool.execute(
      { path: 'lib.ts', content: `export function greet(name: string, loud: boolean): string {\n  return "<new>";\n}\n` },
      makeCtx(cwd),
    );
    bumpMtime(`${cwd}/lib.ts`);

    // Incremental reindex must serve the NEW definition, not the stale one.
    const after = await getFunctionSynapse(cwd, 'greet');
    expect(after).toContain('return "<new>";');
    expect(after).not.toContain('return "hi " + name;');
  });

  it('survives repeated edits (each write stays visible, not just the last)', async () => {
    const lib = `${cwd}/lib.ts`;
    writeFileSync(lib, `export function greet(name: string): string {\n  return "v1";\n}\n`);
    bumpMtime(lib);
    expect(await getFunctionSynapse(cwd, 'greet')).toContain('return "v1";');

    writeTool.execute({ path: 'lib.ts', content: `export function greet(name: string): string {\n  return "v2";\n}\n` }, makeCtx(cwd));
    bumpMtime(lib);
    expect(await getFunctionSynapse(cwd, 'greet')).toContain('return "v2";');

    // A second, consecutive edit must ALSO invalidate -- this regressed when a
    // changed file was mis-treated as "gone" and its inserted rows purged.
    writeTool.execute({ path: 'lib.ts', content: `export function greet(name: string): string {\n  return "v3";\n}\n` }, makeCtx(cwd));
    bumpMtime(lib);
    const last = await getFunctionSynapse(cwd, 'greet');
    expect(last).toContain('return "v3";');
  });

  it('picks up new call sites in findCallers after an edit', async () => {
    writeFileSync(`${cwd}/a.ts`, `import { greet } from "./b";\ngreet();\n`);
    writeFileSync(`${cwd}/b.ts`, `export function greet(name: string): string { return "hi"; }\n`);
    bumpMtime(`${cwd}/a.ts`);
    bumpMtime(`${cwd}/b.ts`);

    const before = await findCallers(cwd, 'greet');
    expect(before).toContain('a.ts:2');

    writeTool.execute(
      { path: 'a.ts', content: `import { greet } from "./b";\ngreet();\ngreet(1);\n` },
      makeCtx(cwd),
    );
    bumpMtime(`${cwd}/a.ts`);

    const after = await findCallers(cwd, 'greet');
    expect(after).toContain('a.ts:3');
  });

  it('drops removed call sites from findCallers after an edit (ghost calls)', async () => {
    // No import of greet in a.ts: the line-grep fallback in findCallers would
    // otherwise keep reporting the import line even after the call is gone.
    writeFileSync(`${cwd}/a.ts`, `greet();\n`);
    writeFileSync(`${cwd}/b.ts`, `export function greet(name: string): string { return "hi"; }\n`);
    bumpMtime(`${cwd}/a.ts`);
    bumpMtime(`${cwd}/b.ts`);

    expect(await findCallers(cwd, 'greet')).toContain('a.ts:1');

    // Remove the ONLY call to greet(). Before the delCall fix, the stale
    // `calls` row survived re-indexing and findCallers still reported a.ts:1.
    writeTool.execute(
      { path: 'a.ts', content: `export const x = 1;\n` },
      makeCtx(cwd),
    );
    bumpMtime(`${cwd}/a.ts`);

    const after = await findCallers(cwd, 'greet');
    expect(after).not.toContain('a.ts');
    expect(after).toContain('No references to "greet" found.');
  });

  it('does not accumulate duplicate call rows after repeated edits keeping one call', async () => {
    writeFileSync(`${cwd}/b.ts`, `export function greet(name: string): string { return "hi"; }\n`);
    bumpMtime(`${cwd}/b.ts`);
    const body = (v: string) => `// ${v}\nexport function caller(): void {\n  greet();\n}\n`;
    writeFileSync(`${cwd}/a.ts`, body('v1'));
    bumpMtime(`${cwd}/a.ts`);
    expect(await findCallers(cwd, 'greet')).toContain('a.ts:3');

    for (const v of ['v2', 'v3', 'v4']) {
      writeTool.execute({ path: 'a.ts', content: body(v) }, makeCtx(cwd));
      bumpMtime(`${cwd}/a.ts`);
      await findCallers(cwd, 'greet');
    }

    // The graph itself must hold exactly ONE row for the one call site in the
    // file -- before the delCall fix each re-index added another identical
    // row (findCallers' Set-collapsed output hid the pile-up).
    const res = await querySymbolGraph(cwd, `SELECT callee, caller, rel, line FROM calls WHERE callee='greet'`);
    expect('rows' in res).toBe(true);
    if ('rows' in res) expect(res.rows).toHaveLength(1);

    // And the public answer lists that call site as a single graph line.
    const after = await findCallers(cwd, 'greet');
    const graphLines = after.split('\n').filter((l) => l === 'a.ts:3 called from caller');
    expect(graphLines).toHaveLength(1);
  });

  it('indexes extends relations under the tree-sitter backend (typeHierarchy)', async () => {
    writeFileSync(
      `${cwd}/lib.ts`,
      `export class Animal {}\nexport class Dog extends Animal {}\n`,
    );
    bumpMtime(`${cwd}/lib.ts`);

    // typeHierarchy is the exported reader for `relations`
    // (src=? -> dst super-types, dst=? -> src sub-types, kind='extends').
    // Before the heritage fix, tsIndexFile wrote no relations rows at all,
    // so both directions came back empty under the default backend.
    expect(await typeHierarchy(cwd, 'Dog')).toContain('super-types of Dog: Animal');
    const down = await typeHierarchy(cwd, 'Animal');
    expect(down).toContain('sub-types of Animal:');
    expect(down).toContain('Dog');
  });
});