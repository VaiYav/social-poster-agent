# Handoff — Cross-Platform Content Syndication

> **Date:** 2026-08-05 (updated)
> **From:** Devin session (Phase 0 + Phase 1 MVP complete)
> **To:** Next Devin session — Phase 2 social platforms
> **Status:** Phase 0 + Phase 1 MVP complete (20 issues closed, commit `ca38098`)
> **Git:** `main` branch, ahead of origin by 2 commits

---

## 1. What's done (don't redo)

### Phase 0 — 12 issues closed (#3-#10, #47, #49, #51, #53)

- **Prisma schema**: 11 new `SocialNetwork` enum values (DEVTO, HASHNODE, LINKEDIN, BLUESKY, MASTODON, TELEGRAM, MEDIUM, SUBSTACK, REDDIT, QUORA, PINTEREST), `ContentType` enum, new Post fields (`canonicalUrl`, `syndicatedUrls`, `contentType`, `judgeScores`, `judgeRetried`)
- **IBrowserPort**: extended with `act()`, `extract()`, `observe()`, `verify()` methods
- **BrowserFactory**: 10 new persistent Camoufox contexts (`PERSISTENT_NETWORKS` Set)
- **CanonicalUrlService** (`src/modules/canonical/canonical-url.service.ts`): POSSE canonical URL management — `buildBlogUrl()`, `slugify()`, `setCanonical()`, `addSyndicatedUrl()`, `verifyCanonical()`. Handles empty slug fallback, missing post gracefully.
- **SyndicationModule** (`src/modules/syndication/syndication.module.ts`): feature-flagged wrapper (`SYNDICATION_ENABLED`). `forRoot()` registers CanonicalModule, GenerationModule, BrowserAgentModule, article posters.
- **Article graph skeleton** → **real implementation** (see Phase 1)
- **5 article fallback prompts** in `fallback-prompts.ts`: `ARTICLE_RESEARCH_EXTRACT_PROMPT`, `ARTICLE_OUTLINE_PROMPT`, `ARTICLE_DRAFT_PROMPT`, `ARTICLE_JUDGE_PROMPT`, `ARTICLE_REFINE_PROMPT`
- **40+ env vars** in `env.validation.ts`: `BLOG_BASE_URL`, `SYNDICATION_ENABLED`, per-platform credentials, rate limits, auto-approve thresholds, `BROWSER_AGENT_MAX_ITERATIONS`, `BROWSER_AGENT_CACHE_TTL_MS`
- **ArticleGenerationCron**: dynamic cron registration via `SchedulerRegistry`, skipped when `ORCHESTRATOR_ENABLED=true`

### Phase 1 MVP — 8 issues closed (#11-#15, #16, #18, #19)

- **#47 BrowserAgentService** (`src/modules/browser-agent/browser-agent.service.ts`): LLM-in-the-loop browser engine. 4 primitives:
  - `act(page, instruction)` — screenshot → LLM vision → parse JSON action → execute (click/fill/scroll/navigate/done). Max 10 iterations, consecutive failure guard (3 max, resets on success).
  - `extract(page, schema)` — screenshot + DOM → LLM → Zod validation → typed result
  - `observe(page, instruction)` — screenshot + DOM → LLM → element list
  - `verify(page, question)` — screenshot → LLM → boolean
  - SHA256 screenshot cache (5-min TTL, `BROWSER_AGENT_CACHE_TTL_MS`). Accessibility tree for DOM context. Multi-strategy element finding (CSS → role → label → text).
  - **26 unit tests** (BA-001..BA-091)

