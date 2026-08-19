# Module: `modules/engagement`

## 1. What this module does

`modules/engagement` implements the social-automation engagement subsystem: likes, comments, follows, replies, reposts, quotes, and autonomous browsing sessions that scroll feeds and use an LLM-driven decision engine to act like a human user. It is feature-flagged behind `ENGAGEMENT_ENABLED` and `ENGAGEMENT_SCHEDULER_ENABLED`.

**Main responsibilities:**
- `EngagementService` — API-triggered individual engagement actions.
- `BrowsingSessionService` — autonomous browser sessions that scroll feeds and perform human-like interactions.
- `EngagementSchedulerService` — schedules browsing sessions via BullMQ delayed jobs.
- `HumanBehaviorEngine` — LLM-driven per-post decision loop (scroll/read/like/comment/repost/quote).
- `EngagementDecisionService` — calls LLM to decide actions and generate comments/quotes.
- `TargetingService` — rotates sources (home feed, hashtag, competitor, explore, own posts, notifications).
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
  2. Builds `rateKey` `${network}-${action}` and calls `rateLimitService.checkRateLimit(rateKey)`.
  3. Gets session via `sessionsService.getOrCreateSession(network)`.
  4. Creates `Interaction` record in `IN_PROGRESS`.
  5. Creates browser context with decrypted storage state.
  6. Calls the appropriate `BaseEngager` method.
  7. Saves updated storage state.
  8. Updates `Interaction` to `COMPLETED`/`FAILED`.
  9. Calls `rateLimitService.recordPost(rateKey)` if successful and not already liked/reposted.
  10. Emits SSE events.

### 3.2 `BrowsingSessionService.runBrowsingSession()`

- Acquires a static `sessionMutex` (only one browsing session across all networks at a time, due to memory concerns).
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
  - Releases page/context and mutex.

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
  2. Get LLM decisions via `decisionPort.decideActionsBatch()` or `decideAction()` (fallback to individual, then fallback to `read`).
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

- Sources: `home-feed`, `hashtag`, `competitor`, `explore`, `own-post`, `notifications`.
- Weights configurable via `ENGAGEMENT_WEIGHT_*`.
- URL builders for X, Threads, Facebook.

### 3.7 `EngagementDecisionService`

- Uses `ILlmPort` (multi-provider fallback).
- Prompts in `infrastructure/llm/prompts/v0.4.0/engagement-decision.js`.
- `decideAction` and `decideActionsBatch` parse LLM JSON response.
- Budget enforcement and fallback to `read`/`like`.
- Generates comments/quotes in brand voice.

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
| `F1_BROWSING_SESSION_MINUTES` | `10` | Duration (not validated) |
| `F1_LIKES_MAX_PER_DAY` | `15` | Likes per session (not validated) |
| `F1_COMMENTS_MAX_PER_DAY` | `4` | Comments per session (not validated) |
| `F1_REPOSTS_MAX_PER_DAY` | `5` | Reposts per session (not validated) |
| `F1_QUOTES_MAX_PER_DAY` | `2` | Quotes per session (not validated) |
| `F1_MAX_POSTS_PER_SESSION` | `30` | Max posts evaluated (not validated) |
| `ENGAGEMENT_HASHTAGS` | multi-language defaults | Hashtag pool (not validated) |
| `ENGAGEMENT_COMPETITORS` | `costarastrology,...` | Competitor pool (not validated) |
| `ENGAGEMENT_WEIGHT_*` | 40/25/15/10/5/5 | Source weights (not validated) |
| `ENGAGEMENT_COMMENT_TEMPERATURE` | `0.8` | Comment LLM temp (read directly from `process.env` in `engagement-decision.service.ts:34`) |
| `ENGAGEMENT_QUOTE_TEMPERATURE` | `0.8` | Quote LLM temp (read directly from `process.env` in `engagement-decision.service.ts:35`, but currently ignored at `:261`) |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `BrowsingSessionService` uses a static `sessionMutex` (Promise) to serialize all browsing sessions across all networks**
- `browsing-session.service.ts:54` `private static sessionMutex: Promise<void> = Promise.resolve();`. This ensures only one session runs at a time globally, due to memory constraints. But if an engagement worker picks up a browsing session job and waits for the mutex, it may hold a BullMQ worker idle for a long time. This prevents other engagement queues (e.g., like/comment) from processing? Wait, the `sessionMutex` is only for browsing sessions. The like/comment actions are handled by `EngagementService` in the same worker? The `queue.module.ts` worker for engagement dispatches by action: `browsing-session` calls `BrowsingSessionService`, others call `EngagementService`. The `sessionMutex` is static across all `BrowsingSessionService` instances. If a browsing session is long (15 min), the worker is blocked. With concurrency=1 per engagement queue, one network's browsing session blocks that queue's other engagement jobs. But if two networks each have a browsing session, they are serialized by the static mutex. The worker waits. This is a bottleneck but intentional. However, if the mutex is held and the worker is blocked, it cannot process other jobs in the same queue. But there are separate queues per network. So network X's browsing session doesn't block network Threads' queue. It blocks if a second browsing session for X is queued. Fine. But if a single `BrowsingSessionService` instance is used by two workers (singleton), the static mutex is shared. Good. This is a memory safety workaround, not a bug.

