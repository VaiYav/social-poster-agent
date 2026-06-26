---
project: Social Poster Agent (SPA)
status: concept / pre-implementation
version: 0.5.0
last_updated: 2026-07-15
owner: Valentyn Yakovlev (solo)
parent_repo: astro-ai-landing (lives in `social-poster-agent/` subdirectory)
---

# Constitution: Social Poster Agent (SPA)

> **Назначение документа.** Это концептуальная конституция — фиксирует WHAT и WHY
> на старте проекта, до написания кода. Архитектурные ADR-ы, технический план и
> спецификации появятся позже как отдельные артефакты (`docs/ADR-*.md`,
> `docs/plan.md`). Этот документ — точка отсчёта: всё, что здесь не описано,
> считается out-of-scope для MVP и требует явного изменения конституции.

---

## 1. Что мы строим (One-liner)

**Внутренний автономный агент, который берёт контент из content-agent-platform,
генерирует LLM-креативы для соц-сетей и постит их через браузерную автоматизацию
(Camoufox — stealth Firefox fork) по принципу "cron генерит → человек ревьюит → агент постит".**

> **Feature Wishlist:** дополнительные фичи (F1-F22) зафиксированы в
> [`FEATURE_WISHLIST.md`](./FEATURE_WISHLIST.md). MVP: F21 (Health Monitor),
> F20 (Warm-up). MVP+ (Phase 1.5): F2, F3, F5, F10, F13, F22. Phase 2-3:
> F1, F4, F6-F8, F11, F19.

---

## 2. Проблема и мотивация

### Проблема
- Ручной постинг в X.com / Threads / Facebook отнимает время и делается
  нерегулярно.
- Контент для постов выдумывается с нуля, хотя на сайте уже сотни
  SEO-статей + content-agent-platform генерирует новые briefs/topics.
- Нет истории что/когда/куда запостили, нет статуса, нет переиспользования.

### Мотивация
- **Автоматизировать рутину** генерации и постинга маркетинговых постов.
- **Переиспользовать контент** сайта и content-agent-platform как источник
  тем/фактов/хуков.
- **Иметь UI** для контроля: что сгенерировано, статус очереди, история постов,
  возможность ревьюить перед постингом.
- **Масштабировать** на несколько аккаунтов/сетей в будущем без переписывания.

### Почему НЕ через официальные API соц-сетей
- X API платный и ограниченный ($100+/mo за базовый постинг).
- Threads API нестабильный и требует Facebook Graph API + бизнес-аккаунт.
- Facebook Pages API требует верификацию приложения.
- Браузерная автоматизация = $0 + полный контроль над UX поста (треды,
  форматирование) + единый интерфейс для всех сетей.
- **Трейд-офф:** выше риск бана аккаунта → поэтому Camoufox (C++ level stealth) +
  HITL-гейт перед постингом + лимиты частоты.

---

## 3. Scope (MVP)

### 3.1 In-scope (MVP)

| # | Возможность | Описание |
|---|-------------|----------|
| 1 | **3 соц-сети** | X.com (Twitter), Threads, Facebook — текстовые посты |
| 2 | **Генерация креативов** | LLM (LangGraph.js) генерирует текст поста из контента content-agent-platform |
| 3 | **Per-network angle** | Разный угол/хук для каждой сети (X=punchy, Threads=narrative, FB=conversational) |
| 4 | **Cron-генерация** | По расписанию агент генерирует кандидаты-посты и складывает в очередь (статус `draft`) |
| 5 | **HITL-ревью** | Оператор видит draft-посты в UI, одобряет/редактирует/отклоняет |
| 6 | **Браузерный постинг** | После одобрения агент открывает Camoufox (stealth Firefox fork) сессию, логинится (persistent cookies), постит |
| 7 | **Persistent sessions** | Cookies/session state сохраняются, релогин только когда протухли |
| 8 | **Auto-retry постинга** | BullMQ: 3 попытки с exponential backoff (1мин, 5мин, 15мин), dead-letter queue |
| 9 | **Configurable rate limits** | Лимиты постинга per network/day/week — в env, меняются без кода |
| 10 | **История постов** | Каждый пост: сеть, текст, статус, timestamp, URL поста (если есть), ошибки |
| 11 | **UI (Vue 3 + Vite SPA)** | REST + shared Zod типобезопасность; очередь, история, генерация, одобрение |
| 12 | **Треды (X + Threads)** | Поддержка multi-post тредов — несколько постов как "паровоз" |
| 13 | **1 аккаунт на сеть** | Один аккаунт на каждую соц-сеть, архитектура готова к расширению |
| 14 | **Structured logging** | NestJS Logger (JSON format) для дебага и observability |

### 3.2 Out-of-scope (пост-MVP, явно зафиксировано)

- **Изображения/медиа** — только текст в MVP; image upload в phase 2.
- **LinkedIn / Instagram / TikTok** — phase 2+.
- **Несколько аккаунтов на сеть** — архитектура готова, но MVP = 1 аккаунт.
- **Автономный постинг без HITL** — сознательно отложено (риск бана).
- **Аналитика вовлечённости** (лайки/ретвиты/охват) — phase 2.
- **A/B-тестирование креативов** — phase 2.
- **Scheduling на конкретное время** — MVP = "постит сразу после одобрения";
  scheduled-posting в phase 2.
- **Multi-language посты** — MVP = English only.
- **Residential proxies** — MVP = Camoufox stealth (C++ level) без proxy; proxy в
  phase 2 если появятся баны.

### 3.3 Явные non-goals (НЕ будем делать никогда/в обозримом будущем)

- **Спам / масс-постинг / бот-фермы** — это инструмент для ОДНОГО бренда
  (My Zodiac AI), не SaaS для других.
- **Fake engagement** (накрутка лайков/боты) — out of scope, этично-серая зона.
- **DM / replies automation** — только исходящие посты, не взаимодействие.
- **Scraping контента конкурентов** — только свой контент.

---

## 4. Архитектура (high-level)

```
┌──────────────────────────────────────────────────────────────────┐
│                      astro-ai-landing repo                        │
│                                                                   │
│  ┌──────────────────┐    ┌──────────────────────────────────┐    │
│  │ content-agent-   │    │   social-poster-agent/            │    │
│  │ platform/ (Py)   │───▶│   pnpm workspace                  │    │
│  │                  │    │                                   │    │
│  │ • runs/brief-*   │    │  packages/shared/ ──────────────  │    │
│  │ • runs/topics-*  │    │  │ Zod schemas (shared contract) │    │
│  │ • runs/create-*  │    │  │ Domain types (Post, Account…) │    │
│  │ • content/blog/  │    │  │ DTO types (z.infer)           │    │
│  │   en/*.md        │    │  └──────────┬───────────────────  │    │
│  └──────────────────┘    │             │ shared import        │    │
│                          │  ┌──────────┴──────────┐          │    │
│                          │  │ packages/backend/    │          │    │
│                          │  │ NestJS 11            │          │    │
│                          │  │  ├─ REST controllers │          │    │
│                          │  │  ├─ Swagger/OpenAPI  │          │    │
│                          │  │  ├─ LangGraph.js     │          │    │
│                          │  │  ├─ Camoufox (stealth)│         │    │
│                          │  │  ├─ BullMQ workers   │          │    │
│                          │  │  ├─ Prisma ORM       │          │    │
│                          │  │  └─ NestJS Logger    │          │    │
│                          │  └────┬──────────┬──────┘          │    │
│                          │       │          │                 │    │
│                          │       ▼          ▼                 │    │
│                          │  ┌────────┐  ┌──────────────┐      │    │
│                          │  │Postgres│  │Redis (BullMQ)│      │    │
│                          │  │+Prisma │  │ rate limiter │      │    │
│                          │  └────────┘  └──────────────┘      │    │
│                          │             │ REST + Swagger       │    │
│                          │  ┌──────────┴──────────┐          │    │
│                          │  │ packages/ui/         │          │    │
│                          │  │ Vue 3 + Vite SPA     │          │    │
│                          │  │  ├─ Dashboard        │          │    │
│                          │  │  ├─ Queue/HITL       │          │    │
│                          │  │  ├─ History          │          │    │
│                          │  │  ├─ Generate         │          │    │
│                          │  │  ├─ Sessions         │          │    │
│                          │  │  └─ Pinia stores     │          │    │
│                          │  └─────────────────────┘           │    │
│                          └──────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ (Camoufox: 1 browser, multi-context)
                    ┌───────────────┴───────────────┐
                    │   x.com   threads.net   fb.com │
                    └───────────────────────────────┘
```

