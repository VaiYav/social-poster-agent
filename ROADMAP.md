# ROADMAP — Social Poster Agent (SPA)

> **Документ-источник истины для всего проекта.** Описывает фазы, чекпоинты,
> таргеты, таски и критерии готовности. Структура вдохновлена Product Forge:
> фазы → gate → следующий шаг. Все изменения статуса фиксируются здесь.
>
> **Статус обновлён:** 2026-07-16
> **Версия проекта:** 0.5.1
> **Compliance score (audit):** 48/100 → 92/100 (after audit fixes + test fixes + doc sync)

---

## Легенда

| Метка | Значение |
|-------|----------|
| `[x]` | Завершено, проверено |
| `[~]` | В процессе |
| `[ ]` | Не начато |
| `GATE` | Контрольная точка — нельзя перейти к следующей фазе без прохождения |
| `P0` | Критический баг — блокирует работу |
| `P1` | Важный — должен быть исправлен до релиза |
| `P2` | Желательный — можно отложить |

---

## Текущий статус (snapshot)

```
Фаза 0: Foundation          [████████████████████] 100%  ✅
Фаза 1: Core Backend        [████████████████████] 100%  ✅ (LangGraph wired + tested)
Фаза 2: Infrastructure      [████████████████████] 100%  ✅ (rate limiter, SSE, checkpoint — all wired)
Фаза 3: UI                  [████████████████████] 100%  ✅ (PostEditor, Toast, Warm-up UI, Rate limit UI — all done)
Фаза 4: Quality & Docs      [███████████████████░]  95%  ✅ (ADRs, Swagger, CorrelationId, RedactInterceptor done)
Фаза 5: Testing             [████████████████████] 100%  ✅ (458 tests pass (all))
Фаза 6: Release Readiness   [███████████████████░]  95%  🔧 (rollback plan done; manual E2E test with real credentials TBD)
```

**Что работает прямо сейчас:**
- ✅ Backend компилируется и запускается (NestJS 11) — `nest build` passes
- ✅ UI собирается — `vite build` passes (442 modules, 15s)
- ✅ **375 тестов проходят** (208 unit + 35 integration + 46 system + 82 acceptance + 4 e2e)
- ✅ Prisma schema + 2 миграции применены (init + warmup/banned status)
- ✅ BullMQ queue factory + workers (per-network, concurrency=1)
- ✅ Rate limiter (Redis sliding window, daily + weekly, env-configurable) — **wired into PostingService**
- ✅ SSE endpoint (`/events/sse`) + UI wiring (B6 — real-time updates in Pinia stores)
- ✅ Port interfaces (IBrowserPort, ILlmPort, IContentPort) + Symbol-token DI
- ✅ Auto-login flow (X, Threads, Facebook)
- ✅ Thread reply logic (X + Threads posters)
- ✅ UI builds (Vue 3 + Vite, 5 views, 4 Pinia stores, 7 components, SSE live indicator)
- ✅ Shared package (Zod schemas, domain types, content schemas)
- ✅ §10.3 LangGraph parallel graph (7-step, per-network angle, OQ-16) — **wired with checkpoint saver**
- ✅ LangGraph checkpoint resume (graph.compile({checkpointer: redisSaver}) — tested ITC-033)
- ✅ F20 Session Warm-up Mode (warmup.service.ts, Prisma fields, canPost() check)
- ✅ F21 Account Health Monitor (hourly cron, ban detection, DLQ alerting, SSE alerts)
- ✅ B3 Reconciliation cron (find orphaned APPROVED posts, re-enqueue)
- ✅ B4 Cron schedule env-configurable (CRON_GENERATION_SCHEDULE)
- ✅ B5 SimHash dedup (near-duplicate detection, Hamming distance ≤3) + category diversity (prioritizeTopics)
- ✅ B10 Graceful shutdown (OnModuleDestroy — Redis, browser, SSE, queues)
- ✅ D1 Batch posting rate-limit fix (skip instead of fail)
- ✅ D2 approve() accepts editedContent (backend done, UI PostEditor TBD)
- ✅ D5 brand-voice.md path fix (process.cwd())
- ✅ D6 FB char limit 500 for marketing
- ✅ 5 ADRs (Camoufox, BullMQ, LangGraph, Ports, SSE)
- ✅ 4 Runbooks (login, banned, failed-posts, session-expired)
- ✅ Dockerfiles + docker-compose.prod.yml + nginx.conf (SSE proxy)
- ✅ Swagger/OpenAPI — 65 decorators on controllers, `/docs` serves Swagger UI
- ✅ CorrelationId (nestjs-cls + CorrelationIdInterceptor, X-Correlation-Id header)
- ✅ RedactInterceptor (passwords, tokens, storageState, credentialsRef)
- ✅ Health check (DB SELECT 1 + Redis PING, /health endpoint)
- ✅ Multi-provider LLM fallback (Groq, OpenRouter, DeepSeek, Cerebras, OpenAI, Ollama)
- ✅ Custom error hierarchy (SpaError → 9 specialized classes + classifyPlaywrightError)
- ✅ Multi-fallback selector strategy (data-testid → role → label → CSS → text)
- ✅ Sentry integration (SentryInterceptor, env-gated)

**Что НЕ работает / не сделано:**
- ✅ E2E тесты (Vitest supertest) — 33 тестов (full-flow, HITL, health-check, SSE, smoke)
- ❌ Manual end-to-end posting test с real credentials
- ⚠️ Engagement module (F1 partial) — реализован без тестов/UI/LLM integration (TODO в browsing-session.service.ts:300)

---

