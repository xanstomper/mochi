---
name: api-design
description: REST, GraphQL, tRPC, and OpenAPI API design, schema validation, idempotency, rate limiting, and backwards compatibility patterns.
tools: [read, write, edit, patch, glob, search]
---

# API Design & Schema Engineering Skill

## REST & HTTP Conventions
- **Resource-Oriented URIs:** Use plural nouns (`/api/v1/users`, `/api/v1/projects/:id/tasks`).
- **Standard HTTP Methods & Status Codes:**
  - `GET` (200 OK, 404 Not Found) - Safe, idempotent.
  - `POST` (201 Created with `Location` header, 400 Bad Request, 422 Unprocessable).
  - `PUT` (200 OK / 204 No Content) - Full replacement, idempotent.
  - `PATCH` (200 OK) - Partial update.
  - `DELETE` (204 No Content / 200 OK) - Idempotent.
- **Consistent Error Response Envelopes:**
  ```json
  {
    "ok": false,
    "error": {
      "code": "INVALID_ARGUMENT",
      "message": "Field 'email' must be a valid email address.",
      "details": [{ "field": "email", "issue": "format" }]
    }
  }
  ```

## Schema Validation & Type Safety
- Validate all incoming request payloads at the system boundary using Zod, Pydantic, Joi, or JSON Schema.
- Provide end-to-end type safety (e.g. tRPC or OpenAPI client generation).
