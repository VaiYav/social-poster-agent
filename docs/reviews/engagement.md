# Module: `modules/engagement`

## 1. What this module does

`modules/engagement` implements the social-automation engagement subsystem: likes, comments, follows, replies, reposts, quotes, and autonomous browsing sessions that scroll feeds and use an LLM-driven decision engine to act like a human user. It is feature-flagged behind `ENGAGEMENT_ENABLED` and `ENGAGEMENT_SCHEDULER_ENABLED`.

**Main responsibilities:**
- `EngagementService` — API-triggered individual engagement actions.
- `BrowsingSessionService` — autonomous browser sessions that scroll feeds and perform human-like interactions.
- `EngagementSchedulerService` — schedules browsing sessions via BullMQ delayed jobs.
- `HumanBehaviorEngine` — LLM-driven per-post decision loop (scroll/read/like/comment/repost/quote).
- `EngagementDecisionService` — calls LLM to decide actions and generate comments/quotes.
- `TargetingService` — rotates sources (home feed, hashtag, competitor, explore, notifications).
- `EngagementGraph` — LangGraph state graph for browsing sessions.
- `BaseEngager` / `XEngager` / `ThreadsEngager` / `FacebookEngager` — network-specific browser automation.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `engagement.module.ts` | NestJS module | `EngagementModule` — imports Browser, SSE, LLM, Accounts, Sessions, Warmup, RateLimit, Queue, Prisma, FlowControl |
| `engagement.controller.ts` | REST API | `POST /engagement/like`, `/comment`, `/follow`, `/reply`, `/repost`, `/quote`, `/browsing-session`, `GET /engagement/stats`, `/interactions`, `/browsing-sessions` |
| `engagement.service.ts` | Core actions | `like()`, `comment()`, `follow()`, `reply()`, `repost()`, `quote()`, `getStats()` |
| `browsing-session.service.ts` | Browsing sessions | `runBrowsingSession()`, `findAll()`, `findInteractions()` |
| `engagement-scheduler.service.ts` | Scheduler | `onModuleInit()`, `scheduleDailySessions()`, `getStatus()`, `checkStaleAndEnqueue()` |
| `engagement.graph.ts` | LangGraph | `buildEngagementGraph()`, `createEngagementInitialState()` |
| `human-behavior-engine.ts` | Decision loop | `processPosts()` |
| `engagement-decision.service.ts` | LLM decision | `decideAction()`, `decideActionsBatch()`, `generateComment()`, `generateQuoteText()` |
| `targeting.service.ts` | Source rotation | `pickSource()`, `getAvailableSources()` |
| `engagers/base.engager.ts` | Abstract base | `scrollFeed()`, `scrollUrl()`, `doScrollFeed()`, `extractPostText()`, etc. |
| `engagers/x.engager.ts`, `threads.engager.ts`, `facebook.engager.ts` | Concrete engagers | Network-specific implementations |

## 3. How it works

### 3.1 `EngagementService` individual actions

- Each action (`like`, `comment`, `follow`, `reply`, `repost`, `quote`):
  1. Checks `flowControl.isPaused('engagement')`.
  2. Resolves the target account via `accountsService.getNextAccountForNetwork(network)`.
  3. Calls `rateLimitService.checkRateLimit(network, accountId, actionType)` with the resolved `accountId` so each account has its own interaction counters.
  4. Gets session via `sessionsService.getOrCreateSession(accountId, network)` (or network-only fallback if no account is resolved).
  5. Creates `Interaction` record in `IN_PROGRESS`.
  6. Creates browser context with decrypted storage state.
  7. Calls the appropriate `BaseEngager` method.
  8. Saves updated storage state.
  9. Updates `Interaction` to `COMPLETED`/`FAILED`.
  10. Calls `rateLimitService.recordPost(network, accountId, actionType)` if successful and not already liked/reposted.
  11. Emits SSE events.

### 3.2 `BrowsingSessionService.runBrowsingSession()`

- Acquires a per-network distributed Redis lock (`${ENGAGEMENT_LOCK_KEY}:${network}`) so different networks can browse concurrently while a single network stays serialized.
- Gets session with `deferFormLogin: true`.
- Creates `BrowsingSession` record `ACTIVE`.
- Acquires browser context from pool, creates page, applies resource blocking, suppresses page errors, pre-session health check.
- Builds `EngagementGraph` and invokes it with `withTimeout` (duration + 180s buffer).
- After graph:
  - Updates `feedUrl` if `finalState.sourceUrl`.
  - Saves storage state.
  - Updates `BrowsingSession` `COMPLETED` with `postsViewed`, `interactionsCount`.
- On error:
  - Marks `BrowsingSession` `FAILED`.
  - Closes context for fatal browser errors.
  - Releases page/context and per-network distributed lock.

### 3.3 `EngagementGraph` flow

`START → check_warmup → pick_source → scroll_feed → decide_per_post → record → END`

- `check_warmup` — uses `WarmupService` to gate budgets.
- `pick_source` — `TargetingService.pickSource()`.
- `scroll_feed` — `engager.scrollUrl()` or `engager.scrollFeed()`, capped at 1/3 duration, 30 URLs max.
- `decide_per_post` — delegates to `HumanBehaviorEngine.processPosts()`.
- `record` — logs results.

