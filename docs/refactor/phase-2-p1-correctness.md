# Phase 2 — P1: Correctness Bugs

Bugs that produce wrong behavior but don't crash the system. Grouped by module.

> Items 2.6.1–2.6.4 (Orchestrator) are already fixed — see [README.md](README.md).

---

## 2.1 Posting & Queue

### 2.1.1 — `retryable` flag not set for poster errors

**Status:** `[x]` | **Effort:** S | **Ref:** posting.md B10

**Files:** `packages/backend/src/modules/posting/posting.service.ts:393-396, 520-539`, queue worker

**Description:** `postFn` returns plain `error` strings without a `retryable` flag, and the catch-all handler also drops `SpaError` retryability info. This means BullMQ retries errors that should not be retried (e.g., validation failures, missing selectors) and does not retry errors that should be (e.g., transient network issues). Add explicit `retryable: false` for validation/selector errors and `retryable: true` for transient/network errors.

### Checklist

- [x] Read `posting.service.ts:393-396` to find the `postFn` error return paths
- [x] Read `posting.service.ts:520-539` to find the catch-all handler
- [x] Classify each error type: validation/selector → `retryable: false`; network/timeout → `retryable: true`
- [x] Return `{ error, retryable }` objects instead of plain strings
- [x] Update the queue worker to respect the `retryable` flag
- [x] Add unit tests for both retryable and non-retryable error paths
- [x] Run `npx vitest run tests/unit/posting/`

### Acceptance criteria

- Validation/selector errors are not retried by BullMQ
- Transient errors are retried
- Unit tests cover both paths

---

### 2.1.2 — `schedulePosting` uses general retry config instead of posting config

**Status:** `[x]` | **Effort:** XS | **Ref:** queue.md

**Files:** `packages/backend/src/infrastructure/queue/queue.factory.ts`

**Description:** `schedulePosting` creates a queue with the general retry configuration instead of the posting-specific retry configuration. Posting retries should be more conservative (fewer attempts, longer backoff) to avoid triggering anti-bot detection. Verify which retry config is used and switch to the posting-specific one if needed.

### Checklist

- [x] Read `queue.factory.ts` to find `schedulePosting` and the retry config definitions
- [x] Compare general vs. posting retry configs
- [x] Switch `schedulePosting` to use the posting-specific config
- [x] Verify with a unit test that the correct config is applied
- [x] Run `npx vitest run tests/unit/queue/`

### Acceptance criteria

- `schedulePosting` uses posting-specific retry config
- Unit test confirms correct config

---

### 2.1.3 — `QueueController.getFailed` exposes raw `Job` objects

**Status:** `[x]` | **Effort:** XS | **Ref:** queue.md B8

**Files:** `packages/backend/src/modules/queue/queue.controller.ts`

**Description:** `getFailed` returns raw BullMQ `Job` objects directly, which may contain sensitive data (storageState, credentials, full post content). Map the jobs to a sanitized DTO before returning. This prevents accidental exposure of sensitive data through the API.

### Checklist

- [x] Read `queue.controller.ts` to find the `getFailed` endpoint
- [x] Create a `JobDto` or mapping function that strips sensitive fields
- [x] Apply the mapping to the response
- [x] Add a unit test that verifies sensitive fields are not present in the response
- [x] Run `npx vitest run tests/unit/queue/`

### Acceptance criteria

- `getFailed` response does not contain raw `Job` objects
- Sensitive fields (storageState, credentials, etc.) are stripped
- Unit test confirms sanitization

---

## 2.2 Autonomy & Auto-approve

### 2.2.1 — Verify `qualityScore` missing-score fallback design

**Status:** `[x]` | **Effort:** XS | **Ref:** autonomy.md B2

**Files:** `packages/backend/src/modules/autonomy/auto-approve.service.ts:113-120`

**Description:** When `qualityScore` is missing, the code defaults to `AUTO_APPROVE_MIN_SCORE` and auto-approves if `AutoCheck` passed. This is a fail-open design — missing scores lead to auto-approval. Decide whether this is intentional (accept and document) or should be fail-closed (route to `HUMAN_REVIEW` when score is missing). If accepting, add a comment explaining the design decision.

### Checklist

- [x] Read `auto-approve.service.ts:113-120` to understand the fallback logic
- [x] Decide: accept fail-open (add comment + doc) OR switch to fail-closed (route to HUMAN_REVIEW)
- [x] If switching: add condition `if (qualityScore === undefined) return HUMAN_REVIEW`
- [x] If accepting: add a clear comment explaining why
- [x] Add/update unit test to cover the missing-score case
- [x] Run `npx vitest run tests/unit/autonomy/`

### Acceptance criteria

- Missing-score behavior is explicitly documented or changed
- Unit test covers the missing-score path

---

### 2.2.2 — `loadRecentHashes` includes FAILED/REJECTED + no `orderBy`

**Status:** `[x]` | **Effort:** XS | **Ref:** autonomy.md B15/B16

**Files:** `packages/backend/src/modules/autonomy/auto-check.service.ts:136-147`

