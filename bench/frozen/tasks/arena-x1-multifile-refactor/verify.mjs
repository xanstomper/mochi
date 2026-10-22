// Frozen verifier for arena-x1-multifile-refactor.
// Ported exactly from bench/arena.mjs task x1 `check` (MCH-90).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.cwd();
const u = readFileSync(join(dir, 'util.js'), 'utf8');
const c = readFileSync(join(dir, 'cart.js'), 'utf8');
if (/fmtPrice/.test(u + c)) { console.log('FAIL: old name still present'); process.exit(1); }
const r = spawnSync('node', ['util.test.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
const out = (r.stdout || '').trim();
if (out === '10.50') { console.log('PASS: renamed + prints 10.50'); process.exit(0); }
console.log(`FAIL: prints ${JSON.stringify(out.slice(0, 40))}`);
process.exit(1);
