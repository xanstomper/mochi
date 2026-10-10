---
name: redteam-packs
description: Adversarial security testing packs — recon, web exploitation, auth bypass, privilege escalation, and proof-of-concept verification with safety guardrails.
tools: [read, write, edit, patch, shell, glob, search, fetch, browser, web_search]
---

# Red Team Packs Skill

**Scope guard:** only test systems you own or have explicit written authorization for. Every technique here is for defensive validation of your own infrastructure.

## Pack 1 — Recon
- Surface map: subdomains (cert transparency logs), open ports, tech fingerprints (response headers, favicon hashes, JS bundle paths).
- JS recon: download app bundles, extract API routes, secrets (regex for `AKIA`, `sk_`, JWT patterns), and commented-out endpoints.

## Pack 2 — Web exploitation
- **Injection ladder:** for every input, test in order — SQLi (`' OR 1=1--` variants, time-based `pg_sleep`), command injection (`; id`, backticks), path traversal (`../../etc/passwd`, encoded), SSRF (metadata IP `169.254.169.254`), template injection (`{{7*7}}`).
- **Auth bypass:** JWT `alg:none`, kid-injection, token-reuse across tenants, IDOR on sequential IDs, cookie-scope confusion, password-reset race.
- **Prototype pollution (Node):** `__proto__`/`constructor.prototype` in JSON body parsers and query-string mergers.

## Pack 3 — Privilege escalation
- Linux: SUID binaries (`find / -perm -4000`), writable cron paths, `sudo -l` misconfigs, CAP_NET_RAW containers.
- Web apps: role values in JWT/cookies vs server enforcement, admin-route authorization checks on API layer (not just UI hiding).

## PoC discipline (hard rule)
- A finding is REAL only with a working proof: the exact request/response, or a script that reproduces it. "Probably exploitable" is a hypothesis, not a finding.
- Every confirmed finding ships with: impact statement, reproduction steps, and a concrete remediation (input validation, parameterized query, secure default).
