# ROADMAP — Cross-Platform Content Syndication

> **Source of truth for the syndication feature.** Phases, gates, targets,
> tasks, and completion criteria. Inspired by Product Forge: phases → gate →
> next step.
>
> **Created:** 2026-08-05
> **Last updated:** 2026-08-05 — two architecture decisions: (1) all platforms via
> Camoufox browser automation (except Telegram Bot API), (2) LLM-in-the-loop
> vision-based interaction (no hardcoded selectors). See "Architecture decisions" below.
> **ADR:** `docs/adr/ADR-007-cross-platform-syndication.md`
> **Feature spec:** `docs/features/cross-platform-syndication.md`
> **Status:** Planning

---

## Architecture decision (2026-08-05): Camoufox-first

**All platforms connect via Camoufox browser automation**, not API. The only
exception is **Telegram** (Bot API — 100% free, no approval, instant setup).

### Why Camoufox-first

| Platform | API status | Why not API |
|----------|-----------|-------------|
| Dev.to | Free API key | API works, but Camoufox unifies the architecture — one posting path, one queue pattern, one judge flow. No separate `IApiPosterPort` needed |
| Hashnode | Free GraphQL token | Same — API works but adds a second posting path for no benefit |
| LinkedIn | OAuth + app review | **API requires app review (weeks)** for `w_member_social` scope. Personal API doesn't support long-form. Camoufox works immediately |
| Bluesky | Free AT Protocol | API works, but Camoufox unifies. Bluesky web UI is stable |
| Mastodon | Free REST API | API works, but Camoufox unifies. Web UI is standard across instances |
| Medium | **API deprecated 2023** | No API. Integration token is limited and unreliable. Camoufox only |
| Substack | **No API at all** | No API. Cookie hack (Pipepost) is fragile. Camoufox only |
| Reddit | **Paid API ($100/mo)** | Free tier too limited for posting. Camoufox only |
| Quora | **No API for answers** | No API. Camoufox only |
| Pinterest | Business API + approval | Requires approval + business account. Camoufox only |
| Telegram | **Bot API — free, no approval** | Bot API is the right tool for channels. Web Telegram is too fragile. **Only API exception** |

### What this changes

- **No `IApiPosterPort`** — all posting goes through the existing `IBrowserPort`
  + `BrowserFactory` persistent context pattern (same as Facebook).
- **No per-platform API adapters** — one `BasePoster` pattern, per-platform
  subclasses with selectors + login flows.
- **No API keys in `.env`** — only account credentials (email/password or
  session cookies) stored as `credentials_ref` (env var name, not secret).
- **Telegram** — single `TelegramBotAdapter` using Bot API (`TELEGRAM_BOT_TOKEN`
  + `TELEGRAM_CHANNEL_ID`). Not Camoufox.
- **PostingService** — dispatches by `network`: TELEGRAM → Bot API, everything
  else → `BrowserFactory.createContext()` → poster subclass.

### Camoufox capabilities used (verified against current docs via Context7)

- **`user_data_dir`** — persistent context, fingerprint + cookies on disk
  (existing pattern from `facebook.poster.ts`). All 10 Camoufox platforms use this.
- **`firefox_user_prefs`** — memory optimization (already in `browser.factory.ts`).
- **`humanize`** — cursor movement, typing cadence (anti-detect).
- **`fingerprint_preset=True`** — real fingerprint bundles (312 presets for
  Firefox ≥149, 123 for older). Recommended in current docs.
- **`geoip`** — auto-detect timezone from proxy IP.
- **`addInitScript`** — per-context fingerprint patches (timezone, canvas, WebGL).
- **`launchServer`** — WebSocket server for remote Camoufox (future: scale-out).

---

## Architecture decision (2026-08-05): LLM-in-the-loop vision-based interaction

**No hardcoded CSS selectors.** All browser interaction is resolved by an LLM
at runtime — "click the Publish button", "find the canonical URL field", "is
this the article editor?". This eliminates selector drift entirely.

### Why LLM-in-the-loop

