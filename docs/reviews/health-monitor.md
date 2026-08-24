# Module: `modules/health-monitor`

## 1. What this module does

`modules/health-monitor` is the operational heart of the F21 feature: an hourly cron that detects account bans, expired sessions, failed posts, queue dead-letter jobs, stuck posts, and stuck browsing sessions. It can also trigger reconciliation (re-enqueueing orphaned `APPROVED` posts) and is a separate concern from the simple `/health` liveness probe.

**Main responsibilities:**
- `HealthMonitorService` — cron-driven health checks, reconciliation, reapers, ban recovery.
- `HealthMonitorController` — dashboard, manual trigger endpoints.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `health-monitor.module.ts` | NestJS module | `HealthMonitorModule` — imports `PrismaModule`, `SseModule`, `ScheduleModule`, `QueueModule`, `QueueInfraModule` |
| `health-monitor.service.ts` | Core service | `onModuleInit()`, `runHealthCheck()`, `getDashboard()`, `runReconciliation()`, `reapStuckPosting()`, `reapStuckBrowsingSessions()`, `checkBanRecovery()`, `recoverBannedSessions()` (and private `checkSessionHealth`, `checkPostHealth`, `checkQueueHealth`) |
| `health-monitor.controller.ts` | REST API | `GET /health-monitor/dashboard`, `POST /health-monitor/check`, `POST /health-monitor/reconcile` |

## 3. How it works

### 3.1 Cron registration (`onModuleInit`)

- Skips all crons if `SPA_DRY_RUN=true` or `ORCHESTRATOR_ENABLED=true`.
- Registers `health-monitor` cron (default `0 * * * *`) → `runHealthCheck()`.
- Registers `reconciliation` cron (default `30 * * * *`) → `runReconciliation()` + `reapStuckPosting()`.
- On startup, runs `reapStuckBrowsingSessions()` to clear `ACTIVE` browsing sessions left by a crash.

### 3.2 `runReconciliation()`

- Loads up to 1000 `APPROVED` posts ordered by `approvedAt desc`.
- For each post older than 10 minutes, checks if a BullMQ job exists in `active`/`waiting`/`delayed` for that `postId`.
- If no existing job, enqueues via `queueService.enqueuePosting()`.
- Emits SSE `reconciliation_requeue`.
- Returns `{ requeued, skipped, deduplicated }`.

### 3.3 `reapStuckPosting()`

- Loads `POSTING` posts with `approvedAt < (now - STUCK_POSTING_GRACE_MIN)`.
- Checks BullMQ job state. If no active/waiting/delayed job, marks post `FAILED` with a warning message.
- Emits SSE and Discord warning.
- Does not auto-re-enqueue (avoid duplicate posts).

### 3.4 `reapStuckBrowsingSessions()`

- Loads `ACTIVE` browsing sessions with `startedAt < (now - sessionDuration - 3min - 5min)`.
- Marks them `FAILED` and sets `endedAt`.

### 3.5 `runHealthCheck()`

- Parallel `checkSessionHealth()`, `checkPostHealth()`, `checkQueueHealth()`.
- `checkSessionHealth` counts **consecutive** `FAILED` posts (P1-4) for each account in the last 24h. If `>= HEALTH_MONITOR_BAN_THRESHOLD`, marks session `BANNED`.
- `checkPostHealth` counts `FAILED`, `POSTING`, `DRAFT`, `APPROVED`, and stuck `POSTING` (>30 min, using `approvedAt` — P1-5).
- `checkQueueHealth` aggregates failed/active/waiting counts across all queues.
- Generates `alerts` array with `critical`/`warning`/`info` severities and emits **all** of them via SSE; Discord only receives `critical` and `warning` (`info` is SSE-only, e.g., ban-lifted notifications from `checkBanRecovery`).

### 3.6 `getDashboard()`

- Calls `runHealthCheck()` and computes a summary.

### 3.7 `checkBanRecovery()` / `recoverBannedSessions()`

- If a `BANNED` session is >24h old and has no recent `FAILED` posts, reactivates it to `ACTIVE`.
- Uses `session.createdAt` to compute ban age rather than `updatedAt` or a dedicated `bannedAt` field — a bug because an old session banned recently is reactivated immediately. See finding B15.

