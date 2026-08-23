# Phase 5 — P2: Performance

> **FROZEN CHECKLIST SNAPSHOT.** Status below is historical. Reproduce through
> `PLAN-005` before creating/updating work in `docs/planning/BACKLOG.md`.

Database query optimizations, Redis efficiency, concurrency control, and caching.

> **5.2 (`SCAN` instead of `KEYS` in orchestrator) is already fixed.** See [README.md](README.md).

---

## 5.1 — `findBySourceAndNetwork` — `sourcePath` column + index

**Status:** `[ ]` | **Effort:** S | **Ref:** infrastructure-prisma.md B5, cross-module-synthesis.md #8

**Files:** `packages/backend/prisma/schema.prisma`, `packages/backend/src/modules/posts/posts.service.ts`

**Description:** `findBySourceAndNetwork` filters posts by `sourcePath` using an in-memory JSON filter, scanning all posts and filtering in Node.js. With thousands of posts, this is O(n) in memory and slow. Add a `sourcePath` column to the `Post` model with a database index, and use a Prisma `where` clause instead of in-memory filtering.

### Checklist

- [ ] Read `posts.service.ts` to find `findBySourceAndNetwork` and the in-memory filter
- [ ] Add `sourcePath String?` column to the `Post` model in `schema.prisma`
- [ ] Add `@@index([sourcePath, network])` to the model
- [ ] Create and run a Prisma migration
- [ ] Backfill existing posts' `sourcePath` from the JSON field
- [ ] Update `findBySourceAndNetwork` to use `where: { sourcePath, network }`
- [ ] Add a unit test that verifies the query uses the column
- [ ] Run `npx vitest run tests/unit/posts/`

### Acceptance criteria

- `sourcePath` is a dedicated column with an index
- `findBySourceAndNetwork` uses a Prisma `where` clause (no in-memory filter)
- Migration is reversible

---

## 5.3 — `FlowControlService.isPaused`/`getStatus` — `MGET` instead of sequential `get`

**Status:** `[ ]` | **Effort:** XS | **Ref:** flow-control.md B6

**Files:** `packages/backend/src/modules/flow-control/flow-control.service.ts:118-120`

**Description:** `isPaused` and `getStatus` make sequential Redis `get` calls for each flow-control key. Using `MGET` (multi-get) reduces this to a single round-trip, cutting latency significantly when checking multiple pause flags.

### Checklist

- [ ] Read `flow-control.service.ts:118-120` to find the sequential `get` calls
- [ ] Replace with a single `redis.mget(...keys)` call
- [ ] Map the results back to the expected format
- [ ] Add a unit test that verifies `MGET` is used
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `isPaused` and `getStatus` use `MGET` instead of sequential `get`
- Unit test confirms single round-trip

---

## 5.4 — `RateLimitService.checkRateLimit` — Lua script for atomicity

**Status:** `[ ]` | **Effort:** S | **Ref:** rate-limit.md B1

**Files:** `packages/backend/src/modules/.../rate-limit.service.ts`

**Description:** This is the same underlying issue as task 2.7.1, but approached from the performance angle. The 3 sequential Redis `get` calls can be replaced with a single Lua script that atomically checks and increments, reducing round-trips and eliminating the race condition. This is the preferred fix over `WATCH`/`MULTI`.

### Checklist

- [ ] Write a Lua script: `local current = redis.call('GET', KEYS[1]); if tonumber(current) >= tonumber(ARGV[1]) then return 0 end; redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[2]); return 1`
- [ ] Use `redis.eval(luaScript, 1, key, limit, ttl)`
- [ ] Replace the 3 sequential `get` calls
- [ ] Add an integration test that verifies atomicity under concurrent access
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Rate limit check is a single atomic Redis call
- No race condition under concurrent access
- Integration test confirms atomicity

---

## 5.5 — `EmailReaderService` — reuse single IMAP connection during polling

**Status:** `[ ]` | **Effort:** S | **Ref:** infrastructure-email.md B1

**Files:** `packages/backend/src/infrastructure/email/email-reader.service.ts`

**Description:** `EmailReaderService` opens a new IMAP connection for each polling cycle, which is slow (TLS handshake + auth per cycle). Reuse a single persistent IMAP connection, reconnecting only on failure.

### Checklist

- [ ] Read `email-reader.service.ts` to find the connection lifecycle
- [ ] Keep the IMAP connection open between polling cycles
- [ ] Add reconnection logic on connection drop
- [ ] Add a idle timeout to close the connection if unused for a long period
- [ ] Add a unit test that verifies connection reuse
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- IMAP connection is reused between polling cycles
- Reconnection works on connection drop
- Unit test confirms reuse

---

## 5.6 — `EmailReaderService` — UID tracking (don't return stale codes)

**Status:** `[ ]` | **Effort:** S | **Ref:** infrastructure-email.md B3

**Files:** `packages/backend/src/infrastructure/email/email-reader.service.ts`

**Description:** `EmailReaderService` does not track which emails it has already processed (by UID). Every polling cycle re-reads all emails, potentially returning stale verification codes. Track the last processed UID and only fetch emails with UID > last seen.

### Checklist

- [ ] Read `email-reader.service.ts` to find the email fetching logic
- [ ] Store the last processed UID (in memory or Redis)
- [ ] Fetch only `UID > lastSeen` emails
- [ ] Update `lastSeen` after processing
- [ ] Add a unit test that verifies stale emails are not returned
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Only new emails (UID > last seen) are processed
- Stale codes are not returned
- Unit test confirms UID tracking

