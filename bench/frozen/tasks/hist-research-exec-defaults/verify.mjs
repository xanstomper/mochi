// Frozen verifier for hist-research-exec-defaults.
// Ground truth read directly from the fixture file (src/exec.ts lines 1-70,
// verbatim from e39d744^): DEFAULT_TIMEOUT_MS = 120_000 (line 50),
// DEFAULT_MAX_OUTPUT = 2_000_000 (line 51), killGraceMs default 1500
// (line 62). Values are compared digit-wise after stripping underscores,
// spaces and commas, so a correct answer written as 120_000 or 120,000
// still passes; the numeric value must be exact.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const p = join(process.cwd(), 'answer.txt');
if (!existsSync(p)) {
  console.log('FAIL: answer.txt not found in the workdir');
  process.exit(1);
}
const text = readFileSync(p, 'utf8');
const getDigits = (key) => {
  const m = new RegExp(`^${key}=([0-9_,\\s]+)$`, 'm').exec(text);
  return m ? m[1].replace(/[_,\s]/g, '') : null;
};
const fails = [];
if (getDigits('TIMEOUT_MS') !== '120000') fails.push(`TIMEOUT_MS=${getDigits('TIMEOUT_MS')}, want 120000`);
if (getDigits('MAX_OUTPUT_BYTES') !== '2000000') fails.push(`MAX_OUTPUT_BYTES=${getDigits('MAX_OUTPUT_BYTES')}, want 2000000`);
if (getDigits('KILL_GRACE_MS') !== '1500') fails.push(`KILL_GRACE_MS=${getDigits('KILL_GRACE_MS')}, want 1500`);

if (fails.length === 0) {
  console.log('PASS: executor defaults correct (timeout 120000 ms, max output 2000000 bytes, kill grace 1500 ms)');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