### 4.1 Компоненты

| Компонент | Технология | Ответственность |
|-----------|-----------|-----------------|
| **REST API** | NestJS controllers + @nestjs/swagger | REST endpoints для posts, generation, posting, sessions, accounts. Swagger/OpenAPI авто-документация на /docs |
| **API client (UI)** | axios + shared Zod types | Type-safe REST клиент в UI, типы из shared Zod schemas (z.infer) |
| **Shared contract** | packages/shared (TS) | Zod schemas, domain types, DTO types (z.infer) — импортируется и backend и UI |
| **LLM Orchestration** | LangGraph.js | Граф генерации: topic → hook → per-network angle → draft → critique → refine. Checkpoint в Redis для pause/resume |
| **Browser Automation** | Camoufox (Firefox fork) + camoufox-js | Stealth на C++ level (не JS injection). 1 browser, multi-context per network. Playwright-compatible API. Fingerprint rotation, humanize, geoip — built-in |
| **Posting Queue** | BullMQ + Redis | Очередь постинга, auto-retry (3x backoff), dead-letter queue, rate limiter |
| **БД** | PostgreSQL + Prisma ORM | Посты, очереди, аккаунты, сессии, история, rate limit config |
| **Content Source Adapter** | Node module | Чтение briefs/topics/articles из content-agent-platform/runs/ + content/blog/en/ |
| **Session Manager** | NestJS service | storageState (cookies), health-check, автологин из env-кредов (2FA выключен) |
| **Logger** | NestJS Logger (built-in) | Structured JSON format, redact secrets через interceptor, run-id correlation |
| **Cron** | @nestjs/schedule | Декларативные cron-jobs для генерации |
| **API docs** | @nestjs/swagger | OpenAPI 3.0 spec на /docs, Swagger UI для тестирования endpoints |

### 4.2 Поток данных (happy path)

```
1. Cron (2x/день) → триггерит GenerationRun
2. ContentSourceAdapter → читает content-agent-platform/runs/{brief,topics,create}-*/
   + content/blog/en/*.md → отбирает N тем
3. LangGraph workflow (per topic):
   a. topic → research_extract (LLM: извлечь факты/хуки)
   b. → hook_generation (LLM: 3-5 вариантов хука)
   c. → angle_per_network (3 угла: X=punchy, Threads=narrative, FB=conversational)
   d. → draft_{x,threads,facebook} (LLM: генерация per-network с учётом лимитов)
   e. → self_critique (LLM: оценить draft — кликбейт? факт-ошибка? off-brand?)
   f. → refine (LLM: финальная полировка)
   g. → сохраняет 3 Post в БД (status=draft, generation_run_id=...)
4. Оператор открывает UI (Vue 3 SPA, axios) → видит draft-посты → ревьюит
5. Оператор нажимает "Approve & Post" → REST POST /posts/:id/approve
   → Post.status=approved → BullMQ enqueue: posting job for this post
6. BullMQ worker picks up job → PostingService:
   a. Rate limit check (configurable per network/day)
   b. SessionManager → загружает storageState для сети
   c. Camoufox (1 browser, new context) → восстанавливает сессию
   d. health-check (если протухла → автологин из env credentials)
   e. навигация → ввод текста → submit
   f. для тредов → цикл post-by-post
   g. собирает URL поста / ошибки
   h. Post.status=posted (или failed) + metadata
7. При ошибке → BullMQ auto-retry: 3x backoff (1мин, 5мин, 15мин)
   → если все fail → dead-letter queue + UI alert
8. UI обновляется через SSE (Server-Sent Events) → история пополняется
```

---

## 5. Технологический стек

| Слой | Технология | Версия | Обоснование |
|------|-----------|--------|-------------|
| **Runtime** | Node.js | 22 LTS | Стабильность, совместимость с NestJS |
| **Package manager** | pnpm | 11.x | Единый с astro-ai-landing workspace |
| **Monorepo** | pnpm workspace | 11.x | packages/backend + packages/ui + packages/shared |
| **Backend framework** | NestJS | 11.x | DI, модульность, cron, Swagger, ecosystem. Знаком из MZAI backend |
| **API layer** | NestJS REST controllers | 11.x | Зрелое, предсказуемое. Guards, interceptors, pipes работают нативно |
| **API docs** | @nestjs/swagger | latest | OpenAPI 3.0 авто-генерация, Swagger UI на /docs |
| **Language** | TypeScript | 5.x strict | Типобезопасность, no `any` |
| **Shared contract** | packages/shared (TS) | — | Zod schemas, domain types, DTO types (z.infer) |
| **LLM orchestration** | LangGraph.js | latest stable | Граф генерации + checkpoint в Redis для pause/resume (F5) |
| **LLM provider** | OpenAI / Anthropic (через LangChain) | — | Переиспользование ключей из CAP, fallback |
| **Local LLM** | Ollama gemma4 | — | Бесплатный local LLM для F1 decision-making (GPU available) |
| **Browser automation** | Camoufox (Firefox fork) + camoufox-js | 0.11+ | Stealth на C++ level (не JS injection). Playwright-compatible API. Fingerprint rotation, humanize, geoip — built-in. ~200MB vs Chrome 800MB+ |
| **Job queue** | BullMQ | latest | Очередь постинга, auto-retry, rate limiter, dead-letter |
| **Cache/Queue store** | Redis | 7+ | BullMQ backend, rate limiter state, LangGraph checkpoints |
| **ORM** | Prisma | 6.x | Типобезопасность, миграции, PostgreSQL |
| **Database** | PostgreSQL | 16+ | Надёжность, реляционная модель, JSONB для storageState |
| **Frontend** | Vue 3 + Vite (SPA) | 3.5 / 6.x | Простой SPA, без SSR overhead. Знакомый Vue 3 |
| **Frontend state** | Pinia | 3.x | State management (знаком из MZAI) |
| **Frontend styling** | Tailwind v3 | 3.4 | Единый с основным проектом |
| **Frontend API client** | axios + shared Zod types | latest | REST клиент, типы из shared Zod schemas (z.infer) |
| **Real-time UI** | SSE (Server-Sent Events) | — | Updates очереди/статуса в UI без WebSocket complexity |
| **Validation** | zod | latest | Schema validation (shared contract, NestJS pipes) |
| **Logging** | NestJS Logger (built-in) | 11.x | Проще чем Pino, достаточно для internal tool. Redact через interceptor |
| **Linting** | oxlint + oxfmt | latest | Единый с основным проектом |
| **Testing** | Vitest | latest | Unit/integration; Playwright для E2E browser-флоу |
| **Cron** | @nestjs/schedule | latest | Декларативные cron-jobs в NestJS |

### 5.1 Почему этот стек

- **NestJS REST + Swagger** — зрелое, предсказуемое. Guards, interceptors,
  pipes работают нативно. Swagger/OpenAPI из коробки — авто-документация на
  /docs, можно тестировать endpoints. Для internal tool — pragmatically
  достаточно. Type safety через shared Zod schemas (z.infer → TS types).
- **Vue 3 + Vite SPA (вместо Nuxt 4)** — Nuxt = full framework для 5 страниц
  internal tool. SSR не нужен. Vite SPA проще, быстрее dev server, меньше
  зависимостей. Vue 3 + Pinia + Tailwind — знакомый стек.
- **pnpm workspace (3 пакета)** — packages/shared даёт единый контракт Zod
  schemas между backend и UI. Любое изменение schema → TypeScript ошибка
  в UI сразу (z.infer).
- **BullMQ + Redis** — надёжная очередь постинга с auto-retry (3x backoff),
  rate limiter, dead-letter queue. Без этого retry = ручной код, ненадёжно.
  Redis также хранит LangGraph checkpoints для F5 pause/resume.