## 4. Dependencies

**Downstream:**
- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/sse` — `SseService`.
- `infrastructure/notifications` — `DiscordNotificationService`.
- `modules/queue` — `QueueService` and `QueueFactory`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.
- `infrastructure/config` — `parseBool`.

**Upstream:**
- `modules/health-monitor` is a top-level controller. No other module calls it.
- UI — `HealthMonitorController`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `SPA_DRY_RUN` | `false` | `onModuleInit` | Skip cron registration |
| `ORCHESTRATOR_ENABLED` | `false` | `onModuleInit` | Skip cron registration |
| `HEALTH_MONITOR_SCHEDULE` | `0 * * * *` | `onModuleInit` | Health check cron |
| `RECONCILIATION_SCHEDULE` | `30 * * * *` | `onModuleInit` | Reconciliation cron |
| `HEALTH_MONITOR_BAN_THRESHOLD` | `5` | constructor | Consecutive failures to flag BANNED |
| `STUCK_POSTING_GRACE_MIN` | `5` | constructor | Grace before reaping POSTING |
| `F1_BROWSING_SESSION_MINUTES` | `15` | `reapStuckBrowsingSessions` | Browsing session duration |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `HealthMonitorService` `runReconciliation` uses `Promise.all` over 1000 posts in parallel**
- `health-monitor.service.ts:125-173` maps all `approvedPosts` into an async function and calls `Promise.all`. This creates 1000 concurrent `queue.getJob` + `getState` + `enqueuePosting` calls. This can overwhelm Redis and BullMQ. Should batch or limit concurrency.

**B2. `HealthMonitorService` `runReconciliation` checks `post.approvedAt` but `approvedAt` may be null for APPROVED posts? No, `approve` sets `approvedAt`. `prisma.post.create` with status `APPROVED` (e.g., from auto-approve) also sets `approvedAt`. Good. But the fallback `post.approvedAt ?? post.createdAt` uses `createdAt` if null. Good.**

**B3. `HealthMonitorService` `runReconciliation` checks `stuckSince > tenMinAgo` and skips. But `stuckSince` is `approvedAt` or `createdAt`, and `tenMinAgo` is `Date.now() - 10min`. If `approvedAt` is recent, skip. Good. But if `approvedAt` is null and `createdAt` is more than 10 min ago, it will re-enqueue. If `createdAt` is DRAFT creation time and the post was recently approved but `approvedAt` not set, it could re-enqueue too early. But `approvedAt` should be set by `approve`. Good.**

**B4. `HealthMonitorService` `runReconciliation` uses `queue.getJob(post.id)` and `job.getState()`. If the job is `completed` (failed), it is re-enqueued. `getState` returns `failed` or `completed`. The condition is `state === 'active' || state === 'waiting' || state === 'delayed'`. If `state` is `failed` or `completed`, it will re-enqueue. This is good because a failed post may still be APPROVED and not yet retried. But a `completed` post means the post was posted successfully; the status should be `POSTED`, not `APPROVED`. If status is `APPROVED` and job is `completed`, the post might have been posted but status not updated (crash). Re-enqueueing could cause duplicate post. But `PostingService` should set `POSTING` then `POSTED`. If it crashed after `POSTED` but before status update, the post is APPROVED but actually posted. Re-enqueueing is risky. However, this is a known edge case and the comment says "deduplication" only for active/waiting/delayed. The reconciliation is inherently unsafe for completed-but-not-updated posts. The `reapStuckPosting` does not re-enqueue. Good. Reconciliation should also not re-enqueue if `job.state === 'completed'`. But it may be `failed` and should retry. If `completed`, we should check the post status or not re-enqueue. The current logic is risky. But it only loads APPROVED posts. If a job is completed and the post is still APPROVED, the status update failed. We could re-enqueue, but duplicate post. Better to mark as FAILED and let human verify. Hmm. The current code re-enqueues. This is a bug in the `completed` state. `failed` state is fine to retry. `completed` state should not retry. But maybe the job is `completed` but the post is not `POSTED` due to a bug. Then re-enqueueing may be the only recovery. The `reapStuckPosting` handles POSTING. The reconciliation handles APPROVED. If a job is `completed`, `queueService.enqueuePosting` will remove existing completed/failed jobs and re-add. If the post was actually posted, this will duplicate. High risk. We can check `job.returnvalue`? BullMQ job returnvalue may contain `postUrl` or `success`. Not used. So the `completed` state is ambiguous. The safe path is to not re-enqueue completed. But then a missed status update leaves the post stuck. Tradeoff. At minimum, the code should handle `completed` differently: log a warning and skip or verify. **Bug**: `completed` jobs are re-enqueued without verification.

**B5. `HealthMonitorService` `reapStuckPosting` uses `approvedAt` to determine cutoff, not `updatedAt` or `statusChangedAt`. `POSTING` status is set by `updateStatus` which sets `approvedAt`? Wait `updateStatus` sets `approvedAt` only when status is `APPROVED`. `POSTING` status is set via `updateStatus` with `status: POSTING` and does not update `approvedAt`. The `approvedAt` field is set when the post is approved. So `approvedAt` is the approval time, not the time it entered `POSTING`. The `reapStuckPosting` uses `approvedAt` with `lt: cutoff` to avoid reaping a post just approved and started. But a post could be `POSTING` for 35 minutes and `approvedAt` 40 minutes ago. Then it's reaped. Good. But a post approved 40 minutes ago, started posting 2 minutes ago, still in `POSTING` for 2 minutes, `approvedAt` is 40 minutes ago, so `reapStuckPosting` would consider it for reaping. Then it checks BullMQ job state. If active, skip. If the job is active (current), it is skipped. Good. But if the job is waiting/delayed due to queue pause or delay, it is skipped. Good. If no job, it fails. So the `approvedAt` heuristic is okay but could be improved with `status` updated timestamp. Prisma doesn't have `statusChangedAt`. So `approvedAt` is used. Good.

**B6. `HealthMonitorService` `reapStuckPosting` does not set `status` to `FAILED` if `update` fails. It logs and skips. Good. But it does not emit SSE for failed update. Minor.**

**B7. `HealthMonitorService` `checkSessionHealth` counts consecutive FAILED posts from the most recent in the last 24h. If there are 50 posts and all FAILED, it flags BANNED. If there is a non-FAILED post older, it stops. Good. But if the most recent 5 are FAILED and `banThreshold` is 5, it flags BANNED. This is a real ban detection. Good. But if `PostingService` has a bug causing failures (e.g., selector changed), it will flag BANNED even if the account is not banned. It should also check the error reason. But as a heuristic, it is okay.**

**B8. `HealthMonitorService` `checkSessionHealth` marks `SessionStatus.ACTIVE` as `BANNED` directly. `BANNED` IS in the Prisma `SessionStatus` enum (`schema.prisma:38`), so the cast is safe. The `as SessionStatus` cast is used because the status string is constructed dynamically. No bug here — verified against schema.

**B9. `HealthMonitorService` `checkSessionHealth` `recentPosts` query uses `createdAt: { gte: twentyFourHoursAgo }`. It counts posts created in the last 24h. If a post was created 24h ago and failed, and then a new post created recently also failed, it counts. The 24h window is reasonable. But if the posting happens infrequently, the 24h window may include too few posts. Good.**

**B10. `HealthMonitorService` `checkQueueHealth` does not handle `getJobCounts` failures gracefully. It catches and skips. But it might hide a queue outage. Good. It doesn't add to DLQ depth. Good.**

**B11. `HealthMonitorService` `getDashboard` calls `runHealthCheck()` which emits SSE and Discord alerts every time the dashboard is loaded. This is a side effect. The dashboard endpoint should not trigger alerts. It should compute a report without side effects. The `runHealthCheck` is also called by cron. The `getDashboard` should call `runHealthCheck` but suppress alert emission? The current code emits on every dashboard load. This could cause alert spam if an operator refreshes the dashboard. **Bug.**

**B12. `HealthMonitorService` `onModuleInit` registers crons dynamically and catches `SchedulerRegistry` not available. Good. It also uses `parseBool(this.configService?.get<string>('SPA_DRY_RUN', 'false'))` and `isOrchestratorEnabled()`. Good.**

**B13. `HealthMonitorService` `reapStuckBrowsingSessions` uses `configService.get<number>('F1_BROWSING_SESSION_MINUTES', 15)`. If `ConfigService.get<number>` returns string, `Number()` is applied. Good. It adds `180000 + 5*60*1000` buffer. The constants are not configurable. Good.**

**B14. `HealthMonitorService` `recoverBannedSessions` uses `findMany` with `include: { account: true }` but then only uses `session.accountId`. The `account` is unused. Good. It does not check the account network. `checkBanRecovery` uses `accountId` only. Fine.**

**B15. `HealthMonitorService` `checkBanRecovery` uses `session.createdAt` as ban age. If the session was created long before ban, this is wrong. But BANNED sessions are created when flagged? The `checkSessionHealth` marks existing session as `BANNED`. It uses `session.createdAt` not the time it was marked BANNED. There is no `bannedAt` field. So a session created a week ago and just banned today would be considered >24h and reactivated immediately. This is a bug. Should add `bannedAt` or `updatedAt` field. The `recoverBannedSessions` could use `updatedAt` if available. Prisma auto-updates `updatedAt`. So `session.updatedAt` would be the last update time (when status changed to BANNED). Using `updatedAt` is better. But the code uses `createdAt`. This is a bug. It may immediately reactivate a newly banned session. **Critical bug.**

**B16. `HealthMonitorService` `checkSessionHealth` marks sessions as `BANNED` but doesn't set `endedAt` or `bannedAt`. If `Session` model has `bannedAt`? Not sure. If not, `updatedAt` is updated. But `checkBanRecovery` uses `createdAt`. So `updatedAt` could be used. But `createdAt` is wrong.**

**B17. `HealthMonitorService` `checkPostHealth` counts `stuckPosting` with `approvedAt: { lt: thirtyMinAgo }`. Similar to `reapStuckPosting` but using 30 min. It counts them for dashboard. Good. But `stuckPosting` count may be stale if `reapStuckPosting` runs at 30 min and `healthCheck` at 30 min concurrently. Race condition. `reapStuckPosting` runs at `30 *` (half past), `healthCheck` at `0 *` (top of hour). They are not concurrent. Good.**

**B18. `HealthMonitorService` `runHealthCheck` does `for (const alert of report.alerts) { await this.sseService.publish(); await this.discord... }` sequentially. If many alerts, slow. But alerts are few. Good. However, `getDashboard` triggers this. Bad.**

**B19. `HealthMonitorController` `runReconciliation` returns `{ requeued: number; skipped: number }` but `runReconciliation` returns `{ requeued, skipped, deduplicated }`. The return type in controller is missing `deduplicated`. This is a TypeScript/type mismatch. The actual object returned has `deduplicated` but the signature says it doesn't. Minor. TypeScript might infer and be okay. The controller return type is explicitly typed. It may be wrong. Not a runtime bug.**

**B20. `HealthMonitorService` `runReconciliation` uses `queueService.enqueuePosting(post.id, post.network)`. `queueService.enqueuePosting` returns `Promise<void>`. If it fails, catch returns 'skipped'. Good. But `QueueService.enqueuePosting` may remove existing completed/failed jobs and re-add. If the job is `completed` (B4), it removes and re-adds. This could cause a duplicate post. As noted.**

**B21. `HealthMonitorService` `runHealthCheck` `alerts` for `BANNED` are emitted every hour. If a session is already BANNED, it will re-alert every hour. The `recoverBannedSessions` may reactivate, but until then, hourly alerts. Should be suppressed after first alert. Not critical.**

### 6.2 Performance

**P1. `HealthMonitorService` `runReconciliation` parallel 1000 posts is heavy.**

**P2. `HealthMonitorService` `checkSessionHealth` does a `findMany` per session (N+1). For each session, it queries recent posts. If there are many sessions, this is N+1. But there are only 3 sessions (one per network). Fine.**

**P3. `HealthMonitorService` `checkQueueHealth` iterates over 3 networks and calls `getJobCounts`. Fine.**

**P4. `HealthMonitorService` `getDashboard` calls `runHealthCheck` which does all checks. The dashboard endpoint is not cached. If many users refresh, it may be heavy. Could cache for 1 minute. But it's an admin endpoint. Fine.**

### 6.3 Architecture / anti-patterns

**A1. `HealthMonitorService` is a cron/health/reconciliation/reaper service. It does multiple things. But it's all operational. Acceptable.**

**A2. `HealthMonitorService` `getDashboard` triggers side effects (SSE/Discord). This is a design smell. Dashboard should be read-only. Alert emission should be in `runHealthCheck` only when triggered by cron.**

**A3. `HealthMonitorService` uses `modules/queue` and `infrastructure/queue` both. `QueueModule` (app) and `QueueInfraModule` (factory). It needs both. The `QueueService` is from `modules/queue` and `QueueFactory` from `infrastructure/queue`. This is correct but verbose naming.**

**A4. `HealthMonitorService` `checkSessionHealth` uses `post.status` to determine ban, but the post might have failed for non-ban reasons (e.g., network error, rate limit). It should incorporate `errorMessage` or `retryable` flag. But `retryable` is not in `Post` model. `errorMessage` could be parsed. Not ideal.**

**A5. `HealthMonitorService` `checkBanRecovery` uses `session.createdAt` instead of `updatedAt` or `bannedAt`. This is a bug. Need a `bannedAt` field.**

### 6.4 TypeScript / type safety

**T1. `HealthMonitorService` `'BANNED' as SessionStatus` cast. Verified: `BANNED` IS in the `SessionStatus` enum (`schema.prisma:38`). The cast is safe — it's used because the status string is constructed dynamically. No type safety issue.**

**T2. `HealthMonitorController` `runReconciliation` return type missing `deduplicated`. Type mismatch.**

**T3. `HealthMonitorService` `HealthReport` interface `status: string` not `SessionStatus`. Good. But `status` is set from `session.status` or `'BANNED'`. Fine.**

### 6.5 Security / reliability

**S1. `HealthMonitorController` endpoints are not admin-only. If `AUTH_ENABLED=false`, anyone can trigger reconciliation, health checks, and view dashboard. Should be admin-only.**

**S2. `HealthMonitorService` `runReconciliation` can re-enqueue APPROVED posts. If triggered manually by an attacker, it could cause multiple posts. But it has dedup. Still, should be admin-only.**

**S3. `HealthMonitorService` `checkSessionHealth` marking `BANNED` is a destructive operation. Should be admin-only trigger.**

**S4. `HealthMonitorService` `reapStuckPosting` marks posts FAILED without human confirmation. This is automated and intentional. Good. But if the queue is down and it can't check job state, it skips. Good. If the queue is available but the job is `completed` (but status not updated), it would fail? The `getJob` returns `job`, `state` is `completed`. It doesn't reap because `completed` is not `active`/`waiting`/`delayed`. So it reaps. It would mark as FAILED and not re-enqueue. If the post was actually posted, the human sees it was actually posted. Good. But the `reapStuckPosting` logic is `if state is active/waiting/delayed, skip; else mark FAILED`. This means if state is `completed`, it marks FAILED. If the post was actually posted, `completed` job should have returned `postUrl` but status not updated. Marking FAILED is wrong. Better to check `job.returnvalue` for `postUrl` and update status to `POSTED` instead. But `returnvalue` is not checked. This is a bug. **Bug**: `reapStuckPosting` does not handle `completed` jobs with `postUrl` in `returnvalue`. It marks them as FAILED. If `returnvalue` has `postUrl`, it should update `POSTED` and `postUrl`. But BullMQ job `returnvalue` is set by the worker's `processJob` function returning the result. The `queue.module.ts` worker handler may not return anything. Let me check. In `queue.module.ts`, the handler does `await postingService.postById(postId)` and then returns? The `queue.module.ts` code from queue review: `await postingService.postById(postId);` returns result. The worker may not return the result. The `postById` returns `PostResult` but the handler may not return it. So `returnvalue` may be undefined. If it does return, the `returnvalue` could be used. But currently it's not. This is a known future improvement. Not a bug in health-monitor per se, but the `reapStuckPosting` could be smarter. We should mention it in the health-monitor review but not call it a bug. The `reapStuckPosting` intentionally marks as FAILED when no active job. This is safer than re-enqueue. It handles `completed` by not re-enqueueing. If `completed` but status not updated, it marks FAILED. That is a false positive but safe. It could be improved. We can note it.

**S5. `HealthMonitorService` `runHealthCheck` `checkSessionHealth` marks sessions as `BANNED` automatically. If `PostingService` has a transient network issue, it may false-positive. Should require a threshold and cooldown. It has threshold. Good. But no cooldown. Could re-mark every hour. The status is already BANNED, so update doesn't change. Good.**

**S6. `HealthMonitorService` `recoverBannedSessions` reactivates `BANNED` accounts based on time and no recent failures. This is a safety-risk if the account is still banned. It only reactivates after 24h and no recent failures. But the `checkSessionHealth` will re-ban if there are consecutive failures again. Good. But `checkBanRecovery` uses `createdAt` not `updatedAt` (B15). This is a bug. It may reactivate a newly banned session.**

## 7. New feature / improvement ideas

**F1. Fix `getDashboard` to not emit SSE/Discord alerts**
- Separate `runHealthCheck` with `emit` option.

**F2. Fix `checkBanRecovery` to use `updatedAt` or `bannedAt` instead of `createdAt`**
- Add `bannedAt` field to `Session` model.

**F3. `BANNED` is already in the Prisma `SessionStatus` enum — no action needed.**

**F4. Limit concurrency in `runReconciliation` and batch queue checks**
- Use `p-map` or chunk with `Promise.all` over smaller batches.

**F5. Add `returnvalue` handling in `reapStuckPosting` and `runReconciliation`**
- If a completed job has `postUrl`, update `POSTED` instead of failing or re-enqueueing.

**F6. Add admin role guard to `HealthMonitorController` endpoints**
- Prevent unauthorized manual triggers.

**F7. Add `stuck` thresholds to env and make `reapStuckPosting` grace configurable**
- Already has `STUCK_POSTING_GRACE_MIN`.

**F8. Add `HealthMonitor` metrics**
- `health_monitor_alerts_total`, `reconciliation_requeued_total`, `reaper_reaped_total`.

**F9. Add `HealthMonitor` CLI commands**
- `pnpm health:reconcile`, `pnpm health:check`.

**F10. Add `reapStuckPosting` to also check `completed` jobs with missing status**
- Update status to `POSTED` if `returnvalue` confirms.

**F11. Add `HealthMonitor` `checkSessionHealth` to consider error reason**
- Parse `errorMessage` to avoid false ban flags for non-ban failures.

**F12. Add `reapStuckPosting` and `reapStuckBrowsingSessions` to `runHealthCheck` as separate checks**
- For dashboard reporting.

## 8. Cross-references

- `modules/queue` — `QueueService`, `QueueFactory`.
- `infrastructure/prisma` — `Session`, `Post`, `BrowsingSession` models.
- `infrastructure/sse` — `SseService`.
- `infrastructure/notifications` — `DiscordNotificationService`.
- `modules/sessions` — `SessionStatus` and `BANNED` handling.
- `modules/orchestrator` — `isOrchestratorEnabled()`.
- `modules/health` — separate liveness endpoint.

## 9. Overall assessment

- **Health**: 6/10. The module provides essential operational monitoring: reconciliation, reapers, ban detection, recovery. But `createdAt` is used for ban recovery age, `getDashboard` emits alerts, and `runReconciliation` is too parallel.
- **Biggest strengths**: comprehensive health checks, reconciliation deduplication, stuck POSTING/browsing reapers, ban recovery concept.
- **Biggest risks**: `checkBanRecovery` uses `createdAt` → reactivates newly banned sessions; `getDashboard` spams alerts; `runReconciliation` re-enqueues `completed` jobs (duplicate post risk); `runReconciliation` 1000 parallel calls; no admin guard.
- **Recommended next actions**:
  1. Add `bannedAt` to `Session` model and use it in `checkBanRecovery`.
  2. Separate `runHealthCheck` from alert emission for dashboard.
  3. Limit concurrency in `runReconciliation` and handle `completed` jobs carefully.
  4. Add admin role guard to controller endpoints.
