// Adversarial mutation verification: make a "PASS" mean something stronger than
// "the commands exited 0". After the agent's own test suite passes on its
// written source, we inject a single logic bug (a *mutation*) into a changed
// source file and re-run the test command. If the tests break, the mutation was
// killed and the test suite is actually exercising that logic. If the tests
// still pass, the mutation survived - a deterministic signal that coverage of
// that control path is weak, and the verifier should flag it rather than report
// a naive clean PASS.
//
// Design constraints honoured here:
//   - No model in the mutation loop: only deterministic operator flips.
//   - Never permanently mutate the repo: the file is backed up and ALWAYS
//     restored, including on error (finally).
//   - Deterministic: flip the FIRST flippable target in the first changed
//     source file that has one, so a given diff always yields one result.
//   - Bounded: one mutation per call. Skips when there is no changed source file
//     or nothing safely flippable.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MutationCheck {
  applied: boolean;
  file?: string;
  target?: string; // human description, e.g. '===' -> '!=='
  killed?: boolean; // tests failed after mutation -> suite is sound here
  survived?: boolean; // tests passed after mutation -> weak coverage on this path
  note?: string;
}

// Ordered operator flips. Deterministic by first-file/first-match.
const FLIPS: { from: string; to: string }[] = [
  { from: '===', to: '!==' },
  { from: '!==', to: '===' },
  { from: '&&', to: '||' },
  { from: '||', to: '&&' },
  { from: '<=', to: '>=' },
  { from: '>=', to: '<=' },
  { from: '<', to: '>' },
  { from: '>', to: '<' },
  { from: '+', to: '-' },
  { from: '-', to: '+' },
];

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Cheap state scan to avoid mutating inside string literals or comments, where
 * flipping an operator would be meaningless (e.g. a '+' in an error message).
 */
function isInStringOrComment(source: string, idx: number): boolean {
  let inString: string | null = null;
  let inLineComment = false;
  let inBlock = false;
  for (let i = 0; i < idx; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && n === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') inString = c;
  }
  return inString !== null || inLineComment || inBlock;
}

/**
 * Find one flippable operator in a source string and return its first match
 * (index, from, to). Deterministic: first candidate, first occurrence that is
 * not inside a string or comment. Bare '<'/'>' matches that are part of '=>'
 * arrows or '>=' / '<=' / '<<' / '>>' pairs are skipped (flipping those makes
 * syntax errors, not logic bugs).
 */
export function findMutation(source: string): { index: number; from: string; to: string } | null {
  const isPartOfLargerToken = (idx: number, from: string): boolean => {
    const prev = source[idx - 1] ?? '';
    const next = source[idx + from.length] ?? '';
    // '=>' arrow: the '>' belongs to the arrow token.
    if (from === '>' && prev === '=') return true;
    // '>' or '<' adjacent to another comparison/shift char forms a longer token
    // ('>=', '<=', '<<', '>>', '</', '/>') that a bare flip would corrupt.
    if ((from === '>' || from === '<') && ['>', '<', '='].includes(next)) return true;
    if ((from === '>' || from === '<') && ['>', '<'].includes(prev)) return true;
    // JSX-ish or type-parameter angle brackets usually sit next to identifiers,
    // but we cannot know cheaply; the tokens above are the dangerous ones.
    return false;
  };
  for (const f of FLIPS) {
    let idx = -1;
    let cursor = 0;
    while ((idx = source.indexOf(f.from, cursor)) !== -1) {
      if (!isInStringOrComment(source, idx) && !isPartOfLargerToken(idx, f.from)) {
        return { index: idx, from: f.from, to: f.to };
      }
      cursor = idx + 1;
    }
  }
  return null;
}

/** Working-tree changed source files (added/modified/untracked) we may mutate.
 *  Test files are EXCLUDED: mutating a test into a syntax error never gets
 *  exercised by the code under test and produces meaningless "survived"
 *  verdicts against implementations the tests actually cover. State/config
 *  dirs like .mochi are also excluded. */
