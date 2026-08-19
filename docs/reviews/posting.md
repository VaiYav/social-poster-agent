# Module: `modules/posting`

## 1. What this module does

`modules/posting` is the browser-automation execution layer: it takes an `APPROVED` `Post` and publishes it to X, Threads, or Facebook via Camoufox/Playwright. It handles the full lifecycle: status checks, rate limiting, session acquisition, context pooling, multi-stage threads, retries, validation, and SSE progress. It is one of the highest-risk modules (real account bans, duplicate posts, failed posts). The previous audit (`docs/audit/03-reliability-anti-ban.md`) found several critical issues here; many have been partially fixed, but some still persist.

**Main responsibilities:**
- `PostingService.postById()` — orchestrate a single post from `APPROVED` to `POSTED`/`FAILED`.
- `PostingService.postAllApproved()` — batch posting with human-like delays.
- `PostingService.scheduleMultiStagePosting()` — queue thread root + continuations with delayed `BullMQ` jobs.
- `XPoster`, `ThreadsPoster`, `FacebookPoster` — network-specific compose/submit/validate logic.
- `BasePoster` — shared selector resolution, human-like typing, validation, shadowban detection, error classification, screenshots.
- `ThreadProgressService` — persistent per-reply thread progress for crash recovery.
- `posting/posters/selectors/` and `selector-strategy.ts` — multi-fallback selector resolution for brittle social UIs.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `posting.module.ts` | NestJS module wiring | `PostingModule` — imports `BrowserModule`, `SseModule`, `CryptoModule`, `AccountsModule`, `SessionsModule`, `WarmupModule`, `PostsModule`, `RateLimitModule`, `PrismaModule`, `QueueModule`, `FlowControlModule` |
| `posting.service.ts` | Main orchestrator | `postById()`, `postAllApproved()`, `scheduleMultiStagePosting()`, `findLivePostUrl()` |
| `posting.controller.ts` | REST endpoints | `POST /posting/:postId`, `POST /posting/batch/all-approved`, `POST /posting/multi-stage/:rootPostId` |
| `posters/base.poster.ts` | Abstract base for all networks | `resolve()`, `humanType()`, `typeHuman()`, `humanClick()`, `validatePostOnProfile()`, `validatePostUrl()`, `classifyError()`, `withErrorHandling()`, `verifyPosted()`, `detectShadowban()`, `detectPostShadowban()` |
| `posters/x.poster.ts` | X (Twitter) posting | `post(context, browserPort, content, threadItems?)` |
| `posters/threads.poster.ts` | Threads posting | `post(context, browserPort, content, threadItems?)` |
| `posters/facebook.poster.ts` | Facebook business page posting | `post(context, browserPort, content)`, `postThread(context, browserPort, rootContent, threadItems)` |
| `thread-progress.service.ts` | Thread persistence | `initThread()`, `markReplyPosted()`, `markReplyFailed()`, `getPendingReplies()`, `getThreadProgress()`, `isThreadComplete()`, `getThreadStats()` |
| `posters/selector-strategy.ts` | Multi-fallback selector resolver | `resolveSelector()`, `waitForSelector()` |
| `posters/selectors/*.selectors.ts` | Network selectors | `X_SELECTORS`, `THREADS_SELECTORS`, `FACEBOOK_SELECTORS` |
| `posters/permalink.ts` | URL validation helper | `isPermalink()`, `normalizePermalink()` |

## 3. How it works

### 3.1 `PostingService.postById()` flow

```
1. Load post via PostsService.findById()
2. Check network enabled (ENABLED_NETWORKS)
3. Check flow-control pause
4. Idempotency check: POSTED/POSTING/FAILED/REJECTED handling
5. Rate-limit check (RateLimitService)
6. Warmup check (WarmupService.canPost())
7. Mark post POSTING
8. SSE: post_status POSTING
9. Acquire session from SessionsService.getOrCreateSession()
10. Decrypt storageState if needed
11. Acquire browser context from BrowserPort pool
12. If thread root: load continuation posts and init ThreadProgress
13. Invoke network-specific poster with retry
14. If session-expired error: self-recovery loop (3 attempts, then defer to BullMQ)
15. Validate returned URL
16. Update post status POSTED/FAILED
17. If thread: update each reply status individually
18. Record rate-limit success
19. SSE: post_status POSTED/FAILED
20. Release context in finally
```

