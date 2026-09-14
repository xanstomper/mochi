---
name: markdown-docs
description: Markdown documentation writing covering README structure, API docs, architecture decision records (ADRs), changelogs, language docstring patterns, Mermaid diagrams, internal links, and badges. Use when producing or revising project docs.
tools:
  - write
  - edit
  - markdown
  - read
---

# Markdown Documentation Skill

## When to Use
- Writing or improving a README, API reference, architecture doc, or changelog.
- Adding an ADR for a significant decision.
- Producing inline docstrings/comments in code.

## README Structure
A good README answers, in order:
1. **What** this project is (one crisp sentence) and a hero screenshot if applicable.
2. **Quick start** — exact commands to install, configure, and run, copy-pasteable.
3. **Configuration** — env vars, flags, and their defaults in a table.
4. **Development** — how to run tests/lint/build locally and the contribution workflow.
5. **Deployment** — how the artifact is built and shipped.
6. **Architecture** — a short section with a diagram linking to deeper docs.
7. **License / acknowledgements** at the end.

Keep the README current and shallow; push deep material to linked files.

## API Docs
- Use **OpenAPI/Swagger** for HTTP APIs; keep examples accurate and validated against the schema.
- For libraries, document every exported symbol with its signature, behavior, edge cases, and a usage snippet.
- **Show, don't just describe:** give a runnable example before the reference details.

## Architecture Decision Records (ADRs)
Each ADR is a dated, numbered markdown file capturing:
- **Context:** the constraint/problem forcing the decision.
- **Decision:** the chosen approach and the alternatives considered.
- **Consequences:** what becomes easier/harder, and known tradeoffs.
Use a `docs/adr/` folder with `NNNN-title.md` filenames and a numbered index.

## Changelog Format
- Follow **Keep a Changelog** and **SemVer**: `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`.
- Keep an `[Unreleased]` section at the top; tag released versions with the date and git tag.

## Docstring Patterns by Language
- **Python:** PEP 257 with a one-line summary, Args/Returns/Raises sections (use Google or NumPy style consistently).
- **TypeScript/JavaScript:** JSDoc tags (`@param`, `@returns`, `@throws`, `@example`).
- **Go:** doc comments (no separators) on all exported identifiers, starting with the identifier name.
- **Rust:** markdown doc comments (`///`) on public items with `# Examples`.
- **Java/C#:** Javadoc/XML-doc on public APIs; explain *why*, not just *what*.

## Mermaid Diagrams
- Use `mermaid` fenced blocks for flowcharts, sequence diagrams, ERD, and architecture graphs (many renderers support them inline).
- Keep diagrams simple and legible; use subgraphs and named nodes instead of tangle-heavy graphs.

## Internal Links & Badges
- Link docs to each other with relative paths (`./architecture.md`) so they work on GitHub and local.
- Add status badges only if they are **live** (build/test/coverage/version), and keep their URLs maintained.

## Workflow
1. **Read** the existing docs to match tone and structure.
2. **Outline** the missing sections before writing.
3. **Write** focused, concrete content with runnable examples.
4. **Verify** links resolve and the rendered output looks right; fix broken anchors.