- **LangGraph.js** — генерация поста это многошаговый pipeline (topic → hook →
  3 angles → 3 drafts → critique → refine). LangGraph даёт checkpoint/pause/
  resume (F5) + удобную абстракцию для multi-step LLM pipeline.
- **Camoufox (Firefox fork) + camoufox-js (1 browser, multi-context)** —
  stealth на C++ level (не JS injection — нельзя детектить через JS inspection).
  Playwright-compatible API — существующий код работает. Fingerprint rotation
  (каждый запуск = новая identity из real-world distribution), humanize
  (human-like mouse), geoip — built-in, не нужны отдельные плагины. ~200MB
  footprint vs Chrome 800MB+ — критично для 3 параллельных браузеров (F1).
  Один browser instance, переиспользуется через contexts per network.
  Для F1 (autonomous agent) — 3 browser instances.
- **NestJS Logger (built-in)** — для internal tool с 1 юзером performance
  логгера не критична. Проще чем Pino, не нужен nestjs-pino adapter. Redact
  secrets через interceptor.
- **PostgreSQL + Prisma** — реляционная структура (post → thread → account →
  session → rate_limit) лучше ложится на SQL; Prisma = типобезопасность.
- **SSE (Server-Sent Events)** — real-time updates очереди/статуса в UI без
  WebSocket complexity. Однонаправленный (server → client), достаточно для
  queue status updates.
- **Ollama gemma4 (local)** — бесплатный local LLM для F1 decision-making
  (like/comment/scroll). GPU available locally. Cloud (gpt-4o-mini) для
  генерации контента (качество важнее).

---

## 6. Структура проекта

```
social-poster-agent/               ← pnpm workspace root
├── CONSTITUTION.md                ← этот файл
├── brand-voice.md                 ← tone of voice для соц-постов (Phase 0)
├── README.md                      ← quickstart
├── pnpm-workspace.yaml            ← packages: backend, ui, shared
├── package.json                   ← root workspace package (scripts, devDeps)
├── tsconfig.base.json             ← shared TS config
├── infra/
│   ├── docker-compose.yml         ← PostgreSQL :5433 + Redis :6381 (local dev)
│   └── docker-compose.test.yml    ← PostgreSQL :5434 + Redis :6381 (test, tmpfs)
├── docker/
│   ├── Dockerfile.backend         ← Multi-stage: node:22-slim + Chromium deps
│   ├── Dockerfile.ui              ← Multi-stage: node:22-slim → nginx:alpine
│   ├── docker-compose.prod.yml    ← Production: backend + ui + postgres + redis
│   └── nginx.conf                 ← SPA fallback + /api/ proxy + /events/ SSE proxy
├── .env.example                   ← Template для env vars (см. §8)
├── docs/                          ← ADRs + runbooks
│   ├── ADR-001-camoufox-over-playwright.md
│   ├── ADR-002-bullmq-for-posting-queue.md
│   ├── ADR-003-langgraph-for-generation.md
│   ├── ADR-004-port-interfaces-ddd.md
│   ├── ADR-005-sse-over-websocket.md
│   ├── runbook-login.md
│   ├── runbook-banned.md
│   ├── runbook-failed-posts.md
│   └── runbook-session-expired.md
│
├── packages/
│   │
│   ├── shared/                    ← Zod schemas + domain types (no runtime deps)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           ← re-exports types + schemas
│   │       ├── schemas/
│   │       │   └── index.ts       ← All Zod schemas (Post, Generation, Session, Posting, Common)
│   │       └── types/
│   │           ├── domain.ts      ← Domain types (Post, Account, Session, SourceRef, LlmMetadata…)
│   │           └── enums.ts       ← Shared enums (SocialNetwork, PostStatus, SessionStatus…)
│   │
│   ├── backend/                   ← NestJS + REST + LangGraph + Camoufox + BullMQ
│   │   ├── package.json
│   │   ├── tsconfig.json          ← extends ../../tsconfig.base.json
│   │   ├── nest-cli.json
│   │   ├── prisma/
│   │   │   ├── schema.prisma      ← Post, PostThread, SocialAccount, Session, GenerationRun, Interaction, BrowsingSession
│   │   │   └── migrations/        ← init + warmup/banned status
│   │   └── src/
│   │       ├── main.ts            ← NestJS bootstrap + Swagger setup + Sentry init
│   │       ├── app.module.ts      ← Root module (16+ modules wired)
│   │       ├── domain/            ← Re-exports from @spa/shared (DTOs, enums, ports, errors)
│   │       │   ├── dtos.ts        ← Re-export DTOs from @spa/shared
│   │       │   ├── enums.ts       ← Re-export enums from @spa/shared
│   │       │   ├── errors.ts      ← SpaError hierarchy + classifyPlaywrightError
│   │       │   └── ports/         ← IBrowserPort, ILlmPort, IContentPort (Symbol-token DI)
│   │       ├── modules/           ← Feature modules (controller + service + module per domain)
│   │       │   ├── posts/         ← Post CRUD, status transitions, approve/reject
│   │       │   ├── generation/    ← LangGraph 7-step parallel graph, cron triggers, SimHash dedup
│   │       │   │   ├── generation.graph.ts   ← StateGraph (research→hook→angle→draft→critique→refine→save)
│   │       │   │   ├── generation.service.ts ← Orchestrates graph.invoke() with checkpoint
│   │       │   │   ├── simhash.ts            ← Near-duplicate detection (Hamming ≤3)
│   │       │   │   └── cron.service.ts       ← Env-configurable cron (CRON_GENERATION_SCHEDULE)
│   │       │   ├── posting/       ← BullMQ worker, Camoufox orchestration, rate limit, SSE
│   │       │   │   ├── posting.service.ts    ← postById() + postAllApproved() with rate limit + SSE
│   │       │   │   └── posters/   ← Page Objects: x/threads/facebook + selectors/ + base.poster
│   │       │   ├── sessions/      ← Session manager + auto-login + warm-up (F20)
│   │       │   │   ├── sessions.service.ts   ← getOrCreateSession, autoLogin, healthCheck
│   │       │   │   └── warmup.service.ts     ← F20: gradual ramp for new accounts
│   │       │   ├── accounts/      ← Social account config (env-driven, credentialsRef only)
│   │       │   ├── content-source/← Adapter to content-agent-platform
│   │       │   ├── queue/         ← BullMQ queues + workers (concurrency=1 per network)
│   │       │   ├── rate-limit/    ← Redis sliding window (daily + weekly + interval, env-driven)
│   │       │   ├── events/        ← SSE endpoint (GET /events/sse, heartbeat 30s)
│   │       │   ├── health/        ← Healthcheck (DB SELECT 1 + Redis PING)
│   │       │   ├── health-monitor/← F21: hourly cron, ban detection, DLQ alerting, reconciliation
│   │       │   └── engagement/    ← F1 (experimental): like/comment/follow/reply + browsing sessions
│   │       ├── infrastructure/
│   │       │   ├── prisma/        ← PrismaService
│   │       │   ├── llm/           ← Multi-provider LLM fallback (Groq, OpenRouter, DeepSeek, Cerebras, OpenAI, Ollama)
│   │       │   ├── browser/       ← Camoufox factory (stealth Firefox, 1 browser, multi-context)
│   │       │   ├── content/       ← File-system reader for content-agent-platform
│   │       │   ├── queue/         ← BullMQ queue + worker factory
│   │       │   ├── sse/           ← SSE service (Redis Pub/Sub → client broadcast)
│   │       │   ├── checkpoint/    ← RedisCheckpointSaver for LangGraph
│   │       │   ├── cls/           ← nestjs-cls (CorrelationId interceptor)
│   │       │   ├── logging/       ← RedactInterceptor (strip secrets from logs)
│   │       │   ├── filters/       ← ZodValidationFilter (ZodError → HTTP 400)
│   │       │   └── monitoring/    ← Sentry interceptor + init
│   │       └── config/            ← Config module (env validation)
│   │
│   └── ui/                        ← Vue 3 + Vite SPA
│       ├── package.json
│       ├── tsconfig.json          ← extends ../../tsconfig.base.json
│       ├── vite.config.ts         ← Vue plugin, path aliases, proxy /api → backend
│       ├── index.html
│       └── src/
│           ├── main.ts            ← Vue app bootstrap + Pinia + Tailwind
│           ├── App.vue            ← Layout + nav
│           ├── env.d.ts           ← Vite env type declarations
│           ├── assets/css/
│           │   └── main.css
│           ├── views/             ← Pages (Vue Router)
│           │   ├── Dashboard.vue  ← Stats + recent posts
│           │   ├── Queue.vue      ← Draft posts for review (HITL)
│           │   ├── History.vue    ← Posted/failed history
│           │   ├── Generate.vue   ← Manual generation trigger
│           │   └── Sessions.vue   ← Session status + health check
│           ├── composables/
│           │   ├── useApi.ts      ← axios client (typed via shared Zod)
│           │   └── useSSE.ts      ← SSE subscription composable
│           ├── stores/            ← Pinia stores (SSE-fed, CRUD actions)
│           │   ├── posts.ts       ← Post state (handles post_status + health_alert SSE events)
│           │   ├── queue.ts       ← Queue state (BullMQ job stats, failed jobs)
│           │   ├── sessions.ts    ← Session state (health check, refresh)
│           │   └── stats.ts       ← Dashboard stats + generation run history
│           ├── components/        ← Shared UI components (7 created)
│           │   ├── PostCard.vue   ← Post card (network, status, content, approve/reject)
│           │   ├── StatusBadge.vue← Colored status badge (6 statuses)
│           │   ├── NetworkIcon.vue← X/Threads/Facebook icon + label
│           │   ├── StatCard.vue   ← Stat display card
│           │   ├── LoadingSpinner.vue ← Animated SVG spinner
│           │   ├── ErrorState.vue ← Error display with message
│           │   └── EmptyState.vue ← Empty state with message
│           └── router/
│               └── index.ts       ← Vue Router setup (5 routes, lazy-loaded)
```