**Description:** `loadRecentHashes` queries recent posts without filtering by status (includes FAILED and REJECTED posts) and without `orderBy` (so the "recent" set is not guaranteed to be the most recent). This means SimHash dedup compares against posts that were never published, and the "recent" window is arbitrary. Filter to `POSTED` status only and add `orderBy: { createdAt: 'desc' }`.

### Checklist

- [x] Read `auto-check.service.ts:136-147` to find the query
- [x] Add `where: { status: 'POSTED' }` (or appropriate statuses)
- [x] Add `orderBy: { createdAt: 'desc' }`
- [x] Update unit tests to verify the filter and ordering
- [x] Run `npx vitest run tests/unit/autonomy/`

### Acceptance criteria

- `loadRecentHashes` only returns POSTED posts
- Results are ordered by `createdAt` descending
- Unit tests verify both

---

### 2.2.3 — `checkRejectStreak` not truly consecutive

**Status:** `[x]` | **Effort:** S | **Ref:** autonomy.md B1

**Files:** `packages/backend/src/modules/autonomy/auto-approve.service.ts:216-220`

**Description:** `checkRejectStreak` checks if N of the last M posts were rejected, but doesn't verify they are *consecutive*. A streak of 3 rejects followed by an approve followed by 2 more rejects would count as 5 rejects. Fix the logic to check for truly consecutive rejects (no approved posts in between).

### Checklist

- [x] Read `auto-approve.service.ts:216-220` to understand the current streak logic
- [x] Rewrite to iterate through posts and count consecutive rejects, resetting on any non-reject
- [x] Add unit tests for: all rejects, mixed, streak broken by approve, streak at end
- [x] Run `npx vitest run tests/unit/autonomy/`

### Acceptance criteria

- Streak counter resets on any non-reject status
- Unit tests cover edge cases (mixed, broken streak, all rejects)

---

### 2.2.4 — Remove unused `PostsService` from `AutoApproveListener`

**Status:** `[x]` | **Effort:** XS | **Ref:** autonomy.md B21

**Files:** `packages/backend/src/events/listeners/auto-approve.listener.ts:39`

**Description:** `AutoApproveListener` injects `PostsService` but never uses it. This creates an unnecessary dependency and can cause circular module imports. Remove the injection and the import.

### Checklist

- [x] Read `auto-approve.listener.ts` to confirm `PostsService` is unused
- [x] Remove the `@Inject` and constructor parameter
- [x] Remove the import statement
- [x] Run `npx tsc --noEmit` to verify no broken references
- [x] Run `npx vitest run tests/unit/` to verify no regressions

### Acceptance criteria

- `PostsService` is no longer injected into `AutoApproveListener`
- `npx tsc --noEmit` passes

---

## 2.3 Posts & Events

### 2.3.1 — `approve` with `editedContent` does not update `simhash` or re-run AutoCheck

**Status:** `[x]` | **Effort:** S | **Ref:** posts.md S7/S8, F3/F4

**Files:** `packages/backend/src/modules/posts/posts.service.ts:172-174, 179-184`

**Description:** When a post is approved with `editedContent`, the `simhash` is not recalculated and `AutoCheck` is not re-run. This means an operator could edit a post to be a near-duplicate of an existing post, and the dedup check would not catch it. Recalculate `simhash` from the edited content and re-run `AutoCheck` before approving.

### Checklist

- [x] Read `posts.service.ts:172-184` to find the `approve` method
- [x] After updating content, recalculate `simhash` using the same method as generation
- [x] Re-run `AutoCheckService.check()` with the new content and hash
- [x] If AutoCheck fails, return an error to the operator
- [x] Add unit tests for: approve with edit → simhash updated, approve with edit → AutoCheck re-run
- [x] Run `npx vitest run tests/unit/posts/`

### Acceptance criteria

- `simhash` is recalculated when `editedContent` is provided
- `AutoCheck` is re-run on edited content
- Unit tests verify both behaviors

---

### 2.3.2 — `updateStatus` allows arbitrary transitions — no state machine

**Status:** `[x]` | **Effort:** S | **Ref:** posts.md B4

**Files:** `packages/backend/src/modules/posts/posts.service.ts:111-139`

**Description:** `updateStatus` accepts any status and sets it directly, without validating that the transition is legal. For example, a `POSTED` post could be set back to `PENDING`, or a `REJECTED` post set to `APPROVED` without review. Implement a state machine that defines valid transitions and rejects invalid ones.

### Checklist

- [x] Read `posts.service.ts:111-139` to find `updateStatus`
- [x] Define a transition map: `PENDING → APPROVED|REJECTED`, `APPROVED → POSTED|FAILED|PENDING`, etc.
- [x] Add validation that checks the current status against the transition map
- [x] Throw a `BadRequestException` for invalid transitions
- [x] Add unit tests for valid and invalid transitions
- [x] Run `npx vitest run tests/unit/posts/`

### Acceptance criteria

- Invalid transitions throw `BadRequestException`
- Valid transitions work as before
- Unit tests cover all transition paths

---

### 2.3.3 — `PostEvents.REJECTED` never emitted

**Status:** `[x]` | **Effort:** XS | **Ref:** posts.md B12, events.md B1

**Files:** `packages/backend/src/modules/posts/posts.service.ts:192-205`

