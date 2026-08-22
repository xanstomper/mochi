import { describe, it, expect } from 'vitest';
import { scanDiffForHygiene, renderHygieneFindings } from './diff-hygiene.js';

describe('diff-hygiene scanner', () => {
  it('flags added debug logging with correct file:line', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,5 @@',
      ' const x = 1;',
      '+console.log("debugging", x);',
      ' export const y = x + 1;',
      '+// done',
    ].join('\n');
    const f = scanDiffForHygiene(diff);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ file: 'src/a.ts', line: 2, kind: 'debug-log' });
  });

  it('flags debugger statements, TODO markers, suppressed checks, and focused tests', () => {
    const mk = (file: string, added: string) =>
      [`--- a/${file}`, `+++ b/${file}`, '@@ -0,0 +1,1 @@', added].join('\n');
    expect(scanDiffForHygiene(mk('a.ts', '+debugger;'))[0].kind).toBe('debugger');
    expect(scanDiffForHygiene(mk('a.ts', '+// TODO: real impl'))[0].kind).toBe('todo-marker');
    expect(scanDiffForHygiene(mk('a.ts', '+// @ts-ignore'))[0].kind).toBe('suppressed-check');
    expect(scanDiffForHygiene(mk('a.py', '+x = 1  # noqa'))[0].kind).toBe('suppressed-check');
    expect(scanDiffForHygiene(mk('a.test.ts', '+describe.only("x", () => {})'))).toHaveLength(0); // test files exempt
  });

  it('ignores context and removed lines entirely', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' console.log("kept existing log");',
      '-console.log("removed log");',
      '+export const ok = true;',
    ].join('\n');
    expect(scanDiffForHygiene(diff)).toHaveLength(0);
  });

  it('skips non-code files and caps findings at 8', () => {
    const notes = Array.from({ length: 20 }, (_, i) => `+++ b/notes${i}.md\n+TODO ${i}`).join('\n');
    expect(scanDiffForHygiene(notes)).toHaveLength(0);
    const spam = Array.from({ length: 20 }, (_, i) => `+++ b/f${i}.ts\n+console.log(${i});`).join('\n');
    expect(scanDiffForHygiene(spam)).toHaveLength(8);
  });

  it('renders findings as actionable lines', () => {
    const out = renderHygieneFindings([{ file: 'a.ts', line: 3, kind: 'debug-log', text: 'console.log(1)' }]);
    expect(out).toContain('[debug-log]');
    expect(out).toContain('a.ts:3');
  });
});
