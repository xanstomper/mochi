// Frozen verifier for arena-f1-feature-add-test.
// Ported exactly from bench/arena.mjs task f1 `check` (MCH-90).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.cwd();
if (!existsSync(join(dir, 'add.js'))) { console.log('FAIL: add.js missing'); process.exit(1); }
if (!existsSync(join(dir, 'add.test.js'))) { console.log('FAIL: add.test.js missing'); process.exit(1); }
const r = spawnSync('node', ['add.test.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
const out = (r.stdout || '').trim();
if (out.endsWith('5')) { console.log('PASS: printed 5'); process.exit(0); }
console.log(`FAIL: ran but printed ${JSON.stringify(out.slice(0, 40))}`);
process.exit(1);
