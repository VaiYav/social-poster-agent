# Handoff: Social Poster Agent — Syndication Feature

> **Date:** 2026-08-05
> **From:** Previous session (architecture review + diagrams + issues cleanup)
> **To:** Next agent
> **Branch:** main
> **Working directory:** `/Users/valentinyakovlev/projects/agents/social-poster-agent`

---

## What was done in this session

### 1. Architecture decisions documented in ROADMAP-SYNDICATION.md

Two architecture decisions were made and documented:

**Decision 1: Camoufox-first (all platforms via browser automation)**
- All 11 platforms connect via Camoufox (anti-detect Firefox), NOT API
- Only exception: Telegram (Bot API — free, no approval, instant setup)
- Rationale: Many platforms lack free APIs (Medium deprecated, Substack none, Reddit paid, Quora none, Pinterest approval). Camoufox unifies the architecture.
- No `IApiPosterPort` — all posting through existing `IBrowserPort` + `BrowserFactory`
- No API keys in `.env` — only account credentials (email/password) + `TELEGRAM_BOT_TOKEN`

**Decision 2: LLM-in-the-loop vision-based interaction (no hardcoded selectors)**
- All browser interaction resolved by LLM at runtime: `act("click the Publish button")`, `verify("is the article published?")`
- Eliminates selector drift entirely — no `selectors/` directory per platform
- Reference implementations: browser-use (107K stars), Stagehand, Skyvern, AgentQL
- Integrates with existing `LlmService` (free-first 15-provider router, 5-min cache, circuit breaker) — cost ~$0
- Trade-offs: 30-90 sec/post (BullMQ queue handles this), 85-90% reliability (retry on misread)
- Existing X/Threads/Facebook posters keep selector chain for now → migrate in Phase 5 (P5-08)

### 2. GitHub issues — 51 total (was 44, added 7)

**Updated 11 issues** to align with Camoufox + LLM-in-the-loop decisions:
- #9 (P0-07 Env vars) — removed API keys, replaced with account credentials
- #22 (P2-01 Bluesky) — removed selectors, added LLM-in-the-loop, blocked-by #47
- #23 (P2-02 Mastodon) — same
- #26 (P3-01 Medium) — same
- #27 (P3-02 Substack) — same
- #29 (P3-04) — completely rewritten: selector strategy → LLM vision accuracy tracking
- #34 (P4-05 Reddit) — removed selectors, added LLM-in-the-loop
- #35 (P4-06 Quora) — same
- #36 (P4-07 Pinterest) — replaced Business API with Camoufox + LLM-in-the-loop
- #45 (P2-05 E2E tests) — replaced API verification with LLM `verify()`
- #46 (P3-05 E2E tests) — removed SelectorHealthService, added LLM vision accuracy

**Created 7 new issues:**
- #47 (P1-00) — LLM-in-the-loop browser engine (browser-use/Stagehand pattern). **Critical path — blocks all new platform posters.**
- #48 (P5-08) — Migrate existing X/Threads/Facebook posters to LLM-in-the-loop
- #49 (P0-09) — Extend BrowserFactory for 10 new persistent contexts
- #50 (P1-04a) — Emit POST_VERIFIED event after publish + verify (needed by IndexNow + social promo)
- #51 (P0-04a) — SyndicationModule wrapper (feature-flag pattern)
- #52 (P2-04a) — Extend social generation graph for new networks (LinkedIn, Bluesky, Mastodon, Telegram)
- #53 (P0-02a) — ArticleGraphState type in @spa/shared

### 3. Architecture diagrams — 4 P0 diagrams created

Location: `docs/diagrams/`

**Created:**
- `docs/diagrams/README.md` — index of all 17 planned diagrams, tools, priorities
- `docs/diagrams/current/c4-context.md` — C4 Level 1: system context (SPA in its environment)
- `docs/diagrams/current/c4-container.md` — C4 Level 2: containers (UI, backend, shared, Camoufox, Postgres, Redis)
- `docs/diagrams/current/generation-graph.md` — LangGraph generation flow (per-topic fan-out to X/THREADS/FACEBOOK)
- `docs/diagrams/current/posting-sequence.md` — End-to-end posting sequence (cron → generation → HITL → BullMQ → Camoufox → platform → verify → SSE)

All diagrams use Mermaid (GitHub renders natively).

**Directory structure created:**
```
docs/diagrams/
├── README.md
├── current/          ← 4 diagrams created
├── future/           ← empty (P1 priority — next step)
└── structurizr/      ← empty (for Structurizr DSL)
```

### 4. Competitive landscape research

