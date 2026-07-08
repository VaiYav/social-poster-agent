# Module: `modules/trending`

## 1. What this module does

`modules/trending` detects trending topics for content generation. It has two layers:
- `TrendingService` — static astrological events calendar (2026–2027) with ±30-day trending windows.
- `TrendingScraperService` — real-time scraping from Google Trends RSS and X (Twitter) Explore, with a keyword + LLM niche-relevance filter, merging with astro events.

**Main responsibilities:**
- `TrendingService` — calendar-based trending topics.
- `TrendingScraperService` — Google Trends RSS, X browser scraping, niche filtering, cache management.
- `TrendingController` — REST endpoints for active/next/merged trends and cache status.
- `google-trends-rss.ts` — pure-function RSS parser.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `trending.module.ts` | NestJS module | `TrendingModule` — imports Browser, LLM, Sessions |
| `trending.service.ts` | Astro calendar | `getTrendingTopics()`, `getActiveTrending()`, `getNextUpcoming()` |
| `trending-scraper.service.ts` | Scraper | `onModuleInit()`, `getGoogleTrends()`, `getXTrends()`, `getMergedTrending()`, `getCacheStatus()`, `invalidateCache()` |
| `trending.controller.ts` | REST API | `GET /trending`, `/trending/active`, `/trending/next`, `/trending/google`, `/trending/x`, `/trending/merged`, `/trending/cache-status` |
| `google-trends-rss.ts` | Parser | `parseGoogleTrendsRss(xml, limit)` |

## 3. How it works

### 3.1 `TrendingService`

- Hardcoded `ASTRO_EVENTS_2026` array with 9 events (solar/lunar eclipses, Mercury retrogrades, planetary ingresses).
- `getTrendingTopics()` maps each event to `daysUntil` and `trending` if `|daysUntil| <= windowDays` (default 30).
- Filters out fully past events (`daysUntil < -windowDays`).
- `getActiveTrending()` returns only `trending: true`.
- `getNextUpcoming()` returns nearest future event.

### 3.2 `TrendingScraperService`

- **Google Trends**:
  - Fetches `https://trends.google.com/trending/rss?geo=US` with `fetch` and 10s timeout.
  - Parses with `google-trends-rss.ts` regex parser.
  - Caches for `TRENDING_CACHE_TTL_MS` (default 15 min).
- **X Trends**:
  - Acquires browser context with X session storage state.
  - Tries `/explore/tabs/trending`, `/explore`, `/home`.
  - Waits 5s for React hydration.
  - Tries multiple CSS selectors; extracts trend text via `page.evaluate`.
  - Caches for `TRENDING_CACHE_TTL_MS`.
- **Niche filtering**:
  - `isRelevantByKeyword` — 120-keyword whitelist covering astrology, wellness, women's cycles, love, business, mental health, spirituality.
  - `isRelevantByLlm` — for borderline topics, asks `YES/NO` with 6h cache; fail-closed.
- **Merged**:
  - Astro topics always pass, priority 3.
  - Google/X topics pass filter, priority 2; cross-source adds +2.
  - Returns `MergedTrendingTopic[]` sorted by priority.

### 3.3 `TrendingController`

- `GET /trending` / `active` / `next` → `TrendingService`.
- `GET /trending/google` / `x` / `merged` / `cache-status` → `TrendingScraperService`.
- `GET /trending/x` and `merged` are protected by `LocalhostGuard` because X scraping is expensive.

## 4. Dependencies

- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/llm` — `LlmService`.
- `modules/sessions` — `SessionsService`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.
- `infrastructure/config` — `parseBool`.
- `infrastructure/guards` — `LocalhostGuard`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `TRENDING_CACHE_TTL_MS` | `900000` | constructor | Cache TTL for Google/X trends |
| `TRENDING_SCRAPING_ENABLED` | `true` | constructor | Enable scraper |
| `X_TRENDS_SCRAPING_ENABLED` | `true` | constructor | Enable X scraping |
| `TRENDING_LLM_FILTER_ENABLED` | `true` | constructor | Enable LLM niche filter |
| `TRENDING_SCRAPER_SCHEDULE` | `0 */2 * * *` | `onModuleInit` | Cron to refresh cache |
| `SPA_DRY_RUN` | `false` | `onModuleInit` | Skip cron registration |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `TrendingService` uses a hardcoded 2026–2027 calendar**
- `trending.service.ts:32` `ASTRO_EVENTS_2026` is a static array. After 2027, there are no events. This is by design? The comment says "In production, this would be fetched from CAP astro MCP or Swiss Ephemeris". It is not. This is a maintainability bug. Need dynamic ephemeris or at least a longer calendar.

**B2. `TrendingService` `DEFAULT_WINDOW_DAYS = 30` means events are flagged trending 30 days before and after**
- This means the system will think "Mercury Retrograde (Mar 2027)" is trending for 60 days. This is fine for astrology but may dilute urgency. The `orchestrator` may use `getNextUpcoming` to avoid.

**B3. `TrendingService` `getTrendingTopics` computes `daysUntil` with `Math.round` of `diffMs / 86400000` using local time**
- `new Date(event.date)` is parsed as UTC? The `event.date` is `2026-08-12` (no time). `new Date('2026-08-12')` is UTC midnight. `new Date()` is local. This can cause off-by-one day differences depending on timezone. Should use UTC.

**B4. `TrendingScraperService` `getXTrends` uses `sessionsService.getOrCreateSession('X' as SocialNetwork)` without `{ deferFormLogin: true }`**
- Same as `RepliesMonitorService` — may trigger inline login. It should pass `deferFormLogin: true`.

**B5. `TrendingScraperService` `getXTrends` calls `page.waitForTimeout(5000)` after `goto` and 5s selector waits for each `X_TREND_SELECTORS`**
- Static waits. The `5s` hydration wait is repeated for each URL. If X_TREND_URLS has 3 URLs, worst case 15s. Could be optimized. But `getXTrends` is cached for 15 min.

**B6. `TrendingScraperService` `extractXTrends` uses `page.waitForSelector` for each selector with 5s timeout, then `page.evaluate` with all selectors**
- `page.evaluate` iterates selectors and `document.querySelectorAll`. If a selector matches something else (e.g., sidebar link), it may extract wrong text. The `X_TREND_SELECTORS` includes `div[role="link"] span:has-text("Trending")` which is a Playwright-specific `:has-text` pseudo-class. `document.querySelectorAll` does not support `:has-text`. This selector will fail in `page.evaluate` because the browser's native `querySelectorAll` does not support Playwright's `:has-text`. The selector may be included in the array but won't work in `evaluate`. It may work in `page.waitForSelector` because Playwright supports it. The extraction `document.querySelectorAll` will not match. This is a bug. **B7.**

**B7. `TrendingScraperService` `extractXTrends` `rank` is `idx + 1` from the `elements` array. If deduplication happens, the rank may be inconsistent. The `rank` is not used in merged. Fine. But the rank is the array index, not actual X rank. It may be the first occurrence. Fine.**

**B8. `TrendingScraperService` `getXTrends` uses `page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })` then `page.waitForTimeout(5000)`. It does not wait for `networkidle` or selector for the first page. It navigates, waits 5s, then tries selectors. If the page loads slowly, selectors may fail. The retry URLs are good.**

**B9. `TrendingScraperService` `getXTrends` does not suppress page errors? It does `this.browser.suppressPageErrors(page)`. Good. It also blocks images. Good. It uses `acquireContext` and `releaseContext`. Good. It closes `page`. Good. This is a well-structured browser scrape.**

**B10. `TrendingScraperService` `getMergedTrending` `getXTrends` is protected by `LocalhostGuard` in controller, but `getMergedTrending` is called by `TrendingController` only. It is not called by the orchestrator or generation. The `getMergedTrending` is manually triggered. If the orchestrator wants merged trends, it would call `getMergedTrending`? Not sure. The orchestrator may use `getGoogleTrends` and `getXTrends` separately. The `TrendingService` is used by `topic-generation.service.ts` in `content-source`. It is likely the source of trending topics for generation.**

**B11. `TrendingScraperService` `isRelevantByLlm` uses a small inline system/user prompt**
- Should be in `PromptRegistry` / Langfuse for consistency. Not a bug, but a maintainability issue.

**B12. `TrendingScraperService` `isRelevantByLlm` uses `response.content.trim().toUpperCase()` and `answer.startsWith('YES')`. If the LLM returns "YES!" or "YES\n" it works. If it returns "Yes, because..." it also works. If it returns "Yes, if..." it works. If it returns "Yes." it works. Good. But if it returns "Yeah" it fails. Fine. But the system prompt says "Respond with ONLY 'YES' or 'NO'". Good. It uses `temperature: 0`. Good.**

**B13. `TrendingScraperService` `filterByNicheRelevance` limits LLM concurrency to 3. Good. But if `borderline` is large, it still may be slow. For 20 topics, 7 batches of 3. Fine. But each LLM call can take 5-10s, so 70s. `getMergedTrending` may be slow. It is cached but first call is slow. Fine.**

**B14. `TrendingScraperService` `getGoogleTrends` uses `fetch` with `AbortSignal.timeout(10_000)`. If `fetch` fails (e.g., network error), it catches and returns `this.googleTrendsCache?.topics ?? []`. Good. But if the cache is stale and fetch fails, it returns stale data. Good for graceful degradation. But if the cache is empty, it returns []. Good.**

**B15. `TrendingScraperService` `getXTrends` uses `this.sessionsService.decryptStorageState(session)` where `session` is from `getOrCreateSession`. If `session.storageState` is encrypted, `session` has the `storageStateIv` and `storageStateTag`? Wait, `getOrCreateSession` returns a `Session` object with all fields. `decryptStorageState` uses `session.storageState` etc. Good. But if `session` is not returned because `getOrCreateSession` failed, it logs and continues with no storage state. Then `acquireContext` with no storage state may require login. But X may not require login for trends. Fine. The `SessionsService` injection is optional. Good.**

**B16. `TrendingScraperService` `getXTrends` uses `this.browser.acquireContext('X' as SocialNetwork, storageState)`. The `SocialNetwork` is `X` typed as string. Good. But `getOrCreateSession('X' as SocialNetwork)` is called. If `X` is not an enum, the `getOrCreateSession` may accept. Fine.**

**B17. `google-trends-rss.ts` `parseGoogleTrendsRss` uses regex on XML. This is a good, dependency-free approach. It handles CDATA, multiline titles, and HTML entities. It resets `ITEM_RE.lastIndex = 0` because the regex is global. Good. But `TITLE_RE` and `TRAFFIC_RE` and `LINK_RE` are not global. `TITLE_RE.exec(itemXml)` is fine. `TITLE_RE` is a module-level regex with `i` flag, not global. It is used once per item. Good. But `TITLE_RE` has a capturing group with `CDATA` and plain. It uses `match[1] ?? match[2]`. Good. The `decodeEntities` decodes `&lt;`, `&gt;`, `&quot;`, `&#0*39;`, `&apos;`, `&amp;`. It uses `replace` with `g` flag. Good. The `&amp;` decoded last to avoid double decoding. Good. But the `decodeEntities` does not decode numeric entities like `&#x27;` or `&#39;` without leading zeros? It handles `&#0*39;` (with optional leading zeros). Good. It does not handle `&#39;` if there are leading zeros? It does. It does not handle `&#x27;` (hex). Not needed. Good. This is a robust parser.**

