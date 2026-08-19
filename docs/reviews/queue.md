# Module: `modules/queue` + `infrastructure/queue`

## 1. What this module does

The queue subsystem is the bridge between the synchronous API/cron layer and asynchronous browser-automation work. It uses **BullMQ** + **Redis** to process posting jobs per network (`X`, `Threads`, `Facebook`) with concurrency=1, retry policies, delayed scheduling, and a dead-letter queue (DLQ). A separate engagement queue per network handles likes, comments, follows, reposts, quotes, browsing sessions, and scheduled replies.

**Main responsibilities:**
- `QueueFactory` (`infrastructure/queue/queue.factory.ts`) — create/retrieve BullMQ queues, enqueue jobs, register workers, pause/resume, get counts/failed jobs, retry failed jobs, clear completed jobs.
- `QueueModule` (`modules/queue/queue.module.ts`) — wire workers on bootstrap: posting workers invoke `PostingService.postById()`, engagement workers lazily resolve `BrowsingSessionService`, `RepliesMonitorService`, or `EngagementService`.
- `QueueService` (`modules/queue/queue.service.ts`) — thin wrapper exposing queue operations to `QueueController`.
- `QueueController` (`modules/queue/queue.controller.ts`) — REST endpoints for stats, failed jobs, pause/resume, retry-failed, clear-completed.
- `IPostingQueuePort` (`domain/ports/posting-queue.port.ts`) — hexagonal port for enqueuing without circular deps.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `infrastructure/queue/queue.module.ts` | Infra module | `QueueModule` — providers `QueueFactory` + `IPostingQueuePort`, exports both |
| `infrastructure/queue/queue.factory.ts` | BullMQ factory | `enqueuePosting()`, `enqueueEngagement()`, `getQueue()`, `registerWorker()`, `getFailedJobs()`, `getJobCounts()`, `pauseQueue()`, `resumeQueue()`, `isQueuePaused()`, `retryFailedJob()`, `schedulePosting()`, `clearCompletedJobs()`, `clearCompletedAndFailedJobs()`, `getEngagementJob()` |
| `modules/queue/queue.module.ts` | App module (worker wiring) | `QueueModule` — registers posting + engagement workers in `onModuleInit` |
| `modules/queue/queue.service.ts` | Service wrapper | `enqueuePosting()`, `getJobCounts()`, `getFailedJobs()`, `pauseQueue()`, `resumeQueue()`, `isQueuePaused()`, `retryAllFailed()`, `clearCompleted()` |
| `modules/queue/queue.controller.ts` | REST API | `GET /queue/stats`, `GET /queue/:network/stats`, `GET /queue/:network/failed`, `GET /queue/:network/paused`, `POST /queue/:network/pause`, `POST /queue/:network/resume`, `POST /queue/:network/retry-failed`, `POST /queue/:network/clear-completed` |
| `domain/ports/posting-queue.port.ts` | Hexagonal port | `IPostingQueuePort` Symbol + `enqueuePosting()` interface |

## 3. How it works

### 3.1 Queue naming and isolation

- One queue per `(network, action)` pair: `spa-posting-x`, `spa-posting-threads`, `spa-posting-facebook`, `spa-engagement-x`, `spa-engagement-threads`, `spa-engagement-facebook`.
- `concurrency = 1` per queue to serialize actions to a network/account (B9 mitigation).
- Workers use `QueueFactory.registerWorker(network, handler, action)`.

### 3.2 Job idempotency

- `jobId = postId` for posting jobs, `jobId = interactionId` or `browsingSessionId` for engagement.
- BullMQ deduplication caveat: if a job with the same `jobId` already exists in `completed`/`failed`/`delayed` sets, `queue.add()` silently returns the existing job and does **not** re-enqueue.
- `QueueFactory.enqueuePosting()` removes existing `completed`/`failed` jobs before adding a new one with the same `postId`.

### 3.3 Posting worker

