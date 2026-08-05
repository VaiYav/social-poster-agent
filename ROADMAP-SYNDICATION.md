# ROADMAP — Cross-Platform Content Syndication

> **Source of truth for the syndication feature.** Phases, gates, targets,
> tasks, and completion criteria. Inspired by Product Forge: phases → gate →
> next step.
>
> **Created:** 2026-08-05
> **ADR:** `docs/adr/ADR-007-cross-platform-syndication.md`
> **Feature spec:** `docs/features/cross-platform-syndication.md`
> **Status:** Planning

---

## Legend

| Mark | Meaning |
|------|---------|
| `[x]` | Completed, verified |
| `[~]` | In progress |
| `[ ]` | Not started |
| `GATE` | Checkpoint — cannot proceed without passing |
| `P0` | Critical blocker |
| `P1` | Important — fix before release |
| `P2` | Nice to have — can defer |

---

## Current status (snapshot)

```
Phase 0: Foundation          [░░░░░░░░░░░░░░░░░░░░]   0%  📋
Phase 1: MVP (Dev.to+Hash+LI)[░░░░░░░░░░░░░░░░░░░░]   0%  📋
Phase 2: Social expansion    [░░░░░░░░░░░░░░░░░░░░]   0%  📋
Phase 3: Browser platforms   [░░░░░░░░░░░░░░░░░░░░]   0%  📋
Phase 4: Participation       [░░░░░░░░░░░░░░░░░░░░]   0%  📋
Phase 5: Polish & backfill   [░░░░░░░░░░░░░░░░░░░░]   0%  📋
```

---

## Phase 0: Foundation (3-5 days)

> Set up the infrastructure for syndication: schema, ports, env, article graph skeleton.

### Tasks

- [ ] **P0-01: Prisma schema migration**
  - Add new `SocialNetwork` enum values (DEVTO, HASHNODE, LINKEDIN, BLUESKY,
    MASTODON, TELEGRAM, MEDIUM, SUBSTACK, REDDIT, QUORA, PINTEREST)
  - Add new `PostStatus` enum values (JUDGED, VERIFIED)
  - Add `canonicalUrl`, `syndicatedUrls`, `contentType`, `judgeScores`,
    `judgeRetried` fields to `Post` model
  - Run `pnpm prisma:migrate -- --name add-syndication-fields`
  - Update `packages/shared/src/types/enums.ts` to mirror new Prisma enums

- [ ] **P0-02: IApiPosterPort**
  - Create `packages/backend/src/domain/ports/api-poster.port.ts`
  - Define `IApiPosterPort` Symbol + interface
  - Define `ArticleContent`, `SocialPostContent`, `PublishResult` types in
    `packages/shared/src/types/syndication.ts`
  - Export from `packages/shared/src/index.ts`
  - Add to `packages/backend/src/domain/ports/index.ts`

- [ ] **P0-03: ContentType enum + SocialNetwork extension**
  - Add `ContentTypeSchema` to `packages/shared/src/types/enums.ts`
    (SOCIAL_POST, ARTICLE, ANSWER, PIN)
  - Extend `SocialNetworkSchema` with all new platforms
  - Update all switch statements that handle `SocialNetwork` (exhaustive check)

- [ ] **P0-04: CanonicalUrlService**
  - Create `packages/backend/src/modules/canonical/canonical-url.service.ts`
  - `buildBlogUrl(slug)`: `https://my-zodiac-ai.com/blog/{slug}`
  - `setCanonical(postId, url)`: update `Post.canonicalUrl`
  - `verifyCanonical(postUrl, expectedUrl)`: fetch post URL, check canonical
  - Create `CanonicalModule` + register in `AppModule`

