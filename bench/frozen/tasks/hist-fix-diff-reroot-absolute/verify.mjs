// Frozen verifier for hist-fix-diff-reroot-absolute.
// Derived from git commit b484d84 (fix(apply): re-root in-root absolute
// diff paths instead of rejecting them; follow-up to the B14 hardening
// b1d288b) and its three red-to-green tests: an in-root absolute path
// re-roots and applies, an escaping one is rejected with 'Path escapes
// workspace root' (pre-fix it threw the generic 'Unsafe path' instead),
// and the end-to-end atomic apply works. Runs with cwd = the task
// workdir; end-to-end cases run in a scratch dir under it. Exit 0/1.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { parseUnifiedDiff, applyDiffAtomically } = require('./diff-apply.js');

const fails = [];
const eq = (got, want, label) => { if (got !== want) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
const throwsWith = (fn, needle, label) => {
  try { fn(); } catch (e) { if (!String(e.message).includes(needle)) fails.push(`${label}: threw "${e.message}", want message containing "${needle}"`); return; }
  fails.push(`${label}: did not throw`);
};

const updateDiff = (oldP, newP) => [
  'diff --git a/src/a.ts b/src/a.ts',
  `--- ${oldP}`,
  `+++ ${newP}`,
  '@@ -1,3 +1,3 @@',
  ' alpha',
  '-beta',
  '+BETA',
  ' gamma',
  '',
].join('\n');

// No root: absolute paths are rejected outright (conservative posture).
throwsWith(() => parseUnifiedDiff(updateDiff('/ws/root/src/a.ts', '/ws/root/src/a.ts')),
  'Unsafe path in diff', 'no-root absolute path rejected');
// With a root: an in-root absolute path re-roots to workspace-relative.
let ops = [];
try {
  ops = parseUnifiedDiff(updateDiff('/ws/root/src/a.ts', '/ws/root/src/a.ts'), '/ws/root');
} catch (e) {
  fails.push(`in-root absolute path threw instead of parsing: "${e.message}"`);
}
eq(ops.length, 1, 'in-root absolute: one op parsed');
eq(ops[0]?.path, 'src/a.ts', 'in-root absolute path re-rooted');
eq(ops[0]?.op, 'update', 'in-root absolute op kind');
// Escaping absolute path: rejected with the ESCAPES message (not the
// generic unsafe-path one).
throwsWith(() => parseUnifiedDiff(updateDiff('/ws/evil.ts', '/ws/evil.ts'), '/ws/root'),
  'Path escapes workspace root', 'escaping absolute path rejected with escapes message');
// Sibling sharing a string prefix is NOT inside the root.
throwsWith(() => parseUnifiedDiff(updateDiff('/ws/rootly/a.ts', '/ws/rootly/a.ts'), '/ws/root'),
  'Path escapes workspace root', 'prefix-sibling absolute path rejected');
// The root itself is not a file target.
throwsWith(() => parseUnifiedDiff(updateDiff('/ws/root', '/ws/root'), '/ws/root'),
  'Path escapes workspace root', 'root-as-path rejected');
// Create op with an absolute target re-roots too (/dev/null counterpart).
const createDiff = [
  'diff --git a/src/new.ts b/src/new.ts',
  '--- /dev/null',
  '+++ /ws/root/src/new.ts',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n');
let cops = [];
try {
  cops = parseUnifiedDiff(createDiff, '/ws/root');
} catch (e) {
  fails.push(`absolute create path threw instead of parsing: "${e.message}"`);
}
eq(cops[0]?.path, 'src/new.ts', 'absolute create path re-rooted');
eq(cops[0]?.op, 'create', 'absolute create op kind');
// Relative behavior unchanged: a/ b/ prefixes strip, `..` still rejected.
let rel = [];
try {
  rel = parseUnifiedDiff(updateDiff('a/src/a.ts', 'b/src/a.ts'), '/ws/root');
} catch (e) {
  fails.push(`relative path threw unexpectedly: "${e.message}"`);
}
eq(rel[0]?.path, 'src/a.ts', 'relative path unchanged by the restructure');
throwsWith(() => parseUnifiedDiff(updateDiff('a/../evil.ts', 'b/../evil.ts'), '/ws/root'),
  'Unsafe path in diff', 'dotdot relative path still rejected');

// End-to-end: applyDiffAtomically passes its root, so an absolute-path
// diff applies to the re-rooted file…
const root = mkdtempSync(join(process.cwd(), '.apply-e2e-'));
try {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'alpha\nbeta\ngamma\n', 'utf8');
  let res = null;
  try {
    res = applyDiffAtomically(root, updateDiff(`${root}/src/a.ts`, `${root}/src/a.ts`));
  } catch (e) {
    fails.push(`end-to-end absolute apply threw instead of applying: "${e.message}"`);
  }
  eq((res?.applied ?? []).join(','), 'src/a.ts', 'end-to-end: applied reports the re-rooted path');
  eq(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'alpha\nBETA\ngamma\n', 'end-to-end: file content updated');
  // …and an escaping diff writes NOTHING outside the root.
  const outside = join(root, '..', 'escaped-frozen.txt');
  throwsWith(() => applyDiffAtomically(root, updateDiff(`${root}/../escaped-frozen.txt`, `${root}/../escaped-frozen.txt`)),
    'Path escapes workspace root', 'end-to-end escape rejected');
  if (existsSync(outside)) fails.push('end-to-end escape WROTE a file outside the root');
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (fails.length === 0) {
  console.log('PASS: in-root absolute diff paths re-root and apply end-to-end; escaping/prefix-sibling/root paths rejected as escapes; no-root stays conservative; relative behavior unchanged');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