---

## 7. Доменная модель (упрощённая)

```
SocialAccount
  id: UUID
  network: enum { X, THREADS, FACEBOOK }
  handle: string          ← @myzodiacai
  credentials_ref: string ← env var name (НЕ сам пароль в БД)
  active: boolean

Session
  id: UUID
  account_id: FK → SocialAccount
  storage_state: JSONB    ← Playwright storageState (cookies, localStorage)
  status: enum { ACTIVE, EXPIRED, ERROR }
  last_health_check: timestamp
  created_at, updated_at

GenerationRun
  id: UUID
  triggered_by: enum { CRON, MANUAL }
  source_topics: JSONB    ← массив тем из content-source
  status: enum { RUNNING, COMPLETED, FAILED }
  started_at, completed_at
  post_ids: Post[]        ← сгенерированные посты

Post
  id: UUID
  generation_run_id: FK → GenerationRun (nullable для ручных)
  account_id: FK → SocialAccount
  network: enum { X, THREADS, FACEBOOK }
  content: text           ← финальный текст поста
  thread_position: int    ← 0 = root, 1+ = replies в треде
  thread_id: FK → PostThread (nullable)
  source_ref: JSONB       ← { type: 'brief'|'article'|'topic', path: '...', topic: '...' }
  status: enum { DRAFT, APPROVED, POSTING, POSTED, FAILED, REJECTED }
  post_url: string        ← URL после постинга (nullable)
  error_message: text     ← если FAILED
  retry_count: int        ← сколько BullMQ retry было (0-3)
  llm_metadata: JSONB     ← model, tokens, cost, prompt version, angle_type
  created_at, approved_at, posted_at

PostThread
  id: UUID
  account_id: FK → SocialAccount
  posts: Post[]           ← упорядочены по thread_position
  status: enum { DRAFT, APPROVED, POSTED, FAILED }

RateLimitConfig (env-driven, не в БД — читается из env)
  network: enum { X, THREADS, FACEBOOK }
  max_posts_per_day: int       ← default: 1
  max_posts_per_week: int      ← default: 5
  min_delay_between_posts_ms: int ← default: 300000 (5 мин)
```

> **BullMQ jobs** не хранятся в PostgreSQL — они в Redis. Post.retry_count
> обновляется из BullMQ worker после каждой попытки. Dead-letter jobs
> остаются в Redis (BullMQ `failed` queue) до ручного вмешательства.

---

## 8. Environment Variables

> **Безопасность:** логины/пароли соц-сетей — ТОЛЬКО в `.env`, никогда в БД,
> никогда в логах. В БД хранится только `credentials_ref` (имя env-переменной).

```env
# === Social credentials (NEVER commit) ===
# 2FA выключен на всех аккаунтах (OQ-3 resolved) — TOTP/SMS vars не нужны
SOCIAL_X_USERNAME=myzodiacai
SOCIAL_X_PASSWORD=...

SOCIAL_THREADS_USERNAME=...      # = Instagram username (Threads = IG-аккаунт)
SOCIAL_THREADS_PASSWORD=...      # = Instagram password

SOCIAL_FACEBOOK_EMAIL=...
SOCIAL_FACEBOOK_PASSWORD=...
SOCIAL_FACEBOOK_PAGE_SLUG=...    # slug бизнес-страницы для навигации (OQ-1)

# === LLM (переиспользуются из content-agent-platform/.env — OQ-6 resolved) ===
OPENAI_API_KEY=...               # тот же ключ что у CAP
ANTHROPIC_API_KEY=...            # optional fallback (тот же что у CAP)
LLM_DEFAULT_MODEL=gpt-4o-mini    # cheap tier для генерации постов
LLM_PROVIDER=openai              # | anthropic

# === Database (Docker локально — OQ-5 resolved) ===
DATABASE_URL=postgresql://spa:spa@localhost:5433/social_poster
# Postgres поднимается через infra/docker-compose.yml (порт 5433 чтобы не
# конфликтовать с системным Postgres если есть)

# === Redis / BullMQ (Docker локально — порт 6380) ===
REDIS_URL=redis://localhost:6380
# Redis поднимается через infra/docker-compose.yml (порт 6380 чтобы не
# конфликтовать с системным Redis если есть)

# === Rate limits (configurable — меняются без кода) ===
RATE_LIMIT_X_MAX_PER_DAY=1
RATE_LIMIT_X_MAX_PER_WEEK=5
RATE_LIMIT_THREADS_MAX_PER_DAY=1
RATE_LIMIT_THREADS_MAX_PER_WEEK=5
RATE_LIMIT_FACEBOOK_MAX_PER_DAY=1
RATE_LIMIT_FACEBOOK_MAX_PER_WEEK=5
RATE_LIMIT_MIN_DELAY_MS=300000   # 5 минут мин. задержка между постами

# === BullMQ retry config ===
BULLMQ_MAX_RETRIES=3
BULLMQ_RETRY_DELAY_MS=60000      # 1мин → 5мин → 15мин (exponential)

# === Content source ===
CONTENT_AGENT_PLATFORM_PATH=../content-agent-platform
SITE_BLOG_PATH=../content/blog/en

# === Browser (Camoufox — stealth Firefox fork) ===
CAMOUFOX_HEADLESS=true           # false для дебага (headed mode)
CAMOUFOX_HUMANIZE=true           # human-like mouse movement (built-in)
CAMOUFOX_GEOIP=true              # geolocation/timezone/locale spoofing (built-in)
CAMOUFOX_LOCALE=en-US            # target locale
CAMOUFOX_OS=windows              # | macos | linux (target OS for fingerprint)
CAMOUFOX_INSTALL_DIR=            # optional custom install path (containers/CI)
MAX_PARALLEL_BROWSERS=1          # 3 when F1 (Autonomous Agent) is active

# === Cron ===
CRON_GENERATION_SCHEDULE=0 9,21 * * *   # 2x/день в 9:00 и 21:00

# === API/UI ===
SPA_API_PORT=3100
SPA_UI_PORT=3101
SPA_API_PREFIX=/api/v1
SPA_SWAGGER_PATH=docs          # Swagger UI на /docs
# Auth: НЕТ (VPN-only — UI не exposed публично, доступ по сети/VPN/localhost)
```