`QueueModule.onModuleInit()`:
- Skips registration if `SPA_DRY_RUN=true`.
- For each `SocialNetwork`:
  - `queueFactory.registerWorker(network, async (job) => { const { postId } = job.data; const result = await postingService.postById(postId); ... })`.
  - If `result.success` is false and `result.retryable === false`, the handler resolves (no throw) — avoids wasting the retry budget on terminal failures (disabled network, already failed).
  - Otherwise, it throws `new Error(result.error ?? 'Posting failed')` so BullMQ retries.

### 3.4 Engagement worker

A single handler per network processes all engagement actions:
- `action === 'browsing-session'` → lazily import `BrowsingSessionService` and run `runBrowsingSession()`.
- `action === 'reply'` → lazily import `RepliesMonitorService` and run `postScheduledReply()`.
- `action` in `like|comment|follow|repost|quote` → lazily import `EngagementService` and dispatch.

Lazy `moduleRef.get()` is wrapped in `try/catch` because if a feature flag is off, the service is not registered and `moduleRef.get(..., { strict: false })` throws `UnknownElementException`.

### 3.5 Retry configuration

- **Posting jobs:** `BULLMQ_POSTING_MAX_RETRIES` (default 8), `BULLMQ_POSTING_RETRY_DELAY_MS` (default 120000, exponential 2min → 4min → 8min...).
- **Engagement jobs:** `BULLMQ_MAX_RETRIES` (default 3), `BULLMQ_RETRY_DELAY_MS` (default 60000, exponential 1min → 5min → 15min).
- `QueueFactory` `parseIntEnv()` preserves `0` explicitly (fix for `Number(x) || fallback` treating `0` as falsy).

### 3.6 DLQ / failure alerts

- Worker `failed` event sends a Discord `critical` alert when `attemptsMade >= effectiveMaxRetries`.
- `QueueService.retryAllFailed()` retries all failed jobs in a network queue.
- `QueueController` exposes `POST /queue/:network/clear-completed` to remove completed/failed jobs so BullMQ dedup can be bypassed.

### 3.7 Scheduling / delayed jobs

- `QueueFactory.schedulePosting(postId, network, scheduledAt)` computes `delayMs = scheduledAt - Date.now()` and adds a delayed posting job.
- `enqueuePosting` accepts `delay` for multi-stage thread continuations (used by `PostingService.scheduleMultiStagePosting()`).

## 4. Dependencies

**Downstream (called by queue):**
- `infrastructure/queue` depends on `infrastructure/notifications` (`DiscordNotificationService`) for DLQ alerts.
- `modules/queue` depends on `modules/posting` (`PostingService`) for posting workers.
- `modules/queue` uses `ModuleRef` to lazily resolve `BrowsingSessionService`, `RepliesMonitorService`, `EngagementService`.
- `infrastructure/redis` — `IORedis` for connections.
- `bullmq` — queues and workers.

**Upstream (callers of queue):**
- `modules/posting` `postById()` returns `PostResult` to the worker.
- `modules/posts` `approve()` may inject `IPostingQueuePort` to enqueue posts.
- `modules/engagement` `BrowsingSessionService` / `EngagementService` can enqueue engagement jobs.
- `modules/replies` `RepliesMonitorService` can enqueue reply jobs.
- `modules/posting` `scheduleMultiStagePosting()` enqueues via `QueueFactory`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `REDIS_URL` | `redis://localhost:6381` | `queue.factory.ts:53` | Redis for BullMQ |
| `BULLMQ_MAX_RETRIES` | `3` | `queue.factory.ts:57` | Engagement retry budget |
| `BULLMQ_RETRY_DELAY_MS` | `60000` | `queue.factory.ts:58` | Engagement retry base delay |
| `BULLMQ_POSTING_MAX_RETRIES` | `8` | `queue.factory.ts:60` | Posting retry budget |
| `BULLMQ_POSTING_RETRY_DELAY_MS` | `120000` | `queue.factory.ts:61` | Posting retry base delay |
| `BULLMQ_QUEUE_PREFIX` | `spa` | `queue.factory.ts:62` | Queue name prefix |
| `BULLMQ_CONCURRENCY_PER_QUEUE` | `1` | `queue.factory.ts:64` | Worker concurrency |
| `SPA_DRY_RUN` | `false` | `packages/backend/src/modules/queue/queue.module.ts:44` | Skip worker registration in dry-run mode |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `QueueFactory` creates a new `IORedis` connection for every `registerWorker` call**
- `getConnectionOpts()` always creates `sharedClient` and `sharedSubscriber` lazily, but the `createClient` callback returns a new `IORedis` for each `bclient`. `QueueFactory.registerWorker` is called per network (and per action) at startup. Each `Worker` creates `bclient` connections. If the same `queueFactory` instance is used, `sharedClient`/`sharedSubscriber` are reused, but `bclient` is new per worker. This is by design (BullMQ requires blocking clients per queue), but the comment about 6 queues + 6 workers = ~15 connections may be outdated if `BullMQ` internally creates more. Redis connections are not tracked/leaked? `onModuleDestroy` closes workers and queues. Good.

