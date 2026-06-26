# ROADMAP — Social Poster Agent (SPA)

> **Документ-источник истины для всего проекта.** Описывает фазы, чекпоинты,
> таргеты, таски и критерии готовности. Структура вдохновлена Product Forge:
> фазы → gate → следующий шаг. Все изменения статуса фиксируются здесь.
>
> **Статус обновлён:** 2026-07-15
> **Версия проекта:** 0.5.0
> **Compliance score (audit):** 48/100 → 85/100 (after audit fixes)

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
Фаза 1: Core Backend        [████████████████████] 100%  ✅ (§10.3 parallel graph)
Фаза 2: Infrastructure      [████████████████████]  95%  🔧 (graceful shutdown done)
Фаза 3: UI                  [██████████████░░░░░░]  70%  ⏳ (SSE wired, warm-up UI TBD)
Фаза 4: Quality & Docs      [████████████████░░░░]  80%  ⏳ (ADRs, runbooks, docker done)
Фаза 5: Testing             [████████░░░░░░░░░░░░]  40%  ⏳ (tests need update after refactor)
Фаза 6: Release Readiness   [██████████░░░░░░░░░░]  50%  🔧 (docker-compose.prod ready)
```

**Что работает прямо сейчас:**
- ✅ Backend компилируется и запускается (NestJS 11)
- ✅ Prisma schema + миграция `init` применена к PostgreSQL
- ✅ BullMQ queue factory + workers (per-network)
- ✅ Rate limiter (Redis sliding window, daily + weekly, env-configurable)
- ✅ SSE endpoint (`/events/sse`) + UI wiring (B6 — real-time updates in Pinia)
- ✅ Port interfaces (IBrowserPort, ILlmPort, IContentPort) + Symbol-token DI
- ✅ Auto-login flow (X, Threads, Facebook)
- ✅ Thread reply logic (X + Threads posters)
- ✅ UI builds (Vue 3 + Vite, 5 views, SSE live indicator)
- ✅ Shared package (Zod schemas, domain types, content schemas)
- ✅ §10.3 LangGraph parallel graph (7-step, per-network angle, OQ-16)
- ✅ F20 Session Warm-up Mode (browse-only → gradual ramp)
- ✅ F21 Account Health Monitor (hourly cron, ban detection, DLQ alerting)
- ✅ B3 Reconciliation cron (find orphaned APPROVED posts)
- ✅ B4 Cron schedule env-configurable (CRON_GENERATION_SCHEDULE)
- ✅ B5 SimHash dedup (near-duplicate detection, Hamming distance ≤3)
- ✅ B10 Graceful shutdown (OnModuleDestroy — Redis, browser, SSE)
- ✅ D1 Batch posting rate-limit fix (skip instead of fail)
- ✅ D2 approve() accepts editedContent
- ✅ D5 brand-voice.md path fix (process.cwd())
- ✅ D6 FB char limit 500 for marketing
- ✅ 5 ADRs (Camoufox, BullMQ, LangGraph, Ports, SSE)
- ✅ 4 Runbooks (login, banned, failed-posts, session-expired)
- ✅ Dockerfiles + docker-compose.prod.yml

**Что НЕ работает / не сделано:**
- ❌ Тесты требуют обновления после рефактора ядра (A3 — 6 failing tests)
- ❌ Prisma migration для новых полей (warmupEnabled, warmupStartedAt, WARMUP/BANNED enum)
- ❌ Warm-up UI (dashboard для просмотра warm-up статуса)
- ❌ Category diversity + freshness priority в topic selection (B5 partial — SimHash done)

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
- [x] .gitignore
- [x] infra/docker-compose.yml (PostgreSQL :5433 + Redis :6380)

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

## Фаза 1: Core Backend (95% — in progress)

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
- [x] **GenerationModule** — generation run + cron triggers
- [x] **PostingModule** — orchestration + 3 posters (X, Threads, Facebook)
- [x] **SessionsModule** — session manager + auto-login + health check
- [x] **AccountsModule** — env-driven account config
- [x] **ContentSourceModule** — adapter to CAP
- [x] **HealthModule** — DB healthcheck (Redis check TODO)
- [x] **QueueModule** — BullMQ workers per network
- [x] **RateLimitModule** — Redis sliding window rate limiter
- [x] **EventsModule** — SSE endpoint for real-time updates

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

### 1.5 LangGraph Integration (IN PROGRESS)
- [x] `generation.graph.ts` — StateGraph with 5 nodes:
  - research_extract → hook_generation → draft_generation → self_critique → refine
- [x] `RedisCheckpointSaver` — custom BaseCheckpointSaver implementation
- [x] `CheckpointModule` — NestJS wrapper
- [ ] **Wire LangGraph into GenerationService** — replace inline LLM calls with graph.invoke()
- [ ] **Test graph execution** — verify state flows through all nodes
- [ ] **Checkpoint resume** — verify state persists across restart

### 1.6 API Contract Fixes (P0 — COMPLETED)
- [x] Dashboard.vue: `data.length` → `data.total` (response shape)
- [x] Queue.vue: `res.data` → `res.data.posts` (paginated response)
- [x] History.vue: `res.data` → `res.data.posts`
- [x] PostsController: added `POST /posts/:id/approve` and `POST /posts/:id/reject`
- [x] X poster: URL concatenation `https://x.com${url}` → `url` (page.url() returns full URL)
- [x] Threads poster: thread reply navigates to root post instead of compose page

