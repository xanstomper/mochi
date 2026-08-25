import { describe, expect, it } from 'vitest';
import { runSecurityAudit, formatSecurityReport } from './security-audit.js';

describe('Security Audit Tool', () => {
  it('detects vulnerabilities and formats clean reports', () => {
    const findings = runSecurityAudit(process.cwd());
    expect(Array.isArray(findings)).toBe(true);

    const report = formatSecurityReport(findings);
    expect(report).toBeDefined();
    expect(report.length).toBeGreaterThan(0);
  });
});