**B2. `QueueFactory` `sharedClient` / `sharedSubscriber` are created lazily and never closed if `createClient` throws before creation**
- `onModuleDestroy` checks and closes them. Fine.

**B3. `QueueFactory.enqueuePosting` removes existing `completed`/`failed` jobs, but not `delayed` jobs**
- `queue.getJob(postId)` can return a `delayed` job. If a delayed job exists, `getJob` returns it. `state` would be `delayed`, not `completed`/`failed`, so it is not removed. Then `queue.add()` with same `jobId` will return the delayed job, not create a new one. This is a bug for multi-stage thread continuations: if the same continuation ID is scheduled twice (e.g., operator clicks schedule twice), the second `enqueuePosting` will silently return the existing delayed job and not update the delay. **Risk: duplicate scheduling is silently ignored.**

**B4. `QueueFactory` `clearCompletedAndFailedJobs` only removes completed/failed, not delayed jobs**
- Same concern as B3. `clearCompleted` endpoint won't clear delayed duplicates.

**B5. `QueueModule` `onModuleInit` creates `sharedClient`/`sharedSubscriber` via `getConnectionOpts()` but also calls `QueueFactory` methods on worker creation without explicitly checking Redis connection**
- `Worker` creation will trigger `createClient` which uses `sharedClient`/`sharedSubscriber`/`bclient` connections. If Redis is down, `onModuleInit` may fail. Good to fail fast.

**B6. `QueueModule` worker handler catches `result.retryable === false` and returns, but does not update `post` status**
- If `postById` returns `{ success: false, retryable: false, error: ... }`, `postById` already updated the post to `FAILED` (or kept `POSTING` in some cases). The worker simply returns. Good. But the worker does not log `result.error` for `retryable: false`? It logs `Post ${postId} failed permanently (non-retryable): ${result.error}`. Good.

**B7. `QueueService.retryAllFailed` calls `queueFactory.retryFailedJob` for each failed job sequentially, but `retryFailedJob` can throw if the job is not in failed state (race)**
- `queue.service.ts:49` `try { await this.queueFactory.retryFailedJob(network, job.id); retried++; } catch { ... }`. It catches. Good.

**B8. `QueueController.getFailed` returns raw BullMQ `Job` objects, which may expose internal data**
- `queue.service.ts:27` `getFailedJobs` returns `queue.getFailed()` which returns `Job[]` objects. These are serialized to JSON. They may contain `data`, `opts`, `failedReason`, `attemptsMade`, `stacktrace`, `timestamp`. `data` includes `postId` and `network`. No sensitive data (storageState, credentials) is in job data for posting. But engagement jobs include `commentDbId`, `postUrl`, `replyText`, `text`, `handleOrUrl` (for `follow` action). `handleOrUrl` could be a private URL. Not critical, but `getFailed` endpoint should sanitize or limit fields.

**B9. `QueueController.getAllStats` uses `Promise.all` over `getJobCounts` and `isQueuePaused` for each network, but `getJobCounts` uses `queue.getJobCounts(...)` which is a single Redis command, and `isQueuePaused` is `queue.isPaused()` (also Redis). Fine, but `getAllStats` is hardcoded to `[X, THREADS, FACEBOOK]` ignoring `ENABLED_NETWORKS`**
- It will still return counts for disabled networks (the queues may be empty). Minor.