---

## 9. Анти-детект стратегия (Camoufox — C++ level stealth)

> **Принцип:** ведём себя как человек, а не как бот. Лучше медленнее и
> надёжнее, чем быстро и забаненно.
>
> **Решение (OQ-25):** используем **Camoufox** — Firefox fork со stealth на
> C++ level (не JS injection). Playwright's internal Page Agent runs in a
> sandboxed world — websites cannot detect Playwright through JS inspection.
> Fingerprint rotation, humanize, geoip — built-in, не нужны отдельные плагины.

| Мера | Реализация |
|------|-----------|
| **Camoufox (stealth browser)** | Firefox fork, stealth на C++ level. `window.__playwright__binding__` и др. артефакты Playwright скрыты в sandboxed world. Не детектится через JS inspection. |
| **Fingerprint rotation (built-in)** | Каждый запуск = свежая identity из real-world distribution устройств. Navigator, WebGL, screen, fonts, WebRTC — всё консистентно спуфится на C++ level (не JS override). |
| **Humanize (built-in)** | Camoufox `humanize: true` — human-like mouse movement. Плюс 5-30с рандомные паузы между действиями, 2-5мин между постами в треде. |
| **Geoip (built-in)** | Camoufox `geoip: true` — geolocation, timezone, locale спуфятся на protocol level. WebRTC IP spoofing at C++ level. |
| **Лимит частоты** | Configurable per network: `RATE_LIMIT_{X,THREADS,FACEBOOK}_MAX_PER_DAY` (default: 1). Проверяется BullMQ worker перед постингом. |
| **Persistent sessions** | Cookies сохраняются через Playwright storageState, логинимся редко → реалистичный паттерн |
| **Headed режим для дебага** | `CAMOUFOX_HEADLESS=false` — видно что происходит |
| **Не 24/7** | Браузер открывается только на момент постинга, не висит постоянно |
| **Ручные сессии** | HITL-гейт = человек решает когда постить, нет автопостинга 24/7 |
| **~200MB footprint** | Camoufox = debloated Firefox (~200MB) vs Chrome 800MB+. Критично для 3 параллельных браузеров (F1 autonomous agent). |

### 9.1 Red flags (что НЕ делаем в MVP)
- ❌ Residential proxy (добавим в phase 2 если будут баны)
- ❌ Mass-following / mass-liking (out of scope вообще)
- ❌ Постинг чаще 1/день/сеть

> **Note:** Fingerprint spoofing на уровне Canvas/WebGL — **уже built-in в
> Camoufox** (C++ level), не overkill. Раньше было в red flags — теперь это
> бесплатный бонус от Camoufox.

### 9.2 План эскалации при бане
1. Аккаунт забанен → Post.status=FAILED + error_message с деталями
2. UI алертит оператора
3. Ручное разбирательство → appeal в соц-сети
4. Если баны систематические → phase 2: residential proxy + снижение частоты
   (fingerprint rotation уже работает из коробки Camoufox)

---

## 10. Content Source Integration

### 10.1 Источники (приоритет)

1. **content-agent-platform/runs/brief-*//brief.json** — SERP-grounded briefs
   с topic, target_queries, outline, entities. Лучший источник: уже
   SEO-оптимизированы, есть факты.
2. **content-agent-platform/runs/topics-*//topic-queue.json** — ranked topic
   queue, кластеры ключевых слов. Хороши для разнообразия тем.
3. **content-agent-platform/runs/create-*//report.json** — свежесозданные
   статьи с финальным текстом.
