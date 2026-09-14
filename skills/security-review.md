---
name: security-review
description: Security audit methodology covering the OWASP Top 10, injection/XSS/CSRF/auth flaws, dependency and secret scanning, input sanitization, and rate limiting. Use when reviewing code for vulnerabilities or hardening a service.
tools:
  - security-audit
  - shell
  - read
  - web-search
---

# Security Review Skill

## When to Use
- Reviewing a PR, service, or dependency for vulnerabilities before shipping.
- Auditing authentication/authorization, input handling, or sensitive-data flows.
- Hardening a public-facing endpoint or integration.

## Threat-Model First
Start by asking *what is the worst thing an attacker could make this do*, given the trust boundary:
- What is the attack surface (unauthenticated endpoints, file uploads, external inputs)?
- What data must be protected (PII, credentials, secrets, financial data)?
- Who can reach the system (anonymous internet, authenticated users, internal only)?

## OWASP Top 10 (prioritized checks)
1. **Broken access control:** default/over-broad permissions, missing checks on object IDs (IDOR), admin endpoints reachable by normal users.
2. **Cryptographic failures:** secrets/default creds committed, weak or deprecated hashing, plaintext sensitive data at rest.
3. **Injection (SQL/XSS/command):** verified by confirming all external input is parameterized/escaped, never concatenated into queries, markup, or shell commands.
4. **Insecure design:** missing rate limits, missing security controls, trusting client-supplied state (e.g. prices, roles) without server re-validation.
5. **Security misconfiguration:** verbose error pages, insecure headers, exposed debug/admin endpoints, unused features enabled.
6. **Vulnerable components:** known-CVE dependencies (scan with npm/pip/cargo audit) and outdated base images.
7. **Authn failures:** weak or default credentials, missing MFA, session fixation, no lockout/rate-limit on login.
8. **Integrity failures:** deserializing untrusted data, missing signature checks on updates/uploads.
9. **Logging/monitoring failures:** no security-relevant logging, no alerting on failed logins.
10. **SSRF:** allowing the server to fetch user-supplied URLs without allow-lists/local-address protection.

## Common Vulnerability Checks
- **SQL injection:** parameterized queries everywhere; watch string-built SQL and raw ORM `raw()` calls.
- **XSS:** escape on output, prefer a sanitizer/`textContent`/framework auto-escaping; audit `dangerouslySetInnerHTML`-style sinks.
- **CSRF:** state-changing requests require CSRF tokens, SameSite cookies, or origin/referer validation.
- **Auth flaws:** check password hashing (bcrypt/argon2, never MD5/SHA1), session expiry, and that tokens are stored securely.
- **Secrets:** scan for committed API keys, `.env` files, and hardcoded passwords in code and history.

## Input Sanitization & Validation
- **Validate** (reject malformed input) rather than silently sanitizing; allow-list types, lengths, and formats.
- **Escape** at the output boundary, not just on input, so the storage layer stays canonical.
- Never trust `Content-Type`, `Referer`, or client-supplied IDs for authorization decisions.

## Rate Limiting & Abuse
- Apply rate limits to login, token minting, and any expensive/costly endpoint.
- Do rate limiting *server-side*, not just in the client/frontend.
- Consider per-IP and per-account limits, plus bot/behavior heuristics for public endpoints.

## Workflow
1. **Scope** the review: surface area, data at risk, trust boundaries.
2. **Run** `security-audit` to sweep dependencies, secrets, and known patterns.
3. **Trace** the highest-risk flows (auth, input → storage/output, external fetches) by hand.
4. **Verify** each finding is real (not a false positive) and categorize by severity.
5. **Report** findings with a concrete fix, prioritized by exploitability and blast radius.