**B2. `BrowsingSessionService` `runBrowsingSession` throws `Error` if no session, but also `releaseMutex` is called before throwing. Good.**

**B3. `BrowsingSessionService` `runBrowsingSession` `getFeedUrl` for Facebook uses `this.facebookEngager.getPageUrl()`. If `getPageUrl()` throws or returns undefined, the feedUrl may be invalid. It is set in DB before navigation. Good.**

**B4. `BrowsingSessionService` `findAll` and `findInteractions` use `status` query without parsing. `BrowsingSessionStatus` and `InteractionStatus` are enums. The `EngagementController` passes `status as never` from query string. If the query string is invalid, Prisma may fail. Should validate.**

**B5. `BrowsingSessionService` `runBrowsingSession` `pre-session health check` calls `page.evaluate(() => 1)` with `withTimeout(10_000)`. If page is not responsive, it catches and continues. But for fatal errors like `Target page...` it throws. Good. But it doesn't test navigation, only JS evaluate. A page may evaluate JS but still fail to navigate. Acceptable.**

**B6. `EngagementService.performInteraction` creates a `browser.createContext` (not `acquireContext`). It does not release/close the context after use? It closes `page` and `context` but does not call `releaseContext`. It uses `context.close()`. This is a new context each time, not pooled. For individual actions, it creates a new context and closes it. This is expensive. It should use `acquireContext`/`releaseContext` like `BrowsingSessionService` to reuse contexts. Also, `browser.createContext` may be for Facebook persistent context? The `browser.createContext` signature: `createContext(network, storageState?)`. It may be a new context per call. This is a performance issue. But individual actions are infrequent. However, it doesn't use the pool, so it doesn't benefit from `BrowserFactory` pooling. Should be `acquireContext`/`releaseContext`.**

**B7. `EngagementService.performInteraction` `catch (err)` catches all errors and updates `Interaction` to `FAILED`, but does not close the context if the action failed. It has `await page.close().catch()` and `await context.close().catch()` in `try` block. If an error occurs before `page` is created, `page.close()` is not reached. If an error occurs after `page` is created but before `context.close()`, the `catch` block doesn't close. But `try` has `page.close()` and `context.close()` after `action`. If `action` throws, those are not executed. Then `catch` returns, leaving context/page open. **Memory leak** for individual actions. Need `finally` close. Same for `browsing-session.service`? It uses `finally` for page/context. Good. `EngagementService` does not. **Bug.**

