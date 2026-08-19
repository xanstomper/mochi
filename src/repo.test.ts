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
    expect(repo.testCommand).toBe('pytest');
    rmSync(dir, { recursive: true, force: true });
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

  it('finds the project root upward through polyglot markers', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'mochi-repo-root-'));
    const nested = resolve(base, 'a/b');
    require('node:fs').mkdirSync(nested, { recursive: true });
    writeFileSync(resolve(base, 'pyproject.toml'), '');
    expect(findProjectRoot(nested)).toBe(base);
    rmSync(base, { recursive: true, force: true });
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
    expect(h).toContain('python -m pytest');
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