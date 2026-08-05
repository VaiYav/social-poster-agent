# Handoff — Cross-Platform Content Syndication

> **Date:** 2026-08-05
> **From:** Devin session (architecture + planning phase)
> **To:** Next agent / developer picking up implementation
> **Status:** Planning complete, implementation not started (Phase 0, 0%)

---

## 1. What was done in this session

### 1.1 Strategy pivot

The user initially wanted a standalone content syndication system using Pipepost MCP.
After research, the decision was made to **extend the existing `social-poster-agent` (SPA)**
instead of building a new service. Rationale: SPA already has 90% of the required
infrastructure (BullMQ, LangGraph, LLM router, judge, auto-approve, browser automation,
rate limiting, health monitoring, 458 tests). Building standalone would duplicate all of it.

### 1.2 Documents created

#### In `astro-ai-landing` repo (the content source / blog)

| File | Purpose |
|------|---------|
| `.devin/rules/content-syndication.md` | Rule: syndication strategy = extend SPA |
| `.devin/plans/cross-platform-syndication-system.md` | Architecture + rollout plan |
| `.devin/plans/syndication-loop.md` | Loop spec (generate → judge → publish → verify) |
| `AGENTS.md` | Updated with reference to the new strategy |

#### In `social-poster-agent` repo (the implementation target)

| File | Purpose | Committed? |
|------|---------|------------|
| `docs/adr/ADR-007-cross-platform-syndication.md` | Formal ADR: extend SPA for syndication | Yes (69cbde7) |
| `docs/features/cross-platform-syndication.md` | Detailed feature spec (platforms, modes, judge, POSSE) | Yes (69cbde7) |
| `ROADMAP-SYNDICATION.md` | 6 phases, 42 tasks, gates, completion criteria | Yes (69cbde7) |
| `docs/ARCHITECTURE-DIAGRAMS.md` | 13 Mermaid diagrams (C4 L1-L3 + behavioral) | **No — uncommitted** |

### 1.3 GitHub project