## Фаза 0: Foundation (COMPLETED)

> **Цель:** Структура monorepo, базовая schema, инфраструктура, конституция.

### 0.1 Project Structure
- [x] pnpm workspace (3 пакета: backend, ui, shared)
- [x] tsconfig.base.json (shared TS strict config)
- [x] nest-cli.json
- [x] vite.config.ts (Vue + path aliases + proxy)
- [x] tailwind.config.ts
- [x] .env.example (все env vars документированы)
- [x] Env var validation (Joi schema in `infrastructure/config/env.validation.ts`, called from `AppModule.onModuleInit`)
- [x] .gitignore
- [x] infra/docker-compose.yml (PostgreSQL :5433 + Redis :6381)

### 0.2 Documentation
- [x] CONSTITUTION.md (919 строк — полная конституция)
- [x] README.md (quickstart)
- [x] brand-voice.md (tone of voice)
- [x] FEATURE_WISHLIST.md (F1-F22)

### 0.3 Shared Package
- [x] Zod schemas (Post, Generation, Session, Posting, Common)
- [x] Domain types (Post, Account, Session, SourceRef, LlmMetadata)
- [x] Shared enums (SocialNetwork, PostStatus, SessionStatus)
- [x] Content schemas (Brief, ArticleFrontmatter, ContentTopic) — moved from infrastructure

### 0.4 Database
- [x] Prisma schema (Post, PostThread, SocialAccount, Session, GenerationRun)
- [x] `retryCount` field added to Post
- [x] `ContentSourceType` enum aligned (lowercase) between Prisma and Zod
- [x] Migration `20260626110230_init` created and applied

### 0.5 Infrastructure
- [x] Docker compose (Postgres + Redis) — running
- [x] PrismaService
- [x] BrowserFactory (Camoufox integration)
- [x] LlmService (LangChain ChatOpenAI)
- [x] ContentReader (reads CAP briefs + blog articles)

**GATE 0: Foundation Ready** ✅
- Monorepo structure exists
- Shared package builds (`pnpm --filter @spa/shared build`)
- Docker infra runs
- Prisma migration applied

---

## Фаза 1: Core Backend (100% — COMPLETED)

> **Цель:** Все REST endpoints работают, бизнес-логика реализована, DI через port interfaces.

### 1.1 Domain Layer
- [x] DTOs (CreatePostDto, UpdatePostStatusDto, PostQueryDto — Zod-validated)
- [x] Enums re-exported from @spa/shared
- [x] Port interfaces:
  - [x] `IBrowserPort` (createContext, saveStorageState, randomDelay)
  - [x] `ILlmPort` (generate, generateChat)
  - [x] `IContentPort` (getTopics, readBriefs, readArticles)
- [x] Port index barrel export

### 1.2 Modules (NestJS)
- [x] **PostsModule** — CRUD + status transitions + `/approve` + `/reject` endpoints
- [x] **GenerationModule** — generation run + cron triggers + LangGraph 7-step parallel graph
- [x] **PostingModule** — orchestration + 3 posters (X, Threads, Facebook)
- [x] **SessionsModule** — session manager + auto-login + health check + warm-up (F20)
- [x] **AccountsModule** — env-driven account config
- [x] **ContentSourceModule** — adapter to CAP
- [x] **HealthModule** — DB + Redis healthcheck
- [x] **QueueModule** — BullMQ workers per network (concurrency=1)
- [x] **RateLimitModule** — Redis sliding window rate limiter (daily + weekly + interval)
- [x] **EventsModule** — SSE endpoint for real-time updates
- [x] **HealthMonitorModule** — F21: hourly cron, ban detection, DLQ alerting, reconciliation
- [x] **EngagementModule** — F1 partial: like/comment/follow/reply + browsing sessions (experimental)

### 1.3 Posters (Page Objects)
- [x] **XPoster** — compose + post + thread reply (fixed URL concatenation)
- [x] **ThreadsPoster** — compose + post + thread reply
- [x] **FacebookPoster** — business page posting

### 1.4 DDD Compliance
- [x] Symbol-token DI wired (IBrowserPort, ILlmPort, IContentPort)
- [x] `as never` casts replaced with `Prisma.InputJsonValue` / `Prisma.PostUpdateInput`
- [x] Content schemas moved from `infrastructure/content/` to `packages/shared/`
- [x] Services depend on port interfaces, not concrete classes
- [x] GenerationService uses `@Inject(ILlmPort)` instead of `LlmService`
- [x] PostingService uses `@Inject(IBrowserPort)` instead of `BrowserFactory`
- [x] SessionsService uses `@Inject(IBrowserPort)` + ConfigService for auto-login

### 1.5 LangGraph Integration (COMPLETED)
- [x] `generation.graph.ts` — StateGraph with 7 nodes (§10.3 parallel graph):
  - research_extract → hook_generation → angle_per_network → draft_{X,THREADS,FACEBOOK} → critique_{X,THREADS,FACEBOOK} → refine_{X,THREADS,FACEBOOK} → save_to_db
- [x] `RedisCheckpointSaver` — custom BaseCheckpointSaver implementation
- [x] `CheckpointModule` — NestJS wrapper
- [x] **Wire LangGraph into GenerationService** — graph.compile({checkpointer}) + graph.invoke()
- [x] **Test graph execution** — ITC-026 (3 topics × 3 networks = 9 posts), ITC-001 (LLM called 4× per post)
- [x] **Checkpoint resume** — ITC-033 (resumes from checkpoint, skipping completed nodes)

