import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RepoInfo } from './types.js';

// ---------------------------------------------------------------------------
// Data-driven language registry. Each entry describes how to detect a repo
// in that language (marker files), the canonical build/test/lint/typecheck
// commands, the package manager, common entrypoints, and a concise hint for
// the model (so it stops assuming npm/TS when it lands in a Python/Rust/Go
// repo). Mirrors how other coding agents keep language knowledge: a table,
// not a pile of if/else.
//
// Ordering matters: `ts` before `js` (a TS repo also has package.json),
// `csharp` before `cpp` (both may have a Makefile; csproj is more specific).
// ---------------------------------------------------------------------------
export interface LangSpec {
  id: string;
  markers: string[];                   // any-of; first hit wins
  fileManagers?: [string, string][];   // probe-file -> manager name
  build?: string | ((root: string) => string | undefined);
  test?: string | ((root: string) => string | undefined);
  lint?: string | ((root: string) => string | undefined);
  typecheck?: string | ((root: string) => string | undefined);
  entries?: (root: string) => string[];
  hint: string;
}

const pyMypy = (root: string): string | undefined => {
  try {
    const configured =
      existsSync(resolve(root, 'mypy.ini')) ||
      existsSync(resolve(root, 'setup.cfg')) ||
      (existsSync(resolve(root, 'pyproject.toml')) && /\[tool\.mypy\]/.test(readFileSync(resolve(root, 'pyproject.toml'), 'utf8')));
    return configured ? 'python3 -m mypy .' : undefined;
  } catch {
    return undefined;
  }
};

/** ruff is a real lint check only when the repo configures it, mirroring the
 *  mypy rule. Every pyproject.toml with [tool.ruff] gets it; otherwise the
 *  python entry keeps lint undefined so verify() doesn't demand a tool the
 *  project never asked for. */
const pyRuff = (root: string): string | undefined => {
  try {
    const configured =
      existsSync(resolve(root, 'ruff.toml')) ||
      existsSync(resolve(root, '.ruff.toml')) ||
      (existsSync(resolve(root, 'pyproject.toml')) && /\[tool\.ruff\]/.test(readFileSync(resolve(root, 'pyproject.toml'), 'utf8')));
    return configured ? 'python3 -m ruff check .' : undefined;
  } catch {
    return undefined;
  }
};

const javaCmd = (root: string, sub: string): string => {
  if (existsSync(resolve(root, 'mvnw'))) return `./mvnw ${sub}`;
  if (existsSync(resolve(root, 'pom.xml'))) return `mvn ${sub}`;
  if (existsSync(resolve(root, 'gradlew'))) return `./gradlew ${sub}`;
  return `gradle ${sub}`;
};

function pickExisting(root: string, paths: string[]): string[] {
  for (const p of paths) {
    if (existsSync(resolve(root, p))) return [p];
  }
  return [];
}

function globAny(root: string, glob: string): boolean {
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return false; }
  const re = new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return entries.some((e) => re.test(e));
}

