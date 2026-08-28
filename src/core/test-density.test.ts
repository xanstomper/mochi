import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  isTestFilePath,
  analyzeDiffTestDensity,
  evaluateTestDensity,
  synthesizeTestSkeleton,
} from './test-density.js';

describe('Epistemic Test Density & Synthesis Engine', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(resolve(tmpdir(), 'mochi-test-density-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('correctly classifies test file paths across languages and conventions', () => {
    expect(isTestFilePath('src/auth.test.ts')).toBe(true);
    expect(isTestFilePath('src/components/button.spec.tsx')).toBe(true);
    expect(isTestFilePath('tests/integration/api_test.py')).toBe(true);
    expect(isTestFilePath('pkg/server/handler_test.go')).toBe(true);
    expect(isTestFilePath('src/lib_test.rs')).toBe(true);

    expect(isTestFilePath('src/auth.ts')).toBe(false);
    expect(isTestFilePath('src/components/button.tsx')).toBe(false);
    expect(isTestFilePath('main.go')).toBe(false);
  });

  it('calculates line counts and density ratios from git diff output', () => {
    const mockDiff = `
diff --git a/src/services/billing.ts b/src/services/billing.ts
index 1234567..89abcdef 100644
--- a/src/services/billing.ts
+++ b/src/services/billing.ts
@@ -10,3 +10,15 @@
+export function calculateInvoice(total: number): number {
+  return total * 1.2;
+}
+export function formatCurrency(amount: number): string {
+  return "$" + amount.toFixed(2);
+}
diff --git a/src/services/billing.test.ts b/src/services/billing.test.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/src/services/billing.test.ts
@@ -0,0 +1,6 @@
+import { calculateInvoice } from './billing.js';
+it('calculates invoice', () => {
+  expect(calculateInvoice(100)).toBe(120);
+});
`;

    const analysis = analyzeDiffTestDensity(mockDiff);
    expect(analysis.productionLines).toBe(6);
    expect(analysis.testLines).toBe(4);
    expect(analysis.productionFiles).toContain('src/services/billing.ts');
    expect(analysis.testFiles).toContain('src/services/billing.test.ts');
  });

  it('evaluates test density and detects untested production files', () => {
    const mockDiff = `
diff --git a/src/auth.ts b/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,20 @@
+export function login() {}
+export function logout() {}
+export function refresh() {}
+export function revoke() {}
+export function inspect() {}
+export function verify() {}
+export function challenge() {}
+export function reset() {}
+export function register() {}
+export function deleteUser() {}
+export function listTokens() {}
+export function purgeSessions() {}
+export function rotateKeys() {}
+export function auditLog() {}
`;

    const report = evaluateTestDensity(testDir, mockDiff);
    expect(report.productionLinesChanged).toBe(14);
    expect(report.testLinesChanged).toBe(0);
    expect(report.densityRatio).toBe(0);
    expect(report.hasSufficientCoverage).toBe(false);
    expect(report.untestedFiles).toContain('src/auth.ts');
    expect(report.synthesisAdvice).toContain('Low test density detected');
  });

  it('synthesizes test skeletons for Vitest, PyTest, and Go', () => {
    const tsSkeleton = synthesizeTestSkeleton('src/crypto.ts', ['hashPassword', 'verifyHash'], 'vitest');
    expect(tsSkeleton).toContain("import { describe, it, expect } from 'vitest';");
    expect(tsSkeleton).toContain('import { hashPassword, verifyHash }');
    expect(tsSkeleton).toContain('hashPassword');

    const pySkeleton = synthesizeTestSkeleton('app/calculator.py', ['add', 'subtract'], 'pytest');
    expect(pySkeleton).toContain('import pytest');
    expect(pySkeleton).toContain('def test_add_basic():');

    const goSkeleton = synthesizeTestSkeleton('pkg/math.go', ['Sum'], 'go');
    expect(goSkeleton).toContain('func TestSum(t *testing.T)');
  });
});
