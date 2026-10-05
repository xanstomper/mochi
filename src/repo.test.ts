import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { detectRepo, languageHint, findProjectRoot } from './repo.js';

describe('detectRepo', () => {
  it('detects Python repos and their test command', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-repo-py-'));
    writeFileSync(resolve(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    const repo = detectRepo(dir);
    expect(repo.language).toBe('python');
    expect(repo.testCommand).toContain('pytest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('offers per-file lint only when the JS/TS repo opted in (aider lint-flow)', () => {
    const mk = () => mkdtempSync(resolve(tmpdir(), 'mochi-repo-lint-'));
    // eslint config present -> lint command detected
    const withEslint = mk();
    writeFileSync(resolve(withEslint, 'package.json'), '{}');
    writeFileSync(resolve(withEslint, 'eslint.config.mjs'), 'export default [];\n');
    const r1 = detectRepo(withEslint);
    expect(r1.lintCommand).toContain('eslint');
    rmSync(withEslint, { recursive: true, force: true });

    // biome config present -> biome check
    const withBiome = mk();
    writeFileSync(resolve(withBiome, 'package.json'), '{}');
    writeFileSync(resolve(withBiome, 'biome.json'), '{}');
    expect(detectRepo(withBiome).lintCommand).toContain('biome');
    rmSync(withBiome, { recursive: true, force: true });

    // plain package.json, no lint config -> no lint command (never demand an
    // unconfigured tool; package.json scripts still take priority elsewhere)
    const bare = mk();
    writeFileSync(resolve(bare, 'package.json'), '{}');
    expect(detectRepo(bare).lintCommand).toBeUndefined();
    rmSync(bare, { recursive: true, force: true });

    // package.json with a lint script wins over config detection
    const scripted = mk();
    writeFileSync(resolve(scripted, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    expect(detectRepo(scripted).lintCommand).toBe('npm run lint');
    rmSync(scripted, { recursive: true, force: true });
  });

  it('detects Go and Rust repos', () => {
    const go = mkdtempSync(resolve(tmpdir(), 'mochi-repo-go-'));
    writeFileSync(resolve(go, 'go.mod'), 'module example.com/x\n');
    expect(detectRepo(go).language).toBe('go');
    expect(detectRepo(go).testCommand).toBe('go test ./...');
    rmSync(go, { recursive: true, force: true });

    const rs = mkdtempSync(resolve(tmpdir(), 'mochi-repo-rs-'));
    writeFileSync(resolve(rs, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(detectRepo(rs).language).toBe('rust');
    expect(detectRepo(rs).testCommand).toBe('cargo test');
    rmSync(rs, { recursive: true, force: true });
  });

  // New languages from the registry: markers -> detected language + commands.
  it.each([
    ['csharp', 'app.csproj', 'dotnet test'],
    ['zig', 'build.zig', 'zig build test'],
    ['java', 'pom.xml', 'mvn test'],
    ['cpp', 'CMakeLists.txt', 'ctest'],
    ['ruby', 'Gemfile', 'bundle exec rspec'],
    ['php', 'composer.json', 'vendor/bin/phpunit'],
    ['swift', 'Package.swift', 'swift test'],
    ['kotlin', 'build.gradle.kts', 'gradle test'],
    ['elixir', 'mix.exs', 'mix test'],
    ['haskell', 'stack.yaml', 'stack test'],
    ['scala', 'build.sbt', 'sbt test'],
    ['dart', 'pubspec.yaml', 'dart test'],
    ['lua', 'x-1.0-1.rockspec', 'busted'],
  ])('detects %s repos and their test command', (lang, marker, cmd) => {
    const d = mkdtempSync(resolve(tmpdir(), `mochi-repo-${lang}-`));
    writeFileSync(resolve(d, marker), 'x');
    const repo = detectRepo(d);
    expect(repo.language).toBe(lang);
    expect(repo.testCommand).toBe(cmd);
    rmSync(d, { recursive: true, force: true });
  });

  it('finds the project root upward through polyglot markers', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'mochi-repo-root-'));
    const nested = resolve(base, 'a/b');
    require('node:fs').mkdirSync(nested, { recursive: true });
    writeFileSync(resolve(base, 'pyproject.toml'), '');
    expect(findProjectRoot(nested)).toBe(base);
    rmSync(base, { recursive: true, force: true });
  });

  it('stops climbing at homedir() and does not treat home as project root for non-repo subdirs', () => {
    const home = require('node:os').homedir();
    // Running directly in home returns home without climbing
    expect(findProjectRoot(home)).toBe(home);
  });
});

describe('languageHint', () => {
  const hintFor = (f: (dir: string) => void) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hint-'));
    f(dir);
    try {
      return languageHint(detectRepo(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('returns empty for unknown repos', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hint-empty-'));
    expect(languageHint(detectRepo(dir))).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('guides the model to pytest for Python repos', () => {
    const h = hintFor((d) => writeFileSync(resolve(d, 'pyproject.toml'), ''));
    expect(h).toMatch(/Python/);
    expect(h).toMatch(/pytest/);
    expect(h).toContain('python3 -m pytest');
  });

  it('guides the model to go test for Go repos', () => {
    const h = hintFor((d) => writeFileSync(resolve(d, 'go.mod'), 'module x'));
    expect(h).toMatch(/Go/);
    expect(h).toMatch(/go test/);
  });

  it('guides the model to cargo test for Rust repos', () => {
    const h = hintFor((d) => writeFileSync(resolve(d, 'Cargo.toml'), '[package]'));
    expect(h).toMatch(/Rust/);
    expect(h).toMatch(/cargo test/);
  });
});