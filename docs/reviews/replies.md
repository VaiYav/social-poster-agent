# Module: `modules/replies`

## 1. What this module does

`modules/replies` monitors comments on posts from the last 24 hours, scrapes them with browser automation, classifies them via deterministic filters and an LLM, and either auto-replies, sends to human review, or skips. Auto-replies are scheduled as delayed BullMQ engagement jobs to simulate human response delays. Manual replies are possible via UI.

**Main responsibilities:**
- `RepliesMonitorService` — cron-driven scraping, classification, scheduling, and reply execution.
- `RepliesController` — REST API for pending comments, stats, manual reply, dismiss, run cycle.
- `comment-id.ts` — stable hash-based comment ID generation.
- `sensitive-filter.ts` — deterministic sensitive-topic and troll pre-filter.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `replies.module.ts` | NestJS module | `RepliesModule`, `RepliesModule.withEngagement(...)` |
| `replies.controller.ts` | REST API | `GET /replies/pending`, `GET /replies/stats`, `POST /replies/:id/manual-reply`, `POST /replies/:id/dismiss`, `POST /replies/run` |
| `replies-monitor.service.ts` | Core service | `onModuleInit()`, `runMonitoringCycle()`, `postScheduledReply()`, `manualReply()`, `dismissReview()`, `isEnabled()` |
| `comment-id.ts` | Utility | `buildCommentId(author, text, nativeId?)` |
| `sensitive-filter.ts` | Utility | `detectSensitive(text)`, `isLikelyTroll(text)` |

## 3. How it works

### 3.1 `onModuleInit`

- Skips if `REPLIES_ENABLED=false` or `ORCHESTRATOR_ENABLED=true`.
- Registers a cron `replies-monitor` with `REPLIES_CRON_SCHEDULE` (default `0 */4 * * *`).
- `runMonitoringCycle()` is the cron body.

### 3.2 `runMonitoringCycle`

- `getMonitorablePosts()` — posts with `status: POSTED`, `postedAt >= 24h ago`, `postUrl != null`.
- For each post:
  - `scrapeComments(network, postUrl)` — acquires browser context, navigates, suppresses page errors, blocks images, scrolls 3 times, extracts comments via network-specific CSS selectors.
  - `saveNewComments(postId, network, comments)` — `upsert` by `postId_commentId`; returns only newly created `NEW` comments.
  - For each new comment:
    - `queueFactory.getEngagementJob(comment.commentId, post.network)` — re-entrancy guard (RP1).
    - `decideReply(post, comment)` — deterministic troll, self-reply, max-replies, sensitive filter, then LLM classification.
    - `executeDecision(post, comment, decision, stats)` — skip, human review, or schedule auto-reply.

### 3.3 `scrapeComments`

- Uses `sessionsService.getOrCreateSession`.
- Loads `storageState` from DB and decrypts.
- Uses `browser.acquireContext` / `releaseContext`.
- Navigates to `postUrl`, waits 3s, scrolls 3×.
- Extracts up to 20 comments via `getCommentSelectors`.

### 3.4 `decideReply`

- Deterministic `isLikelyTroll` check.
- Self-reply check by comparing `comment.author` with `account.handle`.
- Max replies per post check (`REPLIES_MAX_PER_POST`, default 3).
- `detectSensitive` (crisis/complaint patterns) → `human_review`.
- If `LlmService` not available, skip.
- `llmDecideReply`:
  - Detects language with `detectLanguage`.
  - Large inline system prompt with examples in 5 languages.
  - Calls `llmService.generateChat`.
  - Parses JSON from markdown.
  - Validates action, replyText, script/language mismatch.
  - Complexity check: length > 200 or >1 question escalates to `human_review` if `REPLIES_AUTO_REPLY_COMPLEXITY` threshold is low/medium.

### 3.5 `executeDecision`

- `skip` → update `SKIPPED`.
- `human_review` → update `HUMAN_REVIEW`, `needsHumanReview=true`, `replyText` preserved.
- `auto_reply`:
  - Computes random delay 5–30 min.
  - If `queueFactory` available, enqueues delayed `reply` engagement job with `jobId=commentId`.
  - Updates `replyText` in DB (status stays `NEW` until worker posts).
  - Fallback: `engagementService.reply()` directly.

