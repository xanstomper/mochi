# Security Policy

## Supported versions

| Version | Supported          |
|---------|--------------------|
| 0.5.x   | :white_check_mark: |
| 0.4.x   | :white_check_mark: |
| < 0.4   | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Email **security@mochi.dev** or use GitHub's [private vulnerability reporting][advisories].

You should receive an acknowledgement within 48 hours. If you do not, please follow up.

[advisories]: https://github.com/xanstomper/mochi/security/advisories/new

## What to expect

1. **Acknowledgement** within 48 hours of your report.
2. **Triage** within 5 business days: we confirm the issue, assess severity, and assign a CVE if needed.
3. **Fix** on a timeline appropriate to severity:
   - Critical: 1-7 days
   - High: 7-30 days
   - Medium: 30-90 days
   - Low: best effort, may be deferred to next release
4. **Disclosure** coordinated with the reporter. We aim to publish a security advisory at the same time as the fix is released.

## Recognition

We maintain a [security acknowledgements page][hall-of-fame] for researchers who report valid vulnerabilities. With your permission, we will credit you there.

[hall-of-fame]: https://github.com/xanstomper/mochi/security/acknowledgements

## Scope

The following are in scope:

- The `mochi` CLI binary
- The `github.com/mochi/mochi` Go module and its sub-packages
- The documentation site (when it exists)
- The official Docker images
- The official Homebrew, Scoop, and npm packages

The following are **out of scope**:

- Third-party plugins, MCP servers, or skills
- User-defined hooks
- Third-party LLM providers
- Vulnerabilities in upstream dependencies (please report those upstream)

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, or service disruption
- Only interact with accounts they own or have explicit permission to access
- Stop testing immediately if they encounter user data and report it to us
- Do not exploit a vulnerability beyond what is necessary to demonstrate it

## Security best practices for users

- Never commit API keys to version control. Use `mochi login` instead.
- Use the principle of least privilege for tool permissions.
- Review the `MOCHI.json` hooks before enabling them.
- Keep mochi updated to the latest patch release.
- Use a separate, scoped API key for mochi if possible.

Thank you for keeping mochi and its users safe.
