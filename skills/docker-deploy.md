---
name: docker-deploy
description: Dockerization and deployment workflow covering multi-stage Dockerfiles, layer caching, compose, health checks, reverse proxying, and CI/CD deploys to a VPS or cloud. Use when containerizing an app or setting up a deploy path.
tools:
  - shell
  - write
  - edit
  - read
---

# Docker Deploy & Containerization Skill

## When to Use
- Containerizing an existing service for local dev or deployment.
- Writing or reviewing a Dockerfile and docker-compose setup.
- Standing up health checks, reverse proxy, and a CI/CD deploy pipeline.

## Dockerfile Best Practices
- **Multi-stage builds:** build in one stage, copy only the artifacts/`node_modules`/runtime into a slim final stage. Example shape for Node:
  ```dockerfile
  FROM node:22-alpine AS build
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  FROM node:22-alpine
  ENV NODE_ENV=production
  WORKDIR /app
  COPY --from=build /app/package*.json ./
  COPY --from=build /app/dist ./dist
  RUN npm ci --omit=dev
  EXPOSE 8080
  USER node
  CMD ["node", "dist/index.js"]
  ```
- **Leverage layer caching:** copy dependency manifests (`package*.json`, `go.mod`, `requirements.txt`) and run install *before* copying source, so dependency layers cache across builds.
- **Pin base image digests** (or at least major tags) for reproducible builds; do not use bare `latest`.
- **Run as a non-root user**, drop capabilities, and set `WORKDIR` + `EXPOSE` explicitly.
- **Keep images small:** use distroless/alpine, multi-stage, and prune dev tooling and caches.

## Docker Compose
- Define services with explicit **resource limits** (`deploy.resources.limits`) for shared hosts.
- **Order dependencies** with `depends_on` plus a real healthcheck-based condition (`service_healthy`) rather than a bare wait.
- Mount secrets/config via environment files or Docker secrets, never commit `.env`.
- Persist only what must survive restarts via named volumes; keep the FS data ephemeral.

## Health Checks
- Add a `HEALTHCHECK` directive and expose a `/_health` endpoint that reflects readiness (DB connected, cache reachable), not just process liveness.
- Configure `restart: unless-stopped` plus a `start_period` so one-shot startup hiccups don't flap the container.

## Reverse Proxy (nginx / caddy / traefik)
- Terminate TLS at the proxy and forward to the app on a private port.
- Set correct `Host` and real client IP headers (`X-Forwarded-For`, `X-Real-IP`) for app logging and rate limiting.
- Add gzip/brotli and sensible timeouts; enable `proxy_read_timeout` for streaming endpoints.

## CI/CD Deploy Pipeline (GitHub Actions example)
1. Build and **cache** the image with a content-based tag (`git-sha` + date).
2. Run lint + tests in CI *before* building the image.
3. Push to a registry (`ghcr.io`/ECR).
4. Deploy via SSH to a VPS (`docker compose up -d --pull=always`) or to the cloud provider's run service.
5. Verify the health endpoint after deploy and roll back on failure.

## Deployment Workflow
1. **Read** the app's runtime needs (ports, env, persistent data) and write the Dockerfile.
2. **Compose** the stack with health checks, volumes, and secrets.
3. **Run** it locally to confirm it boots and passes the health check.
4. **Push** the image and apply on the target host.
5. **Verify** the running container's logs and health endpoint; confirm auto-restart and reversibility before calling it done.