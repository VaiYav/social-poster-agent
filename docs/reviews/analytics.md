# Module: `modules/analytics`

## 1. What this module does

`modules/analytics` provides a read-only analytics dashboard and a metrics scraper for posted content. It aggregates `Post`/`PostMetrics` data into summary statistics, top posts, per-post metrics, and history; and it collects engagement counts (likes, comments, shares) from Threads and Facebook Insights APIs. X is deferred due to no free API access.

**Main responsibilities:**
- `AnalyticsService` — summary stats, network breakdown, daily stats, top posts.
- `MetricsScraperService` — cron or manual scraping of post metrics from HTTP sources.
- `ThreadsInsightsSource` / `FacebookInsightsSource` / `graph-insights.ts` — network-specific API parsers.
- `AnalyticsController` — REST endpoints for dashboard and manual scrape trigger.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `analytics.module.ts` | NestJS module | `AnalyticsModule` — imports Prisma, Browser, SSE, ContentEnhancements |
| `analytics.service.ts` | Service | `getSummary()`, `getTopPosts(limit)` |
| `metrics-scraper.service.ts` | Service | `onModuleInit()`, `collectMetrics()`, `getLatestMetricsForPost(postId)`, `getMetricsHistory(postId)` |
| `metrics-sources/metrics-source.port.ts` | Port | `IMetricsSource`, `PostMetricsData`, `PostMetricsRef`, `FetchFn` |
| `metrics-sources/threads-insights.source.ts` | Source | `ThreadsInsightsSource.fetchMetrics()` |
| `metrics-sources/facebook-insights.source.ts` | Source | `FacebookInsightsSource.fetchMetrics()`, `parseFacebookPostCounts()` |
| `metrics-sources/graph-insights.ts` | Parser | `extractMetric()`, `parseGraphInsights()` |
| `analytics.controller.ts` | REST API | `GET /analytics/summary`, `GET /analytics/top-posts`, `GET /analytics/metrics/:postId`, `GET /analytics/metrics/:postId/history`, `POST /analytics/scrape`, `GET /analytics/hook-performance`, `POST /analytics/hook-performance/aggregate` |

## 3. How it works

### 3.1 `AnalyticsService`

- `getSummary()` counts `total`, `posted`, `failed`, `pending` (DRAFT/APPROVED/POSTING) and computes success rate.
- `getNetworkStats()` loops over X/Threads/Facebook and counts per network.
- `getDailyStats(days)` groups POSTED/FAILED posts by `createdAt` date, filling missing days.
- `getTopPosts(limit)` returns most recent `POSTED` posts by `postedAt` (not by engagement metrics).

### 3.2 `MetricsScraperService`

- `getSources()` lazily builds a map of `SocialNetwork → IMetricsSource` from env tokens (`THREADS_ACCESS_TOKEN`, `FACEBOOK_PAGE_TOKEN`).
- `onModuleInit()` registers a daily cron if `METRICS_SCRAPER_ENABLED='true'` and orchestrator not enabled.
- `collectMetrics()` queries `Post` with `POSTED`, `postUrl != null`, `postedAt >= 30 days ago`, `take: 50`.
- For each post, calls `scrapePostMetrics()` which dispatches to the source for the network.
- Writes `PostMetrics` row; `collected++` on success, `failed` on error, `skipped` if no source.
- Publishes `health_alert` SSE when done.
- `getLatestMetricsForPost` / `getMetricsHistory` query `PostMetrics`.

### 3.3 Sources

- `ThreadsInsightsSource`: extracts media shortcode from URL, calls `graph.threads.net/v1.0/{mediaId}/insights`.
- `FacebookInsightsSource`: extracts numeric post id from URL, calls `graph.facebook.com/v21.0/{id}?fields=likes.summary(true),comments.summary(true),shares`.
- `graph-insights.ts`: extracts metric values from `data[]` envelope, supporting `values` or `total_value`.

### 3.4 Controller

- `GET /analytics/summary` and `/top-posts`.
- `GET /analytics/metrics/:postId` and `/:postId/history`.
- `POST /analytics/scrape` triggers `collectMetrics`.
- `GET /analytics/hook-performance` and `POST /analytics/hook-performance/aggregate` proxy `HookPerformanceBank`.

