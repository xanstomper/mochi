// Class fixture verifier for short-question-entrypoint. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
import { readFileSync, existsSync } from 'node:fs';
if (!existsSync('answer.txt')) fail('answer.txt not found');
const lines = readFileSync('answer.txt', 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
eq(lines, ['entry=main.js', 'formatter=formatDuration'], 'answers');
console.log('PASS: entry point and formatter identified');
