# Phase 6+7 — P3: Strategic Refactors & New Features (Backlog)

> **FROZEN CHECKLIST SNAPSHOT.** This is not the active feature backlog. Map surviving
> findings through `PLAN-005` into `docs/planning/FEATURES.md` / `BACKLOG.md`.

Large-scale architectural refactors and new feature development. These are long-term backlog items.

---

## Phase 6 — Strategic refactors

### 6.1 — Repository ports for Prisma

**Status:** `[ ]` | **Effort:** L

**Files:** `packages/backend/src/domain/ports/` (new), all modules using `PrismaService` directly

**Description:** Business logic currently depends directly on `PrismaClient` via `PrismaService`, which is `@Global()`. This couples the domain layer to Prisma and makes it impossible to swap databases or mock persistence in tests without a real DB. Create repository ports (`IPostRepository`, `ISessionRepository`, `IAccountRepository`, etc.) as DI tokens, with Prisma implementations in the infra layer. Business logic depends on the ports, not `PrismaService`. Remove `@Global()` from `PrismaModule` once all consumers use ports.

### Checklist

- [ ] Define `IPostRepository`, `ISessionRepository`, `IAccountRepository`, `IQueueRepository` ports in `domain/ports/`
- [ ] Create Prisma implementations in `infrastructure/prisma/repositories/`
- [ ] Bind ports to implementations in `PrismaModule`
- [ ] Refactor all services to inject ports instead of `PrismaService`
- [ ] Remove `@Global()` from `PrismaModule`
- [ ] Update all tests to mock ports instead of `PrismaService`
- [ ] Run `npx tsc --noEmit` and `npx vitest run`

### Acceptance criteria

- No business logic module imports `PrismaService` directly
- `PrismaModule` is not `@Global()`
- All persistence is abstracted behind repository ports
- Full test suite passes

---

### 6.2 — Domain ports for infra modules

**Status:** `[ ]` | **Effort:** L

**Files:** `packages/backend/src/domain/ports/` (new), infra modules

**Description:** Some infra modules (crypto, notifications, email, Redis cache) are not abstracted behind domain ports, unlike `ILlmPort`, `IBrowserPort`, `IContentPort`, `IPromptPort`. Create `ICryptoPort`, `INotificationPort`, `IEmailReaderPort`, `IRedisCache` ports and bind them to their implementations. This aligns all infra with the hexagonal pattern.

### Checklist

- [ ] Define `ICryptoPort`, `INotificationPort`, `IEmailReaderPort`, `IRedisCache` in `domain/ports/`
- [ ] Create adapter implementations in respective infra modules
- [ ] Bind ports to adapters in the infra modules
- [ ] Refactor all consumers to inject ports
- [ ] Update tests
- [ ] Run `npx tsc --noEmit` and `npx vitest run`

### Acceptance criteria

- All infra modules are abstracted behind domain ports
- No business logic depends on concrete infra classes
- Full test suite passes

---

### 6.3 — Decompose God classes

**Status:** `[ ]` | **Effort:** L

**Files:**
- `packages/backend/src/modules/generation/generation.service.ts` (1461 lines)
- `packages/backend/src/modules/sessions/sessions.service.ts` (1521 lines)
- `packages/backend/src/infrastructure/browser/browser.factory.ts` (1165 lines)
- `packages/backend/src/modules/posting/posters/x.poster.ts`

**Description:** Four classes exceed 1000 lines, making them hard to maintain, test, and reason about. Each should be split into focused services with clear single responsibilities. For `GenerationService`: split into `GenerationOrchestrator`, `PostPersistenceService`, `SimHashDedupService`, `GenerationResumeService`. For `SessionsService`: split into `SessionLifecycleService`, `LoginService`, `CookieAuthService`, `SessionHealthService`. For `BrowserFactory`: split into `BrowserLaunchService`, `BrowserPoolService`, `ResourceBlockingService`, `MemoryPrefsService`.

### Checklist (per class)