**B10. `QueueFactory` `getQueue` for `action` `'engagement'` and `network` creates a queue with lower-case network, but `PostingService.scheduleMultiStagePosting` enqueues via `queueFactory.enqueuePosting` which uses `network.toLowerCase()`?**
- `queue.factory.ts:163` `queueName = `${this.queuePrefix}-${action}-${network.toLowerCase()}``. `enqueuePosting` (line 180) calls `getQueue(network, 'posting')`. `network` is passed as `rootPost.network` (enum value) from `posting.service.ts:695`, which is `SocialNetwork.X` etc. `toLowerCase()` works. Good.

**B11. `QueueModule` `onModuleInit` registers `Worker` for all networks, but if `SPA_DRY_RUN` is true, it skips registration and no worker exists. The `QueueService` is still available and `QueueController` still works. `enqueuePosting` calls `getQueue` which creates queues lazily. But `getQueue` creates a `Queue` object even if no worker exists.**
- In dry-run, the orchestrator may not start workers. The `dry-run` runner likely calls `postById` directly. `QueueController` endpoints can still query and manage empty queues. Fine.

**B12. `QueueFactory` `parseIntEnv` uses `configService.get<string>(key)` and then `Number(raw)`. If `raw` is `'0'`, it returns `0`. `Math.max(1, this.parseIntEnv('BULLMQ_CONCURRENCY_PER_QUEUE', 1))` clamps to at least 1.**
- `parseIntEnv('BULLMQ_CONCURRENCY_PER_QUEUE', 0)` would return 0, but `Math.max(1, ...)` ensures 1. Good.

**B13. `QueueFactory.enqueueEngagement` uses `jobId: interactionId` and does not remove existing completed/failed jobs before adding**
- `queue.add()` with existing `completed`/`failed` `jobId` will silently return the old job, not re-enqueue. For engagement actions like `browsing-session` (jobId is fixed per 4h window), this is why `clearCompletedAndFailedJobs` exists. But `enqueueEngagement` itself does not call `clearCompletedAndFailedJobs`. It relies on callers (e.g., `BrowsingSessionService`) to clear before re-enqueue. This is not a bug if callers know, but it is a footgun.

**B14. `QueueModule` worker handler `job.data` type is cast multiple times with `as`**
- `packages/backend/src/modules/queue/queue.module.ts:53` `job.data as { postId: string }` and `packages/backend/src/modules/queue/queue.module.ts:77` `job.data as { action: string; ... }`. No runtime validation. If a job is malformed, the handler may throw `undefined` access errors. Better to use Zod or a guard. But the enqueue side is controlled.

**B15. `QueueFactory` `getEngagementJob` returns `Job | undefined` but `job.getState()` may not be atomic with decision**
- This is used by `replies-monitor` to avoid re-enqueueing a reply already in flight. The job may be `completed` between `getEngagementJob` and the next check. Acceptable race window.

**B16. `QueueFactory` `onModuleDestroy` calls `worker.close()` and `queue.close()` but does not clear `queues`/`workers` maps**
- `queues` and `workers` maps remain closed objects. If anything calls `getQueue` after close, it returns the closed queue. Minor for shutdown.

**B17. `QueueFactory` `getConnectionOpts` does not pass `connection` string? It uses `connection: { url: this.redisUrl }` plus `createClient`**
- The `connection: { url: this.redisUrl }` is probably used by BullMQ for default `client`/`subscriber`/`bclient` when `createClient` is not called? No, `createClient` always overrides. The `connection` field is redundant if `createClient` is provided. It may also cause BullMQ to create extra connections. But `createClient` is used. The `connection` object is passed as part of `QueueOpts` and might be used for URL validation. Not a bug.

### 6.2 Performance

