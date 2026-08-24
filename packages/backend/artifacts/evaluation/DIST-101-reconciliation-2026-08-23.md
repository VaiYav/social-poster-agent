# DIST-101 Multi-instance readiness reconciliation

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c`  
Scope: read-only source/docs/tests inspection; no production, provider, staging, or real Redis-cluster evidence.

## Dirty boundary

The worktree was already dirty before inspection. `git status --short` reported pre-existing edits across docs, planning, README/DEPLOY, backend source/tests, lockfile, and untracked `packages/backend/artifacts/`, telemetry/evaluation/browser files. No existing file was edited, staged, committed, reset, cleaned, or overwritten; this report is the only additive path created by this task.

## Findings table

| Area / proposal claim | Current source and test evidence | Status | Evidence class |
|---|---|---|---|
| Shared LLM response cache | `llm.service.ts` builds `RedisLlmCache` when `LLM_CACHE_SHARED=true` (default), with in-memory fallback only when explicitly false; `llm-cache.ts` uses `spa:cache:llm:<key>` and PX TTL. Focused LLM tests pass, but the Redis implementation was not exercised against a live Redis instance. | ALREADY_FIXED | LOCAL (unit/mocked) |
| Instance heartbeat | `InstanceHeartbeatService` writes `spa:instance:<INSTANCE_ID-or-randomUUID>` JSON containing hostname/pid/beatAt with TTL, renews every interval, and deletes on shutdown. The proposal's exact `spa:instance:${hostname}:${pid}` key and `startedAt/version/roles` payload are not implemented, but uniqueness and liveness are present. No focused heartbeat test found. | SURVIVES (contract differs) | LOCAL (source only) |
| Distributed lock primitive | `DistributedLockService` uses `SET PX NX` random token plus Lua compare-and-delete and compare-and-expire; tracks and releases active locks during shutdown. This is single-Redis-node locking, not Redlock/quorum fencing, and no focused lock tests were found. | SURVIVES | LOCAL (source only); EXTERNAL UNVERIFIED for partition safety |
| Orchestrator leader ownership | `OrchestratorService.start()` acquires `ORCHESTRATOR_LEADER_KEY` before graph construction, renews it, and releases it on stop/error. The exact configured defaults are 30s TTL / 10s renewal. This prevents ordinary duplicate leaders but has no fencing token passed into side effects. | SURVIVES / NEEDS_DECISION | LOCAL (source only); EXTERNAL UNVERIFIED |
| Watchdog / recovery | `WatchdogCron` remains an unconditional `@Cron` every five minutes and checks `ORCHESTRATOR_HEARTBEAT_KEY`; stale recovery now takes a separate Redis owner-token lease and safely releases it, so concurrent watchdog restarts are suppressed. It still lacks full leader/fencing and multi-instance failover evidence. | NEEDS_DECISION | LOCAL source/unit evidence; no multi-instance integration evidence |
| Queue safety | BullMQ queues use shared Redis connection options, per-queue workers, configurable concurrency default 1, and `jobId=postId` for idempotency. Enqueue logic removes terminal/limbo jobs before re-adding and deliberately preserves in-flight/delayed jobs. Queue factory unit tests pass (including dedup/worker behavior), but no two-process integration test was run. | SURVIVES | LOCAL (unit/mocked); INTEGRATION UNVERIFIED |
| Checkpoint/cache separation | `RedisCheckpointSaver` uses `CHECKPOINT_REDIS_URL` when set and different from `REDIS_URL`; otherwise shared Redis. Prefix defaults to `spa:checkpoint`, TTL default is 3600s in source/env validation (some test fixtures use 7 days). Focused checkpoint tests pass, but no live separate Redis verification was run. | ALREADY_FIXED | LOCAL (unit/mocked); INTEGRATION UNVERIFIED |
| Cron/leader ownership | Orchestrator mode dynamically suppresses legacy cron registration, but watchdog remains a permanent cron. Non-orchestrator cron triggers enqueue work; BullMQ is the ownership boundary for queue work. There is no generic instance lease around every cron trigger when orchestrator mode is off. | NEEDS_DECISION | LOCAL (source only) |
| Engagement singleton lock | `BrowsingSessionService` acquires `${ENGAGEMENT_LOCK_KEY}:${network}` through the Redis lock service, derives TTL from session duration plus buffers, and releases in `finally`. This is stronger than the proposal's old static Promise and is network-scoped (X/Threads/Facebook may run concurrently), which differs from the proposal's global key. No focused distributed lock/session test found. | SURVIVES (scope differs) | LOCAL (source only); INTEGRATION/EXTERNAL UNVERIFIED |
| Session affinity / browser ownership | Browser contexts remain process-bound; queue jobs can be consumed by any worker instance and no owner routing/fencing is present. Storage state persistence may allow reacquisition, but cross-instance browser behavior was not tested. | BLOCKED_EXTERNAL | EXTERNAL / MANUAL / production evidence required |
| Metrics per instance | Heartbeat contains instance identity, but this inspection found no proof that all traces/logs/Prometheus metrics carry an instance ID. | UNVERIFIED | LOCAL source search; provider/production unverified |
| Graceful lock/cache shutdown | Distributed locks are released on module destroy; heartbeat is deleted. Redis LLM cache is shared and has no flush requirement, but no live shutdown/lease-expiry test was run. | SURVIVES (partial) | LOCAL (source only) |

## Dependency and readiness verdict

`DIST-101` remains `VERIFY`, not ready. `REL-102` is still `TODO` and is an explicit dependency in `BACKLOG.md`; its missing resilience integration/state-machine evidence cannot be bypassed by this read-only reconciliation. The implementation supports a limited multi-instance topology under a shared single Redis service, but there is no evidence for network partitions, Redis failover/cluster semantics, two-process queue behavior, browser session migration, provider/staging, manual, or production operation.

The highest-priority decision is whether watchdog recovery must itself acquire/renew the orchestrator leader lock (and whether fencing is required for side effects). Next, after REL-102, add bounded two-process/real-Redis integration tests for lock expiry/renewal, leader loss, queue deduplication, checkpoint separation, and watchdog ownership; then perform staging/manual browser and production rollout evidence separately.

## Commands and results

1. `git status --short && git rev-parse HEAD` — exit 0; SHA `f95ff84a4359f209461371d2038d6647bc3ae09c`; dirty boundary recorded above.
2. `npx vitest run tests/unit/llm/llm-service-cache.spec.ts tests/unit/llm/llm-service-routing.spec.ts tests/unit/infrastructure/queue.factory.spec.ts tests/unit/infrastructure/redis-checkpoint.spec.ts tests/unit/checkpoint/redis-checkpoint.spec.ts` from `packages/backend` — exit 0; 5 files, 83 tests passed in 701ms. These are LOCAL unit tests with mocked/fake Redis in relevant fixtures, not live multi-instance evidence.
3. Read-only `rg`, `find`, `sed`, and `nl` source/doc inspection — exit 0; no focused multi-instance lock/heartbeat/leader/watchdog test files found.