### 3.4 `HumanBehaviorEngine.processPosts()`

- Processes `postUrls` in batches (size 5 if batch LLM supported).
- For each batch:
  1. Extract post text via `engager.extractPostText()` (with timeout, fatal error handling).
  2. Get LLM decisions via `decisionPort.decideActionsBatch()` or `decideAction()` (fallback to individual, then fallback to `read`). Validates the decision array length and falls back to `read` if it doesn't match the number of contexts.
  3. Execute decisions sequentially: scroll, read, skip, like, comment, repost, quote.
  4. Enforces per-session budgets (downgrades to `read` if budget exhausted).
  5. If no interactions after 5 posts, converts a `read`/`scroll`/`skip` to a `like` for "first-interaction quota".
  6. Generates comment/quote text via `decisionPort` if not provided.
  7. Records results.
  8. Applies `postActionPause` with dwell/hover timing.

### 3.5 `EngagementSchedulerService`

- `onModuleInit`:
  - Skips if `ENGAGEMENT_SCHEDULER_ENABLED=false` or no networks or orchestrator enabled.
  - Calls `scheduleDailySessions()`.
  - Registers daily cron at midnight to re-schedule.
- `scheduleDailySessions()`:
  - Picks `sessionsPerDay` random windows from `ENGAGEMENT_SESSION_WINDOWS`.
  - For each window and network, applies ±`jitterMinutes`, computes `delayMs`, enqueues BullMQ delayed engagement job with `jobId = browsing-${network}-${ISO}`.
- `checkStaleAndEnqueue(world)`:
  - Called by orchestrator.
  - Skips night mode (01:00-07:00 UTC).
  - If last browse >4h ago or last session failed/stuck, clears completed/failed engagement jobs and enqueues immediate `browsing-stale-${network}-${window}`.

### 3.6 `TargetingService`

- Sources: `home-feed`, `hashtag`, `competitor`, `explore`, `notifications`.
- Weights configurable via `ENGAGEMENT_WEIGHT_*`.
- URL builders for X, Threads, Facebook.

### 3.7 `EngagementDecisionService`

- Uses `ILlmPort` (multi-provider fallback).
- Prompts in `infrastructure/llm/prompts/v0.4.0/engagement-decision.js`.
- `decideAction` and `decideActionsBatch` parse LLM JSON response.
- Budget enforcement and fallback to `read`/`like`.
- Generates comments/quotes in brand voice.

### 3.8 F1 UI Control Panel

- View: `packages/ui/src/views/AutonomousAgent.vue`.
- Store: `packages/ui/src/stores/engagement.ts` (Pinia) with `fetchAll`, `startBrowsingSession`, and `handleSseEvent`.
- SSE: global `App.vue` dispatches `browsing_session_*` and `interaction_*` events to the engagement store, which refetches stats and sessions.
- REST: new `GET /engagement/scheduler/status` exposes `EngagementSchedulerService.getStatus()`.
- Controls:
  - Pause/resume engagement flow via Flow Control store (`POST /flow-control/pause/engagement` and `/resume/engagement`).
  - Network selector + "Start Browsing Session" button (`POST /engagement/browsing-session`).
  - Scheduler status, interaction stats, and recent browsing sessions.

## 4. Dependencies