**B18. `TrendingController` `GET /trending/x` and `GET /trending/merged` use `LocalhostGuard` to prevent external scraping. This is a security measure. Good. But `GET /trending/google` is not guarded. It is public. Google Trends RSS is public and cheap. Good. But `getGoogleTrends` may be called frequently. It is cached for 15 min. Good. The `LocalhostGuard` may block in Docker. The `LocalhostGuard` checks `req.ip`/`connection.remoteAddress`. In Docker, the IP may not be 127.0.0.1. This could be a problem. The `LocalhostGuard` may be too restrictive. Not a bug in trending. But `x` and `merged` endpoints may not be accessible from UI if not localhost. The UI runs on `:3101` and API on `:3100`, so from UI the request is from the browser IP, not localhost. The `LocalhostGuard` blocks the UI from calling `GET /trending/x` and `GET /trending/merged`. This may be intentional to prevent UI from triggering expensive scraping. But then the UI cannot use these endpoints. Unless the UI calls from a backend? Hmm. The `LocalhostGuard` is for localhost-only. This is a design issue. Maybe the UI doesn't use these endpoints. Not a bug. **B19.**

**B19. `TrendingController` `GET /trending/merged` calls `getActiveTrending()` which returns `TrendingTopic[]` and maps to `{ topic, networks }`. Then `scraperService.getMergedTrending(astroTopics)`. `getMergedTrending` calls `getGoogleTrends` and `getXTrends`. `getXTrends` is cached and may be empty if not logged in. Good. The `merged` endpoint is guarded by `LocalhostGuard`. Fine. The `getMergedTrending` may be called from the orchestrator. Not sure. If it is, it is not guarded. The orchestrator calls service directly. Good.**

