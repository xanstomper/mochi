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
    typecheckCommand = existsSync(resolve(root, 'pyproject.toml')) ? 'mypy' : undefined;
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