- **Project:** "Cross-Platform Content Syndication" in `my-zodiac-ai` org
- **Issues:** 42 issues (#3–#44), one per roadmap task
- **Labels:** `syndication`, `phase-0-foundation` through `phase-5-polish`, `P0`/`P1`/`P2`
- **Issue mapping:** `P0-01` = #3, `P0-02` = #4, ... `P5-07` = #44

### 1.4 Architecture diagrams

`docs/ARCHITECTURE-DIAGRAMS.md` contains 13 Mermaid diagrams documenting the **current**
SPA architecture (not the future syndication state):

1. System Context (C4 L1)
2. Container Diagram (C4 L2)
3. Component Diagram — Backend Modules (C4 L3)
4. Hexagonal Ports & Adapters
5. LangGraph Generation State Machine
6. Auto-Approve / LLM-as-a-Judge Flowchart
7. Orchestrator Decision Loop
8. End-to-End Data Flow
9. Prisma ERD (16 models, 9 enums)
10. SSE Event Flow
11. LLM Provider Chain & Circuit Breaker (15 providers)
12. Browser Pool & Context Lifecycle
13. BullMQ Queue Topology

---

## 2. Current state

### 2.1 What exists (SPA today)

- **3 platforms:** X, Threads, Facebook (all via Camoufox browser automation)
- **Content types:** Short social posts only
- **Generation:** LangGraph per-topic fan-out → 3 posts (one per network)
- **Approval:** HITL by default (`AUTO_APPROVE_ENABLED=false`)
- **Judge:** LLM-as-a-Judge with 4 criteria (anti_ai_tone, hook_strength, factual_accuracy, character_limit)
- **Orchestrator:** Full autonomous loop (feature-flagged, `ORCHESTRATOR_ENABLED=false`)
- **Observability:** Langfuse prompt management + tracing, SSE real-time UI, Discord alerts

### 2.2 What needs to be built (syndication extension)

- **9 new platforms:** Dev.to, Hashnode, LinkedIn (API-based); Bluesky, Mastodon, Telegram (API-based); Medium, Substack (browser-based); Reddit, Quora (participation); Pinterest (visual)
- **2 new content types:** Long-form articles, Q&A answers
- **New port:** `IApiPosterPort` for API-based posting (distinct from browser-based `IBrowserPort`)
- **Article generation graph:** New LangGraph for long-form (outline → draft → critique → refine → judge)
- **Canonical URL management:** POSSE pattern — blog is canonical, syndicated posts link back
- **Autonomous mode:** Enable `AUTO_APPROVE_ENABLED=true` with judge-score-based approval
- **IndexNow:** Submit URLs to Bing/Yandex after publish
- **Participation module:** Find questions on Reddit/Quora, draft answers, judge, post

### 2.3 Roadmap status

```
Phase 0: Foundation          [░░░░░░░░░░░░░░░░░░░░]   0%  📋 Not started
Phase 1: MVP (Dev.to+Hash+LI)[░░░░░░░░░░░░░░░░░░░░]   0%  📋 Not started
Phase 2: Social expansion    [░░░░░░░░░░░░░░░░░░░░]   0%  📋 Not started
Phase 3: Browser platforms   [░░░░░░░░░░░░░░░░░░░░]   0%  📋 Not started
Phase 4: Participation       [░░░░░░░░░░░░░░░░░░░░]   0%  📋 Not started
Phase 5: Polish & backfill   [░░░░░░░░░░░░░░░░░░░░]   0%  📋 Not started
```

---

## 3. Immediate next steps

### 3.1 Uncommitted work

**`docs/ARCHITECTURE-DIAGRAMS.md` is uncommitted** in the SPA repo. It should be
committed before starting implementation:

```bash
cd /Users/valentinyakovlev/projects/agents/social-poster-agent
git add docs/ARCHITECTURE-DIAGRAMS.md
git commit -m "docs: add architecture diagrams (13 Mermaid, C4 L1-L3 + behavioral)"
```

### 3.2 Phase 0 — first implementation tasks

The roadmap defines 8 Phase 0 tasks (issue #3–#10). They should be done in order:

| # | Issue | Task | Dependencies |
|---|-------|------|-------------|
| 1 | #3 | P0-01: Prisma schema migration | None — start here |
| 2 | #5 | P0-03: Extend SocialNetwork enum + ContentType | #3 |
| 3 | #4 | P0-02: Create IApiPosterPort | #5 |
| 4 | #6 | P0-04: CanonicalUrlService | None |
| 5 | #7 | P0-05: Article generation graph skeleton | #4 |
| 6 | #8 | P0-06: Add article prompts to Langfuse | #7 |
| 7 | #9 | P0-07: Env vars + validation | #3 |
| 8 | #10 | P0-08: Article generation cron service | #7, #9 |

**Start with #3 (Prisma schema migration).** It unblocks everything else.

### 3.3 API keys needed

Before Phase 1 implementation, the user needs to obtain:

| Platform | API | Env var | Notes |
|----------|-----|---------|-------|
| Dev.to | Forem API | `DEVTO_API_KEY` | Free, instant. https://developers.forem.com/api |
| Hashnode | GraphQL API | `HASHNODE_PAT` | Free, instant. https://hashnode.com/settings/developer |
| LinkedIn | rest/posts API | `LINKEDIN_ACCESS_TOKEN` | OAuth2, requires app approval. https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/sharing/api |
| Bluesky | AT Protocol | `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD` | Free, instant. https://bsky.app/settings/app-passwords |
| Mastodon | Instance API | `MASTODON_ACCESS_TOKEN` | Free, instance-specific. |
| Telegram | Bot API | `TELEGRAM_BOT_TOKEN` | Free, instant via @BotFather. |
| IndexNow | — | `INDEXNOW_KEY` | Already exists in astro-ai-landing (`e6821772f3a8677c2db4ea5b14c9bdf4`). |

Medium and Substack have **no public posting API** — they will use Camoufox browser
automation (Phase 3). Reddit and Quora also use browser automation (Phase 4).

---

## 4. Key architectural decisions

### 4.1 Extend SPA, don't build standalone

**Decision:** ADR-007. Extend `social-poster-agent` with new posters, new content types,
and autonomous mode. Do not build a separate syndication service.

**Rationale:** SPA already has BullMQ queues, LangGraph generation, LLM router (15 providers),
LLM-as-a-Judge, auto-approve pipeline, rate limiting, health monitoring, SimHash dedup,
SSE real-time UI, hexagonal ports, 458 tests. A standalone service would duplicate 90% of this.

### 4.2 Two posting ports

- `IBrowserPort` (existing) — for browser-automated platforms (X, Threads, Facebook, Medium, Substack)
- `IApiPosterPort` (new) — for API-based platforms (Dev.to, Hashnode, LinkedIn, Bluesky, Mastodon, Telegram)

`PostingService` dispatches based on `post.network` → either browser poster or API poster.

### 4.3 POSSE canonical URLs

Blog (`my-zodiac-ai.com/blog/{slug}`) is the canonical source. All syndicated posts
link back to it. `CanonicalUrlService` builds, sets, and verifies canonical URLs.

### 4.4 Autonomous mode = LLM-as-a-Judge gate

No human checkpoint before publishing. The LLM-judge's score determines approval:
- All 4 criteria pass thresholds → AUTO_APPROVE → enqueue
- Any criterion below reject threshold → REJECT
- Otherwise → HUMAN_REVIEW (fallback, not the default path)

`AUTO_APPROVE_ENABLED=true` + `AUTO_APPROVE_USE_JUDGE_SCORES=true` enables this.

### 4.5 Article generation = new LangGraph

Separate from the social-post graph. Different state schema (`ArticleGraphState`),
different nodes (research → outline → draft_article → critique → refine → judge),
different length targets (1500-3000 words vs 280 chars).

---

## 5. Key files to read before starting

### 5.1 In SPA repo (`/Users/valentinyakovlev/projects/agents/social-poster-agent`)

| File | Why |
|------|-----|
| `AGENTS.md` | Project conventions (Langfuse, orchestrator, browser memory, Playwright patch) |
| `CLAUDE.md` | Operational guide (doc-lag caveats, traps, test taxonomy) |
| `docs/ARCHITECTURE-DIAGRAMS.md` | 13 diagrams of current architecture |
| `docs/adr/ADR-007-cross-platform-syndication.md` | The decision to extend SPA |
| `docs/features/cross-platform-syndication.md` | Full feature spec |
| `ROADMAP-SYNDICATION.md` | 42 tasks across 6 phases |
| `packages/backend/prisma/schema.prisma` | Current schema (will be extended in P0-01) |
| `packages/backend/src/app.module.ts` | Module registration (feature-flag pattern) |
| `packages/backend/src/domain/ports/` | All 6 existing ports (pattern to follow for IApiPosterPort) |
| `packages/backend/src/modules/generation/generation.graph.ts` | Current LangGraph (pattern for article graph) |
| `packages/backend/src/modules/posting/posting.service.ts` | Current dispatch (will be extended) |
| `packages/backend/src/modules/autonomy/auto-approve.service.ts` | Auto-approve logic (will be tuned per-platform) |

### 5.2 In astro-ai-landing repo (`/Users/valentinyakovlev/projects/astro-ai-landing`)

| File | Why |
|------|-----|
| `.devin/rules/content-syndication.md` | Syndication rule |
| `.devin/plans/cross-platform-syndication-system.md` | Architecture + rollout plan |
| `.devin/plans/syndication-loop.md` | Loop spec |

### 5.3 In CAP repo (`/Users/valentinyakovlev/projects/agents/content-agent-platform`)

SPA reads from CAP's `runs/brief-*`, `runs/topics-*`, `runs/create-*` folders.
The article generation graph will consume the same content sources but produce
long-form output.

---

## 6. Build / test / lint commands (SPA)

```bash
# Typecheck
cd packages/backend && npx tsc --noEmit

# Unit tests
cd packages/backend && npx vitest run tests/unit/

# Full test suite
cd packages/backend && npx vitest run

# Lint (oxlint) + format (oxfmt)
pnpm lint && pnpm format

# Prisma migrate
pnpm prisma:migrate -- --name <migration-name>

# Dev (all services)
pnpm dev:all

# Dry-run posting (safe — intercepts final submit)
pnpm dry-run

# Infra (Postgres :5433, Redis :6381)
pnpm infra:up
```

**Ports:** API `:3100` (`/api/v1`, Swagger `/docs`), UI `:3101`. Node ≥22, pnpm ≥10.

---

## 7. Risks & open questions

1. **LinkedIn API approval** — requires a LinkedIn app with `w_member_social` scope.
   Approval can take days. Start the application early (before Phase 1).

2. **Medium/Substack have no posting API** — Camoufox browser automation is the only
   option. Medium's editor is a rich-text React app; selector drift is likely.
   Phase 3 includes a selector health service for these.

3. **Reddit/Quora participation** — these platforms have aggressive anti-bot detection.
   Camoufox helps, but account bans are likely. Phase 4 includes ban recovery.
   Consider whether the ROI justifies the effort.

4. **Article quality at scale** — generating 1500-3000 word articles via free-tier LLMs
   (Groq, SambaNova) may hit quality ceilings. The judge's `factual_accuracy` criterion
   is critical here. May need to route article generation to paid providers (OpenAI,
   Anthropic) via the per-role chain (`LLM_ROLE_CHAINS=article=anthropic,openai`).

5. **Backfill volume** — 39K existing blog posts. Phase 5 backfill must be batched
   and rate-limited to avoid platform bans. Estimate: months, not days.

6. **Autonomous mode safety** — enabling `AUTO_APPROVE_ENABLED=true` removes the human
   checkpoint. The judge must be calibrated first (Phase 5-02: track scores vs outcomes).
   Recommend a shadow-mode period where auto-approve runs but doesn't enqueue — just
   logs what it would have approved.

---

## 8. GitHub project board

- **Project URL:** `https://github.com/orgs/my-zodiac-ai/projects/<N>` (check org projects)
- **42 issues:** #3–#44 in `my-zodiac-ai/social-poster-agent`
- **Labels to filter by phase:** `phase-0-foundation`, `phase-1-mvp`, `phase-2-social`,
  `phase-3-browser`, `phase-4-participation`, `phase-5-polish`
- **Priority labels:** `P0` (critical blocker), `P1` (important), `P2` (nice to have)

---

## 9. Session history

Full conversation history saved at:
`/Users/valentinyakovlev/.local/share/devin/cli/summaries/history_befd7d13d06b41f8.md`

Key commits:
- `69cbde7` — feat: add cross-platform content syndication architecture (ADR-007 + roadmap + feature spec)

Uncommitted:
- `docs/ARCHITECTURE-DIAGRAMS.md` — 13 Mermaid architecture diagrams