**B20. `TrendingScraperService` `getXTrends` uses `X_TREND_SELECTORS` in `page.waitForSelector` and `page.evaluate`. The `waitForSelector` timeout is 5s each. If none match, it logs. Then `page.evaluate` tries all selectors. But `evaluate` is not Playwright-specific; it uses browser `document.querySelectorAll`. The `:has-text` selector will not work in `evaluate`. This is the B6 bug. It also uses `div[role="link"] span:has-text("Trending")` which is invalid in browser. The `X_TREND_SELECTORS` array is also used in `waitForSelector` (Playwright). Playwright supports `:has-text`? It might not; Playwright uses `css` or `text` engine separately. `page.waitForSelector('div[role="link"] span:has-text("Trending")')` may not work because `:has-text` is not a standard CSS selector. Playwright supports `:has-text` in `locator`? Actually Playwright supports `:has-text` as a CSS extension for `page.locator` and `page.waitForSelector`? It might. But `page.evaluate` with `document.querySelectorAll` definitely does not. So the `evaluate` will fail for that selector. The other selectors are standard CSS. Good. **B21.**

**B21. `TrendingScraperService` `extractXTrends` `page.evaluate` uses `document.querySelectorAll('[data-testid="trend"]'). It may match `trend` elements in `aside` or `section`. The `trend` text extraction may get the first `span` child. The X DOM for a trend card includes `span` with `Trending` label, `span` with rank, `span` with topic, `span` with post count. `el.querySelector('span')` will get the first `span`, which is likely "Trending" or "1". Then `el.textContent?.trim()?.split('\n')[0]` will get the first line. It may be "Trending" or "Topic". The extraction is fragile. It may return "Trending" for many. The `length > 0` and `< 200` check will allow "Trending" as a topic. This is a bug. The `trendName` extraction should be more specific. **B22.**

**B22. `TrendingScraperService` `extractXTrends` `el.querySelector('span')` gets the first `span` inside the trend container. If the container has `Trending` label, it returns "Trending". It should skip the label and extract the actual topic name. The `data-testid="trendName"` selector is used but may not exist. If it does, it returns the topic. But the fallback `el.querySelector('span')` is too broad. This is a bug. **B23.**

**B23. `TrendingScraperService` `getMergedTrending` assigns `networks` for Google/X topics. For Google, `['X', 'THREADS', 'FACEBOOK']`. For X, `['X', 'THREADS']`. For astro, uses `networks` from `TrendingService`. Good. But if an astro topic and a Google topic merge, the existing `networks` (from astro) are kept and not extended. Good. The `priority` adds +2. Good.**

**B24. `TrendingScraperService` `getMergedTrending` does not deduplicate topic names that differ only in case/whitespace. It uses `topic.toLowerCase().trim()` as key. Good. It lowercases. Good. But if a topic has punctuation or extra spaces, it may not match. Fine. **B25.**

**B25. `TrendingScraperService` `isRelevantByKeyword` uses `NICHE_KEYWORDS` with `topic.toLowerCase().includes(kw)`. The `kw` includes multi-word phrases like `'full moon'`. `includes('full moon')` will match if topic contains "full moon". Good. But `kw` `'sun sign'` will match "sunshine" because `includes('sun sign')` false. Wait, `topic.includes('sun sign')` in "sunshine" is false. Good. But `kw` `'moon'` will match "moonlight" and "mooncake". It is a substring match. The comment says substring. Fine. But it may over-match. For example, "money" contains `"money mindset"`? No. `"money"` does not include `"money mindset"`. But `"money mindset"` is a keyword and topic "money" won't match. Topic "money mindset" matches. Good. Keyword `"business"` matches "busy"? No. Matches "business"? Yes. `includes('business')` in "business" true. Good. But `"men"` matches "menstrual"? The keyword `menstrual` is used, `topic.includes('menstrual')`. Topic "men" won't match. Good. But keyword `"period"` matches "periodic"? Yes, `includes('period')` is true in "periodic". This is a false positive. Word boundaries would be better. But substring is intentional for broad matching. Acceptable.**

**B26. `TrendingScraperService` `setRelevanceCache` uses FIFO eviction (`keys().next().value`). `Map.keys()` returns iterator in insertion order. Removing oldest. Good. But `get` does not refresh position. The `llmRelevanceCache` is a Map, so `keys()` in insertion order. Eviction oldest. Good. But an expired entry is removed before `setRelevanceCache` in `isRelevantByLlm`, so size may not include expired. Good. **B27.**

**B27. `TrendingScraperService` `getCacheStatus` returns `expiresAt` as `Date`. Good. `xTrends` may be cached with empty array. `topics` count is 0. `cached` is true. Good. **B28.**

**B28. `TrendingScraperService` `onModuleInit` does initial cache warm-up in `void this.refreshCache()` in orchestrator mode. In non-orchestrator mode, it registers cron and then `void this.refreshCache()`. Good. But `refreshCache` is `private` and `async`. It uses `Promise.allSettled`. Good. It logs. Good. **B29.**

**B29. `TrendingScraperService` `onModuleInit` does not check `ORCHESTRATOR_ENABLED` for initial warm-up? It does. It skips cron and does warm-up. Good. But `getMergedTrending` is not called by cron. Only `refreshCache` calls `getGoogleTrends` and `getXTrends`. `getMergedTrending` is on-demand. So the cron caches Google and X separately. The merged is not cached. Good. **B30.**

**B30. `TrendingService` is not used by `TrendingScraperService` directly. The controller composes them. The `orchestrator` may use `TrendingService` directly. Good. **B31.**

### 6.2 Performance

**P1. `getXTrends` navigates up to 3 URLs, each with 5s wait + 5s selector wait × 8 selectors = up to 40s. Cached for 15 min. Fine. But first call can take 30s.**

**P2. `filterByNicheRelevance` can make up to 7 LLM calls per batch of 3. For 20 borderline topics, 7 batches × 1-3 calls = up to 21 LLM calls. Each can take 5s. 105s. The merged endpoint may timeout. But `getMergedTrending` is cached? No, `getMergedTrending` is not cached. It calls `getGoogleTrends` and `getXTrends` (cached) and then `filterByNicheRelevance` (not cached). The `getMergedTrending` is called every time. The LLM filter is called every time. This is expensive. It should be cached or pre-computed in `refreshCache`. **P3.**

**P3. `getGoogleTrends` fetches 20 items and parses. Cheap. Good. But `getMergedTrending` calls `getGoogleTrends` and `getXTrends` and then filters. This should be cached. **P4.**

**P4. `getTrendingTopics` is a simple array map/filter. Fast. Good. **P5.**

**P5. `getMergedTrending` does 2 niche filters sequentially. It could use `Promise.all`. It does: `Promise.all([filterByNicheRelevance(rawGoogle), filterByNicheRelevance(rawX)])`. Good. **P6.**

### 6.3 Architecture / anti-patterns

**A1. `TrendingService` has hardcoded astrological events. Should be data-driven.**

**A2. `TrendingScraperService` mixes scraping, filtering, caching, merging. It's large but well-organized.**

**A3. `TrendingScraperService` `isRelevantByLlm` prompt is inline. Should be in Langfuse.**

**A4. `TrendingController` `GET /trending/merged` is `LocalhostGuard` protected but may be needed by UI/orchestrator. The guard may be too restrictive.**

**A5. `TrendingScraperService` `getXTrends` uses `page.evaluate` with `X_TREND_SELECTORS` that includes Playwright-specific `:has-text` pseudo-class. This is a mismatch between Playwright and browser contexts.**

### 6.4 TypeScript / type safety

**T1. `TrendingService` `AstroEvent.networks` is `('X' | 'THREADS' | 'FACEBOOK')[]` not `SocialNetwork[]`. Good but may diverge from enum.**

**T2. `TrendingScraperService` `getXTrends` casts `'X' as SocialNetwork` multiple times. Should use enum.**

**T3. `TrendingScraperService` `getXTrends` `page` type is `Awaited<ReturnType<BrowserContext['newPage']>> | undefined`. It is `Page`. Good. But the type is verbose. Could be `Page | undefined`.** 

**T4. `TrendingController` `getMerged` `astroActive` is `TrendingTopic[]` and maps to `{ topic, networks }`. The `networks` is `string[]` but `MergedTrendingTopic.networks` is `string[]`. Good. But `astroTopics` loses `event` and `daysUntil`. Fine.** 

### 6.5 Security / reliability

**S1. `GET /trending/x` and `GET /trending/merged` are `LocalhostGuard` only. This prevents external users from triggering expensive scraping. Good. But the UI may be blocked. The UI likely doesn't call them. **S2. `LocalhostGuard` may be bypassed in containers or reverse proxies. Should check `X-Forwarded-For`? Not in scope. **S3. `getGoogleTrends` uses `fetch` to external URL. Good. No secrets. **S4. `getXTrends` requires authentication session. It uses `getOrCreateSession`. If session is `EXPIRED` or `BANNED`, it returns null. Then `storageState` undefined. It may still scrape. X may show login wall. The scrape returns empty. Good. **S5. `getXTrends` does not save the session storage state after scrape. It acquires context, navigates, and releases. It doesn't save updated state. Fine for read-only. **S6. `getXTrends` `page.close()` is in `finally`. Good. **S7. `getXTrends` catches and returns cached/stale data. Good. **S8. `getMergedTrending` could be called without guard if `TrendingService`/`TrendingScraperService` are exported. The controller guard is the only protection. If a cron or orchestrator calls `getMergedTrending`, it is not rate-limited or guarded. But it is internal. Good. **S9. `getGoogleTrends` `AbortSignal.timeout` is Node 18+ global. Good. **S10. `parseGoogleTrendsRss` is pure and tested. Good. **

## 7. New feature / improvement ideas

**F1. Replace hardcoded astro calendar with dynamic ephemeris data (Swiss Ephemeris or CAP MCP)**
- Remove static events and compute retrogrades, eclipses, ingresses.

**F2. Cache `getMergedTrending` results for 15 minutes**
- The LLM filter is expensive. Compute merged result in `refreshCache` and cache it.

**F3. Fix `extractXTrends` trend text extraction**
- Use more specific selectors for trend name and post count; avoid generic `span` fallback.

**F4. Remove Playwright-specific `:has-text` from `X_TREND_SELECTORS` used in `page.evaluate`**
- Or pass `X_TREND_SELECTORS` that are valid in `document.querySelectorAll`.

**F5. Move LLM relevance prompt to `PromptRegistry` / Langfuse**
- Versioned and tunable.

**F6. Add `deferFormLogin: true` to `getOrCreateSession` in `getXTrends` and `replies` scrape**
- Avoid inline login in cron/hot paths.

**F7. Add `UTC` date math in `TrendingService`**
- Avoid timezone off-by-one in `daysUntil`.

**F8. Add `getMergedTrending` to `refreshCache` cron**
- Precompute merged result for orchestrator/generation.

**F9. Add `TRENDING_LLM_FILTER_TIMEOUT_MS` env**
- The LLM calls are not individually timeouted. `LlmService.generateChat` may have its own timeout. But niche filter could set a lower timeout.

**F10. Add keyword word boundaries or stemming**
- Reduce false positives like "periodic" matching "period".

**F11. Add `trending` metrics**
- `trending_scraped_total`, `trending_merged_total`, `trending_llm_filter_calls_total`.

## 8. Cross-references

- `modules/content-source` — `topic-generation.service.ts` likely uses `TrendingService`.
- `modules/orchestrator` — `isOrchestratorEnabled()` and may call `getMergedTrending`.
- `modules/sessions` — `SessionsService.getOrCreateSession`.
- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/llm` — `LlmService`.
- `infrastructure/guards` — `LocalhostGuard`.

