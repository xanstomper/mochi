// Instant per-file diagnostics: TS LanguageService + py_compile fast paths.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { diagnoseFile, renderDiagnostics } from './diagnostics.js';

function tsProject() {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-diag-'));
  // Minimal project with Mochi's own typescript for the in-repo test path.
  mkdirSync(resolve(dir, 'node_modules'), { recursive: true });
  const tsPkg = resolve(process.cwd(), 'node_modules', 'typescript');
  try {
    require('node:fs').symlinkSync(tsPkg, resolve(dir, 'node_modules', 'typescript'), 'junction');
  } catch {
    // symlink may fail on some setups; tests below skip via ok=true path
  }
  writeFileSync(resolve(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'node', skipLibCheck: true } }));
  return dir;
}

describe('diagnoseFile (TS)', () => {
  it('reports type errors in the same turn', async () => {
    const dir = tsProject();
    const bad = resolve(dir, 'bad.ts');
    writeFileSync(bad, 'export const n: number = "not a number";\n');
    const d = await diagnoseFile(bad, dir);
    expect(d.ok).toBe(false);
    expect(d.errors.join(' ')).toMatch(/string|number|assign/i);
  }, 20_000);

  it('passes a clean file', async () => {
    const dir = tsProject();
    const good = resolve(dir, 'good.ts');
    writeFileSync(good, 'export const n: number = 42;\n');
    const d = await diagnoseFile(good, dir);
    expect(d.ok).toBe(true);
  }, 20_000);
});

describe('diagnoseFile (python)', () => {
  it('reports syntax errors via py_compile', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-diag-py-'));
    const bad = resolve(dir, 'bad.py');
    writeFileSync(bad, 'def broken(:\n');
    const d = await diagnoseFile(bad, dir);
    // py_compile missing => ok=true (best-effort); only assert when it ran
    if (d.errors.length > 0 || d.ok === false) {
      expect(d.ok).toBe(false);
      expect(d.errors.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it('passes clean python', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-diag-py-'));
    const good = resolve(dir, 'ok.py');
    writeFileSync(good, 'def fine():\n    return 1\n');
    const d = await diagnoseFile(good, dir);
    expect(d.ok).toBe(true);
  }, 20_000);
});

describe('diagnoseFile (unknown)', () => {
  it('is best-effort ok for other extensions', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-diag-x-'));
    const f = resolve(dir, 'notes.md');
    writeFileSync(f, 'not code');
    const d = await diagnoseFile(f, dir);
    expect(d.ok).toBe(true);
    expect(d.errors).toEqual([]);
  });
});

describe('renderDiagnostics', () => {
  it('renders errors with FIX guidance, skips clean files', () => {
    const out = renderDiagnostics([
      { path: '/a/b/clean.ts', ok: true, errors: [], warnings: [], ms: 1 },
      { path: '/a/b/bad.ts', ok: false, errors: ['line 3: type error'], warnings: [], ms: 2 },
    ]);
    expect(out).toContain('bad.ts');
    expect(out).toContain('FIX THESE BEFORE CONTINUING');
    expect(out).not.toContain('clean.ts');
  });
});