**B8. `EngagementService.performInteraction` `rateLimitService.recordPost(rateKey)` is called with `rateKey` `${network}-${type.toLowerCase()}` (e.g., `X-like`). `RateLimitService.resolveLimits` handles this. But `recordPost` uses `intervalMs = resolveLimits(rateKey).intervalMs` which for interaction is `interactionMinIntervalMs` (default 0). Good. `checkRateLimit` uses `resolveLimits` and reads `intervalKey`. But `recordPost` sets `intervalKey` with `PX intervalMs` only if `intervalMs > 0`. For interaction default 0, no interval. Good. But `RateLimitService` does not handle `0` for `interaction_*_MAX_PER_DAY` as B8 in rate-limit. If someone sets `RATE_LIMIT_INTERACTION_LIKE_MAX_PER_DAY=0`, it falls back to 60. This is a bug.**

**B9. `EngagementService.performInteraction` `interactionId` is empty string in early returns (paused, rate limited, no session). The caller gets `interactionId: ''`. Should be null or omitted. But the return type says `EngagementResult & { interactionId: string }`. Empty string is valid type. Not ideal.**

**B10. `EngagementService.performInteraction` does not check `WarmupService.canPost` before creating a session or interaction.**
- A new account in `browse-only` warm-up should not be allowed to perform actions. `HumanBehaviorEngine` handles budgets, but `EngagementService` doesn't. For API-triggered individual actions, `WarmupService` is not checked. Should call `warmupService.canPost(accountId)`.

**B11. `HumanBehaviorEngine.processPosts` uses `postsProcessed` counter. It increments `postsProcessed` for extraction failures (line 177) and for each executed decision (line 231). But if an extraction fails and it continues, it doesn't record a result. Then if extraction fails, `postsProcessed` increments but `results` doesn't. It might exit early. This is okay for maxPosts count.**

**B12. `HumanBehaviorEngine.processPosts` `first-interaction quota` converts `read`/`scroll`/`skip` to `like` if `postsProcessed > 5` and `totalInteractions === 0`. This is a hack. It may force a like on a post that the LLM didn't want to like. But it's to avoid zero interactions. Acceptable.**

**B13. `HumanBehaviorEngine.processPosts` `decisions` array from `decideActionsBatch` may have different length than `contexts` if parsing fails. `parseBatchDecisionResponse` may pad/truncate. It then iterates with `contexts[i]!` and `decisions[i]!`. If lengths mismatch, `decisions[i]` may be undefined. This would throw `TypeError`. Need length check.**

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

**B24. `EngagementDecisionService` `process.env` reads for `ENGAGEMENT_COMMENT_TEMPERATURE` and `ENGAGEMENT_QUOTE_TEMPERATURE` instead of `ConfigService`, and quote generation uses the wrong temperature constant**
- `engagement-decision.service.ts:34-35` reads both constants from `process.env` at module load. `ConfigService` is not injected into the constructor (it only injects `ILlmPort`), so the variables are not centralized.
- Line 207 passes `ENGAGEMENT_COMMENT_TEMPERATURE` for comment generation (correct).
- Line 261 passes `ENGAGEMENT_COMMENT_TEMPERATURE` for **quote** generation — it should pass `ENGAGEMENT_QUOTE_TEMPERATURE`. This is a real bug: quote and comment prompts will use the same temperature regardless of the `ENGAGEMENT_QUOTE_TEMPERATURE` env var.

**B25. `TargetingService` source weights are `configService.get<number>` and may be strings. `this.sourceWeights` is `Record<EngagementSource, number>` but may be strings. `pickSource` uses `this.sourceWeights[s.source]` in arithmetic. If string, JS coercion works. But type is wrong. Should `Number()`.** Also `get<number>` from `ConfigService` may not parse. This is a recurring issue.

**B26. `TargetingService` `getAvailableSources` for `own-post` uses `url: ''` and `label: 'Own Posts (replies to comments)'`. The URL is resolved by engager. But `engagement.graph.ts` `scroll_feed` uses `sourceUrl` from `pickSource`. If `url` is empty, `sourceUrl` becomes empty and falls back to home feed. Then `scroll_feed` checks `if (sourceUrl) { ... } else { scrollFeed }`. So `own-post` always falls back to home feed, never actually goes to own posts. The `engager` may need to handle `own-post` specially. But `scrollUrl` receives a URL. If URL is empty, it scrolls home feed. So `own-post` source is not implemented. This is a bug. The `own-post` source should build the account profile URL using the account handle. It does not. It might be a known limitation. `TargetingService` has `getHomeFeedUrl` but no own-post URL. This is a bug or incomplete feature.**

