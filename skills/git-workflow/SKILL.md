---
name: git-workflow
description: Safe git procedures - checkpoints, inspecting history, branches, and what never to do without approval. Use for any git operation beyond plain status/diff.
---

# Git Workflow

## Reading (always safe)
- `git status --short`, `git diff` — current state.
- `git log --oneline -n`, `git blame <file>`, `git show <sha>` — history.
- The `git_log` / `git_blame` tools wrap these with useful defaults.

## Checkpoints
- The harness snapshots state before edits. If you break something and can't fix forward, say so — do NOT `git checkout .` to "get back".
- Prefer small commits when working for a long time: stage only your files (`git add <paths>`), commit with a message saying what and why.

## Never without explicit user approval
- `git push --force` / `-f` variants
- `git reset --hard`, `git checkout -- .`, `git clean -fd`
- deleting branches, rewriting history on shared branches
- pushing to remotes at all, unless the user asked

## Branches
- New work in a repo with a clean tree: branch first when the change is large or experimental.
- Name branches after intent: `fix-null-token`, `feat-crawl-tool`.

## Recovering
- Accidental commit: `git reset --soft HEAD~1` (keeps changes).
- Wrong branch: `git stash`, switch, `git stash pop`.
- Conflicted rebase/merge: read `git status`, resolve each file with `edit`, `git add` it, continue. Never resolve by deleting the other side blindly.
