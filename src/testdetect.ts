// Auto-detect a runnable test command for a directory under a fileScope.
//
// Why this exists: the decomposer (a model) sometimes returns a weak
// verificationCommand like `test -f x.ts && grep ...` that does not actually
// exercise the implementation. The mutation check then trivially "survives"
// because the verification never runs the code. To prevent this silent
// downgrade, this helper inspects the directory implied by a task's
// fileScope and returns a real test runner command (vitest, jest, pytest,
// etc.) that the loop can run as additional evidence. If the directory has
// no test runner installed, it returns null.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { detectRepo } from './repo.js';

// Project-root markers per language, used by cwdForScope to decide whether a
// subdirectory is its own project or just a folder under a repo root.
const PROJECT_MARKERS = [
  'package.json', 'tsconfig.json',
  'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile',
  'go.mod', 'Cargo.toml', 'build.zig', 'pom.xml', 'build.gradle',
  'CMakeLists.txt', 'Makefile', 'Gemfile', 'composer.json', 'mix.exs',
  'pubspec.yaml', 'build.sbt', 'stack.yaml', '*.csproj', '*.sln',
];

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => {
    if (m.includes('*')) {
      try {
        return readdirSync(dir).some((e) => new RegExp('^' + m.replace(/\*/g, '.*') + '$').test(e));
      } catch {
        return false;
      }
    }
    return existsSync(resolve(dir, m));
  });
}

function nearestProjectRoot(dir: string): string | undefined {
  let probe = dir;
  for (let i = 0; i < 8 && probe !== dirname(probe); i++) {
    if (hasProjectMarker(probe)) return probe;
    probe = dirname(probe);
  }
  return undefined;
}

export function autoTestCommand(cwd: string, fileScope: string[] | undefined): string | null {
  if (!fileScope || fileScope.length === 0) return null;
  // Pick the first in-scope file that exists or would exist; the directory
  // it lives in is the candidate workspace. We don't require the file to
  // exist on disk (the model may have just decided what to create), so any
  // resolvable path counts.
  const candidates = fileScope.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)));
  if (candidates.length === 0) return null;
  const dir = dirname(candidates[0]);

  // Test files under this directory?
  const hasTestFile = fileScope.some((f) => /(\.|_|-)(test|spec)\.[cm]?[jt]sx?$/i.test(f));
  if (!hasTestFile) {
    // Even without an in-scope test file, if the directory has any *test*.ts
    // in it, the agent probably needs them run.
    try {
      const pkgPath = resolve(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
        const hasVitest = pkg.devDependencies?.vitest || pkg.dependencies?.vitest;
        const hasJest = pkg.devDependencies?.jest || pkg.dependencies?.jest;
        const hasNodeTest = typeof pkg.scripts?.test === 'string' && pkg.scripts.test.includes('node --test');
        if (!hasVitest && !hasJest && !hasNodeTest) return null;
      }
    } catch {
      return null;
    }
  }

  // Look for a package.json with a `test` script in the directory or its
  // parents up to the project root.
  let probe = dir;
  for (let i = 0; i < 4; i++) {
    const pkgPath = resolve(probe, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
        const hasVitest = pkg.devDependencies?.vitest;
        const hasJest = pkg.devDependencies?.jest;
        if (pkg.scripts?.test) {
          // Prefer vitest run --reporter=basic for parseable output; fall
          // back to whatever the script says.
          if (hasVitest) return `cd ${probe} && npx vitest run --reporter=basic`;
          if (hasJest) return `cd ${probe} && npx jest --silent`;
          return `cd ${probe} && npm test --silent`; // includes node --test scripts
        }
        if (hasVitest) return `cd ${probe} && npx vitest run --reporter=basic`;
        if (hasJest) return `cd ${probe} && npx jest --silent`;
      } catch {
        // ignore malformed package.json
      }
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  // Python fallback
  if (existsSync(resolve(dir, 'pytest.ini')) || existsSync(resolve(dir, 'pyproject.toml')) || existsSync(resolve(dir, 'setup.py'))) {
    return `cd ${dir} && (python -m pytest -q || python3 -m pytest -q || pytest -q) 2>&1 | tail -20`;
  }

  // Go: any in-scope file with path ending in _test.go or a go.mod nearby.
  if (existsSync(resolve(dir, 'go.mod')) || fileScope.some((f) => f.endsWith('_test.go'))) {
    return `cd ${dir} && go test ./... 2>&1 | tail -20`;
  }

  // Rust: Cargo.toml anywhere between dir and the project root (src/lib.rs
  // lives one level below a workspace-root Cargo.toml).
  let cargoProbe: string = dir;
  for (let i = 0; i < 4; i++) {
    if (existsSync(resolve(cargoProbe, 'Cargo.toml'))) {
      return `cd ${cargoProbe} && cargo test 2>&1 | tail -20`;
    }
    const parent = dirname(cargoProbe);
    if (parent === cargoProbe) break;
    cargoProbe = parent;
  }

  // Language-registry fallback: the same spec table that powers repo
  // detection knows test commands for Java, Kotlin, C#, Zig, Ruby, PHP,
  // Swift, Dart, etc. Detect at `dir`, and at any parent up to the project
  // root, then use that language's canonical test command. Without this the
  // fileScope path returned null for every non-JS/TS/Python/Go/Rust task,
  // so verify() never ran a test for a .java or .cs task even though the
  // registry knows how.
  let langProbe: string = dir;
  for (let i = 0; i < 5; i++) {
    const repo = detectRepo(langProbe);
    if (repo.testCommand && repo.language !== 'js' && repo.language !== 'ts') {
      return `cd ${langProbe} && ${repo.testCommand} 2>&1 | tail -20`;
    }
    const parent = dirname(langProbe);
    if (parent === langProbe) break;
    langProbe = parent;
  }

  return null;
}