- [ ] Analyze the class responsibilities and identify natural split boundaries
- [ ] Extract focused services, each with a single responsibility
- [ ] Update DI bindings and all consumers
- [ ] Move tests to match the new service boundaries
- [ ] Ensure no functionality is lost (all tests pass)
- [ ] Run `npx tsc --noEmit` and `npx vitest run`

### Acceptance criteria

- No class exceeds ~500 lines
- Each service has a clear single responsibility
- All tests pass
- No functionality lost

---

### 6.4 — `ICheckpointSaver` port — abstract `RedisCheckpointSaver`

**Status:** `[ ]` | **Effort:** M | **Ref:** generation.md A5

**Files:** `packages/backend/src/domain/ports/checkpoint.port.ts` (new), `packages/backend/src/infrastructure/checkpoint/`

**Description:** `RedisCheckpointSaver` is used directly by `GenerationService`, coupling generation to Redis. Abstract it behind an `ICheckpointSaver` port with a Prisma or in-memory test adapter. This allows running generation tests without Redis.

### Checklist

- [ ] Define `ICheckpointSaver` port in `domain/ports/`
- [ ] Make `RedisCheckpointSaver` implement the port
- [ ] Create an `InMemoryCheckpointSaver` for tests
- [ ] Bind the port in the infra module
- [ ] Update `GenerationService` to inject the port
- [ ] Update tests to use the in-memory adapter
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/generation/`

### Acceptance criteria

- `GenerationService` depends on `ICheckpointSaver`, not `RedisCheckpointSaver`
- In-memory test adapter works without Redis
- Unit tests pass without Redis

---

### 6.5 — Key rotation for `EncryptionService`

**Status:** `[ ]` | **Effort:** M | **Ref:** infrastructure-crypto.md B6

**Files:** `packages/backend/src/infrastructure/crypto/encryption.service.ts`

**Description:** `EncryptionService` uses a single `SESSION_ENCRYPTION_KEY` with no rotation support. If the key is compromised, all encrypted data must be re-encrypted with a new key. Add a `SESSION_ENCRYPTION_KEY_OLD` env var that allows decrypting with the old key while encrypting with the new key. Add a key ID prefix to encrypted values to support multiple keys.

### Checklist

- [ ] Add `SESSION_ENCRYPTION_KEY_OLD` env var to `env.validation.ts`
- [ ] Add key ID prefix to encrypted values (e.g., `v1:keyid:...`)
- [ ] On decrypt: try current key, then old key
- [ ] On encrypt: always use current key
- [ ] Add a migration script to re-encrypt all values with the new key
- [ ] Add unit tests for: decrypt with old key, decrypt with new key, key rotation
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Old key can decrypt values encrypted with it
- New values are encrypted with the current key
- Migration script re-encrypts all values
- Unit tests cover key rotation

---

### 6.6 — `AbortSignal` support in `ILlmPort`

**Status:** `[ ]` | **Effort:** M | **Ref:** infrastructure-llm.md B16, orchestrator.md

**Files:** `packages/backend/src/domain/ports/llm.port.ts`, `packages/backend/src/infrastructure/llm/llm.service.ts`

**Description:** `ILlmPort.generateChat()` does not accept an `AbortSignal`, so LLM calls cannot be cancelled mid-flight. The orchestrator uses `Promise.race` for timeouts, which leaves the LLM request running in the background even after the timeout fires. Add `AbortSignal` support to the port and implementation, and wire it into the orchestrator's timeout logic.

### Checklist

- [ ] Add `abortSignal?: AbortSignal` to `ILlmPort.generateChat()` signature
- [ ] Pass `signal` to `model.invoke()` in `LlmService`
- [ ] Update the orchestrator to create an `AbortController` and pass its signal
- [ ] On timeout, call `abortController.abort()` to cancel the LLM request
- [ ] Update all callers of `generateChat` to pass signals where applicable
- [ ] Add unit tests for cancellation
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/`

### Acceptance criteria

- LLM calls can be cancelled via `AbortSignal`
- Orchestrator timeout actually cancels the LLM request
- No background LLM requests after timeout
- Unit tests confirm cancellation

