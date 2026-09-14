---
name: release-management
description: Release workflow covering semantic versioning, changelog generation, release branches, tagging, npm/PyPI/crates.io publishing, GitHub releases, and hotfixes. Use when cutting a release or rolling a version.
tools:
  - git
  - shell
  - write
  - create-pr
---

# Release Management Skill

## When to Use
- Cutting a new version for npm, PyPI, crates.io, or a GitHub release.
- Preparing a changelog or release notes.
- Planning how a hotfix should flow without pulling in unrelated changes.

## Semantic Versioning
- **Major** (X.0.0): breaking changes to the public API/behavior.
- **Minor** (0.Y.0): backwards-compatible new features.
- **Patch** (0.0.Z): backwards-compatible bug fixes.
- **Pre-release** suffixes (`-alpha.1`, `-rc.1`) signal not-yet-stable builds.
- Choose the bump from the *largest* change category present since the last tag; never release breaking changes under a minor/patch bump.

## Changelog Workflow
- Maintain a `CHANGELOG.md` following **Keep a Changelog** with an `[Unreleased]` section at the top.
- Group changes by type: `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`.
- On release, fold `[Unreleased]` into a versioned, dated heading and tag it.
- Keep versions and tags in sync: the version in the package manifest must match the git tag and changelog heading.

## Releases & Branching
- **Mainline flow (recommended for most):** commit to default branch, tag at release points, attach to a GitHub Release. Avoid long-lived release branches unless you support multiple published versions.
- **If you keep release branches:** create `release/X.Y.z` from the default branch at the cut point; merge back any fixes. Handle the release branch's final prerelease tag so subsequent bugs land in the right series.
- **Hotfix flow:** branch from the released tag (not from main), apply the minimal fix, release as the patch version, then merge the fix back to main to avoid drift.

## Tagging & Publishing
- Tag with the exact version (e.g. `v1.2.3`) and push tags alongside code.
- Publish only after tests/build pass on the tagged commit; tag *then* publish so the published version matches the tag.
- Register dist-tags for npm (`latest`, `beta`) or use equivalent pre-release channels so consumers control what they upgrade to.
- Never overwrite a published version; range errors or mismatched artifacts break consumers.

## GitHub Releases
- Turn each tag into a release with notes (can be auto-generated from merged PRs or hand-curated from the changelog).
- Attach compiled artifacts/binaries if the project ships any.
- Mark pre-releases when applicable so they are not treated as stable.

## Verification Workflow
1. **Confirm** tests and build are green on the target commit.
2. **Bump** the version (SemVer-aware) and update the changelog.
3. **Tag** and push.
4. **Publish** to the registry, then **verify** the published artifact installs and imports.
5. Draft the **GitHub release** with notes and artifacts.
6. For a **hotfix**, confirm the fix is rebased/merged back to main afterward.