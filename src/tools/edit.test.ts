// tools/edit.ts: exact + whitespace-tolerant fuzzy replace with ambiguity guard.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { editTool } from './edit.js';
import type { ToolContext } from './types.js';

let dir: string;
let ctx: ToolContext;
const F = 'file.ts';
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit-'));
  ctx = { cwd: dir, workspace: {} as any, config: {} as any, events: { emit: () => {} } as any, agentId: 'e' };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seed(content: string): void {
  writeFileSync(resolve(dir, F), content);
}

describe('edit tool', () => {
  it('replaces an exact unique block', async () => {
    seed('export const a = 1;\nexport const b = 2;\n');
    const out = String(await editTool.execute({ path: F, oldText: 'a = 1', newText: 'a = 42' }, ctx));
    expect(out).toContain('Edited file.ts');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('a = 42');
  });

  it('tolerates whitespace drift via fuzzy match (unique only)', async () => {
    seed('function x() {\n    return 1;\n}\n');
    const out = String(await editTool.execute({
      path: F,
      oldText: '  function x() {\n    return 1;\n  }', // different indentation
      newText: 'function x() {\n  return 2;\n}',
    }, ctx));
    expect(out).toContain('fuzzy match');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('return 2;');
  });

  it('refuses ambiguous matches (needs unique context)', async () => {
    seed('const v = 1;\nconst v = 2;\n');
    await expect(editTool.execute({ path: F, oldText: 'const v =', newText: 'const w =' }, ctx)).rejects.toThrow(/unique|locations/);
  });

  it('throws when oldText is absent', async () => {
    seed('nothing here');
    await expect(editTool.execute({ path: F, oldText: 'missing', newText: 'x' }, ctx)).rejects.toThrow(/not found/);
  });

  it('trims common indentation when trim is set', async () => {
    seed('const z = 0;\n');
    const out = String(await editTool.execute({
      path: F, oldText: 'z = 0', newText: '\n  z = 1\n', trim: true,
    }, ctx));
    expect(out).toContain('Edited');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('z = 1;');
  });

  it('tolerates line number gutters copied directly from read output', async () => {
    seed('import os\nimport sys\n\ndef main():\n    print("hello")\n');
    const out = String(await editTool.execute({
      path: F,
      oldText: '   4 | def main():\n   5 |     print("hello")',
      newText: '   4 | def main():\n   5 |     print("world")',
    }, ctx));
    expect(out).toContain('Edited');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('print("world")');
  });

  it('tolerates colon line number gutters', async () => {
    seed('const foo = "bar";\n');
    const out = String(await editTool.execute({
      path: F,
      oldText: '1: const foo = "bar";',
      newText: 'const foo = "baz";',
    }, ctx));
    expect(out).toContain('Edited');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('const foo = "baz";');
  });

  it('reports exact line numbers on ambiguous duplicate matches', async () => {
    seed('line 1: hello\nline 2: middle\nline 3: hello\n');
    await expect(
      editTool.execute({ path: F, oldText: 'hello', newText: 'goodbye' }, ctx)
    ).rejects.toThrow(/at lines 1, 3/);
  });

  it('tolerates quote and trailing semicolon differences via relaxed matching', async () => {
    seed('const msg = "hello world";\nconst val = 100;\n');
    const out = String(await editTool.execute({
      path: F,
      oldText: "const msg = 'hello world'", // single quotes and no semicolon
      newText: 'const msg = "goodbye world";',
    }, ctx));
    expect(out).toContain('fuzzy match');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('goodbye world');
  });

  it('applies a drifted block via the anchored strategy and says so', async () => {
    seed([
      'export function checkout(cart: Cart): number {',
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment);',
      '}',
      '',
    ].join('\n'));
    const out = String(await editTool.execute({
      path: F,
      oldText: [
        'export function checkout(cart: Cart): number {',
        '  const subtotal = price * qty;',
        '  const total = subtotal - discount;',
        '  return chargeCard(total, cart.payment);',
        '}',
      ].join('\n'),
      newText: [
        'export function checkout(cart: Cart): number {',
        '  const subtotal = cart.items.reduce(sumPrices, 0);',
        '  const total = applyDiscount(subtotal, cart.coupon);',
        '  return chargeCard(total, cart.payment, { idempotent: true });',
        '}',
      ].join('\n'),
    }, ctx));
    expect(out).toContain('strategy: anchored');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('idempotent: true');
  });

  it('reverts an edit that introduces syntax errors and leaves the file unchanged', async () => {
    const before = 'export function ok(): number {\n  return 1;\n}\n';
    seed(before);
    const emitted: Array<{ type: string }> = [];
    const evCtx = { ...ctx, events: { emit: (e: { type: string }) => { emitted.push(e); } } as any };
    await expect(editTool.execute({
      path: F,
      oldText: 'export function ok(): number {\n  return 1;\n}',
      newText: 'export function ok(): number {\n  return 2;',
    }, evCtx)).rejects.toThrow(/REVERTED/);
    expect(readFileSync(resolve(dir, F), 'utf8')).toBe(before);
    expect(emitted.some((e) => e.type === 'edit:reverted')).toBe(true);
    expect(emitted.some((e) => e.type === 'file:changed')).toBe(false);
  });

  it('does not revert a clean edit in a file with pre-existing syntax errors', async () => {
    seed('export function broken(: number {\n  return 1;\n}\nexport const target = 1;\n');
    const out = String(await editTool.execute({ path: F, oldText: 'export const target = 1;', newText: 'export const target = 2;' }, ctx));
    expect(out).toContain('pre-existing errors only');
    expect(readFileSync(resolve(dir, F), 'utf8')).toContain('target = 2');
  });

  it('emits edit telemetry for applied and failed edits', async () => {
    seed('function x() {\n    return 1;\n}\n');
    const emitted: Array<Record<string, unknown>> = [];
    const evCtx = { ...ctx, events: { emit: (e: Record<string, unknown>) => { emitted.push(e); } } as any };
    await editTool.execute({ path: F, oldText: '  function x() {\n    return 1;\n  }', newText: 'function x() {\n  return 2;\n}' }, evCtx);
    const appliedEv = emitted.find((e) => e.type === 'edit:applied');
    expect(appliedEv).toMatchObject({ strategy: 'normalized', integrity: 'passed' });

    await expect(editTool.execute({ path: F, oldText: 'totally absent text here', newText: 'x' }, evCtx)).rejects.toThrow(/not found/);
    const failedEv = emitted.find((e) => e.type === 'edit:failed');
    expect(failedEv).toMatchObject({ failureKind: 'not-found' });
  });

  it('not-found errors carry near-miss regions the model can act on', async () => {
    seed('export function alpha(input: number): number {\n  const doubled = input * 2;\n  return doubled + 1;\n}\n');
    const err = await editTool.execute({
      path: F,
      oldText: 'export function beta(value: string): string {\n  const parsed = parseInput(value);\n  return renderOutput(parsed);\n}',
      newText: 'export function beta(value: string): string {\n  return "";\n}',
    }, ctx).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Closest regions');
    expect((err as Error).message).toContain('first difference');
    expect((err as Error).message).toContain('beta');
    expect((err as Error).message).toContain('alpha');
  });

  it('inserts $ replacement patterns in newText literally (no $$ / $& mangling)', async () => {
    seed('const shell = "PID";\n');
    await editTool.execute({ path: F, oldText: 'const shell = "PID";', newText: 'const shell = "$$:$&";' }, ctx);
    // A naive replace(oldText, newText) would expand $$ -> $ and $& -> the match.
    expect(readFileSync(resolve(dir, F), 'utf8')).toBe('const shell = "$$:$&";\n');
  });
});