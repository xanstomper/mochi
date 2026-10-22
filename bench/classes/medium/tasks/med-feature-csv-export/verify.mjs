// Class fixture verifier for med-feature-csv-export. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
import { spawnSync } from 'node:child_process';
const { ROWS } = require('./report/data.js');
const { formatTable } = require('./report/format.js');
const run = (args) => {
  const r = spawnSync('node', ['report/cli.js', ...args], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) fail(`cli exited ${r.status}: ${r.stderr || ''}`);
  return r.stdout || '';
};
const expectedCsv = [
  'name,role,note',
  'Ada Lovelace,engineer,first programmer',
  'Grace Hopper,admiral,"found a moth, literally"',
  'Alan Turing,researcher,"said ""machines take me by surprise""' + '"',
  'Edsger Dijkstra,researcher,"line one',
  'line two"',
].join('\n') + '\n';
eq(run(['--csv']), expectedCsv, 'CSV output with RFC 4180 quoting');
eq(run([]), formatTable(ROWS) + '\n', 'default table output unchanged');
console.log('PASS: csv export is exact, table untouched');
