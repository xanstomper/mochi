import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { extractSymbolFromSource, generateASTSlice } from './ast-slicer.js';

describe('JIT AST Slicer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(resolve(tmpdir(), 'mochi-ast-slicer-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extracts TypeScript function with docstrings and sibling types', () => {
    const tsCode = `
import { resolve } from 'node:path';

export interface UserSession {
  id: string;
  role: string;
}

export type AuthToken = string;

/**
 * Validates the user session token against expiry.
 * @param token Raw JWT or bearer token
 */
export function validateSession(token: AuthToken): UserSession | null {
  if (!token) return null;
  return { id: 'usr_123', role: 'admin' };
}

export function otherHelper() {
  return 42;
}
`;

    const extracted = extractSymbolFromSource(tsCode, 'validateSession');
    expect(extracted.found).toBe(true);
    expect(extracted.kind).toBe('function');
    expect(extracted.content).toContain('export function validateSession');
    expect(extracted.content).toContain('Validates the user session token');
    expect(extracted.siblingTypes.some((s) => s.includes('UserSession'))).toBe(true);
    expect(extracted.siblingTypes.some((s) => s.includes('AuthToken'))).toBe(true);
  });

  it('extracts Python function with decorators and indentation boundaries', () => {
    const pyCode = `
from typing import Optional, Dict

class Config:
    timeout: int = 30

@cache_result
def compute_metrics(dataset_id: str, limit: int = 100) -> Dict[str, float]:
    """Calculates summary statistics."""
    total = 0.0
    for i in range(limit):
        total += i * 1.5
    return {"mean": total / limit}

def unrelated_task():
    pass
`;

    const extracted = extractSymbolFromSource(pyCode, 'compute_metrics');
    expect(extracted.found).toBe(true);
    expect(extracted.kind).toBe('function');
    expect(extracted.content).toContain('def compute_metrics');
    expect(extracted.content).toContain('@cache_result');
    expect(extracted.content).toContain('Calculates summary statistics');
    expect(extracted.content).not.toContain('unrelated_task');
  });

  it('generates high-savings JIT AST slice from disk file', async () => {
    const fullFile = [
      '// Large 100-line module',
      'export interface Payload { data: string; }',
      'export type Status = "ok" | "err";',
      ...Array.from({ length: 40 }, (_, i) => `// Padding comment line ${i}`),
      '/**',
      ' * Main processing kernel',
      ' */',
      'export function processPayload(p: Payload): Status {',
      '  if (!p.data) return "err";',
      '  return "ok";',
      '}',
      ...Array.from({ length: 40 }, (_, i) => `// Post padding comment line ${i}`),
    ].join('\n');

    const filePath = resolve(testDir, 'processor.ts');
    writeFileSync(filePath, fullFile);

    const slice = await generateASTSlice({
      cwd: testDir,
      filePath: 'processor.ts',
      symbolName: 'processPayload',
    });

    expect(slice).not.toBeNull();
    expect(slice?.symbolName).toBe('processPayload');
    expect(slice?.savingsPercent).toBeGreaterThan(70);
    expect(slice?.formattedSlice).toContain('JIT AST Slice');
    expect(slice?.formattedSlice).toContain('Token Savings');
    expect(slice?.formattedSlice).toContain('export function processPayload');
    expect(slice?.formattedSlice).toContain('export interface Payload');
  });
});