**P1. `QueueFactory` creates a new `IORedis` `bclient` for each `Worker` and each `Queue`**
- `getQueue` creates a `Queue` with `getConnectionOpts()`. Each `Queue` uses `createClient` for `client`, `subscriber`, `bclient`. For `bclient`, it returns a new `IORedis`. So each queue creates a `bclient`. `getQueue` is called for every `enqueue` and `getJobCounts`. If `getQueue` creates a new `Queue` each time, it may create many `bclient` connections. But `getQueue` caches queues in `this.queues` map. So `Queue` objects are reused. `Worker` registration also creates `bclient` for each worker. Good.

**P2. `QueueService.getFailedJobs` returns full `Job` objects (could be large if `data` is large)**
- For engagement jobs with `replyText`/`text` (post content), each job is small. But `getFailed` can return many jobs. `QueueController.getFailed` has no pagination. If there are 500 failed jobs, this could be a large JSON response. `removeOnFail: { count: 500 }` keeps 500, so max 500. Fine.

**P3. `QueueController.getAllStats` makes 6 Redis calls sequentially per network (2 calls × 3 networks = 6 calls)**
- `getJobCounts` and `isQueuePaused` per network. `Promise.all` runs them in parallel per network, but `getJobCounts`/`isQueuePaused` are sequential inside each iteration. They could be parallelized: `const [counts, paused] = await Promise.all([...])`. Minor.

**P4. `QueueFactory.clearCompletedAndFailedJobs` loads all completed and failed jobs into memory and removes them one by one**
- `queue.getCompleted()` and `queue.getFailed()` can return thousands of jobs. For `removeOnComplete: { count: 100 }`, completed set is limited to 100, but failed can be 500. `removeOnFail: { count: 500 }`. So max ~600. Acceptable.

**P5. `QueueFactory` `Worker` lock duration for engagement is 5 minutes (`engagementLockDurationMs = 5 * 60 * 1000`)**
- BullMQ auto-renews lock while worker is alive. If worker crashes, 5-minute lock is good. But if the browsing session is 15+ minutes, lock renewal must happen. The comment says "lock is auto-renewed". Good.

**P6. `QueueFactory` `parseIntEnv` is duplicated for every `QueueFactory` instantiation**
- `QueueFactory` is a singleton in `QueueInfraModule`, so only once.

### 6.3 Architecture / anti-patterns

**A1. `QueueModule` in `modules/queue` depends on `PostingModule` and also uses lazy `moduleRef.get()` for engagement services**
- `QueueModule` imports `PostingModule` to get `PostingService`. This is a close coupling. A port-based approach (`IPostingPort` or `IWorkerHandler`) would decouple. But worker registration by design needs concrete handlers. The lazy `moduleRef.get()` for engagement is a workaround for feature-flagged modules. This is acceptable but not ideal.

**A2. `QueueModule` worker handles both posting and engagement actions in one `registerWorker` call with a large `if/else` chain**
- `queue.module.ts` worker handler for engagement has 4 branches and a `switch` inside. This violates SRP. Consider separate `PostingWorker`, `BrowsingSessionWorker`, `RepliesWorker`, `EngagementActionWorker` classes, each registered via a strategy map.

**A3. `QueueService` is just a pass-through to `QueueFactory` for most methods**
- `QueueService` adds no business logic. It exists to provide `QueueController` with a service. This is fine but could be folded into `QueueFactory`/`QueueController` directly. However, the controller → service → factory layering is common.

**A4. `QueueFactory` mixes queue management, worker registration, job scheduling, and DLQ alerting**
- This is a lot, but it is a factory. It has 442 lines. Acceptable.

**A5. `QueueModule` is named `QueueModule` but `infrastructure/queue/queue.module.ts` is also `QueueModule` — two `QueueModule` classes in different directories**
- `modules/queue/queue.module.ts` imports `QueueModule as QueueInfraModule` to avoid conflict. This is a naming smell. Consider renaming one to `QueueWorkersModule` or `QueueInfraModule`.

