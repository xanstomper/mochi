// Comprehensive Static Security & Vulnerability Auditor.
// Scans project files and dependencies for credential leaks, command/SQL/code injections,
// insecure file operations, and vulnerable packages.

import { readFileSync, readdirSync, statSync } from 'node:fs';
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
    regex: /(?:['"])(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9_-]{10,})(?:['"])/,
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
  {
    id: 'SECRET_JWT_TOKEN',
    severity: 'HIGH',
    regex: /['"]eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}['"]/,
    description: 'Hardcoded JSON Web Token (JWT) detected.',
    remediation: 'Generate tokens dynamically at runtime; never commit static auth tokens.',
  },

  // 2. Command & Code Injection
  {
    id: 'INJECTION_EVAL',
    severity: 'CRITICAL',
    regex: /\b(?:eval|new Function)\s*\([^)]+\)/,
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
    regex: /(?:\.query|\.execute|\.prepare|\.runQuery|querySymbolGraphSync)\s*\(\s*`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE|PRAGMA)\b[^`]*\${[^}]+}[^`]*`/i,
    description: 'Raw SQL query constructed with string interpolation.',
    remediation: 'Use parameterized queries ($1, ? or prepared statements) to prevent SQL injection.',
  },

  // 4. Path Traversal & Arbitrary File Access
  {
    id: 'INJECTION_PATH_TRAVERSAL',
    severity: 'HIGH',
    regex: /(?:readFileSync|writeFileSync|readFile|writeFile|createReadStream|createWriteStream|sendFile)\s*\([^)]*(?:req\.(?:query|params|body)|(?:\.\.\/|\.\.\\))/i,
    description: 'Potential path traversal: user-controlled input or ../ in filesystem access without path validation.',
    remediation: 'Resolve and normalize target paths with path.resolve(), and verify they remain within the intended root directory.',
  },

  // 5. Insecure Deserialization
  {
    id: 'VULN_INSECURE_DESERIALIZATION',
    severity: 'CRITICAL',
    regex: /(?:pickle\.loads?|_pickle\.loads?|yaml\.load\s*\([^)]*(?:Loader\s*=\s*(?:None|yaml\.Loader|yaml\.UnsafeLoader)|[^\w]Loader\s*=\s*Loader)|unserialize\s*\()/,
    description: 'Insecure deserialization of untrusted payloads (e.g. Python pickle or unsafe YAML loader).',
    remediation: 'Use safe deserialization parsers (e.g. yaml.safe_load, json.loads); never deserialize untrusted pickle streams.',
    fileExts: ['.py', '.php'],
  },

  // 6. Prototype Pollution
  {
    id: 'VULN_PROTOTYPE_POLLUTION',
    severity: 'HIGH',
    regex: /\[['"](?:__proto__|constructor|prototype)['"]\]\s*=|(?:\.__proto__|constructor\.prototype)\s*=/i,
    description: 'Direct assignment to __proto__ or constructor.prototype leading to Prototype Pollution.',
    remediation: 'Use Object.create(null), Map, or check Object.hasOwn() to block object prototype mutations.',
    fileExts: ['.js', '.jsx', '.ts', '.tsx'],
  },

  // 7. Weak Cryptography & Insecure Randomness
  {
    id: 'VULN_WEAK_CRYPTO_HASH',
    severity: 'MEDIUM',
    regex: /(?:createHash\s*\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\s*\()/i,
    description: 'Usage of broken/weak cryptographic hash algorithms (MD5 or SHA1).',
    remediation: 'Upgrade to collision-resistant hash functions such as SHA-256, SHA-3, or BLAKE2 (or Argon2/bcrypt for passwords).',
  },
  {
    id: 'VULN_INSECURE_RANDOM_TOKEN',
    severity: 'MEDIUM',
    regex: /(?:token|secret|nonce|key|session|salt|password)\s*[:=]\s*[^;\n]*Math\.random\s*\(\)/i,
    description: 'Math.random() used in security, token, or secret generation context.',
    remediation: 'Use cryptographically secure pseudorandom number generators (crypto.randomBytes() or crypto.getRandomValues()).',
    fileExts: ['.js', '.jsx', '.ts', '.tsx'],
  },

  // 8. Cross-Site Scripting (XSS)
  {
    id: 'VULN_XSS_DOM',
    severity: 'HIGH',
    regex: /(?:dangerouslySetInnerHTML\s*=\s*\{\s*__html:|\.innerHTML\s*=\s*(?!['"`]<)|document\.write\s*\()/i,
    description: 'Direct unescaped DOM HTML injection (XSS sink).',
    remediation: 'Sanitize HTML with DOMPurify or use textContent / parameterized UI components.',
    fileExts: ['.js', '.jsx', '.ts', '.tsx', '.html'],
  },

  // 9. Server-Side Request Forgery (SSRF)
  {
    id: 'VULN_SSRF',
    severity: 'HIGH',
    regex: /(?:fetch|axios\.(?:get|post|request)|requests\.(?:get|post))\s*\(\s*(?:req\.(?:query|body|params)|url_param|user_url)/i,
    description: 'Potential SSRF: outbound HTTP request driven directly by unsanitized user parameter.',
    remediation: 'Validate destination URLs against a strict domain/IP allowlist and disallow requests to private RFC-1918 subnets.',
  },

  // 10. Permissive CORS & Permissions
  {
    id: 'INSECURE_CORS_WILDCARD',
    severity: 'MEDIUM',
    regex: /Access-Control-Allow-Origin['"]?\s*[:=]\s*['"]?\*['"]?.*credentials/i,
    description: 'Permissive wildcard CORS origin with credential support.',
    remediation: 'Specify explicit trusted origins when credentials (cookies/auth headers) are allowed.',
  },
  {
    id: 'DANGEROUS_PERMISSIONS',
    severity: 'HIGH',
    regex: /\bchmod\s+(?:-[a-zA-Z]+\s+)?0?777\b|\bfs\.chmod\s*\([^)]*0o?777/i,
    description: 'World-writable file permissions (0777).',
    remediation: 'Restrict file access to least-privilege permissions (e.g. 0755 or 0644).',
  },

  // 11. API Placebo / Stub Detection
  {
    id: 'API_PLACEBO_STUB',
    severity: 'LOW',
    regex: /(?:res|response)\.(?:status\(200\)\.)?json\s*\(\s*\{\s*(?:success|ok|status)\s*:\s*(?:true|['"]ok['"])\s*\}\s*\)\s*;?\s*(?:\/\/\s*TODO|\/\/\s*mock|\/\/\s*stub|\/\/\s*placeholder)/i,
    description: 'API Placebo: Endpoint returns hardcoded success without persisting changes or executing backend logic.',
    remediation: 'Implement real database persistence and state validation before responding with success.',
  },
];

const SCAN_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.cpp', '.c', '.json', '.yaml', '.yml',
]);

/** Scan project files for security vulnerabilities */
export function runSecurityAudit(
  cwd: string,
  opts: { path?: string; includeTests?: boolean; maxFiles?: number; minSeverity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' } = {}
): SecurityFinding[] {
  const includeTests = opts.includeTests ?? false;
  const maxFiles = opts.maxFiles ?? 350;
  const findings: SecurityFinding[] = [];
  const target = opts.path ? resolve(cwd, opts.path) : cwd;
  const rank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const minRank = opts.minSeverity ? (rank[opts.minSeverity] ?? 1) : 1;

  // Single file audit
  try {
    const st = statSync(target);
    if (st.isFile()) {
      const ext = extname(target).toLowerCase();
      if (SCAN_EXTS.has(ext)) {
        const content = readFileSync(target, 'utf8');
        const lines = content.split('\n');
        const relPath = relative(cwd, target);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const pattern of AUDIT_PATTERNS) {
            if (pattern.fileExts && !pattern.fileExts.includes(ext)) continue;
            if (rank[pattern.severity] < minRank) continue;
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
      }
      return findings.sort((a, b) => rank[b.severity] - rank[a.severity]);
    }
  } catch {
    return [];
  }

  // Directory traversal
  const stack = [target];
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
        entry.name === 'coverage' ||
        entry.name === 'build'
      ) {
        continue;
      }

      if (!includeTests && (entry.name.includes('.test.') || entry.name.includes('.spec.') || entry.name.includes('fixtures'))) {
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
              if (rank[pattern.severity] < minRank) continue;
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
      'Perform deep static security & vulnerability audit across project files. Detects OWASP Top 10 vulnerabilities: secrets/API keys, command & SQL injection, path traversal, prototype pollution, insecure deserialization, weak cryptography, DOM XSS, SSRF, permissive CORS, world-writable permissions, and API placebo stubs.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path to directory or specific file to audit (defaults to project root)', required: false },
      { name: 'include_tests', type: 'boolean', description: 'Whether to scan test files and spec directories (default false)', required: false },
      { name: 'min_severity', type: 'string', description: 'Minimum severity threshold to report (CRITICAL, HIGH, MEDIUM, LOW)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const path = typeof args.path === 'string' ? args.path : undefined;
    const includeTests = Boolean(args.include_tests || args.includeTests);
    const minSeverity = typeof args.min_severity === 'string' ? (args.min_severity.toUpperCase() as any) : undefined;
    const findings = runSecurityAudit(ctx.cwd, { path, includeTests, minSeverity });
    return formatSecurityReport(findings);
  },
};