---

## 5.7 — `runReconciliation` — batch concurrency

**Status:** `[ ]` | **Effort:** S | **Ref:** health-monitor.md

**Files:** `packages/backend/src/modules/health-monitor/health-monitor.service.ts:125`

**Description:** This is the same issue as task 2.5.3 but from the performance angle. `runReconciliation` fires up to 1000 parallel `Promise.all` calls, causing memory spikes. Use a concurrency-limited approach (e.g., chunked `Promise.all` with batch size 10, or `p-map` with concurrency=10).

### Checklist

- [ ] Read `health-monitor.service.ts:125` to find the `Promise.all` call
- [ ] Replace with chunked processing: batch of 10, `await Promise.all(batch)`, repeat
- [ ] Or use `p-map` with `concurrency: 10` (add as dependency if not present)
- [ ] Add a unit test that verifies max concurrency
- [ ] Run `npx vitest run tests/unit/health-monitor/`

### Acceptance criteria

- Reconciliation runs with bounded concurrency (≤10)
- No memory spikes from 1000 parallel calls
- Unit test confirms concurrency limit

---

## 5.8 — `MetricsScraperService` — conditionalize delay for HTTP API sources

**Status:** `[ ]` | **Effort:** XS | **Ref:** analytics.md B9

**Files:** `packages/backend/src/modules/analytics/metrics-scraper.service.ts:164`

**Description:** `MetricsScraperService` adds a 5-15 second delay between scraping each post's metrics, designed for browser-based scraping to look human. But for HTTP API sources (e.g., X API), the delay is unnecessary and slows down the scrape significantly. Skip or reduce the delay for API-based sources.

### Checklist

- [ ] Read `metrics-scraper.service.ts:164` to find the delay logic
- [ ] Check if the source is browser-based or API-based
- [ ] Skip/reduce delay for API-based sources
- [ ] Add a unit test that verifies no delay for API sources
- [ ] Run `npx vitest run tests/unit/analytics/`

### Acceptance criteria

- API-based metric sources have no/reduced delay
- Browser-based sources retain the human-like delay
- Unit test confirms conditional delay

---

## 5.9 — `MetricsScraperService` — mutex for concurrent run protection

**Status:** `[ ]` | **Effort:** S | **Ref:** analytics.md

**Files:** `packages/backend/src/modules/analytics/metrics-scraper.service.ts`

**Description:** `MetricsScraperService` has no protection against concurrent runs. If two cron triggers overlap, they both scrape the same posts, doubling the API/browser load and potentially causing rate limit issues. Add a Redis-based mutex that prevents concurrent execution.

### Checklist

- [ ] Read `metrics-scraper.service.ts` to find the entry point
- [ ] Add a Redis-based lock (SET NX EX) at the start
- [ ] Release the lock in a `finally` block
- [ ] If lock is held, skip the run and log a warning
- [ ] Add a unit test that verifies concurrent runs are blocked
- [ ] Run `npx vitest run tests/unit/analytics/`

### Acceptance criteria

- Concurrent metric scrape runs are prevented
- Lock is released even on error
- Unit test confirms mutex behavior

---

## 5.10 — `getMergedTrending` — cache results

**Status:** `[ ]` | **Effort:** XS | **Ref:** trending.md

> **Duplicate of task 2.9.5.** See Phase 2 for details.

---

## 5.11 — `TopicGenerationService` — `createMany` + `skipDuplicates`

**Status:** `[ ]` | **Effort:** XS | **Ref:** content-source.md

**Files:** `packages/backend/src/modules/.../topic-generation.service.ts:217-229`

**Description:** `TopicGenerationService` inserts topics one by one in a loop, checking for duplicates with a `findUnique` before each insert. This is N+1 queries. Use Prisma's `createMany` with `skipDuplicates` to insert all topics in a single query.

### Checklist

- [ ] Read `topic-generation.service.ts:217-229` to find the insert loop
- [ ] Replace the loop with `prisma.topic.createMany({ data: topics, skipDuplicates: true })`
- [ ] Ensure the `topic` model has a unique constraint on the dedup field
- [ ] Add a unit test that verifies bulk insert
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Topics are inserted in a single `createMany` call
- Duplicates are skipped without errors
- Unit test confirms bulk insert

---

## 5.12 — Query telemetry middleware (slow-query logging)

**Status:** `[ ]` | **Effort:** M | **Ref:** infrastructure-prisma.md, cross-module-synthesis.md #15

**Files:** `packages/backend/src/infrastructure/prisma/prisma.service.ts`

**Description:** There is no slow-query logging in the Prisma service. Queries that take >500ms are silently slow, making performance issues hard to diagnose. Add a Prisma `$on('query')` middleware that logs queries exceeding a configurable threshold (default 500ms).

### Checklist

- [ ] Read `prisma.service.ts` to find the Prisma client initialization
- [ ] Add `prisma.$on('query', (e) => { if (e.duration > threshold) logger.warn(...) })`
- [ ] Make the threshold configurable via `SLOW_QUERY_THRESHOLD_MS` env var
- [ ] Include query duration, model, and operation in the log
- [ ] Add a unit test that verifies slow queries are logged
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Queries exceeding the threshold are logged with duration and operation
- Threshold is configurable
- Unit test confirms logging
