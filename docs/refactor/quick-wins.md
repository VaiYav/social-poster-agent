# Quick Wins — XS Tasks (Single-Pass Batch)

All XS tasks that can be done in a single pass. Estimated total: ~4-6 hours if done back-to-back.

---

## Batch 1: Events & Notifications

- [x] **2.3.3** — Emit `PostEvents.REJECTED` in `posts.service.ts:192-205`
- [x] **2.3.5** — `SseEventListener` — `await publish()` + `.catch()` in `sse-event.listener.ts`
- [x] **3.3.5** — Discord embed fields — truncate to 1024 chars in `discord-notification.service.ts`
- [x] **3.3.3** — `SseService.publish` — catch Redis errors internally in `sse.service.ts`

## Batch 2: Env Validation

- [x] **3.1.1** — `DATABASE_URL` — validate as PostgreSQL URI
- [x] **3.1.2** — `REDIS_URL` — validate as Redis URI
- [x] **3.1.3** — `DISCORD_WEBHOOK_URL`, `DISCORD_ALERTS_ENABLED` — declare + validate
- [x] **3.1.4** — `SSE_CHANNEL` — declare + align default (`spa:sse`)

## Batch 3: Transactions & Redis

- [x] **1.3** — Prisma `$transaction` timeout: add `timeout: 30000` in `generation.service.ts`
- [x] **1.4** — Redis: add `on('error')` listeners + `OnModuleDestroy` + `connectionName` in `redis.module.ts`

## Batch 4: Crypto & Security

- [x] **3.3.6** — `EncryptionService` — strict 64-hex key validation
- [x] **3.3.7** — `isEncrypted` — improve check (part count + hex validation)
- [x] **3.2.3** — `debug-sentry` endpoint — guard or remove from production
- [x] **3.2.5** — `/auth/logout` — add to public routes
- [x] **3.2.8** — Stop logging partial API keys in `LlmService.onModuleInit`

## Batch 5: Content & Generation

- [x] **2.8.5** — `ABVariantGenerator` hashtag regex — add Unicode `\p{L}\p{N}` support
- [x] **2.8.6** — `getDailyStats` — change `createdAt` → `postedAt`
- [x] **2.8.3** — Recycling: move `recycled` flag to after generation success
- [x] **2.9.5 / 5.10** — `getMergedTrending` — add 60s TTL cache

## Batch 6: Orchestrator & Rate Limit

- [x] **2.7.2** — Rate limit `0` handling — replace `||` with `??` or explicit check
- [x] **2.10.1** — Fix quote-temperature env var mix-up in `EngagementDecisionService`

## Batch 7: Sessions

- [x] **2.2.4** — Remove unused `PostsService` from `AutoApproveListener`
- [x] **2.4.2** — `healthCheck` — expire sessions on nav errors
- [x] **2.4.3** — Remove `as SessionStatus` casts for `WARMUP`
- [x] **2.4.4** — Add `ParseEnumPipe` for `network` in `SessionsController`

## Batch 8: Langfuse & LLM

- [x] **2.11.1** — Align Langfuse default base URL to US (`us.cloud.langfuse.com`)
- [x] **2.11.2** — Pass `baseUrl` to `CallbackHandler` in `createHandler()`
- [x] **2.11.4** — `getAvailableModels()` — fix paid provider classification
- [x] **3.4.2** — `HEALTH_CHECK_TIMEOUT_MS` — env-driven instead of hardcoded

## Batch 9: Analytics & Queue

- [x] **2.8.7** — `getTopPosts` — sort by engagement, not recency
- [x] **2.1.2** — `schedulePosting` — use posting retry config
- [x] **2.1.3** — `QueueController.getFailed` — sanitize raw `Job` objects
- [x] **1.6** — Queue: remove delayed jobs before re-enqueue

## Batch 10: Performance

- [x] **5.3** — `FlowControlService` — `MGET` instead of sequential `get`
- [x] **5.11** — `TopicGenerationService` — `createMany` + `skipDuplicates`
- [x] **5.8** — `MetricsScraperService` — conditionalize delay for HTTP API sources
- [x] **7.6** — `SOCIAL_{NETWORK}_ACTIVE` env — env-driven active flag
- [x] **7.10** — `impressions` in metrics history endpoint

---

## Summary

24 quick-win tasks, all XS effort. Can be batched into 2-3 PRs:
1. **PR 1:** Batches 1-3 (events, env validation, transactions/Redis)
2. **PR 2:** Batches 4-7 (crypto, security, content, sessions)
3. **PR 3:** Batches 8-10 (Langfuse, analytics, queue, performance)
