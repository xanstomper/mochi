import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSecurityAudit, formatSecurityReport, securityAuditTool } from './security-audit.js';

describe('Security Audit Tool', () => {
  it('detects vulnerabilities and formats clean reports on current project', () => {
    const findings = runSecurityAudit(process.cwd());
    expect(Array.isArray(findings)).toBe(true);

    const report = formatSecurityReport(findings);
    expect(report).toBeDefined();
    expect(report.length).toBeGreaterThan(0);
  });

  it('detects multiple vulnerability classes in test fixtures', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mochi-sec-audit-'));
    try {
      const fixtureFile = join(tempDir, 'vuln_sample.ts');
      const sampleCode = `
        const apiKey = "sk-ant-api03-abcdef12345678901234567890";
        const query = \`SELECT * FROM users WHERE id = \${userId}\`;
        eval("2 + 2");
        const path = req.query.file;
        const data = fs.readFileSync("../" + path);
        obj["__proto__"] = malicious;
        const hash = crypto.createHash("md5");
        element.innerHTML = userInput;
        const token = Math.random().toString();
        res.json({ success: true }); // TODO: implement later
      `;
      writeFileSync(fixtureFile, sampleCode, 'utf8');

      const findings = runSecurityAudit(tempDir, { includeTests: true });
      expect(findings.length).toBeGreaterThanOrEqual(7);

      const rules = findings.map(f => f.rule);
      expect(rules).toContain('INJECTION_EVAL');
      expect(rules).toContain('INJECTION_PATH_TRAVERSAL');
      expect(rules).toContain('VULN_PROTOTYPE_POLLUTION');
      expect(rules).toContain('VULN_WEAK_CRYPTO_HASH');
      expect(rules).toContain('VULN_XSS_DOM');
      expect(rules).toContain('VULN_INSECURE_RANDOM_TOKEN');
      expect(rules).toContain('API_PLACEBO_STUB');

      // Test single file target
      const singleFileFindings = runSecurityAudit(tempDir, { path: 'vuln_sample.ts' });
      expect(singleFileFindings.length).toBe(findings.length);

      // Test minSeverity filter
      const criticalOnly = runSecurityAudit(tempDir, { path: 'vuln_sample.ts', minSeverity: 'CRITICAL' });
      expect(criticalOnly.every(f => f.severity === 'CRITICAL')).toBe(true);
      expect(criticalOnly.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects Python insecure deserialization and subprocess injection', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mochi-sec-py-'));
    try {
      const pyFile = join(tempDir, 'unsafe.py');
      const pyCode = `
import pickle
import subprocess

def load_data(raw):
    return pickle.loads(raw)

def run_cmd(user_input):
    subprocess.Popen("ls " + user_input, shell=True)
`;
      writeFileSync(pyFile, pyCode, 'utf8');

      const findings = runSecurityAudit(tempDir, { includeTests: true });
      const rules = findings.map(f => f.rule);
      expect(rules).toContain('VULN_INSECURE_DESERIALIZATION');
      expect(rules).toContain('PYTHON_SUBPROCESS_SHELL');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('executes via securityAuditTool', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mochi-sec-tool-'));
    try {
      const tsFile = join(tempDir, 'leak.ts');
      writeFileSync(tsFile, 'const secret = "ghp_123456789012345678901234567890";\n', 'utf8');

      const result = await securityAuditTool.execute(
        { path: 'leak.ts', min_severity: 'CRITICAL' },
        { cwd: tempDir } as any
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('SECRET_API_KEY');
      expect(result).toContain('[CRITICAL]');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