### 3.2 Retry and self-recovery

- `withRetry` wraps the actual poster call with 2 retries, 5s-30s backoff, and a retryable predicate that only retries transient network errors (`net::ERR`, `ECONNREFUSED`, `Timeout`, `Navigation failed`, `Target page...closed`).
- On retry, `postFn` first calls `findLivePostUrl()` to avoid re-posting if the previous attempt actually succeeded but validation failed.
- If the poster returns `not logged in|session expired|relogin`, a self-recovery loop runs 3 attempts (5s, 10s, 20s), marks the old session expired, creates a new session, and re-posts. If this fails, the function sets the post back to `APPROVED` and throws a retryable error so BullMQ re-queues with exponential backoff.

### 3.3 `BasePoster` architecture

`BasePoster` is an abstract class with concrete network subclasses. Common behavior:
- Selector resolution via `waitForSelector()` (data-testid → role → label → CSS → text).
- Human-like typing (`humanType`, `typeHuman` from browser port).
- Screenshot capture at phases: `before-compose`, `after-compose`, `after-type`, `after-submit`, `after-validate`, `on-error`.
- Profile validation (`validatePostOnProfile`) — searches for the first 40 chars of content on the public profile, retries once, and tries to extract the post permalink.
- Shadowban/restriction detection (`detectShadowban`, `detectPostShadowban`).
- Error classification (`classifyError`, `withErrorHandling`).
- `verifyPosted()` — `M1`: scrapes the public profile to check if content is already live, used to avoid duplicates.

### 3.4 `XPoster` posting

X posting was refactored (`x.poster.ts:1-130`) to use the home-page compose dialog as the primary path and `/compose/post` as the fallback:

1. **Pre-flight** — content length is checked against X's 280-character hard limit (`x.poster.ts:44-48`).
2. A new page is created and `suppressPageErrors()` is injected (`x.poster.ts:50-51`).
3. **Primary path** — `postViaHomePageCompose()` opens the home-page compose dialog, types via `execCommand('insertText')`, clicks the Post button, and validates (`x.poster.ts:54-67`).
   - Includes SPA-mount detection (`x.poster.ts:662-690`): waits for the timeline/compose UI, reloads once with `networkidle`, and falls back to the compose page if the home dialog cannot be opened.
4. **Fallback** — if the home dialog fails, navigates to `X_SELECTORS.compose.url` (`/compose/post`) with `domcontentloaded` (`x.poster.ts:73-75`), checks for login page, detects shadowban, and takes a `before-compose` screenshot.
5. **Typing** on `/compose/post`:
   - Clicks the `[data-testid="tweetTextarea_0"]` / `[role="textbox"]` textbox (`x.poster.ts:115-127`).
   - Tries `execCommand('insertText')` first, then `fill()` with a DraftJS nudge, then `pressSequentially()` (keyboard) as last resort (`x.poster.ts:129-167`).
6. **Submit** — clicks the Post button, falls back to `Cmd+Enter`, then a JavaScript click (`x.poster.ts:282-374`); retries once on failure.
7. **Validation** — checks URL pattern, extracts the new tweet URL from DOM links, and falls back to profile-page search with Unicode normalization (`x.poster.ts:376-443`); `validatePostOnProfile` reloads the profile once if the content is not found on the first try (`base.poster.ts:240-277`).
8. **Threads** — `postThreadReplies()` replies to the root tweet with 30-90s delays and suppresses page errors before each reply (`x.poster.ts:950-961`).

### 3.5 `ThreadsPoster` posting

1. Navigate to Threads home.
2. Click "New thread" / compose button.
3. Type via `typeHuman`, fallback to `setComposeText`.
4. Click "Post".
5. If URL matches post pattern, use it; else extract profile URL and validate.
6. Post thread replies via `postThreadReplies()` (replies with 30-90s delays).

### 3.6 `FacebookPoster` posting

1. Navigate to `https://www.facebook.com/{SOCIAL_FACEBOOK_PAGE_SLUG}`.
2. Click "Create post".
3. Type into `contenteditable` textarea via `humanType`.
4. Click "Publish".
5. If URL matches post/permalink/photos pattern, use it; else validate by checking page feed content.
6. Threads are simulated as comments on the root post (`postThread` / `postComment`).

### 3.7 Queue integration