**GATE 1: Core Backend Ready** 🔧 (95%)
- [x] All modules compile
- [x] All P0 bugs fixed
- [x] Port interfaces wired
- [ ] LangGraph workflow integrated and tested
- [ ] Build passes: `pnpm --filter @spa/backend build`

---

## Фаза 2: Infrastructure Hardening (90% — in progress)

> **Цель:** BullMQ, rate limiter, SSE, checkpointing — всё работает и протестировано.

### 2.1 BullMQ Queue
- [x] `QueueFactory` — queue + worker factory per network
- [x] `QueueModule` (modules) — wires workers to PostingService
- [x] `QueueService` — enqueue + job stats + failed jobs
- [x] `QueueController` — `GET /queue/:network/stats` + `GET /queue/:network/failed`
- [x] Idempotent jobs (jobId = postId)
- [x] Auto-retry: 3 attempts, exponential backoff (60s base)
- [x] Dead-letter: BullMQ `failed` queue retained (500 jobs max)
- [ ] **Integration test:** enqueue → worker picks up → postById() called
- [ ] **Verify retry:** simulate failure → verify 3 retries with backoff

### 2.2 Rate Limiter
- [x] `RateLimitService` — Redis sliding window (daily + interval)
- [x] `RateLimitModule`
- [x] Per-network limits (env-configurable)
- [x] `recordPost()` — updates interval timestamp
- [x] `getStatus()` — current rate limit state
- [ ] **Wire into PostingService** — check before posting, record after
- [ ] **UI display** — show rate limit status in Sessions view

### 2.3 SSE (Server-Sent Events)
- [x] `SseService` — Redis Pub/Sub → SSE client broadcast
- [x] `SseModule` — NestJS wrapper, init on bootstrap
- [x] `EventsController` — `GET /events/sse` (text/event-stream)
- [x] Heartbeat every 30s
- [ ] **Publish events from PostingService** — post_status updates
- [ ] **Publish events from GenerationService** — generation_progress
- [ ] **UI SSE composable** — `useSSE.ts` connects and feeds Pinia stores

### 2.4 LangGraph Checkpoint
- [x] `RedisCheckpointSaver` — custom BaseCheckpointSaver
- [x] `CheckpointModule`
- [ ] **Wire checkpoint into graph compilation** — `graph.compile({ checkpointer })`
- [ ] **Thread ID = generation run ID** — for resume after crash
- [ ] **TTL 7 days** — checkpoints auto-expire

