---
name: multi-file-refactor
description: Operational playbook for cross-cutting TS refactors that touch 5+ files — repo topology, staging, parallel verification, worktree use, revert strategy, and the "stacked PR" pattern. Use when a refactor spans multiple modules, requires coordinated renames, or breaks the single-PR review budget. Complements the `refactoring` skill (principles) with the mechanics of actually shipping it.
---

# Multi-File Refactor (the mechanics)

The `refactoring` skill covers the principle: behavior preserved, structure
improved, one seam at a time, green between commits. This skill covers what
the principle doesn't — the operational reality of doing it across 5+ files
in a TS repo: where to stage, how to verify, when to split into stacked PRs,
when to use a worktree, and how to revert fast without losing the analysis.

## 1. Decide the shape FIRST (before any edit)

| Scope | Staging shape | Why |
|---|---|---|
| 1–3 files, all in one module | Single PR, single commit chain | Readable diff, one round of review |
| 4–10 files, one module or two siblings | Single PR, multi-commit (one seam per commit) | Reviewable per-commit, fast revert of a single bad seam |
| 10+ files OR cross-module | **Stacked PRs** — base PR lands seams + new types + tests, follow-up PR moves callers | Reviewers can bless the design before 50 file-diff lines hit them |
| Cross-repo | Stop. Discuss with the maintainer first | Cross-repo stacks rarely survive review |

The 10+ file threshold is the trigger: that diff will not get a thoughtful
review as a single PR. Stacking is not optional, it's survival.

## 2. The "seam commit" pattern

Each commit in a cross-cutting refactor MUST be one of three types:

1. **`seam`: add new types/functions/helpers** without removing the old
   — green at HEAD. Reviewer sees pure addition.
2. **`migrate: switch N callers to the new path** — `git add -p` to
   keep the diff minimal. Green at HEAD. No new logic.
3. **`delete: remove the old path** — green at HEAD, no callers left.

No commit may mix types. The order is ALWAYS seam → migrate-by-group →
delete. If a reviewer stops partway and asks "where's the cleanup?", your
chain is wrong.

## 3. Verify continuously — `tsc` AND `vitest` are not enough

Cross-cutting renames have three failure modes the typed compiler doesn't
catch:

1. **Dynamic string keys** — code that does `(env as any)[name]` instead of
   `env.name` survives `tsc`. Run `vitest run` after every commit.
2. **Test snapshots** — `*.snap` files contain literal strings with the old
   name. Run `vitest -u` ONLY after the rename is fully complete, then
   review every snapshot diff manually.
3. **Build artifacts** — `dist/`, generated `.d.ts`, build manifests.
   `rm -rf dist && tsc` after the delete commit, never before.

The bare-minimum verification cadence:
- Every seam commit: `tsc --noEmit && npx vitest run <touched.test.ts>`
- Every 3 migrate commits: full `npm test`
- The delete commit: full `npm test && npm run build`

## 4. Worktrees for parallel branches, not for the refactor itself

Use `mochi --worktree` ONLY when you need a second clean tree to test
against the pre-refactor state (e.g. "does the new path still handle the
old payload?"). The refactor itself should be sequential — concurrent
edits on overlapping files are how you lose half a refactor and have to
revert.

The exception: when the refactor needs to land alongside an in-flight
PR you're reviewing. Two PRs touching the same file at the same time is
fine in a worktree (it's a different branch), not fine in the same
working tree.

## 5. Revert strategy — speed matters

- **One commit went sideways**: `git reset --hard HEAD^` and redo.
  Don't `git revert` unless the commit is already pushed.
- **Three commits in, the seam was wrong**: `git reset --hard <good-sha>`
  and start the seam commits over. Re-doing 30 minutes of typing beats
  patching a wrong abstraction for three days.
- **The whole thing is wrong**: `mochi rollback` (named checkpoint) or
  `git reset --hard <pre-refactor-sha>`. Tell the user in the summary —
  don't silently nuke 12 commits of analysis without a status note.

The asymmetric cost: spending 5 minutes on a clean revert saves 50
minutes of fighting the wrong abstraction.

## 6. The "preflight rename" trick (TS-specific)

For symbol renames across many files:
1. Find all references (LSP `find references`, not grep)
2. Note any access via index signature (`obj[k]` where `obj` is typed) —
   these need an explicit type assertion update, grep won't show them
3. Note any test fixture or factory that produces instances of the renamed
   class — the constructor signature might be reused under the old name
4. Rename in a SINGLE commit (LSP rename), then split the diff into the
   seam/migrate/delete cadence if it's a complex refactor

The single-commit rename is fine for "exact rename, no design change".
If anything else is changing (different shape, different semantics), it
isn't a rename — it's a seam/migrate/delete plan.

## 7. PR description tells the reviewer how to read it

For stacked refactor PRs, the body is not a changelog — it's a routing
guide:

```
## What
Brief one-paragraph summary.

## Reading order
1. Read `src/foo.ts` first — the new shape
2. Then `src/foo.test.ts` — the new contract
3. Then the migrate commits — they are mechanical

## Verification
- `npm test`: <number>
- `npx tsc -p tsconfig.json --noEmit`: clean
- One exercise session against the real workspace

## Out of scope
- <things reviewers will spot but should not block this PR>
```

The "out of scope" section is non-negotiable — it tells reviewers
which of their discoveries are parked for follow-ups, freeing them to
approve the seam without demanding the whole refactor land at once.

## Pitfalls

- **The "rewrite whole module in one go" antipattern**: refactors that
  rewrite more than 30% of a file's lines are rewrites, not refactors.
  Land a parallel `foo.v2.ts`, migrate callers incrementally, delete
  `foo.ts` last.
- **`git add -p` and skip "trivial" hunks**: a 5-line refactor diff with
  30 unrelated formatting changes is unreviewable. Stage the refactor
  ONLY, then a separate commit for the formatting.
- **Trusting the LSP rename**: it misses dynamic access, config files,
  `.d.ts` shims, generated files, JSON Schema references, and database
  migrations. Grep for the old name + a 2-char suffix after the rename
  commit lands — anything you find is a hole.
- **Forgot the build artifact**: `dist/foo.js` still references the old
  name; downstream consumers see the OLD public API. Clean dist/ before
  the delete commit, never after.
- **Reviewer-driven scope creep**: 8 inline-suggestions on a refactor PR
  is the smell that the refactor scope is wrong. Accept ≤2 trivial, push
  the rest to follow-ups. Refactors that try to satisfy every comment
  grow past the diff budget and fail.
- **Running `tsc --noEmit` only**: it does not catch dynamic access.
  Always pair with `vitest run` after every seam.

## When NOT to use this skill

- Refactor in a single file under 200 lines — that's just editing.
- Refactor that is actually a rewrite — pair with `legacy-refactoring`.
- Bug fix that happens to touch many files — keep the bug fix's PR
  one-commit, do the cleanup refactor as a separate PR AFTER the fix.
- "I'll rename X across the codebase while I'm here" — that's the
  refactor that has zero review sign-off and ships broken. Don't.
