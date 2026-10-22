// Frozen verifier for arena-q1-codebase-question.
// Ported exactly from bench/arena.mjs task q1 `check` (MCH-90).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.cwd();
if (!existsSync(join(dir, 'answer.txt'))) { console.log('FAIL: answer.txt missing'); process.exit(1); }
const t = readFileSync(join(dir, 'answer.txt'), 'utf8');
const ok = /VAR\s*=\s*AUTH_SALT/i.test(t) && /FALLBACK\s*=\s*pepper/i.test(t);
if (ok) { console.log('PASS: both facts correct'); process.exit(0); }
console.log(`FAIL: wrong: ${JSON.stringify(t.trim().slice(0, 80))}`);
process.exit(1);