## 9. Overall assessment

- **Health**: 6/10. The `TrendingService` is a simple, reliable calendar, but it is hardcoded and will become stale. The `TrendingScraperService` has good caching, graceful degradation, and LLM filtering, but the X trend extraction is fragile and uses invalid selectors in `page.evaluate`, and `getMergedTrending` is not cached.
- **Biggest strengths**: RSS parser is robust, Google Trends RSS is free, cache TTL, graceful fallbacks, niche filter with fail-closed LLM, `LocalhostGuard` protects expensive endpoints.
- **Biggest risks**: hardcoded calendar expires after 2027; `page.evaluate` uses Playwright `:has-text` selector; X trend text extraction may return "Trending" label; `getMergedTrending` not cached; `LocalhostGuard` may block UI; no `deferFormLogin`.
- **Recommended next actions**:
  1. Replace or extend `ASTRO_EVENTS_2026` with dynamic ephemeris data.
  2. Fix `X_TREND_SELECTORS` for use in `page.evaluate` (browser-compatible CSS only).
  3. Improve X trend text extraction to avoid the "Trending" label.
  4. Cache `getMergedTrending` results.
  5. Add `deferFormLogin: true` to `getOrCreateSession` call.
  6. Move LLM relevance prompt to `PromptRegistry` / Langfuse.