---

### 6.7 — `INotificationPort` with multiple adapters

**Status:** `[ ]` | **Effort:** M | **Ref:** infrastructure-notifications.md

**Files:** `packages/backend/src/domain/ports/notification.port.ts` (new), `packages/backend/src/infrastructure/notifications/`

**Description:** Currently only Discord notifications are supported. Create an `INotificationPort` with adapters for Discord, email, Slack, and PagerDuty. Allow configuring which adapters are active via env vars. This enables alerting through multiple channels and avoids vendor lock-in.

### Checklist

- [ ] Define `INotificationPort` in `domain/ports/`
- [ ] Refactor `DiscordNotificationService` to implement the port
- [ ] Create `EmailNotificationAdapter`, `SlackNotificationAdapter` (stubs or full)
- [ ] Create a `NotificationService` that fans out to all active adapters
- [ ] Configure active adapters via env vars
- [ ] Add unit tests for multi-channel fan-out
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/`

### Acceptance criteria

- Notifications can be sent through multiple channels
- Active channels are configurable via env vars
- Adding a new channel only requires a new adapter

---

### 6.8 — SSE `Last-Event-ID` replay

**Status:** `[ ]` | **Effort:** M | **Ref:** infrastructure-sse.md

**Files:** `packages/backend/src/infrastructure/sse/sse.service.ts`, `packages/backend/src/modules/events/events.controller.ts`

**Description:** SSE clients that disconnect and reconnect lose any events that fired during the disconnect. Implement `Last-Event-ID` header support: store recent events in a Redis list, and on reconnect, replay events from the last seen ID. This ensures the UI doesn't miss status updates.

### Checklist

- [ ] Store each SSE event in a Redis list with an incrementing ID
- [ ] On SSE connection, check for `Last-Event-ID` header
- [ ] If present, replay events with ID > last seen from the Redis list
- [ ] Trim the Redis list to a reasonable size (e.g., last 100 events)
- [ ] Add a unit test that verifies replay on reconnect
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Reconnecting SSE clients receive missed events
- Event history is bounded (no unbounded Redis growth)
- Unit test confirms replay

---

### 6.9 — Alert batching/cooldown — prevent Discord spam

**Status:** `[ ]` | **Effort:** M | **Ref:** infrastructure-notifications.md

**Files:** `packages/backend/src/infrastructure/notifications/discord-notification.service.ts`

**Description:** During an alert storm (e.g., multiple sessions banned simultaneously), Discord gets spammed with individual alerts. Add alert batching: collect alerts for a configurable window (e.g., 30 seconds), then send a single batched embed. Also add a per-alert-type cooldown to prevent repeated alerts for the same issue.

### Checklist

- [ ] Add a batching buffer that collects alerts for a configurable window
- [ ] Send a batched embed at the end of the window
- [ ] Add per-alert-key cooldown (e.g., `session:banned:123` → 5 min cooldown)
- [ ] Make the window and cooldown configurable via env vars
- [ ] Add unit tests for batching and cooldown
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Alerts are batched during alert storms
- Repeated alerts for the same issue are suppressed during cooldown
- Discord webhook is not spammed

---

## Phase 7 — New features

### 7.1 — Dynamic ephemeris data for trending

**Status:** `[ ]` | **Effort:** M

**Files:** `packages/backend/src/modules/trending/`

**Description:** The trending module uses a hardcoded `ASTRO_EVENTS_2026` calendar for astrology events. This will go stale after 2026. Replace with a dynamic ephemeris API or a regularly-updated data source. Consider using a Swiss Ephemeris library or an astrology API.

### Checklist

- [ ] Research available ephemeris APIs or libraries for Node.js
- [ ] Replace the hardcoded calendar with dynamic data fetching
- [ ] Cache ephemeris data with a long TTL (daily refresh)
- [ ] Add a fallback to the hardcoded calendar if the API is unavailable
- [ ] Add unit tests for dynamic data fetching
- [ ] Run `npx vitest run tests/unit/trending/`

### Acceptance criteria

- Astrology events are fetched dynamically, not hardcoded
- Fallback works when API is unavailable
- Data stays current without code changes

---

### 7.2 — Performance-based recycling

**Status:** `[ ]` | **Effort:** S | **Ref:** recycling.md

**Files:** `packages/backend/src/modules/.../recycling.service.ts`

**Description:** `findRecyclablePosts` sorts by recency, not by engagement metrics. High-performing posts that could be recycled for maximum impact are not prioritized. Sort by engagement metrics (likes + retweets + replies) to recycle the best-performing posts first.

### Checklist

- [ ] Read `recycling.service.ts` to find `findRecyclablePosts`
- [ ] Change the sort to use engagement metrics
- [ ] Consider a configurable sort metric (recency vs. engagement vs. hybrid)
- [ ] Add a unit test with posts of varying engagement
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Recyclable posts are sorted by engagement
- High-performing posts are prioritized for recycling

---

### 7.3 — Language rotation in recycling

**Status:** `[ ]` | **Effort:** S

**Files:** `packages/backend/src/modules/.../recycling.service.ts`, `packages/backend/src/modules/generation/generation.service.ts`

**Description:** `repurposeFromArticles` and `recycleTopPosts`/`recycleById` are hardcoded to `en`. When multiple posting languages are configured, recycled content is only generated in English. Rotate through configured languages or generate in all configured languages.

### Checklist

- [ ] Read the recycling methods to find the hardcoded `en`
- [ ] Use `POSTING_LANGUAGES` config to determine target languages
- [ ] Generate recycled content in all configured languages
- [ ] Add a unit test with multiple languages
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Recycled content is generated in all configured posting languages
- No hardcoded language in recycling methods

---

### 7.4 — `own-post` source — implement or remove

**Status:** `[ ]` | **Effort:** S | **Ref:** engagement.md B26

**Files:** `packages/backend/src/modules/engagement/`

**Description:** The engagement module has an `own-post` source type that is declared but not implemented. Engagement actions targeting the bot's own posts (e.g., pinning, quoting) don't work because the post URL is never resolved. Either implement URL resolution from the account handle, or remove the source type to avoid confusion.

### Checklist

- [ ] Read the engagement source configuration to find `own-post`
- [ ] Decide: implement or remove
- [ ] If implementing: resolve the bot's own post URLs from the account handle + post ID
- [ ] If removing: delete the source type and update config
- [ ] Add/update unit tests
- [ ] Run `npx vitest run tests/unit/engagement/`

### Acceptance criteria

- `own-post` source either works or is removed
- No dead configuration options

---

### 7.5 — Per-account rate limit keys

**Status:** `[ ]` | **Effort:** S | **Ref:** rate-limit.md

**Files:** `packages/backend/src/modules/.../rate-limit.service.ts`

**Description:** Rate limit keys are per-network (e.g., `rate_limit:x`), not per-account. If multiple X accounts are configured, they share a single rate limit counter. Change keys to per-account (e.g., `rate_limit:x:username`) so each account has its own limit.

### Checklist

- [ ] Read `rate-limit.service.ts` to find the key construction
- [ ] Include the account identifier (username/handle) in the key
- [ ] Update all callers to pass the account identifier
- [ ] Add a unit test with multiple accounts
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Each account has its own rate limit counter
- Multiple accounts on the same network don't share limits

---

### 7.6 — `SOCIAL_{NETWORK}_ACTIVE` env — env-driven active flag

**Status:** `[ ]` | **Effort:** XS | **Ref:** accounts.md

**Files:** `packages/backend/src/modules/accounts/`, `env.validation.ts`

**Description:** Account active/inactive status is only configurable via the database. Add `SOCIAL_X_ACTIVE`, `SOCIAL_THREADS_ACTIVE`, `SOCIAL_FACEBOOK_ACTIVE` env vars to allow toggling accounts without DB access. The env var overrides the DB value when set.

### Checklist

- [ ] Add `SOCIAL_{NETWORK}_ACTIVE` env vars to `env.validation.ts` (default: true)
- [ ] Read the env vars in the accounts service
- [ ] If env var is `false`, mark the account as inactive regardless of DB status
- [ ] Add a unit test that verifies env override
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Accounts can be toggled via env vars
- Env var overrides DB status

---

### 7.7 — `bannedAt` field on `Session` model

**Status:** `[ ]` | **Effort:** S | **Ref:** health-monitor.md A5/F2

**Files:** `packages/backend/prisma/schema.prisma`, `packages/backend/src/modules/health-monitor/`

**Description:** The `Session` model has no `bannedAt` field, so ban recovery uses `updatedAt` which can be updated by unrelated changes. Add a `bannedAt DateTime?` field that is set when a session is marked as banned and cleared when recovered. This enables correct ban duration calculation (see task 2.5.1).

### Checklist

- [ ] Add `bannedAt DateTime?` to the `Session` model in `schema.prisma`
- [ ] Create and run a Prisma migration
- [ ] Set `bannedAt` when a session is marked as `BANNED`
- [ ] Clear `bannedAt` when a session is recovered
- [ ] Update `checkBanRecovery` to use `bannedAt` instead of `updatedAt` (fixes task 2.5.1)
- [ ] Add unit tests
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `bannedAt` is set on ban and cleared on recovery
- Ban recovery uses `bannedAt` for duration calculation
- Migration is clean and reversible

---

### 7.8 — `/health/metrics` — Prometheus metrics endpoint

**Status:** `[ ]` | **Effort:** M | **Ref:** health.md F5

**Files:** `packages/backend/src/modules/health/`

**Description:** There is no Prometheus metrics endpoint for monitoring. Add a `/health/metrics` endpoint that exposes Prometheus-format metrics: posts generated, posts posted, posts failed, active sessions, queue depth, LLM provider status, etc. Use `prom-client` library.

### Checklist

- [ ] Install `prom-client` package
- [ ] Define metrics: counters (posts generated/posted/failed), gauges (active sessions, queue depth), histograms (LLM latency)
- [ ] Instrument key services to update metrics
- [ ] Add `/health/metrics` endpoint that returns `register.metrics()`
- [ ] Add the endpoint to public routes (no auth for scraping)
- [ ] Add a unit test that verifies metrics are exposed
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `/health/metrics` returns Prometheus-format metrics
- Key operational metrics are tracked
- Endpoint is accessible without auth (for Prometheus scraping)

---

### 7.9 — Webhook health check / canary alert

**Status:** `[ ]` | **Effort:** S | **Ref:** infrastructure-notifications.md

**Files:** `packages/backend/src/infrastructure/notifications/`

**Description:** There is no way to verify that the Discord webhook is alive without waiting for a real alert. Add a periodic canary alert (e.g., every 6 hours) that sends a test message to the webhook. If the canary fails, log an error. This provides early detection of webhook misconfiguration.

### Checklist

- [ ] Add a cron job that sends a canary message every 6 hours
- [ ] If the canary send fails, log an error and emit a health event
- [ ] Make the interval configurable via env var
- [ ] Add a unit test for the canary
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Canary alert is sent periodically
- Webhook failures are detected early
- Interval is configurable

---

### 7.10 — `impressions` in metrics history endpoint

**Status:** `[ ]` | **Effort:** XS | **Ref:** analytics.md

**Files:** `packages/backend/src/modules/analytics/analytics.controller.ts`, `analytics.service.ts`

**Description:** The metrics history endpoint returns likes, retweets, and replies but not impressions. Impressions are available in the metrics data but not exposed in the API response. Add `impressions` to the response DTO.

### Checklist

- [ ] Read the metrics history endpoint to find the response shape
- [ ] Add `impressions` to the response
- [ ] Verify the field is populated from the metrics data
- [ ] Add a unit test
- [ ] Run `npx vitest run tests/unit/analytics/`

### Acceptance criteria

- Metrics history endpoint includes `impressions`
- Field is populated from scraped data