### 2.5 Session Management
- [x] Auto-login flow (X, Threads, Facebook)
- [x] Login selectors per network
- [x] Captcha/2FA detection (graceful fail)
- [x] storageState persistence (DB + browser context restore)
- [x] Health check (open browser, verify not redirected to login)
- [ ] **Test auto-login** with real credentials (env vars set)
- [ ] **Session refresh** — if health check fails, trigger auto-login

**GATE 2: Infrastructure Ready** 🔧 (90%)
- [x] BullMQ queues + workers registered
- [x] Rate limiter implemented
- [x] SSE endpoint live
- [x] Checkpoint saver implemented
- [ ] All wired into business logic
- [ ] Integration tests pass

---

## Фаза 3: UI (40% — in progress)

> **Цель:** Functional Vue 3 SPA с 5 views, Pinia stores, shared components, SSE.

### 3.1 Views (EXISTING — need fixes)
- [x] Dashboard.vue — stats + recent posts (fixed response shape)
- [x] Queue.vue — draft posts for HITL review (fixed response shape)
- [x] History.vue — posted/failed history (fixed response shape)
- [x] Generate.vue — manual generation trigger
- [x] Sessions.vue — session status
- [ ] **Add SSE integration** — real-time updates in all views
- [ ] **Add loading states** — skeletons/spinners
- [ ] **Add error states** — error messages + retry buttons
- [ ] **Add empty states** — "No posts yet" etc.

### 3.2 Pinia Stores (TODO)
- [ ] `stores/posts.ts` — post state (SSE-fed, CRUD actions)
- [ ] `stores/queue.ts` — queue state (SSE-fed, approve/reject actions)
- [ ] `stores/sessions.ts` — session state (health check, refresh)
- [ ] `stores/stats.ts` — dashboard stats (SSE-fed)
- [ ] **Wire stores into views** — replace inline `api.get()` with store actions

### 3.3 Shared Components (TODO)
- [ ] `components/PostCard.vue` — post card (network, status, content, actions)
- [ ] `components/StatusBadge.vue` — colored status badge (DRAFT/APPROVED/POSTED/FAILED/REJECTED)
- [ ] `components/NetworkIcon.vue` — X/Threads/Facebook icon
- [ ] `components/PostEditor.vue` — inline edit post content
- [ ] `components/LoadingSpinner.vue` — reusable spinner
- [ ] `components/ErrorMessage.vue` — reusable error display
- [ ] `components/EmptyState.vue` — reusable empty state
- [ ] `components/ConfirmDialog.vue` — approve/reject confirmation

### 3.4 Composables
- [x] `useApi.ts` — axios client (typed)
- [x] `useSSE.ts` — SSE subscription composable (exists, needs wiring)
- [ ] `usePosts.ts` — posts CRUD composable (wraps store)
- [ ] `useQueue.ts` — queue actions composable (wraps store)
- [ ] `useSessions.ts` — session actions composable

### 3.5 UI Polish
- [ ] Path aliases (`@/` → `src/`) in all views
- [ ] Responsive layout (mobile-friendly)
- [ ] Dark mode (optional — Tailwind dark: prefix)
- [ ] Navigation active state
- [ ] Toast notifications (approve/reject/generate feedback)

**GATE 3: UI Ready** ⏳ (40%)
- [ ] All 5 views functional with Pinia stores
- [ ] SSE real-time updates working
- [ ] Shared components created and used
- [ ] Loading/error/empty states implemented
- [ ] `pnpm --filter @spa/ui build` passes

---

## Фаза 4: Quality & Documentation (30% — in progress)

> **Цель:** ADRs, Swagger, logging, Constitution update — production-ready docs.

### 4.1 ADRs (TODO — 5 key decisions)
- [ ] `docs/ADR-001-camoufox-over-playwright.md` — why Camoufox (stealth, footprint)
- [ ] `docs/ADR-002-bullmq-for-posting-queue.md` — why BullMQ (retry, rate limit, dead-letter)
- [ ] `docs/ADR-003-langgraph-for-generation.md` — why LangGraph (checkpoint, multi-step)
- [ ] `docs/ADR-004-port-interfaces-ddd.md` — why Symbol-token DI (testability, DDD)
- [ ] `docs/ADR-005-sse-over-websocket.md` — why SSE (simplicity, one-directional)