Researched existing products on the market (via Exa MCP + web search). Key findings:

**Article syndication SaaS:**
- Article Distribution ($5/mo) — 37 platforms, canonical URL, AI rewrite, Chrome extension for Medium/Substack. **Closest competitor.**
- Texavor, Crier, OmniDistribute, posse-publisher — various approaches, all API-based

**Social media scheduling:**
- Postiz (34K stars, free self-hosted) — 30+ platforms, OAuth only, no browser automation
- SocialFlow (open source, Python) — **closest architectural analogue**: Playwright + multi-agent pipeline. But Chromium (detectable) + hardcoded selectors (drift).
- pendpost, usp — various approaches

**Participation (Reddit/Quora):**
- Replymer, SWARM, Prems AI — Reddit via API only. **Nobody does Quora.** SPA with Camoufox = only tool that automates Quora answers.

**SPA's unique combination (no competitor has all):**
- Camoufox (anti-detect) + LLM-in-the-loop (no selectors) + LangGraph (judge/HITL) + free-first LLM router

---

## Current state of the codebase

### What exists today (as-is)

SPA is a **hexagonal NestJS application** with:
- **22 NestJS modules** (generation, posting, engagement, orchestrator, replies, analytics, etc.)
- **6 ports** (IBrowserPort, ILlmPort, IContentPort, IEngagementDecisionPort, IPostingQueuePort, IPromptPort)
- **4 LangGraph graphs** (GenerationGraph, EngagementGraph, OrchestratorGraph, DialogueGraph)
- **3 browser posters** (X, Threads, Facebook) — selector-based, Camoufox
- **15 Prisma models** (Account, Post, Session, Interaction, etc.)
- **8 cron services** (7 dynamic + 1 watchdog)
- **15-provider LLM router** (free-first: Groq → SambaNova → Cerebras → ... → Ollama)
- **Vue 3 dashboard** (12 views, 9 Pinia stores)
- **BullMQ queues** (one per network×action, concurrency=1)
- **Langfuse** (prompt management + LLM tracing)

### What does NOT exist yet (to-be)

- No syndication (no Dev.to, Hashnode, LinkedIn, Medium, Substack, Reddit, Quora, Pinterest, Bluesky, Mastodon, Telegram)
- No article generation (only short social posts)
- No canonical URL management
- No IndexNow integration
- No LLM-in-the-loop browser engine
- No participation module (Reddit/Quora answers)
- No `POST_VERIFIED` event
- No SyndicationModule

---

## What the next agent should do

### Immediate next steps (P1 priority diagrams)

Create 5 future-state diagrams in `docs/diagrams/future/`:

1. **`c4-context.md`** — C4 Level 1 with 11 platforms + IndexNow + article syndication + participation
2. **`c4-container.md`** — C4 Level 2 with new services: BrowserAgentService, CanonicalUrlService, IndexNowService, TelegramAdapter, ParticipationModule
3. **`article-graph.md`** — Article generation LangGraph: `research_extract → outline → draft_article → judge_article → [refine loop] → set_canonical → save_to_db`
4. **`syndication-sequence.md`** — Full syndication flow: article cron → article graph → judge → auto-approve → BullMQ → Camoufox+LLM → publish → verify → canonical → IndexNow → social promo → social graph → publish to social platforms
5. **`phase-roadmap.md`** — Gantt diagram of Phase 0-5 with gates and dependencies

All using Mermaid (GitHub native rendering).

### Then: P2 priority diagrams

6. `docs/diagrams/future/llm-in-the-loop.md` — LLM vision browser interaction flow
7. `docs/diagrams/future/module-dependency.md` — Extended module graph with new modules
8. `docs/diagrams/current/ports-adapters.md` — Hexagonal ports & adapters (current)
9. `docs/diagrams/current/module-dependency.md` — Current module graph
10. `docs/diagrams/current/er-diagram.md` — Current Prisma ER
11. `docs/diagrams/current/llm-router.md` — LLM provider fallback chain
12. `docs/diagrams/future/participation-flow.md` — Reddit/Quora participation sequence
13. `docs/diagrams/future/er-diagram.md` — Extended ER with syndication fields

### Then: Implementation (Phase 0)

Start with Phase 0 issues (foundation):
- #3 (P0-01) — Prisma schema migration
- #4 (P0-02) — Extend IBrowserPort with LLM-in-the-loop stubs
- #53 (P0-02a) — ArticleGraphState type in @spa/shared
- #5 (P0-03) — SocialNetwork enum extension
- #6 (P0-04) — CanonicalUrlService
- #51 (P0-04a) — SyndicationModule wrapper
- #7 (P0-05) — Article generation graph skeleton
- #8 (P0-06) — Langfuse prompts
- #9 (P0-07) — Env vars
- #10 (P0-08) — Article generation cron
- #49 (P0-09) — BrowserFactory extension

