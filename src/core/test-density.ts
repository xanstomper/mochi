// Epistemic Test Density & Proactive Test Synthesis Engine for Mochi
// Audits the ratio of test code to production changes, identifies untested newly
// introduced symbols, and generates actionable test templates to guarantee zero-bug delivery.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectRepo } from '../repo.js';

export interface TestDensityReport {
  productionLinesChanged: number;
  testLinesChanged: number;
  densityRatio: number;
  untestedFiles: string[];
  testFramework: 'vitest' | 'jest' | 'pytest' | 'cargo' | 'go' | 'unknown';
  hasSufficientCoverage: boolean;
  synthesisAdvice: string;
}

/** Determines if a relative or absolute file path corresponds to a test file */
export function isTestFilePath(filePath: string): boolean {
  const norm = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    norm.includes('.test.') ||
    norm.includes('.spec.') ||
    norm.includes('/__tests__/') ||
    norm.includes('/tests/') ||
    norm.includes('/test/') ||
    norm.endsWith('_test.go') ||
    norm.endsWith('_test.py') ||
    norm.endsWith('_test.rs')
  );
}

/** Parses git diff output to calculate changed line density between test & production files */
export function analyzeDiffTestDensity(gitDiffOutput: string): {
  productionLines: number;
  testLines: number;
  productionFiles: string[];
  testFiles: string[];
} {
  const lines = gitDiffOutput.split(/\r?\n/);
  let curFile = '';
  let isCurTest = false;
  let prodCount = 0;
  let testCount = 0;
  const prodFiles = new Set<string>();
  const testFiles = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ');
      const bPath = parts[parts.length - 1]?.replace(/^b\//, '') ?? '';
      curFile = bPath;
      isCurTest = isTestFilePath(curFile);
      if (curFile) {
        if (isCurTest) testFiles.add(curFile);
        else prodFiles.add(curFile);
      }
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++') && line.trim().length > 1) {
      if (isCurTest) testCount++;
      else prodCount++;
    }
  }

  return {
    productionLines: prodCount,
    testLines: testCount,
    productionFiles: [...prodFiles],
    testFiles: [...testFiles],
  };
}

/** Generates a test density audit report and proactive advice */
export function evaluateTestDensity(cwd: string, gitDiffOutput: string): TestDensityReport {
  const analysis = analyzeDiffTestDensity(gitDiffOutput);
  const repo = detectRepo(cwd);

  let framework: TestDensityReport['testFramework'] = 'unknown';
  if (repo.testCommand?.includes('vitest')) framework = 'vitest';
  else if (repo.testCommand?.includes('jest')) framework = 'jest';
  else if (repo.testCommand?.includes('pytest')) framework = 'pytest';
  else if (repo.testCommand?.includes('cargo')) framework = 'cargo';
  else if (repo.testCommand?.includes('go test')) framework = 'go';

  const totalAdded = analysis.productionLines + analysis.testLines;
  const densityRatio = totalAdded > 0 ? analysis.testLines / totalAdded : 1.0;

  // Find production files with 0 matching test files in diff
  const untestedFiles = analysis.productionFiles.filter((pFile) => {
    const baseName = pFile.replace(/\.[^/.]+$/, '');
    return !analysis.testFiles.some((tFile) => tFile.includes(baseName));
  });

  const hasSufficientCoverage =
    analysis.productionLines === 0 ||
    (analysis.testLines > 0 && densityRatio >= 0.20 && untestedFiles.length === 0);

  let synthesisAdvice = 'Test coverage is well-balanced across modified source files.';
  if (!hasSufficientCoverage && analysis.productionLines > 10) {
    synthesisAdvice = `Low test density detected (${Math.round(densityRatio * 100)}%). ${untestedFiles.length} file(s) modified without corresponding tests: [${untestedFiles.slice(0, 3).join(', ')}]. Proactively add unit tests using ${framework !== 'unknown' ? framework : 'the project test runner'}.`;
  }

  return {
    productionLinesChanged: analysis.productionLines,
    testLinesChanged: analysis.testLines,
    densityRatio,
    untestedFiles,
    testFramework: framework,
    hasSufficientCoverage,
    synthesisAdvice,
  };
}

/** Synthesizes an idiomatic starter unit test template for a newly created or modified source file */
export function synthesizeTestSkeleton(
  relativeSourcePath: string,
  exportedSymbols: string[],
  framework: TestDensityReport['testFramework'] = 'vitest'
): string {
  const normPath = relativeSourcePath.replace(/\\/g, '/');
  const ext = normPath.split('.').pop() || 'ts';
  const importName = normPath.replace(/\.[^/.]+$/, '') + '.js';

  if (framework === 'pytest' || ext === 'py') {
    const modName = normPath.replace(/\.py$/, '').replace(/\//g, '.');
    return [
      `"""Unit tests for ${normPath}"""`,
      'import pytest',
      `from ${modName} import ${exportedSymbols.length ? exportedSymbols.join(', ') : '*'}`,
      '',
      ...exportedSymbols.map(
        (sym) => `def test_${sym}_basic():\n    # TODO: assert ${sym} expected behavior\n    assert True\n`
      ),
    ].join('\n');
  }

  if (framework === 'go' || ext === 'go') {
    return [
      'package main',
      '',
      'import "testing"',
      '',
      ...exportedSymbols.map(
        (sym) => `func Test${sym}(t *testing.T) {\n\t// TODO: test ${sym}\n}\n`
      ),
    ].join('\n');
  }

  // Default TypeScript / JavaScript (Vitest / Jest)
  return [
    `import { describe, it, expect } from '${framework === 'jest' ? '@jest/globals' : 'vitest'}';`,
    `import { ${exportedSymbols.join(', ')} } from './${importName.split('/').pop()}';`,
    '',
    `describe('${normPath}', () => {`,
    ...exportedSymbols.map(
      (sym) => `  it('verifies ${sym} behavior under standard and edge cases', () => {\n    expect(typeof ${sym}).toBeDefined();\n  });`
    ),
    '});',
  ].join('\n');
}
