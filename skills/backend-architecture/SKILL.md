---
name: backend-architecture
description: Backend service architecture, distributed systems, event-driven designs, caching strategies, message queues, and reliability engineering.
tools: [read, write, edit, patch, shell, glob, search]
---

# Backend Systems Architecture Skill

## Core Architectural Patterns
- **Layered Architecture:** Controller/Handler -> Service/Domain Logic -> Repository/Data Access.
- **Event-Driven Architecture:** Use asynchronous message queues (RabbitMQ, Kafka, SQS, Redis Pub/Sub) to decouple long-running side effects (emails, notifications, transcoding) from hot HTTP request paths.
- **Idempotency & Retry Guarantees:** Implement idempotency keys for mutating operations to ensure safe retries over unreliable networks.

## Resilience & High Availability
- **Circuit Breakers & Timeouts:** Wrap all downstream external RPCs/APIs with strict timeouts and circuit breakers to prevent cascading system failure.
- **Rate Limiting & Throttling:** Implement Token Bucket or Leaky Bucket algorithms per IP / User ID.
- **Database Connection Pooling:** Configure max connections, idle timeouts, and statement timeouts to avoid database thread exhaustion.