**A6. `IPostingQueuePort` is a port but `QueueFactory` is not injected through the port into `QueueModule` workers**
- `QueueModule` uses `PostingService` directly. The port is only for `PostsController` to avoid cycle. Fine, but the posting worker should also go through a port if hexagonal is strict.

**A7. `QueueModule` skips registration when `SPA_DRY_RUN=true` but `QueueFactory` is still instantiated and `QueueService` can still enqueue jobs**
- If `SPA_DRY_RUN=true` and someone calls `enqueuePosting`, it will create queues and jobs, but no workers will process them. This is contradictory: dry-run should probably not enqueue jobs. It is mitigated by `postById` being called directly in dry-run mode, but `approve()` may still enqueue. Check `posts.service.ts` approve path.

### 6.4 TypeScript / type safety

**T1. `QueueFactory` `getQueue` returns `Queue` but the queue is typed as `any` for `Job`**
- BullMQ `Queue` is generic. `QueueFactory.getQueue` is not typed. Fine.

**T2. `QueueModule` worker handler `job.data` casts are unsafe**
- As noted in B14, no validation. If a bad job is enqueued, handler will throw.

**T3. `QueueService` uses `SocialNetwork` enum from `@prisma/client` but does not import it?**
- `queue.service.ts` line 3 `import { SocialNetwork } from '@prisma/client';` — good.

**T4. `QueueController` `ParseEnumPipe` handles enum validation, but `SocialNetwork` enum values are `X`, `THREADS`, `FACEBOOK` and pipe is `ParseEnumPipe` — this works**
- Good.

### 6.5 Security / reliability

**S1. `QueueController` `POST /queue/:network/retry-failed` and `clear-completed` are admin operations without explicit admin guard**
- If `AUTH_ENABLED` is true, global `JwtAuthGuard` protects all. If `false`, pass-through. No role check. Could be a problem if admin wants to restrict to operators. Since `AUTH_ENABLED` default is false, in production with VPN, it may be okay. But if `AUTH_ENABLED` is true, any logged-in user can retry/clear queues.

**S2. `QueueController` `getFailed` may expose stack traces in `Job` objects**
- BullMQ `Job` `stacktrace` may include stack traces from `Error` objects. These could contain internal paths or sensitive info. Should sanitize response.

**S3. `QueueFactory` `getQueue` can create queues with arbitrary `network` if called directly**
- `getQueue` accepts `network: string`. If a malicious caller uses `QueueController` (which validates), it is fine. But `QueueFactory` is exported and can be called with arbitrary strings, creating queues like `spa-posting-foo`. Not a security issue but a misuse risk.

**S4. `QueueFactory` `clearCompletedAndFailedJobs` is called by `clearCompleted` endpoint but could remove failed jobs that the user wanted to retry later**
- The endpoint is explicit. Acceptable. But `clearCompleted` endpoint name suggests only completed, but it actually removes completed **and** failed. The controller returns `cleared` count without distinguishing. Misleading.

**S5. `QueueFactory` `onModuleDestroy` does not wait for active workers to finish before closing**
- `worker.close()` with `false`? The code `await worker.close()` without options. BullMQ `Worker.close()` default is `graceful`? Actually `Worker.close()` by default waits for active jobs? Let me check: BullMQ `worker.close()` signature is `close(force?: boolean)`. Without args, it defaults to `false` (graceful). It waits for active jobs to finish. Good.

**S6. `QueueModule` `onModuleInit` registers workers and `queueFactory.onModuleInit()` is also called?**
- `QueueFactory` has `onModuleInit` and `onModuleDestroy`. It logs config. `QueueModule` imports `QueueInfraModule` which provides `QueueFactory`. `QueueFactory` is `OnModuleInit`, so Nest calls `onModuleInit`. Then `QueueModule` also has `onModuleInit` for worker registration. Good. But `QueueModule` does not call `super.onModuleInit`? It's not a parent class. Good.