## 4. Dependencies

- `infrastructure/prisma` — `PrismaService`, `Post`, `PostMetrics`.
- `infrastructure/sse` — `SseService`.
- `infrastructure/browser` — `IBrowserPort` (optional, for future X scraping).
- `modules/content-enhancements` — `HookPerformanceBank`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `METRICS_SCRAPER_ENABLED` | `false` | `onModuleInit` | Enable metrics scraper cron |
| `METRICS_SCRAPER_SCHEDULE` | `0 6 * * *` | `onModuleInit` | Cron schedule |
| `THREADS_ACCESS_TOKEN` | — | `getSources` | Threads Insights API token |
| `FACEBOOK_PAGE_TOKEN` | — | `getSources` | Facebook Graph API token |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `MetricsScraperService.onModuleInit` uses `process.env` for `METRICS_SCRAPER_ENABLED` and `METRICS_SCRAPER_SCHEDULE`**
- No documented reason to bypass `ConfigService` here. Should use `ConfigService` for validation and consistency.

**B2. `getTopPosts` orders by `postedAt: 'desc'`, not by engagement metrics**
- The JSDoc says "top performing posts (by engagement if available)". The implementation ignores `PostMetrics` and simply returns the most recent posts. This is misleading.

**B3. `AnalyticsService.getSummary` counts `pending` as `DRAFT + APPROVED + POSTING` but not `FAILED` or `REJECTED` separately**
- `pending` is a bucket of three statuses. The dashboard may be confusing. `REJECTED` posts are not counted anywhere. Should report `rejected` separately.

**B4. `getDailyStats` uses `createdAt` instead of `postedAt`**
- It groups by `post.createdAt` but `status` is `POSTED` or `FAILED`. For posted posts, the `postedAt` is the meaningful date. `createdAt` is generation time. This may cause a post generated today and posted tomorrow to appear today. This is a bug.

**B5. `MetricsScraperService.collectMetrics` uses `postedAt` for lookback, but `getDailyStats` uses `createdAt`. Inconsistent date semantics.**

**B6. `MetricsScraperService` does not implement X source**
- X is deferred. The comment says `X (Twitter): deferred per AN1 research §3`. The `IBrowserPort` is injected but never used. If no sources, it returns `skipped`. The `MetricsScraperService` has `if (!this.browser && Object.keys(this.getSources()).length === 0) return` — but `browser` is not used for X. This is future scaffolding. Fine.

**B7. `MetricsScraperService.collectMetrics` `getSources()` returns a cache built from `process.env` at first call**
- The tokens are read once and cached. If env changes at runtime, the source won't update. This is usually fine. But it also means `getSources` is not deterministic per test if env is set after module init. Fine.

**B8. `MetricsScraperService.collectMetrics` does not check `flowControl.isPaused` before running**
- If operator pauses metrics scraping, the cron still runs. Not a major issue but should be consistent.

**B9. `MetricsScraperService.collectMetrics` uses `this.browser?.randomDelay(5000, 15000)` between HTTP API calls**
- The delay is for HTTP API calls, not browser page loads. It slows down metrics collection unnecessarily. If `browser` is not used, `randomDelay` may be undefined and skip. But if `browser` is available, it adds 5-15s per post for HTTP calls. For 50 posts, 250-750s (4-12 min). This is a lot. The delay should be per-source or only for browser scraping.

**B10. `MetricsScraperService.collectMetrics` writes one `PostMetrics` row per post per run. It does not upsert. If run twice in same day, duplicate rows are created.**
- `getLatestMetricsForPost` uses `orderBy: { collectedAt: 'desc' }` and returns latest. History shows all. Duplicates are allowed. This is a design choice but may lead to duplicates if cron runs twice or manual trigger + cron overlap.

**B11. `MetricsScraperService.collectMetrics` does not prevent concurrent runs. If cron is long and manual trigger runs, two overlapping runs may occur.**
- No mutex or `job` running check. Could duplicate metrics. Not critical.