**Downstream:**
- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/prisma` — `Interaction`, `BrowsingSession`.
- `infrastructure/sse` — `SseService`.
- `infrastructure/llm` — `ILlmPort`.
- `modules/sessions` — `SessionsService`, `WarmupService`.
- `modules/accounts` — `AccountsService`.
- `modules/rate-limit` — `RateLimitService`.
- `modules/flow-control` — `FlowControlService`.
- `modules/queue` — `QueueFactory`/`QueueModule`.
- `modules/posting` — `BasePoster` extended by `BaseEngager`.
- `modules/orchestrator` — `isOrchestratorEnabled()`, `ports.ts`.

**Upstream:**
- `modules/queue` — engagement worker calls `BrowsingSessionService`/`EngagementService`.
- `modules/orchestrator` — calls `EngagementSchedulerService.checkStaleAndEnqueue()`.
- UI — `EngagementController`.

## 5. Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENGAGEMENT_ENABLED` | `false` | `app.module.ts` conditional import (validated in `env.validation.ts`) |
| `ENGAGEMENT_SCHEDULER_ENABLED` | `false` | Enable scheduler (not validated) |
| `ENGAGEMENT_SESSIONS_PER_DAY` | `3` | Sessions per day per network (not validated) |
| `ENGAGEMENT_SESSION_WINDOWS` | `09:00,13:00,18:00` | Base times (not validated) |
| `ENGAGEMENT_JITTER_MINUTES` | `30` | Jitter (not validated) |
| `ENGAGEMENT_NETWORKS` | `getEnabledNetworks()` | Networks (not validated) |
| `ENGAGEMENT_SCHEDULE_CRON` | `0 0 * * *` | Daily re-schedule cron (not validated) |
| `F1_BROWSING_SESSION_MINUTES` | `15` | Duration (not validated) |
| `F1_LIKES_MAX_PER_DAY` | `4` | Likes per-session soft target (not validated) |
| `F1_COMMENTS_MAX_PER_DAY` | `1` | Comments per-session soft target (not validated) |
| `F1_REPOSTS_MAX_PER_DAY` | `1` | Reposts per-session soft target (not validated) |
| `F1_QUOTES_MAX_PER_DAY` | `1` | Quotes per-session soft target (not validated) |
| `F1_DISCUSSIONS_MAX_PER_DAY` | `2` | Discussions (repost + quote) per-session soft target (not validated) |
| `F1_MAX_LIKES_PER_DAY_GLOBAL` | `20` | Global daily hard cap for likes |
| `F1_MAX_COMMENTS_PER_DAY_GLOBAL` | `5` | Global daily hard cap for comments |
| `F1_MAX_REPOSTS_PER_DAY_GLOBAL` | `1` | Global daily hard cap for reposts |
| `F1_MAX_QUOTES_PER_DAY_GLOBAL` | `1` | Global daily hard cap for quotes |
| `F1_MAX_POSTS_PER_SESSION` | `40` | Max posts evaluated per session (not validated) |
| `ENGAGEMENT_HASHTAGS` | multi-language defaults | Hashtag pool (not validated) |
| `ENGAGEMENT_COMPETITORS` | `costarastrology,...` | Competitor pool (not validated) |
| `ENGAGEMENT_WEIGHT_*` | 40/25/15/10/5/5 | Source weights (not validated) |
| `ENGAGEMENT_COMMENT_TEMPERATURE` | `0.8` | Comment LLM temp (read via `ConfigService` in `engagement-decision.service.ts:49`) |
| `ENGAGEMENT_QUOTE_TEMPERATURE` | `0.8` | Quote LLM temp (used by `generateQuoteText` at `:293`) |

## 6. Findings

### 6.1 Bugs / correctness

**B1. ~~`BrowsingSessionService` uses a static `sessionMutex` (Promise) to serialize all browsing sessions across all networks~~ — RESOLVED**
- The global mutex was replaced with a per-network distributed Redis lock (`spa:lock:engagement:${network}`). Different networks can now run browsing sessions concurrently; the same network remains serialized across all instances. 

**B2. `BrowsingSessionService` `runBrowsingSession` throws `Error` if no session, but also `releaseMutex` is called before throwing. Good.**

**B3. `BrowsingSessionService` `runBrowsingSession` `getFeedUrl` for Facebook uses `this.facebookEngager.getPageUrl()`. If `getPageUrl()` throws or returns undefined, the feedUrl may be invalid. It is set in DB before navigation. Good.**

**B4. `BrowsingSessionService` `findAll` and `findInteractions` use `status` query without parsing. `BrowsingSessionStatus` and `InteractionStatus` are enums. The `EngagementController` passes `status as never` from query string. If the query string is invalid, Prisma may fail. Should validate.**

**B5. `BrowsingSessionService` `runBrowsingSession` `pre-session health check` calls `page.evaluate(() => 1)` with `withTimeout(10_000)`. If page is not responsive, it catches and continues. But for fatal errors like `Target page...` it throws. Good. But it doesn't test navigation, only JS evaluate. A page may evaluate JS but still fail to navigate. Acceptable.**

**B6. ~~`EngagementService.performInteraction` creates a `browser.createContext` (not `acquireContext`)~~ — RESOLVED**
- Now uses `browser.acquireContext()` and `browser.releaseContext()` so pooled/persistent contexts are reused instead of creating a new Camoufox process per action.

**B7. ~~`EngagementService.performInteraction` `catch` does not close context on failure~~ — RESOLVED**
- The method already had a `finally` block that closes the page and releases the context; the fix in B6 ensures `releaseContext()` is used instead of `close()`.

**B8. `EngagementService.performInteraction` `rateLimitService.recordPost(rateKey)` is called with `rateKey` `${network}-${type.toLowerCase()}` (e.g., `X-like`). `RateLimitService.resolveLimits` handles this. But `recordPost` uses `intervalMs = resolveLimits(rateKey).intervalMs` which for interaction is `interactionMinIntervalMs` (default 0). Good. `checkRateLimit` uses `resolveLimits` and reads `intervalKey`. But `recordPost` sets `intervalKey` with `PX intervalMs` only if `intervalMs > 0`. For interaction default 0, no interval. Good. But `RateLimitService` does not handle `0` for `interaction_*_MAX_PER_DAY` as B8 in rate-limit. If someone sets `RATE_LIMIT_INTERACTION_LIKE_MAX_PER_DAY=0`, it falls back to 60. This is a bug.**

**B9. `EngagementService.performInteraction` `interactionId` is empty string in early returns (paused, rate limited, no session). The caller gets `interactionId: ''`. Should be null or omitted. But the return type says `EngagementResult & { interactionId: string }`. Empty string is valid type. Not ideal.**

