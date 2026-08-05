# Syndication Roadmap — Full Analysis

> **Purpose:** Complete breakdown of what we're building, how, where we're going,
> and what we'll get. Based on cross-referencing ADR-007, feature spec,
> ROADMAP-SYNDICATION.md, and the GitHub project (42 issues).
>
> **Date:** 2026-08-05
> **Status:** Planning complete, implementation not started

---

## 1. What we're building

### 1.1 One-sentence summary

Extend the existing Social Poster Agent (SPA) to autonomously syndicate
My Zodiac AI content across **11+ platforms** — articles, social posts,
Q&A answers, and visual pins — with LLM-as-a-Judge as the sole gatekeeper
(no human review before publishing).

### 1.2 The vision

Today SPA posts short social content to 3 platforms (X, Threads, Facebook)
with human-in-the-loop approval. The goal is:

- **11+ platforms** (Dev.to, Hashnode, LinkedIn, Bluesky, Mastodon, Telegram,
  Medium, Substack, Reddit, Quora, Pinterest) in addition to the existing 3
- **4 content types**: short social posts, long-form articles, Q&A answers,
  visual pins
- **Full autonomy**: LLM-judge decides what gets published, no human checkpoint
- **POSSE strategy**: blog (`my-zodiac-ai.com/blog`) is canonical, all
  syndicated content links back
- **IndexNow**: auto-submit new URLs to Bing/Yandex for faster indexing

### 1.3 What already exists (the foundation we're building on)

| Component | Status | Reuse level |
|-----------|--------|-------------|
| LangGraph generation (per-topic fan-out) | ✅ Working | Extended (new article graph) |
| LLM-as-a-Judge (4 criteria) | ✅ Working | Extended (5 criteria for articles, 4 for answers) |
| Auto-approve pipeline | ✅ Built, disabled | Enabled + per-platform thresholds |
| BullMQ queues (per-network, concurrency=1) | ✅ Working | Extended (new queues per platform) |
| Rate limiter (Redis sliding window) | ✅ Working | Extended (per-platform limits) |
| Health monitor (ban detection, DLQ, reconciliation) | ✅ Working | Extended (API adapter health) |
| SimHash dedup | ✅ Working | No changes |
| 15-provider LLM router with circuit breakers | ✅ Working | No changes (per-role chains for articles) |
| Langfuse prompt management + tracing | ✅ Working | Extended (5 new article prompts) |
| Hexagonal ports (6 Symbol tokens) | ✅ Working | Extended (1 new port: IApiPosterPort) |
| SSE real-time UI | ✅ Working | Extended (new event types) |
| Camoufox browser automation | ✅ Working | Extended (Medium, Substack, Reddit, Quora) |
| 458 tests | ✅ Passing | Extended |

**Key insight:** We're not building a new system. We're adding adapters and
one new LangGraph to a system that already has all the infrastructure.

---

## 2. How we're building it

### 2.1 Architecture approach

**Hexagonal extension.** New platform adapters implement either:
- `IApiPosterPort` (new) — for API-based platforms (Dev.to, Hashnode, LinkedIn,
  Bluesky, Mastodon, Telegram)
- `IBrowserPort` (existing) — for browser-based platforms (Medium, Substack,
  Reddit, Quora — via Camoufox persistent contexts)

`PostingService` dispatches based on `post.network` → correct adapter.

### 2.2 Two generation graphs

| Graph | Content type | Flow | Output |
|-------|-------------|------|--------|
| **Social graph** (existing) | Short social posts | research → hook → draft → critique → refine → judge → save | 3 posts (X/Threads/Facebook), 280 chars each |
| **Article graph** (new) | Long-form articles | research → outline → draft → judge → [refine loop] → set canonical → save | 1 article, 1500-3000 words, markdown |

### 2.3 Autonomous approval flow

```
Content generated → LLM-as-a-Judge scores it →
  score ≥ platform threshold → AUTO_APPROVE → BullMQ queue → publish
  score < threshold, retries < 3 → refine loop → re-judge
  score < threshold, retries ≥ 3 → REJECT
```

**Per-platform thresholds** (stricter for participation platforms):
- Dev.to/Hashnode/Medium/Substack: 8 (developer/quality audience)
- LinkedIn/Bluesky/Mastodon/Telegram: 7 (general social)
- Reddit/Quora: 9 (participation — strictest, anti-spam)

### 2.4 POSSE canonical URLs

