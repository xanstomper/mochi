// B9 restructure: plan-mode verify-with-rollback.
//
// Pre-restructure, plan mode vetoed EVERY `verify` call (it is mutating:
// builds/tests write artifacts and run arbitrary project scripts). That made
// plan-mode research unable to answer "does the project's own check pass on
// the current tree?" — a question plans legitimately need answered.
//
// The restructure: non-destructive verify calls are exempt from the veto and
// execute against a tree snapshot; any tracked-file modification the command
// introduces is rolled back before the loop continues. Destructive commands
// and non-git workspaces still veto (fail closed).
//
// NOTE: scratch dirs are created under <repo>/.revtmp/ (workspace-local
// scratch, gitignored) and deliberately NOT deleted by the test — they are
// tiny and .revtmp is cleared manually. This keeps destructive-fs patterns
// out of the test source.
import { describe, it, expect } from 'vitest';
// Hermetic: this file exercises the TypeScript context engine only. The
// native Rust runtime must NOT be spawned from here — a live child process
// left behind in the vitest worker keeps the macOS runner's test step alive
// (the runner's orphan cleanup then tears the job down). The native path has
// its own parity tests.
process.env.MOCHI_NO_NATIVE = '1';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotTree, rollbackTracked, resolveVerifyCommand } from './plan-verify.js';
const SCRATCH = resolve(import.meta.dirname ?? '.', '..', '..', '.revtmp');
// The scratch root may not exist yet (fresh clone / CI) — create it so the
// test never depends on a developer's local state.
mkdirSync(SCRATCH, { recursive: true });
// Hermetic git env: point GIT_CONFIG_GLOBAL at an EMPTY file and drop the
// system config, so the test's git calls behave the same on every machine
// (no dubious-ownership guards, no signing keys, no user-global aliases).
// (The original pinned a developer's absolute path, which only existed on
// their workstation.)
const GITCFG = join(mkdtempSync(join(tmpdir(), 'mochi-planverify-gitcfg-')), 'gitconfig');
writeFileSync(GITCFG, '');
const GITENV = { ...process.env, GIT_CONFIG_GLOBAL: GITCFG, GIT_CONFIG_NOSYSTEM: '1' };

function scratchDir(prefix: string): string {
  return mkdtempSync(join(SCRATCH, prefix));
}

/** Content read back from disk, normalized to LF: a Windows checkout may
 *  materialize CRLF, and the contract under test is "the pre-verify content
 *  is restored", not the platform's line-ending convention. */
