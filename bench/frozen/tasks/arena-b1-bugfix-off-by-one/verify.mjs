// Frozen verifier for arena-b1-bugfix-off-by-one.
// Ported exactly from bench/arena.mjs task b1 `check` (MCH-90).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { spawnSync } from 'node:child_process';

const dir = process.cwd();
const r = spawnSync('node', ['run.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
const out = (r.stdout || '').trim();
if (out === '10') { console.log('PASS: prints 10'); process.exit(0); }
console.log(`FAIL: prints ${JSON.stringify(out.slice(0, 40))}`);
process.exit(1);