```
Blog (canonical) → syndicated to → Dev.to (canonical_url field)
                                   Hashnode (canonicalUrl arg)
                                   Medium (story settings)
                                   Substack (post settings)
                                   LinkedIn/Bluesky/Mastodon/Telegram (URL in text)
```

`CanonicalUrlService` builds, sets, and verifies canonical URLs. Judge criterion
`canonical_correctness` fails-closed if missing.

### 2.5 Post-publish hooks

After an article is published and verified:
1. **IndexNow** — submit blog URL + all syndicated URLs to Bing/Yandex
2. **Social promo trigger** — auto-generate social posts for all platforms
   (X, Threads, Facebook, LinkedIn, Bluesky, Mastodon, Telegram) linking
   back to the article

### 2.6 Participation mode (Reddit/Quora)

Different from broadcast syndication:
```
Find questions → LLM filters relevant → LLM drafts value-first answer →
  LLM-judge (helpfulness, promotional_tone < 0.3) →
  Camoufox posts answer → track engagement →
  feedback loop (high-engagement topics → more articles)
```

---

## 3. The 6 phases — detailed breakdown

### Phase 0: Foundation (3-5 days, 8 tasks)

**Goal:** Set up infrastructure for syndication — schema, ports, env, article graph skeleton.

| # | Issue | Task | Priority | Key files |
|---|-------|------|----------|-----------|
| #3 | P0-01 | Prisma schema migration | P0 | `schema.prisma`, `enums.ts` |
| #4 | P0-02 | Create IApiPosterPort | P0 | `api-poster.port.ts`, `syndication.ts` |
| #5 | P0-03 | Extend SocialNetwork + ContentType enums | P0 | `enums.ts` |
| #6 | P0-04 | CanonicalUrlService | P0 | `canonical-url.service.ts` |
| #7 | P0-05 | Article generation graph skeleton | P0 | `article-graph.ts` |
| #8 | P0-06 | Add article prompts to Langfuse | P1 | Langfuse UI + `fallback-prompts.ts` |
| #9 | P0-07 | Env vars + validation | P0 | `.env.example`, `env.validation.ts` |
| #10 | P0-08 | Article generation cron service | P1 | `article-generation-cron.ts` |

**Gate 0:** Migration applied, `IApiPosterPort` compiles, article graph compiles
with stub nodes, Langfuse prompts created, `SYNDICATION_ENABLED=false` → no errors.

**Deliverable:** Empty infrastructure ready for real implementations. No platforms
connected yet. Nothing publishes.

---

### Phase 1: MVP — Dev.to + Hashnode + LinkedIn (1-2 weeks, 11 tasks)

**Goal:** First three API-based platforms. Full article generation → judge →
auto-approve → publish → canonical URL → IndexNow flow.

| # | Issue | Task | Priority | What it does |
|---|-------|------|----------|--------------|
| #11 | P1-01 | Dev.to adapter (Forem API) | P0 | `POST /api/articles` with canonical_url |
| #12 | P1-02 | Hashnode adapter (GraphQL) | P0 | `publishPublication` mutation |
| #13 | P1-03 | LinkedIn adapter (rest/posts) | P0 | `POST /v2/posts` with share URL |
| #14 | P1-04 | PostingService extension | P0 | Dispatch to API adapters (not just browser) |
| #15 | P1-05 | Article graph — real implementation | P0 | Full article generation: research → outline → draft → judge → refine |
| #16 | P1-06 | Auto-approve per-platform thresholds | P0 | Per-platform `AUTO_APPROVE_MIN_SCORE_*` |
| #17 | P1-07 | IndexNow service | P1 | Submit URLs to Bing/Yandex after publish |
| #18 | P1-08 | BullMQ queues for new platforms | P1 | `spa-posting-devto`, `spa-posting-hashnode`, `spa-posting-linkedin` |
| #19 | P1-09 | Rate limiter per-platform | P1 | Per-platform daily/weekly limits |
| #20 | P1-10 | End-to-end test — Dev.to | P1 | Full flow: generate → judge → publish → verify |
| #21 | P1-11 | SPA UI — syndication dashboard | P2 | New `/syndication` view |

**Gate 1:** Article generated → judged → auto-approved → published to Dev.to
with canonical URL (verified live). Same for Hashnode + LinkedIn. IndexNow
verified in Bing Webmaster Tools. No bans in 48h.

**Deliverable:** 3 platforms live. Articles auto-publishing weekly. This is the
first shippable increment — the system is now autonomously syndicating content.

**Dependencies:** Dev.to API key, Hashnode token, LinkedIn access token (OAuth2 app
approval — start early, can take days).