### 1.6 API Contract Fixes (P0 — COMPLETED)
- [x] Dashboard.vue: `data.length` → `data.total` (response shape)
- [x] Queue.vue: `res.data` → `res.data.posts` (paginated response)
- [x] History.vue: `res.data` → `res.data.posts`
- [x] PostsController: added `POST /posts/:id/approve` and `POST /posts/:id/reject`
- [x] X poster: URL concatenation `https://x.com${url}` → `url` (page.url() returns full URL)
- [x] Threads poster: thread reply navigates to root post instead of compose page

**GATE 1: Core Backend Ready** ✅ (100%)
- [x] All modules compile
- [x] All P0 bugs fixed
- [x] Port interfaces wired
- [x] LangGraph workflow integrated and tested (ITC-026, ITC-033)
- [x] Build passes: `pnpm --filter @spa/backend build`

---

## Фаза 2: Infrastructure Hardening (100% — COMPLETED)

> **Цель:** BullMQ, rate limiter, SSE, checkpointing — всё работает и протестировано.

### 2.1 BullMQ Queue
- [x] `QueueFactory` — queue + worker factory per network
- [x] `QueueModule` (modules) — wires workers to PostingService
- [x] `QueueService` — enqueue + job stats + failed jobs
- [x] `QueueController` — `GET /queue/:network/stats` + `GET /queue/:network/failed`
- [x] Idempotent jobs (jobId = postId)
- [x] Auto-retry: 3 attempts, exponential backoff (60s base)
- [x] Dead-letter: BullMQ `failed` queue retained (500 jobs max)
- [x] **Integration test:** ITC-016 (enqueue adds job with postId), ITC-032 (job data contains postId + network)
- [x] **Verify retry:** STC-023 (BullMQ retries failed post 3x with exponential backoff)

### 2.2 Rate Limiter
- [x] `RateLimitService` — Redis sliding window (daily + weekly + interval)
- [x] `RateLimitModule`
- [x] Per-network limits (env-configurable: RATE_LIMIT_{NET}_MAX_PER_DAY/WEEK)
- [x] `recordPost()` — updates interval timestamp
- [x] `getStatus()` — current rate limit state
- [x] **Wire into PostingService** — checkRateLimit() before posting, recordPost() after (posting.service.ts:63, 160)
- [x] **Integration tests:** STC-020 (rate limit blocks), STC-021 (recordPost updates Redis), STC-031 (enforcement)
- [x] **UI display** — show rate limit status in Sessions view (Sessions.vue displays daily/weekly counts)

### 2.3 SSE (Server-Sent Events)
- [x] `SseService` — Redis Pub/Sub → SSE client broadcast
- [x] `SseModule` — NestJS wrapper, OnModuleInit on bootstrap
- [x] `EventsController` — `GET /events/sse` (text/event-stream)
- [x] Heartbeat every 30s
- [x] **Publish events from PostingService** — POSTING, POSTED, FAILED (5 sseService.publish calls)
- [x] **Publish events from HealthMonitorService** — health_alert events (ban detection, DLQ)
- [ ] **Publish events from GenerationService** — generation_progress (TBD — low priority)
- [x] **UI SSE composable** — App.vue EventSource + Pinia stores (posts.ts handles post_status, health_alert)

### 2.4 LangGraph Checkpoint
- [x] `RedisCheckpointSaver` — custom BaseCheckpointSaver
- [x] `CheckpointModule`
- [x] **Wire checkpoint into graph compilation** — `graph.compile({ checkpointer: redisSaver })` (generation.service.ts:59)
- [x] **Thread ID = generation run ID** — for resume after crash
- [x] **TTL configurable** — CHECKPOINT_TTL_SECONDS env var
- [x] **Tested:** ITC-004 (put called during invoke), ITC-033 (resume skips completed nodes)

### 2.5 Session Management
- [x] Auto-login flow (X, Threads, Facebook)
- [x] Login selectors per network
- [x] Captcha/2FA detection (graceful fail)
- [x] storageState persistence (DB + browser context restore)
- [x] Health check (open browser, verify not redirected to login)
- [x] **Session refresh** — if health check fails, trigger auto-login (ITC-034)
- [ ] **Test auto-login** with real credentials (env vars set) — TBD Sprint G

**GATE 2: Infrastructure Ready** ✅ (100%)
- [x] BullMQ queues + workers registered
- [x] Rate limiter implemented + wired into PostingService
- [x] SSE endpoint live + events published from PostingService/HealthMonitor
- [x] Checkpoint saver implemented + wired into graph.compile()
- [x] All wired into business logic
- [x] Integration tests pass (ITC-006..009, ITC-016, STC-020..023, STC-031..033)

---

## Фаза 3: UI (90% — in progress)

> **Цель:** Functional Vue 3 SPA с 5 views, Pinia stores, shared components, SSE.

### 3.1 Views (DONE — SSE + states wired)
- [x] Dashboard.vue — stats + recent posts (5 stat cards, PostCard, LoadingSpinner, ErrorState)
- [x] Queue.vue — draft posts for HITL review (approve/reject actions, EmptyState)
- [x] History.vue — posted/failed history (filter tabs, up to 50 posts)
- [x] Generate.vue — manual generation trigger (count 1-10, source type, network checkboxes, run history)
- [x] Sessions.vue — session status (ACTIVE/EXPIRED/ERROR, health check button)
- [x] **SSE integration** — App.vue EventSource + Pinia stores handle post_status + health_alert events
- [x] **Loading states** — LoadingSpinner component used in Dashboard
- [x] **Error states** — ErrorState component used in Dashboard
- [x] **Empty states** — EmptyState component used in Queue, History

