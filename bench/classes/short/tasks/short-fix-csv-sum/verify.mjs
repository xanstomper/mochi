// Class fixture verifier for short-fix-csv-sum. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { sumColumn } = require('./sumcsv.js');
eq(sumColumn('name,amount\na,10\nb,20\n', 'amount'), 30, 'basic with trailing newline');
eq(sumColumn('name,amount\na,10\n\nb,20\n', 'amount'), 30, 'blank line ignored');
eq(sumColumn('x,y\n1,2\n3,4', 'x'), 4, 'first column');
eq(sumColumn('x,y\n1,\n3,4', 'y'), 4, 'empty cell counts as 0');
let threw = false;
try { sumColumn('a,b\n1,2', 'nope'); } catch { threw = true; }
eq(threw, true, 'unknown column throws');
console.log('PASS: csv sum contract holds');
