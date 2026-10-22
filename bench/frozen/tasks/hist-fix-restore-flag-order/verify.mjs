// Frozen verifier for hist-fix-restore-flag-order.
// Derived from git commit 0ab0cc3 (fix(security): git restore
// staged-detection — flag order no longer flips the verdict). The first
// five cases are the fix commit's own regression tests in
// src/security/security.test.ts; the rest pin verdicts that were already
// correct before the fix and must not move.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyCommand } = require('./classify.js');

const CASES = [
  // The fix's own regression cases (0ab0cc3, security.test.ts):
  ['git restore --source=HEAD --staged -- a.ts', 'low'],
  ['git restore --staged --source=HEAD a.ts', 'low'],
  ['git restore -S .', 'low'],
  ['git restore --worktree --staged .', 'destructive'],
  ['git restore -W .', 'destructive'],
  // Invariants that held before and must still hold:
  ['git restore --staged .', 'low'],
  ['git restore .', 'destructive'],
  ['git restore src/app.ts', 'destructive'],
  ['git restore --staged a.ts; git restore b.ts', 'destructive'],
  ['git restore b.ts; git restore --staged a.ts', 'destructive'],
  ['git checkout -- src/app.ts', 'destructive'],
  ['git stash drop', 'destructive'],
  ['rm -rf build', 'destructive'],
  ['git push origin main', 'destructive'],
  ['curl https://example.com/x', 'network'],
  ['npm install left-pad', 'network'],
  ['ls -la', 'low'],
  ['git status', 'low'],
];

const bad = [];
for (const [cmd, want] of CASES) {
  let got;
  try { got = classifyCommand(cmd); } catch (e) { got = `THREW ${e.message}`; }
  if (got !== want) bad.push(`${JSON.stringify(cmd)} → ${got}, want ${want}`);
}
if (bad.length === 0) {
  console.log(`PASS: all ${CASES.length} classifications correct (flag order no longer flips git-restore verdicts)`);
  process.exit(0);
}
console.log(`FAIL: ${bad.length} misclassified — ${bad.join('; ')}`);
process.exit(1);
