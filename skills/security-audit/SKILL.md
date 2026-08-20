---
name: security-audit
description: Security audit workflow covering OWASP Top 10, static analysis, secret-leakage prevention, injection/SSRF/XSS checks, and dependency CVE review. Use when the task involves reviewing or hardening code security.
tools: [read, glob, search, grep, shell, sql_codebase_query]
---

# Security Audit Skill

## Scope
- Run a static pass for injection (SQL/command/deserialization), broken access control, XSS/CSRF, SSRF, and insecure defaults.
- Check for hardcoded secrets: API keys, tokens, passwords, AWS keys (scan for `sk-`, `AKIA`, `ghp_`, `Bearer `, private key blocks). Never echo a found secret — report the file/line and advise rotation.
- Dependency hygiene: look for known-vulnerable packages in manifests (package.json, requirements.txt, Cargo.toml, go.mod) and suggest `audit`/`pip-audit`/`cargo audit` runs.

## Checks to perform
1. AuthN/AuthZ: are admin operations guarded by middleware? Is authorization verified on the resource, not just the route?
2. Input: is every external value validated/escaped at the boundary (schema or parameterized query)?
3. Output: is user input escaped in HTML/JS contexts (no raw `dangerouslySetInnerHTML` unless necessary)?
4. Errors: do error paths leak stack traces, SQL, or internal paths? Use generic messages + server-side logs.
5. Rate limiting & abuse: are mutating endpoints throttled; is file upload size/type constrained?

## Deliverable
- Produce a prioritized list: `[HIGH] file:line — issue — remediation`. Order by exploitability, not alphabetical.
- If a fix is requested, make the minimal change and re-check adjacent call sites for the same pattern.