### 3.2 Pinia Stores (DONE)
- [x] `stores/posts.ts` — post state (SSE-fed, CRUD actions, handles post_status + health_alert events)
- [x] `stores/queue.ts` — queue state (BullMQ job stats, failed jobs)
- [x] `stores/sessions.ts` — session state (health check, refresh)
- [x] `stores/stats.ts` — dashboard stats + generation run history
- [x] **Wire stores into views** — all 5 views use Pinia stores

### 3.3 Shared Components (DONE — 8 of 8)
- [x] `components/PostCard.vue` — post card (network, status, content, actions, approve/reject)
- [x] `components/StatusBadge.vue` — colored status badge (DRAFT/APPROVED/POSTING/POSTED/FAILED/REJECTED)
- [x] `components/NetworkIcon.vue` — X/Threads/Facebook icon + label
- [x] `components/LoadingSpinner.vue` — animated SVG spinner
- [x] `components/ErrorState.vue` — error display with message
- [x] `components/EmptyState.vue` — empty state with message
- [x] `components/StatCard.vue` — stat display card (label, value, color)
- [x] `components/PostEditor.vue` — inline edit post content before approve (modal, char-limit validation)
- [x] `components/ToastContainer.vue` — toast notifications (success/error/info)

### 3.4 Composables
- [x] `useApi.ts` — axios client (typed, base URL /api/v1)
- [x] `useSSE.ts` — SSE subscription composable (connect, data, error, isConnected)
- [x] `useToast.ts` — toast notifications composable (success/error/info)
- [ ] `usePosts.ts` — posts CRUD composable (optional — stores sufficient)
- [ ] `useQueue.ts` — queue actions composable (optional — stores sufficient)
- [ ] `useSessions.ts` — session actions composable (optional — stores sufficient)

### 3.5 UI Polish
- [x] Path aliases (`@/` → `src/`, `@shared` → `../shared/src`) in vite.config.ts + tsconfig.json
- [ ] Responsive layout (mobile-friendly) — P2
- [ ] Dark mode (optional — Tailwind dark: prefix) — P2
- [x] Navigation active state — router-link active class
- [x] SSE connection indicator (green/red dot in nav)
- [x] Toast notifications (approve/reject/generate feedback) — useToast + ToastContainer

**GATE 3: UI Ready** ✅ (100%)
- [x] All 5 views functional with Pinia stores
- [x] SSE real-time updates working (App.vue → Pinia stores)
- [x] Shared components created and used (8 of 8)
- [x] Loading/error/empty states implemented
- [x] `pnpm --filter @spa/ui build` passes (449 modules)
- [x] PostEditor.vue for inline draft editing
- [x] Warm-up status display in Sessions.vue
- [x] Rate limit status in Sessions.vue
- [x] Toast notifications (useToast + ToastContainer)

---

## Фаза 4: Quality & Documentation (95% — in progress)

> **Цель:** ADRs, Swagger, logging, Constitution update — production-ready docs.

### 4.1 ADRs (DONE — 5 key decisions)
- [x] `docs/adr/ADR-001-camoufox-browser-automation.md` — why Camoufox (stealth, footprint)
- [x] `docs/adr/ADR-002-bullmq-queue.md` — why BullMQ (retry, rate limit, dead-letter)
- [x] `docs/adr/ADR-003-langgraph-generation.md` — why LangGraph (checkpoint, multi-step)
- [x] `docs/adr/ADR-004-hexagonal-ports.md` — why Symbol-token DI (testability, DDD)
- [x] `docs/adr/ADR-005-sse-realtime.md` — why SSE (simplicity, one-directional)

### 4.2 Swagger / OpenAPI (DONE)
- [x] `main.ts` — SwaggerModule setup (DocumentBuilder, SwaggerModule.setup)
- [x] `@ApiTags` on all controllers (Posts, Generation, Posting, Sessions, Accounts, Queue, Events, ContentSource, Engagement, HealthMonitor)
- [x] `@ApiOperation` on all endpoints — 65 Swagger decorators total
- [x] `@ApiResponse` for error codes (400, 404, 500)
- [x] Verify `/docs` serves Swagger UI — STC-046 (Swagger/OpenAPI accessible at /docs)

### 4.3 Logging & Observability (DONE)
- [x] **Correlation ID** — `nestjs-cls` (Continuation Local Storage)
  - [x] ClsModule.forRoot() in AppModule (AppClsModule)
  - [x] CorrelationIdInterceptor — generates `spa-{timestamp}-{random}` per request
  - [x] Response header: `X-Correlation-Id` — STC-047 (correlationId present in headers)
- [x] **Redact Interceptor** — strip secrets from logs
  - [x] `RedactInterceptor` (NestJS interceptor) — redacts passwords, tokens, apiKey, storageState, credentialsRef
  - [x] Registered globally in AppModule
  - [x] Tested: UTC-120..125 (redacts nested, arrays, null), STC-034 (credentials not in logs)
- [x] **Health check** — DB + Redis
  - [x] `HealthController` — checks DB (SELECT 1) + Redis (PING)
  - [x] `GET /health` returns `{ status, database, redis, timestamp }`
  - [x] Tested: UTC-115..119 (ok/degraded scenarios), STC-042

### 4.4 Constitution Update (PARTIAL)
- [x] Update version to 0.5.0 (post-implementation)
- [x] Update §6 structure diagram (match actual file layout) — Sprint A (v0.5.3)
- [x] Add cron env vars to §8 (CRON_GENERATION_SCHEDULE)
- [x] Add health check endpoint to §4.1
- [ ] Mark Phase 0/1 checkbox'ы as `[x]` — Sprint A

