"""grok_4_4 - security examples."""
from __future__ import annotations
from typing import Any, Dict, List

grok_4_4_security_examples: List[Dict[str, Any]] = [
    {"instruction": "XSS prevention", "response": "CSP+escape+HttpOnly+sanitize", "difficulty": 0.3},
    {"instruction": "OAuth 2.0", "response": "Auth code flow, redirect, token", "difficulty": 0.4},
    {"instruction": "HTTPS/TLS", "response": "Handshake+cert+ECDHE+encrypt", "difficulty": 0.8},
    {"instruction": "SQL injection fix", "response": "Parameterized queries always", "difficulty": 0.4},
    {"instruction": "CSRF prevention", "response": "Tokens+SameSite+origin check", "difficulty": 0.3},
    {"instruction": "Zero-trust", "response": "Never trust+microseg+verify", "difficulty": 0.8},
    {"instruction": "Public-key crypto", "response": "RSA: public encrypt, private decrypt", "difficulty": 0.2},
    {"instruction": "Least privilege", "response": "Minimum permissions+RBAC", "difficulty": 0.8},
    {"instruction": "Defense in depth", "response": "Firewall+WAF+auth+encrypt+monitor", "difficulty": 0.3},
    {"instruction": "Session management", "response": "Random IDs+HTTPS+timeout", "difficulty": 0.3},
    {"instruction": "DDoS protection", "response": "Rate limit+CDN+anycast+WAF", "difficulty": 0.4},
    {"instruction": "JWT best practices", "response": "RS256+short exp+validate", "difficulty": 0.3},
    {"instruction": "Container security", "response": "Scan+non-root+readonly+minimal", "difficulty": 0.7},
    {"instruction": "K8s security", "response": "RBAC+netpol+secrets+audit", "difficulty": 0.2},
    {"instruction": "Cloud security", "response": "IAM+encrypt+SG+VPC+logging", "difficulty": 0.2},
    {"instruction": "Supply chain", "response": "SBOM+scan+signed+trusted", "difficulty": 0.8},
    {"instruction": "Password best", "response": "Argon2id+12char+MFA+lockout", "difficulty": 0.4},
    {"instruction": "CORS config", "response": "Whitelist+methods avoid wildcard", "difficulty": 0.4},
    {"instruction": "SSRF prevention", "response": "Validate+block internal+allowlist", "difficulty": 0.3},
    {"instruction": "API auth methods", "response": "Keys+OAuth+JWT+mTLS+HMAC", "difficulty": 0.2},
]
__all__ = ["grok_4_4_security_examples"]