`QueueModule` registers a BullMQ worker per network. Worker calls `postingService.postById()`. If `result.success` is false and `retryable` is false, it resolves the job (no retries). Otherwise it throws and BullMQ retries. `QueueFactory` handles dedup by `jobId = postId`, but removes old completed/failed jobs before re-enqueueing.

### 3.8 Multi-stage thread scheduling

`scheduleMultiStagePosting()`:
1. Validates root post has `threadId` and `threadPosition=0`.
2. Gets APPROVED continuations.
3. Enqueues root immediately (priority 1).
4. Enqueues each continuation with delay `position * THREAD_CONTINUATION_DELAY_MS` (default 30 min).

## 4. Dependencies

**Downstream (called by posting):**
- `infrastructure/browser` — `IBrowserPort` (context pool, page, typing, screenshots, resource blocking).
- `modules/sessions` — `SessionsService` (get/create session, decrypt storageState, update storageState, mark expired).
- `modules/sessions/warmup` — `WarmupService` (`canPost`).
- `modules/accounts` — `AccountsService`.
- `modules/posts` — `PostsService` (find, update status, findThreadContinuations).
- `modules/rate-limit` — `RateLimitService` (check, record).
- `infrastructure/sse` — `SseService` (progress events).
- `infrastructure/queue` — `QueueFactory` (enqueue).
- `modules/flow-control` — `FlowControlService` (pause check).
- `infrastructure/prisma` — `PrismaService` for `ThreadProgress`.
- `domain/retry`, `domain/circuit-breaker`, `domain/errors` — retry helper, circuit breaker, typed errors.