**B12. `ThreadsInsightsSource.resolveMediaId` only matches `/post/<shortcode>` URLs**
- Threads post URLs may have `www.threads.net/@handle/post/...` or `threads.com/...` (without `post/`). The regex requires `/post/`. If URL format differs, it returns null. This is a risk.

**B13. `ThreadsInsightsSource` uses `globalThis.fetch` as `FetchFn` default. The `FetchFn` type is a simplified `fetch` with `ok`, `status`, `json`. The actual `fetch` has more fields. The cast `as unknown as FetchFn` is okay but the type is narrow. It should probably accept `Response` from `fetch` and `json()` returns `unknown`. Fine. **B14. `ThreadsInsightsSource` constructs `metric` parameter by `Array.from(new Set(Object.values(THREADS_MAPPING))).join(',')` which gives `likes,replies,reposts,views`. It queries `metric=likes,replies,reposts,views`. Good. **B15. `ThreadsInsightsSource` does not URL-encode the metric list? It uses `metric=${metric}`. Since the list is comma-separated and no special chars, fine. **B16. `ThreadsInsightsSource` `res.ok` false returns `null`. It doesn't log. The caller logs via `MetricsScraperService` catch. Good. **B17. `FacebookInsightsSource.resolvePostId` only matches `/posts/{id}`, `/permalink/{id}`, `/photos/{id}`. Facebook URLs can also have `fb.watch/{id}` or `?story_fbid=...` or `?id=...`. The regex may fail. **B18. `FacebookInsightsSource` returns `impressions: null` explicitly. Good. **B19. `FacebookInsightsSource` does not handle `shares` being `undefined` if post has no shares. `parseFacebookPostCounts` returns `n(j?.shares?.count)` which is 0. Good. **B20. `graph-insights.ts` `extractMetric` `find` uses `d?.name === name`. If `name` is undefined, it won't match. Good. **B21. `graph-insights.ts` `extractMetric` takes `last` value from `values` array. If there are multiple values (e.g., daily time-series), it takes the last (most recent). Good. **B22. `graph-insights.ts` `parseGraphInsights` uses `?? 0` for missing metrics. Good. **B23. `MetricsScraperService` `scrapePostMetrics` returns `null` when no source. It doesn't check if `source` has errors. Good. **B24. `AnalyticsController` `triggerScrape` is not guarded. It can be called by any authenticated user. Should be admin-only? If `AUTH_ENABLED`, global guard applies. The `triggerScrape` can take a long time. It might be okay. But it triggers external API calls. Should be admin-only. **B25. `AnalyticsController` `getHookPerformance` and `triggerHookAggregation` are not guarded. They expose hook performance stats and can trigger aggregation. If `AUTH_ENABLED`, global guard applies. `triggerHookAggregation` is a write operation. Should be admin-only. **B26. `AnalyticsController` `getPostMetrics` and `getPostMetricsHistory` are not guarded. If `AUTH_ENABLED`, global guard applies. They expose per-post metrics. Fine. **B27. `AnalyticsController` `getTopPosts` limit parse `parseInt(limit, 10) || 10`. Good. **B28. `AnalyticsService.getSummary` uses `Promise.all` for 5 independent queries. Good. **B29. `AnalyticsService.getNetworkStats` uses `Promise.all` per network. Good. **B30. `AnalyticsService.getDailyStats` uses `findMany` and groups in JS. Good. **B31. `MetricsScraperService` `collectMetrics` uses `findMany` with `take: 50`. If there are more than 50 posts in 30 days, it takes the most recent 50. Good. **B32. `MetricsScraperService` `onModuleInit` `process.env` read. Should be `ConfigService`. **B33. `MetricsScraperService` has `private readonly daysLookback = 30` and `maxPostsPerRun = 50` hardcoded. Should be env-configurable. **B34. `AnalyticsService.getTopPosts` does not select `metrics` or order by them. It could join `PostMetrics` and order by `likes + comments + shares`. **B35. `AnalyticsService.getSummary` `successRate` is `posted / (posted + failed) * 100`. It ignores `REJECTED` and `PENDING`. Good. **B36. `AnalyticsService` `pending` is `DRAFT + APPROVED + POSTING`. It does not include `REJECTED`. Should it? Probably not. **B37. `AnalyticsService.getNetworkStats` returns `result[network]` for `SocialNetwork` enum values. Good. **B38. `MetricsScraperService` SSE `type: 'health_alert'` is a bit odd — analytics should have its own `metrics_update` event type. But it works. **B39. `MetricsScraperService` `collectMetrics` uses `post.postUrl!` non-null. The `findMany` ensures `postUrl not null`, but TypeScript doesn't narrow. Good. **B40. `MetricsScraperService` `getLatestMetricsForPost` returns `impressions: number | null`. The `PostMetrics` model may have `impressions` as optional `Int?`. Good. **B41. `MetricsScraperService` `getMetricsHistory` does not include `impressions` in select. It omits `impressions`. The return type does not include `impressions`. This is inconsistent with `getLatestMetricsForPost`. The history endpoint loses `impressions`. **B42. `MetricsScraperService` `collectMetrics` does not `await` the `PostMetrics.create` with a transaction. If the process crashes, some metrics are saved. Not a bug. **B43. `MetricsScraperService` `collectMetrics` `collected` count increments even if `postUrl` is null? No, `findMany` filters `postUrl: { not: null }`. Good. **B44. `MetricsScraperService` `collectMetrics` `daysLookback` uses `postedAt` with `setDate`. If the server timezone changes, lookback window may vary. Should be UTC. **B45. `AnalyticsService.getDailyStats` uses `new Date()` and `setDate` for local dates. It groups by `post.createdAt.toISOString().split('T')[0]`. This is UTC. But the `startDate` is local midnight. If a post's `createdAt` is local date but `toISOString()` is UTC, the grouping may differ by timezone. The `startDate` should be UTC. **B46. `MetricsScraperService` `getSources` caches sources. If `THREADS_ACCESS_TOKEN` or `FACEBOOK_PAGE_TOKEN` is not set, no source. If a token is invalid, the source still tries and fails. Good. **B47. `AnalyticsController` `triggerHookAggregation` returns `await this.hookBank.aggregateStats()` then `{ success: true }`. It does not return the result. Good. **B48. `AnalyticsService` `getSummary` `last7Days` is based on `createdAt` and uses local date for `startDate` and `d` but `toISOString()` for grouping. This can cause timezone mismatches. **B49. `MetricsScraperService` `collectMetrics` `postUrl` is `string` in `findMany` select? It returns `postUrl: true` and Prisma `postUrl` is `String?` so it can be null. It then `post.postUrl!`. Good. **B50. `MetricsScraperService` `onModuleInit` does not check `process.env.METRICS_SCRAPER_ENABLED` for `parseBool`. It checks `!== 'true'`. If value is `True` or `1`, it disables. Should use `parseBool`. **B51. `MetricsScraperService` `onModuleInit` does not skip `SPA_DRY_RUN` like `TrendingScraperService` does. In dry-run, the metrics scraper cron may still register if `METRICS_SCRAPER_ENABLED=true`. It won't make real posts, but it will make API calls. Should respect `SPA_DRY_RUN`. **B52. `MetricsScraperService` `collectMetrics` no `flowControl` pause. **B53. `MetricsScraperService` `getSources` reads `process.env` directly. Should be `ConfigService` or injected. **B54. `AnalyticsController` `triggerScrape` uses `this.metricsScraper.collectMetrics()` and returns summary. It does not guard. Should be admin-only. **B55. `MetricsScraperService` `collectMetrics` delay: `if (this.browser?.randomDelay)`. This `randomDelay` is from `IBrowserPort`. But for HTTP sources, the delay is not needed. It may add `undefined` if browser not available, so no delay. If browser available, it adds 5-15s per post. This is wasteful. It should be per-source or only if source uses browser. **B56. `MetricsScraperService` `collectMetrics` does not publish `metrics` SSE separate from `health_alert`. Fine. **B57. `MetricsScraperService` `collectMetrics` `collected` count is for posts, but `PostMetrics` is created per post. Good. **B58. `MetricsScraperService` `collectMetrics` `failed` count increments on any error. If one source fails, it continues. Good. **B59. `MetricsScraperService` `scrapePostMetrics` `post` parameter `postUrl` is `string`. It doesn't accept `postUrl: string | null`. The `post` is constructed with `postUrl: post.postUrl!`. Good. **B60. `MetricsScraperService` `collectMetrics` logs `F6: Metrics collected — ...` as `health_alert` with `severity: 'info'`. This is an SSE notification. Good. **B61. `AnalyticsController` `getHookPerformance` uses `this.hookBank?.getStats()`. If `hookBank` is not provided, it returns error. But `AnalyticsModule` imports `ContentEnhancementsModule` which exports `HookPerformanceBank`. So `hookBank` should be available. Good. **B62. `AnalyticsModule` imports `ContentEnhancementsModule` to get `HookPerformanceBank`. This is a cross-module dependency. Good. **B63. `AnalyticsModule` imports `BrowserModule` but `MetricsScraperService` doesn't use `browser` except for `randomDelay`. It may not need `BrowserModule` until X is implemented. Fine. **B64. `AnalyticsService` `getSummary` `successRate` is `Math.round(successRate * 100) / 100`. This rounds to 2 decimals. Good. **B65. `AnalyticsService` `getNetworkStats` returns `Record<string, ...>` with `SocialNetwork` keys. Good. **B66. `AnalyticsService` `getDailyStats` loops `for (let i = days - 1; i >= 0; i--)` and uses `new Date()` each iteration, then `d.setDate(d.getDate() - i)`. This creates a new Date for each iteration and mutates it. It works but is slightly inefficient. The date could be `new Date(startDate)` and add days. Not a bug. **B67. `AnalyticsService` `getDailyStats` uses `toISOString().split('T')[0]` for both grouping and result. Good. **B68. `AnalyticsService` `getTopPosts` returns `postedAt: Date | null` and `postUrl: string | null`. Good. **B69. `ThreadsInsightsSource` `fetchMetrics` `mediaId` shortcode is not validated to be base64-ish. It just extracts. If URL has query params, the regex may fail. Good. **B70. `FacebookInsightsSource` `fetchMetrics` uses `v21.0` hardcoded. If API version changes, it may break. Should be configurable. **B71. `FacebookInsightsSource` `fetchMetrics` `resolvePostId` returns the first numeric id. If URL has `?story_fbid=123&id=456` or `fb.watch/abc`, it fails. This is a risk. **B72. `graph-insights.ts` `parseGraphInsights` `impressions` is `null` if `mapping.impressions` undefined. Good. **B73. `graph-insights.ts` `extractMetric` uses `d?.name === name`. If `name` is not found, returns `null`. `parseGraphInsights` `?? 0` for missing. Good. **B74. `MetricsScraperService` `collectMetrics` `daysLookback` hardcoded. **B75. `MetricsScraperService` `collectMetrics` `maxPostsPerRun` hardcoded. **

