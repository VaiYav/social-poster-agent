# C4 Container Diagram — Current State

> **Level 2:** Containers. Shows the internal structure of SPA — packages, processes, data stores.
> **As-is:** What exists today (3 platforms, no syndication).

```mermaid
C4Container
    title Social Poster Agent — Container Diagram (Current)

    Person(operator, "Operator", "Single admin user")

    System_Boundary(spa_boundary, "Social Poster Agent") {
        Container(ui, "Vue 3 Dashboard", "Vue 3 + Vite + Pinia + Tailwind", "12 views: Dashboard, Monitor, Queue, History, Generate, Sessions, Analytics, Trending, QuoteCards, FlowControl, Reports, Login. SSE for real-time updates.")
        Container(backend, "NestJS Backend", "NestJS 11 + TypeScript + Hexagonal", "22 modules: generation (LangGraph), posting (Camoufox), engagement, orchestrator, replies, analytics, accounts, sessions, etc. BullMQ workers, cron triggers, SSE publisher.")
        Container(shared, "@spa/shared", "TypeScript library", "Zod schemas + domain types. Single source-of-truth contract. Editing a schema breaks backend AND UI at compile time.")
        Container(camoufox, "Camoufox Browser", "Firefox fork (C++ anti-detect)", "Stealth browser automation. Pooled contexts for X/Threads. Persistent context for Facebook. Patched Playwright coreBundle.js.")
    }

    System_Ext(cap, "Content Agent Platform", "Sibling repo on disk")
    System_Ext(langfuse, "Langfuse", "LLM observability + prompts")
    System_Ext(llm, "LLM Providers", "15-provider fallback chain")

    ContainerDb(postgres, "PostgreSQL", "Postgres 16", "Accounts, posts, sessions, interactions, metrics, topics, content sources. Port 5433 (non-standard).")
    ContainerDb(redis, "Redis", "Redis 7", "BullMQ queues, LangGraph checkpoints, SSE pub/sub, flow-control flags, distributed locks. Port 6381 (non-standard).")

    System_Ext(x, "X.com")
    System_Ext(threads, "Threads")
    System_Ext(facebook, "Facebook")
    System_Ext(discord, "Discord")

    Rel(operator, ui, "Uses via browser (http://localhost:3101)")
    Rel(ui, backend, "REST API + SSE (http://localhost:3100/api/v1)")
    Rel(ui, shared, "Imports types + Zod schemas (compile-time)")
    Rel(backend, shared, "Imports types + Zod schemas (compile-time)")
    Rel(backend, camoufox, "Drives browser via Playwright protocol")
    Rel(backend, cap, "Reads files from disk (../content-agent-platform)")
    Rel(backend, langfuse, "Traces + prompt fetch (5-min cache, circuit breaker)")
    Rel(backend, llm, "LLM calls via LangChain ChatOpenAI (free-first chain)")
    Rel(backend, postgres, "Prisma ORM (port 5433)")
    Rel(backend, redis, "BullMQ + checkpoints + SSE + flags (port 6381)")
    Rel(camoufox, x, "Navigates, types, clicks (pooled context)")
    Rel(camoufox, threads, "Navigates, types, clicks (pooled context)")
    Rel(camoufox, facebook, "Navigates, types, clicks (persistent context)")
    Rel(backend, discord, "Webhook alerts (DLQ, bans, failures)")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Container details

### Vue 3 Dashboard (`@spa/ui`)
- **Port:** 3101
- **Stack:** Vue 3 + Vite + Pinia + Tailwind CSS
- **12 views:** Dashboard, Monitor, Queue, History, Generate, Sessions, Analytics, Trending, QuoteCards, FlowControl, Reports, Login
- **Real-time:** SSE (EventSource) for live updates — posting progress, queue status
- **Auth:** JWT cookie (`spa_token`), `AUTH_ENABLED` flag (default off = VPN-only)

### NestJS Backend (`@spa/backend`)
- **Port:** 3100 (`/api/v1`, Swagger at `/docs`)
- **Stack:** NestJS 11 + TypeScript, hexagonal architecture (ports & adapters)
- **22 modules:** generation, posting, engagement, orchestrator, replies, analytics, accounts, sessions, content-source, content-enhancements, quote-cards, recycling, trending, flow-control, autonomy, health-monitor, auth, posts, queue, SSE, health, warmup
- **4 LangGraph graphs:** GenerationGraph, EngagementGraph, OrchestratorGraph, DialogueGraph
- **8 cron services:** 7 dynamic + 1 permanent watchdog (all skip when ORCHESTRATOR_ENABLED=true)
- **Feature flags:** ENGAGEMENT_ENABLED, REPLIES_ENABLED, CAPTCHA_SOLVER_ENABLED, PROXY_ROTATION_ENABLED, QUOTE_CARDS_ENABLED, ORCHESTRATOR_ENABLED, AUTO_APPROVE_ENABLED, AUTH_ENABLED

### @spa/shared
- **Type:** TypeScript library (workspace package)
- **Role:** Zod schemas + domain types — single source-of-truth contract
- **Key:** Editing a schema breaks backend AND UI at compile time

### Camoufox Browser
- **Type:** Firefox fork patched at C++ level (anti-detect)
- **Why not Chromium:** Kills CDP detection vector. Chromium detectable via WebDriver, CDP.
- **Two context modes:**
  - **Pooled** (X, Threads): fresh context per post, `BROWSER_POOL_SIZE=3`, storageState saved between posts
  - **Persistent** (Facebook): single context, `user_data_dir` on disk, never pooled/closed — dodges "suspicious login" challenges
- **Memory:** `firefox_user_prefs` for memory optimization (~340-500 MB → less). Gated by `CAMOUFOX_MEMORY_PREFS=true`.
- **Patch:** `patch-playwright.js` fixes Camoufox Juggler protocol `Page.uncaughtError` missing `location` field.

### PostgreSQL
- **Port:** 5433 (non-standard, avoids collisions)
- **15 models:** AccountGroup, SocialAccount, Session, GenerationRun, Topic, ContentSource, PostThread, ThreadProgress, Post, PostVariant, PostMetrics, Interaction, IncomingComment, BrowsingSession, Admin

### Redis
- **Port:** 6381 (non-standard)
- **Multiple uses:**
  - BullMQ job queues (one per network×action: `spa-posting-x`, `spa-engagement-threads`, etc.)
  - LangGraph checkpoints (`RedisCheckpointSaver` — crash-resume)
  - SSE pub/sub (channel `spa:sse` — two separate connections: publish + subscribe)
  - Flow-control flags (`flow:pause_*` — pause without restart)
  - Distributed locks (multi-instance deployments)
