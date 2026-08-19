import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RepoInfo } from './types.js';

const files = {
  js: ['package.json'],
  ts: ['package.json', 'tsconfig.json'],
  python: ['pyproject.toml', 'setup.py', 'requirements.txt'],
  go: ['go.mod'],
  rust: ['Cargo.toml'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  ruby: ['Gemfile'],
  php: ['composer.json'],
};

export function detectRepo(root: string): RepoInfo {
  let language: string | undefined;
  for (const [lang, markers] of Object.entries(files)) {
    if (markers.some((f) => existsSync(resolve(root, f)))) {
      language = lang;
      break;
    }
  }

  let packageManager: string | undefined;
  let framework: string | undefined;
  let buildCommand: string | undefined;
  let testCommand: string | undefined;
  let lintCommand: string | undefined;
  let typecheckCommand: string | undefined;

  if (existsSync(resolve(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const hasPnpm = existsSync(resolve(root, 'pnpm-lock.yaml'));
    const hasYarn = existsSync(resolve(root, 'yarn.lock'));
    const hasBun = existsSync(resolve(root, 'bun.lockb')) || existsSync(resolve(root, 'bun.lock'));
    packageManager = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : hasBun ? 'bun' : 'npm';
    buildCommand = pkg.scripts?.build ? `${packageManager} run build` : undefined;
    testCommand = pkg.scripts?.test ? `${packageManager} test` : undefined;
    lintCommand = pkg.scripts?.lint ? `${packageManager} run lint` : undefined;
    typecheckCommand = pkg.scripts?.typecheck ? `${packageManager} run typecheck` : pkg.scripts?.['type-check'] ? `${packageManager} run type-check` : undefined;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) framework = 'next';
    else if (deps.react) framework = 'react';
    else if (deps.vue) framework = 'vue';
    else if (deps.svelte) framework = 'svelte';
    else if (deps.express) framework = 'express';
    else if (deps.astro) framework = 'astro';
  } else if (language === 'python') {
    packageManager = existsSync(resolve(root, 'poetry.lock')) ? 'poetry' : existsSync(resolve(root, 'uv.lock')) ? 'uv' : existsSync(resolve(root, 'Pipfile')) ? 'pipenv' : 'pip';
    testCommand = 'pytest';
    // mypy is only a real check when the project actually configures it;
    // assuming it for every pyproject.toml makes verification fail in
    // repos where mypy isn't installed or requested.
    const hasMypyConfig =
      existsSync(resolve(root, 'mypy.ini')) ||
      existsSync(resolve(root, 'setup.cfg')) ||
      (existsSync(resolve(root, 'pyproject.toml')) && /\[tool\.mypy\]/.test(readFileSync(resolve(root, 'pyproject.toml'), 'utf8')));
    typecheckCommand = hasMypyConfig ? 'mypy' : undefined;
  } else if (language === 'go') {
    packageManager = 'go';
    buildCommand = 'go build ./...';
    testCommand = 'go test ./...';
  } else if (language === 'rust') {
    packageManager = 'cargo';
    buildCommand = 'cargo build';
    testCommand = 'cargo test';
  }

  const importantDirs: string[] = [];
  for (const d of ['src', 'lib', 'app', 'tests', 'test', 'spec', 'packages', 'scripts', 'docs']) {
    if (existsSync(resolve(root, d)) && statSync(resolve(root, d)).isDirectory()) importantDirs.push(d);
  }

  const entrypoints: string[] = [];
  if (existsSync(resolve(root, 'src/index.ts'))) entrypoints.push('src/index.ts');
  if (existsSync(resolve(root, 'src/index.js'))) entrypoints.push('src/index.js');
  if (existsSync(resolve(root, 'index.ts'))) entrypoints.push('index.ts');
  if (existsSync(resolve(root, 'index.js'))) entrypoints.push('index.js');
  if (existsSync(resolve(root, 'main.py'))) entrypoints.push('main.py');
  if (existsSync(resolve(root, 'main.go'))) entrypoints.push('main.go');

  return {
    language,
    framework,
    packageManager,
    buildCommand,
    testCommand,
    lintCommand,
    typecheckCommand,
    importantDirs,
    entrypoints,
  };
}

/**
 * Language-aware guidance for the model, surfaced in the system prompt so it
 * reaches for the right tooling instead of assuming a JS/TS repo. Each entry
 * names the test runner, build check, and the syntax rules to respect. The
 * verify() path already auto-detects runners for Go/Rust/Python scopes; this
 * hint stops the MODEL from emitting `npm test` in a Rust repo in the first
 * place.
 */
export function languageHint(repo: RepoInfo): string {
  const lang = repo.language;
  const lines: string[] = [];
  switch (lang) {
    case 'python': {
      lines.push('This is a Python repo.');
      lines.push('Test: run `python -m pytest -q` (or `pytest -q`).');
      lines.push('Verification: use pytest in verificationCommand, not npm/node.');
      lines.push('Syntax: 4-space indent, no semicolons, docstrings optional, type hints preferred.');
      lines.push(`Package manager: ${repo.packageManager ?? 'pip/pipenv/uv'}.`);
      break;
    }
    case 'go': {
      lines.push('This is a Go repo.');
      lines.push('Tests: files named *_test.go with `go test ./...`.');
      lines.push('Verification: use `go test ./...`; run `go vet ./...` for static checks.');
      lines.push('Syntax: no semicolons, no unused imports/variables (compiler-enforced), tab indentation.');
      break;
    }
    case 'rust': {
      lines.push('This is a Rust repo (Cargo).');
      lines.push('Tests: unit test `#[cfg(test)] mod tests` inline or `tests/` integration tests; run `cargo test`.');
      lines.push('Verification: use `cargo test`; `cargo build` for compile errors.');
      lines.push('Syntax: snake_case items, `Result`/`?` for errors, no null.');
      break;
    }
    case 'java': {
      lines.push('This is a Java repo.');
      lines.push('Tests: JUnit 4/5 under src/test/java, classes end in *Test.java; run `./mvnw test` or `mvn test` (Gradle: `./gradlew test`).');
      lines.push('Verification: use the build tool test task; javac errors are compile failures.');
      break;
    }
    case 'cpp':
    case 'ruby':
    case 'php': {
      lines.push(`This is a ${lang} repo.`);
      const cmd = lang === 'cpp' ? 'cmake --build . && ctest' : lang === 'ruby' ? 'bundle exec rspec' : 'composer test';
      lines.push(`Verification: try \`cd <dir> && ${cmd}\`; adapt to the actual build system.`);
      break;
    }
    default:
      return '';
  }
  if (repo.testCommand) lines.push(`Detected repo test command: \`${repo.testCommand}\`.`);
  if (repo.buildCommand) lines.push(`Detected build command: \`${repo.buildCommand}\`.`);
  return lines.join('\n');
}

export function findProjectRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== '/') {
    if (existsSync(resolve(dir, '.git'))) return dir;
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    if (existsSync(resolve(dir, 'pyproject.toml'))) return dir;
    if (existsSync(resolve(dir, 'go.mod'))) return dir;
    if (existsSync(resolve(dir, 'Cargo.toml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}
