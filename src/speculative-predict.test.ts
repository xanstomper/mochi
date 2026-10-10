import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { predictNextFiles } from './speculative.js';

describe('predictNextFiles (MCH-43 co-change prefetch)', () => {
  let dir: string;
  let cleanup: () => void;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-predict-'));
    cleanup = () => { try { execSync(`rm -rf ${dir}`); } catch { /* ignore */ } };
    execSync('git init', { cwd: dir });
    execSync('git config user.email t@t && git config user.name t', { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    execSync('git add -A && git commit -m init', { cwd: dir });
    writeFileSync(join(dir, 'src/unrelated.ts'), 'export const u = 4;\n');
    execSync('git add -A && git commit -m "add unrelated"', { cwd: dir });
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'src/c.ts'), 'export const c = 3;\n');
    // Commit 1: a.ts + b.ts co-change
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 11;\n');
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 22;\n');
    execSync('git add -A && git commit -m "touch a+b"', { cwd: dir });
    // Commit 2: a.ts + c.ts co-change
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 111;\n');
    writeFileSync(join(dir, 'src/c.ts'), 'export const c = 33;\n');
    execSync('git add -A && git commit -m "touch a+c"', { cwd: dir });
  });

  afterAll(() => { try { execSync(`rm -rf ${dir}`); } catch { /* ignore */ } });

  it('predicts co-change partners of a touched file', () => {
    const predicted = predictNextFiles(dir, ['src/a.ts'], 5);
    expect(predicted).toContain('src/b.ts');
    expect(predicted).toContain('src/c.ts');
    expect(predicted).not.toContain('src/a.ts');
    expect(predicted).not.toContain('src/unrelated.ts');
  });

  it('returns empty for unknown files and bad dirs without throwing', () => {
    expect(predictNextFiles(dir, ['src/nope.ts'], 5)).toEqual([]);
    expect(predictNextFiles(join(dir, 'missing'), ['src/a.ts'], 5)).toEqual([]);
  });
});