**Description:** When a post is rejected, `PostEvents.REJECTED` is never emitted to the event bus. This means the UI never sees rejection events via SSE, and any listeners that depend on rejection events (e.g., analytics, notifications) never fire. Add `this.eventBus.emit(PostEvents.REJECTED, ...)` in the rejection path.

### Checklist

- [x] Read `posts.service.ts:192-205` to find the rejection path
- [x] Add `eventBus.emit(PostEvents.REJECTED, { postId, network, ... })` after status update
- [x] Verify `PostEvents.REJECTED` is defined in the events enum
- [x] Add a unit test that verifies the event is emitted on rejection
- [x] Run `npx vitest run tests/unit/posts/`

### Acceptance criteria

- `PostEvents.REJECTED` is emitted when a post is rejected
- Unit test confirms event emission

---

### 2.3.4 — Duplicate `post_status` SSE events

**Status:** `[x]` | **Effort:** S | **Ref:** events.md B3, infrastructure-sse.md B1

**Files:** `packages/backend/src/modules/posting/posting.service.ts`, `packages/backend/src/events/listeners/sse-event.listener.ts`

**Description:** `posting.service.ts` publishes `post_status` SSE events directly to Redis, and `SseEventListener` also republishes the same event when it hears the domain event. This results in duplicate SSE events reaching the UI. Choose one path (either direct publish or event-listener publish) and remove the other.

### Checklist

- [x] Read `posting.service.ts` to find direct SSE publish calls for `post_status`
- [x] Read `sse-event.listener.ts` to find the `post_status` republish
- [x] Decide which path to keep (recommend: event-listener path, as it centralizes SSE publishing)
- [x] Remove the direct publish from `posting.service.ts` (or remove the listener handler)
- [x] Verify SSE events still reach the UI with a manual test or integration test
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Only one `post_status` SSE event per status change
- No duplicate events in integration tests

---

### 2.3.5 — `SseEventListener` does not await `publish` → unhandled promise rejections

**Status:** `[x]` | **Effort:** XS | **Ref:** events.md B2, infrastructure-sse.md B2

**Files:** `packages/backend/src/events/listeners/sse-event.listener.ts`

**Description:** `SseEventListener` event handlers call `sseService.publish()` without `await` and without `.catch()`. If the Redis PUBLISH fails, the rejected promise becomes an unhandled rejection, which can crash the process in strict mode. Add `await` or `.catch()` to all publish calls in the listener.

### Checklist

- [x] Read `sse-event.listener.ts` to find all `publish()` calls
- [x] Add `await` to each call (make handlers `async` if not already)
- [x] Alternatively, add `.catch(err => this.logger.error(...))` to each call
- [x] Add a unit test that simulates a publish failure and verifies no unhandled rejection
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- All `publish()` calls are awaited or have `.catch()`
- No unhandled promise rejections on publish failure
- Unit test confirms graceful error handling

---

## 2.4 Sessions

### 2.4.1 — Circuit breaker does not record `null` failures

**Status:** `[x]` | **Effort:** S | **Ref:** sessions.md

**Files:** `packages/backend/src/modules/sessions/sessions.service.ts`

**Description:** When `autoLogin` returns `null` (login failed but no exception thrown), the circuit breaker does not record a failure. This means repeated login failures never trip the breaker, and the system keeps trying to log in indefinitely. Record `null` returns as failures in the circuit breaker.

### Checklist

- [x] Read `sessions.service.ts` to find the `autoLogin` call site and circuit breaker usage
- [x] After `autoLogin` returns, check for `null` and call `circuitBreaker.recordFailure()` if so
- [x] Ensure `circuitBreaker.recordSuccess()` is only called on actual success
- [x] Add unit tests for: `null` return → failure recorded, success → success recorded
- [x] Run `npx vitest run tests/unit/sessions/`

### Acceptance criteria

- `null` return from `autoLogin` trips the circuit breaker
- Unit test confirms failure recording

---

### 2.4.2 — `healthCheck` does not expire sessions on nav errors

**Status:** `[x]` | **Effort:** XS | **Ref:** sessions.md B29

**Files:** `packages/backend/src/modules/sessions/sessions.service.ts:1389-1391`

**Description:** `healthCheck` returns `healthy: false` on navigation errors but does not update the session status to `EXPIRED`. The session remains `ACTIVE` and keeps being selected for posting, leading to repeated failures. Update the session status to `EXPIRED` when a navigation error occurs during health check.

### Checklist

- [x] Read `sessions.service.ts:1389-1391` to find the nav error handling
- [x] Add `await this.updateSessionStatus(session.id, 'EXPIRED')` on nav error
- [x] Add a unit test that verifies status changes to `EXPIRED` on nav error
- [x] Run `npx vitest run tests/unit/sessions/`

### Acceptance criteria

- Session status becomes `EXPIRED` on navigation error during health check
- Unit test confirms status change

---

### 2.4.3 — Remove `as SessionStatus` casts for `WARMUP`

**Status:** `[x]` | **Effort:** XS | **Ref:** sessions.md

**Files:** `packages/backend/src/modules/sessions/warmup.service.ts`, `packages/backend/src/modules/sessions/sessions.service.ts`

