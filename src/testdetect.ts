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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

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
        if (!hasVitest && !hasJest) return null;
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
          return `cd ${probe} && npm test --silent`;
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
  if (existsSync(resolve(dir, 'pytest.ini')) || existsSync(resolve(dir, 'pyproject.toml'))) {
    return `cd ${dir} && (python -m pytest -q || pytest -q) 2>&1 | tail -20`;
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
  if (/\bvitest\b|\bjest\b|\bpytest\b|\bmocha\b|\btap\b|\bnode\s+-e\b|\bnode\s+\S+\.test/i.test(c)) return false;
  if (/\bnode\b|\btsx\b|\bts-node\b|\bdeno\b|\bbun\b/.test(c)) return false;
  if (/\bnpm\s+test|\bnpx\s+test|\bpnpm\s+test|\byarn\s+test/.test(c)) return false;
  return true;
}