### 3.6 `postScheduledReply`

- Re-checks per-post cap at execution time.
- Calls `engagementService.reply()`.
- On success, updates `incomingComment` to `REPLIED` and publishes SSE.
- On failure, throws so BullMQ retries/DLQ.

### 3.7 `manualReply` / `dismissReview`

- `manualReply` validates comment and post URL, calls `engagementService.reply`, updates `REPLIED_MANUAL`.
- `dismissReview` sets `SKIPPED`.

## 4. Dependencies

- `infrastructure/prisma` — `Post`, `IncomingComment`.
- `modules/accounts` — `AccountsService`.
- `modules/sessions` — `SessionsService`.
- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/llm` — `LlmService`.
- `infrastructure/notifications` — `DiscordNotificationService`.
- `infrastructure/sse` — `SseService`.
- `modules/engagement` — `EngagementService`.
- `infrastructure/queue` — `QueueFactory`.
- `modules/orchestrator` — `IRepliesMonitorPort` token, `isOrchestratorEnabled()`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `REPLIES_ENABLED` | `false` | constructor | Feature flag |
| `REPLIES_CRON_SCHEDULE` | `0 */4 * * *` | constructor | Cron schedule |
| `REPLIES_MAX_PER_POST` | `3` | constructor | Max replies per post |
| `REPLIES_AUTO_REPLY_COMPLEXITY` | `medium` | constructor | low/medium/high threshold for human review |
| `REPLIES_AUTO_DELAY_MIN_MS` | `300000` | `computeReplyDelayMs` | Min reply delay |
| `REPLIES_AUTO_DELAY_MAX_MS` | `1800000` | `computeReplyDelayMs` | Max reply delay |
| `REPLIES_TEMPERATURE` | `0.6` | module-level constant | LLM temperature |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `replies-monitor.service.ts:51` uses `process.env.REPLIES_TEMPERATURE` instead of `ConfigService`**
- Module-level `const REPLIES_TEMPERATURE = Number(process.env.REPLIES_TEMPERATURE ?? 0.6);`. This is read at import time, not at runtime, and bypasses validation. Should be `configService.get<number>('REPLIES_TEMPERATURE', 0.6)`.

**B2. `RepliesMonitorService` `runMonitoringCycle` processes posts sequentially**
- Each post requires a browser session. With many posts, the cycle can be long. Parallelization per network is possible but not implemented. `stats` only reflect processed posts; if a later post fails, earlier posts are still counted.

**B3. `scrapeComments` calls `getOrCreateSession(network)` without `{ deferFormLogin: true }`**
- `sessions.service.ts` uses `deferFormLogin` in `BrowsingSessionService` and `PostingService` to avoid inline login in hot paths. The replies cron should pass the same option to avoid hanging on a login form.

**B4. `scrapeComments` uses hardcoded `page.waitForTimeout(3000)` and `scrollForComments` uses `page.waitForTimeout(1500)`**
- Static sleeps; `waitForTimeout` can throw if the page closes. Should use `browser.randomDelay` or dynamic wait for comment container.

**B5. `extractComments` does not use native comment IDs for `buildCommentId`**
- `buildCommentId` accepts `nativeId` but the caller passes only `author` and `text`. Hashing text means an edited or duplicate comment changes or collides; native IDs would be more stable.

**B6. `extractComments` selectors may scrape the original post as a comment**
- For X, `commentContainer` is `[data-testid="cellInnerDiv"] article` which matches the original post and replies. The original post may be treated as a comment. The self-reply check should catch it, but see B7.

**B7. Self-reply detection is fragile**
- `decideReply` compares `comment.author.toLowerCase().replace(/^@/, '')` to `account.handle`. But `comment.author` for X is extracted from `[data-testid="User-Name"]`, which contains display name + handle, e.g., `My Zodiac AI\n@myzodiacai`. The comparison fails. This can lead to replying to the bot's own post/comments.

**B8. `extractComments` for Threads/Facebook author selectors may return display name instead of handle**
- Threads selector `a[href*="/@"] span` and Facebook `span a[href*="/user/"]` likely return display name, not handle. Self-reply check fails for them too.

**B9. `executeDecision` `auto_reply` with `queueFactory` does not increment `stats.repliesPosted`**
- `stats.repliesPosted` is only incremented in the fallback direct-post path (line ~714). When queue is used, the monitoring cycle summary reports `repliesPosted: 0` even though replies were scheduled. The `replies_monitor` SSE event is misleading. Should track `repliesScheduled` separately.

**B10. `postScheduledReply` does not update the monitoring cycle stats**
- The `reply_posted` SSE is published, but no aggregate counter is updated. The `replies/stats` endpoint counts `REPLIED` status, so it eventually corrects, but the cycle summary is stale.

**B11. `scrapeComments` re-fetches the session with `select: { storageState: true }` instead of using the `session` from `getOrCreateSession`**
- `SessionsService.decryptStorageState` only needs `session.storageState`, so decryption works: the `storageState` field carries the `v1:` ciphertext with the IV/tag embedded. The extra `findUnique` is therefore redundant and could return stale data if the session was updated since `getOrCreateSession` returned it. Use the `session` object directly, or refetch with `storageState` and the updated `updatedAt` to detect staleness.

**B12. `manualReply` does not re-check `maxRepliesPerPost` or status**
- A human can bypass the per-post cap and reply to comments not in `HUMAN_REVIEW` status. This may be intended (human override) but is inconsistent with `postScheduledReply`.

**B13. `runMonitoringCycle` does not re-check `flowControl.isPaused('engagement')` or `pauseAll`**
- Unlike `EngagementService` and `BrowsingSessionService`, the replies cron does not poll flow control. If an operator pauses engagement, the replies cron continues to run and may auto-reply. This is a bug for operational safety.

**B14. `llmDecideReply` uses a large inline prompt instead of `PromptRegistry` / Langfuse**
- `AGENTS.md` says all production prompts are in Langfuse Prompt Management. The replies system prompt is inline and not versioned, so prompt changes require redeploy and cannot be A/B tested.

**B15. `llmDecideReply` `systemPrompt` tells the LLM to set `detectedLanguage` to the pre-detected value**
- This is good, but the validation `matchesScript(parsed.replyText, lang)` uses `detectLanguage` as ground truth. If `detectLanguage` returns `und` or an unsupported code, `matchesScript` may default to English or false, causing false `human_review` escalations.

**B16. `decideReply` skips own comments only when `account.handle` is found**
- If `AccountsService.findByNetwork` returns `null` or `handle` is empty, self-reply check is bypassed. The comment author extraction is broken anyway (B7).

**B17. `extractComments` catches and silently ignores individual extraction errors**
- For a single `article` that fails to parse text, it continues. This is fine, but if `commentText` or `author` returns empty, it skips. No logging of skipped comments.

**B18. `extractComments` for Facebook `commentContainer` selector `div[aria-label*="Comment"]` may not match actual Facebook DOM**
- Facebook comment containers are usually `div[role="article"]` or `div[data-visualcompletion]`; `aria-label*="Comment"` may be localized or missing. This selector is likely wrong for Facebook and will return empty comments.

**B19. `computeReplyDelayMs` uses `Number()` on `configService.get<string>`**
- If env value is `'foo'`, `Number('foo')` is `NaN`, `Number.isFinite` false, so falls back to default. Good. But it uses `configService.get<string>` for numeric values. Should use `get<number>` or `Number()` consistently.

**B20. `RepliesController` write endpoints (`manual-reply`, `dismiss`, `run`) check `repliesMonitor.isEnabled()` but the module is also gated by `REPLIES_ENABLED`**
- The `ensureEnabled` guard is redundant but safe. However, `GET /replies/stats` returns `enabled` from `isEnabled()`, which is fine. The `GET /replies/pending` works even when disabled.

### 6.2 Performance

**P1. `runMonitoringCycle` processes posts sequentially, each with browser navigation and scrolls**
- For 10 posts, this is ~30–60s or more. Could parallelize by network if sessions support it.

**P2. `scrapeComments` scrolls only 3 times with fixed 1.5s delay**
- Captures at most 20 comments. If a post has many comments, the oldest may not load. Fine for the 3-reply cap.

**P3. `saveNewComments` does one `upsert` per scraped comment sequentially**
- With 20 comments per post and 10 posts, 200 sequential DB calls. Could batch, but `upsert` uniqueness requires individual handling.

**P4. `decideReply` makes one LLM call per new comment**
- For 50 new comments, 50 LLM calls. Expensive. Could batch comments like `HumanBehaviorEngine.processPosts`.

**P5. `postScheduledReply` calls `engagementService.reply` which creates a new browser context per reply**
- Same memory/performance issue as `EngagementService` individual actions.

### 6.3 Architecture / anti-patterns

**A1. `RepliesMonitorService` is a large cron + scraping + LLM + posting service**
- Could be split into `CommentScraper`, `ReplyDecisionService`, `ReplyScheduler`.

**A2. `RepliesMonitorService` depends on `EngagementService` and `QueueFactory` directly**
- The delayed reply job is `action: 'reply'`. The worker dispatches to `postScheduledReply`. The `reply` action is in the engagement queue. This is okay but couples replies to engagement queue.

**A3. `RepliesModule` uses `withEngagement` to conditionally compose the module when `REPLIES_ENABLED` and `ENGAGEMENT_ENABLED` are true**
- `Replies` needs `EngagementService` for `reply`. This is a module dependency. The `app.module.ts` conditionally uses `RepliesModule.withEngagement(EngagementModule)`. Good.

**A4. `RepliesController` mixes read and write with a `ensureEnabled` guard on writes**
- Good. But `manualReply` should validate the comment status and per-post cap.

**A5. `comment-id.ts` uses SHA-256 of `author + NUL + text`**
- Good. But if `author` is empty or incorrect, the hash is less unique. `nativeId` is not used. Should be used when available.

**A6. `sensitive-filter.ts` uses regex patterns for crisis/complaint detection**
- Word boundaries are not used for Cyrillic in `CRISIS_PATTERNS` (comment says `\b` does not work for Cyrillic). This can cause false positives. But the comment acknowledges trade-offs.

### 6.4 TypeScript / type safety

**T1. `RepliesController` `manualReply` returns `{ success: false, error: parsed.error.message }` with HTTP 200**
- Should use `BadRequestException` or return 400. Currently it returns 200 with `success: false`. Not a bug, but inconsistent with other endpoints.

**T2. `RepliesController` `runCycle` returns `this.repliesMonitor.runMonitoringCycle()` directly**
- The return type is a promise of the stats object. Good.

**T3. `RepliesMonitorService` `manualReply` uses `comment.post.network` as `SocialNetwork` directly**
- Type from Prisma is `SocialNetwork` enum. Good.

**T4. `RepliesMonitorService` `executeDecision` `decision` is `ReplyDecision` but `action` can be `skip`/`human_review`/`auto_reply`**
- The switch is exhaustive. Good. Could add `default` or `never` check.

**T5. `buildCommentId` `nativeId` is `string | null | undefined` but `n:${native}` is used if length > 0**
- Good. Not used by caller.

### 6.5 Security / reliability

**S1. `RepliesController` write endpoints are not admin-only**
- If `AUTH_ENABLED=true`, any authenticated user can trigger replies or dismiss comments. Should be admin-only.

**S2. `runMonitoringCycle` is not gated by `FlowControlService`**
- Operator cannot pause replies without disabling the module. This is a reliability risk.

**S3. `manualReply` does not sanitize `replyText` beyond `z.string().min(1).max(500)`**
- User-supplied text is passed to `engagementService.reply`. The social platform may have its own limits. Good enough. But no `sensitive-filter` check on manual replies.

**S4. `sensitive-filter.ts` `isLikelyTroll` uses `\b` word boundaries**
- Good for English. But `\b` does not work for Cyrillic; the regex may not catch Cyrillic troll words. It only matches `bot|stupid|idiot|hate|...` etc. which are English. There are no Cyrillic troll patterns.

**S5. `llmDecideReply` `systemPrompt` is interpolated into user prompt with `sanitizeUntrustedInput`**
- Good. The `post.content` and `comment.text` are sanitized before interpolation. The `sanitizeUntrustedInput` should truncate or escape. Need to verify it strips quotes/newlines? It is described in `infrastructure/llm/sanitize-untrusted-input.ts` but not reviewed.

**S6. `postScheduledReply` updates `incomingComment` to `REPLIED` only if `engagementService.reply` returns `success: true`**
- If `engagementService.reply` returns `success: false` but the reply actually posted (status mismatch), the comment is retried and could lead to a duplicate reply. `engagementService.reply` should be the source of truth. Good.

**S7. `getMonitorablePosts` only includes posts from the last 24h**
- Good. But a post may have an old comment that appears later. Replies only monitor posts for 24h after posting. This is a business rule.

## 7. New feature / improvement ideas

**F1. Use `ConfigService` for `REPLIES_TEMPERATURE`**
- Remove `process.env` read.

**F2. Pass `{ deferFormLogin: true }` to `getOrCreateSession` in `scrapeComments`**
- Avoid inline login in cron.

**F3. Fix `storageState` decryption query to select `storageStateIv`/`storageStateTag` or use the full session object**
- Critical for production encryption.

**F4. Fix self-reply detection by extracting the handle from the author DOM element**
- Use `href` or `User-Name` parsing to get `@handle`.

**F5. Exclude the original post from `extractComments` for X/Threads**
- Use a more specific selector or skip the first `article`.

**F6. Add `repliesScheduled` to `runMonitoringCycle` stats and SSE**
- Fix misleading `repliesPosted` count.

**F7. Gate `runMonitoringCycle` with `FlowControlService`**
- Respect `pauseAll` and `pauseEngagement`.

**F8. Move the reply prompt into `PromptRegistry` / Langfuse**
- Versioned, A/B testable, no redeploy.

**F9. Batch reply decisions via `decideActionsBatch` or a dedicated `IEngagementDecisionPort` method**
- Reduce LLM calls.

**F10. Add `maxRepliesPerPost` check and status validation to `manualReply`**
- Consistent with `postScheduledReply`.

**F11. Add `nativeId` extraction for X/Threads/Facebook**
- Use `data-testid`, `href`, or `aria-labelledby` for stable comment IDs.

**F12. Add `RepliesMonitorService` metrics**
- `replies_scraped_total`, `replies_decisions_total`, `replies_posted_total`, `replies_human_review_total`.

**F13. Add retry for transient scrape failures and retry count in `incomingComment`**
- Avoid reprocessing all comments from scratch.

## 8. Cross-references

- `modules/engagement` — `EngagementService.reply` used for posting replies.
- `modules/accounts` — `AccountsService.findByNetwork` for self-reply detection.
- `modules/sessions` — `SessionsService.getOrCreateSession` and `decryptStorageState`.
- `modules/orchestrator` — `IRepliesMonitorPort` token, `isOrchestratorEnabled()`.
- `infrastructure/llm` — `LlmService`, `sanitizeUntrustedInput`, `detectLanguage`, `matchesScript`.
- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/prisma` — `Post`, `IncomingComment`.
- `infrastructure/sse` — `SseService`.
- `infrastructure/queue` — `QueueFactory`.
- `infrastructure/notifications` — `DiscordNotificationService`.

## 9. Overall assessment

- **Health**: 5/10. The replies module has a clear pipeline and good safety guardrails (sensitive filter, troll detection, language validation), but it has critical issues: `process.env` temperature, redundant `storageState` refetch, broken self-reply detection, original-post scraping, and no flow-control pause.
- **Biggest strengths**: deterministic safety pre-filter, delayed queue scheduling, manual review UI, hash-based stable comment IDs, multilingual prompt, script/language validation.
- **Biggest risks**: self-reply detection may reply to own posts; `runMonitoringCycle` ignores flow control; `repliesPosted` stats are misleading; prompt is inline and not versioned.
- **Recommended next actions**:
  1. Use the `session` object from `getOrCreateSession` directly instead of re-querying `storageState`.
  2. Fix self-reply detection by extracting handle from the author element.
  3. Exclude original post from scraped comments.
  4. Add `flowControl.isPaused` checks.
  5. Move `REPLIES_TEMPERATURE` to `ConfigService`.
  6. Move the reply prompt to `PromptRegistry` / Langfuse.
  7. Add `repliesScheduled` to stats and fix `repliesPosted` reporting.
