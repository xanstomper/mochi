// Frozen verifier for hist-fix-atomic-fs-umask-mode.
// Derived from git commit 3bdc1ea (fix(atomic-fs): chmod the temp file so
// preserved permission bits survive any umask). The regression case is the
// one the commit names: preserved 0o755 under umask 0007 must survive; the
// pre-fix module yields 0o750 (see src/core/atomic-fs.ts at 3bdc1ea^).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.cwd();
const scratch = join(dir, '.verify-scratch');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// Driver runs in a CHILD process so process.umask(0o007) applies exactly the
// way it did for the real bug (the verifier's own umask is irrelevant).
const driver = `
const { writeFileSync, statSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
process.umask(0o007);
const { atomicWriteFileSync } = require(join(process.cwd(), 'atomic-fs.js'));
const target = join(process.cwd(), '.verify-scratch', 'script.sh');
writeFileSync(target, 'old content\\n');
chmodSync(target, 0o755);
atomicWriteFileSync(target, 'new content\\n');
const mode = statSync(target).mode & 0o777;
const secret = join(process.cwd(), '.verify-scratch', 'secret.txt');
atomicWriteFileSync(secret, 's3cret\\n', { mode: 0o755 });
const secretMode = statSync(secret).mode & 0o777;
console.log(JSON.stringify({ mode, secretMode }));
`;
writeFileSync(join(dir, '.verify-driver.cjs'), driver);
const r = spawnSync('node', ['.verify-driver.cjs'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
let got;
try { got = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* handled below */ }
const content = readFileSync(join(scratch, 'script.sh'), 'utf8');
const leftovers = readdirSync(scratch).filter((f) => f.endsWith('.tmp'));
const modeStr = (m) => (m === undefined ? '?' : `0${m.toString(8)}`);
if (
  got && got.mode === 0o755 && got.secretMode === 0o755 &&
  content === 'new content\n' && leftovers.length === 0
) {
  console.log('PASS: mode 0755 preserved under umask 0007 for both preserved and explicit modes; content written; no temp leftovers');
  process.exit(0);
}
console.log(`FAIL: mode=${modeStr(got?.mode)} explicitMode=${modeStr(got?.secretMode)} content=${JSON.stringify(content)} tmpLeftovers=${leftovers.length} (expected 0755/0755, new content, no leftovers; driver stderr: ${(r.stderr || '').trim().slice(0, 120)})`);
process.exit(1);
