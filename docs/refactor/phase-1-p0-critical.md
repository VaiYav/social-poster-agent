# Phase 1 — P0: Critical Bugs and Resource Leaks

Production blockers, resource leaks, data corruption risks. These should be done first.

---

## 1.1 — Close `BrowserContext` leak in `SessionsService`

**Status:** `[ ]` | **Effort:** S | **Ref:** infrastructure-browser.md B1

**Files:** `packages/backend/src/modules/sessions/sessions.service.ts:328-392, 453+`

**Description:** `tryCookieAuth` and `autoLogin` call `browser.createContext()` for X/Threads, close the `page` with `page.close()`, but never close the `context` itself. Every login attempt or cookie-auth check leaks a full Camoufox/Firefox process (~340-500 MB RSS each). Over time this exhausts system memory and degrades all browser automation. The fix is to wrap the context usage in a `try/finally` block that always calls `await context?.close()`.

### Checklist

- [ ] Read `sessions.service.ts` and locate all `browser.createContext()` call sites in `tryCookieAuth` and `autoLogin`
- [ ] For each call site, wrap the body in `try { ... } finally { await context?.close() }`
- [ ] Ensure `page.close()` is called before `context.close()` in the `finally` block
- [ ] Verify that the `storageState` extraction (if any) happens before `context.close()`
- [ ] Add a unit test that mocks `browser.createContext()` and verifies `context.close()` is called on both success and error paths
- [ ] Run `npx vitest run tests/unit/sessions/` to verify no regressions

### Acceptance criteria

- No `browser.createContext()` call in `sessions.service.ts` lacks a `finally` block with `context.close()`
- Unit test confirms context is closed on both success and error paths
- `npx tsc --noEmit` passes

---

## 1.2 — `EngagementService.performInteraction` memory leak

**Status:** `[ ]` | **Effort:** S | **Ref:** engagement.md B1

**Files:** `packages/backend/src/modules/engagement/engagement.service.ts:205-272`

**Description:** `performInteraction` creates a browser context and page but has no `finally` block. When an error occurs during the interaction (like, comment, quote), the context and page are never closed, leaking a Camoufox process. This is especially severe because engagement runs repeatedly in a loop. Add a `finally` block that closes the page and releases/closes the context, using the appropriate pool release method if the context came from a pool.

### Checklist

- [ ] Read `engagement.service.ts:205-272` to understand context acquisition (pooled vs. created)
- [ ] Determine whether context comes from `browserPool.acquire()` or `browser.createContext()`
- [ ] Add `try { ... } finally { await page?.close(); await context?.close() }` (or `pool.release(context)` if pooled)
- [ ] Ensure the `finally` block does not throw if `page` or `context` is already null/undefined
- [ ] Add a unit test that triggers an error mid-interaction and verifies cleanup
- [ ] Run `npx vitest run tests/unit/engagement/` to verify

### Acceptance criteria

- `performInteraction` always cleans up browser resources on both success and error paths
- Unit test confirms cleanup on error path
- `npx tsc --noEmit` passes

---

## 1.3 — Prisma transaction timeout for multi-post generation

**Status:** `[ ]` | **Effort:** XS | **Ref:** infrastructure-prisma.md B4, cross-module-synthesis.md #2

**Files:** `packages/backend/src/modules/generation/generation.service.ts:799, 882`, `packages/backend/src/infrastructure/prisma/prisma.service.ts`

**Description:** The `$transaction` call in `persistGeneratedPosts` uses the default 5-second timeout. When generating multiple posts in a single batch (3 networks × N topics), the thread assembly and SimHash dedup queries can exceed 5 seconds, causing the transaction to abort mid-write. This leaves partial data in the database. Pass `timeout: 30000` (or use `PRISMA_TRANSACTION_TIMEOUT_MS` env var) to the transaction options.

### Checklist

- [ ] Read `generation.service.ts` around lines 799 and 882 to find all `$transaction` calls
- [ ] Read `prisma.service.ts` to check if `PRISMA_TRANSACTION_TIMEOUT_MS` is already declared
- [ ] Add `timeout` to the `$transaction` options object: `{ timeout: 30000 }` or read from `ConfigService`
- [ ] If using env var, add it to `env.validation.ts` with a sensible default (30000)
- [ ] Verify the transaction still works with a unit/integration test
- [ ] Run `npx vitest run tests/unit/generation/` to verify

