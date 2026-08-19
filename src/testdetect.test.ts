import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { autoTestCommand, isWeakVerification, cwdForScope, withCwd } from './testdetect.js';

const dir = mkdtempSync(resolve(tmpdir(), 'mochi-testdetect-'));

describe('autoTestCommand', () => {
  it('returns vitest run for a directory with vitest in package.json and a test in scope', () => {
    mkdirSync(resolve(dir, 'pkg'), { recursive: true });
    writeFileSync(resolve(dir, 'pkg', 'package.json'), JSON.stringify({
      scripts: { test: 'vitest' },
      devDependencies: { vitest: '^2.0.0' },
    }));
    const cmd = autoTestCommand(dir, ['pkg/foo.test.ts']);
    expect(cmd).toContain('vitest run');
    expect(cmd).toContain('pkg');
  });

  it('returns jest run for a directory with jest in package.json', () => {
    mkdirSync(resolve(dir, 'pkg-jest'), { recursive: true });
    writeFileSync(resolve(dir, 'pkg-jest', 'package.json'), JSON.stringify({
      devDependencies: { jest: '^29.0.0' },
    }));
    const cmd = autoTestCommand(dir, ['pkg-jest/foo.test.ts']);
    expect(cmd).toContain('jest');
  });

  it('returns pytest for a python directory with pyproject.toml', () => {
    mkdirSync(resolve(dir, 'py'), { recursive: true });
    writeFileSync(resolve(dir, 'py', 'pyproject.toml'), '[project]\nname = "x"');
    const cmd = autoTestCommand(dir, ['py/foo.py']);
    expect(cmd).toContain('pytest');
  });

  it('returns null when the fileScope is empty', () => {
    expect(autoTestCommand(dir, [])).toBeNull();
    expect(autoTestCommand(dir, undefined)).toBeNull();
  });

  it('returns null when no test runner is configured in the directory', () => {
    mkdirSync(resolve(dir, 'naked'), { recursive: true });
    writeFileSync(resolve(dir, 'naked', 'package.json'), JSON.stringify({}));
    const cmd = autoTestCommand(dir, ['naked/foo.test.ts']);
    expect(cmd).toBeNull();
  });
});

describe('isWeakVerification', () => {
  it('flags test/grep/find/cat as weak', () => {
    expect(isWeakVerification('test -f foo.ts')).toBe(true);
    expect(isWeakVerification('grep -q "export function add" foo.ts')).toBe(true);
    expect(isWeakVerification('cat foo.ts')).toBe(true);
    expect(isWeakVerification('ls foo.ts')).toBe(true);
  });
  it('accepts real runners as not-weak', () => {
    expect(isWeakVerification('npx vitest run')).toBe(false);
    expect(isWeakVerification('node -e "require(./foo)"')).toBe(false);
    expect(isWeakVerification('npm test')).toBe(false);
    expect(isWeakVerification('npx jest')).toBe(false);
    expect(isWeakVerification('pytest -q')).toBe(false);
  });
  it('treats empty/undefined as weak so the auto-detector kicks in', () => {
    expect(isWeakVerification(undefined)).toBe(true);
    expect(isWeakVerification('')).toBe(true);
  });
});

describe('cwdForScope', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'mochi-cwdscope-'));
  it('returns the subdirectory when fileScope is consistently under one', () => {
    const sub = resolve(root, 'pkg');
    const result = cwdForScope(root, ['pkg/foo.ts', 'pkg/bar.ts']);
    expect(result).toBe(sub);
  });
  it('returns undefined when fileScope is at the project root', () => {
    expect(cwdForScope(root, ['foo.ts', 'bar.ts'])).toBeUndefined();
  });
  it('returns undefined when fileScope spans multiple directories', () => {
    const r = cwdForScope(root, ['pkg/a.ts', 'other/b.ts']);
    expect(r).toBeUndefined();
  });
  it('returns undefined for empty fileScope', () => {
    expect(cwdForScope(root, [])).toBeUndefined();
    expect(cwdForScope(root, undefined)).toBeUndefined();
  });
});

describe('withCwd', () => {
  it('prefixes cd <dir> when no prefix exists', () => {
    expect(withCwd('npx vitest run', '/tmp/sub')).toBe('cd /tmp/sub && npx vitest run');
  });
  it('does not double-prefix when command already starts with cd', () => {
    expect(withCwd('cd /other && npx vitest run', '/tmp/sub')).toBe('cd /other && npx vitest run');
  });
  it('passes through unchanged when dir is undefined', () => {
    expect(withCwd('npx vitest run', undefined)).toBe('npx vitest run');
  });
});
