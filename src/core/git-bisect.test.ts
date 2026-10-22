import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBisect, classifyCheckExit } from './git-bisect.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

/** Build a fixture repo: `commits` commits appending lines to app.txt; the
 *  commit at `bugIndex` also appends the PLANTED_BUG marker. */
function makeRepo(commits: number, bugIndex: number): { dir: string; shas: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-bisect-test-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@mochi.agent']);
  git(dir, ['config', 'user.name', 'Mochi Test']);
  writeFileSync(join(dir, 'app.txt'), 'line 0\n');
  const shas: string[] = [];
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'commit 0']);
  shas.push(git(dir, ['rev-parse', 'HEAD']));
  for (let i = 1; i < commits; i++) {
    appendFileSync(join(dir, 'app.txt'), `line ${i}\n`);
    if (i === bugIndex) appendFileSync(join(dir, 'app.txt'), 'PLANTED_BUG\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', `commit ${i}`]);
    shas.push(git(dir, ['rev-parse', 'HEAD']));
  }
  return { dir, shas };
}

const CHECK = '! grep -q PLANTED_BUG app.txt'; // exit 0 = good (bug absent)

describe('classifyCheckExit', () => {
  it('follows the git bisect run convention', () => {
    expect(classifyCheckExit(0)).toBe('good');
    expect(classifyCheckExit(1)).toBe('bad');
    expect(classifyCheckExit(42)).toBe('bad');
    expect(classifyCheckExit(124)).toBe('bad');
    expect(classifyCheckExit(125)).toBe('skip');
    expect(classifyCheckExit(126)).toBe('abort');
    expect(classifyCheckExit(127)).toBe('abort');
    expect(classifyCheckExit(null)).toBe('abort');
  });
});

describe('runBisect on a planted-bug fixture repo', () => {
  let repo: { dir: string; shas: string[] };
  const BUG_AT = 7;
  const COMMITS = 12;

  beforeAll(() => { repo = makeRepo(COMMITS, BUG_AT); });
  afterAll(() => { rmSync(repo.dir, { recursive: true, force: true }); });

  it('finds the planted bad commit and leaves the user checkout untouched', () => {
    const headBefore = git(repo.dir, ['rev-parse', 'HEAD']);
    const statusBefore = git(repo.dir, ['status', '--porcelain']);

    const result = runBisect({ repoDir: repo.dir, good: repo.shas[0], bad: 'HEAD', checkCommand: CHECK });

    expect(result.firstBadCommit).toBe(repo.shas[BUG_AT]);
    expect(result.firstBadSubject).toBe(`commit ${BUG_AT}`);
    expect(result.rangeSize).toBe(COMMITS - 1);
    // Binary search: far fewer checks than the range size (endpoints incl.).
    expect(result.steps.length).toBeLessThan(COMMITS);
    expect(result.steps.length).toBeGreaterThan(0);
    for (const s of result.steps) expect(['good', 'bad', 'skip']).toContain(s.verdict);

    // The user's checkout was never disturbed: same HEAD, clean tree,
    // no leftover worktrees or bisect state.
    expect(git(repo.dir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(repo.dir, ['status', '--porcelain'])).toBe(statusBefore);
    expect(git(repo.dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    expect(existsSync(join(repo.dir, '.git', 'BISECT_LOG'))).toBe(false);
  });

  it('adjacent good/bad: first bad is the immediate child', () => {
    const result = runBisect({ repoDir: repo.dir, good: repo.shas[BUG_AT - 1], bad: repo.shas[BUG_AT], checkCommand: CHECK });
    expect(result.firstBadCommit).toBe(repo.shas[BUG_AT]);
  });

  it('a flipped check command fails fast at endpoint verification', () => {
    expect(() => runBisect({ repoDir: repo.dir, good: repo.shas[0], bad: 'HEAD', checkCommand: 'grep -q PLANTED_BUG app.txt' }))
      .toThrow(/endpoint verification failed/);
  });

  it('a failure that already exists at the good ref is rejected', () => {
    // good ref is AFTER the bug was introduced: check fails there too.
    expect(() => runBisect({ repoDir: repo.dir, good: repo.shas[BUG_AT + 1], bad: 'HEAD', checkCommand: CHECK }))
      .toThrow(/already exists at the good ref|endpoint verification failed/);
  });

  it('non-ancestor good ref is rejected before any searching', () => {
    git(repo.dir, ['checkout', '-b', 'orphan-side', repo.shas[2]]);
    appendFileSync(join(repo.dir, 'app.txt'), 'side branch line\n');
    git(repo.dir, ['add', '-A']);
    git(repo.dir, ['commit', '-m', 'side commit']);
    const side = git(repo.dir, ['rev-parse', 'HEAD']);
    git(repo.dir, ['checkout', 'main']);
    expect(() => runBisect({ repoDir: repo.dir, good: side, bad: 'HEAD', checkCommand: CHECK }))
      .toThrow(/not an ancestor/);
    git(repo.dir, ['branch', '-D', 'orphan-side']);
  });

  it('maxSteps is a hard bound and cleanup still happens', () => {
    expect(() => runBisect({ repoDir: repo.dir, good: repo.shas[0], bad: 'HEAD', checkCommand: CHECK, maxSteps: 2 }))
      .toThrow(/maxSteps/);
    expect(git(repo.dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  });

  it('a broken check command (exit ≥126) aborts instead of misclassifying', () => {
    expect(() => runBisect({ repoDir: repo.dir, good: repo.shas[0], bad: 'HEAD', checkCommand: 'exit 127' }))
      .toThrow(/endpoint verification|check itself is broken/);
  });
});