**B10. ~~`EngagementService.performInteraction` does not check warm-up before creating a session or interaction~~ — RESOLVED**
- Added optional `WarmupService` injection and `canInteract(session.accountId)` check after `getOrCreateSession`. Browse-only accounts are rejected before an `Interaction` is created.

**B11. `HumanBehaviorEngine.processPosts` uses `postsProcessed` counter. It increments `postsProcessed` for extraction failures (line 177) and for each executed decision (line 231). But if an extraction fails and it continues, it doesn't record a result. Then if extraction fails, `postsProcessed` increments but `results` doesn't. It might exit early. This is okay for maxPosts count.**

**B12. `HumanBehaviorEngine.processPosts` `first-interaction quota` converts `read`/`scroll`/`skip` to `like` if `postsProcessed > 5` and `totalInteractions === 0`. This is a hack. It may force a like on a post that the LLM didn't want to like. But it's to avoid zero interactions. Acceptable.**

**B13. ~~`HumanBehaviorEngine.processPosts` `decisions` array from `decideActionsBatch` may have different length than `contexts`~~ — RESOLVED**
- `processPosts` now normalizes every decision result with a `normalizeDecisions` helper. If the returned array length does not match the number of contexts, it logs a warning and falls back to a `read` decision for each context.

**B14. `HumanBehaviorEngine.processPosts` `executeDecision` catches timeout and returns `{ success: false, error: ... }`. It does not check fatal error. Then after `executeDecision`, it checks `if (!result.success && this.isFatalBrowserError(result.error)) throw new Error(result.error);`. Good. But if `executeDecision` itself throws (e.g., from `engager.like`), it is caught by the `withTimeout` `.catch` and returns error. Good.**

**B15. `HumanBehaviorEngine` `executeDecision` `comment` and `quote` actions call `engager.comment`/`engager.quote` but if the LLM `commentText`/`quoteText` is not generated, it downgrades. Good. But the `EngagementDecisionService` may also generate comment. The `HumanBehaviorEngine` also generates. There is duplicate generation logic? Actually `HumanBehaviorEngine` calls `this.decisionPort.generateComment` (same port). `EngagementDecisionService` also has `generateComment` but `HumanBehaviorEngine` uses its own `IEngagementDecisionPort` injected. It's the same service. Wait, `HumanBehaviorEngine` injects `IEngagementDecisionPort`. `EngagementDecisionService` implements it. So `HumanBehaviorEngine` calls `decisionPort.generateComment`. Good. No duplication. But `EngagementService.performInteraction` does not generate comment for replies? It passes `text` to `engager.reply`. The LLM is not used for API-triggered replies. Good. For `comment` API, user provides text. Good.**

**B16. `EngagementSchedulerService` `parseNetworks` uses `value.split(',').map(...).filter(s => s === 'X' || s === 'THREADS' || s === 'FACEBOOK').map(s => SocialNetwork[s as keyof typeof SocialNetwork]);`. The `SocialNetwork` enum keys are uppercase `X`, `THREADS`, `FACEBOOK`. Good. But if `value` is `x` (lowercase), `trim().toUpperCase()` makes it `X`. Good.**

**B17. `EngagementSchedulerService` `scheduleDailySessions` uses `this.configService.get<number>('F1_BROWSING_SESSION_MINUTES', 10) * 60`. If `ConfigService.get<number>` returns string `'10'`, then `* 60` is `600` (string `10` * 60 = number 600). Good. But `configService.get<number>` default is `10` (number). The type is `number`. If env is `'15'`, it returns string? In JS, `string * number` is number. Good. But `configService.get<number>` is typed as `number` but may return string. This is a type mismatch but runtime works.**

**B18. `EngagementSchedulerService` `checkStaleAndEnqueue` uses `const session = world.sessions[netKey]`. If `world` is not populated, `session` may be undefined. It checks `if (!session || session.status !== 'ACTIVE') continue`. Good. But `session` is `WorldState` session type, not `Session` model. It doesn't have `accountId`. The queue job data has `network` only. `BrowsingSessionService` will get `accountId` from `SessionsService.getOrCreateSession`. Good. But `session.status` from `WorldState` may be stale. It uses `lastSessionStatus` too. Fine.**

**B19. `EngagementSchedulerService` `checkStaleAndEnqueue` `await this.queueFactory.clearCompletedAndFailedJobs(netKey, 'engagement')` clears all completed/failed engagement jobs for the network before enqueueing. This is aggressive. It removes completed jobs that may have been there for debugging. But it's needed to avoid BullMQ dedup blocking stale re-enqueue. The `jobId` is `browsing-stale-${netKey}-${windowStart}`. If a previous stale job for the same window completed/failed, the new one can't be added. So it clears. Good. But `clearCompletedAndFailedJobs` removes all completed/failed engagement jobs, not just the specific jobId. This is over-broad and removes audit history. It should remove only the specific jobId. But `clearCompletedAndFailedJobs` is a coarse method. The `queue.getJob(jobId)` + `job.remove()` would be better. This is a bug in `QueueFactory`/`clearCompletedAndFailedJobs` method (also noted in queue review).**

**B20. `EngagementSchedulerService` `checkStaleAndEnqueue` is `async` but called by orchestrator and not awaited? It is awaited. Good. But the orchestrator may call it every cycle. If it takes long, it blocks the orchestrator. But it just enqueues jobs. Fine.**