The traditional browser automation approach (Playwright/Selenium + hardcoded
selectors) breaks every time a platform changes its DOM. With 10+ platforms,
this is constant maintenance. LLM-in-the-loop solves this:

- **Zero selector maintenance** — LLM sees the page (screenshot + DOM) and
  resolves instructions at runtime. Page redesigns don't break anything.
- **Universal** — same approach works on any platform, including ones we've
  never seen before (Quora, Substack editor).
- **Anti-detect synergy** — Camoufox provides stealth, LLM provides
  human-like interaction patterns. No machine-readable selector fingerprints.
- **Cost ~$0** — SPA's free-first 8-provider LLM router (with 5-min cache
  and circuit breaker) makes per-step LLM calls effectively free.

### Reference implementations (verified, production-ready)

| Tool | Stars | Stack | Pattern |
|------|-------|-------|---------|
| **browser-use** | 107K | Python, Playwright + LLM vision | `observe → think → act` loop. Screenshot → LLM decides next action. Model-agnostic (OpenAI, Anthropic, Ollama). MCP support. |
| **Stagehand** | — | TypeScript + Python | 4 primitives: `act("click submit")`, `extract`, `observe`, `agent`. AI resolves at runtime. "Instructions survive page redesigns." |
| **Skyvern** | — | Python, Playwright + Vision LLMs | `page.click(prompt="Click login button")` instead of `page.click("#btn")`. "Resistant to website layout changes." |
| **AgentQL** | — | Python/TypeScript | AI query language. Natural language selectors. Self-healing. "Same query works after site updates." |

**Key quotes:**
- Stagehand: *"Instructions like 'click the submit button' survive page redesigns because they're resolved by AI at runtime, not hardcoded into your test suite."*
- Skyvern: *"Skyvern is resistant to website layout changes, as there are no pre-determined XPaths or other selectors our system is looking for."*

### What this changes

- **No `selectors/` directory per platform** — no `devto.selectors.ts`,
  `hashnode.selectors.ts`, etc. All interaction is LLM-resolved.
- **No `SelectorHealthService` drift detector for new platforms** — not needed.
  LLM adapts at runtime.
- **Poster classes use natural language instructions** — instead of:
  ```typescript
  await page.click('[data-testid="publish-button"]');
  ```
  Posters use:
  ```typescript
  await browserAgent.act('Click the "Publish" button to publish the article');
  ```