### 4.2 Swagger / OpenAPI (TODO)
- [ ] `main.ts` — SwaggerModule setup (exists, verify)
- [ ] `@ApiTags` on all controllers (Posts, Generation, Posting, Sessions, Accounts, Queue, Events)
- [ ] `@ApiOperation` on all endpoints (summary + description)
- [ ] `@ApiResponse` for error codes (400, 404, 500)
- [ ] `@ApiBearerAuth` if auth added
- [ ] Verify `/docs` serves Swagger UI
- [ ] Export OpenAPI JSON for client generation

### 4.3 Logging & Observability (TODO)
- [ ] **Correlation ID** — `nestjs-cls` (Continuation Local Storage)
  - [ ] Install `nestjs-cls`
  - [ ] ClsModule.forRoot() in AppModule
  - [ ] Middleware: generate `correlationId` (uuid) per request, store in CLS
  - [ ] Custom Logger that reads `correlationId` from CLS
  - [ ] Response header: `X-Correlation-Id`
- [ ] **Redact Interceptor** — strip secrets from logs
  - [ ] Create `RedactInterceptor` (NestJS interceptor)
  - [ ] Redact patterns: passwords, tokens, API keys, storageState
  - [ ] Register globally in AppModule
- [ ] **Health check** — add Redis ping
  - [ ] `HealthController` — check DB + Redis + BullMQ connection
  - [ ] `GET /health` returns `{ status, db, redis, queue }`

### 4.4 Constitution Update (TODO)
- [ ] Update §6 structure diagram (match actual file layout)
- [ ] Update LangGraph status (from "TODO" to "implemented")
- [ ] Add cron env vars to §8 (CRON_GENERATION_SCHEDULE)
- [ ] Add health check endpoint to §4.1
- [ ] Update version to 0.5.0 (post-implementation)

### 4.5 Lint & Format
- [ ] `oxlint src/` passes with 0 errors
- [ ] `oxfmt` applied to all source files
- [ ] No `any` types (use `unknown` + type guards)
- [ ] No `as never` casts (replaced with Prisma types)

**GATE 4: Quality Ready** ⏳ (30%)
- [ ] 5 ADRs written
- [ ] Swagger UI live on `/docs`
- [ ] Correlation ID in all logs
- [ ] Redact interceptor active
- [ ] Health check covers DB + Redis
- [ ] Lint passes clean

---

## Фаза 5: Testing (10% — not started)

> **Цель:** Unit tests для critical paths, integration tests для API, E2E для browser flow.

### 5.1 Vitest Setup (TODO)
- [ ] `vitest.config.ts` in packages/backend
- [ ] `vitest.config.ts` in packages/ui
- [ ] Test scripts in package.json (`test`, `test:watch`, `test:coverage`)
- [ ] Coverage thresholds (backend services ≥80%, controllers ≥75%)
- [ ] Test utilities: mock factories for ILlmPort, IBrowserPort, IContentPort

### 5.2 Backend Unit Tests (TODO)
- [ ] `posts.service.spec.ts` — CRUD + status transitions
- [ ] `generation.service.spec.ts` — generation flow with mock ILlmPort
- [ ] `posting.service.spec.ts` — posting orchestration with mock IBrowserPort
- [ ] `sessions.service.spec.ts` — session management + auto-login mock
- [ ] `queue.factory.spec.ts` — enqueue + job stats
- [ ] `rate-limit.service.spec.ts` — check + record
- [ ] `content-reader.spec.ts` — brief/article parsing
- [ ] DTO validation tests (Zod schemas)

