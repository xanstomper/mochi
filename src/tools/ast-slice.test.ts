import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { astSliceTool } from './ast-slice.js';
import type { ToolContext } from './types.js';

describe('astSliceTool', () => {
  let testDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    testDir = mkdtempSync(resolve(tmpdir(), 'mochi-tool-ast-slice-'));
    ctx = {
      cwd: testDir,
      agentId: 'test-agent',
      events: { emit: () => {} } as any,
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('slices a target symbol from a real file via tool interface', async () => {
    const file = resolve(testDir, 'math.ts');
    writeFileSync(
      file,
      `export interface MathOptions { precision: number; }
export function add(a: number, b: number, opts?: MathOptions): number {
  return a + b;
}
export function multiply(a: number, b: number): number {
  return a * b;
}
`
    );

    const result = await astSliceTool.execute({ path: 'math.ts', symbol: 'add' }, ctx);
    expect(typeof result).toBe('string');
    expect(result).toContain('JIT AST Slice');
    expect(result).toContain('export function add');
    expect(result).toContain('export interface MathOptions');
    expect(result).not.toContain('multiply');
  });

  it('handles missing file gracefully with descriptive error', async () => {
    const result = await astSliceTool.execute({ path: 'nonexistent.ts', symbol: 'foo' }, ctx);
    expect(result).toContain('Error: File not found');
  });
});