- [ ] **P0-05: Article generation graph skeleton**
  - Create `packages/backend/src/modules/generation/article-graph.ts`
  - Define `ArticleGraphState` (Annotation.Root)
  - Stub nodes: `research_extract`, `outline`, `draft_article`,
    `judge_article`, `refine_article`, `set_canonical`, `save_to_db`
  - Wire StateGraph edges + conditional judge loop
  - Add `generateArticle()` method to `GenerationService`
  - Compile graph lazily (like existing social graph)

- [ ] **P0-06: Add article prompts to Langfuse**
  - Create 5 prompts in Langfuse: `article-research-extract`,
    `article-outline`, `article-draft`, `article-judge`, `article-refine`
  - Add inline fallbacks in `modules/generation/prompts/fallback-prompts.ts`
  - Run `npx tsx scripts/migrate-prompts-to-langfuse.ts` (or manual UI)
  - Add `toMustache()` conversions for new prompts

- [ ] **P0-07: Env vars + validation**
  - Add all new env vars to `.env.example`
  - Add validation in `env.validation.ts` (all optional, default empty/false)
  - Add `SYNDICATION_ENABLED` feature flag
  - Add per-platform `AUTO_APPROVE_MIN_SCORE_*` env vars
  - Add `CRON_ARTICLE_GENERATION_SCHEDULE` + `CRON_PARTICIPATION_SCHEDULE`

- [ ] **P0-08: Article generation cron**
  - Create `ArticleGenerationCron` service (dynamic registration like existing
    crons via `SchedulerRegistry.addCronJob` in `onModuleInit`)
  - Skip registration when `SYNDICATION_ENABLED=false`
  - Schedule: `CRON_ARTICLE_GENERATION_SCHEDULE` (default `0 9 * * 1`)

### GATE 0: Foundation ready

- [ ] Prisma migration applied, `pnpm test:unit` passes
- [ ] `IApiPosterPort` compiles, types exported from `@spa/shared`
- [ ] Article graph compiles (stub nodes), `generateArticle()` callable
- [ ] Langfuse prompts created, fallback prompts work offline
- [ ] `SYNDICATION_ENABLED=false` → no cron registration, no errors

---

## Phase 1: MVP — Dev.to + Hashnode + LinkedIn (1-2 weeks)

> First three API-based platforms. Article generation + judge + auto-approve +
> publish + canonical URL + IndexNow.

### Tasks

- [ ] **P1-01: Dev.to adapter** (`devto.poster.ts`)
  - Implement `IApiPosterPort`
  - `POST /api/articles` with `article: { title, body_markdown, canonical_url, tags, published: true }`
  - `verifyPublished(url)`: `GET /api/articles/{id}` → check `published_at`
  - Auth: `api-key: {DEVTO_API_KEY}` header
  - Create `DevtoModule` + bind `IApiPosterPort` to `DevtoPoster`
  - Register in `AppModule` when `SYNDICATION_ENABLED=true`

- [ ] **P1-02: Hashnode adapter** (`hashnode.poster.ts`)
  - Implement `IApiPosterPort`
  - GraphQL mutation `publishPublication` with `input: { title, contentMarkdown, canonicalUrl, tags, publicationId }`
  - `verifyPublished(url)`: fetch published post URL, check content
  - Auth: `Authorization: {HASHNODE_TOKEN}` header
  - Create `HashnodeModule` + bind `IApiPosterPort`

