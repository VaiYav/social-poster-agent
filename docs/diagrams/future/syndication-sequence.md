# Syndication Sequence — Future State

> **End-to-end flow:** From article cron trigger to published article + social promo posts across 14 platforms.
> **To-be:** Article cron → generation → judge/refine → auto-approve → BullMQ → BrowserAgentService (LLM vision) → Camoufox → publish → verify → canonical → IndexNow → social promo trigger → social posts → their own judge/approve/publish flow.

```mermaid
sequenceDiagram
    autonumber
    participant ArticleCron as ArticleCron
    participant Gen as GenerationService
    participant ArticleGraph as ArticleGraph<br/>(LangGraph)
    participant LLM as LlmService<br/>(15-provider router)
    participant Langfuse as Langfuse
    participant DB as PostgreSQL
    participant Redis as Redis<br/>(checkpoints)
    participant UI as Vue Dashboard
    participant Operator as Operator
    participant Queue as BullMQ Queue<br/>(spa-article / spa-syndication-{platform})
    participant Worker as BullMQ Worker
    participant BrowserAgent as BrowserAgentService<br/>(LLM vision engine)
    participant Camoufox as Camoufox Browser
    participant Platform as Platform<br/>(Dev.to/Hashnode/LinkedIn/etc)
    participant SSE as SSE Service<br/>(Redis pub/sub)
    participant Canonical as CanonicalUrlService
    participant IndexNow as IndexNowService
    participant PromoTrigger as SocialPromoTrigger
    participant SocialGraph as SocialGraph

    Note over ArticleCron: Trigger: CRON_ARTICLE_SCHEDULE<br/>(default: 0 10 * * * — daily)
    ArticleCron->>Gen: generateArticle({ topic, language })
    Gen->>ArticleGraph: graph.invoke(state, { thread_id: article:runId:topic })
    ArticleGraph->>Redis: Save checkpoint
    ArticleGraph->>LLM: research_extract (prompt: article-research-extract)
    LLM->>Langfuse: Trace + fetch prompt (5-min cache)
    LLM-->>ArticleGraph: Facts extracted
    ArticleGraph->>LLM: outline (prompt: article-outline)
    LLM-->>ArticleGraph: H2/H3 structure
    ArticleGraph->>LLM: draft_article (prompt: article-draft)
    LLM-->>ArticleGraph: Full markdown article
    ArticleGraph->>LLM: judge_article (prompt: article-judge)
    LLM-->>ArticleGraph: Judge scores (5 criteria, 0.0-1.0)

    loop Refine loop (max 3 retries)
        alt score < threshold AND retries < 3
            ArticleGraph->>LLM: refine_article (prompt: article-refine)
            LLM-->>ArticleGraph: Refined article
            ArticleGraph->>LLM: judge_article (re-evaluate)
            LLM-->>ArticleGraph: Updated judge scores
        else retries ≥ 3 AND score < threshold
            ArticleGraph-->>Gen: END_REJECTED
            Gen->>DB: Update Article.status = REJECTED
            Gen-->>UI: SSE: article_rejected
        end
    end

    ArticleGraph->>ArticleGraph: set_canonical (CanonicalUrlService.buildBlogUrl)
    ArticleGraph->>ArticleGraph: save_to_db (format state)
    ArticleGraph-->>Gen: Final state (article + canonicalUrl)
    Gen->>DB: Prisma: create Article row (status = GENERATED)
    Gen-->>UI: SSE: article_generated

    Note over Gen,Queue: Auto-approve check (per-platform threshold)
    alt judge score ≥ per-platform threshold
        Gen->>Gen: Auto-approve for syndication platforms
        Gen->>Queue: enqueueSyndication(articleId, platform)<br/>(one job per target platform)
        Note over Queue: Platforms: Dev.to, Hashnode, LinkedIn,<br/>Medium, Substack + Telegram
    else HITL mode (score below threshold)
        Gen-->>UI: SSE: article_paused
        UI->>Operator: Show article for review
        Operator->>UI: Approve / Reject / Edit
        UI->>Gen: POST /articles/:id/approve
        Gen->>Queue: enqueueSyndication(articleId, platform)
    end

    Queue->>Worker: Process syndication job
    Worker->>DB: Re-check Article.status = APPROVED
    Worker->>BrowserAgent: act({ article, platform, goal: "publish article" })

    Note over BrowserAgent,Camoufox: LLM-in-the-loop interaction pattern
    loop LLM vision loop
        BrowserAgent->>Camoufox: Take screenshot of current page
        Camoufox-->>BrowserAgent: Screenshot image
        BrowserAgent->>LLM: Send screenshot + goal + history
        LLM->>Langfuse: Trace browser action
        LLM-->>BrowserAgent: Next action (click/type/scroll/wait/done)
        BrowserAgent->>Camoufox: Execute action (human-like typing)
    end

    Camoufox->>Platform: Submit article
    Platform-->>Camoufox: Article published
    BrowserAgent->>Camoufox: verify("is article published?")
    Camoufox->>Platform: Navigate to article URL
    Platform-->>Camoufox: Article visible
    Camoufox-->>BrowserAgent: Verified — POST_VERIFIED event

    BrowserAgent->>DB: Update SyndicationTarget.status = PUBLISHED, set platformUrl
    BrowserAgent->>SSE: Publish to Redis channel spa:sse
    SSE-->>UI: EventSource: article_published

    Note over BrowserAgent,PromoTrigger: POST_VERIFIED event chain
    BrowserAgent->>Canonical: verifyCanonical(article.canonicalUrl)
    Canonical->>Canonical: HTTP GET my-zodiac-ai.com/blog/{slug}
    Canonical-->>BrowserAgent: Canonical verified (200 OK)
    BrowserAgent->>DB: Update Article.canonicalVerified = true
    BrowserAgent->>SSE: SSE: canonical_verified

    BrowserAgent->>IndexNow: submitUrls([canonicalUrl])
    IndexNow->>IndexNow: POST https://api.indexnow.org/indexnow
    IndexNow-->>BrowserAgent: 200 OK (URL submitted)
    BrowserAgent->>SSE: SSE: indexnow_submitted

    BrowserAgent->>PromoTrigger: fire(article)
    PromoTrigger->>SocialGraph: generateSocialPromo(article)
    Note over SocialGraph: SocialGraph generates social posts<br/>promoting the article (with canonical link)
    SocialGraph->>LLM: research → hook → draft → judge → refine
    SocialGraph-->>PromoTrigger: Social posts ready
    PromoTrigger->>Queue: enqueuePosting(postId, network)<br/>(X, Threads, Facebook, Bluesky, Mastodon)
    PromoTrigger->>SSE: SSE: social_promo_triggered

    Note over Worker: Social posts go through their own<br/>judge/approve/publish flow (see posting-sequence.md)

    alt Syndication fails
        BrowserAgent->>Queue: Throw error
        Queue->>Queue: Retry (3-8 retries, exponential backoff 60s)
        alt All retries exhausted
            Queue->>SSE: SSE: article_failed
            Queue->>DB: Update SyndicationTarget.status = FAILED
            Note over Queue: DLQ → Discord webhook alert
        end
    end
```

