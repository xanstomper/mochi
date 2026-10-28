// CI guard: prompt/skill/tool byte-budget ratchet (D4).
//
// Prompt bytes, tool schemas and the bundled-skill advertisement are a hidden
// tax on every run. src/prompt/byte-budget.ts meters them through the real
// assembly seams (ContextEngine.buildSystemPrompt, ALL_TOOLS_MAP, the rendered
// <available_skills> block); the committed baseline
// scripts/byte-budget.baseline.json records the measured numbers and this
// script holds the line: growth beyond the stated allowances — prompt total,
// prompt STABLE head, or ANY single tool's schema — fails the build, and a
// new tool without a baseline entry is reported, never silently ignored.
// Like check-proc-sites.mjs, this is a RATCHET: decreases always pass; the
// baseline only moves deliberately, via --update-baseline with a reason in
// the commit message.
//
// Usage: node scripts/check-byte-budget.mjs [--update-baseline]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'scripts', 'byte-budget.baseline.json');
const meterTs = resolve(root, 'src', 'prompt', 'byte-budget.ts');
const update = process.argv.includes('--update-baseline');

// The meter is TypeScript (it composes the real prompt via src/context.ts), so
// it runs through the repo-local tsx loader with the current node binary.
const tsxCli = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) {
  console.error('tsx not installed (node_modules/tsx) — run `npm ci` first.');
  process.exit(2);
}

const args = [tsxCli, meterTs];
if (update) args.push('--update-baseline');
else args.push('--check', '--baseline', baselinePath);

const res = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.status ?? 1);
