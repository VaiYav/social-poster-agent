# Code Review Index — `packages/backend`

This directory contains per-module deep-research reviews of the Social Poster Agent backend. Each file documents the module's purpose, public API, key findings (bugs, performance, architecture, security, new-feature ideas), and cross-references.

> **Docs vs. code** — `AGENTS.md` and `CLAUDE.md` are the project conventions; prior ADR/audit docs may drift. The reviews below were written against snapshots of `packages/backend/src/` and may fall behind active development. When a detail matters, grep the source, not this index.

## Reviewed modules

| Module | Review file | Status | Coverage | Key risks |
|--------|-------------|--------|----------|-----------|
| [`modules/generation`](../../packages/backend/src/modules/generation) | [`generation.md`](./generation.md) | completed | full | God-class `GenerationService`, `process.env` usage in graph/service, `IPromptPort` use, hardcoded English paths, LangGraph error handling gaps |
| [`modules/posting`](../../packages/backend/src/modules/posting) | [`posting.md`](./posting.md) | completed | full | `process.env` in posters, `retryable` not set uniformly, many TODO/FIXME markers, `Threads` and `Facebook` poster complexity |
| [`modules/queue`](../../packages/backend/src/modules/queue) | [`queue.md`](./queue.md) | completed | full | Delayed jobs not removed before re-enqueue, `schedulePosting` uses wrong retry config, raw job objects exposed, dry-run workers skipped |
| [`modules/autonomy`](../../packages/backend/src/modules/autonomy) | [`autonomy.md`](./autonomy.md) | completed | full | Missing quality score defaults to auto-approve, SimHash dedup includes FAILED/REJECTED, reject streak not truly consecutive |
| [`modules/flow-control`](../../packages/backend/src/modules/flow-control) | [`flow-control.md`](./flow-control.md) | completed | full | No admin guard, no Redis error fallback, `resumeAll` resets individual overrides |
| [`modules/posts`](../../packages/backend/src/modules/posts) | [`posts.md`](./posts.md) | completed | full | `approve` with edited content does not update `simhash` or re-run AutoCheck, `updateStatus` allows arbitrary transitions, no `REJECTED` event |
| [`modules/content-source`](../../packages/backend/src/modules/content-source) | [`content-source.md`](./content-source.md) | completed | full | `DbContentReader.markUsed` not exposed, topic generation loads all topic strings, prompt hardcoded, English-only |
| [`modules/sessions`](../../packages/backend/src/modules/sessions) | [`sessions.md`](./sessions.md) | completed | full | 1500+ line God-class, `process.env` reads, circuit breaker not recording `null` failures, health check doesn't expire on nav errors |
| [`modules/accounts`](../../packages/backend/src/modules/accounts) | [`accounts.md`](./accounts.md) | completed | full | Seed doesn't upsert on env changes, `getCredentials` not used by `SessionsService`, no env-driven `active` flag |
| [`modules/rate-limit`](../../packages/backend/src/modules/rate-limit) | [`rate-limit.md`](./rate-limit.md) | completed | full | Non-atomic check/record, fail-open on Redis, `0` handling, no network validation, per-network not per-account |
| [`modules/health`](../../packages/backend/src/modules/health) | [`health.md`](./health.md) | completed | full | Mixes liveness/readiness, returns 200 on degraded, `debug-sentry` unprotected |
| [`modules/health-monitor`](../../packages/backend/src/modules/health-monitor) | [`health-monitor.md`](./health-monitor.md) | completed | full | `BANNED` status casts, `createdAt` used for ban recovery, `getDashboard` emits alerts, `runReconciliation` too parallel |
| [`modules/engagement`](../../packages/backend/src/modules/engagement) | [`engagement.md`](./engagement.md) | completed | full | `EngagementService` memory leak, `own-post` source not implemented, `scheduleDailySessions` can stack jobs, static mutex bottleneck |
| [`modules/replies`](../../packages/backend/src/modules/replies) | [`replies.md`](./replies.md) | completed | full | Broken self-reply detection, original post scraped as comment, `runMonitoringCycle` ignores flow control, `repliesPosted` stats misleading, inline reply prompt |
| [`modules/trending`](../../packages/backend/src/modules/trending) | [`trending.md`](./trending.md) | completed | full | Hardcoded 2026–27 astro calendar, `page.evaluate` uses Playwright `:has-text` selector, X trend text extraction fragile, `getMergedTrending` not cached |
| [`modules/content-enhancements`](../../packages/backend/src/modules/content-enhancements) | [`content-enhancements.md`](./content-enhancements.md) | completed | full | `ContentPillarTracker` TTL not a rolling window, `recordPillar` may record drafts, many inline prompts, `ABVariantGenerator` heuristic misses Cyrillic hashtags |
| [`modules/recycling`](../../packages/backend/src/modules/recycling) | [`recycling.md`](./recycling.md) | completed | full | Performance selection missing, SimHash threshold inconsistent with generation, hardcoded English, `recycled` flag set before success |
| [`modules/analytics`](../../packages/backend/src/modules/analytics) | [`analytics.md`](./analytics.md) | completed | full | `getTopPosts` by recency not engagement, `getDailyStats` uses `createdAt`, hardcoded scraper limits, `process.env` usage, no concurrent-run protection |
| [`modules/auth`](../../packages/backend/src/modules/auth) | [`auth.md`](./auth.md) | completed | full | `/auth/logout` not public, `/auth/me` fails when `AUTH_ENABLED=false`, `JwtAuthGuard` public routes via `endsWith`, no login rate limiting |
| [`modules/orchestrator`](../../packages/backend/src/modules/orchestrator) | [`orchestrator.md`](./orchestrator.md) | completed | full | `WAIT` sleepMs ignored, `resetCheckpoint` deletes all checkpoints, `stop/start` can dual-loop, non-cancellable LLM timeout, heartbeat doesn't cover long `BROWSE` |
| [`modules/events`](../../packages/backend/src/modules/events) | [`events.md`](./events.md) | completed | full | `REJECTED` never emitted, duplicate `post_status` paths, `AutoApproveListener` in wrong module, `EventsController` cleanup issues |
| [`modules/quote-cards`](../../packages/backend/src/modules/quote-cards) | *none* | **pending** | missing | Sprint O / F19 — generation of quote-cards via Satori + `@resvg/resvg-js`; feature-gated `QUOTE_CARDS_ENABLED` (review not yet written) |

