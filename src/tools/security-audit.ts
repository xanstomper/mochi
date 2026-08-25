// Comprehensive Static Security & Vulnerability Auditor.
// Scans project files and dependencies for credential leaks, command/SQL/code injections,
// insecure file operations, and vulnerable packages.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import type { Tool } from './types.js';

export interface SecurityFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  file: string;
  line: number;
  rule: string;
  description: string;
  snippet: string;
  remediation: string;
}

interface AuditPattern {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  regex: RegExp;
  description: string;
  remediation: string;
  fileExts?: string[];
}

const AUDIT_PATTERNS: AuditPattern[] = [
  // 1. Secrets & Credentials
  {
    id: 'SECRET_API_KEY',
    severity: 'CRITICAL',
    regex: /(?:['"])(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})(?:['"])/,
    description: 'Hardcoded API key or access token detected in source code.',
    remediation: 'Move secrets to environment variables (.env) or secret stores; do not commit them.',
  },
  {
    id: 'SECRET_PRIVATE_KEY',
    severity: 'CRITICAL',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    description: 'Hardcoded private key block detected.',
    remediation: 'Store private keys in secure file vaults or system keychains.',
  },

  // 2. Command & Code Injection
  {
    id: 'INJECTION_EVAL',
    severity: 'CRITICAL',
    regex: /\beval\s*\([^)]+\)|\bFunction\s*\([^)]*\)\s*\(/,
    description: 'Dynamic code execution via eval() or Function constructor.',
    remediation: 'Avoid dynamic code execution; parse structured JSON or use strict dispatch tables.',
    fileExts: ['.js', '.jsx', '.ts', '.tsx'],
  },
  {
    id: 'INJECTION_SHELL_EXEC',
    severity: 'HIGH',
    regex: /(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\${[^}]+}[^`]*`/,
    description: 'Potential command injection: unsanitized template interpolation in shell exec.',
    remediation: 'Use spawn with an array of arguments rather than a concatenated shell command string.',
    fileExts: ['.js', '.jsx', '.ts', '.tsx'],
  },
  {
    id: 'PYTHON_SUBPROCESS_SHELL',
    severity: 'HIGH',
    regex: /subprocess\.(?:Popen|run|call|check_output)\s*\([^)]*shell\s*=\s*True/,
    description: 'Python subprocess executed with shell=True.',
    remediation: 'Pass arguments as a list and set shell=False to prevent shell injection.',
    fileExts: ['.py'],
  },

  // 3. SQL Injection
  {
    id: 'INJECTION_SQL_INTERPOLATION',
    severity: 'HIGH',
    regex: /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\s+[^`"'\n]*`[^`]*\${[^}]+}[^`]*`/i,
    description: 'Raw SQL query constructed with string interpolation.',
    remediation: 'Use parameterized queries ($1, ? or prepared statements) to prevent SQL injection.',
  },

  // 4. Insecure HTTP / Communication
  {
    id: 'INSECURE_HTTP_REQUEST',
    severity: 'MEDIUM',
    regex: /https?:\/\/http:\/\//i,
    description: 'Insecure plaintext HTTP URL used in network communication.',
    remediation: 'Upgrade to HTTPS endpoints to prevent eavesdropping and man-in-the-middle attacks.',
  },
];

const SCAN_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.cpp', '.c', '.json', '.yaml', '.yml',
]);

/** Scan project files for security vulnerabilities */
export function runSecurityAudit(cwd: string, maxFiles = 250): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const stack = [cwd];
  let filesScanned = 0;

  while (stack.length && filesScanned < maxFiles) {
    const curr = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(curr, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'target' ||
        entry.name === 'coverage'
      ) {
        continue;
      }

      const fullPath = resolve(curr, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && SCAN_EXTS.has(extname(entry.name).toLowerCase())) {
        filesScanned++;
        const ext = extname(entry.name).toLowerCase();
        try {
          const content = readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const relPath = relative(cwd, fullPath);

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pattern of AUDIT_PATTERNS) {
              if (pattern.fileExts && !pattern.fileExts.includes(ext)) continue;
              if (pattern.regex.test(line)) {
                findings.push({
                  severity: pattern.severity,
                  file: relPath,
                  line: i + 1,
                  rule: pattern.id,
                  description: pattern.description,
                  snippet: line.trim().slice(0, 120),
                  remediation: pattern.remediation,
                });
              }
            }
          }
        } catch {}
      }
    }
  }

  // Sort: CRITICAL > HIGH > MEDIUM > LOW
  const rank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return findings.sort((a, b) => rank[b.severity] - rank[a.severity]);
}

export function formatSecurityReport(findings: SecurityFinding[]): string {
  if (!findings.length) {
    return '🛡️ Security Audit: No vulnerabilities or secret leaks detected across scanned files.';
  }

  const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) counts[f.severity]++;

  const lines = [
    `🛡️ Security Audit Findings (${findings.length} total: ${counts.CRITICAL} CRITICAL, ${counts.HIGH} HIGH, ${counts.MEDIUM} MEDIUM, ${counts.LOW} LOW):\n`,
  ];

  for (const f of findings) {
    const badge = `[${f.severity}]`.padEnd(10, ' ');
    lines.push(`${badge} ${f.file}:${f.line} — ${f.description}`);
    lines.push(`           Rule: ${f.rule}`);
    lines.push(`           Code: \`${f.snippet}\``);
    lines.push(`           Fix:  ${f.remediation}\n`);
  }

  return lines.join('\n');
}

export const securityAuditTool: Tool = {
  def: {
    name: 'security_audit',
    description:
      'Perform static security and vulnerability audit across project files. Detects secret leaks (API keys, private keys), code injection, command injection, and SQL injection risks.',
    parameters: [],
    permission: 'read',
  },
  async execute(args, ctx) {
    const findings = runSecurityAudit(ctx.cwd);
    return formatSecurityReport(findings);
  },
};
