# Feature Proposal: Multi-Instance Distribution

## Document maturity (non-canonical)

Feature status: `DIST-001` in [the canonical register](../planning/FEATURES.md).

Backlog / proposal. The system runs on a single Node instance per deployment today.

## Problem

Several key subsystems assume a single instance:

- `LlmService` keeps a 5-minute response cache in an in-process `Map` (`packages/backend/src/infrastructure/llm/llm.service.ts:289`). Two instances will duplicate LLM calls and cannot share cache hits.
- There is no instance heartbeat, so a failover/restart cannot tell whether another instance is currently running the orchestrator or a cron.
- While BullMQ queues are already Redis-backed and can be shared, the orchestrator heartbeat and `SessionsService` mutex are local to one process.

This limits horizontal scaling and makes rolling deployments risky.

## Current state

- `llm.service.ts:289` uses `private cache = new Map<string, CachedLlmResponse>()`.
- `sse.service.ts` publishes to Redis `spa:sse` and subscribes; this part is already multi-instance compatible.
- `queue.factory.ts` uses BullMQ with Redis; workers in multiple instances will pick from the same queues.
- `orchestrator.service.ts` writes a heartbeat to `SHARED_REDIS` with key `ORCHESTRATOR_HEARTBEAT_KEY` and TTL, but there is no leader election / fencing token.
- `BrowsingSessionService` uses a static `sessionMutex` (in-process Promise), which only serializes within one process.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/src/infrastructure/llm/llm.service.ts" lines="285-295" />

## Proposed feature

1. **Shared response cache.** Replace the in-process `Map` with a Redis-backed cache (or hybrid: L1 in-process + L2 Redis) keyed by SHA-256 of prompt/system/temperature/maxTokens/model/role. Add `LLM_CACHE_SHARED=true` feature flag.
2. **Instance heartbeat / leader election.**
   - Each instance writes `spa:instance:${hostname}:${pid}` with TTL.
   - Orchestrator only starts if it can acquire a Redis lock (Redlock or `SET NX EX`) with `ORCHESTRATOR_LEADER_KEY`. `WatchdogCron` checks the leader, not just any heartbeat.
   - Same for expensive singletons like `BrowsingSessionService` global mutex (replace static Promise with Redis distributed lock).
3. **Request/session affinity.** If stateful browser contexts are not fully shareable, route posting/engagement jobs to the instance that owns the session, or persist `storageState` and allow any instance to re-acquire.
4. **Metrics per instance.** Add instance ID to traces, logs, and Prometheus metrics to see load distribution.

## Data model / infra changes

No Prisma schema changes. Redis keys:

```
spa:cache:llm:<sha256>  -> JSON { content, usage, model, expiresAt }
spa:instance:<id>       -> { startedAt, version, roles }
spa:leader:orchestrator -> <instanceId>
spa:lock:engagement     -> <instanceId>  // distributed browsing session mutex
```

## Integration points

- `infrastructure/llm/llm.service.ts` — cache abstraction.
- `infrastructure/redis/redis.module.ts` — provide a `RedisCache` helper.
- `modules/orchestrator/orchestrator.service.ts` — leader lock before `runGraphLoop()`.
- `modules/engagement/browsing-session.service.ts` — distributed lock instead of `static sessionMutex`.
- `infrastructure/queue/queue.factory.ts` — already shared; ensure job idempotency works across instances.

## Open questions / risks

- Shared cache increases Redis traffic; keep values compressed and TTL short (5 min).
- Leader election with Redis is not bulletproof in network partitions; acceptable for non-critical orchestration, but critical posting paths should remain queue-based.
- Browser contexts are tied to a process; moving a posting job between instances may require re-login unless `storageState` is robust.
- Need graceful shutdown: release locks and flush cache before exit.

## Effort estimate

**M–L** (2–4 weeks). Leader election and distributed engagement lock are the hard parts; shared LLM cache is relatively straightforward.

## Related reviews

- `infrastructure-llm.md` (cache, concurrency)
- `infrastructure-redis.md`
- `orchestrator.md`
- `engagement.md`
