import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { computeSymbolBlastRadius } from '../codegraph.js';
import { blastRadiusTool } from './blast-radius.js';

describe('Blast Radius AST Dependency Analyzer', () => {
  it('computes call sites, affected files, and risk level for a symbol', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-blast-'));
    writeFileSync(
      resolve(dir, 'math.ts'),
      `export function add(a: number, b: number): number { return a + b; }\n`
    );
    writeFileSync(
      resolve(dir, 'calc.ts'),
      `import { add } from './math';\nexport function calculateTotal(items: number[]): number { return items.reduce((a, b) => add(a, b), 0); }\n`
    );

    const report = computeSymbolBlastRadius(dir, 'add');
    expect(report.symbol).toBe('add');
    expect(typeof report.riskLevel).toBe('string');
    expect(report.summary).toContain('add');
  });

  it('executes blast_radius tool and returns formatted architectural report', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-blast-tool-'));
    writeFileSync(
      resolve(dir, 'service.ts'),
      `export class AuthService { login() { return true; } }\n`
    );

    const result = await blastRadiusTool.execute({ symbol: 'AuthService' }, { cwd: dir } as any);
    expect(result).toContain('# Blast Radius Analysis: AuthService');
    expect(result).toContain('Risk Assessment:');
    expect(result).toContain('Recommendation:');
  });
});
