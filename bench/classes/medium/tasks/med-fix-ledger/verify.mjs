// Class fixture verifier for med-fix-ledger. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const accounts = require('./bank/accounts.js');
const { transfer } = require('./bank/ledger.js');
accounts.reset();
accounts.createAccount('A', 1000);
accounts.createAccount('B', 500);
transfer('A', 'B', 200); // fee 25
eq(accounts.balance('A'), 775, 'sender loses amount + fee');
eq(accounts.balance('B'), 700, 'receiver gains exactly amount');
transfer('B', 'A', 100); // fee 25
eq(accounts.balance('B'), 575, 'second sender');
eq(accounts.balance('A'), 875, 'second receiver');
eq(accounts.balance('A') + accounts.balance('B'), 1500 - 50, 'value conserved modulo burned fees');
let threw = false;
try { transfer('A', 'B', 10000); } catch { threw = true; }
eq(threw, true, 'uncoverable transfer throws');
eq(accounts.balance('A'), 875, 'failed transfer leaves sender unchanged');
eq(accounts.balance('B'), 575, 'failed transfer leaves receiver unchanged');
console.log('PASS: ledger conserves value');