- **Existing X/Threads/Facebook posters** — keep current selector chain for now
  (it works, don't break it). Migrate to LLM-in-the-loop in Phase 5 as a
  separate task (P5-X).
- **`IBrowserPort` extension** — add `act(instruction)`, `extract(schema)`,
  `observe()`, `verify(stateDescription)` methods. These wrap the LLM-in-the-loop
  engine. Underlying implementation: Camoufox page + LLM vision call.

### Trade-offs (acknowledged)

| Parameter | Selector-based | LLM-in-the-loop |
|-----------|---------------|-----------------|
| Maintenance | High (drift) | **Zero** |
| Speed | 5-10 sec/post | 30-90 sec/post (LLM thinking) |
| Cost | $0 | ~$0 (free-first router + cache) |
| Reliability | 95% (when selectors work) | 85-90% (LLM can misread) |
| Determinism | Yes | No (LLM stochastic) |

**Mitigations:**
- Speed: BullMQ queue, concurrency=1, no real-time requirement. 30-90 sec is fine.
- Cost: free-first router (Groq → OpenRouter → DeepSeek → Cerebras → OpenAI →
  Google → NVIDIA → Ollama). 5-min SHA256 cache. Circuit breaker per provider.
- Reliability: retry on LLM misread (BullMQ retry). Fallback to selector-based
  for critical paths (login flow) where determinism matters.
- Determinism: seed LLM temperature=0 for vision tasks where possible.

### Implementation plan

1. **Phase 0** — add `IBrowserPort` methods: `act()`, `extract()`, `observe()`,
   `verify()`. Stub implementation (returns "not implemented"). No LLM calls yet.
2. **Phase 1** — implement LLM-in-the-loop engine. Integrate with existing
   `LlmService` (free-first router). All new platform posters use it from day one.
3. **Phase 5** — migrate existing X/Threads/Facebook posters from selector chain
   to LLM-in-the-loop. Separate task, don't break working code.

### Competitive advantage

This combination does not exist in any product on the market:

| Competitor | Approach | Selector drift? | Anti-detect? |
|-----------|----------|-----------------|--------------|
| Article Distribution | API + Chrome extension | Yes (extension) | No |
| Postiz | OAuth API | No (but limited platforms) | No |
| Pipepost | API + cookie hack | Yes (cookie hack breaks) | No |
| SocialFlow | Playwright Chromium + selectors | **Yes** | No (Chromium detectable) |
| **SPA (this plan)** | **Camoufox + LLM-in-the-loop** | **No** | **Yes** |

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

> Set up the infrastructure for syndication: schema, canonical URL, article
> graph skeleton, env vars. **No `IApiPosterPort`** — all posting extends the
> existing `IBrowserPort` + `BrowserFactory` persistent context pattern.

### Tasks

- [ ] **P0-01: Prisma schema migration**
  - Add new `SocialNetwork` enum values (DEVTO, HASHNODE, LINKEDIN, BLUESKY,
    MASTODON, TELEGRAM, MEDIUM, SUBSTACK, REDDIT, QUORA, PINTEREST)
  - Add new `PostStatus` enum values (JUDGED, VERIFIED)
  - Add `canonicalUrl`, `syndicatedUrls`, `contentType`, `judgeScores`,
    `judgeRetried` fields to `Post` model
  - Run `pnpm prisma:migrate -- --name add-syndication-fields`
  - Update `packages/shared/src/types/enums.ts` to mirror new Prisma enums

- [ ] **P0-02: Extend IBrowserPort with LLM-in-the-loop methods**
  - Extend `IBrowserPort` (`domain/ports/browser.port.ts`) with vision-based
    interaction methods (LLM-in-the-loop, no hardcoded selectors):
    - `act(instruction: string)` — "Click the Publish button", "Find the canonical URL field and type X"
    - `extract(schema: ZodSchema)` — extract structured data from page via LLM vision
    - `observe()` — return list of actionable elements on page (LLM-resolved)
    - `verify(stateDescription: string)` — "Is the article published? yes/no"
  - Stub implementation in Phase 0 (returns "not implemented"). Real LLM engine
    implemented in Phase 1 (P1-00).
  - No new port — reuse existing `IBrowserPort`. All 10 Camoufox platforms go
    through `BrowserFactory.createContext()` / `getOrCreatePersistentContext()`.
  - Define `ArticleContent`, `SocialPostContent`, `PublishResult` types in
    `packages/shared/src/types/syndication.ts`
  - Export from `packages/shared/src/index.ts`
  - **No `selectors/` directory per platform** — all interaction is LLM-resolved
    (see "Architecture decision: LLM-in-the-loop")

- [ ] **P0-03: ContentType enum + SocialNetwork extension**
  - Add `ContentTypeSchema` to `packages/shared/src/types/enums.ts`
    (SOCIAL_POST, ARTICLE, ANSWER, PIN)
  - Extend `SocialNetworkSchema` with all new platforms
  - Update all switch statements that handle `SocialNetwork` (exhaustive check)
  - Update `BrowserFactory.getOrCreatePersistentContext()` — all new networks
    use persistent context (like Facebook), not pooled (like X/Threads)

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
  - **No API keys** — only `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHANNEL_ID`
  - Account credentials: `DEVTO_EMAIL`/`DEVTO_PASSWORD`, `HASHNODE_EMAIL`/
    `HASHNODE_PASSWORD`, etc. (stored as `credentials_ref` env var names, not
    secrets in DB)

- [ ] **P0-08: Article generation cron**
  - Create `ArticleGenerationCron` service (dynamic registration like existing
    crons via `SchedulerRegistry.addCronJob` in `onModuleInit`)
  - Skip registration when `SYNDICATION_ENABLED=false`
  - Schedule: `CRON_ARTICLE_GENERATION_SCHEDULE` (default `0 9 * * 1`)

### GATE 0: Foundation ready

- [ ] Prisma migration applied, `pnpm test:unit` passes
- [ ] `IBrowserPort` extended, types exported from `@spa/shared`
- [ ] Article graph compiles (stub nodes), `generateArticle()` callable
- [ ] Langfuse prompts created, fallback prompts work offline
- [ ] `SYNDICATION_ENABLED=false` → no cron registration, no errors

---

## Phase 1: MVP — Dev.to + Hashnode + LinkedIn (1-2 weeks)

> First three platforms. **All via Camoufox persistent context** (same pattern
> as `facebook.poster.ts`). Article generation + judge + auto-approve + publish
> + canonical URL + IndexNow.

### Tasks

- [ ] **P1-00: LLM-in-the-loop browser engine** (`browser-agent.service.ts`)
  - Implement the LLM vision-based interaction engine that powers `IBrowserPort`
    methods (`act`, `extract`, `observe`, `verify`) stubbed in P0-02.
  - **Pattern:** browser-use / Stagehand / Skyvern approach — screenshot + DOM
    context → LLM decides next action. No hardcoded selectors.
  - Integrate with existing `LlmService` (free-first 8-provider router, 5-min
    cache, circuit breaker). Vision calls go through the same router.
  - `act(instruction)`: screenshot page → LLM identifies element → click/type/scroll
  - `extract(schema)`: screenshot + DOM → LLM returns structured data (Zod-validated)
  - `observe()`: return actionable elements (LLM-resolved, not CSS-parsed)
  - `verify(stateDescription)`: screenshot → LLM returns boolean ("is article published?")
  - **Retry on LLM misread:** BullMQ retry handles transient failures. Critical
    paths (login) can fall back to selector-based as safety net.
  - **Cost control:** temperature=0 for vision tasks, 5-min cache on identical
    screenshots, circuit breaker per provider.
  - Reference: `github.com/browser-use/browser-use` (107K stars, Python),
    `stagehand.dev` (TypeScript), `github.com/skyvern-ai/skyvern`

- [ ] **P1-01: Dev.to poster** (`devto.poster.ts`)
  - Extend `BasePoster` (or create new base for article posters)
  - Persistent Camoufox context (like Facebook)
  - **LLM-in-the-loop** for all interactions (no hardcoded selectors):
    - Login: `act("log in with email and password")` if session expired
    - New article: `act("navigate to new article editor")`
    - Type title: `act("type the article title in the title field")`
    - Type body: `act("paste the article body in the editor")`
    - Canonical URL: `act("find the canonical URL field in settings and type X")`
    - Publish: `act("click the Publish button")`
    - Verify: `verify("is the article published with canonical URL set?")`
  - Session warm-up: browse feed before posting (existing pattern)

- [ ] **P1-02: Hashnode poster** (`hashnode.poster.ts`)
  - Persistent Camoufox context
  - **LLM-in-the-loop** for all interactions (same pattern as P1-01):
    - Login: `act("log in to Hashnode")` if session expired
    - New draft: `act("navigate to new draft editor")`
    - Type title + body: `act("type the article title/body")`
    - Canonical URL: `act("find canonical URL field in draft settings and type X")`
    - Publish: `act("click the Publish button")`
    - Verify: `verify("is the article published on Hashnode?")`

- [ ] **P1-03: LinkedIn poster** (`linkedin.poster.ts`)
  - Persistent Camoufox context
  - **LLM-in-the-loop** for all interactions:
    - Login: `act("log in to LinkedIn with email and password")` if session expired
    - **LinkedIn doesn't support long-form articles via UI anymore** — post as
      a feed update with article link + summary (link share)
    - Navigate to feed: `act("go to the LinkedIn feed")`
    - Compose: `act("click Start a post and type the article summary and canonical URL")`
    - Publish: `act("click the Post button")`
    - Verify: `verify("is the LinkedIn post visible on my profile?")`
  - **No OAuth, no app review** — Camoufox bypasses the API entirely

- [ ] **P1-04: PostingService extension**
  - Extend `PostingService` to dispatch to new platform posters
  - All new networks → `BrowserFactory.createContext()` → poster subclass
  - TELEGRAM → `TelegramBotAdapter` (Bot API, Phase 2)
  - Error handling: browser errors → BullMQ retry → DLQ

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
  - Test with `pnpm dry-run` first (intercept publish click), then live

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
- [ ] No account bans, no browser errors in 48h of running

---

## Phase 2: Social expansion — Bluesky + Mastodon + Telegram (3-5 days)

> Three more platforms. Bluesky + Mastodon via Camoufox. **Telegram via Bot API**
> (the only API exception — Bot API is free, stable, and the right tool for channels).

### Tasks

- [ ] **P2-01: Bluesky poster** (`bluesky.poster.ts`)
  - Persistent Camoufox context
  - Login flow: navigate to `bsky.app`, check session, login with handle + app password
  - New post: use composer, paste text + canonical URL (300 char limit)
  - Publish: click "Post" button
  - Verify: navigate to profile, check post is visible

- [ ] **P2-02: Mastodon poster** (`mastodon.poster.ts`)
  - Persistent Camoufox context
  - Login flow: navigate to `{MASTODON_INSTANCE}`, check session
  - New post: use composer, paste text + canonical URL (500 char limit)
  - Publish: click "Toot"/"Publish" button
  - Verify: navigate to profile, check post is visible

- [ ] **P2-03: Telegram adapter** (`telegram.adapter.ts`) — **Bot API**
  - **Only API-based platform** — Bot API is free, no approval, instant setup
  - Bot API: `POST /bot{TELEGRAM_BOT_TOKEN}/sendMessage` to channel
  - Auth: `TELEGRAM_BOT_TOKEN`, channel: `TELEGRAM_CHANNEL_ID`
  - Markdown formatting (`parse_mode=MarkdownV2`)
  - `verifyPublished`: `getUpdates` or skip (Telegram has no post URL verification)
  - **Not Camoufox** — Telegram Web is too fragile, Bot API is the right tool

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
> These were always Camoufox — no architecture change here.

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
> All three via Camoufox — no APIs (Reddit API is paid, Quora has no API,
> Pinterest requires business approval).

### Tasks

- [ ] **P4-01: Participation module skeleton**
  - Create `packages/backend/src/modules/participation/`
  - `ParticipationModule` + register in `AppModule` when `SYNDICATION_ENABLED=true`
  - `ParticipationService` — orchestrator
  - `ParticipationCron` — dynamic registration, `CRON_PARTICIPATION_SCHEDULE`

- [ ] **P4-02: Question finder** (`question-finder.service.ts`)
  - Reddit: search `r/astrology`, `r/AskAstrologers`, `r/advancedastrology`
    via Camoufox browse (Reddit search)
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

- [ ] **P4-07: Pinterest poster** (`pinterest.poster.ts`)
  - Camoufox persistent context
  - Generate pin image from article cover (fal.ai FLUX or template)
  - Navigate to `pinterest.com/pin-builder/`
  - Upload image, set title, description, link (canonical URL)
  - Publish: click "Publish" button
  - Verify: navigate to pin URL

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

- [ ] **P5-08: Migrate existing X/Threads/Facebook posters to LLM-in-the-loop**
  - Replace hardcoded selector chain (`data-testid → role → label → CSS → text`)
    in existing X/Threads/Facebook posters with LLM-in-the-loop `act()`/`verify()` calls
  - Keep selector chain as fallback safety net for login flows (determinism matters)
  - Remove `SelectorHealthService` drift detector (no longer needed — LLM adapts
    at runtime). Or repurpose it to track LLM vision accuracy instead.
  - **Don't break working code** — migrate one poster at a time, verify with
    `pnpm dry-run` before moving to the next
  - Order: Facebook (persistent context, simplest) → Threads → X (most complex)
  - Benefit: zero selector maintenance on existing platforms too

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

> **No API keys needed** (except Telegram Bot API). All platforms use Camoufox
> browser automation with account credentials (email/password). Credentials are
> stored as `credentials_ref` (env var *name*) in DB, actual values in `.env`.

| Dependency | Required for | Status | How to get |
|------------|--------------|--------|------------|
| Dev.to account | Phase 1 | Pending — create at dev.to | Register, verify email |
| Hashnode account | Phase 1 | Pending — create at hashnode.com | Register, verify email |
| LinkedIn account | Phase 1 | Pending — existing or new | Register, verify email |
| Bluesky account | Phase 2 | Pending — create at bsky.app | Register (invite code may be needed) |
| Mastodon account | Phase 2 | Pending — create on mastodon.social | Register, verify email |
| Telegram bot + channel | Phase 2 | Pending — create via @BotFather | `/newbot` → get token → create channel → add bot as admin |
| Medium account | Phase 3 | Pending — existing or new | Register, verify email |
| Substack publication | Phase 3 | Pending — create at substack.com | Register → create publication |
| Reddit account (aged) | Phase 4 | Pending — existing or new, aged account preferred | Register, build karma first |
| Quora account | Phase 4 | Pending — existing or new | Register, verify email |
| Pinterest account | Phase 4 | Pending — create at pinterest.com | Register (business account optional) |
| IndexNow key | Phase 1 | Existing — `INDEXNOW_KEY` in astro-ai-landing | Already configured |

### Env vars (`.env`)

```bash
# Feature flag
SYNDICATION_ENABLED=false

# Telegram (only API-based platform)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=

# Account credentials (email/password for Camoufox login)
# Stored as credentials_ref in DB — these are the actual values
DEVTO_EMAIL=
DEVTO_PASSWORD=
HASHNODE_EMAIL=
HASHNODE_PASSWORD=
LINKEDIN_EMAIL=
LINKEDIN_PASSWORD=
BLUESKY_HANDLE=
BLUESKY_APP_PASSWORD=
MASTODON_INSTANCE=mastodon.social
MASTODON_EMAIL=
MASTODON_PASSWORD=
MEDIUM_EMAIL=
MEDIUM_PASSWORD=
SUBSTACK_PUBLICATION=            # e.g. "my-zodiac-ai"
SUBSTACK_EMAIL=
SUBSTACK_PASSWORD=
REDDIT_USERNAME=
REDDIT_PASSWORD=
QUORA_EMAIL=
QUORA_PASSWORD=
PINTEREST_EMAIL=
PINTEREST_PASSWORD=

# Auto-approve thresholds (per-platform)
AUTO_APPROVE_MIN_SCORE_DEVTO=7
AUTO_APPROVE_MIN_SCORE_HASHNODE=7
AUTO_APPROVE_MIN_SCORE_LINKEDIN=7
AUTO_APPROVE_MIN_SCORE_REDDIT=9   # strictest — Reddit bans for self-promo

# Cron schedules
CRON_ARTICLE_GENERATION_SCHEDULE=0 9 * * 1   # weekly Monday 9am
CRON_PARTICIPATION_SCHEDULE=0 10 * * *        # daily 10am

# Rate limits (per-platform daily)
RATE_LIMIT_DAILY_DEVTO=3
RATE_LIMIT_DAILY_HASHNODE=3
RATE_LIMIT_DAILY_LINKEDIN=2
RATE_LIMIT_DAILY_BLUESKY=5
RATE_LIMIT_DAILY_MASTODON=5
RATE_LIMIT_DAILY_TELEGRAM=10
RATE_LIMIT_DAILY_MEDIUM=2
RATE_LIMIT_DAILY_SUBSTACK=2
RATE_LIMIT_DAILY_REDDIT=2
RATE_LIMIT_DAILY_QUORA=2
RATE_LIMIT_DAILY_PINTEREST=3
```

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
- Camoufox docs (Context7, fetched 2026-08-05): `/daijro/camoufox`, `/apify/camoufox-js`
- Pipepost (reference only, not a dependency): `github.com/MendleM/Pipepost`
