// Frozen verifier for hist-fix-racer-shell-verification.
// Derived from git commit bbcaa62 (fix(branch-racer): run verification
// through the shell) and its regression test in src/core/branch-racer.test.ts
// ('runs verification commands with quoted arguments, env assignments, and
// && chains' — a command the commit notes is "unparseable by the old
// testCmd.split(' ') route").
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { runVerificationCommand } = require('./run-verify.js');

const dir = process.cwd();
const fx = join(dir, '.verify-fixtures');
mkdirSync(fx, { recursive: true });
writeFileSync(join(fx, 'verify-quoted.js'), [
  'if (process.env.EXPECTED_GREETING !== "hello world") process.exit(1);',
  'if (process.argv[2] !== "a b") process.exit(2);',
  'if (process.argv[3] !== "c d") process.exit(3);',
  'process.exit(0);',
].join('\n'));
writeFileSync(join(fx, 'ok.js'), 'process.exit(0);\n');
writeFileSync(join(fx, 'bad.js'), 'process.exit(5);\n');

const fails = [];
const check = async (label, cmd, wantPassed, wantCode) => {
  let r;
  try { r = await runVerificationCommand(cmd, fx); } catch (e) { fails.push(`${label}: REJECTED (${e.message}) — contract says never reject`); return; }
  if (r.passed !== wantPassed || (wantCode !== undefined && r.code !== wantCode)) {
    fails.push(`${label}: got {passed:${r.passed}, code:${r.code}}, want passed=${wantPassed}${wantCode !== undefined ? ` code=${wantCode}` : ''}`);
  }
};

// The fix commit's own scenario: env assignment + double/single-quoted
// arguments containing spaces + an && chain.
await check('env+quotes+chain', 'EXPECTED_GREETING="hello world" node verify-quoted.js "a b" \'c d\' && node ok.js', true, 0);
await check('plain command', 'node ok.js', true, 0);
await check('quoted arg only', 'node verify-quoted.js "a b" \'c d\'', false); // env missing → checker exits 1
await check('non-zero exit resolves', 'node bad.js', false, 5);
await check('missing script resolves', 'node nope-not-here.js', false);

if (fails.length === 0) {
  console.log('PASS: verification commands run verbatim through the shell (env assignments, quoted args, && chains); contract never rejects');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