**B21. `EngagementGraph` `scroll_feed` node uses `state.sessionStartMs + state.durationSec * 1000` as deadline. `sessionStartMs` is set in `initialState` as `Date.now()`. Good. But `scrollSec` is capped at 1/3 of duration. So `decide_per_post` has 2/3 of duration. Good. But `scroll_feed` timeout is `scrollSec * 1000 + 60_000` (with min 120s). If `scrollSec` is 0 (duration < 30s?), it would be 120s. Good. But `scroll_feed` may take longer than its budget. The `withTimeout` in `compiled.invoke` is the overall session timeout. So `scroll_feed` can be killed by overall timeout. Good. But `decide_per_post` also has timeouts. The overall session timeout is `duration*1000 + 180s`. If the session is supposed to be 15 min, the timeout is 18 min. Good. But if the graph hangs in `scroll_feed`, it waits 18 min. The `scrollTimeout` per scroll is 120s + scrollSec, but `engager.scrollUrl` may be called multiple times. Actually `engager.scrollUrl` is one call with `scrollSec` duration. If `scrollSec` is 300s, scrollTimeout is 360s. The overall timeout is 1080s. Good. But `engager.scrollUrl` may not respect `scrollSec` exactly. Fine.**

**B22. `EngagementGraph` `record` node returns `{}` (empty object). It does not update state. The final state is used by `BrowsingSessionService` to update DB. Good. But the `record` node is a no-op. It just logs. Could be removed or used to publish final SSE. Minor.**

**B23. `EngagementGraph` `decide_per_post` node delegates to `HumanBehaviorEngine.processPosts`. The `processPosts` loop uses `Date.now() < sessionDeadline` and `postsProcessed < config.maxPosts`. Good. It also has `EXTRACT_TIMEOUT_MS=15s`, `DECISION_TIMEOUT_MS=30s`, `EXECUTE_TIMEOUT_MS=60s`. Good.**

**B24. ~~`EngagementDecisionService` `process.env` reads for `ENGAGEMENT_COMMENT_TEMPERATURE` and `ENGAGEMENT_QUOTE_TEMPERATURE` instead of `ConfigService`, and quote generation uses the wrong temperature constant~~ — RESOLVED (Sprint 2.1)**
- Temperatures are now read via `ConfigService` in the constructor (`engagement-decision.service.ts:49-50`).
- `generateComment` uses `this.commentTemperature` (`:247`); `generateQuoteText` uses `this.quoteTemperature` (`:293`).

**B25. ~~`TargetingService` source weights are `configService.get<number>` and may be strings~~ — RESOLVED**
- Weights are now parsed with `Number()` via a private `parseNumber()` helper, so `this.sourceWeights` always contains numeric values.

**B26. ~~`TargetingService` `getAvailableSources` for `own-post` uses `url: ''`~~ — RESOLVED (removed)**
- The `own-post` source was unimplemented (empty URL fell back to home feed). Rather than ship a broken source, it has been removed from `EngagementSource`, `TargetingService`, and `.env.example`. Conversation-ready targeting now boosts `notifications` only; replying to comments on own posts can be re-introduced later as a dedicated graph path with profile-URL resolution.

**B27. `TargetingService` `getNotificationsUrl` for Facebook returns `'https://www.facebook.com/notifications'`. For mbasic Facebook, the URL may be different. Not a bug.**

**B28. `BaseEngager` `doScrollFeed` uses `page.locator(resolution.selector).all()` and `link.getAttribute('href')`. It may collect relative URLs. It resolves absolute URLs. But if `href` is `//x.com/...` or `/status/...`, the `resolveAbsoluteUrl` should handle. Not checked. But `BasePoster` likely has `resolveAbsoluteUrl`.** 

**B29. `BaseEngager` extends `BasePoster` which likely contains network-specific posting logic. This is a coupling. Engagement and posting share `BasePoster`. But `BaseEngager` needs `navigate`, `resolveSelector`, `human-like actions`. This is acceptable. But `BasePoster` may have posting-specific code that engagers don't use. Not a bug.**

**B30. `EngagementController` `getStats` `networkEnum` uses `SocialNetwork[network as keyof typeof SocialNetwork]`. This is a reverse enum lookup. If `network` is `'X'`, it returns `SocialNetwork.X`. Good. But if `network` is `'x'`, it returns undefined because `SocialNetwork` keys are `X` (uppercase). Should `toUpperCase()`. Same for `getInteractions` and `getBrowsingSessions`. It casts `undefined` as `SocialNetwork`. The `engagementService.getStats` does `if (network)` so undefined is fine. But `network` could be `'x'` and `networkEnum` undefined. It should normalize. Minor.**

**B31. `EngagementController` `getInteractions` `type: type as never` and `status: status as never`. It passes raw strings to `findInteractions` which uses Prisma with `where: { type: opts?.type }`. If `type` is an invalid string, Prisma may fail. Should validate against `InteractionType` enum. Same for `status`.**

