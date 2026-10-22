// Class fixture verifier for short-script-wordfreq. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const run = (file) => {
  const r = spawnSync('node', ['wordfreq.js', file], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) fail(`wordfreq exited ${r.status}: ${r.stderr || ''}`);
  return (r.stdout || '').replace(/\n$/, '');
};
eq(run('sample.txt'), ['the 3', 'cat 2', 'and 1', 'dog 1', 'ran 1', 'sat 1', 'slept 1'].join('\n'), 'sample ordering');
writeFileSync('probe.txt', 'b a a b c c c\n');
eq(run('probe.txt'), ['c 3', 'a 2', 'b 2'].join('\n'), 'probe ordering');
console.log('PASS: wordfreq ordering is frequency-first');
