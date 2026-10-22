// Frozen verifier for arena-x2-cross-module-bugfix.
// Ported exactly from bench/arena.mjs task x2 `check` (MCH-90).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { spawnSync } from 'node:child_process';

const dir = process.cwd();
const r = spawnSync('node', ['order.test.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
const out = (r.stdout || '').trim();
if (out === '11') { console.log('PASS: prints 11'); process.exit(0); }
console.log(`FAIL: prints ${JSON.stringify(out.slice(0, 40))}`);
process.exit(1);
