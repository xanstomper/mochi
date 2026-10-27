#!/usr/bin/env tsx
// MCH-lazy 14 surface measurement (provider-independent, deterministic).
//
// Calls the BASE (a9b9de9) and TIP builds of the SAME tools against the SAME
// fixture inputs and measures the payload each surface injects into context
// (chars; ~4 chars/token — the repo's own estimator scale). This is the
// per-surface token delta: what one tool call costs the model at base vs tip
// on identical bytes, with expansion-availability proofs (deferred, not
// dropped).
//
// Usage: ./node_modules/.bin/tsx bench/lazy-surface-proof.ts \
//          --base /tmp/lazyproof-base/dist --tip ./dist --out /path/surface.json

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeFixture, CALC_BUGGY, CALC_FIXED } from './lazy-fixture-lib.mjs';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const BASE_DIR = resolve(argOf('--base') ?? '/tmp/lazyproof-base/dist');
const TIP_DIR = resolve(argOf('--tip') ?? resolve(process.cwd(), 'dist'));
const OUT = argOf('--out');

type ToolMod = { def: { name: string }; execute(args: Record<string, unknown>, ctx: unknown): Promise<string> };

async function loadTool(distDir: string, rel: string, exportName: string): Promise<ToolMod> {
  const mod = await import(resolve(distDir, rel));
  return mod[exportName] as ToolMod;
}

function makeCtx(cwd: string) {
  return {
    cwd,
    workspace: { dir: cwd, root: cwd },
    config: { permissions: { read: true, gitDestructive: true, shell: true }, safety: { mode: 'auto', commandTimeoutSeconds: 60 } },
    events: { emit: () => {} },
    agentId: 'surface-proof',
    goalHint: 'Work out what the function parseQux returns for input 7 (it calls another function in the same file you must also inspect), report the changed files of the repo, and run the test suite.',
  };
}

const approxTokens = (chars: number): number => Math.round(chars / 4);

interface SurfaceRow {
  surface: string;
  baseChars: number;
  tipChars: number;
  baseTokensApprox: number;
  tipTokensApprox: number;
  savedPct: number;
  basePreview: string;
  tipPreview: string;
}

async function measure(name: string, run: (distDir: string) => Promise<string>): Promise<SurfaceRow> {
  const base = await run(BASE_DIR);
  const tip = await run(TIP_DIR);
  return {
    surface: name,
    baseChars: base.length,
    tipChars: tip.length,
    baseTokensApprox: approxTokens(base.length),
    tipTokensApprox: approxTokens(tip.length),
    savedPct: base.length > 0 ? Math.max(0, Math.round((1 - tip.length / base.length) * 100)) : 0,
    basePreview: base.slice(0, 100).replace(/\n/g, ' | '),
    tipPreview: tip.slice(0, 100).replace(/\n/g, ' | '),
  };
}

async function main() {
  const rows: SurfaceRow[] = [];
  const dir = makeFixture();
  try {
    // ── Surface 1: lazy file contents (read tool, large file, no explicit range) ──
    rows.push(await measure('S1 read(large file, goal-relevant window)', async (distDir) => {
      const read = await loadTool(distDir, 'tools/read.js', 'readTool');
      return String(await read.execute({ path: 'src/parser.js' }, makeCtx(dir)));
    }));

    // ── Surface 2a: git tool diff (12-file uncommitted diff) ──
    rows.push(await measure('S2 git diff(12-file diff)', async (distDir) => {
      const git = await loadTool(distDir, 'tools/git.js', 'gitTool');
      return String(await git.execute({ subcommand: 'diff' }, makeCtx(dir)));
    }));

    // ── Surface 2b: diff tool, file-vs-content ──
    writeFileSync(join(dir, 'surf-a.txt'), Array.from({ length: 120 }, (_, i) => `line ${i} original`).join('\n'));
    rows.push(await measure('S2 diff(file vs provided content)', async (distDir) => {
      const diff = await loadTool(distDir, 'tools/diff.js', 'diffTool');
      const content = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `line ${i} CHANGED for the surface probe` : `line ${i} original`)).join('\n');
      return String(await diff.execute({ path: 'surf-a.txt', content }, makeCtx(dir)));
    }));

    // ── Surface 3a: verify tool on the FAILING fixture suite ──
    rows.push(await measure('S3 verify(test, FAILING suite)', async (distDir) => {
      const verify = await loadTool(distDir, 'tools/verify.js', 'verifyTool');
      return String(await verify.execute({ command: 'node tests/run.js' }, makeCtx(dir)));
    }));

    // ── Surface 3b: verify tool on the PASSING suite ──
    writeFileSync(join(dir, 'src', 'calc.js'), CALC_FIXED);
    rows.push(await measure('S3 verify(test, PASSING suite)', async (distDir) => {
      const verify = await loadTool(distDir, 'tools/verify.js', 'verifyTool');
      return String(await verify.execute({ command: 'node tests/run.js' }, makeCtx(dir)));
    }));

    // ── Expansion-availability checks (lazy ⇒ deferred, not dropped) ──
    writeFileSync(join(dir, 'src', 'calc.js'), CALC_BUGGY);
    const read = await loadTool(TIP_DIR, 'tools/read.js', 'readTool');
    const tipRead = String(await read.execute({ path: 'src/parser.js' }, makeCtx(dir)));
    const region = String(await read.execute({ path: 'src/parser.js', offset: 834, limit: 6 }, makeCtx(dir)));
    const git = await loadTool(TIP_DIR, 'tools/git.js', 'gitTool');
    const tipGit = String(await git.execute({ subcommand: 'diff' }, makeCtx(dir)));
    const gitFull = String(await git.execute({ subcommand: 'diff', full: true }, makeCtx(dir)));
    const verify = await loadTool(TIP_DIR, 'tools/verify.js', 'verifyTool');
    const verifyFail = String(await verify.execute({ command: 'node tests/run.js' }, makeCtx(dir)));
    const expansion = {
      readSliceFooterHasFetchInstructions: tipRead.includes('read { path, offset, limit }'),
      readDeferredRegionReturnsDeepTarget: region.includes('parseQux'),
      gitSummaryHasArchiveId: /recall_output \S+/.test(tipGit),
      gitFullReturnsRawHunks: gitFull.includes('diff --git a/src/mod0.js') && gitFull.includes('@@'),
      verifyFailHasArchiveId: /recall_output \S+/.test(verifyFail),
      verifyFailNamesFailures: verifyFail.includes('FAIL') && verifyFail.includes('AssertionError'),
    };

    const json = JSON.stringify({ baseDir: BASE_DIR, tipDir: TIP_DIR, rows, expansion }, null, 2);
    if (OUT) {
      writeFileSync(OUT, json);
      console.log(`wrote ${OUT}`);
    } else {
      console.log(json);
    }
    for (const r of rows) {
      console.log(`${r.surface}: base ${r.baseChars}ch (~${r.baseTokensApprox} tok) -> tip ${r.tipChars}ch (~${r.tipTokensApprox} tok)  [-${r.savedPct}%]`);
    }
    console.log('expansion:', JSON.stringify(expansion, null, 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
