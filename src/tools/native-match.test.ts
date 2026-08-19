import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fuzzyFindUniqueNative } from './native-match.js';
import { fuzzyFindUnique } from './fuzzy-match.js';

describe('fuzzyFindUniqueNative', () => {
  it('returns the same unique match as the TS matcher', () => {
    const text = 'function greet(name: string): string {\n  return "hi " + name;\n}\n';
    const needle = 'return "hi " + name;';
    expect(fuzzyFindUniqueNative(text, needle)).toEqual(fuzzyFindUnique(text, needle));
  });

  it('returns null for missing and for ambiguous matches', () => {
    const text = 'a\nb\nc\na\n';
    expect(fuzzyFindUniqueNative(text, 'zzz')).toBeNull();
    expect(fuzzyFindUniqueNative(text, 'a')).toBeNull(); // two occurrences
    expect(fuzzyFindUniqueNative(text, '')).toBeNull();
  });

  it('handles CRLF text and whitespace drift like the TS version', () => {
    const text = 'const x = 1;\r\nif (x > 0) {\r\n  return 1;\r\n}\r\n';
    const needle = '  return 1;';
    expect(fuzzyFindUniqueNative(text, needle)).toEqual(fuzzyFindUnique(text, needle));
  });

  it('works end to end through the edit tool path', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-native-edit-'));
    const file = resolve(dir, 'a.ts');
    writeFileSync(file, 'export const v = "x";\n');
    const mod = await import('./edit.js');
    const out = await mod.editTool.execute({ path: 'a.ts', oldText: 'export const v = "x";', newText: 'export const v = "y";' }, {
      cwd: dir,
      events: { emit: () => {} },
      agentId: 't',
    } as any);
    expect(out).toContain('Edited');
    rmSync(dir, { recursive: true, force: true });
  });
});