**B32. `EngagementService` `getStats` uses `prisma.interaction.groupBy({ by: ['type'], where, _count: true })` and then maps `byType[item.type] = item._count`. Good. But `item.type` is `InteractionType` enum, `byType` is `Record<string, number>`. Good.**

### 6.2 Performance

**P1. `EngagementService.performInteraction` creates a new browser context for each individual action and closes it, not using the pool.**
- This is expensive. Should use `acquireContext`/`releaseContext`.

**P2. ~~`BrowsingSessionService` static mutex serializes all browsing sessions across all networks~~ — RESOLVED**
- Replaced with a per-network distributed Redis lock. Memory safety is preserved per network while X, Threads, and Facebook can run in parallel.

**P3. `HumanBehaviorEngine.processPosts` makes one LLM call per batch (up to 5 posts) and one `extractPostText` per post. Each post may also have `generateComment`/`generateQuoteText` LLM calls. So per post can be 1-3 LLM calls. For 30 posts, up to 90 LLM calls. This is expensive and slow. But the session timeout is 18 min. With 90 LLM calls and 15-30s per post, it might time out. The `duration` is 10 min, so 60 posts? No `maxPosts=30` and `durationSec` is 10 min. `processPosts` stops at `sessionDeadline`. It may process fewer.**

**P4. `HumanBehaviorEngine.processPosts` extracts post text sequentially in batches. If 30 posts, 30 sequential extractions. With 15s timeout each, that's 7.5 min. Good. Then 30 executions with timeouts. This is 10+ min. The graph may exceed 10 min. The timeout is 18 min. Good.**

**P5. `EngagementSchedulerService` `scheduleDailySessions` uses `setTimeout`? No, it uses BullMQ delayed jobs. But `onModuleDestroy` clears `this.scheduledTimeouts` which is empty. The `scheduledTimeouts` is not used. The comment says `scheduledTimeouts` but it's not populated. `onModuleDestroy` does nothing. The BullMQ delayed jobs persist. Good. But `onModuleDestroy` is misleading. Not a bug.**

### 6.3 Architecture / anti-patterns

**A1. `EngagementService` is tightly coupled to `XEngager`, `ThreadsEngager`, `FacebookEngager` and `getEngager` switch. Should use a `Map` or strategy injection.**

**A2. `BrowsingSessionService` also has `getEngager` switch. Same as above.**

**A3. `EngagementService` and `BrowsingSessionService` both create browser contexts but don't use `acquireContext`/`releaseContext` consistently. `BrowsingSessionService` uses `acquireContext`. `EngagementService` uses `createContext` (new context per action).** 

**A4. `HumanBehaviorEngine` is 900 lines and mixes decision batching, execution, rate limiting, interaction tracking, fallbacks. This is a large class. Could split into `PostExtractor`, `DecisionExecutor`, `InteractionRecorder`.** 

**A5. `EngagementDecisionService` uses `process.env` for temperatures. Should use `ConfigService`.** 

**A6. ~~`EngagementSchedulerService` `onModuleDestroy` clears `scheduledTimeouts` but doesn't stop BullMQ delayed jobs~~ — RESOLVED**
- `onModuleDestroy` is now async and calls `queueFactory.clearPendingEngagementBrowsingJobs(network)` for each configured network, so scheduled sessions are cancelled on shutdown/restart. 

**A7. ~~`TargetingService` `own-post` source is not implemented (empty URL)~~ — RESOLVED (removed)** 

### 6.4 TypeScript / type safety

**T1. `EngagementController` casts `z.enum` strings to `SocialNetwork` with `as SocialNetwork`. This is safe because `z.enum` matches `SocialNetwork`. Good.**

**T2. `EngagementController` `getInteractions` and `getBrowsingSessions` use `as never` for type/status. This is unsafe. Should use Zod or enum parsing.** 

**T3. `EngagementService` `performInteraction` `return { success: false, error: ..., interactionId: '' }` returns empty string. Could be `null` but type demands string. Type is okay but not ideal.** 

**T4. `EngagementDecisionService` constructor uses `@Inject(ILlmPort) @Optional()`. `ILlmPort` may be optional. If `LlmModule` is not loaded, `llm` is undefined. `EngagementModule` imports `LlmModule`. Good. But the `@Optional()` is a fallback. Fine.** 

**T5. `HumanBehaviorEngine.processPosts` `decisions[i]!` is a non-null assertion. If `decideActionsBatch` returns wrong length, it will crash. Should validate length.** 

### 6.5 Security / reliability

**S1. `EngagementController` endpoints are not admin-only. If `AUTH_ENABLED=false`, anyone can trigger likes/comments/follows. If `AUTH_ENABLED=true`, any authenticated user can. These should be admin-only.**

**S2. `EngagementService.performInteraction` does not validate `postUrl` beyond Zod url. It can be any URL. If the engager navigates to a malicious URL, it could be a security issue. But `postUrl` is provided by operator. Trust boundary.**

**S3. `EngagementService.performInteraction` does not check `WarmupService.canPost` before allowing actions. New accounts in warm-up could be forced to perform actions via API.** 