const LANG_SPECS: LangSpec[] = [
  {
    id: 'ts',
    markers: ['tsconfig.json'],
    hint: 'This is a TypeScript repo. Prefer the package.json scripts (test, build, lint, typecheck) with the detected package manager.',
  },
  {
    id: 'csharp',
    markers: ['*.csproj', '*.sln'],
    build: 'dotnet build',
    test: 'dotnet test',
    entries: (r) => pickExisting(r, ['Program.cs', 'src/Program.cs']),
    hint: 'This is a C#/.NET repo. Tests run with `dotnet test` (xunit/nunit/MSTest), `dotnet build` catches compile errors.',
  },
  {
    id: 'python',
    markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock', 'uv.lock'],
    fileManagers: [['poetry.lock', 'poetry'], ['uv.lock', 'uv'], ['Pipfile', 'pipenv'], ['pyproject.toml', 'pip'], ['requirements.txt', 'pip']],
    test: 'python3 -m pytest -q',
    lint: pyRuff,
    typecheck: pyMypy,
    entries: (r) => pickExisting(r, ['main.py', 'app.py', 'cli.py', 'manage.py']),
    hint: 'Python: `python3 -m pytest -q` for tests, 4-space indent, no semicolons, type hints preferred.',
  },
  {
    id: 'go',
    markers: ['go.mod', 'go.sum', 'Gopkg.toml'],
    build: 'go build ./...',
    test: 'go test ./...',
    lint: 'go vet ./...',
    entries: (r) => pickExisting(r, ['main.go', 'cmd', 'cmd/app/main.go']),
    hint: 'Go: tests are *_test.go run with `go test ./...`; `go vet ./...` for static checks; no unused imports (compiler-enforced).',
  },
  {
    id: 'rust',
    markers: ['Cargo.toml'],
    build: 'cargo build',
    test: 'cargo test',
    lint: 'cargo clippy -- -D warnings',
    entries: (r) => pickExisting(r, ['src/main.rs', 'src/lib.rs']),
    hint: 'Rust: `cargo test` for unit (`#[cfg(test)] mod tests`) and integration tests, `cargo build` catches compile errors, use `Result`/`?`.',
  },
  {
    id: 'java',
    markers: ['pom.xml', 'build.gradle', 'settings.gradle'],
    build: (r) => javaCmd(r, 'compile'),
    test: (r) => javaCmd(r, 'test'),
    entries: (r) => pickExisting(r, ['src/main/java/Main.java', 'src/Main.java']),
    hint: 'Java: JUnit lives under src/test/java; run `./mvnw test`/`./gradlew test` (fall back to mvn/gradle).',
  },
  {
    id: 'cpp',
    markers: ['CMakeLists.txt', 'Makefile', 'configure.ac'],
    fileManagers: [['CMakeLists.txt', 'cmake'], ['Makefile', 'make']],
    build: (r) => (existsSync(resolve(r, 'CMakeLists.txt')) ? 'cmake --build .' : 'make'),
    test: (r) => 'ctest',
    entries: (r) => pickExisting(r, ['src/main.cpp', 'main.cpp', 'src/main.c', 'main.c']),
    hint: 'C/C++: build with the project system (`cmake --build .`, `make`), tests under ctest or a test target.',
  },
  {
    id: 'zig',
    markers: ['build.zig', 'build.zig.zon'],
    build: 'zig build',
    test: 'zig build test',
    entries: (r) => pickExisting(r, ['src/main.zig', 'main.zig']),
    hint: 'Zig: `zig build` compiles, `zig build test` runs tests, deps in build.zig.zon.',
  },
  {
    id: 'ruby',
    markers: ['Gemfile', 'Rakefile', 'config.ru'],
    test: 'bundle exec rspec',
    entries: (r) => pickExisting(r, ['app.rb', 'lib/app.rb', 'bin/server']),
    hint: 'Ruby: `bundle exec rspec` (or `rake test`), snake_case names, Bundler for deps.',
  },
  {
    id: 'php',
    markers: ['composer.json', 'artisan', 'wp-config.php'],
    test: 'vendor/bin/phpunit',
    entries: (r) => pickExisting(r, ['index.php', 'src/index.php', 'artisan']),
    hint: 'PHP: `vendor/bin/phpunit` (or `composer test` if scripted), PSR-12 style.',
  },
  {
    id: 'swift',
    markers: ['Package.swift', '*.xcodeproj'],
    build: 'swift build',
    test: 'swift test',
    entries: (r) => pickExisting(r, ['Sources/App/main.swift', 'main.swift']),
    hint: 'Swift: `swift test` runs XCTest, `swift build` compiles.',
  },
  {
    id: 'kotlin',
    markers: ['build.gradle.kts'],
    build: 'gradle build',
    test: 'gradle test',
    entries: (r) => pickExisting(r, ['src/main/kotlin/Main.kt']),
    hint: 'Kotlin: `gradle build`/`gradle test` (or ./gradlew), kotlin.test / JUnit.',
  },
  {
    id: 'elixir',
    markers: ['mix.exs'],
    build: 'mix compile',
    test: 'mix test',
    entries: (r) => pickExisting(r, ['lib/app.ex']),
    hint: 'Elixir: `mix test` (ExUnit), `mix compile` builds.',
  },
  {
    id: 'haskell',
    markers: ['stack.yaml', 'package.yaml', '*.cabal'],
    build: 'stack build',
    test: 'stack test',
    entries: (r) => pickExisting(r, ['app/Main.hs', 'src/Main.hs']),
    hint: 'Haskell: `stack test` (or cabal test), property tests under tests/.',
  },
  {
    id: 'scala',
    markers: ['build.sbt'],
    build: 'sbt compile',
    test: 'sbt test',
    entries: (r) => pickExisting(r, ['src/main/scala/Main.scala']),
    hint: 'Scala: `sbt test`, `sbt compile`.',
  },
  {
    id: 'dart',
    markers: ['pubspec.yaml'],
    build: 'dart analyze',
    test: 'dart test',
    entries: (r) => pickExisting(r, ['lib/main.dart', 'bin/main.dart']),
    hint: 'Dart: `dart test` for unit tests, `dart analyze` for static checks.',
  },
  {
    id: 'lua',
    markers: ['*.rockspec'],
    test: 'busted',
    hint: 'Lua: `busted` for tests.',
  },
  {
    id: 'js',
    markers: ['package.json'],
    hint: 'JavaScript/Node repo. Use the package.json scripts (test/build/lint) with the detected package manager.',
  },
];