### 6.2 Performance

**P1. `MetricsScraperService.collectMetrics` can take 4-12 minutes due to 5-15s delay per post (50 posts).**
- For HTTP sources, no delay is needed; for browser-based X, delay is needed. The current code always delays if `browser` exists, which is wrong.

**P2. `AnalyticsService.getSummary` does 5 independent queries. Good.**

**P3. `AnalyticsService.getNetworkStats` does 3 queries per network (9 total). Could be one grouped query with `groupBy`. Good enough.**

**P4. `AnalyticsService.getTopPosts` does a simple `findMany` ordered by `postedAt`. Good.**

**P5. `MetricsScraperService.collectMetrics` creates one `PostMetrics` per post sequentially. Fine. No upsert.**

### 6.3 Architecture / anti-patterns

**A1. `AnalyticsService` is read-only and Prisma-backed. Good.**

**A2. `MetricsScraperService` delegates per-network fetching to `IMetricsSource` implementations. Good separation.**

**A3. `MetricsScraperService` uses `process.env` for token envs. Should be `ConfigService` or injected tokens.**

**A4. `MetricsScraperService` injects `IBrowserPort` but doesn't use it for X yet. The `browser` is only used for `randomDelay`. Could be removed until X is implemented.**

**A5. `AnalyticsModule` imports `ContentEnhancementsModule` to get `HookPerformanceBank`. This couples analytics to content-enhancements. Could be a separate `HookPerformanceModule` or use `ModuleRef` to avoid dependency. But `ContentEnhancementsModule` is not heavy. Fine.**

