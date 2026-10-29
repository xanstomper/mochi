// Shared fixture builder for the MCH-lazy 14 proof scripts (lazy-proof.mjs
// whole-task runs and lazy-surface-proof.ts per-surface measurement). One
// definition so the whole-task set and the surface set measure the SAME bytes.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function fillerFn(i) {
  return `// filler module section ${i}
export function fillerFn${i}(x) {
  const acc = x * ${i};
  for (let k = 0; k < ${i % 7}; k++) acc += k * ${i};
  return acc;
}
`;
}

export function makeParserBody() {
  const parts = [];
  parts.push('// parser.js — fixture for the lazy-file proof (large file surface).\n');
  for (let i = 0; i < 60; i++) parts.push(fillerFn(i));
  parts.push(`export function parseBar(input) {
  // mid-file target: parseQux depends on this
  return input + 41;
}
`);
  for (let i = 60; i < 118; i++) parts.push(fillerFn(i));
  parts.push(`export function parseQux(input) {
  // deep-file target (~line 700): the task asks for parseQux(7)
  return input * parseBar(input);
}
`);
  for (let i = 118; i < 150; i++) parts.push(fillerFn(i));
  return parts.join('\n');
}

export const CALC_BUGGY = `// calc.js — seeded bugs for the test-surface proof.
export function add(a, b) { return a + b; }
export function mul(a, b) { return a + b; }  // BUG: should be a * b
export function sub(a, b) { return a - b - 1; }  // BUG: off by one
export function div(a, b) { return b === 0 ? 0 : a / b; }
`;

export const CALC_FIXED = `// calc.js — seeded bugs for the test-surface proof.
export function add(a, b) { return a + b; }
export function mul(a, b) { return a * b; }
export function sub(a, b) { return a - b; }
export function div(a, b) { return b === 0 ? 0 : a / b; }
`;

export function testRunnerScript() {
  return `#!/usr/bin/env node
// Vitest-style runner: verbose per-test output + full failure blocks; exits 1
// while the calc.js bugs live. Deliberately chatty like real vitest output.
import { add, mul, sub, div } from '../src/calc.js';
const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const eq = (a, b) => { if (a !== b) throw new Error('AssertionError: expected ' + a + ' to equal ' + b); };
t('add > adds numbers', () => eq(add(2, 3), 5));
t('add > handles negatives', () => eq(add(-1, 1), 0));
t('add > handles zero', () => eq(add(0, 0), 0));
t('mul > multiplies numbers', () => eq(mul(2, 3), 6));
t('mul > handles zero', () => eq(mul(5, 0), 0));
t('sub > subtracts numbers', () => eq(sub(5, 2), 3));
t('sub > handles negatives', () => eq(sub(-1, -1), 0));
t('div > divides numbers', () => eq(div(6, 3), 2));
t('div > guards zero', () => eq(div(1, 0), 0));
t('combo > add-mul chain', () => eq(mul(add(1, 1), 3), 6));
t('combo > sub-div chain', () => eq(div(sub(9, 3), 2), 3));
t('combo > nested', () => eq(add(mul(2, 2), sub(5, 1)), 8));
t('combo > zero identity', () => eq(mul(div(0, 1), 5), 0));
t('combo > parse-adjacent', () => eq(sub(add(10, 5), 5), 10));
t('combo > big numbers', () => eq(mul(12, 12), 144));
t('combo > final', () => eq(add(mul(3, 3), 1), 10));
let failed = 0;
console.log(' RUN  v5.0.3 fixture');
console.log('');
for (const [name, fn] of cases) {
  try { fn(); console.log(' ✓ ' + name + ' 1ms'); }
  catch (e) { failed++; console.log(' × ' + name + ' 3ms'); console.log('   → ' + e.message); }
}
if (failed > 0) {
  console.log('');
  console.log('⎯⎯⎯ Failed Tests ' + failed + ' ⎯⎯⎯');
  console.log('');
  for (const [name, fn] of cases) {
    try { fn(); } catch (e) {
      console.log(' FAIL  tests/calc.test.js > ' + name);
      console.log(e.message);
      console.log('');
      console.log('Expected: ' + (e.message.split('to equal ')[1] ?? '?'));
      console.log('Received: (actual value differed — see assertion above)');
      console.log('');
      console.log(' ❯ tests/calc.test.js:1:1');
      for (let s = 0; s < 8; s++) console.log('   at ' + (s % 2 ? 'fixture' : 'vitest') + '/internal/frame' + s + '.js:' + (s + 1) + ':' + (s + 3));
      console.log('');
      console.log(' ☰ fixture output above truncated to the failing test detail');
      console.log('');
    }
  }
}
console.log(' Test Files  ' + (failed > 0 ? '1 failed (1)' : '1 passed (1)'));
console.log('      Tests  ' + (failed > 0 ? failed + ' failed (' + cases.length + ')' : cases.length + ' passed (' + cases.length + ')'));
console.log('   Start at  ' + new Date().toISOString());
console.log('   Duration  0.42s (transform 100ms, setup 50ms, collect 80ms, tests 30ms, environment 50ms, prepare 60ms)');
process.exit(failed > 0 ? 1 : 0);
`;
}

export function makeFixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'mochi-lazy-proof-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'lazy-proof-fixture', type: 'module', scripts: { test: 'node tests/run.js' } }, null, 2));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src', 'parser.js'), makeParserBody());
  writeFileSync(join(dir, 'src', 'calc.js'), CALC_BUGGY);
  writeFileSync(join(dir, 'tests', 'run.js'), testRunnerScript());
  exec('git init -q', dir);
  exec('git config user.email proof@fixture && git config user.name proof', dir);
  writeFileSync(join(dir, '.gitignore'), 'node_modules\nanswer.txt\nCHANGES.md\n');
  exec('git add -A && git commit -q -m fixture', dir);
  // Uncommitted multi-file changes for the diff surface: 12 files, ~2 hunks
  // each (~28KB of raw `git diff`).
  for (let f = 0; f < 12; f++) {
    const p = join(dir, 'src', `mod${f}.js`);
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(`// mod${f} original line ${i}`);
    for (let h = 0; h < 2; h++) {
      lines.push(`export function mod${f}Hunk${h}() {`);
      for (let k = 0; k < 8; k++) lines.push(`  const v${k} = ${k}; // will change`);
      lines.push(`  return [${Array.from({ length: 8 }, (_, k) => `v${k}`).join(', ')}].join('-');`);
      lines.push(`}`);
    }
    writeFileSync(p, lines.join('\n'));
  }
  exec('git add -A && git commit -q -m mods', dir);
  for (let f = 0; f < 12; f++) {
    const p = join(dir, 'src', `mod${f}.js`);
    const content = readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => (l.includes('will change') ? l.replace('// will change', '// changed for the diff fixture with a longer tail comment') : l))
      .concat(Array.from({ length: 4 }, (_, k) => `// appended line ${k} for mod${f} to widen the hunk`))
      .join('\n');
    writeFileSync(p, content);
  }
  return dir;
}

export function exec(cmd, cwd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture setup failed: ${cmd}: ${r.stderr}`);
}