/** Identify the language of `root` by marker files (first match wins). */
export function detectLang(root: string): string | undefined {
  for (const spec of LANG_SPECS) {
    for (const marker of spec.markers) {
      if (marker.includes('*')) {
        if (globAny(root, marker)) return spec.id;
      } else if (existsSync(resolve(root, marker))) return spec.id;
    }
  }
  return undefined;
}

function resolveFn<T>(v: T | ((root: string) => T) | undefined, root: string): T | undefined {
  return typeof v === 'function' ? (v as (root: string) => T)(root) : (v as T | undefined);
}

export function detectRepo(root: string): RepoInfo {
  const language = detectLang(root);
  const spec = LANG_SPECS.find((s) => s.id === language);

  let packageManager: string | undefined;
  if (spec?.fileManagers) {
    for (const [probe, manager] of spec.fileManagers) {
      if (globAny(root, probe)) { packageManager = manager; break; }
    }
  }

  let framework: string | undefined;
  let buildCommand: string | undefined;
  let testCommand: string | undefined;
  let lintCommand: string | undefined;
  let typecheckCommand: string | undefined;

  // package.json repos: prefer the project's own scripts, then the registry.
  if (existsSync(resolve(root, 'package.json'))) {
    try {
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
    } catch {
      // malformed package.json: fall through to registry defaults
    }
  }

  // Language defaults for non-package.json repos.
  if (language && language !== 'js' && language !== 'ts') {
    if (!buildCommand) buildCommand = resolveFn(spec!.build, root);
    if (!testCommand) testCommand = resolveFn(spec!.test, root);
    if (!lintCommand) lintCommand = resolveFn(spec!.lint, root);
    if (!typecheckCommand) typecheckCommand = resolveFn(spec!.typecheck, root);
  }

  const importantDirs: string[] = [];
  for (const d of ['src', 'lib', 'app', 'tests', 'test', 'spec', 'packages', 'scripts', 'docs', 'cmd']) {
    if (existsSync(resolve(root, d)) && ((): boolean => { try { return (readdirSync(resolve(root, d)).length > 0); } catch { return false; } })()) {
      importantDirs.push(d);
    }
  }

  return {
    language,
    framework,
    packageManager,
    buildCommand,
    testCommand,
    lintCommand,
    typecheckCommand,
    entrypoints: spec?.entries ? spec.entries(root) : [],
    importantDirs,
  };
}

export function findProjectRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== '/') {
    if (existsSync(resolve(dir, '.git'))) return dir;
    if (detectLang(dir)) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export function languageHint(repo: RepoInfo): string {
  const spec = LANG_SPECS.find((s) => s.id === repo.language);
  if (!spec) return '';
  const lines = [spec.hint];
  if (repo.testCommand) lines.push(`Detected repo test command: \`${repo.testCommand}\`.`);
  if (repo.buildCommand) lines.push(`Detected build command: \`${repo.buildCommand}\`.`);
  if (repo.lintCommand) lines.push(`Detected lint command: \`${repo.lintCommand}\`.`);
  if (repo.typecheckCommand) lines.push(`Detected typecheck command: \`${repo.typecheckCommand}\`.`);
  return lines.join('\n');
}