## Reviewed infrastructure

| Area | Review file | Status | Coverage | Key risks |
|------|-------------|--------|----------|-----------|
| `infrastructure/llm` (router, providers, prompts, rate-limit) | [`infrastructure-llm.md`](./infrastructure-llm.md) | completed | full | Response cache key omits role/model/tokens; reasoning `maxCompletionTokens` dead branch; rate-limit strike penalty default always triggers; Langfuse base URL drift; prompt registry keeps only first system/user message; partial API key logged; `withTimeout` semantics |
| `infrastructure/browser` (Camoufox, pool, context lifecycle) | [`infrastructure-browser.md`](./infrastructure-browser.md) | completed | full | `BrowserContext` leak in `SessionsService`, persistent Facebook context can return dead contexts, proxy/captcha/selector-health services dead, proxy URL bug, captcha API likely wrong, env validation missing |
| `infrastructure/prisma` | [`infrastructure-prisma.md`](./infrastructure-prisma.md) | completed | full | No repository port, `@Global()` module, default transaction timeout, connection pool not tuned, `DATABASE_URL` not validated as URL |
| `infrastructure/redis` | [`infrastructure-redis.md`](./infrastructure-redis.md) | completed | full | No lifecycle/error handling, `QueueFactory` duplicates connections, `KEYS` in orchestrator, many Redis env vars missing from `env.validation.ts` |
| `infrastructure/sse` | [`infrastructure-sse.md`](./infrastructure-sse.md) | completed | full | Duplicate `post_status` events, `SseEventListener` async handling bugs, no rate limiting, `SSE_CHANNEL` default mismatch |
| `infrastructure/notifications` | [`infrastructure-notifications.md`](./infrastructure-notifications.md) | completed | full | No retry/circuit breaker, no `INotificationPort`, `DISCORD_*` env vars not validated, no batching |
| `infrastructure/crypto` | [`infrastructure-crypto.md`](./infrastructure-crypto.md) | completed | full | No `ICryptoPort`, no key rotation, persistent profile dir stores plaintext cookies, `isEncrypted` too naive |
| `infrastructure/email` | [`infrastructure-email.md`](./infrastructure-email.md) | completed | full | New IMAP connection per poll, no UID tracking, direct `process.env` reads, raw source regex extraction |
| `infrastructure/langfuse` | *none* | pending | missing | OTel SDK init, prompt management, AsyncLocalStorage callback propagation (`packages/backend/src/infrastructure/langfuse/`) |
| `infrastructure/prompt` (PromptRegistry / `IPromptPort`) | *none* | pending | missing | Langfuse Prompt Management facade, SDK-native fallback, `{var}` → `{{var}}` conversion, circuit breaker |
| `infrastructure/content` (ContentReader, DbContentReader, topic generation) | *none* | pending | partial | Shared with `modules/content-source`; readers and `topic-generation.service.ts` not reviewed as a standalone infrastructure area |
| `infrastructure/checkpoint` | *none* | pending | missing | `RedisCheckpointSaver` for LangGraph resume (`packages/backend/src/infrastructure/checkpoint/`) |
| `infrastructure/captcha` | *none* | pending | missing | Captcha-solver adapter behind feature flag (`packages/backend/src/infrastructure/captcha/`) |
| `infrastructure/proxy` | *none* | pending | missing | Proxy rotation adapter behind `PROXY_ROTATION_ENABLED` (`packages/backend/src/infrastructure/proxy/`) |
| `infrastructure/logging`, `infrastructure/filters`, `infrastructure/guards`, `infrastructure/common`, `infrastructure/config`, `infrastructure/cls`, `infrastructure/util` | *none* | pending | missing | Small cross-cutting utilities not individually reviewed |

