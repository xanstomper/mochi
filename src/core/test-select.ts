// MCH-72: changed-file → related-test selection. The verification path has
// always run the whole repo suite, which on a big repo is minutes per
// iteration and drowns the agent in unrelated failures. When only a handful
// of source files changed, we can run just their tests and get feedback in
// seconds.
//
// Correctness rule: the FINAL gate still runs the full suite (a missed
// regression is far worse than a slow run). This module only powers fast
// feedback + a fail-fast short-circuit. Whenever the mapping is uncertain —
// config/lock/doc files touched, too many files changed, unknown runner — we
// return no selection and the caller falls back to the full command.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { execArgvText } from '../exec.js';
import { SKIP_DIRS } from '../tools/glob.js';
import type { RepoInfo } from '../types.js';

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.php', '.swift', '.c', '.cc', '.cpp',
]);
const JS_TS_EXTS = ['.ts', '.tsx', '.js', '.jsx'];
const JS_TS_LIKE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

const TEST_RES = [
  /(^|\/)[^/]+\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i,
  /(^|\/)test_[^/]+\.(py|rb)$/i,
  /(^|\/)[^/]+_test\.(py|rb|go)$/i,
];

/** Normalize any path form (abs, .\x, x) to a repo-relative forward-slash path. */
export function normalizeRel(p: string): string {
  return p.split('\\').join('/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function isTestFile(rel: string): boolean {
  const n = normalizeRel(rel);
  return TEST_RES.some((r) => r.test(n));
}

export function isCodeFile(rel: string): boolean {
  return CODE_EXTS.has(extname(rel).toLowerCase());
}

/**
 * Parse `git status --porcelain` output into repo-relative file paths.
 * Handles the two-char status prefix, renames (`R  old -> new` → new), and
 * git's quoted paths for names with special characters.
 */
export function parsePorcelainFiles(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.startsWith('##')) continue;
    const m = /^(..)\s+(.*)$/.exec(raw);
    if (!m) continue;
    let p = m[2];
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.replace(/^"(.*)"$/, '$1');
    p = normalizeRel(p);
    if (p) out.push(p);
  }
  return out;
}

/** Candidate mirrored test paths for a source file (existence NOT checked). */
export function candidateTestPaths(srcRel: string): string[] {
  const rel = normalizeRel(srcRel);
  const dir = dirname(rel);
  const ext = extname(rel).toLowerCase();
  const base = basename(rel, extname(rel));
  const out = new Set<string>();
  const push = (d: string, name: string) => out.add(normalizeRel(join(d, name)));
  if (JS_TS_LIKE.has(ext)) {
    for (const d of [dir, join(dir, '__tests__'), 'tests', 'test']) {
      for (const e of JS_TS_EXTS) {
        push(d, `${base}.test${e}`);
        push(d, `${base}.spec${e}`);
      }
    }
  } else if (ext === '.py') {
    for (const d of [dir, join(dir, 'tests'), 'tests', 'test']) {
      push(d, `test_${base}.py`);
      push(d, `${base}_test.py`);
    }
  } else if (ext === '.go') {
    push(dir, `${base}_test.go`);
  } else if (ext === '.rb') {
    for (const d of [dir, 'spec', 'test']) {
      push(d, `${base}_spec.rb`);
      push(d, `${base}_test.rb`);
      push(d, `test_${base}.rb`);
    }
  }
  return Array.from(out);
}

/** Strip a module extension and a trailing `/index` to get a comparable stem. */
export function stemOf(rel: string): string {
  let s = normalizeRel(rel);
  const e = extname(s).toLowerCase();
  if (JS_TS_LIKE.has(e) || e === '.py' || e === '.rb') s = s.slice(0, -e.length);
  s = s.replace(/\/index$/, '');
  return s;
}

const SPECIFIER_RE = /(?:from|require\(|import\()\s*['"]([^'"]+)['"]/g;

/** Resolve a relative import specifier written in `fromRel` to a comparable stem. */
export function resolveSpecifierStem(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return stemOf(join(dirname(fromRel), spec));
}

/** All relative import/require specifiers written in a source file's text. */
export function extractRelativeSpecifiers(content: string): string[] {
  const out: string[] = [];
  const re = new RegExp(SPECIFIER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1].startsWith('.')) out.push(m[1]);
  }
  return out;
}

export interface RelatedTests {
  tests: string[];
  reason: string;
}

/**
 * Map changed files to the subset of existing tests that cover them.
 * Fast path: mirrored test names. Slow path (only when the fast path finds
 * nothing): scan test files for relative imports of the changed modules.
 * Returns `tests: []` whenever selection is not safe → caller runs the full suite.
 */