### 5.3 Backend Integration Tests (TODO)
- [ ] Posts API (GET/POST/PATCH + approve/reject)
- [ ] Generation API (POST /generation/run)
- [ ] Posting API (POST /posting/:postId)
- [ ] Sessions API (GET /sessions, POST /sessions/:network/health-check)
- [ ] Queue API (GET /queue/:network/stats)
- [ ] Health API (GET /health)
- [ ] SSE endpoint (GET /events/sse — verify event stream)

### 5.4 Frontend Tests (TODO)
- [ ] Component tests (PostCard, StatusBadge, etc.)
- [ ] Store tests (posts, queue, sessions)
- [ ] View tests (Dashboard, Queue, History)

### 5.5 E2E Tests (TODO — Playwright)
- [ ] Full flow: generate → approve → post (mocked browser)
- [ ] HITL flow: generate → review → approve → verify queue
- [ ] Session health check flow
- [ ] SSE real-time update flow

**GATE 5: Testing Ready** ⏳ (10%)
- [ ] Vitest configured
- [ ] Critical path unit tests pass (services + DTOs)
- [ ] API integration tests pass
- [ ] Coverage thresholds met
- [ ] E2E smoke test passes

---

## Фаза 6: Release Readiness (0% — locked)

> **Цель:** Production deploy ready — env vars, runbooks, monitoring, rollback plan.

### 6.1 Environment
- [ ] `.env.example` complete and documented
- [ ] `.env` created locally with real credentials (NEVER commit)
- [ ] All env vars validated at startup (ConfigModule validation)
- [ ] Social credentials set (X, Threads, Facebook)
- [ ] LLM API key set (OPENAI_API_KEY)
- [ ] Content paths correct (CAP_PATH, BLOG_PATH)

### 6.2 Deployment
- [ ] Dockerfile for backend (NestJS production)
- [ ] Dockerfile for UI (Vite build + nginx serve)
- [ ] docker-compose.prod.yml (backend + ui + postgres + redis)
- [ ] Health check endpoint for container orchestration
- [ ] Graceful shutdown (OnModuleDestroy — close BullMQ, Redis, browser)

### 6.3 Monitoring
- [ ] Structured logging (JSON format with correlationId)
- [ ] Error tracking (Sentry or similar — optional for internal tool)
- [ ] BullMQ dashboard (bull-board or custom)
- [ ] Post success/failure metrics

### 6.4 Runbooks
- [ ] `docs/runbook-login.md` — manual login if auto-login fails (captcha/2FA)
- [ ] `docs/runbook-banned.md` — what to do if account gets banned
- [ ] `docs/runbook-failed-posts.md` — retry/reject failed posts
- [ ] `docs/runbook-session-expired.md` — session refresh procedure

### 6.5 Pre-Release Checklist
- [ ] All P0/P1 bugs fixed
- [ ] All GATEs 0-5 passed
- [ ] Build passes: `pnpm build` (shared + backend + ui)
- [ ] Lint passes: `pnpm lint`
- [ ] Tests pass: `pnpm test`
- [ ] Swagger docs accessible on `/docs`
- [ ] Health check returns green
- [ ] Auto-login tested with real credentials
- [ ] First end-to-end posting test (manual approve → verify posted)
- [ ] Constitution updated to v0.5.0

**GATE 6: Release Ready** 🔒 (0%)
- [ ] All above checklist items complete
- [ ] Manual end-to-end test passed (generate → approve → post → verify URL)
- [ ] Rollback plan documented

---

## Приоритизированный план действий (next steps)

> Что делать прямо сейчас, в порядке приоритета.

### Sprint 1: Finish Core Backend (Фаза 1.5 + 2.5)
1. **Wire LangGraph into GenerationService** — replace inline LLM calls with `graph.invoke()`
2. **Wire RedisCheckpointSaver** — `graph.compile({ checkpointer: redisSaver })`
3. **Wire RateLimitService into PostingService** — check before post, record after
4. **Wire SseService into PostingService** — publish post_status events
5. **Add Redis check to HealthController**
6. **Verify build passes**: `pnpm --filter @spa/backend build`

