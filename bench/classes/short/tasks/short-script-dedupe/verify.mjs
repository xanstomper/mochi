// Class fixture verifier for short-script-dedupe. Runs with cwd = the task workdir.
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
  const r = spawnSync('node', ['dedupe.js', file], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) fail(`dedupe exited ${r.status}: ${r.stderr || ''}`);
  return r.stdout || '';
};
eq(run('input.txt'), 'banana\napple\ncherry\n', 'file order preserved');
writeFileSync('probe-crlf.txt', 'x\r\ny\r\nx\r\n');
eq(run('probe-crlf.txt'), 'x\ny\n', 'CRLF duplicates collapse');
writeFileSync('probe-blank.txt', 'a\n\na\n');
eq(run('probe-blank.txt'), 'a\n\n', 'blank line kept once');
console.log('PASS: dedupe preserves order');