**Description:** `WARMUP` is already in the Prisma `SessionStatus` enum, but the code still uses `as SessionStatus` casts. Remove the casts to improve type safety and catch any future enum mismatches at compile time.

### Checklist

- [x] Search for `as SessionStatus` in `warmup.service.ts` and `sessions.service.ts`
- [x] Remove the casts
- [x] Run `npx tsc --noEmit` to verify the types are correct without casts
- [x] Run `npx vitest run tests/unit/sessions/`

### Acceptance criteria

- No `as SessionStatus` casts in the codebase
- `npx tsc --noEmit` passes

---

### 2.4.4 — `ParseEnumPipe` for `network` parameter in `SessionsController`

**Status:** `[x]` | **Effort:** XS | **Ref:** sessions.md B27

**Files:** `packages/backend/src/modules/sessions/sessions.controller.ts`

**Description:** `healthCheck` and `submitVerifyCode` endpoints accept `network` as a string literal union but don't use `ParseEnumPipe` for runtime validation. An invalid network string would pass through and cause a runtime error deeper in the service layer. Add `ParseEnumPipe(Network)` to the route parameters.

### Checklist

- [x] Read `sessions.controller.ts` to find `healthCheck` and `submitVerifyCode` routes
- [x] Add `@Param('network', new ParseEnumPipe(Network))` to both
- [x] Add a unit test that sends an invalid network and expects 400
- [x] Run `npx vitest run tests/unit/sessions/`

### Acceptance criteria

- Invalid network values return 400 Bad Request
- Valid network values work as before

---

## 2.5 Health Monitor

### 2.5.1 — `checkBanRecovery` uses `createdAt` instead of `updatedAt`/`bannedAt`

**Status:** `[x]` | **Effort:** S | **Ref:** health-monitor.md A5

**Files:** `packages/backend/src/modules/health-monitor/health-monitor.service.ts:549`

**Description:** `checkBanRecovery` uses `createdAt` to determine how long a session has been banned, but `createdAt` is the session creation time, not the ban time. This causes newly banned sessions with old creation dates to be immediately reactivated. Use `updatedAt` (or a dedicated `bannedAt` field if added) instead.

### Checklist

- [x] Read `health-monitor.service.ts:549` to find the ban recovery logic
- [x] Change `createdAt` to `updatedAt` in the time calculation
- [x] Consider adding a `bannedAt` field to the `Session` model (see task 7.7) for correctness
- [x] Add a unit test: session banned recently → not recovered; session banned long ago → recovered
- [x] Run `npx vitest run tests/unit/health-monitor/`

### Acceptance criteria

- Ban recovery uses the correct timestamp
- Unit test confirms recent bans are not prematurely recovered

---

### 2.5.2 — `getDashboard` calls `runHealthCheck()` which emits alerts

**Status:** `[x]` | **Effort:** S | **Ref:** health-monitor.md

**Files:** `packages/backend/src/modules/health-monitor/health-monitor.service.ts:519`

**Description:** `getDashboard` calls `runHealthCheck()` to populate the dashboard, but `runHealthCheck` emits Discord alerts as a side effect. Every time someone opens the dashboard, alerts are re-sent. Separate the data-collection logic from the alert-emission logic so `getDashboard` can get the data without triggering alerts.

### Checklist

- [x] Read `health-monitor.service.ts:519` to find the `getDashboard` → `runHealthCheck` call
- [x] Extract the data-collection part of `runHealthCheck` into a separate method (e.g., `collectHealthData`)
- [x] Have `getDashboard` call `collectHealthData` instead of `runHealthCheck`
- [x] `runHealthCheck` should call `collectHealthData` then emit alerts
- [x] Add a unit test that verifies `getDashboard` does not emit alerts
- [x] Run `npx vitest run tests/unit/health-monitor/`

### Acceptance criteria

- `getDashboard` does not emit Discord alerts
- `runHealthCheck` still emits alerts as before
- Unit test confirms no alert emission from `getDashboard`

---

### 2.5.3 — `runReconciliation` 1000 parallel calls + re-enqueues `completed` jobs

**Status:** `[x]` | **Effort:** S | **Ref:** health-monitor.md

**Files:** `packages/backend/src/modules/health-monitor/health-monitor.service.ts:125`

**Description:** `runReconciliation` fires up to 1000 parallel calls and re-enqueues `completed` jobs that don't need reconciliation. This causes memory spikes and unnecessary queue load. Batch the calls with limited concurrency (e.g., `p-map` with concurrency=10) and filter out `completed` jobs before re-enqueuing.

### Checklist

- [x] Read `health-monitor.service.ts:125` to find the reconciliation logic
- [x] Replace `Promise.all` with a concurrency-limited approach (chunked or `p-map`)
- [x] Filter out `completed` jobs — only reconcile `active`/`delayed`/`failed` jobs
- [x] Add a unit test that verifies concurrency limit and job filtering
- [x] Run `npx vitest run tests/unit/health-monitor/`

### Acceptance criteria

- Reconciliation runs with bounded concurrency (≤10)
- `completed` jobs are not re-enqueued
- Unit test confirms both

---

## 2.6 Orchestrator

> **2.6.1–2.6.4 are already fixed.** See [README.md](README.md).