4. **content/blog/en/*.md** — fallback: парсинг frontmatter (title,
   description, answerCapsule, faq, seo.keywords) опубликованных статей.

### 10.2 Логика отбора тем

- **Дедупликация** — не постим про тему, которую уже постили за последние 14
  дней (по source_ref + SimHash на тексте поста).
- **Свежесть** — приоритет темам из свежих briefs/create-runs (последние 7
  дней).
- **Разнообразие** — не более 2 постов подряд на одну категорию (ai-astrology,
  compatibility, transits, и т.д.).
- **Лимит** — cron генерит 3-5 кандидатов за запуск (1 на сеть + запас).

### 10.3 LangGraph workflow генерации

```
[topic] → [research_extract] → [hook_generation] → [angle_per_network]
                                                          ↓
                        ┌──────────────────┬──────────────┴───────────────┐
                        ▼                  ▼                              ▼
                   [draft_x]          [draft_threads]              [draft_facebook]
                        │                  │                              │
                        ▼                  ▼                              ▼
                  [critique_x]      [critique_threads]          [critique_facebook]
                        │                  │                              │
                        ▼                  ▼                              ▼
                   [refine_x]         [refine_threads]            [refine_facebook]
                        │                  │                              │
                        └────────┬─────────┴───────────────────────────────┘
                                 ▼
                          [save_to_db: 3 Posts, status=draft]
```

- **research_extract** — извлекает ключевые факты/хуки из brief/article
- **hook_generation** — 3-5 вариантов хука (вопрос / утверждение / контр-интуиция)
- **angle_per_network** — 3 разных угла: X = punchy+hook-first, Threads =
  narrative+storytelling, FB = conversational+question-end. Каждый угол
  использует разный hook из предыдущего шага.
- **draft_*** — генерация текста per-network с учётом лимитов символов и tone
- **critique_*** — LLM оценивает свой draft per-network (кликбейт? факт-ошибка?
  off-brand? влезает в лимит?)
- **refine_*** — финальная полировка per-network, возвращает только текст
- **save_to_db** — 3 отдельных Post (по одному на сеть), все с одним
  generation_run_id и source_ref, status=draft

> **Per-network angle = разный контент, не адаптация одного.** X-пост и
> Threads-пост на одну тему будут выглядеть по-разному (разные хуки, разная
> структура). Это избегает повторов между сетями и повышает engagement.

---

## 11. Per-network особенности

### 11.1 X.com (Twitter)
- **Лимит:** 280 символов на пост (premium аккаунты — 25k, но не рассчитываем)
- **Треды:** поддерживаются — root tweet + replies, до ~25 в треде
- **Постинг:** `x.com/compose/post` → textarea → submit
- **URL поста:** извлекается из redirect после постинга

### 11.2 Threads (threads.net)
- **Лимит:** 500 символов на пост
- **Треды:** поддерживаются — root + replies
- **Постинг:** `threads.net/` → compose dialog → submit
- **Особенность:** Threads-аккаунт = Instagram-аккаунт (Meta ecosystem). Логин
  через Instagram-креды. IG-аккаунт My Zodiac AI уже существует (OQ-2 resolved).

### 11.3 Facebook (facebook.com)
- **Лимит:** ~63k символов, но для маркетинга ≤500
- **Треды:** НЕ поддерживаются (один пост = один блок текста)
- **Постинг:** **бизнес-страница** My Zodiac AI (OQ-1 resolved). Постинг через
  `facebook.com/<page-slug>/` → "Create post" → text → Publish. Бизнес-страница
  даёт выше reach + analytics, но сложнее UI постинга.
- **Особенность:** сложный UI, частые A/B-тесты интерфейса → хрупкие селекторы.
  Логин через основной FB-аккаунт → навигация на бизнес-страницу → постинг.

> **⚠️ Риск:** Facebook агрессивно детектит автоматизацию. Может потребоваться
> phase 2 переход на Facebook Pages API вместо браузера. Зафиксировать как
> known-risk в ADR.

---

## 12. UI (Vue 3 + Vite SPA) — минимальный

### 12.1 Страницы (Vue Router)

| Страница | Назначение |
|----------|-----------|
| `/` (Dashboard) | Сводка: draft-очередь (count), posted-today (count), failed (count), последние 5 постов |
| `/queue` | Список draft-постов с фильтром по сети; кнопки Approve / Edit / Reject / Post |
| `/history` | Полная история с фильтрами (сеть, статус, дата); клик → детали поста |
| `/generate` | Ручной триггер генерации: выбрать source (brief/article/topic), сеть, кол-во |
| `/sessions` | Статус сессий по аккаунтам (active/expired), кнопка "health check" |

### 12.2 Компоненты
- `PostCard` — карточка поста (сеть, текст, статус, действия)
- `PostEditor` — модалка для редактирования draft перед одобрением
- `StatusBadge` — цветной бейдж статуса
- `NetworkIcon` — иконка сети
- `GenerationRunList` — история запусков генерации

### 12.3 Auth
- **Нет auth (VPN-only).** UI и API не exposed публично — доступ только по
  localhost / VPN / SSH-туннелю. Внутренний инструмент для одного пользователя.
- REST endpoints не защищены — предполагается network-level isolation.
- Phase 2 (если понадобится публичный доступ): proper auth (Better Auth) +
  NestJS guards.

### 12.4 Real-time updates
- **SSE (Server-Sent Events)** для queue status и post status updates.
- NestJS emits SSE events при: post status change, BullMQ job lifecycle,
  generation progress.
- UI подписывается через `useSSE()` composable → Pinia store updates.

---

## 13. Безопасность

| Риск | Митигация |
|------|-----------|
| **Утечка паролей соц-сетей** | Только в `.env`, `.env` в `.gitignore`, `credentials_ref` в БД вместо пароля |
| **Утечка cookies сессии** | `storageState` в БД (PostgreSQL), не в файлах; БД за firewall |
| **LLM prompt injection из контента** | Контент проходит через LangGraph с изоляцией шагов; user-content не интерпретируется как инструкции |
| **Постинг нежелательного контента** | HITL-гейт — ничего не постится без явного одобрения оператора |
| **Доступ к UI/API извне** | **VPN-only** — нет auth, но UI не exposed публично. Доступ по localhost / VPN / SSH-туннелю. Network-level isolation. |
| **Логи с секретами** | NestJS Logger + redact interceptor (пароли, cookies, tokens автоматически вырезаются из логов) |
| **Redis без пароля** | Redis в Docker только на localhost (не exposed наружу). Phase 2: Redis AUTH если VPS. |

---

## 14. Тестирование

| Уровень | Инструмент | Что покрывает |
|---------|-----------|---------------|
| **Unit** | Vitest | Domain logic, content-source adapter, LangGraph nodes (mocked LLM) |
| **Integration** | Vitest + testcontainers (PostgreSQL + Redis) | Prisma repositories, session manager, BullMQ queue/retry, rate limiter |
| **Browser E2E** | `@playwright/test` (vanilla Chromium, без stealth) | UI flows: login → queue → approve → status update. Stealth не нужен — тестируем свой UI |
| **Posting E2E** | Camoufox against staging аккаунтов | Реальный постинг в test-аккаунты (НЕ прод) — опционально, manual |
| **Stealth verification** | Ручная проверка через bot-detection sites | `bot.sannysoft.com`, `creepjs` — периодически |

> **⚠️ Важно:** E2E тесты реального постинга дёргают прод-аккаунты → только
> manual trigger, никогда в CI. CI = mocked browser.

---

## 15. Риски и open questions

| # | Риск | Вероятность | Impact | Митигация / статус |
|---|------|-------------|--------|--------------------|
| R1 | Бан аккаунта за автоматизацию | Средняя | Высокий | Camoufox (C++ level stealth) + HITL + лимиты; план эскалации §9.2 |
| R2 | Facebook UI меняется → ломаются селекторы | Высокая | Средний | Page Object pattern + data-testid где возможно; мониторинг |
| R3 | ~~Threads требует Instagram-аккаунт~~ | ~~Средняя~~ | ~~Средний~~ | **Снято** — Threads = IG-аккаунт, уже существует (OQ-2). Логин через IG-креды |
| R4 | ~~2FA блокирует автоматический логин~~ | ~~Средняя~~ | ~~Средний~~ | **Снято** — 2FA выключен на всех аккаунтах (OQ-3). Если включится позже → TOTP-секрет в env + otpauth lib |
| R5 | LangGraph.js менее зрелый чем Python-версия | Низкая | Низкий | Fallback на линейный LangChain pipeline если граф unstable |
| R6 | content-agent-platform меняет формат runs/ | Низкая | Средний | Версионирование adapter + integration test на fixture |
| R7 | Cloudflare/captcha на логине | Средняя | Высокий | Persistent sessions (редкий логин) + автологин из env (OQ-8); при captcha → alert оператору для ручного вмешательства |
| R8 | Стоимость LLM для генерации | Низкая | Низкий | gpt-4o-mini / cheap tier; ~$0.003/пост (3 угла × draft+critique+refine) |
| R9 | ~~tRPC + NestJS integration (trpc-nest) less mature~~ | ~~Низкая~~ | ~~Средний~~ | **Снято (v0.4.0)** — reverted to NestJS REST. trpc-nest больше не используется |
| R10 | BullMQ job stuck in active state (browser hang) | Средняя | Средний | Job timeout (5 мин) + BullMQ `stalledInterval` check; manual retry из UI |

### Resolved decisions (answered 2026-06-26)

| OQ | Вопрос | Решение | Влияние |
|----|--------|---------|---------|
| OQ-1 | Facebook — личная или бизнес-страница? | **Бизнес-страница** My Zodiac AI | §11.3: постинг через `/pages/` UI; выше reach + analytics; сложнее селекторы |
| OQ-2 | Threads = Instagram-аккаунт? | **Да, IG-аккаунт уже есть** | §11.2: Threads-логин = Instagram-логин; один набор кредов для Threads |
| OQ-3 | 2FA на аккаунтах? | **Выключен на всех 3** | §8/§9: убраны TOTP/SMS env vars; автологин проще; ниже security — компенсируем Camoufox stealth + лимитами |
| OQ-4 | Есть ли аккаунты? | **Все 3 созданы** (X, Threads/IG, FB-страница) | Phase 1 стартует без задержки на создание аккаунтов |
| OQ-5 | PostgreSQL — где? | **Docker локально** (`infra/docker-compose.yml`) | Изолированная БД, легко снести/пересоздать; zero зависимостей от MZAI backend |
| OQ-6 | LLM-ключи? | **Те же что у content-agent-platform** | Переиспользование `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` из CAP `.env`; один биллинг |
| OQ-7 | Brand voice документ? | **Нет — создадим `brand-voice.md` в Phase 0** | Phase 0 добавлен action item; tone: mystical-but-grounded / accessible / empowering |
| OQ-8 | First-login flow? | **Авто-логин сразу** | Агент логинится сам из env-кредов с первого запуска; выше риск captcha → persistent sessions + relogin fallback |

### Resolved decisions v0.3.0 (architecture brainstorm 2026-06-26)

| OQ | Вопрос | Решение | Влияние |
|----|--------|---------|---------|
| OQ-9 | API layer: REST или tRPC? | **~~tRPC (trpc-nest)~~ → NestJS REST + Zod** (v0.4.0) | v0.3.0: tRPC. v0.4.0: reverted to REST — trpc-nest community-пакет, конфликт с NestJS парадигмой. REST + Swagger + shared Zod schemas для type safety |
| OQ-10 | Структура проекта? | **pnpm workspace: backend + ui + shared** | packages/shared — Zod schemas + domain types; чистое разделение deps; tsconfig.base.json |
| OQ-11 | Очередь постинга? | **BullMQ + Redis** | Auto-retry 3x backoff (1мин, 5мин, 15мин); dead-letter queue; rate limiter; Redis в docker-compose :6380 |
| OQ-12 | Логирование? | **~~Pino~~ → NestJS Logger (built-in)** (v0.4.0) | v0.3.0: Pino. v0.4.0: NestJS Logger — проще, не нужен adapter, достаточно для 1 юзера. Redact через interceptor |
| OQ-13 | Auth для UI? | **Нет auth (VPN-only)** | Убран ApiTokenGuard; UI/API не exposed публично; network-level isolation; Phase 2 = proper auth если понадобится |
| OQ-14 | Retry при ошибке постинга? | **Auto-retry (3x backoff)** | BullMQ: 3 попытки, exponential backoff (1мин, 5мин, 15мин); dead-letter queue + UI alert если все fail |
| OQ-15 | Rate limiting? | **Configurable (env)** | `RATE_LIMIT_{NETWORK}_MAX_PER_DAY/WEEK` в env; проверяется BullMQ worker перед постингом; меняется без кода |
| OQ-16 | Контент стратегия? | **Разный angle per network** | LangGraph генерит 3 разных поста per topic (X=punchy, Threads=narrative, FB=conversational); не адаптация одного текста |
| OQ-17 | Browser lifecycle? | **1 browser, multi-context** | Один Playwright browser instance; contexts per network; переиспользование; меньше памяти |
| OQ-18 | Деплой? | **TBD — локально пока** | Начинаем локально (docker-compose); VPS + Docker compose потом; serverless исключён (Playwright persistent browser) |
| OQ-19 | Brand voice? | **Статичный .md файл** | brand-voice.md как часть system prompt; DB+UI редактор в phase 2 если захочется A/B test tone |

### Resolved decisions v0.4.0 (pragmatism review 2026-06-26)

| OQ | Вопрос | Решение | Влияние |
|----|--------|---------|---------|
| OQ-20 | UI framework? | **Vue 3 + Vite SPA (вместо Nuxt 4)** | Nuxt = full framework для 5 страниц. SSR не нужен. Vite SPA проще, быстрее. Pinia + Tailwind + Vue Router |
| OQ-21 | API docs? | **NestJS Swagger (@nestjs/swagger)** | OpenAPI 3.0 на /docs, Swagger UI для тестирования. Раз REST — Swagger из коробки |
| OQ-22 | Real-time UI updates? | **SSE (Server-Sent Events)** | Вместо tRPC subscription (убран) или WebSocket. Однонаправленный server→client, достаточно для queue/status |
| OQ-23 | Local LLM? | **Ollama gemma4 (GPU available locally)** | Бесплатный local LLM для F1 decision-making. Cloud (gpt-4o-mini) для генерации контента |
| OQ-24 | LangGraph.js purpose? | **Checkpoint/pause/resume + абстракция** | Обе причины. Checkpoint в Redis для F5. Удобная абстракция для multi-step LLM pipeline |
| OQ-25 | Browser stealth approach? | **Camoufox (Firefox fork, C++ level stealth)** | Вместо `playwright-extra` + `puppeteer-extra-plugin-stealth` (JS injection — детектится современными anti-bot системами). Camoufox модифицирует Firefox на C++ level: fingerprint rotation (каждый запуск = новая identity), humanize mouse, geoip, WebRTC spoofing — всё built-in. Playwright-compatible API (camoufox-js). ~200MB vs Chrome 800MB+ — критично для F1 (3 параллельных браузера). Sandbox изолирует Playwright Page Agent от page JS — невозможно детектить автоматизацию |

### Remaining open questions (появятся при реализации)

_Пока нет — все стартовые закрыты. Новые OQ добавляются сюда по мере возникновения._

---

## 16. Roadmap (фазы)

### Phase 0 — Scaffold (эта конституция) — COMPLETED
- [x] Зафиксировать концепцию (этот документ)
- [x] Закрыть все 8 open questions v0.2.0 (§15)
- [x] Закрыть 11 open questions v0.3.0 (§15 Resolved decisions v0.3.0)
- [x] Создать `brand-voice.md` — tone of voice для соц-постов (OQ-7)
- [x] **F20: Session Warm-up Mode** — опция для новых аккаунтов (browse-only → gradual ramp)
- [x] Создать pnpm workspace: packages/{backend,ui,shared}
- [x] packages/shared: Zod schemas, domain types, DTO types (z.infer)
- [x] packages/backend: NestJS + REST + Swagger + Prisma + BullMQ
- [x] packages/ui: Vue 3 + Vite SPA + Pinia + Tailwind + Vue Router
- [x] `infra/docker-compose.yml` — PostgreSQL :5433 + Redis :6381 (OQ-5)
- [x] `.env.example` + Prisma schema (с retry_count, rate limit config)
- [x] tsconfig.base.json (shared TS config для всех 3 пакетов)
- [x] pnpm-workspace.yaml (packages: backend, ui, shared)

### Phase 1 — MVP (3 сети, HITL, persistent sessions, REST, BullMQ) — COMPLETED
- [x] Content-source adapter (читает content-agent-platform runs + blog)
- [x] LangGraph workflow: per-network angle generation (OQ-16) — 7-step parallel graph
- [x] Camoufox browser factory (1 browser, multi-context — OQ-25)
- [x] Session manager (storageState save/load/health-check)
- [x] BullMQ queue + worker (auto-retry 3x backoff — OQ-14)
- [x] Rate limiter (configurable env — OQ-15) — wired into PostingService
- [x] Posting service для X.com (включая треды)
- [x] Posting service для Threads (включая треды)
- [x] Posting service для Facebook
- [x] NestJS REST controllers + Swagger (posts, generation, posting, sessions, accounts, content) — 65 decorators
- [x] NestJS Logger + redact interceptor
- [x] Vue 3 + Vite SPA UI (dashboard, queue, history, generate, sessions) — 5 views, 4 Pinia stores, 7 components
- [x] SSE for real-time queue/status updates — wired in PostingService + HealthMonitor + UI
- [x] Cron generation job — env-configurable (CRON_GENERATION_SCHEDULE)
- [x] Vitest unit/integration tests — 368 tests (205 unit + 35 integration + 46 system + 82 acceptance)
- [x] Авто-логин flow для каждого аккаунта (OQ-8: агент логинится сам)
- [x] **F21: Account Health Monitor** — cron раз/час: sessions, queues, bans,
  DLQ. Health dashboard в UI + SSE alerts

### Phase 1.5 — MVP+ (расширение базового MVP, низкий риск) — PARTIAL
- [ ] **F2: Multi-Stage Posting** — хук → 30мин → ссылка (X/Threads треды)
- [~] **F5: Pauseable/Resumable Environment** — LangGraph checkpoint wired; UI for pause/stop/restart TBD
- [~] **F3: On-Demand Feature Launch** — Generate.vue has count/network/source; model picker + control panel TBD
- [ ] **F10: Content Repurposing** — article → 5-10 постов (deep fact extraction)
- [ ] **F13: Content Recycling** — old top posts → refreshed angle (evergreen revival)
- [ ] **F22: Trending Topic Detection** — Google Trends + X trending → priority generation
- [x] Ollama integration (local LLM для decision-making) — LlmService supports Ollama as fallback
- [x] SSE for real-time UI updates (queue status, post status) — wired in App.vue + Pinia stores
- [x] BullMQ queue per network (concurrency=1, B9 mitigation) — QueueFactory
- [x] Reconciliation cron (B10: APPROVED posts without active job) — health-monitor.service.ts

### Phase 2 — Расширение (после стабильного MVP)
- [ ] **F6: Analytics Dashboard** — метрики engagement, top posts, сравнение сетей
- [ ] **F7: Content Calendar** — планирование постов, визуальный календарь
- [ ] **F11: Best Time to Post** — data-driven scheduling slots (после F6)
- [ ] **F19: Image Quote Cards** — SVG→PNG pipeline, zodiac-themed templates
- [ ] **F4: Adaptive Replies** — poll-based ответы на комментарии, injection detection
- [ ] Image/media posts (browser upload через Playwright)
- [ ] Scheduled posting (постинг в конкретное время)
- [ ] Residential proxies + fingerprint рандомизация (если нужны)
- [ ] LinkedIn / Instagram
- [ ] Несколько аккаунтов на сеть
- [ ] Multi-language посты

### Phase 2-3 — Advanced (высокий риск, после стабильного Phase 2)
- [ ] **F1: Autonomous User-Agent** — LLM-управляемый browsing, лайки, комментарии
- [ ] **F8: A/B Testing постов** — 2 варианта, сравнение engagement (требует F6)
- [ ] Captcha auto-solve (2captcha API) если captcha частые

---

## 17. Принципы разработки

1. **HITL-first** — ничего не постится без явного одобрения человека в MVP.
2. **Conservative over fast** — лучше медленнее и не забаниться, чем быстро и
   потерять аккаунт.
3. **Stealth by default** — все browser-сессии идут через Camoufox (C++ level
   stealth, не JS injection). Fingerprint rotation, humanize, geoip — built-in.
4. **Secrets in env, never in code/DB/logs** — пароли только в `.env`.
5. **TypeScript strict** — no `any`, strict null checks, explicit types.
6. **Type-safe end-to-end** — shared Zod schemas: любой контракт
   backend↔frontend проверяется TypeScript на compile time (z.infer → TS types).
   NestJS REST + Swagger для API; axios + shared types в UI.
7. **SOLID + DDD-lite** — модули NestJS по доменам (posts, generation, posting,
   sessions), ports для LLM/browser/content-source (тестируемость).
8. **Page Object pattern** для browser-автоматизации — изоляция хрупких
   селекторов от бизнес-логики.
9. **Idempotent posting** — повторный триггер постинга того же Post не создаёт
   дубль (check status before post).
10. **Observable** — NestJS Logger structured JSON с run-id correlation для
    каждого шага (generation, session-check, login, post, retry).
11. **Fail-safe with retry** — при ошибке постинга BullMQ auto-retry 3x backoff;
    если все fail → dead-letter queue + UI alert; аккаунт не блокируется.
12. **Rate-limited by default** — каждый постинг проходит rate limit check
    (configurable per network/day/week) перед выполнением.

---

## 18. Словарь терминов

| Термин | Значение |
|--------|----------|
| **SPA** | Social Poster Agent (этот проект) |
| **CAP** | content-agent-platform (соседний Python-проект) |
| **HITL** | Human-In-The-Loop — человек одобряет перед действием |
| **Zod** | TypeScript-first schema validation — shared контракт между backend и UI |
| **z.infer** | Zod utility: выводит TS type из Zod schema — основа type safety |
| **Swagger/OpenAPI** | NestJS @nestjs/swagger — авто-документация REST API на /docs |
| **SSE** | Server-Sent Events — однонаправленный server→client для real-time UI |
| **BullMQ** | Redis-based job queue — auto-retry, rate limiter, dead-letter |
| **Dead-letter queue** | BullMQ failed jobs (все retry исчерпаны) — ручное вмешательство |
| **storageState** | Playwright-формат сохранения cookies + localStorage сессии |
| **Draft / Approved / Posted / Failed** | Статусы жизненного цикла Post |
| **Thread** | Многосообщный пост (root + replies) в X/Threads |
| **GenerationRun** | Один запуск cron/manual генерации креативов |
| **Angle** | Угол подачи контента per network (punchy/narrative/conversational) |
| **Stealth** | Набор техник скрытия признаков автоматизации браузера |
| **Ollama** | Local LLM runtime — gemma4 модель для F1 decision-making |

---

## 19. Изменение конституции

Эта конституция — living document. Любое изменение scope, стека, или принципов
требует:
1. Явного edit этого файла с bump `version` (semver).
2. Краткого changelog-коммита: `chore(spa): constitution v0.4.0 — revert to REST, Vue+Vite, Swagger, SSE`.
3. Обновления связанных ADR-ов если изменение архитектурное.

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-06-26 | Initial concept: 19 sections, MVP scope, stack, architecture, risks, 8 open questions |
| 0.2.0 | 2026-06-26 | Resolved all 8 OQ: FB=бизнес-страница, Threads=IG-акк, 2FA выкл, все акк созданы, Postgres=Docker, LLM-ключи=CAP, brand-voice.md в Phase 0, авто-логин. Сняты риски R3/R4. Обновлены §8/§11/§15/§16. |
| 0.3.0 | 2026-06-26 | Architecture brainstorm: 11 new OQ (OQ-9..19). tRPC+trpc-nest (вместо REST), pnpm workspace (backend+ui+shared), BullMQ+Redis (auto-retry, rate limiter), Pino (вместо NestJS Logger), VPN-only (убран auth), per-network angle (разный контент per сеть), 1 browser multi-context, deploy=TBD локально. Обновлены §3/§4/§5/§6/§7/§8/§9/§10.3/§12/§13/§14/§15/§16/§17/§18. Добавлены R9/R10. |
| 0.3.1 | 2026-06-26 | Feature wishlist brainstorm: 9 features (F1-F9) в FEATURE_WISHLIST.md. MVP+ (F2/F3/F5) добавлены в Phase 1.5 roadmap. Phase 2: F6/F7/F4. Phase 2-3: F1/F8. 10 bottlenecks (B1-B10). Ollama gemma4 для local LLM. tRPC subscriptions (WebSocket) для real-time. BullMQ queue per network (concurrency=1). |
| 0.4.0 | 2026-06-26 | Pragmatism review: REVERTED tRPC → NestJS REST + Zod (trpc-nest community, конфликт с NestJS). REVERTED Nuxt 4 → Vue 3 + Vite SPA (Nuxt overkill для 5 страниц). REVERTED Pino → NestJS Logger (достаточно для 1 юзера). ADDED Swagger/OpenAPI. ADDED SSE (вместо tRPC subscription). Ollama gemma4 confirmed (GPU available). LangGraph.js kept (checkpoint + abstraction). 5 new OQ (OQ-20..24). Обновлены §4/§4.1/§4.2/§5/§5.1/§6/§8/§12/§13/§15/§16/§17/§18. |
| 0.4.1 | 2026-06-26 | Feature expansion: 7 new features (F10-F22) в FEATURE_WISHLIST.md. F21 (Health Monitor) → MVP. F20 (Warm-up) → Phase 0/1. F10 (Repurposing), F13 (Recycling), F22 (Trending) → Phase 1.5. F11 (Best Time), F19 (Quote Cards) → Phase 2. Fixed stale §3.1 (Nuxt/Pino → Vue/NestJS Logger). Fixed stale R9 (tRPC risk → снято). Updated roadmap. |
| 0.4.2 | 2026-06-26 | Browser stealth: REVERTED `playwright-extra` + `puppeteer-extra-plugin-stealth` (JS injection — детектится современными anti-bot) → **Camoufox** (Firefox fork, C++ level stealth). Removed `playwright` (full — скачивает 3 браузера ~800MB) → kept `playwright-core` (peer dep of camoufox-js, API only). New OQ-25. Обновлены §1/§2/§3.1/§3.2/§4/§4.1/§4.2/§5/§5.1/§6/§8/§9/§14/§15(R1,OQ-3)/§16/§17. Camoufox: fingerprint rotation, humanize, geoip — built-in. ~200MB vs Chrome 800MB+. Playwright-compatible API (camoufox-js + playwright-core). |
| 0.5.0 | 2026-07-15 | **Audit fixes**: A1 rate-limit env vars (daily+weekly, conservative defaults). A2 Redis port 6381. A4 §10.3 LangGraph 7-step parallel per-network graph (OQ-16). B1 F21 Account Health Monitor (hourly cron, ban detection). B2 F20 Session Warm-up Mode. B3 Reconciliation cron. B4 Cron env-configurable. B5 SimHash dedup. B6 SSE UI wiring (Pinia stores). B10 Graceful shutdown. D1 Batch posting rate-limit fix. D2 approve() editedContent. D5 brand-voice path. D6 FB char limit 500. 5 ADRs, 4 runbooks, Dockerfiles + docker-compose.prod.yml. |
| 0.5.1 | 2026-07-16 | **Doc-code sync**: §6 structure updated (added engagement/, health-monitor/, cls/, monitoring/, filters/, checkpoint/, docker/, docs/ ADRs+runbooks). §16 Phase 0/1 marked as COMPLETED with [x]. Phase 1.5 marked as PARTIAL (Ollama, SSE, BullMQ per-network, reconciliation cron — done; F2/F10/F13/F22 — not started; F3/F5 — partial). ROADMAP.md fully synced with codebase (all phases, compliance score 92/100, new sprints A-G). 368 tests pass. |

---

_Document created 2026-06-26 by Valentyn Yakovlev. MVP fully implemented (v0.5.1)._