---

### Phase 2: Social expansion — Bluesky + Mastodon + Telegram (3-5 days, 5 tasks)

**Goal:** Three more API-based platforms. Social promo trigger after article publish.

| # | Issue | Task | Priority | What it does |
|---|-------|------|----------|--------------|
| #22 | P2-01 | Bluesky adapter (AT Protocol) | P0 | `com.atproto.repo.createRecord` |
| #23 | P2-02 | Mastodon adapter (instance API) | P0 | `POST /api/v1/statuses` |
| #24 | P2-03 | Telegram adapter (Bot API) | P0 | `POST /bot{token}/sendMessage` |
| #25 | P2-04 | Social promo trigger | P0 | Auto-generate social posts on article publish |
| — | P2-05 | End-to-end tests | — | **⚠️ MISSING — not created as issue** |

**Gate 2:** Bluesky, Mastodon, Telegram publishing. Social promo trigger fires on
article publish. All social posts include canonical URL. No rate limit hits in 48h.

**Deliverable:** 6 platforms live (3 article + 3 social). When an article publishes,
social posts auto-generate and publish to all social platforms.

**Dependencies:** Bluesky account, Mastodon account, Telegram bot + channel.

---

### Phase 3: Browser platforms — Medium + Substack (1-2 weeks, 5 tasks)

**Goal:** Camoufox-based posting for API-less platforms. Persistent context (like Facebook).

| # | Issue | Task | Priority | What it does |
|---|-------|------|----------|--------------|
| #26 | P3-01 | Medium poster (Camoufox) | P0 | Persistent context, Lexical editor, canonical in settings |
| #27 | P3-02 | Substack poster (Camoufox) | P0 | Persistent context, rich text editor, canonical in settings |
| #28 | P3-03 | Account model + session management | P1 | SocialAccount records, BrowsingSessionService |
| #29 | P3-04 | Selector strategy + health | P1 | Selector fallback chain, drift detector |
| — | P3-05 | End-to-end tests | — | **⚠️ MISSING — not created as issue** |

**Gate 3:** Medium + Substack articles published with canonical URL (verified live).
No bans in 48h. Session persistence works.

**Deliverable:** 8 platforms live. All article-syndication platforms connected.
Memory impact: +2 persistent Camoufox contexts (~340-500 MB each).

**Dependencies:** Medium account, Substack publication. No API — browser automation only.
**Risk:** Medium's Lexical editor is a React SPA; selector drift is likely.

---

### Phase 4: Participation — Reddit + Quora + Pinterest (1-2 weeks, 8 tasks)

**Goal:** Agent participation mode. Different workflow — find questions, draft answers, post.

| # | Issue | Task | Priority | What it does |
|---|-------|------|----------|--------------|
| #30 | P4-01 | Participation module skeleton | P0 | Module + cron service |
| #31 | P4-02 | Question finder | P0 | Search Reddit/Quora for astrology questions |
| #32 | P4-03 | Answer drafter | P0 | LLM writes value-first answers (not promotional) |
| #33 | P4-04 | Answer judge | P0 | LLM-judge: helpfulness, promotional_tone < 0.3 |
| #34 | P4-05 | Reddit agent (Camoufox) | P0 | Browse + post answers via comment editor |
| #35 | P4-06 | Quora agent (Camoufox) | P0 | Browse + post answers via rich text editor |
| #36 | P4-07 | Pinterest adapter | P2 | Generate pin image + post via API or browser |
| #37 | P4-08 | Engagement feedback loop | P2 | High-engagement topics → more articles |

**Gate 4:** 2-3 Reddit answers posted, no bans, some upvotes. Same for Quora.
Pinterest pins created. Judge `promotional_tone` working.

**Deliverable:** 11 platforms live. Full participation mode. The system is now
both broadcasting content AND participating in conversations.

**Dependencies:** Reddit account (aged preferred), Quora account, Pinterest Business account.
**Risk:** Reddit/Quora have aggressive anti-bot detection. Bans are likely. The
`promotional_tone` judge criterion is critical — answers must be genuinely helpful.

---

### Phase 5: Polish & backfill (ongoing, 7 tasks)

**Goal:** Production hardening, monitoring, backfill existing content.