**B27. `TargetingService` `getNotificationsUrl` for Facebook returns `'https://www.facebook.com/notifications'`. For mbasic Facebook, the URL may be different. Not a bug.**

**B28. `BaseEngager` `doScrollFeed` uses `page.locator(resolution.selector).all()` and `link.getAttribute('href')`. It may collect relative URLs. It resolves absolute URLs. But if `href` is `//x.com/...` or `/status/...`, the `resolveAbsoluteUrl` should handle. Not checked. But `BasePoster` likely has `resolveAbsoluteUrl`.** 

**B29. `BaseEngager` extends `BasePoster` which likely contains network-specific posting logic. This is a coupling. Engagement and posting share `BasePoster`. But `BaseEngager` needs `navigate`, `resolveSelector`, `human-like actions`. This is acceptable. But `BasePoster` may have posting-specific code that engagers don't use. Not a bug.**

**B30. `EngagementController` `getStats` `networkEnum` uses `SocialNetwork[network as keyof typeof SocialNetwork]`. This is a reverse enum lookup. If `network` is `'X'`, it returns `SocialNetwork.X`. Good. But if `network` is `'x'`, it returns undefined because `SocialNetwork` keys are `X` (uppercase). Should `toUpperCase()`. Same for `getInteractions` and `getBrowsingSessions`. It casts `undefined` as `SocialNetwork`. The `engagementService.getStats` does `if (network)` so undefined is fine. But `network` could be `'x'` and `networkEnum` undefined. It should normalize. Minor.**

**B31. `EngagementController` `getInteractions` `type: type as never` and `status: status as never`. It passes raw strings to `findInteractions` which uses Prisma with `where: { type: opts?.type }`. If `type` is an invalid string, Prisma may fail. Should validate against `InteractionType` enum. Same for `status`.**

**B32. `EngagementService` `getStats` uses `prisma.interaction.groupBy({ by: ['type'], where, _count: true })` and then maps `byType[item.type] = item._count`. Good. But `item.type` is `InteractionType` enum, `byType` is `Record<string, number>`. Good.**

### 6.2 Performance

**P1. `EngagementService.performInteraction` creates a new browser context for each individual action and closes it, not using the pool.**
- This is expensive. Should use `acquireContext`/`releaseContext`.

**P2. `BrowsingSessionService` static mutex serializes all browsing sessions across all networks.**
- This avoids memory crashes but is a major throughput bottleneck. If a session takes 15 min, a second session waits 15 min.

**P3. `HumanBehaviorEngine.processPosts` makes one LLM call per batch (up to 5 posts) and one `extractPostText` per post. Each post may also have `generateComment`/`generateQuoteText` LLM calls. So per post can be 1-3 LLM calls. For 30 posts, up to 90 LLM calls. This is expensive and slow. But the session timeout is 18 min. With 90 LLM calls and 15-30s per post, it might time out. The `duration` is 10 min, so 60 posts? No `maxPosts=30` and `durationSec` is 10 min. `processPosts` stops at `sessionDeadline`. It may process fewer.**

**P4. `HumanBehaviorEngine.processPosts` extracts post text sequentially in batches. If 30 posts, 30 sequential extractions. With 15s timeout each, that's 7.5 min. Good. Then 30 executions with timeouts. This is 10+ min. The graph may exceed 10 min. The timeout is 18 min. Good.**

**P5. `EngagementSchedulerService` `scheduleDailySessions` uses `setTimeout`? No, it uses BullMQ delayed jobs. But `onModuleDestroy` clears `this.scheduledTimeouts` which is empty. The `scheduledTimeouts` is not used. The comment says `scheduledTimeouts` but it's not populated. `onModuleDestroy` does nothing. The BullMQ delayed jobs persist. Good. But `onModuleDestroy` is misleading. Not a bug.**