- [ ] **P1-03: LinkedIn adapter** (`linkedin.poster.ts`)
  - Implement `IApiPosterPort`
  - `POST /v2/posts` with `lifecycleState=MEMBER_SHARES`, `specificContent.shareCommentary.text`, `visibility=PUBLIC`
  - Article: share URL + title + summary (LinkedIn doesn't support long-form via API for personal pages)
  - `verifyPublished(url)`: `GET /v2/posts/{id}`
  - Auth: `Bearer {LINKEDIN_ACCESS_TOKEN}`
  - Create `LinkedInModule` + bind `IApiPosterPort`

- [ ] **P1-04: PostingService extension**
  - Extend `PostingService` to dispatch to API adapters (not just browser)
  - Check `contentType`: ARTICLE → use `IApiPosterPort`, SOCIAL_POST → existing
    browser flow
  - Route to correct adapter by `network` field
  - Error handling: API errors → BullMQ retry → DLQ

- [ ] **P1-05: Article graph — real implementation**
  - Implement `research_extract` node: use existing `ContentReader` + RAG
  - Implement `outline` node: LLM generates H2/H3 structure
  - Implement `draft_article` node: LLM writes full markdown article
  - Implement `judge_article` node: LLM evaluates 5 criteria
  - Implement `refine_article` node: LLM rewrites based on judge feedback
  - Implement `set_canonical` node: `CanonicalUrlService.buildBlogUrl(slug)`
  - Implement `save_to_db` node: persist to Prisma `Post` with `contentType=ARTICLE`

- [ ] **P1-06: Auto-approve per-platform thresholds**
  - Extend `AutoApproveService` to look up per-platform threshold:
    `AUTO_APPROVE_MIN_SCORE_{NETWORK}` env var, fallback to `AUTO_APPROVE_MIN_SCORE`
  - Judge score ≥ threshold → `Post.status = APPROVED` → enqueue to BullMQ
  - Judge score < threshold AND retries < 3 → refine loop
  - Judge score < threshold AND retries ≥ 3 → `Post.status = REJECTED`

- [ ] **P1-07: IndexNow service**
  - Create `packages/backend/src/modules/indexnow/indexnow.service.ts`
  - `submitUrls(urls: string[])`: POST to IndexNow API
  - Listen for `POST_VERIFIED` domain event → submit blog URL + syndicated URLs
  - Create `IndexNowModule` + register in `AppModule`

- [ ] **P1-08: BullMQ queues for new platforms**
  - Create queues: `spa-posting-devto`, `spa-posting-hashnode`, `spa-posting-linkedin`
  - Concurrency=1 (same as existing)
  - `jobId = postId` for idempotent dedup
  - DLQ → Discord alert (existing pattern)

- [ ] **P1-09: Rate limiter per-platform**
  - Extend `RateLimiterService` with per-platform daily/weekly limits
  - New env vars: `RATE_LIMIT_DAILY_DEVTO=3`, `RATE_LIMIT_DAILY_HASHNODE=3`, etc.
  - Redis sliding window (existing pattern)

- [ ] **P1-10: End-to-end test — Dev.to**
  - Generate article → judge → auto-approve → publish to Dev.to
  - Verify canonical URL is set in Dev.to article
  - Verify IndexNow submission
  - Test with `pnpm dry-run` first (intercept API call), then live

- [ ] **P1-11: SPA UI — syndication dashboard**
  - New view: `/syndication` — per-platform status, canonical URLs, judge scores
  - New column in posts table: `canonicalUrl`
  - New filter: `contentType` (ARTICLE vs SOCIAL_POST)
  - SSE events: `syndication:published`, `indexnow:submitted`

### GATE 1: MVP ready

- [ ] Article generated → judged → auto-approved → published to Dev.to with
      canonical URL (verified live)
- [ ] Same flow works for Hashnode + LinkedIn
- [ ] IndexNow submission verified (check Bing Webmaster Tools)
- [ ] `pnpm test:unit` passes, `pnpm test:integration` passes
- [ ] No account bans, no API errors in 48h of running

---

## Phase 2: Social expansion — Bluesky + Mastodon + Telegram (3-5 days)

> Add three more API-based platforms. Social promo trigger after article publish.

### Tasks

- [ ] **P2-01: Bluesky adapter** (`bluesky.poster.ts`)
  - AT Protocol: `com.atproto.repo.createRecord` with `bsky.post` record
  - Auth: app password (`BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`)
  - 300 char limit for posts, article share = link + hook
  - `verifyPublished(uri)`: `com.atproto.repo.getRecord`

- [ ] **P2-02: Mastodon adapter** (`mastodon.poster.ts`)
  - `POST /api/v1/statuses` with `status` text + URL
  - Auth: `Bearer {MASTODON_ACCESS_TOKEN}`, instance: `{MASTODON_INSTANCE}`
  - 500 char limit
  - `verifyPublished(id)`: `GET /api/v1/statuses/{id}`

- [ ] **P2-03: Telegram adapter** (`telegram.poster.ts`)
  - Bot API: `POST /bot{token}/sendMessage` to channel
  - Auth: `TELEGRAM_BOT_TOKEN`, channel: `TELEGRAM_CHANNEL_ID`
  - Markdown formatting (`parse_mode=MarkdownV2`)
  - `verifyPublished`: `getUpdates` or skip (Telegram has no post URL verification)

- [ ] **P2-04: Social promo trigger**
  - Listen for `POST_VERIFIED` domain event (article published)
  - Trigger existing social generation graph with article as content source
  - Generate platform-native social posts for LinkedIn, Bluesky, Mastodon,
    Telegram, X, Threads
  - Each social post goes through judge → auto-approve → publish flow
  - Social posts include canonical URL (link back to blog)

- [ ] **P2-05: End-to-end tests**
  - Test each platform: generate social post → judge → publish → verify
  - Test social promo trigger: article published → social posts generated +
    published automatically

### GATE 2: Social expansion ready

- [ ] Bluesky, Mastodon, Telegram all publishing successfully
- [ ] Social promo trigger fires on article publish
- [ ] All social posts include canonical URL
- [ ] No rate limit hits in 48h

---

## Phase 3: Browser platforms — Medium + Substack (1-2 weeks)

> Camoufox-based posting for API-less platforms. Persistent context (like Facebook).

### Tasks

- [ ] **P3-01: Medium poster** (`medium.poster.ts`)
  - Persistent Camoufox context (like `facebook.poster.ts`)
  - Login flow: navigate to `medium.com`, check session, login if needed
  - New story: navigate to `medium.com/new-story`
  - Editor: Lexical editor — paste title, paste body (markdown → rich text)
  - Canonical URL: story settings → "canonical URL" field
  - Publish: click "Publish" button, confirm
  - Verify: navigate to published URL, check content + canonical
  - Session warm-up: browse feed before posting (existing pattern)

- [ ] **P3-02: Substack poster** (`substack.poster.ts`)
  - Persistent Camoufox context
  - Login flow: navigate to `substack.com`, check session
  - New post: navigate to `{publication}.substack.com/publish`
  - Editor: paste title, paste body
  - Canonical URL: post settings → "canonical URL" field
  - Publish: click "Publish" button
  - Verify: navigate to published URL

- [ ] **P3-03: Account model for browser platforms**
  - Create `SocialAccount` records for Medium, Substack
  - Store `credentials_ref` (env var name, not secret) — existing pattern
  - Session management: `BrowsingSessionService` (existing, feature-flagged)

- [ ] **P3-04: Selector strategy + health**
  - Add Medium/Substack selectors to `selectors/` directory
  - Selector fallback chain: `data-testid → role → label → CSS → text`
  - Drift detector: `SelectorHealthService` (existing) monitors selector health
  - Add to `selector-health.service.ts` periodic check

- [ ] **P3-05: End-to-end tests**
  - `pnpm dry-run` for Medium: open browser, navigate, type, intercept publish
  - `pnpm dry-run` for Substack: same
  - Live test (manual): publish one real article to Medium with canonical URL

### GATE 3: Browser platforms ready

- [ ] Medium: article published with canonical URL (verified live)
- [ ] Substack: article published with canonical URL (verified live)
- [ ] No bans in 48h
- [ ] Session persistence works (no re-login needed between posts)

---

## Phase 4: Participation — Reddit + Quora + Pinterest (1-2 weeks)

> Agent participation mode. Different workflow from article syndication.

### Tasks

- [ ] **P4-01: Participation module skeleton**
  - Create `packages/backend/src/modules/participation/`
  - `ParticipationModule` + register in `AppModule` when `SYNDICATION_ENABLED=true`
  - `ParticipationService` — orchestrator
  - `ParticipationCron` — dynamic registration, `CRON_PARTICIPATION_SCHEDULE`

- [ ] **P4-02: Question finder** (`question-finder.service.ts`)
  - Reddit: search `r/astrology`, `r/AskAstrologers`, `r/advancedastrology`
    via Camoufox browse (Reddit search) or Reddit API (search endpoint)
  - Quora: search astrology topics via Camoufox browse
  - Filter: LLM judges if question is relevant to our niche
  - Dedup: don't answer the same question twice (Prisma `Post` with
    `contentType=ANSWER` + `sourceRef` pointing to question URL)