export function changedSourceFiles(cwd: string): string[] {
  try {
    // `git status --porcelain` lists added (A/??), modified (M) and renamed (R)
    // paths in the working tree - including new uncommitted files, which a
    // plain `git diff` misses. Parse the two-column status + path.
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const files: string[] = [];
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      const status = line.slice(0, 2);
      // only changed (not ignored/deleted-from-view) working-tree entries
      if (status.trim() === '' || status.startsWith('!!')) continue;
      const path = line.slice(3).trim();
      if (!path || path.startsWith('"')) {
        // quoted paths are rare; skip decoding quirks and only take plain ones
        if (!path) continue;
      }
      // Never mutate the harness's own state, dependencies, or build output.
      const segs = path.split('/');
      if (segs.some((seg) => seg.startsWith('.'))) continue;
      if (segs.includes('node_modules') || segs.includes('dist') || segs.includes('build') || segs.includes('coverage')) continue;
      if (isTestFile(path)) continue;
      if (SOURCE_EXTS.some((e) => path.endsWith(e))) files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

function isTestFile(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return /(\.|_|-)(test|spec)\.[cm]?[jt]sx?$/.test(base) || /^test/.test(base);
}

/**
 * Apply one adversarial mutation to a changed source file and re-run the test
 * command. The file is restored to its exact prior bytes in ALL cases.
 *
 * A mutation is "killed" when the command fails OR when its output changes:
 * many small tasks verify with a print command (e.g. `node -e
 * "console.log(add(2,3))"`) that always exits 0, so exit-code-only detection
 * would declare every such suite weakly-covering even when it demonstrably
 * exercises the mutated logic. Comparing stdout+stderr before/after makes the
 * check meaningful for both assert-style and print-style verification.
 *
 * @param run A function that executes a command and returns its exit code (0 =
 *            pass). Kept as a parameter so the verifier can reuse its shell
 *            runner and so tests can present a fake runner without invoking a
 *            real model or shell.
 */
export async function runMutationCheck(
  cwd: string,
  testCommand: string,
  run: (cmd: string) => Promise<number>,
  capture?: (cmd: string) => Promise<string>,
): Promise<MutationCheck> {
  const files = changedSourceFiles(cwd);
  if (files.length === 0) return { applied: false, note: 'No changed source files to mutate.' };

  const file = files[0];
  const full = resolve(cwd, file);
  let original: string;
  try {
    original = readFileSync(full, 'utf8');
  } catch {
    return { applied: false, note: `Could not read ${file} for mutation.` };
  }
  const target = findMutation(original);
  if (!target) {
    return { applied: false, note: `No flippable logic operator in ${file}.` };
  }
  const mutated = original.slice(0, target.index) + target.to + original.slice(target.index + target.from.length);

  // Baseline output (unmutated) for output-diff detection.
  let baseline = '';
  if (capture) {
    try {
      baseline = await capture(testCommand);
    } catch {
      baseline = '';
    }
  }

  writeFileSync(full, mutated);
  let exit = 1;
  let mutatedOut = '';
  try {
    exit = await run(testCommand);
    if (capture) {
      try {
        mutatedOut = await capture(testCommand);
      } catch {
        mutatedOut = '';
      }
    }
  } finally {
    // Always restore: the repo must never be left in a mutated state.
    writeFileSync(full, original);
  }

  const outputChanged = !!capture && baseline !== '' && mutatedOut !== baseline;
  const killed = exit !== 0 || outputChanged;
  const howKilled = exit !== 0 && outputChanged
    ? 'exit code and output changed'
    : exit !== 0
      ? 'exit code changed'
      : 'output changed (print-style check caught the mutation)';
  return {
    applied: true,
    file,
    target: `${target.from} -> ${target.to}`,
    killed,
    survived: !killed,
    note: killed
      ? `Mutation ${target.from}->${target.to} in ${file} was KILLED: ${howKilled}, so the verification command exercises this logic.`
      : `Mutation ${target.from}->${target.to} in ${file} SURVIVED: tests passed with the injected bug, coverage on this path is weak.`,
  };
}