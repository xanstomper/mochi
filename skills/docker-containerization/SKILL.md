---
name: docker-containerization
description: Docker containerization, multi-stage builds, Docker Compose, container security, and minimal production image optimization.
tools: [read, write, edit, patch, shell, glob, search]
---

# Docker Containerization & Image Optimization Skill

## Multi-Stage Build Pattern
- Separate the build environment (compilers, npm devDependencies, cargo toolchains) from the final minimal production runtime image (Alpine, Debian-slim, Distroless).
- Example:
  ```dockerfile
  # Stage 1: Build
  FROM node:20-alpine AS builder
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  # Stage 2: Production Runtime
  FROM node:20-alpine AS runner
  WORKDIR /app
  ENV NODE_ENV=production
  COPY --from=builder /app/dist ./dist
  COPY --from=builder /app/package*.json ./
  RUN npm ci --omit=dev
  USER node
  EXPOSE 3000
  CMD ["node", "dist/index.js"]
  ```

## Container Security & Best Practices
- Never run containers as root: declare `USER appuser` or use non-root base images.
- Pin base image tags (e.g. `node:20.11-alpine3.19` instead of `node:latest`).
- Use `.dockerignore` to exclude `.git`, `node_modules`, `.env`, and test artifacts from build contexts.