- **#15 Article graph real implementation** (`src/modules/generation/article-graph.ts`): all 7 nodes now make real LLM calls:
  - `research_extract` — `article-research-extract` prompt, parses numbered facts list
  - `build_outline` — `article-outline` prompt, parses markdown H2/H3 structure into `ArticleOutlineSection[]`
  - `draft_article` — `article-draft` prompt, parses H1 title + body + excerpt + slug
  - `judge_article` — `article-judge` prompt, extracts JSON scores, validates 5 criteria (anti_ai_tone, hook_strength, factual_accuracy, structure_quality, seo_optimization)
  - `refine_article` — `article-refine` prompt, rewrites based on judge feedback
  - `set_canonical` — calls `CanonicalUrlService.buildBlogUrl()` + `setCanonical()`
  - `save_to_db` — formats state (Prisma persistence happens in GenerationService)
  - Judge router: avg < 0.7 + refineCount < 3 → refine. `MAX_REFINES=3`, `JUDGE_THRESHOLD=0.7` (hardcoded constants — #15 review noted these should be env-configurable)
  - **15 unit tests** (AG-001..AG-071)

- **#16 Auto-approve per-platform thresholds** (`src/modules/autonomy/auto-approve.service.ts`):
  - `getThresholdForNetwork(network)` — returns per-platform threshold from `perPlatformThresholds` Map
  - 14 networks configured. Env vars: `AUTO_APPROVE_MIN_SCORE_{NET}` (e.g. `AUTO_APPROVE_MIN_SCORE_REDDIT=9`)
  - Falls back to global `AUTO_APPROVE_MIN_SCORE` (default 7)
  - `failOpenMissingScore` also uses per-network threshold

- **#18 BullMQ queues**: already supported by generic `QueueFactory.getQueue(network, action)`. No changes needed — queues created on-demand.

- **#19 Rate limiter** (`src/modules/rate-limit/rate-limit.service.ts`):
  - Extended from 3 networks to 14 (original 3 + 11 syndication)
  - New platforms: `RATE_LIMIT_DAILY_{NET}` env vars (default: 3/day for article platforms vs 1/day for micro-posts)
  - Weekly: `RATE_LIMIT_WEEKLY_{NET}` (default: 10/week for new, 5/week for original)
  - Legacy `RATE_LIMIT_{NET}_MAX_PER_DAY` still supported (checked first)

- **#14 PostingService extension** (`src/modules/posting/posting.service.ts`):
  - New `postArticle(context, post)` method — dispatches to article posters via `ModuleRef` lazy resolution
  - Post.content parsed as JSON `ArticleContent` (title, bodyMarkdown, slug, tags, excerpt)
  - Canonical URL from `post.canonicalUrl` or built from slug
  - Article posters resolved only when `SYNDICATION_ENABLED=true` — graceful error when disabled
  - Switch cases added: `DEVTO`, `HASHNODE`, `LINKEDIN` → `postArticle()`

- **#11/#12/#13 Article posters**:
  - `ArticleBasePoster` (`src/modules/posting/posters/article-base.poster.ts`) — abstract base with `postArticle()` flow: navigate → LLM fills title → LLM fills body (markdown) → LLM fills tags → LLM sets canonical URL → LLM clicks publish → LLM extracts URL
  - `DevtoPoster` — editor `https://dev.to/new`
  - `HashnodePoster` — editor `https://hashnode.com/new`
  - `LinkedinPoster` — editor `https://www.linkedin.com/article/new`
  - All registered in `SyndicationModule.forRoot()` providers + exports

### Bug fixes from code review

- **CRITICAL**: LLM `cacheKey()` now includes `imageBase64` hash (vision calls were returning cached responses for different screenshots with same text prompt)
- **CRITICAL**: Vision calls (`role='vision'`) bypass LLM cache entirely (screenshots are unique per capture)
- **HIGH**: `act()` loop has consecutive failure guard (3 max failures → returns `consecutive_failures`, resets on successful action)
- **MEDIUM**: `generateVision()` validates image format (must be `data:image/png;base64,`) + 10MB size limit
- **MEDIUM**: `buildBlogUrl('')` falls back to `/blog/untitled` for empty slugs
- **MEDIUM**: `setCanonical()` silently skips when post not found (try/catch)
- **BUG**: Article graph node `outline` renamed to `build_outline` (LangGraph rejects node name matching state channel name)

### Test state

- **1484 passed**, 14 pre-existing failures, 0 regressions
- 39 new tests: BrowserAgent (26), CanonicalUrl (16), ArticleGraph (15)
- 14 pre-existing failures are in: `auto-approve`, `browsing-session`, `engagement-graph`, `batched-judge` — all unrelated to syndication

---

## 2. What's next — Phase 2 social platforms

### Phase 1 remainder (4 open issues, P1-P2 priority)

| Issue | Title | Priority | Notes |
|-------|-------|----------|-------|
| #50 | P1-04a: Emit POST_VERIFIED event after successful publish + verify | P1 | Needed for #25 social promo trigger |
| #17 | P1-07: IndexNow service — submit URLs after publish | P1 | SEO — ping search engines after article publish |
| #20 | P1-10: End-to-end test — Dev.to full flow | P1 | Dry-run test of Dev.to poster |
| #21 | P1-11: SPA UI — syndication dashboard | P2 | Vue UI for syndication status |

### Phase 2 — social platforms (6 open issues)

| Issue | Title | Priority | Type |
|-------|-------|----------|------|
| **#22** | P2-01: Bluesky poster (Camoufox + LLM-in-the-loop) | **P0** | Browser |
| **#23** | P2-02: Mastodon poster (Camoufox + LLM-in-the-loop) | **P0** | Browser |
| **#24** | P2-03: Telegram adapter (Bot API — only API exception) | **P0** | API |
| **#25** | P2-04: Social promo trigger — auto-generate social posts on article publish | **P0** | Event |
| #52 | P2-04a: Extend social generation graph for new networks | P1 | Graph |
| #45 | P2-05: End-to-end tests — Bluesky + Mastodon + Telegram | P1 | Test |

### Recommended order for Phase 2

1. **#50** POST_VERIFIED event (needed for #25)
2. **#22** Bluesky poster (Camoufox + LLM-in-the-loop, same pattern as article posters but for short-form posts)
3. **#23** Mastodon poster (same pattern)
4. **#24** Telegram adapter (Bot API — direct HTTP, no browser. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `POST /bot{token}/sendMessage` with `parse_mode=MarkdownV2`)
5. **#25** Social promo trigger (listens for POST_VERIFIED → triggers social generation graph → generates platform-native promo posts with canonical URL)
6. **#52** Extend social generation graph for new networks (add BLUESKY, MASTODON, TELEGRAM, LINKEDIN to generation graph fan-out)
7. **#17** IndexNow (submit URLs to Bing/Yandex after publish)
8. **#45** E2e tests

---

## 3. Architecture context for Phase 2

### Bluesky/Mastodon posters — key difference from article posters

Article posters (Dev.to, Hashnode, LinkedIn) publish **long-form articles** via `ArticleBasePoster.postArticle()`. Bluesky/Mastodon publish **short-form social posts** (300-500 char limit). They should extend `BasePoster` (like `XPoster`, `ThreadsPoster`) and implement `post()` method, not `ArticleBasePoster`.

**Pattern**: Use `BrowserAgentService.act()` for all interactions — same LLM-in-the-loop approach, but for short-form compose boxes instead of article editors.

**Files to create**:
- `src/modules/posting/posters/bluesky.poster.ts` — extends `BasePoster`
- `src/modules/posting/posters/mastodon.poster.ts` — extends `BasePoster`

**Register in**: `SyndicationModule.forRoot()` providers + exports (same as article posters)

**PostingService dispatch**: Add `case SocialNetwork.BLUESKY` / `MASTODON` to the switch in `postById()` — resolve via `ModuleRef.get(BlueskyPoster, { strict: false })`

### Telegram adapter — no browser

Telegram uses Bot API directly (HTTP calls, no Camoufox). This is the **only API exception** in the architecture.

**Files to create**:
- `src/infrastructure/telegram/telegram.adapter.ts` — direct HTTP via `fetch` or `axios`
- `src/infrastructure/telegram/telegram.module.ts` — NestJS module

**Env vars** (already in `env.validation.ts`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`

**PostingService dispatch**: Add `case SocialNetwork.TELEGRAM` → resolve `TelegramAdapter` via `ModuleRef`

### Social promo trigger (#25)

Listens for `POST_VERIFIED` domain event → triggers existing social generation graph (`generation.graph.ts`) with article as content source → generates platform-native promo posts for all enabled social networks → each goes through judge → auto-approve → publish.

**Key**: The social generation graph already exists and works for X/Threads/Facebook. Phase 2 extends it to Bluesky/Mastodon/Telegram/LinkedIn (#52).

**Files to create**:
- `src/modules/generation/social-promo.trigger.ts`
- `src/events/listeners/social-promo.listener.ts`

**Dependency**: #50 (POST_VERIFIED event) must be implemented first.

---

## 4. Key files to read before starting

| File | Why |
|------|-----|
| `src/modules/posting/posters/article-base.poster.ts` | Pattern for LLM-in-the-loop posting |
| `src/modules/browser-agent/browser-agent.service.ts` | The 4 LLM primitives (act/extract/observe/verify) |
| `src/modules/posting/posters/x.poster.ts` | Pattern for short-form social poster (extends BasePoster) |
| `src/modules/posting/posting.service.ts` | How dispatch works (switch + ModuleRef for new posters) |
| `src/modules/syndication/syndication.module.ts` | Where new posters are registered |
| `src/modules/generation/generation.graph.ts` | Social generation graph (fan-out per network) |
| `src/modules/rate-limit/rate-limit.service.ts` | Rate limits already configured for 14 networks |
| `src/modules/autonomy/auto-approve.service.ts` | Per-platform thresholds already configured |
| `src/infrastructure/config/env.validation.ts` | All env vars (Telegram, Bluesky, Mastodon credentials) |
| `AGENTS.md` | Project conventions (ESM .js imports, Langfuse, orchestrator) |
| `CLAUDE.md` | Architecture overview, traps, test taxonomy |

---

## 5. Conventions to follow

- **ESM imports**: Orchestrator + syndication modules use `.js` extensions (`import { X } from './foo.js'`)
- **Feature flags**: New modules behind `SYNDICATION_ENABLED` in `app.module.ts` (same pattern as `ENGAGEMENT_ENABLED`)
- **ModuleRef for cross-module**: PostingService uses `ModuleRef.get(Poster, { strict: false })` to resolve article posters from SyndicationModule — avoids hard dependency
- **LLM-in-the-loop**: No hardcoded selectors. All browser interactions via `BrowserAgentService.act()` / `extract()` / `observe()` / `verify()`
- **Tests**: Unit tests in `tests/unit/{module}/`. Test IDs: `XX-NNN` format (e.g. `BP-001` for Bluesky Poster)
- **Typecheck**: `cd packages/backend && npx tsc --noEmit` — must pass 0 errors
- **Tests**: `cd packages/backend && npx vitest run tests/unit/` — 14 pre-existing failures are OK, 0 new failures

---

## 6. Known issues / tech debt

- `MAX_REFINES=3` and `JUDGE_THRESHOLD=0.7` in `article-graph.ts` are hardcoded (should be env-configurable — noted in code review #15)
- `ArticleBasePoster` has `import { z } from 'zod'` at the bottom of the file (should be at top, but works due to hoisting)
- `BrowserAgentService.cacheKey()` doesn't include LLM parameters (temperature, maxTokens) — low priority since BrowserAgent always uses temperature=0
- 14 pre-existing test failures in `auto-approve`, `browsing-session`, `engagement-graph`, `batched-judge` — unrelated to syndication
- `LlmRole` type now includes `'outline'` — added for article graph, may need provider routing config in `LLM_ROLE_CHAINS` if outline calls should use a specific provider chain

---

## 7. Quick start for new session

```bash
# Verify state
cd /Users/valentinyakovlev/projects/agents/social-poster-agent
git log --oneline -3  # should show ca38098 as latest
cd packages/backend && npx tsc --noEmit  # 0 errors
npx vitest run tests/unit/  # 1484 passed, 14 pre-existing failures

# Open issues for Phase 2
gh issue list --state open --label "phase-2-social"

# Start with #50 (POST_VERIFIED event) then #22 (Bluesky poster)
```
