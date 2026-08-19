import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchTool, parsePatch, applyFilePatch } from './patch.js';
import { fuzzyFindUnique } from './fuzzy-match.js';
import type { ToolContext } from './types.js';

let dir: string;

function ctx(): ToolContext {
  return {
    cwd: dir,
    workspace: {} as never,
    config: {} as never,
    events: { emit: () => {} } as never,
    agentId: 't',
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mochi-patch-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('fuzzyFindUnique', () => {
  it('finds a block when indentation differs', () => {
    const file = 'function a() {\n    if (x) {\n        return 1;\n    }\n}\n';
    const needle = 'if (x) {\n  return 1;\n}';
    const m = fuzzyFindUnique(file, needle);
    expect(m).not.toBeNull();
    expect(file.slice(m!.start, m!.end)).toContain('if (x)');
    expect(file.slice(m!.start, m!.end)).toContain('return 1');
  });

  it('returns null for ambiguous matches', () => {
    const file = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';
    expect(fuzzyFindUnique(file, 'const a = 1;')).toBeNull();
  });

  it('returns null when there is no match', () => {
    expect(fuzzyFindUnique('abc\ndef\n', 'xyz')).toBeNull();
  });
});

describe('parsePatch', () => {
  it('parses add, update, and delete sections', () => {
    const patch = [
      'Some prose before the patch.',
      '*** Begin Patch',
      '*** Add File: new.ts',
      '+export const x = 1;',
      '*** Update File: app.ts',
      '@@ class App',
      ' context',
      '-old line',
      '+new line',
      '*** Delete File: gone.ts',
      '*** End Patch',
    ].join('\n');
    const patches = parsePatch(patch);
    expect(patches).toHaveLength(3);
    expect(patches[0]).toMatchObject({ op: 'add', path: 'new.ts' });
    expect(patches[1]).toMatchObject({ op: 'update', path: 'app.ts', anchor: 'class App' });
    expect(patches[2]).toMatchObject({ op: 'delete', path: 'gone.ts' });
    expect(patches[1].lines).toEqual([
      { kind: 'ctx', text: 'context' },
      { kind: 'del', text: 'old line' },
      { kind: 'add', text: 'new line' },
    ]);
  });

  it('rejects a missing Begin Patch', () => {
    expect(() => parsePatch('+foo')).toThrow('Begin Patch');
  });

  it('rejects unknown directives', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Rename File: x\n*** End Patch')).toThrow('Unknown patch directive');
  });

  it('rejects malformed body lines', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Update File: a.ts\nbad line\n*** End Patch')).toThrow('Malformed');
  });
});

describe('patch tool (real files)', () => {
  it('adds, updates, and deletes files', async () => {
    writeFileSync(join(dir, 'app.ts'), 'function setup() {\n  const value = old;\n  return value;\n}\n');
    writeFileSync(join(dir, 'gone.ts'), 'obsolete\n');

    const out = await patchTool.execute({
      patch: [
        '*** Begin Patch',
        '*** Add File: new.ts',
        '+export const x = 1;',
        '*** Update File: app.ts',
        ' function setup() {',
        '-  const value = old;',
        '+  const value = new;',
        '*** Delete File: gone.ts',
        '*** End Patch',
      ].join('\n'),
    }, ctx());

    expect(out).toContain('3 file(s)');
    expect(readFileSync(join(dir, 'new.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('const value = new;');
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).not.toContain('old;');
    expect(existsSync(join(dir, 'gone.ts'))).toBe(false);
  });

  it('applies updates even when remembered context whitespace drifts', async () => {
    // File on disk uses 4-space indentation; the patch remembers 2-space.
    writeFileSync(join(dir, 'deep.ts'), 'function a() {\n    if (x) {\n        return 1;\n    }\n    return 0;\n}\n');

    const out = await patchTool.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: deep.ts',
        ' function a() {',
        '   if (x) {',
        '-      return 1;',
        '+      return 42;',
        '*** End Patch',
      ].join('\n'),
    }, ctx());

    expect(out).toContain('updated deep.ts');
    const after = readFileSync(join(dir, 'deep.ts'), 'utf8');
    expect(after).toContain('return 42;');
    expect(after).toContain('    return 0;'); // untouched tail preserved
  });

  it('fails when context cannot be located', async () => {
    writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n');
    await expect(patchTool.execute({
      patch: '*** Begin Patch\n*** Update File: a.ts\n nope\n*** End Patch',
    }, ctx())).rejects.toThrow('Could not locate');
  });

  it('refuses to add an existing file and to update a missing one', async () => {
    writeFileSync(join(dir, 'exists.ts'), 'x');
    await expect(patchTool.execute({
      patch: '*** Begin Patch\n*** Add File: exists.ts\n+x\n*** End Patch',
    }, ctx())).rejects.toThrow('already exists');
    await expect(patchTool.execute({
      patch: '*** Begin Patch\n*** Update File: missing.ts\n a\n*** End Patch',
    }, ctx())).rejects.toThrow('not found');
  });
});

describe('applyFilePatch (unit)', () => {
  it('appends pure additions before the trailing newline', () => {
    const out = applyFilePatch('a\nb\n', { op: 'update', path: 'x', lines: [{ kind: 'add', text: 'c' }] });
    expect(out).toBe('a\nb\nc\n');
  });
});