### 6.3 Architecture / anti-patterns

**A1. `EngagementService` is tightly coupled to `XEngager`, `ThreadsEngager`, `FacebookEngager` and `getEngager` switch. Should use a `Map` or strategy injection.**

**A2. `BrowsingSessionService` also has `getEngager` switch. Same as above.**

**A3. `EngagementService` and `BrowsingSessionService` both create browser contexts but don't use `acquireContext`/`releaseContext` consistently. `BrowsingSessionService` uses `acquireContext`. `EngagementService` uses `createContext` (new context per action).** 

**A4. `HumanBehaviorEngine` is 900 lines and mixes decision batching, execution, rate limiting, interaction tracking, fallbacks. This is a large class. Could split into `PostExtractor`, `DecisionExecutor`, `InteractionRecorder`.** 

**A5. `EngagementDecisionService` uses `process.env` for temperatures. Should use `ConfigService`.** 

**A6. `EngagementSchedulerService` `onModuleDestroy` clears `scheduledTimeouts` but doesn't stop BullMQ delayed jobs. Misleading. Should remove or document.** 

**A7. `TargetingService` `own-post` source is not implemented (empty URL).** 

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

## 7. New feature / improvement ideas

**F1. Use `acquireContext`/`releaseContext` in `EngagementService` for individual actions**
- Fix memory leak and improve performance.

**F2. Add `finally` block to `EngagementService.performInteraction` to close context/page**
- Fix memory leak on errors.

**F3. Add `WarmupService.canPost` check to `EngagementService` and `BrowsingSessionService`**
- Respect warm-up phases for API-triggered actions.

**F4. Implement `own-post` targeting source**
- Build account profile URL and use it to reply to comments on own posts.

**F5. Use `ConfigService` for `ENGAGEMENT_COMMENT_TEMPERATURE` and `ENGAGEMENT_QUOTE_TEMPERATURE`**
- Remove `process.env` read.

**F6. Validate `network`, `type`, `status` in `EngagementController` query params**
- Use `ParseEnumPipe` or Zod.

**F7. Add `IEngagerStrategy` Map injection**
- Remove `getEngager` switch in both `EngagementService` and `BrowsingSessionService`.

**F8. Add per-account rate limit keys**
- Currently `EngagementService` uses `${network}-${action}`; if multi-account, they share limits.

**F9. Add `BrowsingSessionService` `runBrowsingSession` concurrency per network instead of global mutex**
- The global mutex is a bottleneck. But memory may require it. Could be a pool semaphore.

**F10. Add `HumanBehaviorEngine` `decisions` length validation**
- Avoid crashes if batch response has wrong length.

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

## 9. Overall assessment

- **Health**: 5/10. The engagement module is ambitious and feature-rich but has significant issues: memory leaks in `EngagementService`, `own-post` not implemented, `process.env` for temperatures, `EngagementService` not using context pool, static mutex bottleneck, `scheduleDailySessions` not clearing old delayed jobs, controller not validating query enums.
- **Biggest strengths**: LLM-driven human-like behavior, source rotation, warmup gating, batch decisions, `EngagementGraph` orchestration, resource blocking for memory, `checkStaleAndEnqueue` for orchestrator.
- **Biggest risks**: `EngagementService` memory leak (no `finally` close context), `own-post` source not implemented, `scheduleDailySessions` can stack delayed jobs, static mutex limits throughput, `process.env` read, controller validation gaps, no warm-up check for API actions.
- **Recommended next actions**:
  1. Add `finally` to `EngagementService.performInteraction` to close context/page.
  2. Switch `EngagementService` to `acquireContext`/`releaseContext`.
  3. Implement `own-post` source or remove it.
  4. Fix `EngagementSchedulerService` to clear old delayed browsing jobs before re-scheduling.
  5. Use `ConfigService` for comment/quote temperature.
  6. Validate `network`/`type`/`status` in `EngagementController`.
  7. Add `WarmupService.canPost` check for API actions.
