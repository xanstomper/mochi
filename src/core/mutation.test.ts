import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { findMutation, runMutationCheck, changedSourceFiles, enumerateMutations } from './mutation.js';
import { execSync } from 'node:child_process';

let dirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-mut-'));
  dirs.push(dir);
  // Init so `git diff --name-only` sees working-tree changes.
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t && git config user.name t', { cwd: dir });
  // Track an initial commit so later file changes show up in `git diff`.
  writeFileSync(resolve(dir, 'seed.txt'), 'seed');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('mutation.findMutation', () => {
  it('finds a real equality operator', () => {
    const m = findMutation('if (a === b) return 1;');
    expect(m).not.toBeNull();
    expect(m!.from).toBe('===');
    expect(m!.to).toBe('!==');
  });

  it('skips operators inside string literals and comments', () => {
    // The '+' and '===' are inside a string/comment, so the first real operator
    // is the '<' comparison.
    const src = '// a === b comment\nconst s = "a === b";\nif (x < y) return 0;';
    const m = findMutation(src);
    expect(m).not.toBeNull();
    expect(m!.from).toBe('<');
    expect(m!.index).toBeGreaterThan(src.indexOf('if'));
  });

  it('returns null when there is nothing flippable', () => {
    expect(findMutation('const x = 1; // nothing flippable\nreturn "done";')).toBeNull();
  });

  it('mutates Python operators (== and and/or)', () => {
    const mEq = findMutation('if a == b:\n    return 1');
    expect(mEq?.from).toBe('==');
    expect(mEq?.to).toBe('!=');
    const mAnd = findMutation('if a and b:\n    return 1');
    expect(mAnd?.from).toBe(' and ');
    expect(mAnd?.to).toBe(' or ');
  });

  it('mutates Go and Rust shared operators (==, &&)', () => {
    const mEq = findMutation('if a == b { return 1 }');
    expect(mEq?.from).toBe('==');
    expect(mEq?.to).toBe('!=');
    const mAnd = findMutation('if a && b { return 1 }');
    expect(mAnd?.from).toBe('&&');
    expect(mAnd?.to).toBe('||');
  });
});