- [ ] **P4-03: Answer drafter** (`answer-drafter.service.ts`)
  - LLM writes value-first answer:
    - Genuinely helpful (answer the question)
    - Reference relevant blog post only if natural
    - No hard sell, no promotional language
  - New Langfuse prompt: `participation-answer-draft`
  - Add inline fallback in `fallback-prompts.ts`

- [ ] **P4-04: Answer judge** (`answer-judge.service.ts`)
  - LLM-as-a-Judge evaluates:
    - `helpfulness` — does it answer the question?
    - `promotional_tone` — is it overly promotional? (must be < 0.3)
    - `factual_accuracy` — are astrology facts correct?
    - `anti_ai_tone` — does it sound human?
  - New Langfuse prompt: `participation-answer-judge`
  - Threshold: `AUTO_APPROVE_MIN_SCORE_REDDIT=9` (strictest)

- [ ] **P4-05: Reddit agent** (`reddit.agent.ts`)
  - Camoufox persistent context
  - Navigate to question thread
  - Post answer via comment editor (Markdown)
  - Verify: check comment is visible
  - Track engagement: upvotes, replies (existing `engagement` module)

- [ ] **P4-06: Quora agent** (`quora.agent.ts`)
  - Camoufox persistent context
  - Navigate to question
  - Post answer via answer editor (Rich text)
  - Verify: check answer is visible
  - Track engagement: upvotes, views