---

## 2.7 Rate Limit

### 2.7.1 — Non-atomic check/record — race condition

**Status:** `[x]` | **Effort:** S | **Ref:** rate-limit.md B1

**Files:** `packages/backend/src/modules/.../rate-limit.service.ts:158, 167, 176`

**Description:** `RateLimitService.recordPost` performs 3 sequential Redis `get` calls without `WATCH`/`MULTI`, creating a race condition where concurrent posts can all pass the rate limit check before any of them increments the counter. This allows exceeding the rate limit. Use a Lua script for atomic check-and-increment, or use Redis `WATCH`/`MULTI` transactions.

### Checklist

- [ ] Read `rate-limit.service.ts:158-176` to find the check/record logic
- [ ] Write a Lua script that atomically checks the current count and increments if under limit
- [ ] Use `redis.eval(luaScript, ...)` to execute the script
- [ ] Alternatively, use `WATCH`/`MULTI`/`EXEC` for a transactional approach
- [ ] Add a unit/integration test that fires concurrent posts and verifies the limit is not exceeded
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Rate limit check and record are atomic
- Concurrent posts do not exceed the rate limit
- Integration test confirms atomicity

---

### 2.7.2 — `0` handling — `Number(...) || default` treats `0` as falsy

**Status:** `[x]` | **Effort:** XS | **Ref:** rate-limit.md B8

**Files:** `packages/backend/src/modules/.../rate-limit.service.ts:76-79`

**Description:** The code uses `Number(process.env.X) || default` to parse numeric env vars, but `0` is falsy in JavaScript. If an operator sets a rate limit to `0` (to disable it), the code uses the default instead. Use nullish coalescing (`??`) or explicit `undefined` checks instead of `||`.

### Checklist

- [ ] Read `rate-limit.service.ts:76-79` to find all `Number(...) || default` patterns
- [ ] Replace with `const val = process.env.X; const result = val !== undefined ? Number(val) : default`
- [ ] Or use `Number(process.env.X ?? default)` if the env var is always a string when set
- [ ] Add a unit test that sets the env var to `0` and verifies it's respected
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `0` is respected as a valid value
- Unit test confirms `0` is not replaced with default

---

### 2.7.3 — Fail-open on Redis down — no fail-closed option

**Status:** `[x]` | **Effort:** XS | **Ref:** rate-limit.md

**Files:** `packages/backend/src/modules/.../rate-limit.service.ts:144-146`

**Description:** When Redis is down, the rate limiter fails open (allows all posts through). There is no option to fail closed (block all posts when Redis is unavailable). Add a `RATE_LIMIT_FAIL_CLOSED` env var (default `false`) that, when true, blocks posts if Redis is unavailable.

### Checklist

- [ ] Read `rate-limit.service.ts:144-146` to find the Redis-down handling
- [ ] Add `RATE_LIMIT_FAIL_CLOSED` to `env.validation.ts` (default `false`)
- [ ] When Redis is down and `FAIL_CLOSED=true`, return `allowed: false`
- [ ] Add unit tests for both fail-open and fail-closed modes
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `RATE_LIMIT_FAIL_CLOSED=true` blocks posts when Redis is down
- `RATE_LIMIT_FAIL_CLOSED=false` (default) allows posts when Redis is down
- Unit tests cover both modes

---

## 2.8 Content & Generation

### 2.8.1 — `DbContentReader.markUsed` never called → topics reused

**Status:** `[x]` | **Effort:** S | **Ref:** content-source.md

**Files:** `packages/backend/src/infrastructure/content/content-reader.ts`, `packages/backend/src/modules/generation/generation.service.ts`

**Description:** `DbContentReader.markUsed` is defined but never called from the generation pipeline. This means topics are never marked as used and can be selected again for generation, leading to duplicate content. Call `markUsed` after a topic is successfully picked for generation.

### Checklist

- [ ] Read `content-reader.ts` to find `markUsed` and understand the marking mechanism
- [ ] Read `generation.service.ts` to find where topics are selected
- [ ] Call `markUsed(topicId)` after a topic is successfully picked and generation starts
- [ ] Ensure `markUsed` is not called if generation fails (so the topic can be reused)
- [ ] Add a unit test that verifies `markUsed` is called after topic selection
- [ ] Run `npx vitest run tests/unit/generation/`

### Acceptance criteria

- `markUsed` is called after topic selection
- Topics are not re-selected after being marked used
- Unit test confirms `markUsed` call

---

### 2.8.2 — `ContentPillarTracker` TTL refresh = non-rolling window + records drafts

**Status:** `[x]` | **Effort:** S | **Ref:** content-enhancements.md B1, S51-S53

**Files:** `packages/backend/src/modules/.../content-pillar.tracker.ts:177-181`

**Description:** `ContentPillarTracker` refreshes the TTL on every access, creating a non-rolling window that never expires if accessed frequently. It also records draft posts (not just published ones), skewing the content distribution. Fix the TTL to be set once at creation (not refreshed on access) and only record published posts.

### Checklist