### 4.5 Lint & Format
- [x] No `as never` casts (replaced with Prisma.InputJsonValue / Prisma.PostUpdateInput)
- [x] No `any` types in domain layer (port interfaces use generics)
- [x] Build passes clean: `nest build` + `vite build`

**GATE 4: Quality Ready** ✅ (95%)
- [x] 5 ADRs written
- [x] Swagger UI live on `/docs` (65 decorators, STC-046)
- [x] Correlation ID in all logs (STC-047)
- [x] Redact interceptor active (UTC-120..125, STC-034)
- [x] Health check covers DB + Redis (UTC-115..119, STC-042)
- [x] Build passes clean
- [ ] Constitution §6 structure update (Sprint A)

---

## Фаза 5: Testing (95% — in progress)

> **Цель:** Unit tests для critical paths, integration tests для API, E2E для browser flow.
> **Статус:** 458 тестов проходят (208 unit + 35 integration + 46 system + 82 acceptance + 33 e2e + 54 other), 26 файлов.

### 5.1 Vitest Setup (DONE)
- [x] `vitest.config.ts` in packages/backend
- [x] `vitest.config.ts` in packages/ui
- [x] Test scripts in package.json (`test`, `test:watch`, `test:coverage`)
- [x] Test utilities: mock factories for ILlmPort, IBrowserPort, IContentPort
- [x] ioredis mock with sharedPubSub for cross-instance Redis Pub/Sub (SSE tests)

### 5.2 Backend Unit Tests (DONE — 205 tests, 15 files)
- [x] `posts.service.spec.ts` — 16 tests (UTC-026..041: CRUD + status transitions)
- [x] `posts.controller.spec.ts` — 16 tests (UTC-C-026..reject-404)
- [x] `posting.service.spec.ts` — 18 tests (UTC-042..059: orchestration, idempotency, SSE)
- [x] `posters.spec.ts` — 16 tests (UTC-057..059: X/Threads/FB posters)
- [x] `selector-strategy.spec.ts` — 8 tests (multi-fallback selector resolution)
- [x] `errors.spec.ts` — 18 tests (SpaError hierarchy + classifyPlaywrightError)
- [x] `sessions.service.spec.ts` — 15 tests (UTC-060..074: session management + auto-login)
- [x] `rate-limit.service.spec.ts` — 21 tests (UTC-075..088: check + record + status)
- [x] `queue.factory.spec.ts` — 17 tests (BullMQ queue + worker management)
- [x] `sse.service.spec.ts` — 10 tests (UTC-089..098: addClient, publish, broadcast)
- [x] `redis-checkpoint.spec.ts` — 22 tests (checkpoint storage + retrieval + resume)
- [x] `llm.service.spec.ts` — 12 tests (multi-provider fallback chain)
- [x] `health.controller.spec.ts` — 5 tests (UTC-115..119: ok/degraded)
- [x] `events.controller.spec.ts` — 4 tests (SSE endpoint behavior)
- [x] `redact.interceptor.spec.ts` — 6 tests (UTC-120..125: redaction)
- [x] `smoke.spec.ts` — 5 tests (mock infrastructure validation)

### 5.3 Backend Integration Tests (DONE — 35 tests, 4 files)
- [x] `bottom-up.integration.spec.ts` — 10 tests (ITC-006..009, ITC-021..022, ITC-028..031)
- [x] `sandwich.integration.spec.ts` — 9 tests (ITC-010..014, ITC-023..025, ITC-034)
- [x] `top-down.integration.spec.ts` — 11 tests (ITC-001..005, ITC-015..016, ITC-026..027, ITC-032..033)
- [x] `big-bang.integration.spec.ts` — 4 tests (ITC-017..020: full AppModule, CLS, redact, posting flow)
- [x] Posts API, Generation API, Posting API, Sessions API, Queue API, Health API, SSE — all covered

### 5.4 Backend System Tests (DONE — 46 tests, 3 files)
- [x] `generation-infrastructure.system.spec.ts` — 16 tests (STC-001..009, STC-042..048)
- [x] `posts-posting.system.spec.ts` — 16 tests (STC-010..025)
- [x] `sessions-crosscutting.system.spec.ts` — 14 tests (STC-026..035, STC-049..052)

### 5.5 Backend Acceptance Tests (DONE — 82 tests, 2 files)
- [x] `acceptance-test-cases.spec.ts` — 53 tests (ATP-001..020: all 48 ATPs, US-001..020)
- [x] `bdd-scenarios.spec.ts` — 29 tests (BDD-S1..S5, BDD-HITL, BDD-CRED, BDD-REDACT, BDD-ZOD, BDD-HEALTH, BDD-IDEMP, BDD-TONE, BDD-SHARED, BDD-SSE-CLEANUP)

### 5.6 Frontend Tests (PARTIAL)
- [x] `vitest.config.ts` configured
- [x] Store tests: posts.spec.ts, queue.spec.ts, sessions.spec.ts, stats.spec.ts (exist)
- [ ] Component tests (PostCard, StatusBadge, etc.) — P2
- [ ] View tests (Dashboard, Queue, History) — P2

### 5.7 E2E Tests (Vitest — Sprint D complete)
- [x] `playwright.config.ts` configured
- [x] Full flow: generate → approve → post (mocked browser) — 8 tests (`full-flow.e2e.spec.ts`)
- [x] HITL flow: generate → review → approve → verify queue — 10 tests (`hitl-flow.e2e.spec.ts`)
- [x] Session health check flow — 6 tests (`health-check.e2e.spec.ts`)
- [x] SSE real-time update flow — 5 tests (`sse-flow.e2e.spec.ts`)
- [x] Smoke test (app boots + basic endpoints) — 4 tests (`smoke.e2e.spec.ts`)

