// Frozen verifier for arena-r1-refactor-rename.
// Ported exactly from bench/arena.mjs task r1 `check` (MCH-90).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.cwd();
const c = readFileSync(join(dir, 'calc.js'), 'utf8');
const a = readFileSync(join(dir, 'app.js'), 'utf8');
if (c.includes('calcTotal') || a.includes('calcTotal')) { console.log('FAIL: old name still present'); process.exit(1); }
const r = spawnSync('node', ['app.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
const out = (r.stdout || '').trim();
if (out === '11') { console.log('PASS: renamed + prints 11'); process.exit(0); }
console.log(`FAIL: prints ${JSON.stringify(out.slice(0, 40))}`);
process.exit(1);
