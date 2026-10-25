# Authoring Agent Skills for Mochi — the AAIF conformance + safety bar

Mochi's skills are [Agent Skills](https://agentskills.io/specification): a folder
with a `SKILL.md` file whose YAML frontmatter declares metadata and whose
Markdown body carries the procedure. The spec is stewarded by the **Agentic AI
Foundation (AAIF)**, a Linux Foundation project (Anthropic donated the spec, the
name, and agentskills.io on 2026-10-22).

Every skill Mochi ships or loads is validated against the spec by
`src/skills/aaif-conformance.ts` (`validateAaifSkill`), and every skill entering
through the import path (`mochi skills import` / `install` / `unpack`) is
additionally passed through a security screen (`src/features/skill-security-screen.ts`).
This document is the author-facing contract: what the validators enforce, and
how to write a skill that passes both.

Check your work before shipping:

```bash
mochi skills lint            # AAIF conformance + house quality bar; exit 1 on any violation
```

## 1. Spec conformance (blocking violations)

These rules come from the Agent Skills spec itself. A violation fails `mochi
skills lint` and the conformance test, and quarantines an imported skill.

| Rule | Requirement |
|---|---|
| `frontmatter-missing` | `SKILL.md` must start with a `---` delimited YAML frontmatter block. |
| `name-required` | Frontmatter must carry a non-empty `name`. |
| `name-format` | `name` is lowercase letters/digits and single hyphens only — no `_`, no leading/trailing hyphen, no `--`. |
| `name-length` | `name` is at most 64 characters. |
| `name-dir-match` | The `name` must match the parent directory name (`skills/my-skill/SKILL.md` → `my-skill`). Mochi's flat `my-skill.md` layout must match the file basename instead. |
| `description-required` | Frontmatter must carry a non-empty `description`. |
| `description-length` | `description` is at most 1024 characters. |
| `compatibility-type` / `compatibility-length` | Optional `compatibility` must be a string of at most 500 characters. |
| `metadata-type` | Optional `metadata` must be a map of string keys to **string** values (quote numbers: `version: "1.0"`). |
| `allowed-tools-type` | Optional `allowed-tools` must be a space-separated string of tool names: `allowed-tools: read diff git`. |
| `license-type` | Optional `license` must be a string (a license name, or a reference to a bundled license file). |
| `unknown-field` | No frontmatter fields outside the spec set plus Mochi's documented extensions (below). |

Mochi's documented frontmatter extensions (spec-unknown, but intentional and
validated for shape): `tools` (legacy declared-tools list; prefer
`allowed-tools`), `disable-model-invocation`, `category`, `tags`, `updated`.

Example of a conforming frontmatter:

```yaml
---
name: pdf-extraction
description: Extracts text and tables from PDFs and fills forms. Use when the user mentions PDFs, forms, or document extraction.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
allowed-tools: read write bash
---
```

## 2. House quality bar (Mochi's stricter layer, non-blocking for imports)

The spec places no format restrictions on the body. Mochi's quality gate
(`src/skills/skill-lint.ts`) is stricter for everything Mochi ships:

- `body-min` — at least 120 characters of body; a skill with no procedure is noise.
- `has-steps` — at least one numbered step (`1.` / `2.` …, numbered ATX
  headings like `## 1. Detect`, or `- [ ]` checkboxes). Skills must be actionable.
- `no-placeholders` — no bare TODO/TBD/FIXME/XXX markers (naming them inside
  quotes to *prohibit* them is fine).
- `description-min` — at least 20 characters: the description drives retrieval.
- Warn tier: `body-max` (>40k chars), `line-length` (>2000 chars on one line),
  `description-max` (>500 chars).

Write the body as: when-to-use triggers → numbered steps → pitfalls →
verification with executable evidence.

## 3. Security rules for skill authors (the ingestion screen)

Untrusted skills enter only through `mochi skills import`, which screens every
candidate. A **blocking** hit quarantines the skill — it is never installed and
never silently dropped: the skill is parked under
`<skills-root>/.quarantine/<name>/` with a `QUARANTINE.json` listing each named
reason. You cannot import past the screen; there is no override flag. Warn-tier
hits install but are flagged visibly in the report.

Never include any of this in a skill:

1. **Prompt-injection language** (`security:prompt-injection`) — instructions
   addressed to the agent that override its actual instructions ("ignore
   previous instructions", "disregard your guidelines"), attempts to make it
   reveal its system prompt, fake `[system]:` turns, "BEGIN NEW INSTRUCTIONS"
   markers, jailbreak claims. This includes the *description* — it is
   advertised into every prompt.
2. **Credential exfiltration** (`security:credential-exfiltration`) — any line
   pairing a credential/source reference (`~/.ssh`, `.aws/credentials`, `.env`,
   `api keys`, `tokens`, `printenv`, …) with an egress verb (`curl`, `wget`,
   `nc`, `scp`, `send`, `post`, `upload`, webhooks), and the word
   "exfiltrate" anywhere. Security-audit skills that *check* whether a
   credential file exists are fine; skills that *move* secret material off-box
   are not.
3. **Hidden instructions** (`security:invisible-unicode`,
   `security:hidden-html-instructions`, `security:concealed-directive`,
   `security:obfuscated-blob`) — zero-width or bidi control characters, HTML
   comments carrying agent-directed orders, "don't tell the user" prose, or
   long base64 payloads outside code fences.
4. **Fetch-and-execute** (`security:fetch-execute`, warn tier) —
   `curl … | bash` style remote execution installs flagged. Prefer named,
   reviewable steps; document dependencies in `compatibility` instead.

A skill is read by a model with tool access. Write it as if the most
dangerous possible reader will follow it verbatim — because eventually one will.

## 4. Publishing and importing

- Structure: `my-skill/SKILL.md` plus optional `scripts/`, `references/`,
  `assets/`. Keep `SKILL.md` under ~500 lines; push detail into `references/`.
- Import: `mochi skills import <source>` records provenance next to every
  installed skill (`.origin.json`: origin, source spec, resolved path, git
  commit and exact tag when the source is a clone) and prints every quarantine
  with its reasons.
- Re-importing is idempotent; quarantined skills stay quarantined (each
  re-import parks a fresh `-2`, `-3`… copy so evidence is never overwritten).
- To inspect a rejection: read `QUARANTINE.json` in the quarantine dir; every
  reason names the rule, file, and line.

## 5. Where the rules live (for maintainers)

- Spec conformance: `src/skills/aaif-conformance.ts` — rule table + limits
  mirror the spec and the `skills-ref` reference validator.
- House quality bar: `src/skills/skill-lint.ts`.
- Security screen: `src/features/skill-security-screen.ts`.
- Ingestion/quarantine: `src/features/skill-importer.ts`.
- Standing gates: `src/skills/aaif-conformance.test.ts` (100% of the bundled
  catalog must conform) and `src/features/aaif-ingestion.test.ts` (fixture
  matrix: good → installed, malformed/malicious → quarantined with reasons).