---

## Key files to read

| File | Purpose |
|------|---------|
| `ROADMAP-SYNDICATION.md` | **Source of truth** for syndication feature. Phases, gates, tasks, architecture decisions. |
| `CLAUDE.md` | Operational guide for SPA. Non-obvious traps, architecture overview, commands. |
| `AGENTS.md` | Project conventions: Langfuse, orchestrator, browser memory, Playwright patch. |
| `docs/diagrams/README.md` | Index of all diagrams + tools + priorities. |
| `docs/diagrams/current/*.md` | 4 current-state diagrams (C4 context, C4 container, generation graph, posting sequence). |

## Key GitHub issues to read

| Issue | What |
|-------|------|
| #47 | **P1-00: LLM-in-the-loop browser engine** — critical path, blocks all new posters |
| #4 | P0-02: IBrowserPort extension with LLM stubs |
| #49 | P0-09: BrowserFactory extension for 10 persistent contexts |
| #50 | P1-04a: POST_VERIFIED event emitter |
| #51 | P0-04a: SyndicationModule wrapper |
| #52 | P2-04a: Social graph extension for new networks |
| #53 | P0-02a: ArticleGraphState type |

## Issue dependency graph (critical path)

```
Phase 0 (foundation):
  #3 (Prisma) → #5 (enums) → #49 (BrowserFactory)
  #4 (IBrowserPort stubs) → #47 (LLM engine)
  #53 (ArticleGraphState) → #7 (article graph skeleton)
  #6 (CanonicalUrlService) → #51 (SyndicationModule)
  #9 (env vars) → #10 (article cron)

Phase 1 (MVP):
  #47 (LLM engine) → #11 (Dev.to) → #14 (PostingService) → #50 (POST_VERIFIED)
  #7 (graph skeleton) → #15 (graph real impl) → #16 (auto-approve)
  #50 (POST_VERIFIED) → #17 (IndexNow)
  #50 (POST_VERIFIED) → #25 (social promo) → #52 (social graph extension)

Phase 2-5:
  #47 blocks ALL new platform posters (#11-13, #22-23, #26-27, #34-36)
  #48 (migrate existing posters) blocked by #47 + Gate 1
```

## Architecture decisions summary (for context)

### Camoufox-first
- All 11 platforms via Camoufox (anti-detect Firefox), not API
- Only Telegram uses Bot API
- No API keys — account credentials only
- Rationale: API = bot detection (LinkedIn penalizes, Reddit bans), many platforms lack free APIs

### LLM-in-the-loop
- No hardcoded CSS selectors — LLM vision resolves elements at runtime
- `act("click the Publish button")`, `verify("is the article published?")`, `extract(schema)`, `observe()`
- Eliminates selector drift (the main maintenance burden of browser automation)
- Reference: browser-use (107K stars), Stagehand, Skyvern
- Cost ~$0 via existing free-first 15-provider LLM router
- Existing X/Threads/Facebook posters migrate in Phase 5 (#48)

### Diagramming tools
- **Mermaid** — primary (GitHub renders natively)
- **Structurizr DSL** — for C4 model (model-as-code, multiple views)
- **LangGraph Studio** — for LangGraph visualization (auto-generated from code)
- **PlantUML** — for complex sequence diagrams (rendered to PNG)

## Uncommitted changes

The following files were modified/created but NOT committed:
- `ROADMAP-SYNDICATION.md` — updated (2 architecture decisions, P1-00, P5-08, LLM-in-the-loop tasks)
- `docs/diagrams/README.md` — new
- `docs/diagrams/current/c4-context.md` — new
- `docs/diagrams/current/c4-container.md` — new
- `docs/diagrams/current/generation-graph.md` — new
- `docs/diagrams/current/posting-sequence.md` — new

GitHub issues were updated via `gh` CLI (already pushed to GitHub).

## Commands

```bash
# View all issues
gh issue list --repo my-zodiac-ai/social-poster-agent --state all --limit 200

# View specific issue
gh issue view 47 --repo my-zodiac-ai/social-poster-agent

# Run SPA
pnpm dev:all              # start everything
pnpm dry-run              # safe browser test (intercepts publish)
pnpm test:unit            # unit tests
pnpm test:integration     # integration tests

# Diagrams — all render in GitHub Markdown, no tools needed
# For LangGraph Studio: open LangGraph Studio app, point to packages/backend
```