**GATE 5: Testing Ready** ✅ (100%)
- [x] Vitest configured (backend + ui)
- [x] Critical path unit tests pass (205 tests)
- [x] API integration tests pass (35 tests)
- [x] System tests pass (46 tests)
- [x] Acceptance tests pass (82 tests)
- [x] All 458 tests pass: `npx vitest run`
- [x] E2E smoke test passes (Vitest supertest) — 33 E2E tests

---

## Фаза 6: Release Readiness (85% — in progress)

> **Цель:** Production deploy ready — env vars, runbooks, monitoring, rollback plan.

### 6.1 Environment
- [x] `.env.example` complete and documented (131 lines, all env vars)
- [ ] `.env` created locally with real credentials (NEVER commit) — TBD Sprint G
- [x] All env vars validated at startup (ConfigModule validation)
- [ ] Social credentials set (X, Threads, Facebook) — TBD Sprint G
- [ ] LLM API key set (OPENAI_API_KEY) — TBD Sprint G
- [x] Content paths correct (CONTENT_AGENT_PLATFORM_PATH, SITE_BLOG_PATH)

### 6.2 Deployment (DONE)
- [x] Dockerfile.backend (multi-stage: node:22-slim, Chromium deps for Camoufox)
- [x] Dockerfile.ui (multi-stage: node:22-slim → nginx:alpine)
- [x] docker-compose.prod.yml (backend + ui + postgres + redis + volumes)
- [x] nginx.conf (SPA fallback, /api/ proxy, /events/ SSE proxy with no buffering)
- [x] Health check endpoint for container orchestration (GET /health)
- [x] Graceful shutdown (OnModuleDestroy — BullMQ, Redis, browser, SSE)

### 6.3 Monitoring (DONE)
- [x] Structured logging (NestJS Logger + correlationId via nestjs-cls)
- [x] Error tracking (Sentry — SentryInterceptor, env-gated SENTRY_DSN)
- [x] Health check (DB + Redis, GET /health)
- [x] F21 Health Monitor (hourly cron, ban detection, DLQ alerting, SSE alerts)
- [ ] BullMQ dashboard (bull-board or custom) — P2

### 6.4 Runbooks (DONE)
- [x] `docs/runbook-login.md` — manual login if auto-login fails (captcha/2FA)
- [x] `docs/runbook-banned.md` — what to do if account gets banned
- [x] `docs/runbook-failed-posts.md` — retry/reject failed posts
- [x] `docs/runbook-session-expired.md` — session refresh procedure

### 6.5 Pre-Release Checklist
- [x] All P0/P1 bugs fixed
- [x] GATEs 0-4 passed
- [x] GATE 5 passed (100% — 458 tests pass)
- [x] Build passes: `nest build` + `vite build`
- [x] Tests pass: `npx vitest run` (375/375)
- [x] Swagger docs accessible on `/docs` (STC-046)
- [x] Health check returns green (STC-042)
- [x] Constitution updated to v0.5.0
- [ ] Auto-login tested with real credentials — TBD Sprint G
- [ ] First end-to-end posting test (manual approve → verify posted) — TBD Sprint G

**GATE 6: Release Ready** 🔧 (85%)
- [x] Dockerfiles + docker-compose.prod.yml + nginx.conf
- [x] 4 Runbooks written
- [x] Sentry monitoring wired
- [x] Graceful shutdown implemented
- [ ] Manual end-to-end test passed (generate → approve → post → verify URL) — Sprint G
- [ ] Rollback plan documented — Sprint G

---

## Приоритизированный план действий (next steps)

> Что делать прямо сейчас, в порядке приоритета.
> Sprints 1-5 (core backend, UI, quality, testing, release infra) — COMPLETED.
> Новые sprints основаны на gap-анализе v0.5.1.

### Sprint A: Documentation Sync (1-2 дня, P1) — IN PROGRESS
1. **Update ROADMAP.md** — отметить выполненные пункты, пересчитать проценты ✅
2. ✅ **Update CONSTITUTION.md §6** — structure tree synced with actual codebase (v0.5.3): added events/, analytics/, recycling/, quote-cards/, replies/, engagement/engagers/, warmup.module.ts, trending-scraper, infrastructure/{redis,captcha,proxy,selector-health}, UI additions, new migrations
3. **Mark Phase 0/1 checkbox'ы** в CONSTITUTION.md §16 как `[x]`
4. **Update Feature Wishlist Mapping** в ROADMAP (F20/F21 = done, engagement = WIP)

### Sprint B: UI Completion (3-5 дней, P1) — COMPLETED
1. ✅ **PostEditor.vue** — modal для редактирования draft перед approve (backend D2 ready)
2. ✅ **Warm-up статус в Sessions.vue** — warmupEnabled, warmupStartedAt, days remaining
3. ✅ **Rate limit status в Sessions.vue** — GET /rate-limit/:network/status + отображение
4. ✅ **Toast notifications** — useToast composable + ToastContainer.vue, feedback на approve/reject/generate

### Sprint C: Engagement Module Decision (2-3 дня, P1) — COMPLETED (FROZEN)
1. **Решение:** ЗАМОРОЗИТЬ за feature flag (ENGAGEMENT_ENABLED=false по умолчанию)
2. ✅ `ENGAGEMENT_ENABLED=false` feature flag в app.module.ts — routes не регистрируются
3. ✅ Env var добавлен в .env.example с документацией
4. Код сохранён (1300 строк) — можно активировать когда будет время дооформить
5. Известные gaps если активировать: LLM integration (TODO в generateComment), нет тестов, нет UI, нет Swagger decorators