### Acceptance criteria

- All `$transaction` calls in `generation.service.ts` have an explicit `timeout` ≥ 30000ms
- No transaction timeout errors in integration tests
- `npx tsc --noEmit` passes

---

## 1.4 — Redis lifecycle: error listeners + OnModuleDestroy

**Status:** `[ ]` | **Effort:** S | **Ref:** infrastructure-redis.md B1, cross-module-synthesis.md #4

**Files:** `packages/backend/src/infrastructure/redis/redis.module.ts`

**Description:** The Redis module creates IORedis instances but does not attach `error` event listeners. Unhandled `error` events on Redis connections crash the Node.js process. Additionally, there is no `OnModuleDestroy` hook to call `redis.quit()`, so shutdown hangs waiting for connections to time out. Add `redis.on('error', ...)` handlers and implement `OnModuleDestroy` to gracefully close all connections.

### Checklist

- [ ] Read `redis.module.ts` to find all Redis connection creation sites
- [ ] Add `redis.on('error', (err) => this.logger.error(...))` to each connection
- [ ] Implement `OnModuleDestroy` interface with `await redis.quit()` for each connection
- [ ] Add `connectionName` to each IORedis instance for debugging (e.g., `spa:queue`, `spa:sse-pub`, `spa:sse-sub`)
- [ ] Ensure `quit()` errors are caught (connection may already be closed)
- [ ] Add a unit test that verifies `onModuleDestroy` calls `quit` on all connections
- [ ] Run `npx vitest run tests/unit/` to verify no regressions

### Acceptance criteria

- All Redis connections have `error` event listeners
- `OnModuleDestroy` gracefully closes all connections
- No unhandled Redis `error` events crash the process
- `npx tsc --noEmit` passes

---

## 1.5 — LLM response cache key incomplete

**Status:** `[ ]` | **Effort:** S | **Ref:** infrastructure-llm.md B4

**Files:** `packages/backend/src/infrastructure/llm/llm.service.ts:639-649`

**Description:** The SHA256 cache key for LLM responses only includes the message content but omits `maxTokens`, `provider/model`, and `role` (system vs. user). This means a cached response from a request with `maxTokens=100` can be returned for a subsequent request with `maxTokens=500`, producing truncated or wrong-length output. It also means responses from different providers/models are interchangeable in the cache. Add these fields to the hash input.

### Checklist

- [ ] Read `llm.service.ts:639-649` to find the cache key construction
- [ ] Add `maxTokens`, `model` (provider+model name), and `role` to the hash input string
- [ ] Consider adding `temperature` as well (reasoning models omit it, but it affects output)
- [ ] Verify the cache still works with a unit test (same params → cache hit, different params → cache miss)
- [ ] Run `npx vitest run tests/unit/llm/` to verify

### Acceptance criteria

- Cache key includes `maxTokens`, `model`, `role`, and `temperature`
- Unit test confirms different params produce cache misses
- `npx tsc --noEmit` passes

---

## 1.6 — Queue: delayed jobs not removed before re-enqueue

**Status:** `[ ]` | **Effort:** XS | **Ref:** queue.md B3/B4

**Files:** `packages/backend/src/infrastructure/queue/queue.factory.ts:188-196`

**Description:** `clearCompletedAndFailedJobs` removes only `completed` and `failed` jobs, but not `delayed` jobs. When a post is re-approved or re-scheduled, the new enqueue with the same `jobId` is silently ignored by BullMQ because a delayed job with that ID already exists. This means re-scheduled posts never get posted. Add delayed job removal to the cleanup function.

### Checklist

- [ ] Read `queue.factory.ts:188-196` to find `clearCompletedAndFailedJobs`
- [ ] Add `await queue.getDelayed()` and remove those jobs too
- [ ] Consider also removing `active` and `waiting` jobs if the use case requires it
- [ ] Add a unit test that creates a delayed job, runs cleanup, and verifies it's removed
- [ ] Run `npx vitest run tests/unit/queue/` to verify

### Acceptance criteria

- `clearCompletedAndFailedJobs` also removes `delayed` jobs
- Re-enqueue with same `jobId` after cleanup succeeds
- Unit test confirms delayed job removal
- `npx tsc --noEmit` passes