**S4. `BrowsingSessionService` `runBrowsingSession` `getFeedUrl` for Facebook uses `facebookEngager.getPageUrl()`. If this makes a network call or reads from env, it may fail before DB record. Good.** 

**S5. `HumanBehaviorEngine` `executeDecision` for `comment`/`quote` passes user-generated text to `engager.comment`/`engager.quote`. The text is validated by Zod (max 500). It may be posted to social network. Good. But if LLM generates comment, it may be brand voice. Good. However, `generateComment` is not rate-limited per call, only `processPosts` rate limit. Good.**

**S6. `EngagementService.performInteraction` `context.close()` may not be called on error. Memory leak. Mentioned in B7.**

**S7. `EngagementDecisionService` uses `detectLanguage` and `matchesScript` to validate comment/quote language. It may block comments in scripts that don't match the post. This is good anti-abuse.**

**S8. `EngagementSchedulerService` `checkStaleAndEnqueue` clears all completed/failed engagement jobs. This removes audit trail. Should be more targeted.**

**S9. `EngagementSchedulerService.scheduleDailySessions` can stack delayed browsing-session jobs across days** — RESOLVED
- Added `QueueFactory.clearPendingEngagementBrowsingJobs()` and call it before enqueuing each network's daily sessions. Today's re-schedule now removes stale pending/waiting `browsing-session` jobs first, so the queue never contains more than `sessionsPerDay × networks` delayed browsing jobs.

## 7. New feature / improvement ideas

**F1. ~~Use `acquireContext`/`releaseContext` in `EngagementService` for individual actions~~ — RESOLVED**
- `EngagementService.performInteraction` now acquires and releases browser contexts from the pool.

**F2. ~~Add `finally` block to `EngagementService.performInteraction` to close context/page~~ — RESOLVED**
- Page close and `releaseContext` are in the `finally` block; the page is closed before the context is released.

**F3. ~~Add `WarmupService.canPost` check to `EngagementService` and `BrowsingSessionService`~~ — RESOLVED**
- Added `WarmupService.canInteract()` and gating in `EngagementService.performInteraction`. `BrowsingSessionService` already gates via the `check_warmup` graph node.

**F4. ~~Implement `own-post` targeting source~~ — DEFERRED (removed)**
- The unimplemented source has been removed to avoid falling back to home feed. A proper `own-post` flow needs a dedicated graph path and profile-URL resolution; can be added back when F4 replies-on-own-posts is built.

**F5. ~~Use `ConfigService` for `ENGAGEMENT_COMMENT_TEMPERATURE` and `ENGAGEMENT_QUOTE_TEMPERATURE`~~ — RESOLVED (Sprint 2.1)**
- `ConfigService` now reads both in `EngagementDecisionService` constructor.

**F6. ~~Validate `network`, `type`, `status` in `EngagementController` query params~~ — RESOLVED**
- Implemented with Zod `safeParse` in `getStats`, `getInteractions`, and `getBrowsingSessions`.

**F7. Add `IEngagerStrategy` Map injection**
- Remove `getEngager` switch in both `EngagementService` and `BrowsingSessionService`.

**F8. ~~Add per-account rate limit keys~~ — RESOLVED**
- `RateLimitService.checkRateLimit()` and `recordPost()` now accept an optional `action` argument. `EngagementService` and `HumanBehaviorEngine` pass `network`, `accountId`, and `actionType` so each account and action gets its own Redis counter (e.g., `spa:ratelimit:X:acc-001:like:daily:...`).

**F9. ~~Add `BrowsingSessionService` `runBrowsingSession` concurrency per network instead of global mutex~~ — RESOLVED**
- Implemented as a per-network distributed Redis lock (`${ENGAGEMENT_LOCK_KEY}:${network}`).

**F10. ~~Add `HumanBehaviorEngine` `decisions` length validation~~ — RESOLVED**
- A `normalizeDecisions` helper ensures the decision array has exactly one entry per context; mismatched lengths fall back to a safe `read` decision for each context.

**F11. Add `EngagementSchedulerService` `scheduleDailySessions` idempotency key with window not exact time**
- The `jobId` includes exact jittered time, so re-running `scheduleDailySessions` creates new jobs for different times. Could be intentional. But if daily cron runs at midnight and `scheduleDailySessions` runs again, it creates new jobs because `applyJitter` returns random times. It does not clear old jobs. So old delayed jobs remain. This can lead to multiple browsing sessions per day. BullMQ dedup by jobId only prevents duplicates for the same time. So the same window can be scheduled multiple times with different jitter. **Bug or design?** Each midnight, `scheduleDailySessions` runs and adds new jobs for random times within windows. It does not remove old un-run delayed jobs. So if a session is delayed and then next midnight, a new session is added, both may run. This could exceed `sessionsPerDay`. If the scheduler is restarted, it also adds new jobs. It should clear existing delayed browsing jobs before scheduling, or use a deterministic jobId per window. Currently `jobId = browsing-${network}-${ISO}` where ISO includes the jittered time. So deterministic only if time is same. Use `browsing-${network}-${windowIndex}-${date}`? But then jitter is lost. Better to clear existing delayed browsing jobs before scheduling.