## Key details

### Article generation
- **ArticleCron** (`modules/generation/article-cron.service.ts`) — triggers on `CRON_ARTICLE_SCHEDULE` (default daily)
- **GenerationService.generateArticle()** wraps `articleGraph.invoke()` with Langfuse callbacks via ALS
- Article graph: research → outline → draft → judge (5 criteria) → refine loop (max 3) → set_canonical → save_to_db
- Crash-resume via `RedisCheckpointSaver` (key: `article:runId:topic`)

### LLM-in-the-loop interaction pattern
- **BrowserAgentService.act()** is the core loop: screenshot → LLM vision → action → execute → repeat
- The LLM receives: current screenshot, goal ("publish this article on Dev.to"), action history
- The LLM returns: structured action (click selector, type text, scroll, wait, done)
- No hardcoded selectors — the LLM sees the page and adapts. This is why new platforms don't need selector maintenance.
- Human-like typing: `humanType()`, `humanClick()`, `randomDelay()` still applied to LLM-decided actions
- Langfuse traces every browser action (screenshot + LLM response) for debugging

### Auto-approve (per-platform thresholds)
- Each syndication platform has its own judge score threshold (`ARTICLE_JUDGE_MIN_SCORE_{PLATFORM}`)
- If article judge score ≥ threshold for a platform → auto-enqueue to that platform's BullMQ queue
- If below threshold → HITL: operator reviews in Vue dashboard, approves per-platform
- This allows partial syndication: article might auto-approve for Dev.to but need manual approval for LinkedIn

### POST_VERIFIED event chain
- After BrowserAgentService verifies the article is published → emits `POST_VERIFIED` event
- Chain: `POST_VERIFIED` → `CanonicalUrlService.verifyCanonical()` → `IndexNowService.submitUrls()` → `SocialPromoTrigger.fire()`
- Each step is idempotent — re-running won't double-submit or double-trigger

### Canonical URL verification
- `CanonicalUrlService.verifyCanonical(url)` — HTTP GET to `my-zodiac-ai.com/blog/{slug}`
- Confirms the canonical home of the article is live before notifying search engines
- Syndicated articles (Dev.to, Hashnode, etc.) include `<link rel="canonical" href="my-zodiac-ai.com/blog/{slug}">`

### IndexNow submission
- `IndexNowService.submitUrls([canonicalUrl])` — POST to `https://api.indexnow.org/indexnow`
- Notifies Bing + other participating search engines that the URL is new/updated
- Accelerates indexing — no waiting for organic crawl
- Batched: if multiple articles published in same window, URLs batched into one request

### Social promo trigger (article → social posts)
- `SocialPromoTrigger.fire(article)` → `SocialGraph.generateSocialPromo(article)`
- SocialGraph generates social posts (X, Threads, Facebook, Bluesky, Mastodon) promoting the article
- Each social post includes the canonical URL as a link
- Social posts go through their own judge/approve/publish flow (same as existing GenerationGraph)
- This creates the POSSE chain: article (canonical) → syndicated copies → social promo posts linking back

### SSE events
- `article_generated` — article graph completed, Article row created
- `article_published` — article published on a syndication platform
- `canonical_verified` — canonical URL confirmed live
- `indexnow_submitted` — URL submitted to IndexNow
- `social_promo_triggered` — social promo posts enqueued
- `article_rejected` — article failed quality gate (max retries, score below threshold)
- `article_failed` — syndication failed after all retries

### Error handling
- BullMQ retry: 3 retries (syndication: 8), exponential backoff (60s base)
- DLQ → Discord webhook alert
- Per-platform error isolation: Dev.to failure doesn't block Hashnode publish
- BrowserAgentService LLM failures: fallback to retry, then DLQ
