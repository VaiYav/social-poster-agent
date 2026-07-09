# Action Plan — SPA Backend

Consolidated work plan derived from the per-module deep reviews in `docs/reviews/` and the cross-module synthesis. Every item traces back to a specific finding in the corresponding review file.

> **⚠️ This is a living document.** The reviews it is based on were written against snapshots of `packages/backend/src/` and may drift behind active commits. Before implementing any item, re-verify the file/line references against the current source. See `CLAUDE.md` — "The docs lag the code — trust source, not prose".

## Priority levels

- **P0** — production blockers, resource leaks, data corruption risks
- **P1** — correctness bugs that produce wrong behavior
- **P2** — stability, security, env validation, architecture, performance
- **P3** — strategic refactors and new features (backlog)

## Effort

- **XS** — under 1 hour
- **S** — 1-4 hours
- **M** — 1-2 days
- **L** — 3+ days

---

## Phase 1 — P0: Critical bugs and resource leaks

| # | Task | File(s) | Effort | Description |
|---|------|---------|--------|-------------|
| 1.1 | Close `BrowserContext` leak in `SessionsService` | `sessions.service.ts:328-392, 453+` | S | `tryCookieAuth` and `autoLogin` call `browser.createContext()` for X/Threads, close `page.close()`, but **never close `context`**. Every login/cookie-auth leaks a Camoufox/Firefox process. Add `finally { await context?.close() }`. (infrastructure-browser.md B1) |
| 1.2 | `EngagementService.performInteraction` memory leak | `engagement.service.ts:205-272` | S | No `finally` block — on error, context/page are not closed. Add `finally` with `page.close()` + `context.close()` (or `releaseContext`). (engagement.md B1) |
| 1.3 | Prisma transaction timeout for multi-post generation | `generation.service.ts:799, 882`, `prisma.service.ts` | XS | `$transaction` uses default 5s timeout — multi-post thread assembly can time out mid-write. Add `timeout: 30000` to `transactionOptions`. (infrastructure-prisma.md B4, cross-module-synthesis.md #2) |
| 1.4 | Redis lifecycle: error listeners + OnModuleDestroy | `redis.module.ts` | S | No `on('error')`, no `OnModuleDestroy` cleanup → process crashes and shutdown hangs. Add listeners + `await redis.quit()` in `onModuleDestroy`. (infrastructure-redis.md B1, cross-module-synthesis.md #4) |
| 1.5 | LLM response cache key incomplete | `llm.service.ts:639-649` | S | Cache key omits `maxTokens`, `provider/model`, `role` → can return wrong-length or wrong-attributed response. Add to hash input. (infrastructure-llm.md B4) |
| 1.6 | Queue: delayed jobs not removed before re-enqueue | `queue.factory.ts:188-196` | XS | `clearCompletedAndFailedJobs` removes only `completed`/`failed`, not `delayed`. Re-enqueue with same `jobId` is silently ignored by BullMQ. Add delayed job removal. (queue.md B3/B4) |

---

## Phase 2 — P1: Correctness bugs

### 2.1 Posting & Queue

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.1.1 | `retryable` flag not set for poster errors → BullMQ retries non-retryable errors | `posting.service.ts:393-396`, `posting.service.ts:520-539`, queue worker | S | posting.md B10 | `postFn` returns plain `error` strings; catch-all also drops `SpaError` retryability. Add explicit `retryable: false` for validation/selector errors. |
| 2.1.2 | `schedulePosting` uses general retry config instead of posting config | `queue.factory.ts` | XS | queue.md |
| 2.1.3 | `QueueController.getFailed` exposes raw `Job` objects | `queue.controller.ts` | XS | queue.md B8 |

### 2.2 Autonomy & Auto-approve

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.2.1 | Verify `qualityScore` missing-score fallback design | `auto-approve.service.ts:113-120` | XS | autonomy.md B2 | Currently fail-open: missing score defaults to `AUTO_APPROVE_MIN_SCORE` and auto-approves if `AutoCheck` passed. Accept or switch to `HUMAN_REVIEW`; if accepted, close this as intentional. |
| 2.2.2 | `loadRecentHashes` includes FAILED/REJECTED + no `orderBy` | `auto-check.service.ts:136-147` | XS | autonomy.md B15/B16 |
| 2.2.3 | `checkRejectStreak` not truly consecutive | `auto-approve.service.ts:216-220` | S | autonomy.md B1 |
| 2.2.4 | Remove unused `PostsService` from `AutoApproveListener` | `auto-approve.listener.ts:39` | XS | autonomy.md B21 |

### 2.3 Posts & Events

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.3.1 | `approve` with `editedContent` does not update `simhash` or re-run AutoCheck | `posts.service.ts:172-174`, `posts.service.ts:179-184` | S | posts.md S7/S8, F3/F4 |
| 2.3.2 | `updateStatus` allows arbitrary transitions — no state machine | `posts.service.ts:111-139` | S | posts.md B4 |
| 2.3.3 | `PostEvents.REJECTED` never emitted | `posts.service.ts:192-205` | XS | posts.md B12, events.md B1 |
| 2.3.4 | Duplicate `post_status` SSE events — `posting.service.ts` publishes directly + `SseEventListener` republishes | `posting.service.ts`, `sse-event.listener.ts` | S | events.md B3, infrastructure-sse.md B1 |
| 2.3.5 | `SseEventListener` does not await `publish` → unhandled promise rejections | `sse-event.listener.ts` | XS | events.md B2, infrastructure-sse.md B2 |

### 2.4 Sessions

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.4.1 | Circuit breaker does not record `null` failures — `autoLogin` returning `null` does not trip breaker | `sessions.service.ts` | S | sessions.md |
| 2.4.2 | `healthCheck` does not expire sessions on nav errors — returns `healthy: false` but status stays ACTIVE | `sessions.service.ts:1389-1391` | XS | sessions.md B29 |
| 2.4.3 | `WARMUP` is already in the Prisma `SessionStatus` enum — remove `as SessionStatus` casts in `WarmupService`/`SessionsService` | `warmup.service.ts`, `sessions.service.ts` | XS | sessions.md |
| 2.4.4 | `SessionsController` `healthCheck` / `submitVerifyCode` accept `network` as a string literal union — add `ParseEnumPipe` for runtime hardening | `sessions.controller.ts` | XS | sessions.md B27 |

### 2.5 Health Monitor

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.5.1 | `checkBanRecovery` uses `createdAt` instead of `updatedAt`/`bannedAt` → reactivates newly banned sessions | `health-monitor.service.ts:549` | S | health-monitor.md A5 |
| 2.5.2 | `getDashboard` calls `runHealthCheck()` which emits alerts → spam on every dashboard open | `health-monitor.service.ts:519` | S | health-monitor.md |
| 2.5.3 | `runReconciliation` 1000 parallel calls + re-enqueues `completed` jobs | `health-monitor.service.ts:125` | S | health-monitor.md |

### 2.6 Orchestrator

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.6.1 | `WAIT` action `sleepMs` ignored — hardcoded 120s | `orchestrator.graph.ts:223` | XS | orchestrator.md |
| 2.6.2 | `resetCheckpoint` deletes ALL checkpoints (KEYS pattern) | `orchestrator.service.ts:170` | S | orchestrator.md, infrastructure-redis.md B3 |
| 2.6.3 | `stop()`/`start()` race — can start two `runGraphLoop()` | `orchestrator.service.ts:128-157` | S | orchestrator.md B4 |
| 2.6.4 | LLM timeout not cancellable — `Promise.race` does not cancel request | `llm-decision.service.ts:69-76` | M | orchestrator.md, infrastructure-llm.md B16 |

### 2.7 Rate Limit

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.7.1 | Non-atomic check/record — 3 sequential Redis `get` without WATCH/MULTI → race condition | `rate-limit.service.ts:158,167,176` | S | rate-limit.md B1 |
| 2.7.2 | `0` handling — `Number(...) || default` treats `0` as falsy | `rate-limit.service.ts:76-79` | XS | rate-limit.md B8 |
| 2.7.3 | Fail-open on Redis down — no fail-closed option | `rate-limit.service.ts:144-146` | XS | rate-limit.md |

### 2.8 Content & Generation

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.8.1 | `DbContentReader.markUsed` never called → topics reused | `content-reader.ts`, `generation.service.ts` | S | content-source.md |
| 2.8.2 | `ContentPillarTracker` TTL refresh = non-rolling window + records drafts | `content-pillar.tracker.ts:177-181` | S | content-enhancements.md B1, S51-S53 |
| 2.8.3 | Recycling: `recycled` flag set before generation success | `generation.service.ts:562-565` | XS | recycling.md B10 |
| 2.8.4 | Recycling: SimHash threshold inconsistent with GenerationService | `recycling.service.ts` | XS | recycling.md |
| 2.8.5 | `ABVariantGenerator` hashtag regex ASCII-only — misses Cyrillic | `ab-variant.generator.ts:254` | XS | content-enhancements.md B8 |
| 2.8.6 | `getDailyStats` uses `createdAt` instead of `postedAt` | `analytics.service.ts:84` | XS | analytics.md |
| 2.8.7 | `getTopPosts` sorts by recency, not engagement | `analytics.service.ts:120-124` | XS | analytics.md |

### 2.9 Replies & Trending

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.9.1 | Self-reply detection broken — handle comparison may match others | `replies-monitor.service.ts:414-416` | S | replies.md |
| 2.9.2 | Original post scraped as comment | `replies-monitor.service.ts` | S | replies.md |
| 2.9.3 | `runMonitoringCycle` ignores flow control | `replies-monitor.service.ts` | XS | replies.md |
| 2.9.4 | `page.evaluate` uses Playwright `:has-text` selector (invalid in browser) | `trending-scraper.service.ts:76` | S | trending.md |
| 2.9.5 | `getMergedTrending` not cached | `trending.service.ts` | XS | trending.md |

### 2.10 Engagement

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.10.1 | Quote generation uses `ENGAGEMENT_COMMENT_TEMPERATURE` instead of `ENGAGEMENT_QUOTE_TEMPERATURE` at line 261 | `engagement-decision.service.ts:261` | XS | engagement.md B24 |
| 2.10.2 | `EngagementDecisionService` reads `ENGAGEMENT_*_TEMPERATURE` from `process.env` at module load — should use `ConfigService` | `engagement-decision.service.ts:34-35` | XS | engagement.md B24 |

### 2.11 LLM / Langfuse / Prompts

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 2.11.1 | Langfuse base URL default is EU `https://cloud.langfuse.com` while `.env.example` and `AGENTS.md` specify US `https://us.cloud.langfuse.com` — traces export to wrong region when `LANGFUSE_BASE_URL` is unset | `langfuse.service.ts:75`, `langfuse-instrumentation.ts:83` | XS | infrastructure-llm.md B8 |
| 2.11.2 | `LangfuseService.createHandler()` does not pass `baseUrl` to `CallbackHandler` — traces and prompt fetches can diverge to different endpoints when self-hosted | `langfuse.service.ts:92-101` | XS | infrastructure-llm.md B9 |
| 2.11.3 | `PromptRegistry` hardcodes prompt label to `production`, so `PROMPT_VERSION` env var has no effect — either wire `PROMPT_VERSION` to the label or rename the env | `prompt-registry.ts`, `langfuse.service.ts:130`, `:162` | S | infrastructure-llm.md B11 |
| 2.11.4 | `getAvailableModels()` misclassifies paid providers as free (only `openai`/`anthropic` treated as paid) | `llm.service.ts:360-366` | XS | infrastructure-llm.md B7 |

---

## Phase 3 — P2: Stability, Security, Env Validation

### 3.1 Env validation gaps (batch quick-win)

| # | Task | Effort |
|---|------|--------|
| 3.1.1 | `DATABASE_URL` — validate as PostgreSQL URI | XS |
| 3.1.2 | `REDIS_URL` — validate as URI | XS |
| 3.1.3 | `DISCORD_WEBHOOK_URL`, `DISCORD_ALERTS_ENABLED` | XS |
| 3.1.4 | `SSE_CHANNEL` — declare + align default with `.env.example` (`spa:sse` vs `spa:events`) | XS |
| 3.1.5 | `CAMOUFOX_*`, `BROWSER_*`, `PROXY_*`, `CAPTCHA_*` — numeric checks | S |
| 3.1.6 | `RATE_LIMIT_PREFIX`, `CHECKPOINT_*`, `HOOK_*` — declare | S |
| 3.1.7 | `PRISMA_CONNECTION_LIMIT`, `PRISMA_POOL_TIMEOUT_MS`, `PRISMA_TRANSACTION_TIMEOUT_MS` | S |

### 3.2 Security

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 3.2.1 | Admin role guard on `FlowControlController` | `flow-control.controller.ts` | S | flow-control.md S1 |
| 3.2.2 | Admin role guard on `HealthMonitorController` | `health-monitor.controller.ts` | S | health-monitor.md |
| 3.2.3 | `debug-sentry` endpoint — guard or remove from production | `health.controller.ts:56` | XS | health.md B3 |
| 3.2.4 | Rate limiting on `POST /auth/login` | `auth.controller.ts` | S | auth.md |
| 3.2.5 | `/auth/logout` add to public routes | `jwt-auth.guard.ts:35` | XS | auth.md B2 |
| 3.2.6 | `/auth/me` return default admin when `AUTH_ENABLED=false` | `auth.controller.ts:84-87` | XS | auth.md B7 |
| 3.2.7 | SSE connection limits + rate limiting | `sse.service.ts`, `events.controller.ts` | S | events.md S3, infrastructure-sse.md |
| 3.2.8 | Stop logging partial API keys in `LlmService.onModuleInit` | `llm.service.ts` | XS | infrastructure-llm.md B17 |
| 3.2.9 | `sanitizeUntrustedInput` in all prompt builders with external text | `engagement-decision.service.ts`, `replies-monitor.service.ts` | S | infrastructure-llm.md B12 |
| 3.2.10 | `JwtAuthGuard` — replace `endsWith` with `@Public()` decorator + `Reflector` | `jwt-auth.guard.ts` | S | auth.md |

### 3.3 Infrastructure hardening

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 3.3.1 | `PrismaClientExceptionFilter` — P2002/P2025/P2024 → HTTP exceptions | `infrastructure/filters` | S | infrastructure-prisma.md B3 |
| 3.3.2 | `PrismaService` — connection pool tuning (`connection_limit`, `pool_timeout`) | `prisma.service.ts` | S | infrastructure-prisma.md |
| 3.3.3 | `SseService.publish` — catch Redis errors internally (fire-and-forget safe) | `sse.service.ts` | XS | infrastructure-sse.md B3 |
| 3.3.4 | Discord notifications — retry (2 attempts) + circuit breaker | `discord-notification.service.ts` | S | infrastructure-notifications.md |
| 3.3.5 | Discord embed fields — truncate to 1024 chars | `discord-notification.service.ts` | XS | infrastructure-notifications.md |
| 3.3.6 | `EncryptionService` — strict 64-hex key validation (share regex with env.validation) | `encryption.service.ts` | XS | infrastructure-crypto.md B1 |
| 3.3.7 | `isEncrypted` — improve check (part count + hex validation) | `encryption.service.ts` | XS | infrastructure-crypto.md B5 |
| 3.3.8 | Camoufox patch — fail fast in production if patch not applied | `browser.factory.ts` | S | infrastructure-browser.md |
| 3.3.9 | `QueueFactory` — reuse `SHARED_REDIS` connections instead of creating own | `queue.factory.ts:120-131` | M | infrastructure-redis.md B2, cross-module-synthesis.md #5 |

### 3.4 Health endpoint

| # | Task | Effort | Ref |
|---|------|--------|-----|
| 3.4.1 | Split `/health` → `/health/live` (200 always) + `/health/ready` (503 on degraded) | S | health.md B2/A1/F1 |
| 3.4.2 | `HEALTH_CHECK_TIMEOUT_MS` — env-driven instead of hardcoded 2000 | XS | health.md B1/F2 |

---

## Phase 4 — P2: Architecture & DRY

### 4.1 `process.env` → `ConfigService` (batch)

Affected modules (does NOT include intentional reads from AGENTS.md: `getEnabledNetworks`, `isOrchestratorEnabled`, `app.module.ts`):

| Module | Variables | Effort |
|--------|-----------|--------|
| `GenerationService` | `POSTING_LANGUAGES`, `JUDGE_REFINE_THRESHOLD`, `DEDUP_SINCE_DAYS`, `GENERATION_TEMPERATURE_*` | S |
| `SessionsService` | `CAMOUFOX_HEADLESS`, `SESSION_RELOGIN_CRON`, `SPA_DRY_RUN` | S |
| `XPoster` / `BasePoster` | `SOCIAL_X_USERNAME`, `THREAD_CONTINUATION_DELAY_MS` | S |
| `EngagementDecisionService` | `ENGAGEMENT_COMMENT_TEMPERATURE`, `ENGAGEMENT_QUOTE_TEMPERATURE` | XS |
| `RepliesMonitorService` | `REPLIES_TEMPERATURE` | XS |
| `MetricsScraperService` | `METRICS_SCRAPER_ENABLED`, `METRICS_SCRAPER_SCHEDULE` | XS |
| `RecyclingService` | `RECYCLING_CRON_ENABLED`, `RECYCLING_CRON_SCHEDULE` | XS |
| `HookPerformanceBank` | `HOOK_BANK_AGGREGATE_SCHEDULE` | XS |
| `AutonomousRunnerService` | `AUTONOMOUS_RUNNER_SCHEDULE` | XS |
| `EmailReaderService` | `EMAIL_*` | XS |

### 4.2 DRY / Single source of truth

| # | Task | Effort | Ref |
|---|------|--------|-----|
| 4.2.1 | `NETWORK_LIMITS` — extract to single config (duplicated in `auto-check.service.ts` and `posts.service.ts`) | S | autonomy.md B17, posts.md |
| 4.2.2 | `persistGeneratedPosts()` — extract helper (duplicated in `generate`, `resumeRun`, `resumeWithReview`) | S | generation.md A1 |
| 4.2.3 | `CircuitBreakerRegistry` — either use it or remove it (created but not wired) | XS | posting.md B1 |

### 4.3 Inline prompts → Langfuse Prompt Management

| Prompt | File | Effort |
|--------|------|--------|
| Topic generation prompt | `topic-generation.service.ts:109-131` | S |
| Reply prompt | `replies-monitor.service.ts` | S |
| Trending relevance prompt | `trending-scraper.service.ts` | S |
| Engagement comment/quote prompts | `engagement-decision.service.ts` | S |

### 4.4 Module boundaries

| # | Task | Effort | Ref |
|---|------|--------|-----|
| 4.4.1 | `AutoApproveListener` → move to `modules/autonomy` | S | events.md A1, cross-module-synthesis.md #11 |
| 4.4.2 | LLM endpoints (`/models`, `/provider-status`, `/reset-circuit-breakers`) → extract from `GenerationController` to `LlmController` | S | generation.md A2/A14 |
| 4.4.3 | `ThreadDepthController` → rename to `ThreadDepthService` | XS | content-enhancements.md |
| 4.4.4 | `modules/events` → rename to `modules/sse` (avoid confusion with `events/`) | S | events.md A4 |

### 4.5 Shared schemas

| # | Task | Effort | Ref |
|---|------|--------|-----|
| 4.5.1 | `SSEvent` schema in `packages/shared` — type SSE payloads for backend + UI | S | events.md A2/T1, infrastructure-sse.md |
| 4.5.2 | Event payload types in `packages/shared` — type for `emit` + `@OnEvent` handlers | S | events.md T1 |

---

## Phase 5 — P2: Performance

| # | Task | File(s) | Effort | Ref |
|---|------|---------|--------|-----|
| 5.1 | `findBySourceAndNetwork` — `sourcePath` column + index (instead of in-memory JSON filter) | `schema.prisma`, `posts.service.ts` | S | infrastructure-prisma.md B5, cross-module-synthesis.md #8 |
| 5.2 | `OrchestratorService.resetCheckpoint` — `SCAN` instead of `KEYS` | `orchestrator.service.ts:170` | XS | infrastructure-redis.md B3 |
| 5.3 | `FlowControlService.isPaused`/`getStatus` — `MGET` instead of sequential `get` | `flow-control.service.ts:118-120` | XS | flow-control.md B6 |
| 5.4 | `RateLimitService.checkRateLimit` — Lua script for atomicity | `rate-limit.service.ts` | S | rate-limit.md B1 |
| 5.5 | `EmailReaderService` — reuse single IMAP connection during polling | `email-reader.service.ts` | S | infrastructure-email.md B1 |
| 5.6 | `EmailReaderService` — UID tracking (don't return stale codes) | `email-reader.service.ts` | S | infrastructure-email.md B3 |
| 5.7 | `runReconciliation` — batch concurrency (p-map or chunked `Promise.all`) | `health-monitor.service.ts:125` | S | health-monitor.md |
| 5.8 | `MetricsScraperService` — conditionalize 5-15s delay for HTTP API sources | `metrics-scraper.service.ts:164` | XS | analytics.md B9 |
| 5.9 | `MetricsScraperService` — mutex for concurrent run protection | `metrics-scraper.service.ts` | S | analytics.md |
| 5.10 | `getMergedTrending` — cache results | `trending.service.ts` | XS | trending.md |
| 5.11 | `TopicGenerationService` — `createMany` + `skipDuplicates` instead of loop insert | `topic-generation.service.ts:217-229` | XS | content-source.md |
| 5.12 | Query telemetry middleware (slow-query logging) | `prisma.service.ts` | M | infrastructure-prisma.md, cross-module-synthesis.md #15 |

---

## Phase 6 — P3: Strategic refactors (L)

| # | Task | Effort | Description |
|---|------|--------|-------------|
| 6.1 | Repository ports for Prisma — `IPrismaPort`, `IPostRepository`, `ISessionRepository`, `IAccountRepository` | L | Decouple business logic from PrismaClient, remove `@Global()` |
| 6.2 | Domain ports for infra modules — `ICryptoPort`, `INotificationPort`, `IEmailReaderPort`, `IRedisCache` | L | Align with hexagonal pattern (`ILlmPort`, `IBrowserPort`, `IContentPort`, `IPromptPort`) |
| 6.3 | Decompose God classes — `GenerationService` (1461 lines), `SessionsService` (1521 lines), `BrowserFactory` (1165 lines), `XPoster` | L | Split into focused services |
| 6.4 | `ICheckpointSaver` port — abstract `RedisCheckpointSaver` behind port + in-memory test adapter | M | generation.md A5 |
| 6.5 | Key rotation for `EncryptionService` — key ID or `SESSION_ENCRYPTION_KEY_OLD` fallback | M | infrastructure-crypto.md B6 |
| 6.6 | `AbortSignal` support in `ILlmPort` — real cancellation for timeouts | M | infrastructure-llm.md B16, orchestrator.md |
| 6.7 | `INotificationPort` with multiple adapters — Discord, email, Slack, PagerDuty | M | infrastructure-notifications.md |
| 6.8 | SSE `Last-Event-ID` replay — reconnect without losing events | M | infrastructure-sse.md |
| 6.9 | Alert batching/cooldown — prevent Discord spam during alert storms | M | infrastructure-notifications.md |

---

## Phase 7 — P3: New features

| # | Task | Effort | Description |
|---|------|--------|-------------|
| 7.1 | Dynamic ephemeris data for trending (replace hardcoded 2026-27 calendar) | M | `ASTRO_EVENTS_2026` will go stale |
| 7.2 | Performance-based recycling — `findRecyclablePosts` sort by engagement metrics, not recency | S | recycling.md |
| 7.3 | Language rotation in `repurposeFromArticles` and `recycleTopPosts`/`recycleById` | S | Currently hardcoded `en` |
| 7.4 | `own-post` source — implement URL resolution from account handle or remove source | S | engagement.md B26 |
| 7.5 | Per-account rate limit keys — currently per-network, not per-account | S | rate-limit.md |
| 7.6 | `SOCIAL_{NETWORK}_ACTIVE` env — env-driven active flag for accounts | XS | accounts.md |
| 7.7 | `bannedAt` field on `Session` model — for correct ban recovery | S | health-monitor.md A5/F2 |
| 7.8 | `/health/metrics` — Prometheus metrics endpoint | M | health.md F5 |
| 7.9 | Webhook health check / canary alert — verify Discord webhook is alive | S | infrastructure-notifications.md |
| 7.10 | `impressions` in metrics history endpoint | XS | analytics.md |

---

## Recommended execution order

```
Phase 1 (P0)   ████████████████████  ← do now
Phase 2 (P1)   ████████████████████████████████████  ← current sprint
Phase 3 (P2a)  ██████████████████████████████  ← next sprint (security + env + infra)
Phase 4 (P2b)  ██████████████████████████  ← architecture / DRY
Phase 5 (P2c)  ██████████████████████  ← performance
Phase 6 (P3a)  ████████████████████  ← strategic refactors (backlog)
Phase 7 (P3b)  ██████████████████  ← new features (backlog)
```

## Quick wins (XS, can be done in a single pass)

1. `PostEvents.REJECTED` emission (2.3.3)
2. `SseEventListener` async + `.catch` (2.3.5)
3. `DATABASE_URL` / `REDIS_URL` URI validation (3.1.1, 3.1.2)
4. `DISCORD_*` env validation (3.1.3)
5. `transactionOptions` timeout for generation (1.3)
6. Discord embed truncate to 1024 (3.3.5)
7. `connectionName` on IORedis instances (1.4)
8. `isEncrypted` improvement (3.3.7)
9. `ABVariantGenerator` Cyrillic hashtag regex (2.8.5)
10. `getMergedTrending` cache (2.9.5)
11. `getDailyStats` `createdAt` → `postedAt` (2.8.6)
12. `WAIT` sleepMs fix (2.6.1)
13. `recycled` flag after success (2.8.3)
14. Remove unused `PostsService` from `AutoApproveListener` (2.2.4)
15. `SSE_CHANNEL` env declaration + default alignment (3.1.4)
16. `/auth/logout` public route (3.2.5)
17. Stop logging partial API keys (3.2.8)
18. `debug-sentry` guard (3.2.3)
19. `0` handling in rate limit (2.7.2)
20. `SCAN` instead of `KEYS` in orchestrator (5.2)
21. Fix quote-temperature mix-up in `EngagementDecisionService` (2.10.1)
22. Pass `baseUrl` into `LangfuseService.createHandler()` (2.11.2)
23. Align Langfuse default base URL with `.env.example` / `AGENTS.md` (2.11.1)
24. Wire `PROMPT_VERSION` into `PromptRegistry` fetch label or rename it (2.11.3)

---

## Recommended next sprint — "Cleanup, resource leaks, and correctness"

A focused sprint that does **not** require large refactors but closes the highest-risk gaps in the current code. All items are `S` or `XS` effort and are either P0/P1 correctness bugs or hardening.

| Priority | Task | ID | Effort | Why now |
|----------|------|----|--------|---------|
| **P0** | Fix `EngagementService.performInteraction` memory leak (no `finally` close) | **1.2** | S | Real browser context / page leak on every failed engagement action. |
| **P0** | Fix `SessionsService.tryCookieAuth` / `autoLogin` context cleanup | **1.1** | S | `browser.createContext()` contexts are never closed on the login path → Camoufox/Firefox process leak. |
| **P1** | `EngagementDecisionService` quote generation uses `ENGAGEMENT_COMMENT_TEMPERATURE` instead of `ENGAGEMENT_QUOTE_TEMPERATURE` | **2.10.1** | XS | One-line real bug; quote temperature config is currently ignored. |
| **P1** | Align Langfuse default base URL with `.env.example` / `AGENTS.md` (US cloud) | **2.11.1** | XS | Currently defaults to EU `cloud.langfuse.com` when `LANGFUSE_BASE_URL` is unset. |
| **P1** | `SessionsService` circuit breaker should record `autoLogin` `null` as failure | **2.4.1** | S | Failed logins do not trip the breaker, leading to repeated attempts. |
| **P1** | `SessionsService.healthCheck` mark session `EXPIRED` on navigation errors | **2.4.2** | XS | Broken sessions remain `ACTIVE` and keep being reused. |
| **P1** | Emit `PostEvents.REJECTED` and make `SseEventListener` handlers await `publish` | **2.3.3** + **2.3.5** | XS each | Event-bus correctness; UI never sees rejected drafts and async Redis errors become unhandled. |
| **P2** | Add `ParseEnumPipe` to `SessionsController` `healthCheck` / `submitVerifyCode` | **2.4.4** | XS | Cheap hardening while already touching sessions. |

**Follow-up bucket** (next sprint or in parallel if capacity allows):

- **1.4** Redis lifecycle listeners + `OnModuleDestroy` cleanup.
- **1.5** LLM response cache key includes `maxTokens`, `provider/model`, `role`.
- **2.6.1** Orchestrator `WAIT` action respects `sleepMs`.
- **2.6.3** Orchestrator `start()` / `stop()` race guard.
- **2.7.1** `RateLimitService` atomic check/record (Lua script or Redis transaction).
- **2.11.3** `PROMPT_VERSION` actually controls the Langfuse label.

**Estimated total effort:** ~2–3 developer-days if done back-to-back; many items can be batched into 2–3 PRs (`sessions`, `engagement`, `events/langfuse`).

## Summary

~80 tasks total: ~30 quick wins (XS), ~35 short tasks (S), ~10 medium (M), ~5 large (L).