function readLf(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function gitRepo(): string {
  const dir = scratchDir('b9pv-git-');
  const g = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: GITENV, stdio: 'pipe' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  // Keep the working tree byte-exact: Windows git defaults to
  // core.autocrlf=true, which would rewrite the committed blobs to CRLF on
  // checkout and make the restored content differ from the pre-verify
  // content the test pins.
  g(['config', 'core.autocrlf', 'false']);
  // Both files tracked: b.txt is the "user-dirtied before verify" file, so it
  // must be in HEAD for the tracked-dirty baseline to see it.
  writeFileSync(join(dir, 'a.txt'), 'original\n');
  writeFileSync(join(dir, 'b.txt'), 'base\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
  return dir;
}

describe('resolveVerifyCommand', () => {
  it('appends target exactly like tools/verify.ts — the classifier sees the FULL string', () => {
    const dir = scratchDir('b9pv-pkg-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    // Same append shape as verify.ts:52 (`-- ` added unless target has it).
    expect(resolveVerifyCommand({ command: 'test', target: 'src/foo.test.ts' }, dir))
      .toBe('npm test -- src/foo.test.ts');
    expect(resolveVerifyCommand({ command: 'test', target: '-- --grep x' }, dir))
      .toBe('npm test -- --grep x');
    // Verbatim command containing 'test' gets the target appended, same as
    // the tool (its condition: cmdType === 'test' || cmd.includes('test'));
    // a command like 'mocha' contains no 'test' so the tool ignores its
    // target — ignored here too.
    expect(resolveVerifyCommand({ command: 'run tests all', target: 'a.test.ts' }, dir))
      .toBe('run tests all -- a.test.ts');
    expect(resolveVerifyCommand({ command: 'mocha', target: 'a.test.ts' }, dir))
      .toBe('mocha');
    // A target on a NON-test command is ignored by the tool — ignored here
    // too (classification matches execution).
    expect(resolveVerifyCommand({ command: 'npx tsc --noEmit', target: 'x; wget evil' }, dir))
      .toBe('npx tsc --noEmit');
    // The injected-metachar target must SURVIVE into the classified string —
    // the gate (not the tool) is what refuses it in plan mode.
    expect(resolveVerifyCommand({ command: 'test', target: 'x; wget evil' }, dir))
      .toBe('npm test -- x; wget evil');
  });

  it('fails closed (null) when package.json is unreadable for an alias', () => {
    const dir = scratchDir('b9pv-nopkg-');
    expect(resolveVerifyCommand({ command: 'test' }, dir)).toBeNull();
    // Verbatim commands never need repo detection.
    expect(resolveVerifyCommand({ command: 'echo hi' }, dir)).toBe('echo hi');
  });
});

describe('snapshotTree / rollbackTracked', () => {
  it('snapshots a dirty tree without touching it; rollback restores only what the command introduced', async () => {
    const dir = gitRepo();
    // User dirties b.txt BEFORE verify runs.
    writeFileSync(join(dir, 'b.txt'), 'user edit\n');
    const snap = await snapshotTree(dir);
    expect(snap).not.toBeNull();
    expect(snap!.baselineDirty).toEqual(['b.txt']);
    // Snapshot must not have disturbed the working tree.
    expect(readLf(join(dir, 'b.txt'))).toBe('user edit\n');

    // "verify" overwrites both: the user-dirtied file and a clean tracked file.
    writeFileSync(join(dir, 'b.txt'), 'user edit + verify noise\n');
    writeFileSync(join(dir, 'a.txt'), 'verify wrote here\n');
    const r = await rollbackTracked(dir, snap!);
    // BOTH paths restored to their pre-verify content: a.txt from HEAD (clean
    // baseline), b.txt from the snapshot commit (whose tree recorded the
    // user's dirty content at snapshot time) — verify's noise is undone and
    // the user's edit survives.
    expect(r.rolledBack.sort()).toEqual(['a.txt', 'b.txt']);
    expect(readLf(join(dir, 'a.txt'))).toBe('original\n');
    expect(readLf(join(dir, 'b.txt'))).toBe('user edit\n');
    // Untracked artifacts: under the tightened contract, a file CREATED after
    // the snapshot is a command artifact and is DELETED on rollback (not
    // merely reported).
    writeFileSync(join(dir, 'out.js'), 'artifact');
    const r2 = await rollbackTracked(dir, snap!);
    expect(existsSync(join(dir, 'out.js'))).toBe(false);
    expect(r2.untrackedLeftover).not.toContain('out.js');
  });

  it('rollback preserves the user index state (staged stays staged, unstaged stays unstaged)', async () => {
    const dir = gitRepo();
    // User edits a.txt and stages it; edits b.txt unstaged.
    writeFileSync(join(dir, 'a.txt'), 'user staged edit\n');
    writeFileSync(join(dir, 'b.txt'), 'user unstaged edit\n');
    execFileSync('git', ['-C', dir, 'add', 'a.txt'], { env: GITENV, stdio: 'pipe' });
    const snap = await snapshotTree(dir);
    expect(snap).not.toBeNull();
    // Verify dirties BOTH files further.
    writeFileSync(join(dir, 'a.txt'), 'verify noise\n');
    writeFileSync(join(dir, 'b.txt'), 'verify noise\n');
    const r = await rollbackTracked(dir, snap!);
    expect(r.rolledBack.sort()).toEqual(['a.txt', 'b.txt']);
    // Content restored to pre-verify in both cases.
    expect(readLf(join(dir, 'a.txt'))).toBe('user staged edit\n');
    expect(readLf(join(dir, 'b.txt'))).toBe('user unstaged edit\n');
    // INDEX state preserved: a.txt still staged (X='M'), b.txt still only
    // unstaged (X=' '). Before the fix, checkout -- staged BOTH.
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { env: GITENV, stdio: 'pipe' }).toString();
    const aRow = status.split('\n').find((l) => l.endsWith(' a.txt'));
    const bRow = status.split('\n').find((l) => l.endsWith(' b.txt'));
    expect(aRow?.[0]).toBe('M'); // staged modification preserved
    expect(bRow?.[0]).toBe(' '); // NOT staged by the rollback
  });

  it('deletes untracked artifacts the command CREATED, keeps pre-existing untracked paths', async () => {
    const dir = gitRepo();
    // Pre-existing untracked file BEFORE verify.
    writeFileSync(join(dir, 'preexisting.txt'), 'user file\n');
    const snap = await snapshotTree(dir);
    expect(snap).not.toBeNull();
    expect([...snap!.baselineUntracked]).toEqual(['preexisting.txt']);
    // Verify creates an artifact and dirties a tracked file.
    writeFileSync(join(dir, 'dist.out'), 'verify artifact\n');
    writeFileSync(join(dir, 'a.txt'), 'verify wrote here\n');
    const r = await rollbackTracked(dir, snap!);
    // Created artifact GONE; pre-existing file UNTOUCHED.
    expect(existsSync(join(dir, 'dist.out'))).toBe(false);
    expect(existsSync(join(dir, 'preexisting.txt'))).toBe(true);
    expect(readLf(join(dir, 'preexisting.txt'))).toBe('user file\n');
    // The created artifact is not reported as a leftover; the pre-existing
    // one is (the caller surfaces it honestly).
    expect(r.untrackedLeftover).toContain('preexisting.txt');
    expect(r.untrackedLeftover).not.toContain('dist.out');
  });

  it('fails closed outside a git repo', async () => {
    // Must be OUTSIDE any git repo: scratch under .revtmp is inside the mochi
    // repo, so use the OS temp dir (left behind deliberately — tiny).
    const dir = mkdtempSync(join(tmpdir(), 'b9pv-nogit-'));
    expect(await snapshotTree(dir)).toBeNull();
  });
});