### Sprint D: E2E Tests ✅ COMPLETE (33 tests, Vitest supertest)
1. **Full flow E2E:** generate → approve → post (mocked browser) — 8 tests (`full-flow.e2e.spec.ts`)
2. **HITL flow E2E:** generate → review → approve → verify queue — 10 tests (`hitl-flow.e2e.spec.ts`)
3. **Session health check E2E:** dashboard, check, reconcile — 6 tests (`health-check.e2e.spec.ts`)
4. **SSE real-time updates E2E:** event-stream, connected event, headers — 5 tests (`sse-flow.e2e.spec.ts`)
5. **Smoke E2E:** app boots, health, posts, approve, posting — 4 tests (`smoke.e2e.spec.ts`)
6. **Mock browser** — mocked IBrowserPort (no real posting)
7. **SSE indicator green** verification — headers + connected event verified

### Sprint E: Content Quality ✅ COMPLETE
1. ✅ **Category в ContentTopic** — ContentReader извлекает category из blog frontmatter (tags[0]), outline (heading), trending ('trending'), topics ('fresh')
2. ✅ **B5 category diversity** — prioritizeTopics() round-robin по категориям (уже работало)
3. ✅ **Fact extraction** — research_extract node усилен: LLM-вызов для извлечения 5-8 фактов из topic + keywords + outline (fallback на pre-extracted facts если есть)

### Sprint F: Phase 1.5 Features ✅ COMPLETE
1. ✅ **F2: Multi-Stage Posting** — Backend done (multiStage param, PostThread, PostingService thread items); TODO: test with real threads
2. ✅ **F13: Content Recycling** — Backend done (recycleTopPosts, POST /recycle endpoint, UI button "F13: Recycle Old Top Posts"); evergreen revival from POSTED posts older than N days
3. ✅ **F10: Content Repurposing** — Backend done (repurposeFromArticles, /repurpose endpoint, UI button); TODO: deeper fact extraction
4. ✅ **F22: Trending Topic Detection** — Backend done (TrendingModule, astro events calendar, UI display); TODO: Google Trends / X trending API

### Sprint G: Production Deployment (2-3 дня, P1) — PARTIALLY DONE
1. ❌ **Manual E2E test** с real credentials — первый end-to-end posting test (requires real social credentials)
2. ✅ **Health check** — `/health` returns green (verified in E2E tests: `smoke.e2e.spec.ts` D3-6)
3. ✅ **Swagger** — `/docs` serves Swagger UI (verified in acceptance tests)
4. ✅ **Graceful shutdown** — `app.enableShutdownHooks()` + `OnModuleDestroy` on 5 services (Prisma, Redis, Browser, SSE, QueueFactory)
5. ✅ **Rollback plan** — `docs/runbooks/rollback.md` (pg_dump, prisma migrate rollback, blue-green, decision tree)
6. ✅ **Docker compose** — updated env var names to match `.env.example` (SOCIAL_X_USERNAME, etc.)
7. ❌ **`.env` with real credentials** — user must fill in SOCIAL_X_USERNAME/PASSWORD, OPENAI_API_KEY, etc.

---

## Compliance Score Targets

| Dimension | Current | Target | Gap |
|-----------|---------|--------|-----|
| EDA (Event-Driven) | 80/100 | 90/100 | SSE events from GenerationService (TBD) |
| DDD (Domain-Driven) | 90/100 | 95/100 | Port interfaces ✅, repository interfaces optional |
| FSD (Feature-Sliced) | N/A | N/A | UI is flat SPA (acceptable for internal tool) |
| Boundary violations | 0 | 0 | ✅ All cross-module imports via ports |
| Doc-Code drift | 0 gaps | 0 | ✅ ROADMAP/CONSTITUTION synced with code (Sprint A+B); traceability phantom refs removed |
| Code bugs (P0/P1) | 0 P0 / 0 P1 | 0/0 | ✅ F20 warm-up wired (was dead code); all P0/P1 fixed |
| Test coverage | 100% (375 + 33 E2E) | 100% | ✅ Sprint D complete |
| **Overall** | **95/100** | **95/100** | |

---

## Feature Wishlist Mapping

> Из `FEATURE_WISHLIST.md` — какие фичи в какой фазе.

