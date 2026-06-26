# ADR-002: BullMQ for Job Queue

**Status:** Accepted  
**Date:** 2026-07-15  
**Decider:** Valentyn Yakovliev

## Context

The posting pipeline needs a job queue for:
- Retry with exponential backoff (browser automation can fail transiently)
- Rate limiting (1 post/day per network)
- Dead letter queue (DLQ) for permanently failed jobs
- Priority scheduling (approved posts → posting queue)

## Decision

Use **BullMQ** (Redis-based job queue for Node.js).

## Rationale

- Built on Redis — already in our stack for rate limiting and SSE
- First-class TypeScript support
- Exponential backoff, priority queues, job dependencies
- Dashboard via Bull Board
- Active maintenance, large community
- NestJS integration via `@nestjs/bullmq`

## Consequences

**Positive:**
- Reliable retry mechanism for flaky browser automation
- Rate limiting integration with Redis sliding window
- DLQ for manual intervention on permanently failed posts
- Job events → SSE → real-time UI updates

**Negative:**
- Redis is a single point of failure (mitigated by Redis persistence)
- No built-in cron (use `@nestjs/schedule` for cron → BullMQ enqueue)
- Memory usage for large queues

## Alternatives Considered

1. **In-process queue** — no retry, no persistence, lost on crash
2. **RabbitMQ** — heavier, separate service, overkill for single-server
3. **AWS SQS** — cloud lock-in, latency, cost
4. **Celery (Python)** — different language, unnecessary complexity

## References

- [BullMQ docs](https://docs.bullmq.io/)
- CONSTITUTION §8: "Queue = BullMQ + Redis"