**A6. `AnalyticsController` proxies `HookPerformanceBank` endpoints. Good for dashboard.**

### 6.4 TypeScript / type safety

**T1. `AnalyticsService` uses `PrismaService` directly. Good.**

**T2. `MetricsScraperService` `getSources` returns `Partial<Record<SocialNetwork, IMetricsSource>>`. Good.**

**T3. `FetchFn` type is custom and narrower than `fetch`. The default `globalThis.fetch as unknown as FetchFn` compiles but may not catch mismatches. Good enough.**

**T4. `PostMetricsData` uses `impressions?: number | null`. Good.**

**T5. `AnalyticsController` `getTopPosts` `limit?: string` parse. Good.**

**T6. `MetricsScraperService.collectMetrics` return type `Promise<{ collected: number; failed: number; skipped: number }>`. Good.**

### 6.5 Security / reliability

**S1. `AnalyticsController` `triggerScrape` is not admin-only. Could be any authenticated user. Should be admin-only.**

**S2. `MetricsScraperService` tokens are in env. Good. They are not logged.**

**S3. `MetricsScraperService` `getSources` uses `globalThis.fetch` default. It may be monkey-patched in tests. Good for testability.**

**S4. `MetricsScraperService` does not have rate limiting or circuit breaker for external APIs. If many posts, it may hit rate limits. The `withTimeout` is 8s. The `MetricsScraperService` delay slows it. Should use `rate-limit` or `exponential backoff` on API errors.**