**Upstream (callers of posting):**
- `modules/queue` — BullMQ worker.
- `modules/posts` — `approve()` may enqueue via `QueueFactory` (see `posts.service.ts`).
- `posting.controller` — manual endpoints.
- `modules/autonomy` / `events/listeners/auto-approve.listener` — auto-approve may trigger posting.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `ENABLED_NETWORKS` | all | `isNetworkEnabled()` | Which networks are enabled |
| `SOCIAL_X_USERNAME` | — | `base.poster.ts:692`, `x.poster.ts:931` | Verification profile URL for X |
| `SOCIAL_THREADS_USERNAME` | — | `base.poster.ts:696` | Verification profile URL for Threads |
| `SOCIAL_FACEBOOK_PAGE_SLUG` | — | `base.poster.ts:700`, `facebook.poster.ts:27` | Facebook business page slug |
| `THREAD_CONTINUATION_DELAY_MS` | `1800000` | `posting.service.ts:699` | Delay between multi-stage continuations |
| `SPA_DEBUG_SELECTORS` | `false` | `x.poster.ts:92` | Extra HTML/testid logging for X compose |
| `BULLMQ_POSTING_MAX_RETRIES` | `8` | `queue.factory.ts:60` | BullMQ retries for posting jobs |
| `BULLMQ_POSTING_RETRY_DELAY_MS` | `120000` | `queue.factory.ts:61` | Posting retry base delay |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `PostingService.postById()` does NOT use `CircuitBreakerRegistry` that it instantiates**
- `posting.service.ts:41` creates `private readonly circuitBreakers = new CircuitBreakerRegistry()` but the `circuitBreakers` field is never used in `postById` or anywhere. The `CircuitBreakerRegistry` is dead code in `PostingService`. (It may be used elsewhere, but in this file it's unused.)

**B2. `findLivePostUrl` verifies against public profile with `content.slice(0, 40)` but `validatePostOnProfile` only uses 40 chars, then 30 chars without quotes**
- `base.poster.ts:190` `content.slice(0, 40)` and `base.poster.ts:218` `content.replace(/^["']+|["']+$/g, '').slice(0, 30)`. This means verification is based on a short, possibly non-unique snippet. For short astrology tweets, two posts can share the same first 40 chars (e.g., same hook reused). This can cause a false positive "already live" and skip a post that wasn't actually published, or validate a stale post as the new one.

**B3. `validatePostOnProfile` can return `page.url()` (profile URL) as success when no post URL link is found**
- `base.poster.ts:293-296` returns `page.url()` if content is found but no link matches `postUrlPattern`. This profile URL is later rejected by `posting.service.isValidPostUrl()` (which is correct), but the validation function itself is misleading. It returns a URL that is then thrown away by `isValidPostUrl`. This is a known issue from the previous audit and still present.

**B4. `validatePostOnProfile` is unreliable for X/Threads because it searches `page.innerText('body')` and short text**
- `base.poster.ts:191` `const pageText = await page.innerText('body').catch(() => '');` — the entire page body. If the profile contains the same snippet from an old post, it may match and produce a wrong URL. The fallback to post-specific selectors (`postContentSelector`) is better, but still uses short snippets.

**B5. `XPoster.getAccountHandleFromEnv` reads `process.env.SOCIAL_X_USERNAME` directly**
- `x.poster.ts:931` uses `process.env` directly instead of `ConfigService`. Same in `base.poster.ts` for verification handles (`SOCIAL_X_USERNAME`, `SOCIAL_THREADS_USERNAME`, `SOCIAL_FACEBOOK_PAGE_SLUG`). This is inconsistent with the rest of the codebase and breaks if the config is loaded from a different source.

**B6. `posting.service.ts:699` uses `parseInt(process.env.THREAD_CONTINUATION_DELAY_MS ?? '1800000', 10)` directly**
- Should use `ConfigService`. Also no validation; a non-numeric env value yields `NaN` and `position * NaN = NaN`, which BullMQ may reject or ignore.

**B7. `ThreadsPoster` uses `waitUntil: 'networkidle'` for `/compose` fallback**
- `threads.poster.ts:66` `page.goto('https://www.threads.com/compose', { waitUntil: 'networkidle' })` — Threads (like X) uses constant polling. `networkidle` may timeout and is discouraged elsewhere. Should use `domcontentloaded`.

**B8. `ThreadsPoster.extractProfileUrl` uses `page.locator('a[href^="/@"]')` and `aria-label` fallback**
- This is fragile. If the user is not logged in or the nav has a different layout, `profileUrl` may be wrong, leading to `validatePostOnProfile` failing.

**B9. `FacebookPoster.post` does not pre-validate the 500-char marketing limit**
- `facebook.poster.ts` has no `content.length` check. The generation graph enforces ~500 chars, but if an operator edits a post or the generation limit is relaxed, the Facebook post may exceed the practical limit and fail in the browser.

**B10. `posting.service.ts` catch-all error handler sets status FAILED and discards the original `SpaError` type**
- `posting.service.ts:520-539` catches any `SpaError`, extracts `message`, and updates status with just the string. This loses `retryable`/`code`/`screenshotPath` fields. The queue worker then throws `new Error(result.error)` which loses the `SpaError` retry semantics. The comment says "P0-H1: Preserve SpaError retry semantics" but the implementation converts it to a string.

Wait, `postById` returns `{ success: false, error: message }` in the catch. `QueueModule` checks `result.retryable` (line 59), but the catch block does not set `retryable`, so `result.retryable` is `undefined` (falsy). For errors caught in `postById`, the worker throws `new Error(result.error ?? 'Posting failed')`, which triggers BullMQ retries. For errors returned by `postById` from earlier branches (e.g., disabled network) `retryable` is explicitly set to `false`. For the catch-all, `retryable` is undefined; the worker will throw. This is intentional for transient failures. However, for `ValidationError` or `SelectorNotFoundError`, `postById` returns `{ success: false, error: result.error }` (not throwing), and `retryable` is not set — the worker throws and BullMQ retries. For `ValidationError` and `SelectorNotFoundError`, the code comment says these should NOT be retried. But `postById` returns them as `success: false` with `retryable` undefined, and `QueueModule` throws, so BullMQ retries them. This is a bug.

Looking at `postById`:
- `result.error` path (line 393): `return { success: false, error: result.error }` — `retryable` is not set. `result` comes from `xPoster.post()` which returns `PostResult` with `{ error, screenshotPath }`. No `retryable` field. So `QueueModule` throws and retries even for `ValidationError`/`SelectorNotFoundError`.

This contradicts `BasePoster.withErrorHandling` which wraps `ValidationError` in `error`. The `QueueModule` then retries it. This wastes retries for UI-change errors. `PostingService.postById` should inspect `result.error` and set `retryable: false` for known non-retryable errors (e.g., `Post button is disabled`, `DraftJS state not updated`, `Posted content not found on profile page`).

**B11. `posting.service.ts` `postAllApproved` catches `Rate limited` and `warm-up` by substring match in message**
- `posting.service.ts:644` checks `msg.includes('Rate limited') || msg.includes('warm-up')`. This is fragile. If the error message wording changes, it fails. Better to check `SpaError`/`RateLimitError` types, but those are lost in the catch-all.

**B12. `posting.service.ts` `postById` catches errors in `updateStatus` calls with `.catch(() => {})`**
- `posting.service.ts:68`, `posting.service.ts:382`, `posting.service.ts:395`, `posting.service.ts:417`, `posting.service.ts:435`, `posting.service.ts:449`, `posting.service.ts:465`, `posting.service.ts:489`, `posting.service.ts:525`, `posting.service.ts:531`. Swallowing DB update errors can hide persistence failures and leave stale status in UI. Some are intentional (non-blocking), but for critical transitions like FAILED/POSTED it could be risky.

**B13. `ThreadProgressService.initThread` uses sequential `upsert` in a loop**
- `thread-progress.service.ts:34-56` iterates over replies and calls `prisma.threadProgress.upsert` one by one. This is N+1 and could be a single `createMany` with `skipDuplicates`.

**B14. `ThreadProgressService` has `getPendingReplies` but is never used to resume a thread**
- `thread-progress.service.ts:122-131` returns pending reply IDs, but no caller uses it. The multi-stage scheduler re-enqueues entire threads from `Post` status, not from `ThreadProgress`. This makes `ThreadProgress` mostly an audit table, not a resumption source.

**B15. `XPoster.postReply` uses `page.addInitScript` for error suppression every reply**
- `x.poster.ts:958-961` adds an error listener on every reply. This is redundant and may leak listeners. `page.addInitScript` is for scripts that run on every page load, but adding it repeatedly is a no-op in Playwright? It may just add the same script repeatedly.

**B16. `XPoster.postViaHomePageCompose` uses `networkidle` for X home page**
- `x.poster.ts:655` uses `networkidle`. It is explicit in the comment, but X/Threads never reach `networkidle` due to polling. The code waits 30s and then reloads. This is a known issue and the fallback reload is there. Still, `networkidle` is risky.

**B17. `validatePostOnProfile` constructs full URL with a hardcoded `https://www.` prefix and per-network hostnames**
- `base.poster.ts:287` uses `https://www.x.com` or `https://www.threads.com` or `https://www.facebook.com`. X posts are typically `https://x.com/...` (no www). The constructed URL may be a valid canonical, but the regex `postUrlPattern` is then tested. It likely works. Minor issue.

**B18. `FacebookPoster` is the only poster that uses `ConfigService` in constructor**
- `facebook.poster.ts:24` injects `ConfigService`. The `SOCIAL_FACEBOOK_PAGE_SLUG` is read at construction. If the env var changes, the poster must be restarted. This is consistent with X/Threads using `process.env` at call time, but both are bad patterns. Use `ConfigService` for all, or use `accountsService` to get the page slug from the DB.

**B19. `XPoster` and `ThreadsPoster` use `postThreadReplies` with retry on `page.isClosed`, but if `page` crashes, the reply loop does not acquire a new page**
- `postThreadReplies` retries the same `postReply` on a potentially closed page. The `isDead` check aborts, but it doesn't open a new page and start over. For a multi-reply thread, a page crash fails the rest of the thread.

**B20. `posting.service.ts` `postById` sets `POSTING` status before checking flow-control and warmup**
- Wait, no. It checks flow control (line 75) and warmup (line 120) before marking POSTING (line 127). Good.

**B21. `posting.service.ts` `postById` does not validate `post.accountId` exists before `warmupService.canPost(post.accountId)`**
- `post` includes `accountId` from Prisma. If the account is missing, `canPost` might fail. Minor.

**B22. `posting.controller` `postById` endpoint does not require post approval and directly posts**
- `POST /posting/:postId` calls `postingService.postById()`. If the post is not `APPROVED`, `postById` throws `NotFoundException`. This is odd (404 instead of 400/409). The endpoint path is `/posting/:postId` but semantically it's a post. The `NotFoundException` is misleading for "not approved".

### 6.2 Performance

**P1. `postById` and `postAllApproved` use many `randomDelay` calls, sometimes sequential**
- `posting.service.ts:653` waits 10-30s between batch posts. `x.poster.ts` and `threads.poster.ts` use 30-90s between thread replies. This is intentional humanization but makes batch posting slow. Not a bug.

**P2. `validatePostOnProfile` waits 8s + 5s on retry + 3-6s initial delay = up to 19s just for validation**
- `base.poster.ts:165`, `base.poster.ts:175`, `base.poster.ts:245`. This is acceptable per post but can be tuned. For X/Threads, the post can be delayed after publish; the validation logic is robust.

**P3. `postViaHomePageCompose` waits up to 30s for SPA mount + reload + 20s + 15s for compose button = 65s worst case**
- `x.poster.ts:669-718`. This is a long fallback but necessary for X's flaky SPA. Could be optimized by pre-warming a home page context.

**P4. `postById` loads session storageState and decrypts it for each post**
- `posting.service.ts:155-157` decrypts storageState and `browser.acquireContext` is called for each post. For batch posts, this is heavy. A session cache or context reuse would help. But context pooling already exists in `BrowserPort`.

**P5. `postAllApproved` loads 50 approved posts but `postById` re-fetches each post individually**
- `posting.service.ts:617` `findMany` loads 50 posts, then `postById` calls `findById` again. The extra `findById` is needed for `include: { account, thread, generationRun }` and up-to-date status, but it is redundant if the `findMany` already included relations. Minor.

**P6. `BasePoster` screenshots at many phases and stores them on disk**
- `base.poster.ts:142-144`, `infrastructure/browser/browser.factory.ts` (per the AGENTS.md). Full-page screenshots can consume disk space if not cleaned up. The AGENTS.md already flagged this as a disk leak.

**P7. `XPoster` `postViaHomePageCompose` calls `page.content()` to get full HTML for debug logging**
- `x.poster.ts:93` only when `SPA_DEBUG_SELECTORS` is true, but `page.content()` can be large. Fine.

**P8. `postThreadReplies` in X/Threads and Facebook does not parallelize replies**
- Replies are posted sequentially with delays. This is correct for human-like behavior and platform rate limits.

### 6.3 Architecture / anti-patterns

**A1. `PostingService` is large and mixes orchestration with posting logic**
- `posting.service.ts` is 726 lines. It handles self-recovery, batch posting, multi-stage scheduling, thread continuation status updates, and URL validation. It is cohesive but could be split: `SinglePostOrchestrator`, `BatchPoster`, `MultiStageScheduler`, `RecoveryService`.

**A2. `XPoster` is 1042 lines and contains many nested fallbacks**
- This is a natural consequence of X's UI fragility, but it is hard to test and maintain. Some fallbacks (fill, paste, keyboard type, JS click) are duplicated. Could be extracted into `XComposeInput`, `XSubmitButton`, `XFallbackHome` helpers.

**A3. `BasePoster` directly reads `process.env` for verification profile URLs**
- `base.poster.ts:689-705` should read from `ConfigService` or an account config. The `verifyPosted` method is `public` and `async` but the class doesn't have access to `ConfigService`.

**A4. `PostingService` does not use the `CircuitBreakerRegistry` it owns**
- As noted in B1, the registry is instantiated but unused. Either use it (e.g., per-network posting circuit breaker) or remove it.

**A5. `PostingService` depends on `IBrowserPort` directly, not via an abstract poster port**
- It knows about `XPoster`, `ThreadsPoster`, `FacebookPoster` concrete classes. A `PosterStrategy` interface + factory would reduce coupling.

**A6. `ThreadProgressService` has no index on `(postId, status)`**
- The service uses `count({ where: { postId, status: 'POSTED' } })` and `findMany({ where: { postId, status: 'PENDING' } })`. If `ThreadProgress` table grows, these queries could be slow without an index. Check schema.

**A7. `posting.controller.ts` has a `batch/all-approved` endpoint that calls `postAllApproved` synchronously**
- If there are many approved posts, this HTTP call will block for minutes. Should be async enqueue or background.

**A8. `posting.service.ts` `postById` has nested `try`/`catch` blocks and a self-recovery loop inside the main try**
- The control flow is complex (post → retry → self-recovery → post validation → thread updates). Error handling is duplicated. Consider a state machine for the posting lifecycle.

**A9. `BasePoster` `withErrorHandling` catches `SpaError` and returns `{ error: err.message }` losing the typed object**
- `base.poster.ts:370-375` returns `error: err.message` and `screenshotPath`, but loses `code`, `retryable`, `network`. `PostingService` then wraps the string in `Error`. This propagates the loss.

### 6.4 TypeScript / type safety

**T1. `PostingService.postById` return type is `{ success: boolean; url?: string; error?: string; retryable?: boolean }`**
- `retryable` is not always set. `QueueModule` relies on it. Better to use `retryable: boolean` with a default.

**T2. `XPoster.post` has `_browserPort` and `_threadItems` with underscore prefix**
- `x.poster.ts:35` and `threads.poster.ts:29` use `_` to indicate unused params. This is a code smell; the interface should not require the param if it's unused. But `BasePoster` uses `browser` in constructor, so `_browserPort` is unused in `post`.

**T3. `posting.service.ts` `findLivePostUrl` returns `string | null` but `postById` pre-retry guard checks `if (live)`**
- `posting.service.ts:195` `const live = await this.findLivePostUrl(...)` and `if (live)`. Good.

**T4. `posting.service.ts` `findLivePostUrl` checks `typeof poster.verifyPosted !== 'function'` but `verifyPosted` is defined on `BasePoster`**
- `posting.service.ts:607` `if (typeof poster.verifyPosted !== 'function') return null`. This is always true (it's a function), so it's dead code. Minor.

### 6.5 Security / reliability

**S1. `posting.controller.ts` `POST /posting/:postId` can be called by any authenticated user with no role check**
- It calls `postById` directly. If an operator accidentally hits the endpoint, it will post immediately. This is a feature, but there is no guard against re-posting an already `POSTED` post (the `postById` idempotency checks `POSTED` and returns success). Fine.

**S2. `posting.service.ts` self-recovery loop sets `PostStatus.APPROVED` and throws, but the status may be overwritten by `finally` in `withRetry`? No, the status is updated before throw.**
- `posting.service.ts:382` updates status to `APPROVED` before throwing. Good. But `BullMQ` retries with the same `postId`/`jobId`; `postById` will then re-fetch the post (now `APPROVED`) and try again. Good.

**S3. `posting.service.ts` `postById` catches `SpaError` with `retryable = false` and converts it to `Error` with `status FAILED` in the outer catch**
- Wait, the outer `catch` catches errors thrown by `postFn` or `withRetry` that are not `SpaError`. `postById` returns `result` from `postFn` (which may have `error`). If `postFn` throws (e.g., `ValidationError`), it is caught by `withRetry` and rethrown. Then `postById` outer catch (line 520) catches it and sets `FAILED`. This is for unhandled errors. But `ValidationError`/`SelectorNotFoundError` are returned by `withErrorHandling`, not thrown. So `postFn` returns `{ error: ... }`, not throwing. Then `postById` sets `FAILED` and returns `success: false`. Good. The `QueueModule` then retries it (because `retryable` is undefined). That's the bug in B10.

**S4. `postById` does not check the `threadId`/`threadPosition` ordering for threads before `findThreadContinuations`**
- It only checks `post.threadPosition === 0` and `post.threadId`. If a thread continuation is approved by mistake, it won't be posted as root, but it could be enqueued separately. Fine.

**S5. `posting.service.ts` `postById` returns `{ success: false, error: message }` where `message` is from `err as Error` but `err` could be a string**
- `posting.service.ts:523` `const message = (err as Error).message;`. If `err` is a string, `message` is undefined. Better use `String(err)` or a helper.

## 7. New feature / improvement ideas

**F1. Use `SpaError` throughout and avoid `result.error` string conversion**
- `postById` should return `SpaError` or a `Result` type with `retryable`. `QueueModule` should inspect `retryable` and `code` for DLQ alerts and retry decisions.

**F2. Add `PostingRetryPolicy` service**
- Centralize retry logic: `QueueModule` for BullMQ retries, `withRetry` for poster retries, and self-recovery. Each error type should have a clear retry policy.

**F3. Improve verification using post permalinks, not profile snippets**
- Capture the post permalink from the network directly after submit. X/Threads sometimes provide it in the DOM or URL. Use `permalink.ts` consistently. The profile-snippet fallback is too fragile.

**F4. Add a `posting.recovery` job**
- Instead of the self-recovery loop inside `postById`, move session recovery to a separate worker or use `postById` re-entry with state. This simplifies the main flow.

**F5. Add `PosterFactory` / `IPosterStrategy` port**
- `PostingService` should resolve poster by `SocialNetwork` from a factory/map, not concrete `xPoster`, `threadsPoster`, `facebookPoster` fields.

**F6. Add posting metrics**
- Emit: `posting_duration`, `posting_attempts`, `post_validation_failures`, `post_rate_limited`, `post_screenshot_count`, `poster_errors_by_code`.

**F7. Add `post draft` endpoint / dry-run preview**
- `posting.controller` could expose a dry-run endpoint that does everything except the final click.

**F8. Improve `ThreadProgress` usage for resumable threads**
- `postThreadReplies` should check `ThreadProgress` before posting a reply, and on crash, resume from the first `PENDING` reply. Currently, `ThreadProgress` is only updated after a reply.

**F9. Add `SOCIAL_*` handles to `Account` model instead of env**
- The verification profile URLs should come from the account, not env vars. This enables multi-account posting.

**F10. Reduce XPoster complexity by extracting compose strategies**
- `XComposeInput`, `XSubmit`, `XHomeCompose`, `XComposePage` classes. Each handles one fallback path.

**F11. Add human-like action randomization as a config**
- `delayMs`, `typingDelay`, `thinkingPause`, `preActionDelay` are hardcoded across posters. Move to `ConfigService` or per-account config.

**F12. Add `post approval` to `posting` controller auth guard**
- The `POST /posting/:postId` endpoint should probably only allow admins to manually trigger posting.

**F13. Avoid re-fetching `post` in `postById` after `postAllApproved` has loaded it**
- `postAllApproved` could pass the post object to an internal `postOne` method, reducing DB queries.

**F14. Add `SESSION_DEFERRED_LOGIN` handling for all recovery paths**
- Currently `getOrCreateSession` is called with `deferFormLogin: true` initially but `false` in self-recovery. This inconsistency may cause login loops.

**F15. Add `post` status `POSTING` with timeout reconciliation**
- `health-monitor.service` should detect `POSTING` jobs older than N minutes and either retry or mark as FAILED. The previous audit identified this as critical.

## 8. Cross-references

- `modules/queue` — BullMQ workers call `postById()`.
- `modules/posts` — `approve()` transitions to `APPROVED` and may enqueue.
- `modules/sessions` — session acquisition, storageState encryption/decryption.
- `modules/sessions/warmup` — warm-up mode.
- `modules/accounts` — account lookup.
- `modules/rate-limit` — per-network rate limiting.
- `modules/flow-control` — pause/resume.
- `modules/engagement` — uses poster selectors for likes/comments.
- `infrastructure/browser` — browser context pool, human-like typing, screenshots.
- `infrastructure/sse` — real-time status events.
- `infrastructure/queue` — BullMQ queue factory.
- `infrastructure/prisma` — `ThreadProgress` table.
- `domain/retry`, `domain/circuit-breaker`, `domain/errors` — shared utilities.
- `docs/audit/03-reliability-anti-ban.md` — prior audit (validatePostOnProfile, stuck POSTING, screenshots, etc.).
- `docs/reviews/generation.md` — generates the `Post` rows consumed by this module.

## 9. Overall assessment

- **Health**: 6/10. The module has been heavily patched and is more reliable than before, but it still carries significant complexity and fragility.
- **Biggest strengths**: multi-fallback selectors, idempotent retry, self-recovery, thread progress persistence, robust X posting fallback, `permalink.ts` guard.
- **Biggest risks**: `retryable` not set for poster errors → BullMQ may retry non-retryable errors; `validatePostOnProfile` still uses short text snippets and can return profile URLs; `process.env` reads in `BasePoster` and `XPoster`; `CircuitBreakerRegistry` unused; `XPoster` is very large; `ThreadProgress` under-utilized for resumption.
- **Recommended next actions**:
  1. Fix `postById` return type to include `retryable` and make `QueueModule` respect non-retryable poster errors.
  2. Move `process.env` reads in `BasePoster`/`XPoster` to `ConfigService` or account config.
  3. Replace `CircuitBreakerRegistry` with actual per-network circuit breaker usage or remove it.
  4. Extract `XPoster` into smaller compose/submit/validate helpers.
  5. Use `ThreadProgress` to skip already-posted replies in `postThreadReplies`.
  6. Add reconciliation for stuck `POSTING` posts (if not already in `health-monitor`).