- [ ] Read `content-pillar.tracker.ts:177-181` to find the TTL refresh logic
- [ ] Remove the TTL refresh on access — set TTL only at key creation
- [ ] Filter to only record `POSTED` status posts, not drafts
- [ ] Add unit tests for: TTL not refreshed on access, drafts not recorded
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- TTL is set once at creation, not refreshed on access
- Only `POSTED` posts are recorded in the tracker
- Unit tests confirm both behaviors

---

### 2.8.3 — Recycling: `recycled` flag set before generation success

**Status:** `[x]` | **Effort:** XS | **Ref:** recycling.md B10

**Files:** `packages/backend/src/modules/generation/generation.service.ts:562-565`

**Description:** The `recycled` flag is set on a post before the new generation completes. If generation fails, the post is marked as recycled but no new post was created, wasting the original post. Move the `recycled` flag update to after successful generation.

### Checklist

- [ ] Read `generation.service.ts:562-565` to find the `recycled` flag setting
- [ ] Move the flag update to after the generation succeeds (after `persistGeneratedPosts`)
- [ ] Add a unit test that verifies the flag is not set on generation failure
- [ ] Run `npx vitest run tests/unit/generation/`

### Acceptance criteria

- `recycled` flag is set only after successful generation
- Unit test confirms flag is not set on failure

---

### 2.8.4 — Recycling: SimHash threshold inconsistent with GenerationService

**Status:** `[x]` | **Effort:** XS | **Ref:** recycling.md

**Files:** `packages/backend/src/modules/.../recycling.service.ts`

**Description:** `RecyclingService` uses a different SimHash Hamming distance threshold than `GenerationService` for dedup. This means a recycled post might pass dedup in recycling but fail in generation, or vice versa. Align the threshold to use the same config value.

### Checklist

- [ ] Read `recycling.service.ts` to find the SimHash threshold
- [ ] Read `generation.service.ts` to find the SimHash threshold
- [ ] Extract the threshold to a shared config constant or env var
- [ ] Use the same value in both services
- [ ] Add a unit test that verifies both services use the same threshold
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Both services use the same SimHash threshold
- Threshold is defined in a single location
- Unit test confirms consistency

---

### 2.8.5 — `ABVariantGenerator` hashtag regex ASCII-only — misses Cyrillic

**Status:** `[x]` | **Effort:** XS | **Ref:** content-enhancements.md B8

**Files:** `packages/backend/src/modules/.../ab-variant.generator.ts:254`

**Description:** The hashtag extraction regex uses `[a-zA-Z0-9_]` which only matches ASCII characters. Russian/Cyrillic hashtags (e.g., `#астрология`) are not extracted, leading to missing hashtags in AB variants. Update the regex to use Unicode character classes (`\p{L}\p{N}`).

### Checklist

- [ ] Read `ab-variant.generator.ts:254` to find the hashtag regex
- [ ] Replace `[a-zA-Z0-9_]` with `[\p{L}\p{N}_]` and add the `u` flag
- [ ] Test with Cyrillic hashtags: `#астрология`, `#зодиак`
- [ ] Add a unit test with Cyrillic hashtag input
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Cyrillic hashtags are correctly extracted
- ASCII hashtags still work
- Unit test covers both

---

### 2.8.6 — `getDailyStats` uses `createdAt` instead of `postedAt`

**Status:** `[x]` | **Effort:** XS | **Ref:** analytics.md

**Files:** `packages/backend/src/modules/analytics/analytics.service.ts:84`

**Description:** `getDailyStats` filters posts by `createdAt` (when the post was generated) instead of `postedAt` (when it was actually posted). This means posts generated yesterday but posted today appear in yesterday's stats, not today's. Change the filter to use `postedAt`.

### Checklist

- [ ] Read `analytics.service.ts:84` to find the `createdAt` filter
- [ ] Change to `postedAt`
- [ ] Add a unit test with a post that has different `createdAt` and `postedAt`
- [ ] Run `npx vitest run tests/unit/analytics/`

### Acceptance criteria

- Daily stats are based on `postedAt`
- Unit test confirms correct date filtering

---

### 2.8.7 — `getTopPosts` sorts by recency, not engagement

**Status:** `[x]` | **Effort:** XS | **Ref:** analytics.md

**Files:** `packages/backend/src/modules/analytics/analytics.service.ts:120-124`

**Description:** `getTopPosts` claims to return top-performing posts but sorts by `createdAt` descending (most recent), not by engagement metrics (likes, retweets, replies). This means "top" posts are just the most recent ones. Sort by a composite engagement score instead.

### Checklist

- [ ] Read `analytics.service.ts:120-124` to find the sort logic
- [ ] Change `orderBy` to sort by engagement metrics (e.g., `likes + retweets + replies` descending)
- [ ] Consider making the sort metric configurable
- [ ] Add a unit test with posts of varying engagement
- [ ] Run `npx vitest run tests/unit/analytics/`

### Acceptance criteria

- `getTopPosts` returns posts sorted by engagement, not recency
- Unit test confirms correct sorting

---

## 2.9 Replies & Trending

### 2.9.1 — Self-reply detection broken

**Status:** `[x]` | **Effort:** S | **Ref:** replies.md

**Files:** `packages/backend/src/modules/replies/replies-monitor.service.ts:414-416`