**S5. `MetricsScraperService` `collectMetrics` does not skip posts that already have a recent metric. It collects every 30 days. Fine. But it may create duplicate rows on same day. Should upsert or use unique `postId + collectedAt`?** 

**S6. `MetricsScraperService` `collectMetrics` does not prevent concurrent runs. Could overlap.**

**S7. `MetricsScraperService` `onModuleInit` `METRICS_SCRAPER_ENABLED !== 'true'` uses strict string. Should use `parseBool`.**

**S8. `MetricsScraperService` `collectMetrics` does not handle `postUrl` that is not a valid URL. `resolveMediaId` and `resolvePostId` may return null. Good. **S9. `MetricsScraperService` `collectMetrics` does not check `post.status` before scraping. It queries `POSTED`. Good. **S10. `MetricsScraperService` `collectMetrics` `daysLookback` is 30 days. If a post is 31 days old, it stops collecting. Good. **S11. `MetricsScraperService` `collectMetrics` does not use `flowControl`. **S12. `AnalyticsService` `getTopPosts` is not gated by auth. If `AUTH_ENABLED`, global guard applies. **S13. `AnalyticsController` `triggerHookAggregation` should be admin-only. **S14. `MetricsScraperService` `collectMetrics` `sseService.publish` uses `error` field for info message. The SSE schema may expect `error` for error. It works but is semantically odd. **S15. `MetricsScraperService` `getSources` caches `sourcesCache` on first access. If token is missing, source is not created and post is skipped. Good. **S16. `MetricsScraperService` `getSources` does not cache a `null` source? It only creates when token exists. If token is missing, no source. Good. **S17. `MetricsScraperService` `collectMetrics` `postUrl` is `post.postUrl!` but `postUrl` can be `null` if Prisma returns. The `findMany` filters `not: null`, but TypeScript doesn't narrow. Good. **S18. `MetricsScraperService` `getLatestMetricsForPost` `latest.impressions` may be `null` or `undefined`? The `PostMetrics` model `impressions` is `Int?` so `null` is allowed. The return type `number | null` is good. **S19. `MetricsScraperService` `getMetricsHistory` select does not include `impressions`. Should include for consistency. **S20. `MetricsScraperService` `collectMetrics` does not upsert. If run twice, duplicate rows. **S21. `MetricsScraperService` `collectMetrics` does not have a `runId` or `batchId`. It uses `collectedAt` time. Good. **S22. `ThreadsInsightsSource` `fetchMetrics` URL has `access_token` in query. The token may be logged in server logs if URLs are logged. `RedactInterceptor` strips keys by exact match; `access_token` is not in the redact list? It might be. Need to check. Not a bug. **S23. `FacebookInsightsSource` similar token in URL. **S24. `MetricsScraperService` `onModuleInit` `process.env` read. **S25. `MetricsScraperService` `getSources` `process.env` read. **