/** True if a verification command is "weak" (string/file check, no real
 *  runner invocation). Used by the loop to decide whether to add an
 *  auto-detected test command as additional evidence. */
export function isWeakVerification(command: string | undefined): boolean {
  if (!command) return true;
  const c = command.trim();
  // Pure existence/grep/find checks are weak.
  if (/^\s*test\s+-/.test(c) || /^\s*\[/.test(c)) return true;
  if (/\bgrep\b/.test(c) || /\bfind\b/.test(c) || /\bcat\b/.test(c) || /\bls\b/.test(c)) return true;
  if (/\bwc\b/.test(c) || /\bhead\b/.test(c) || /\btail\b/.test(c)) return true;
  // Anything that actually invokes a runner is not weak.
  if (/\bvitest\b|\bjest\b|\bpytest\b|\bmocha\b|\btap\b|\bnode\s+-e\b|\bnode\s+--test\b|\bnode\s+\S+\.test/i.test(c)) return false;
  if (/\bnode\b|\btsx\b|\bts-node\b|\bdeno\b|\bbun\b/.test(c)) return false;
  if (/\bnpm\s+test|\bnpx\s+test|\bpnpm\s+test|\byarn\s+test/.test(c)) return false;
  // Polyglot runners (Go, Rust, Python module) are real evidence too.
  if (/\bgo\s+test\b|\bcargo\s+test\b|\bpython(\d)?\s+-m\s+(pytest|unittest)\b|\bstretchr\/testify/.test(c)) return false;
  return true;
}

/** Resolves the directory the verification command should run from.
 *  If the task's fileScope points under a subdirectory, return that
 *  subdirectory so commands like `npx vitest run` work without the model
 *  having to remember the `cd <dir> && ...` prefix. Returns undefined
 *  when there is no clear directory (no fileScope, all top-level). */
export function cwdForScope(cwd: string, fileScope: string[] | undefined): string | undefined {
  if (!fileScope || fileScope.length === 0) return undefined;
  // Use the directory of the first non-root path.
  const dir = dirname(fileScope.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)))[0]);
  // If the directory equals the project root, no change is needed.
  if (resolve(dir) === resolve(cwd)) return undefined;
  // If the directory is the same for every fileScope entry, use it.
  const sameForAll = fileScope.every((f) => {
    const d = dirname(isAbsolute(f) ? f : resolve(cwd, f));
    return resolve(d) === resolve(dir);
  });
  if (!sameForAll) return undefined;
  // Only scope into a subdirectory when it actually is its own project root:
  // cargo/zig/rust lived in src/ but their Cargo.toml/build.zig sits at the
  // repo root, and `cd src && cargo test`/`zig build test` would fail there.
  // Walk up to the nearest marker (the workspace root) and return THAT.
  const markerHere = hasProjectMarker(dir);
  if (markerHere) return dir;
  const root = nearestProjectRoot(dir);
  return root ? root : dir;
}

/** Returns a version of `cmd` that runs from the given directory if it does
 *  not already start with a `cd ... && ...` prefix. */
export function withCwd(cmd: string, dir: string | undefined): string {
  if (!dir) return cmd;
  const trimmed = cmd.trim();
  if (/^cd\s+\S+/.test(trimmed)) return cmd; // already prefixes itself
  return `cd ${dir} && ${cmd}`;
}

