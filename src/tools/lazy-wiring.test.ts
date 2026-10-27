// MCH-lazy 14.x: tool wiring for the lazy surfaces — read (lazy slice window
// + invalidation through the tool), diff/git-diff (summary default, full
// hunks on demand), verify (failures+summary default, counts for passes,
// never hides a failure).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { readTool } from './read.js';
import { diffTool } from './diff.js';
import { gitTool } from './git.js';
import { verifyTool } from './verify.js';
import { recallOutputTool } from './recall-output.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

let dir: string;
let ctx: ToolContext;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-lazy-wiring-'));
  mkdirSync(resolve(dir, 'src'), { recursive: true });
  ctx = {
    cwd: dir,
    workspace: { dir, root: dir } as any,
    config: { permissions: { read: true, gitDestructive: true }, safety: { mode: 'safe' } } as unknown as MochiConfig,
    events: {} as any,
    agentId: 'r',
    goalHint: 'Fix the parseQux bug in src/parser.js',
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('read tool lazy window', () => {
  it('large file + goalHint serves head + task-relevant region, bounded and marked', async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `filler line ${i}`);
    lines[700] = 'export function parseQux(input) { return input; }';
    writeFileSync(resolve(dir, 'src/parser.js'), lines.join('\n'));
    const out = String(await readTool.execute({ path: 'src/parser.js' }, ctx));
    expect(out).toContain('parseQux');
    expect(out).toContain('omitted');
    expect(out).toContain('lazy slice of');
    expect(out).toContain('rev mtime=');
    // Bounded: far below the 1200-line full content.
    expect(out.length).toBeLessThan(20_000);
  });

  it('explicit offset/limit fetches a deferred region on demand (fresh read)', async () => {
    const out = String(await readTool.execute({ path: 'src/parser.js', offset: 695, limit: 10 }, ctx));
    expect(out).toContain('parseQux');
  });

  it('INVALIDATION: file changed after slicing — a later read returns FRESH content', async () => {
    const p = resolve(dir, 'src/changes-late.js');
    writeFileSync(p, Array.from({ length: 900 }, (_, i) => `old content ${i}`).join('\n'));
    const slice = String(await readTool.execute({ path: 'src/changes-late.js' }, ctx));
    expect(slice).toContain('old content');
    // Mutate after slicing (different size → new mtime+size revision).
    writeFileSync(p, Array.from({ length: 900 }, (_, i) => `brand new content ${i} xx`).join('\n'));
    const region = String(await readTool.execute({ path: 'src/changes-late.js', offset: 100, limit: 5 }, ctx));
    expect(region).toContain('brand new content 100');
    expect(region).not.toContain('old content 100');
  });

  it('kill-switch MOCHI_LAZY_FILE=0 restores the plain first-N window', async () => {
    process.env.MOCHI_LAZY_FILE = '0';
    try {
      const lines = Array.from({ length: 1200 }, (_, i) => `plain ${i}`);
      lines[700] = 'export function parseQux(input) { return input; }';
      writeFileSync(resolve(dir, 'src/plain.js'), lines.join('\n'));
      const out = String(await readTool.execute({ path: 'src/plain.js' }, ctx));
      expect(out).not.toContain('lazy slice of');
      expect(out).toContain('   1 | plain 0');
    } finally {
      delete process.env.MOCHI_LAZY_FILE;
    }
  });
});

describe('diff tool lazy presentation', () => {
  it('EXPANSION: full: true returns the complete hunks', async () => {
    const a = resolve(dir, 'src/diff-a.txt');
    const b = resolve(dir, 'src/diff-b.txt');
    writeFileSync(a, ['one', 'two', 'three', 'four'].join('\n'));
    writeFileSync(b, ['one', 'TWO!', 'three', 'four', 'five'].join('\n'));
    const full = String(await diffTool.execute({ path: 'src/diff-a.txt', path_b: 'src/diff-b.txt', full: true }, ctx));
    expect(full).toContain('@@');
    expect(full).toContain('-two');
    expect(full).toContain('+TWO!');
    expect(full).toContain('+five');
  });

  it('defaults to the compact summary with the expansion hint', async () => {
    const out = String(await diffTool.execute({ path: 'src/diff-a.txt', path_b: 'src/diff-b.txt' }, ctx));
    expect(out).toContain('[lazy diff: 1 file changed');
    expect(out).not.toContain('-two');
    expect(out.toLowerCase()).toContain('full: true');
  });
});