## 7. New feature / improvement ideas

**F1. Use `ConfigService` for `METRICS_SCRAPER_ENABLED`, `METRICS_SCRAPER_SCHEDULE`, `THREADS_ACCESS_TOKEN`, `FACEBOOK_PAGE_TOKEN`.**

**F2. Order `getTopPosts` by engagement metrics or add a `sort` query param.**

**F3. Use `postedAt` instead of `createdAt` in `getDailyStats`.**

**F4. Add `REJECTED` count to `getSummary`.**

**F5. Make `daysLookback` and `maxPostsPerRun` configurable via env.**

**F6. Add upsert for `PostMetrics` to avoid duplicates per day.**

**F7. Remove or condition the 5-15s delay for HTTP sources; only use for browser scraping.**

**F8. Add concurrency control / mutex to prevent overlapping `collectMetrics` runs.**

**F9. Add `flowControl.isPaused` check before metrics scraping.**

**F10. Add `SPA_DRY_RUN` guard in `onModuleInit` to skip cron in dry-run mode.**

**F11. Use `parseBool` for `METRICS_SCRAPER_ENABLED`.**

**F12. Add `impressions` to `getMetricsHistory` select.**

**F13. Add `X` metrics source via browser scraping or paid API (deferred).**

**F14. Add `admin` guard to `triggerScrape` and `triggerHookAggregation`.**

**F15. Add rate limiting and retry/backoff for HTTP API calls.**

**F16. Add `metrics_update` SSE event type separate from `health_alert`.**

## 8. Cross-references

- `infrastructure/prisma` — `Post`, `PostMetrics`.
- `infrastructure/sse` — `SseService`.
- `infrastructure/browser` — `IBrowserPort` (future X).
- `modules/content-enhancements` — `HookPerformanceBank`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.
- `modules/recycling` — `findRecyclablePosts` uses `PostMetrics` (planned) for performance selection.
- `modules/posts` — `Post` status, `postUrl`.
- `infrastructure/util/with-timeout` — `withTimeout`.

## 9. Overall assessment

- **Health**: 6/10. The analytics module is clean and read-only, with a good port/adapter separation for metrics sources. However, it has several correctness and operational issues: `getTopPosts` does not use engagement metrics, `getDailyStats` uses `createdAt` instead of `postedAt`, `process.env` reads, hardcoded scraper limits, no `parseBool` on `METRICS_SCRAPER_ENABLED`, no concurrent-run protection, and a wasteful 5-15s delay per HTTP call.
- **Biggest strengths**: separate `IMetricsSource` per network, defensive parsing, `PostMetrics` time-series, no zero-rows when source unavailable, `MetricsScraperService` can be triggered manually.
- **Biggest risks**: `getTopPosts` is recency-based, not performance-based; `getDailyStats` date semantics wrong; `MetricsScraperService` can take 12+ minutes; duplicate metrics on overlap; `METRICS_SCRAPER_ENABLED` strict string check; `process.env` usage.
- **Recommended next actions**:
  1. Move `MetricsScraperService` env reads to `ConfigService`/`parseBool`.
  2. Use `postedAt` in `getDailyStats` and add `REJECTED` to `getSummary`.
  3. Order `getTopPosts` by engagement or add a sort param.
  4. Remove or conditionalize the 5-15s delay for HTTP API sources.
  5. Add concurrency protection (mutex) to `collectMetrics`.
  6. Add `SPA_DRY_RUN` and `flowControl` pause checks.
  7. Add `impressions` to metrics history endpoint.