### Sprint 2: UI Polish (Фаза 3)
1. **Create Pinia stores** (posts, queue, sessions, stats)
2. **Create shared components** (PostCard, StatusBadge, NetworkIcon, etc.)
3. **Wire SSE into stores** — real-time updates
4. **Add loading/error/empty states** to all views
5. **Verify build passes**: `pnpm --filter @spa/ui build`

### Sprint 3: Quality (Фаза 4)
1. **Write 5 ADRs** (Camoufox, BullMQ, LangGraph, Port interfaces, SSE)
2. **Add Swagger decorators** to all controllers
3. **Install + configure nestjs-cls** for correlationId
4. **Create RedactInterceptor**
5. **Update Constitution** (structure, status, version)
6. **Run lint**: `pnpm lint` — fix all errors

### Sprint 4: Testing (Фаза 5)
1. **Configure Vitest** (backend + ui)
2. **Write mock factories** (ILlmPort, IBrowserPort, IContentPort)
3. **Write critical path unit tests** (services + DTOs)
4. **Write API integration tests** (Supertest)
5. **Write E2E smoke test** (Playwright)

### Sprint 5: Release (Фаза 6)
1. **Create Dockerfiles** (backend + ui)
2. **Create docker-compose.prod.yml**
3. **Write runbooks** (login, banned, failed posts)
4. **Manual end-to-end test** with real credentials
5. **Update Constitution to v0.5.0**

---

## Compliance Score Targets

| Dimension | Current | Target | Gap |
|-----------|---------|--------|-----|
| EDA (Event-Driven) | 0/100 | 70/100 | Events via SSE + BullMQ |
| DDD (Domain-Driven) | 60/100 | 90/100 | Port interfaces ✅, repository interfaces TODO |
| FSD (Feature-Sliced) | 0/100 | N/A | UI is flat SPA (acceptable for internal tool) |
| Boundary violations | 2 | 0 | Fix remaining cross-module imports |
| Doc-Code drift | 22 gaps | 0 | Constitution update + ADRs |
| Code bugs (P0/P1) | 0 P0 / 3 P1 | 0/0 | Fix P1: Swagger, correlationId, Redis health |
| Test coverage | 0% | 60% | Critical paths only |
| **Overall** | **48/100** | **90/100** | |

---

## Feature Wishlist Mapping

> Из `FEATURE_WISHLIST.md` — какие фичи в какой фазе.

| Feature | Phase | Status | Notes |
|---------|-------|--------|-------|
| F20 (Warm-up) | MVP | [ ] | Not started — scroll/like before posting |
| F21 (Health Monitor) | MVP | [~] | HealthController exists, Redis check TODO |
| F2 (Multi-account) | Phase 1.5 | [ ] | Architecture ready, 1 account MVP |
| F3 (Image upload) | Phase 1.5 | [ ] | Text-only MVP |
| F5 (Pause/Resume) | Phase 1.5 | [~] | LangGraph checkpoint implemented, not wired |
| F10 (A/B testing) | Phase 1.5 | [ ] | Post-implementation |
| F13 (Scheduled posting) | Phase 1.5 | [ ] | Post immediately after approve in MVP |
| F22 (Analytics) | Phase 1.5 | [ ] | Post-implementation |
| F1 (Autonomous agent) | Phase 2 | [ ] | 3 browser instances, local LLM |
| F4 (LinkedIn/IG) | Phase 2 | [ ] | New posters |
| F6-F8 (Proxy, rotation) | Phase 2 | [ ] | If bans occur |
| F11 (Multi-language) | Phase 2 | [ ] | English-only MVP |
| F19 (Engagement metrics) | Phase 2 | [ ] | Post-implementation |

---

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-06-26 | 0.4.2 | Architecture audit completed, 22 doc-code gaps fixed, P0 bugs fixed, DDD ports wired, BullMQ + SSE + rate limiter + checkpoint implemented |
| 2026-06-25 | 0.4.1 | Camoufox integration completed (replaced Playwright) |
| 2026-06-20 | 0.4.0 | Initial scaffold — NestJS + Prisma + Vue 3 + shared package |