**S7. `QueueFactory` `schedulePosting` uses `BULLMQ_MAX_RETRIES` and `BULLMQ_RETRY_DELAY_MS` for scheduled posting, not `BULLMQ_POSTING_*`**
- `queue.factory.ts:283-309` `schedulePosting` uses `this.maxRetries` and `this.retryDelayMs` (general) instead of `postingMaxRetries`/`postingRetryDelayMs`. This is inconsistent with `enqueuePosting` and may cause scheduled posts to get fewer retries/shorter delays. **Bug or inconsistency.**

## 7. New feature / improvement ideas

**F1. Add `POST /queue/:network/retry-job/:jobId` (single job retry)**
- `retryAllFailed` is coarse. Single job retry is useful for UI.

**F2. Add `GET /queue/:network/job/:jobId` (inspect job state)**
- Useful for ops.

**F3. Sanitize `getFailed` response to exclude `data`/`stacktrace` or return DTO**
- Security/UX improvement.

**F4. Use typed `Job` data and validate with Zod in worker handlers**
- Add `PostJobDataSchema` and `EngagementJobDataSchema`.

**F5. Add `QueueEventService` for SSE events on queue changes**
- Currently UI must poll `GET /queue/stats`. SSE could push updates.

**F6. Add queue health checks and auto-retry for failed jobs**
- `health-monitor` could retry failed jobs or alert if queue is stalled.

**F7. Fix `schedulePosting` to use posting retry config**
- Ensure scheduled posts get `postingMaxRetries` and `postingRetryDelayMs`.

**F8. Clear delayed jobs in `enqueuePosting` and `clearCompleted` endpoint**
- Fix dedup issue for delayed jobs.

**F9. Add `retry-failed` with filter by age / error pattern**
- Don't retry all failed jobs blindly; only retry recent or network/session errors.

**F10. Add metrics and alerting for queue depth, oldest delayed job, failed count, retry rate**
- Feed `analytics` module.

**F11. Separate `QueueWorkersModule` from `QueueInfraModule` naming**
- Rename `modules/queue` module to `QueueWorkersModule`.

**F12. Add `IPostingWorkerPort` so `QueueModule` doesn't import `PostingModule`**
- `PostingService` implements a `IPostingWorker` interface; `QueueModule` injects the port.

**F13. Add job dedup for engagement actions with composite keys**
- For `reply` and `browsing-session`, use a composite jobId that includes timestamp/window to avoid dedup collisions.

**F14. Add `QueueService` `pauseAll` / `resumeAll` endpoints**
- Useful for crisis mode.

## 8. Cross-references

- `modules/posting` — `postById()` called by worker.
- `modules/posts` — `approve()` enqueues via `IPostingQueuePort`.
- `modules/engagement` — `BrowsingSessionService`, `EngagementService` used by engagement worker.
- `modules/replies` — `RepliesMonitorService` used by engagement worker.
- `infrastructure/notifications` — `DiscordNotificationService` for DLQ alerts.
- `infrastructure/redis` — Redis connections.
- `modules/health-monitor` — could monitor queue depth/failed jobs.
- `docs/audit/*.md` — prior reliability audit mentions queue dedup and retry.

## 9. Overall assessment

- **Health**: 7/10. The queue subsystem is well-structured, uses BullMQ correctly, and has good retry/DLQ/alerting. The port `IPostingQueuePort` is a good architectural decision.
- **Biggest strengths**: per-network concurrency=1, idempotent jobId, automatic retry, Discord DLQ alerts, lazy module resolution for feature flags, `parseIntEnv` preserves `0`.
- **Biggest risks**: delayed jobs not removed before re-enqueueing can cause duplicate scheduling to be ignored; `schedulePosting` uses general retry config instead of posting config; `getFailed` exposes raw `Job` objects; `SPA_DRY_RUN` workers skipped but `QueueService` still active; worker handler is a large `if/else` chain.
- **Recommended next actions**:
  1. Fix `enqueuePosting` to also remove delayed jobs with the same `jobId`.
  2. Fix `schedulePosting` to use `postingMaxRetries` and `postingRetryDelayMs`.
  3. Sanitize `QueueController.getFailed` output.
  4. Refactor `QueueModule` worker handler into per-action handler classes.
  5. Rename one of the `QueueModule` classes to avoid confusion.