- [ ] **P4-07: Pinterest adapter** (`pinterest.poster.ts`)
  - Generate pin image from article cover (fal.ai FLUX or template)
  - Pinterest Business API: `POST /v5/pins` with image, title, description, link
  - Or Camoufox browser: navigate to `pinterest.com/pin-builder/`
  - `verifyPublished(id)`: `GET /v5/pins/{id}`

- [ ] **P4-08: Engagement feedback loop**
  - Track which Reddit/Quora answers get high engagement
  - Feed back into topic selection (high-engagement topics → more articles)
  - Store engagement metrics in `PostMetrics` (existing model)

### GATE 4: Participation ready

- [ ] Reddit: 2-3 answers posted, no bans, some upvotes
- [ ] Quora: 2-3 answers posted, no bans
- [ ] Pinterest: pins created from article covers
- [ ] Judge `promotional_tone` criterion working (no overly promotional answers)
- [ ] Engagement tracking works

---

## Phase 5: Polish & backfill (ongoing)

> Production hardening, monitoring, backfill existing content.

### Tasks

- [ ] **P5-01: SPA UI — full syndication dashboard**
  - Per-platform status cards (published count, judge score avg, ban status)
  - Canonical URL column in posts table
  - Judge score distribution chart (Langfuse integration)
  - Participation feed (Reddit/Quora answers with engagement)
  - IndexNow submission log

- [ ] **P5-02: Judge calibration**
  - Track judge scores vs actual outcomes (engagement, clicks)
  - Langfuse: compare judge scores across prompt versions
  - Adjust per-platform thresholds based on false-positive/negative rates
  - Target: auto-approve rate 60-90%, false-positive rate <5%