| # | Issue | Task | Priority | What it does |
|---|-------|------|----------|--------------|
| #38 | P5-01 | Full syndication dashboard | P2 | Per-platform status, judge score charts, participation feed |
| #39 | P5-02 | Judge calibration | P1 | Track scores vs outcomes, adjust thresholds |
| #40 | P5-03 | Metrics & alerting | P1 | Publish rate, judge scores, costs, ban rate |
| #41 | P5-04 | Backfill 39K blog posts | P2 | Batch syndicate existing content (~2 years at 50/day) |
| #42 | P5-05 | Content calendar | P2 | Cron schedule + topic rotation (seasonal, evergreen) |
| #43 | P5-06 | A/B testing | P2 | Test judge thresholds, article prompts, social hooks |
| #44 | P5-07 | Documentation | P1 | CLAUDE.md, README, runbooks |

**Deliverable:** Production-grade system with monitoring, calibration, and
backfill running. Documentation complete.

---

## 4. Where we're going (timeline)

```
Week 1     Phase 0: Foundation (schema, ports, article graph skeleton)
Week 2-3   Phase 1: MVP (Dev.to + Hashnode + LinkedIn) ← first shippable increment
Week 4     Phase 2: Social expansion (Bluesky + Mastodon + Telegram)
Week 5-6   Phase 3: Browser platforms (Medium + Substack)
Week 7-8   Phase 4: Participation (Reddit + Quora + Pinterest)
Week 9+    Phase 5: Polish & backfill (ongoing)
```

**Total estimated effort:** 6-8 weeks to full feature, then ongoing Phase 5.

**Critical path:** Phase 0 → Phase 1 (everything else depends on Phase 1 being
done — article generation, auto-approve, PostingService extension).

---

## 5. What we'll get (success metrics)

### 90 days after Phase 1 launch

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

### Long-term (12 months)

| Outcome | How we measure |
|---------|----------------|
| Domain authority growth | GSC / Ahrefs / Moz |
| Referral traffic from syndicated platforms | Google Analytics |
| Brand search volume growth | GSC search queries |
| Reddit/Quora authority | Upvotes, best answer counts |
| Backlink profile diversity | GSC links report |

---

## 6. Platform matrix

| Platform | Type | Auth | Content | Phase | Issue |
|----------|------|------|---------|-------|-------|
| X (existing) | Browser | Session | Social post | — | — |
| Threads (existing) | Browser | Session | Social post | — | — |
| Facebook (existing) | Browser | Persistent ctx | Social post | — | — |
| Dev.to | API | `api-key` header | Article + canonical | 1 | #11 |
| Hashnode | API | `Authorization` | Article + canonical | 1 | #12 |
| LinkedIn | API | `Bearer` token | Social share + URL | 1 | #13 |
| Bluesky | API | App password | Social post + URL | 2 | #22 |
| Mastodon | API | `Bearer` token | Social post + URL | 2 | #23 |
| Telegram | API | Bot token | Channel broadcast + URL | 2 | #24 |
| Medium | Browser | Persistent ctx | Article + canonical | 3 | #26 |
| Substack | Browser | Persistent ctx | Article + canonical | 3 | #27 |
| Reddit | Browser | Persistent ctx | Answer (participation) | 4 | #34 |
| Quora | Browser | Persistent ctx | Answer (participation) | 4 | #35 |
| Pinterest | API/Browser | Business token | Pin (visual) | 4 | #36 |

---

## 7. Dependencies (external blockers)

