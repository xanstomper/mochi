---
name: code-review
description: Comprehensive code review, pull request analysis, security vetting, cyclomatic complexity check, and architectural alignment.
tools: [read, diff, git, glob, search, verify]
---

# Code Review & Pull Request Vetting Skill

## PR Review Checklist
1. **Correctness & Logic:** Does the change solve the stated problem without introducing regressions or edge-case failures?
2. **Security & Data Safety:** Are inputs sanitized? Are secrets excluded? Are SQL injections or XSS vectors prevented?
3. **Test Coverage:** Does the PR include comprehensive unit/integration tests covering both happy path and failure cases?
4. **Maintainability & Readability:** Is naming descriptive and clear? Is dead/redundant code removed?
5. **Performance & Scalability:** Are there $O(N^2)$ loops, N+1 queries, or unindexed lookups in hot paths?