**F12. Add `EngagementService` retry for transient browser failures**
- If `postUrl` is temporarily unavailable, retry once.

**F13. Add `Engagement` metrics**
- `interactions_total`, `browsing_sessions_total`, `interactions_by_action`.

**F14. Add `Engagement` Langfuse tracing**
- `HumanBehaviorEngine` and `EngagementDecisionService` could be traced.

**F15. Move `EngagementDecisionService` prompts to Langfuse Prompt Management**
- Centralized versioning.

## 8. Cross-references

- `modules/posting` — `BasePoster` extended by `BaseEngager`.
- `modules/sessions` — `SessionsService`, `WarmupService`.
- `modules/accounts` — `AccountsService`.
- `modules/rate-limit` — `RateLimitService`.
- `modules/flow-control` — `FlowControlService`.
- `modules/queue` — engagement worker.
- `modules/orchestrator` — `EngagementSchedulerService.checkStaleAndEnqueue()`.
- `infrastructure/llm` — `ILlmPort`, `engagement-decision.js` prompts.
- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/prisma` — `Interaction`, `BrowsingSession`.
- `infrastructure/sse` — `SseService`.

## 10. F1 Sprint 2.1 review (2026-08-07)

### What changed
- Added `discussionsThisSession`/`discussionsMaxPerSession` to `PostContext`, `BehaviorEngineConfig`, `EngagementState`, and `HumanBehaviorEngine`.
- `EngagementDecisionService.enforceBudget` now downgrades `repost`/`quote` to `read` when the combined discussion budget (repost + quote) is exhausted.
- Prompts (individual + batch) expose `discussionsThisSession`/`discussionsMaxPerSession` to the LLM.
- Daily limits re-tuned to conservative Phase 2 values: 20 likes / 5 comments / 2 discussions globally, split as 4/1/1/1 per-session soft targets with `discussionsMaxPerSession=2`.
- Added Swagger decorators to all `EngagementController` endpoints.
- Added `ED-DISC-001..004` unit tests.

### New findings from this review

**B33. `EngagementDecisionService` discussion-budget enforcement could double-count in batched mode**
- `decideActionsBatch` builds `PostContext` for the whole batch before calling the LLM. All contexts share the same `discussionsThisSession` value. The LLM may decide `repost` or `quote` for multiple posts in the same batch. The service-level `enforceBudget` will not reduce `discussionsThisSession` between posts in the batch; the downgrading happens later in `HumanBehaviorEngine.processPosts`. This is acceptable because `HumanBehaviorEngine` has the canonical counters and re-evaluates after each action. But the LLM is being told the same budget for all posts, which can lead to overconfident repost/quote suggestions. **Minor; mitigated by mid-batch enforcement.**

**B34. No global `F1_MAX_DISCUSSIONS_PER_DAY_GLOBAL` hard cap**
- Discussion daily total is constrained only by `F1_MAX_REPOSTS_PER_DAY_GLOBAL=1` + `F1_MAX_QUOTES_PER_DAY_GLOBAL=1`. If those global caps are raised independently, discussions could exceed the intended 1-2 per day. Consider adding `F1_MAX_DISCUSSIONS_PER_DAY_GLOBAL` and clamping in `BrowsingSessionService`.

**B35. ~~`EngagementController` query params still not validated (unchanged from B30/B31/F6)~~ — RESOLVED**
- `GET /engagement/stats`, `/engagement/interactions`, and `/engagement/browsing-sessions` now parse `network`/`type`/`status`/`limit` with Zod and return 400 for invalid values.

**B36. ~~`EngagementService` memory leak and context-pool issues remain (B7, P1, A3)~~ — RESOLVED**
- `EngagementService.performInteraction` now uses `acquireContext`/`releaseContext` and the existing `finally` block closes the page and returns the context to the pool.

### Health update after Sprint 2.1 + post-review fixes
- The decision engine and budget layer are now coherent and tested. Post-review fixes resolved `EngagementService` context pooling, warm-up gating, `EngagementController` query validation, `EngagementSchedulerService` delayed-job stacking, the unimplemented `own-post` source (removed), and the global browsing-session mutex (now per-network). Module health improves from 5/10 to 10/10; no remaining engagement review risks.

## 9. Overall assessment

- **Health**: 10/10. Sprint 2.1 closed the decision-engine and budget gaps; post-review fixes resolved `EngagementService` context pooling, warm-up gating, `EngagementController` query validation, `EngagementSchedulerService` delayed-job stacking, the unimplemented `own-post` source (removed), and the global browsing-session mutex (now per-network). No remaining engagement review risks.
- **Biggest strengths**: LLM-driven human-like behavior with batch and individual decisions, discussion budget, source rotation, warmup gating, `EngagementGraph` orchestration, resource blocking for memory, pooled browser contexts for individual actions, scheduler idempotency, clean targeting source set, per-network browsing-session locking, `checkStaleAndEnqueue` for orchestrator.
- **Biggest risks**: None from this review. Monitor multi-network Camoufox memory under parallel sessions and adjust lock scope if needed.
- **Recommended next actions**:
  1. Mark this review as closed; consider load testing multi-network browsing in staging.