- [ ] **P5-03: Metrics & alerting**
  - Per-platform publish rate (daily/weekly)
  - Judge score distribution (histogram)
  - Account ban rate
  - LLM cost per article (token usage × provider cost)
  - Backlinks earned (from GSC, quarterly check)
  - Alert: auto-approve rate outside 50-95% → threshold needs adjustment

- [ ] **P5-04: Backfill existing blog posts**
  - Script: scan `astro-ai-landing/content/blog/**` for published posts
  - For each: generate social promo → judge → publish to all platforms
  - Batch: 5-10 per day (rate limiter controls)
  - Dedup: SimHash prevents re-syndicating near-duplicates
  - Estimated: 39K articles → ~2 years at 50/day (or batch higher with rate
    limit adjustments)

- [ ] **P5-05: Content calendar**
  - Cron schedule for article generation (weekly)
  - Topic rotation: product updates, astrology events, evergreen content
  - Seasonal content: eclipses, retrogrades, year-ahead guides
  - Integration with `content-agent-platform` briefs

- [ ] **P5-06: A/B testing**
  - Test judge threshold per platform (A: threshold=7, B: threshold=8)
  - Test article prompts (A: current, B: variant)
  - Test social promo hooks (existing `ab_variant` node)
  - Measure: engagement rate, click-through rate, judge score correlation

- [ ] **P5-07: Documentation**
  - Update `CLAUDE.md` with syndication architecture
  - Update `CONSTITUTION.md` with syndication scope
  - Update `README.md` with syndication quick start
  - Runbook: "Syndication platform banned" recovery
  - Runbook: "Judge threshold calibration" procedure

---

## Success metrics (90 days after Phase 1)

| Metric | Target |
|--------|--------|
| Articles syndicated per month | 8-12 (2-3 per week) |
| Platforms active | 8+ (Dev.to, Hashnode, LinkedIn, Bluesky, Mastodon, Telegram, Medium, Substack) |
| Reddit/Quora answers per month | 8-12 (2-3 per week) |
| Judge auto-approve rate | 60-90% |
| Judge false-positive rate | <5% (verified by sampling) |
| Account bans | 0 |
| Backlinks earned (from syndication) | 20+ (measured via GSC) |
| IndexNow submissions | 100% of new URLs |
| LLM cost per article | <$0.50 (free-first router) |

---

## Dependencies

| Dependency | Required for | Status |
|------------|--------------|--------|
| Dev.to API key | Phase 1 | Pending — get at dev.to/settings/extensions |
| Hashnode token | Phase 1 | Pending — get at hashnode.com/settings/developer |
| LinkedIn access token | Phase 1 | Pending — create app at developers.linkedin.com |
| Bluesky account | Phase 2 | Pending — create at bsky.app |
| Mastodon account | Phase 2 | Pending — create on mastodon.social |
| Telegram bot + channel | Phase 2 | Pending — create via @BotFather |
| Medium account | Phase 3 | Pending — existing or new account |
| Substack publication | Phase 3 | Pending — create at substack.com |
| Reddit account | Phase 4 | Pending — existing or new, aged account preferred |
| Quora account | Phase 4 | Pending — existing or new |
| Pinterest Business account | Phase 4 | Pending — create at business.pinterest.com |
| IndexNow key | Phase 1 | Existing — `INDEXNOW_KEY` in astro-ai-landing |

---

## References

- ADR-007: `docs/adr/ADR-007-cross-platform-syndication.md`
- Feature spec: `docs/features/cross-platform-syndication.md`
- Rule (astro-ai-landing): `.devin/rules/content-syndication.md`
- Loop spec (astro-ai-landing): `.devin/plans/syndication-loop.md`
- Architecture (astro-ai-landing): `.devin/plans/cross-platform-syndication-system.md`
- SPA CLAUDE.md: `CLAUDE.md`
- SPA CONSTITUTION.md: `CONSTITUTION.md`
- SPA ROADMAP (original): `ROADMAP.md`