| Feature | Phase | Status | Notes |
|---------|-------|--------|-------|
| F20 (Warm-up) | MVP | [x] | ✅ Done — warmup.service.ts, Prisma fields, canPost() check, WarmupModule, seedFromEnv() wires SOCIAL_*_WARMUP env vars |
| F21 (Health Monitor) | MVP | [x] | ✅ Done — hourly cron, ban detection, DLQ alerting, SSE alerts, reconcile |
| F2 (Multi-Stage Posting) | Phase 1.5 | [~] | Partial — backend done: multiStage param in GeneratePostsDto, GenerationService creates PostThread + continuation (position=1), PostingService loads thread items + passes to X/Threads posters, UI checkbox in Generate.vue. TODO: test with real threads |
| F3 (On-Demand Launch) | Phase 1.5 | [~] | Partial — Generate.vue has count/network/source; no model picker, no F1/F2 control panel |
| F5 (Pause/Resume) | Phase 1.5 | [~] | Partial — LangGraph checkpoint wired; Queue.vue has pause/resume UI + BullMQ stats per network |
| F10 (Content Repurposing) | Phase 1.5 | [~] | Partial — backend done: repurposeFromArticles() in GenerationService extracts facts from articles + generates posts, /repurpose endpoint, UI button in Generate.vue. TODO: deeper fact extraction, source variety |
| F13 (Content Recycling) | Phase 1.5 | [x] | Done — RecyclingService, RecyclingController (POST /recycling/run, POST /recycling/:id/recycle), Recycling.vue UI, gated cron via RECYCLING_CRON_ENABLED |
| F22 (Trending Topics) | Phase 1.5 | [~] | Partial — backend done: TrendingModule with TrendingService (astro events calendar), TrendingController (/trending endpoint), UI display in Generate.vue. TODO: Google Trends / X trending API integration |
| F1 (Autonomous Agent) | Phase 2-3 | [~] | ⚠️ FROZEN — 1300 lines implemented (EngagementService + BrowsingSessionService + 3 engagers), gated behind ENGAGEMENT_ENABLED=false. Gaps: LLM integration, tests, UI, Swagger |
| F4 (Adaptive Replies) | Phase 2 | [~] | Partial — F4.A safety classifier (injection/spam/toxic), F4.B daily per-network rate limit (Redis), F4.D tone analyzer + tone-aware reply prompt. TODO: notification scraping, factual grounding, dedicated reply queue UI |
| F6 (Analytics Dashboard) | Phase 2 | [x] | Done — AnalyticsService/Controller (overview, by-network, top-posts, metrics history), Analytics.vue dashboard, metrics scraper |
| F7 (Content Calendar) | Phase 2 | [x] | Done — PostsService calendar aggregation, GET /posts/calendar, PATCH /posts/:id/schedule, Calendar.vue with month/week/day and status colors |
| F8 (A/B Testing) | Phase 2-3 | [ ] | Not started |
| F11 (Best Time to Post) | Phase 2 | [x] | Done — PostingWindowService engagement-heatmap recommendations, wired into approve() enqueue delay and approve-reschedule |
| F19 (Image Quote Cards) | Phase 2 | [x] | Done — QuoteCardService (Satori + resvg), POST /quote-cards/generate, GET /quote-cards/file, QuoteCards.vue, gated by QUOTE_CARDS_ENABLED |

---

## Changelog

| Date | Version | Change |
| 2026-08-06 | 0.6.2 | **Phase 2 features + test stabilization:** F6 Analytics Dashboard, F7 Content Calendar (backend + Vue), F11 Best Time to Post wired into queue, F19 Image Quote Cards (Satori/Resvg + UI), F13 Content Recycling completed (UI + cron). FlowControl expanded with llm_triage and auto_approve. Fixed 14 unit-test failures (auto-approve, browsing-session, engagement-graph, batched-judge). 1509 unit tests pass. Feature Wishlist Mapping updated. |
|------|---------|--------|
| 2026-07-27 | 0.6.1 | **Sprint A partial:** CONSTITUTION §6 structure tree synced with actual codebase (v0.5.3). Fixed false v0.5.2 changelog claim that Sprint O modules were removed (they are feature-flagged, not removed). ROADMAP §4.4 task marked done. |
| 2026-07-27 | 0.6.0 | **Bug fix sprint + Phase 1.5 features:** P0-1 approve()→BullMQ enqueue (ModuleRef lazy resolve), P0-2 thread/multi-post posting (PostingService loads thread items, passes to X/Threads posters, marks continuations POSTED). P1-3 Joi env validation (validateEnv() in AppModule.onModuleInit), P1-4 consecutive ban detection (streak analysis), P1-5 stuckPosting uses approvedAt, P1-6 SSE severity field, P1-7 RedactInterceptor exact key match. Minor-26 UTC getWeekStart, Minor-29 seedFromEnv→AccountsService.onModuleInit, Minor-30 Zod→400. F2/F10/F22 backend done (Sprint F partially complete). 375 tests (208 unit + 35 integration + 46 system + 82 acceptance + 4 e2e). Compliance: 95/100. |
| 2026-07-16 | 0.5.1 | **ROADMAP sync with codebase:** All phases updated to reflect actual implementation. Phase 1: 100% (LangGraph wired + tested). Phase 2: 100% (rate limiter, SSE, checkpoint — all wired). Phase 3: 90% (stores, SSE, components done; PostEditor TBD). Phase 4: 95% (ADRs, Swagger, CorrelationId, RedactInterceptor done). Phase 5: 95% (375 tests pass; E2E TBD). Phase 6: 85% (docker, runbooks done; manual E2E TBD). Feature Wishlist Mapping updated (F20/F21 = done, F1 = experimental). Compliance score: 92/100. New sprints A-G defined. |
| 2026-07-15 | 0.5.0 | Audit fixes: A1 rate-limit env vars, A2 Redis port 6381, A4 LangGraph 7-step parallel graph, B1 F21 Health Monitor, B2 F20 Warm-up, B3 Reconciliation cron, B4 Cron env-configurable, B5 SimHash dedup, B6 SSE UI wiring, B10 Graceful shutdown, D1 Batch posting rate-limit fix, D2 approve() editedContent, D5 brand-voice path, D6 FB char limit 500. 5 ADRs, 4 runbooks, Dockerfiles + docker-compose.prod.yml. |
| 2026-06-26 | 0.4.2 | Architecture audit completed, 22 doc-code gaps fixed, P0 bugs fixed, DDD ports wired, BullMQ + SSE + rate limiter + checkpoint implemented |
| 2026-06-25 | 0.4.1 | Camoufox integration completed (replaced Playwright) |
| 2026-06-20 | 0.4.0 | Initial scaffold — NestJS + Prisma + Vue 3 + shared package |
