---
name: devops-ci
description: DevOps and CI workflow — Dockerfile multi-stage optimization, GitHub Actions pipeline authoring, container manifest validation, and build/release hygiene. Use when writing or fixing CI/CD, Dockerfiles, or deployment configs.
tools: [read, write, edit, patch, shell, glob, search]
---

# DevOps & CI Skill

## Dockerfile
- Prefer multi-stage builds: a `build` stage producing artifacts, a slim `runtime` stage copying them. Pin base image digests for reproducibility.
- Order layers by change frequency (dependencies before source) to maximize layer cache hits.
- Run as a non-root user; set `EXPOSE` and metadata; avoid pulling secrets into the image (`--mount=type=secret` or build args only for non-secrets).

## GitHub Actions
- Use `actions/checkout@v4` + a pinned setup toolchain for the language. Keep the matrix small and explicit.
- Set `permissions: contents: read` (least privilege) unless a job needs more; never use a token with write scope for read-only steps.
- Cache dependencies (`actions/cache` or the setup tool's native cache) keyed by the lockfile.
- Split long suites into jobs with `timeout-minutes` and `fail-fast: false` for matrix legs.

## Kubernetes / containers
- Validate manifests with `kubectl --dry-run=client -o yaml` or `kubeconform` before apply.
- Set resource requests/limits and readiness/liveness probes on every workload.

## Finish
- Run the pipelining tools available locally (`docker build`, `act`, lint) to verify before claiming the config works.