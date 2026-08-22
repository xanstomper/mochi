---
name: research
description: Web and codebase research procedure - search, crawl, cite sources, and explore unfamiliar repositories efficiently. Use when investigating libraries, APIs, errors, or an unknown codebase.
---

# Research Procedure

## Web research
1. Start with `web_search` (add `domain:` to pin to docs sites like developer.mozilla.org, docs.rs, pkg.go.dev).
2. For a known URL use `fetch`. For a documentation SITE use `web_crawl` (it follows links, same-host by default; use `include_pattern` to stay in the docs subtree).
3. Prefer primary sources: official docs > GitHub source/issues > blog posts > AI-generated content farms.
4. Record exact version numbers — an API answer without a version is half an answer.

## Codebase research
1. Orient first: read README/package.json, then `tree` (depth-limited), then the entrypoint.
2. Follow the data: find where input enters (route/CLI/main) and where the relevant state lives.
3. `search` for the exact symbol/strings; `get_function` for one definition; `find_callers` to trace usage; `type_hierarchy` for inheritance.
4. Take notes as you go: file paths + what each contains. Re-reading is the #1 token waster.
5. When you infer an architecture fact, verify it against ONE concrete call site before relying on it.

## Citing
- Name files with paths, quote the decisive lines. "It handles retries" << "src/http.ts:88 retries 4x with backoff".

## Efficiency rules
- Never re-read a file you read 3 turns ago; re-check only the lines you're editing.
- If a tool result was truncated, the full output path is at the end of the result — grep THAT file rather than re-running the tool.
- Batch independent reads/searches in one turn (the harness runs them in parallel).
