---
name: skill-authoring
description: How to write high-quality SKILL.md files — when to author one, required structure, detail bar, and the lifecycle (create, use, refine, retire). Load this before creating or improving any skill.
---

# Skill Authoring Guide

Skills are persistent procedural memory. A good skill turns a lesson you
learned the hard way into a shortcut every future session gets for free.

## When to author a skill

Author one when you have:
- **Solved a non-obvious problem** whose fix would be expensive to re-derive
  (e.g. "this build fails under Node 22 unless X").
- **Repeated a workflow** 2+ times (release steps, review checklist, deploy runbook).
- **Learned a project convention** the codebase does not enforce but expects.

Do NOT author skills for: one-off fixes that will never recur, anything already
documented in AGENTS.md/MOCHI.md, or raw command dumps with no rationale.

If the reusable thing is an EXECUTABLE pipeline rather than knowledge, build a
callable tool with `tool_factory` instead — skills guide judgment, tools
execute work. Both can be needed: the skill explains WHEN, the tool does HOW.

## Required structure

```markdown
---
name: lowercase-hyphen-name
description: One specific sentence — what it is for AND when to apply it.
  This is the ONLY text the model sees when deciding to load the skill.
---

# Title

## Trigger / when to use
The conditions under which this skill applies. Be concrete.

## Approach
Numbered steps. Each step says WHY, not just WHAT.

## Pitfalls
What goes wrong if you skip a step. Real failure modes, not disclaimers.

## Verification
How to prove the approach worked (command, test, observable signal).
```

## Detail bar

- A stranger (or future-you with zero context) must be able to follow it.
- Every step: **action + reason**. "Bump the timeout" is noise; "bump the
  timeout to 30s because the CI runner is cold and the build needs ~20s" is a skill.
- Include exact commands, file paths, error signatures — verbatim, copy-pasteable.
- Keep it under ~120 lines. If it grows past that, split by trigger condition.
- `description` frontmatter is retrieval: no match on it means the skill never loads.

## Lifecycle

1. **create** via `skill_manage action="create"` — lands in the project's
   `.mochi/skills/` (or `~/.mochi/skills/` for cross-project memory).
2. **use** — future sessions auto-see it in `<available_skills>` and load it
   with the `skill` tool when the task matches.
3. **refine** — when a skill's steps turn out wrong/incomplete, `skill_manage
   action="patch"` immediately with what you learned. Stale skills are worse
   than none.
4. **retire** — `skill_manage action="delete"` archives (recoverable). The
   background curator also archives skills unused for 90 days.

## Quality checklist before saving

- [ ] Does the description contain the words a future task would use?
- [ ] Does every step have a reason attached?
- [ ] Are commands verbatim and verified (you ran them)?
- [ ] Is there at least one real pitfall from this session's experience?
- [ ] Would this have saved the last hour if it had existed?