export function selectRelatedTests(
  cwd: string,
  changed: string[],
  opts: { maxChanged?: number; maxScanFiles?: number } = {},
): RelatedTests {
  const maxChanged = opts.maxChanged ?? 12;
  const maxScanFiles = opts.maxScanFiles ?? 8000;
  const files = Array.from(new Set(changed.map(normalizeRel).filter(Boolean)));
  if (files.length === 0) return { tests: [], reason: 'no changed files' };
  if (files.length > maxChanged) {
    return { tests: [], reason: `${files.length} changed files exceeds the ${maxChanged}-file targeting limit` };
  }
  const nonCode = files.find((f) => !isCodeFile(f));
  if (nonCode) {
    return { tests: [], reason: `non-code change (${nonCode}) can affect the whole suite` };
  }

  const found = new Set<string>();
  for (const f of files) {
    if (isTestFile(f)) {
      if (existsSync(resolve(cwd, f))) found.add(f);
      continue;
    }
    for (const c of candidateTestPaths(f)) {
      if (existsSync(resolve(cwd, c))) found.add(c);
    }
  }
  if (found.size > 0) {
    return { tests: Array.from(found).sort(), reason: `${found.size} mirrored test file(s)` };
  }

  // Reverse import scan: which test files import any changed module?
  const targetStems = new Set(files.map(stemOf));
  let scanned = 0;
  const stack: string[] = ['.'];
  while (stack.length > 0 && scanned < maxScanFiles) {
    const relDir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(resolve(cwd, relDir));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const rel = normalizeRel(join(relDir, name));
      const abs = resolve(cwd, rel);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        stack.push(rel);
        continue;
      }
      scanned++;
      if (!isTestFile(rel) || !CODE_EXTS.has(extname(rel).toLowerCase())) continue;
      let content: string;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const re = new RegExp(SPECIFIER_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const stem = resolveSpecifierStem(rel, m[1]);
        if (stem && targetStems.has(stem)) {
          found.add(rel);
          break;
        }
      }
    }
  }
  if (found.size > 0) {
    return { tests: Array.from(found).sort(), reason: `${found.size} importing test file(s)` };
  }
  return { tests: [], reason: 'no tests reference the changed files' };
}

export type TestRunner = 'vitest' | 'jest' | 'mocha' | 'pytest' | 'go' | 'node' | 'pm-script' | 'unknown';

/** Infer the test runner from the command string, then package config, then markers. */
export function detectRunner(cwd: string, repo: RepoInfo, testCommand?: string): TestRunner {
  const cmd = (testCommand ?? repo.testCommand ?? '').toLowerCase();
  if (cmd.includes('vitest')) return 'vitest';
  if (cmd.includes('jest')) return 'jest';
  if (cmd.includes('mocha')) return 'mocha';
  if (cmd.includes('pytest')) return 'pytest';
  if (/node\s+--test|node\s+-t\b/.test(cmd)) return 'node';
  if (cmd.includes('go test')) return 'go';
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) return 'vitest';
    if (deps.jest) return 'jest';
    if (deps.mocha) return 'mocha';
  } catch {
    /* no package.json */
  }
  if (existsSync(resolve(cwd, 'go.mod'))) return 'go';
  if (
    existsSync(resolve(cwd, 'pyproject.toml')) ||
    existsSync(resolve(cwd, 'pytest.ini')) ||
    existsSync(resolve(cwd, 'setup.cfg')) ||
    existsSync(resolve(cwd, 'tox.ini'))
  ) {
    return 'pytest';
  }
  if (/^(npm|pnpm|yarn|bun)\b/.test(cmd)) return 'pm-script';
  return 'unknown';
}

function quote(f: string): string {
  return /\s/.test(f) ? `"${f}"` : f;
}

/** Build a runner-specific command that runs ONLY `testFiles`, or undefined when the runner can't target files. */
export function buildTargetedTestCommand(
  repo: RepoInfo,
  testFiles: string[],
  runner: TestRunner,
): string | undefined {
  if (testFiles.length === 0) return undefined;
  const list = testFiles.map(quote).join(' ');
  switch (runner) {
    case 'vitest':
      return `npx vitest run ${list}`;
    case 'jest':
      return `npx jest ${list}`;
    case 'mocha':
      return `npx mocha ${list}`;
    case 'pytest':
      return `python -m pytest ${list}`;
    case 'node':
      return `node --test ${list}`;
    case 'go': {
      const pkgs = Array.from(new Set(testFiles.map((f) => `./${normalizeRel(dirname(f))}/`))).join(' ');
      return `go test ${pkgs}`;
    }
    case 'pm-script':
      return `${repo.testCommand ?? 'npm test'} -- ${list}`;
    default:
      return undefined;
  }
}

/** `git status --porcelain` file list for `cwd`; [] when not a git repo. */
export async function gitChangedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await execArgvText('git', ['status', '--porcelain'], { cwd, maxBuffer: 1024 * 1024 });
    // mochi's own state dir is never a target-selection signal (and repos that
    // don't gitignore it would otherwise make every task look like a
    // whole-suite change).
    return parsePorcelainFiles(out).filter((p) => !p.startsWith('.mochi/'));
  } catch {
    return [];
  }
}

export interface TargetedPlan {
  command?: string;
  files: string[];
  reason: string;
}

/**
 * End-to-end: read changed files, select related tests, build the targeted
 * command. `command: undefined` means "run the full suite".
 */
export async function planTargetedTests(
  cwd: string,
  repo: RepoInfo,
  testCommand?: string,
): Promise<TargetedPlan> {
  const changed = await gitChangedFiles(cwd);
  const sel = selectRelatedTests(cwd, changed);
  if (sel.tests.length === 0) return { files: [], reason: sel.reason };
  const runner = detectRunner(cwd, repo, testCommand);
  const command = buildTargetedTestCommand(repo, sel.tests, runner);
  if (!command) {
    return { files: sel.tests, reason: `${sel.tests.length} related test(s); runner "${runner}" cannot target files` };
  }
  return { command, files: sel.tests, reason: `${sel.tests.length} related test(s) via ${runner}` };
}