| Dependency | Required for | Status | Lead time |
|------------|--------------|--------|-----------|
| Dev.to API key | Phase 1 (#11) | Pending | Instant (dev.to/settings/extensions) |
| Hashnode token | Phase 1 (#12) | Pending | Instant (hashnode.com/settings/developer) |
| LinkedIn OAuth2 app | Phase 1 (#13) | Pending | **Days-weeks** (developers.linkedin.com) |
| Bluesky account | Phase 2 (#22) | Pending | Instant (bsky.app) |
| Mastodon account | Phase 2 (#23) | Pending | Instant (mastodon.social) |
| Telegram bot + channel | Phase 2 (#24) | Pending | Instant (@BotFather) |
| Medium account | Phase 3 (#26) | Pending | Instant (medium.com) |
| Substack publication | Phase 3 (#27) | Pending | Instant (substack.com) |
| Reddit account (aged) | Phase 4 (#34) | Pending | Use existing or create + age 30+ days |
| Quora account | Phase 4 (#35) | Pending | Instant (quora.com) |
| Pinterest Business | Phase 4 (#36) | Pending | Instant (business.pinterest.com) |
| IndexNow key | Phase 1 (#17) | **Already exists** | `e6821772f3a8677c2db4ea5b14c9bdf4` in astro-ai-landing |

**⚠️ Critical path dependency: LinkedIn OAuth2 app approval.** Start this
immediately — it's the only dependency with multi-day lead time.

---

## 8. Risks & mitigations

| Risk | P | Impact | Mitigation |
|------|---|--------|------------|
| Medium/Substack ban for automation | Medium | High | Camoufox stealth + warm-up + rate limiter + human-like cadence |
| Reddit/Quora ban for self-promotion | Medium | High | LLM-judge `promotional_tone` < 0.3; max 2-3 answers/week |
| Judge false positives (bad content published) | Low | Medium | Per-platform thresholds; Langfuse calibration; dry-run mode |
| API rate limits hit | Medium | Low | BullMQ concurrency=1; Redis sliding window; exponential backoff |
| Canonical URL missing | Low | High | Judge criterion `canonical_correctness` fails-closed |
| Account sessions expire | Medium | Low | Existing session warm-up + health monitor + login flow |
| LLM cost explosion | Low | Medium | Free-first 15-provider router; judge loop capped at 3; SimHash dedup |
| Camoufox memory (4 more persistent contexts) | Medium | Medium | `firefox_user_prefs` optimization; pool size=1 per platform |
| Article quality on free-tier LLMs | Medium | Medium | Per-role chain: `LLM_ROLE_CHAINS=article=anthropic,openai` |
| Backfill volume (39K articles) | Low | Low | Batch 5-10/day; SimHash dedup; ~2 years at 50/day |

---

## 9. Gaps in GitHub project setup

### 9.1 Missing issues (2)

| Roadmap task | Description | Action needed |
|---|---|---|
| P2-05: End-to-end tests | Test Bluesky/Mastodon/Telegram + social promo trigger | Create issue |
| P3-05: End-to-end tests | Dry-run Medium/Substack + live manual test | Create issue |

### 9.2 No milestones (recommended)

Milestones would give timeline + progress per phase. Recommended:

| Milestone | Issues | Target |
|-----------|--------|--------|
| Phase 0: Foundation | #3-#10 (8) | Week 1 |
| Phase 1: MVP | #11-#21 (11) | Week 2-3 |
| Phase 2: Social expansion | #22-#25 + P2-05 (5) | Week 4 |
| Phase 3: Browser platforms | #26-#29 + P3-05 (5) | Week 5-6 |
| Phase 4: Participation | #30-#37 (8) | Week 7-8 |
| Phase 5: Polish & backfill | #38-#44 (7) | Week 9+ |

### 9.3 No custom project fields (recommended)

| Field | Type | Values | Why |
|-------|------|--------|-----|
| Phase | Single-select | Phase 0-5 | Group/filter by phase (currently only via labels) |
| Platform | Single-select | Dev.to, Hashnode, LinkedIn, ... | Filter by platform |
| Content type | Single-select | Article, Social post, Answer, Pin | Filter by content type |
| Effort | Single-select | S, M, L | Planning |

### 9.4 No project views (recommended)

| View | Layout | Group by | Purpose |
|------|--------|----------|---------|
| Board | Board | Status | Kanban board (Todo / In Progress / Done) |
| By phase | Table | Phase label | See all tasks per phase |
| Roadmap | Roadmap | Milestone | Timeline view |
| By platform | Table | Platform field | See all tasks per platform |

### 9.5 No project description / README

The project has no description. Recommended:
- **Description:** "Autonomous cross-platform content syndication for My Zodiac AI.
  11+ platforms, LLM-as-a-Judge approval, POSSE canonical URLs."
- **README:** Link to ADR-007, feature spec, roadmap.

---

## 10. Recommended next actions

### 10.1 Fix GitHub project (30 min)

1. Create 2 missing issues (P2-05, P3-05)
2. Create 6 milestones (Phase 0-5)
3. Link all issues to milestones
4. Add project description
5. Create board view + by-phase view

### 10.2 Start LinkedIn OAuth2 app approval (now)

This is the only dependency with multi-day lead time. Start it immediately.

### 10.3 Get API keys (parallel, 1 hour)

Dev.to, Hashnode, Bluesky, Mastodon, Telegram — all instant. Get them all
now so Phase 1 and 2 aren't blocked.

### 10.4 Commit architecture diagrams + handoff doc

Both `ARCHITECTURE-DIAGRAMS.md` and `HANDOFF-SYNDICATION.md` are uncommitted.

### 10.5 Start Phase 0 implementation

Begin with issue #3 (Prisma schema migration) — it unblocks everything else.