**Description:** Self-reply detection compares the comment author handle with the current account's handle, but the comparison may use different formats (e.g., `@user` vs `user`) or case sensitivity. This can cause the bot to reply to its own comments. Normalize both handles (strip `@`, lowercase) before comparison.

### Checklist

- [ ] Read `replies-monitor.service.ts:414-416` to find the self-reply check
- [ ] Normalize both handles: strip `@`, trim, lowercase
- [ ] Add a unit test with various handle formats (`@User`, `user`, `USER`)
- [ ] Run `npx vitest run tests/unit/replies/`

### Acceptance criteria

- Self-replies are correctly detected regardless of handle format
- Unit test covers case and `@` prefix variations

---

### 2.9.2 — Original post scraped as comment

**Status:** `[x]` | **Effort:** S | **Ref:** replies.md

**Files:** `packages/backend/src/modules/replies/replies-monitor.service.ts`

**Description:** The replies scraper sometimes scrapes the original post as a comment, leading to the bot replying to its own post. Filter out the original post from the scraped comments by comparing post URLs or IDs.

### Checklist

- [ ] Read `replies-monitor.service.ts` to find the comment scraping logic
- [ ] Add a filter that excludes the original post (by URL, ID, or position in the thread)
- [ ] Add a unit test that includes the original post in mock data and verifies it's filtered out
- [ ] Run `npx vitest run tests/unit/replies/`

### Acceptance criteria

- Original post is not treated as a comment
- Unit test confirms filtering

---

### 2.9.3 — `runMonitoringCycle` ignores flow control

**Status:** `[x]` | **Effort:** XS | **Ref:** replies.md

**Files:** `packages/backend/src/modules/replies/replies-monitor.service.ts`

**Description:** `runMonitoringCycle` does not check the flow-control pause flag before running. This means replies monitoring continues even when the system is paused. Add a `flowControlService.isPaused('replies')` check at the start of the cycle.

### Checklist

- [ ] Read `replies-monitor.service.ts` to find `runMonitoringCycle`
- [ ] Add `if (await this.flowControlService.isPaused('replies')) return;` at the top
- [ ] Add a unit test that sets the pause flag and verifies the cycle is skipped
- [ ] Run `npx vitest run tests/unit/replies/`

### Acceptance criteria

- Monitoring cycle is skipped when flow control is paused
- Unit test confirms skip behavior

---

### 2.9.4 — `page.evaluate` uses Playwright `:has-text` selector (invalid in browser)

**Status:** `[x]` | **Effort:** S | **Ref:** trending.md

**Files:** `packages/backend/src/modules/trending/trending-scraper.service.ts:76`

**Description:** `page.evaluate` runs JavaScript in the browser context, but the code uses Playwright's `:has-text` selector syntax which is not valid CSS and only works in Playwright's `locator`/`page.$` APIs. This causes the evaluate to fail silently or throw. Replace with standard DOM APIs (`querySelectorAll` + text content check).

### Checklist

- [ ] Read `trending-scraper.service.ts:76` to find the `page.evaluate` call
- [ ] Replace `:has-text` selectors with standard DOM queries (`querySelectorAll` + `textContent.includes()`)
- [ ] Test with a real page (use `pnpm dry-run` or a unit test with mocked page)
- [ ] Run `npx vitest run tests/unit/trending/`

### Acceptance criteria

- `page.evaluate` uses valid browser DOM APIs
- Trending scraping works correctly

---

### 2.9.5 — `getMergedTrending` not cached

**Status:** `[x]` | **Effort:** XS | **Ref:** trending.md

**Files:** `packages/backend/src/modules/trending/trending.service.ts`

**Description:** `getMergedTrending` merges trending data from multiple sources on every call, which is expensive. Add a short TTL cache (e.g., 60 seconds) to avoid redundant computation on repeated dashboard loads.

### Checklist

- [ ] Read `trending.service.ts` to find `getMergedTrending`
- [ ] Add an in-memory cache with a 60-second TTL
- [ ] Invalidate the cache when new trending data is scraped
- [ ] Add a unit test that verifies cache hit on second call
- [ ] Run `npx vitest run tests/unit/trending/`

### Acceptance criteria

- `getMergedTrending` results are cached for 60 seconds
- Cache is invalidated on new scrape
- Unit test confirms caching

---

## 2.10 Engagement

### 2.10.1 — Quote generation uses wrong temperature env var

**Status:** `[x]` | **Effort:** XS | **Ref:** engagement.md B24

**Files:** `packages/backend/src/modules/engagement/engagement-decision.service.ts:261`

**Description:** Quote generation at line 261 reads `ENGAGEMENT_COMMENT_TEMPERATURE` instead of `ENGAGEMENT_QUOTE_TEMPERATURE`. This means the quote temperature config is silently ignored and quotes use the comment temperature. Fix the env var name.

### Checklist

- [ ] Read `engagement-decision.service.ts:261` to find the wrong env var
- [ ] Change `ENGAGEMENT_COMMENT_TEMPERATURE` to `ENGAGEMENT_QUOTE_TEMPERATURE`
- [ ] Add a unit test that verifies the correct env var is read for quote generation
- [ ] Run `npx vitest run tests/unit/engagement/`

### Acceptance criteria