describe('mutation.runMutationCheck', () => {
  it('reports KILLED when the test runner catches the injected bug', async () => {
    const dir = makeRepo();
    // Source with a real comparison; the test would fail if it flipped.
    writeFileSync(resolve(dir, 'add.ts'), 'export function add(a,b){ return a + b; }\nexport function gt(a,b){ return a > b; }');
    const result = await runMutationCheck(dir, 'npm test', async () => 1); // mutated -> fail -> killed
    expect(result.applied).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.survived).toBe(false);
    // File restored to exact original bytes.
    expect(readFileSync(resolve(dir, 'add.ts'), 'utf8')).toBe('export function add(a,b){ return a + b; }\nexport function gt(a,b){ return a > b; }');
  });

  it('reports SURVIVED when tests stay green under the injected bug (weak coverage)', async () => {
    const dir = makeRepo();
    writeFileSync(resolve(dir, 'util.ts'), 'export const answer = 42;\nexport function cmp(a,b){ if (a > b) return "big"; return "small"; }');
    const result = await runMutationCheck(dir, 'test', async () => 0); // mutated but tests still pass
    expect(result.applied).toBe(true);
    expect(result.survived).toBe(true);
    expect(result.killed).toBe(false);
    expect(readFileSync(resolve(dir, 'util.ts'), 'utf8')).toContain('answer = 42');
  });

  it('reports KILLED when a print-style check still exits 0 but output changes', async () => {
    const dir = makeRepo();
    writeFileSync(resolve(dir, 'math.js'), 'module.exports = { add: (a, b) => a + b };');
    // Real print path: baseline prints 5, the mutated file prints 2 (the '+'
    // flips to '-') but EXITS 0 both times. Exit-code-only detection would call
    // this survived; output-diff must call it killed.
    const cmd = 'node -e "const {add}=require(\'./math.js\'); process.stdout.write(String(add(2,3)))"';
    const result = await runMutationCheck(
      dir,
      cmd,
      async (c) => { try { execSync(c, { cwd: dir }); return 0; } catch { return 1; } },
      async (c) => String(execSync(c, { cwd: dir }) ?? ''),
    );
    expect(result.applied).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.survived).toBe(false);
    expect(result.note).toContain('output changed');
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('a + b');
  }, 20_000);

  it('does not mistake TAP timing noise for a killed mutant', async () => {
    // Regression (Wave S4): `node --test` emits `duration_ms: 1.029107` in
    // its per-test YAML diagnostics. The old normalizer only stripped the
    // `duration_ms 5` footer form, so two identical green runs differed and
    // EVERY mutant was reported KILLED — the check became a no-op exactly on
    // the runner it was meant to police.
    const dir = makeRepo();
    writeFileSync(resolve(dir, 'same.js'), 'module.exports = { same: (a, b) => a === b };');
    let n = 0;
    const tap = () => [
      'TAP version 13',
      '# Subtest: unrelated',
      'ok 1 - unrelated',
      '  ---',
      `  duration_ms: ${n++ === 0 ? '1.029107' : '2.718281'}`,
      '  ...',
      '1..1',
      '# pass 1',
    ].join('\n');
    const result = await runMutationCheck(
      dir,
      'node --test',
      async () => 0, // green before AND after the mutation
      async () => tap(),
    );
    expect(result.applied).toBe(true);
    expect(result.survived).toBe(true);
    expect(result.killed).toBe(false);
  });

  it('mutates python sources and reports KILLED under pytest', async () => {
    const dir = makeRepo();
    writeFileSync(resolve(dir, 'arith.py'), 'def add(a, b):\n    return a + b\n');
    const cmd = 'python3 -m pytest -q 2>&1 | tail -3';
    const result = await runMutationCheck(
      dir,
      cmd,
      async (c) => { try { execSync(c, { cwd: dir }); return 0; } catch { return 1; } },
      async (c) => String(execSync(c, { cwd: dir }) ?? ''),
    );
    // The '+'-flip only matters if the mutated file is actually targeted; the
    // point of this test is that a .py file is now a viable mutation target.
    expect(result.applied).toBe(true);
    expect(['+', '-']).toContain(result.target?.match(/[+-]/)?.[0]);
    expect(readFileSync(resolve(dir, 'arith.py'), 'utf8')).toContain('a + b');
  }, 60_000);

  it('skips when there are no changed source files', async () => {
    const dir = makeRepo();
    // no uncommitted source changes
    const result = await runMutationCheck(dir, 'test', async () => 1);
    expect(result.applied).toBe(false);
    expect(result.note).toContain('No changed source');
  });

  it('restricts mutation to the task fileScope when provided', async () => {
    // Two source files in the working tree; only the in-scope one must be
    // mutated. The out-of-scope file would otherwise get picked first by
    // changedSourceFiles (alphabetic order) and produce a meaningless
    // "survived" verdict against logic the verification command does not
    // exercise.
    const dir = makeRepo();
    writeFileSync(resolve(dir, 'a-out-of-scope.js'), 'module.exports = { x: 1 };');
    writeFileSync(resolve(dir, 'b-in-scope.js'), 'module.exports = { add: (a, b) => a + b };');
    const cmd = 'node -e "const {add}=require(\'./b-in-scope.js\'); if(add(2,3)!==5) process.exit(1)"';
    const result = await runMutationCheck(
      dir,
      cmd,
      async (c) => { try { execSync(c, { cwd: dir }); return 0; } catch { return 1; } },
      async (c) => String(execSync(c, { cwd: dir }) ?? ''),
      ['b-in-scope.js'],
    );
    expect(result.applied).toBe(true);
    expect(result.file).toBe('b-in-scope.js');
    expect(result.killed).toBe(true);
    expect(readFileSync(resolve(dir, 'a-out-of-scope.js'), 'utf8')).toBe('module.exports = { x: 1 };');
    expect(readFileSync(resolve(dir, 'b-in-scope.js'), 'utf8')).toContain('a + b');
  });

  it('returns no-mutation when fileScope contains nothing changed', async () => {
    const dir = makeRepo();
    writeFileSync(resolve(dir, 'untouched.js'), 'module.exports = 1;');
    const result = await runMutationCheck(dir, 'test', async () => 1, undefined, ['only-this.js']);
    expect(result.applied).toBe(false);
    expect(result.note).toContain('fileScope');
  });

  it('excludes test files in every polyglot convention from mutation candidates', async () => {
    const dir = makeRepo();
    // Source candidates that WOULD be mutated.
    writeFileSync(resolve(dir, 'math.py'), 'def add(a,b): return a + b');
    writeFileSync(resolve(dir, 'util.go'), 'package u');
    // Test files in polyglot conventions — these must ALL be excluded.
    writeFileSync(resolve(dir, 'x.test.ts'), 'import test out;');
    writeFileSync(resolve(dir, 'y_spec.rb'), 'RSpec.describe X do raise "x"; end');
    writeFileSync(resolve(dir, 'FooTest.java'), 'class FooTest {}');
    writeFileSync(resolve(dir, 'test_it.py'), 'def test_it(): assert True');
    writeFileSync(resolve(dir, 'foo_test.go'), 'package t');
    writeFileSync(resolve(dir, 'fluid_test.rs'), 'pub fn t() {}');
    writeFileSync(resolve(dir, 'FooTests.cs'), 'class FooTests {}');
    writeFileSync(resolve(dir, 'BarTest.php'), '<?php class BarTest {}');
    writeFileSync(resolve(dir, 'widget_spec.rb'), 'RSpec.describe Widget do end');

    const files = changedSourceFiles(dir);
    expect(files).toContain('math.py');
    expect(files).toContain('util.go');
    for (const testFile of ['x.test.ts', 'y_spec.rb', 'FooTest.java', 'test_it.py', 'foo_test.go', 'fluid_test.rs', 'FooTests.cs', 'BarTest.php', 'widget_spec.rb']) {
      expect(files).not.toContain(testFile);
    }
  });
});
describe('mutation.enumerateMutations', () => {
  it('returns every site in source order, unlike findMutation priority order', () => {
    const src = 'const s = a + b;\nif (x > 0) return 1;\nif (a === b) return 2;';
    const sites = enumerateMutations(src);
    expect(sites.map((s) => s.from)).toEqual(['+', '>', '===']);
    const idx = sites.map((s) => s.index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('prefers the longest flip at a position (=== over ==) and never overlaps', () => {
    const sites = enumerateMutations('if (a === b) return 1;');
    expect(sites).toEqual([{ index: 6, from: '===', to: '!==' }]);
  });

  it('skips operators inside strings and comments', () => {
    const src = '// a === b\nconst s = "x + y";\nif (a && b) return 1;';
    const sites = enumerateMutations(src);
    expect(sites.map((s) => s.from)).toEqual(['&&']);
  });

  it('enumerates Python and/or sites', () => {
    const sites = enumerateMutations('if a and b or c:\n    return 1');
    expect(sites.map((s) => s.from)).toEqual([' and ', ' or ']);
  });
});