## Cross-module synthesis

After the per-module reviews, a consolidated synthesis was written to surface cross-cutting themes and a unified action backlog:

- [`cross-module-synthesis.md`](./cross-module-synthesis.md) — cross-cutting themes, module interaction map, consolidated prioritized backlog, quick wins, and strategic refactors.
- [`ACTION_PLAN.md`](./ACTION_PLAN.md) — executable, effort-sized task list derived from the reviews (living document; re-verify file/line references before implementing).
- [`../features/README.md`](../features/README.md) — high-level feature proposals that are not yet in `ACTION_PLAN.md` (A/B testing, content adapters, operator dashboard, multi-instance scaling, browser replay, prompt versioning).

## In progress / pending

Not every backend module/infrastructure area has been reviewed. The main gaps are:

- `modules/quote-cards`
- `infrastructure/langfuse` and `infrastructure/prompt`
- `infrastructure/content` (standalone)
- `infrastructure/checkpoint`, `captcha`, `proxy`
- small cross-cutting utilities: `config`, `cls`, `common`, `filters`, `guards`, `logging`, `util`

The reviews above also drift against active commits. New review files should be added here as they are completed.

## Methodology

- Each review is **read-only** (no code changes applied in the review file itself).
- Findings are grouped: Bugs, Performance, Architecture, TypeScript, Security/Reliability, New-feature ideas.
- Cross-references link related modules and `docs/adr/*` / `docs/audit/*`.
- `AGENTS.md` and `CLAUDE.md` are treated as the source of truth for project conventions; prior docs are cross-referenced but not blindly trusted.
- This index is maintained against the actual `packages/backend/src/` directory tree, not against design documents.

## How to use

1. Read the module that interests you.
2. Look at the **Overall assessment** at the end for the top risks and recommended next actions.
3. Use the cross-references to trace impacts across modules.
4. Check the **Coverage** column above: `full` means the review covers the whole area; `partial` / `missing` means the area either overlaps with another review or has not yet been documented.
5. When the research phase is complete, pick the **Recommended next actions** for implementation.

---

*Generated as part of the SPA backend deep-review project.*