- Quote generation uses `ENGAGEMENT_QUOTE_TEMPERATURE`
- Unit test confirms correct env var

---

### 2.10.2 — `EngagementDecisionService` reads env vars at module load

**Status:** `[x]` | **Effort:** XS | **Ref:** engagement.md B24

**Files:** `packages/backend/src/modules/engagement/engagement-decision.service.ts:34-35`

**Description:** `EngagementDecisionService` reads `ENGAGEMENT_*_TEMPERATURE` from `process.env` at module load time (top-level const), not via `ConfigService`. This means env var changes require a restart and are not validated. Switch to `ConfigService` injection (note: this module is not in the orchestrator, so `ConfigService` is available).

### Checklist

- [ ] Read `engagement-decision.service.ts:34-35` to find the `process.env` reads
- [ ] Inject `ConfigService` and read the env vars in the constructor or method
- [ ] Add the env vars to `env.validation.ts` if not already declared
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/engagement/`

### Acceptance criteria

- No `process.env` reads at module load level in `EngagementDecisionService`
- `ConfigService` is used instead
- `npx tsc --noEmit` passes

---

## 2.11 LLM / Langfuse / Prompts

### 2.11.1 — Langfuse default base URL is EU instead of US

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-llm.md B8

**Files:** `packages/backend/src/infrastructure/langfuse/langfuse.service.ts:75`, `packages/backend/src/infrastructure/langfuse/langfuse-instrumentation.ts:83`

**Description:** The default `LANGFUSE_BASE_URL` in the code is `https://cloud.langfuse.com` (EU), but `.env.example` and `AGENTS.md` specify `https://us.cloud.langfuse.com` (US). When the env var is unset, traces export to the wrong region. Align the code default with the documented US cloud URL.

### Checklist

- [ ] Read `langfuse.service.ts:75` and `langfuse-instrumentation.ts:83` to find the default URL
- [ ] Change `https://cloud.langfuse.com` to `https://us.cloud.langfuse.com`
- [ ] Verify `env.validation.ts` default matches
- [ ] Run `npx tsc --noEmit`

### Acceptance criteria

- Default `LANGFUSE_BASE_URL` is `https://us.cloud.langfuse.com` in all locations
- Consistent with `.env.example` and `AGENTS.md`

---

### 2.11.2 — `createHandler()` does not pass `baseUrl` to `CallbackHandler`

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-llm.md B9

**Files:** `packages/backend/src/infrastructure/langfuse/langfuse.service.ts:92-101`

**Description:** `LangfuseService.createHandler()` creates a `CallbackHandler` without passing the `baseUrl` config. When self-hosting Langfuse, traces and prompt fetches can diverge to different endpoints. Pass `baseUrl` to the `CallbackHandler` constructor.

### Checklist

- [ ] Read `langfuse.service.ts:92-101` to find the `CallbackHandler` construction
- [ ] Add `baseUrl: this.config.baseUrl` (or equivalent) to the constructor options
- [ ] Verify with a unit test that the handler receives the correct `baseUrl`
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `CallbackHandler` receives the configured `baseUrl`
- Unit test confirms `baseUrl` is passed

---

### 2.11.3 — `PROMPT_VERSION` env var has no effect

**Status:** `[x]` | **Effort:** S | **Ref:** infrastructure-llm.md B11

**Files:** `packages/backend/src/infrastructure/langfuse/prompt-registry.ts`, `packages/backend/src/infrastructure/langfuse/langfuse.service.ts:130, 162`

**Description:** `PromptRegistry` hardcodes the prompt label to `production`, so the `PROMPT_VERSION` env var has no effect. Either wire `PROMPT_VERSION` to the label parameter in the fetch call, or rename the env var to `PROMPT_LABEL` to clarify its purpose.

### Checklist

- [ ] Read `prompt-registry.ts` to find the hardcoded `production` label
- [ ] Read `langfuse.service.ts:130, 162` to find the prompt fetch calls
- [ ] Either: read `PROMPT_VERSION` from env and pass as the label, or rename to `PROMPT_LABEL`
- [ ] Add the env var to `env.validation.ts` with default `production`
- [ ] Add a unit test that verifies the label is read from env
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `PROMPT_VERSION` (or `PROMPT_LABEL`) controls the Langfuse prompt label
- Default is `production`
- Unit test confirms env var is respected

---

### 2.11.4 — `getAvailableModels()` misclassifies paid providers as free

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-llm.md B7

**Files:** `packages/backend/src/infrastructure/llm/llm.service.ts:360-366`

**Description:** `getAvailableModels()` only treats `openai` and `anthropic` as paid providers, but Google, NVIDIA, and others are also paid. This causes the free-first fallback router to incorrectly prioritize paid providers over free ones. Update the classification to correctly identify all paid providers.

### Checklist

- [ ] Read `llm.service.ts:360-366` to find the paid/free classification
- [ ] Add all paid providers to the check (google, nvidia, openai, anthropic, etc.)
- [ ] Add a unit test that verifies provider classification
- [ ] Run `npx vitest run tests/unit/llm/`

### Acceptance criteria

- All paid providers are correctly classified
- Free-first router prioritizes correctly
- Unit test confirms classification