describe('git tool lazy diff', () => {
  beforeAll(() => {
    execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir });
    writeFileSync(resolve(dir, 'tracked.txt'), 'a\nb\nc\n');
    execSync('git add tracked.txt && git commit -q -m add', { cwd: dir });
    writeFileSync(resolve(dir, 'tracked.txt'), 'a\nB!\nc\nd\n');
  });

  it('defaults to summary + archive id; recall_output retrieves full hunks', async () => {
    const out = String(await gitTool.execute({ subcommand: 'diff' }, ctx));
    expect(out).toContain('[lazy diff: 1 file changed');
    expect(out).not.toContain('+B!');
    const id = /recall_output (\S+)/.exec(out)?.[1];
    expect(id).toBeTruthy();
    // DEFERRED, NOT DROPPED: the archived hunks come back in full.
    const full = String(await recallOutputTool.execute({ id }, ctx));
    expect(full).toContain('+B!');
    expect(full).toContain('-b');
    expect(full).toContain('@@');
  });

  it('EXPANSION: full: true returns the raw git diff', async () => {
    const out = String(await gitTool.execute({ subcommand: 'diff', full: true }, ctx));
    expect(out).toContain('diff --git a/tracked.txt');
    expect(out).toContain('+B!');
  });
});

describe('verify tool lazy output', () => {
  it('passing run condenses to counts + archive pointer', async () => {
    const out = await verifyTool.execute({ command: 'node -e "console.log(\' Tests  15 passed (15)\'); console.log(\' Duration  2.40s\')"' }, ctx);
    expect(out).toContain('[PASS]');
    expect(out).toContain('[lazy test summary: PASS]');
    expect(out).toContain('15 passed');
    expect(out).toContain('recall_output');
  });

  it('failing run keeps EVERY failure — summary never hides a failure', async () => {
    const script = [
      "console.log(' FAIL  src/t.test.ts > case one');",
      "console.log('AssertionError: expected 1 to equal 2');",
      "console.log('Tests  3 failed (10)');",
      "process.exit(1);",
    ].join('\n');
    const out = await verifyTool.execute({ command: `node -e "${script}"` }, ctx);
    expect(out).toContain('[FAIL]');
    expect(out).toContain('case one');
    expect(out).toContain('AssertionError: expected 1 to equal 2');
    expect(out).toContain('3 failed');
    expect(out).toContain('recall_output');
  });

  it('many failures: overflow failures are still all NAMED', async () => {
    const script = Array.from({ length: 12 }, (_, i) => `console.log(' FAIL  src/s${i}.test.ts > case ${i}'); console.log('AssertionError: boom ${i}');`).join('\n') + ";process.exit(1);";
    const out = await verifyTool.execute({ command: `node -e "${script}"` }, ctx);
    for (let i = 0; i < 12; i++) {
      expect(out).toContain(`s${i}.test.ts`);
    }
    expect(out).toContain('FAILURE DETAIL TRUNCATED');
  });

  it('kill-switch MOCHI_LAZY_TEST_OUTPUT=0 restores the raw slice', async () => {
    process.env.MOCHI_LAZY_TEST_OUTPUT = '0';
    try {
      const out = await verifyTool.execute({ command: 'node -e "console.log(\' Tests  15 passed (15)\')"' }, ctx);
      expect(out).not.toContain('[lazy test summary');
      expect(out).toContain(' Tests  15 passed (15)');
    } finally {
      delete process.env.MOCHI_LAZY_TEST_OUTPUT;
    }
  });
});
