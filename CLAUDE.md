# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Social Poster Agent (SPA): a social media automation system that generates LLM content from a sibling
content repo and posts it to X.com, Threads, and Facebook via stealth browser automation. Core operating
principle: **cron generates → human reviews → agent posts** (HITL by default).

`README.md` covers the stack, the project-structure tree, quick-start, and the basic command list — this
file is the operational + non-obvious layer on top of it. Start with both.

## ⚠️ The docs lag the code — trust source, not prose

This is the single most important thing to know here. Design documents are written *before* or alongside the
code and may not be updated as the code evolves. Known concrete drifts (verify against source, never inherit a
doc claim):

- `README.md` says the LLM is "OpenAI gpt-4o-mini + Ollama". Reality: an 8-provider fallback router,
  default model `gpt-5-nano` (see `.env.example`).

When a subsystem detail matters, `grep` the source. Design docs are "what to build", not "what is".

## Commands

`README.md` lists the everyday `pnpm dev:all` / `build` / `lint` (oxlint) / `format` (oxfmt) / `prisma:*` /
`infra:up` commands. The non-obvious ones:

```bash
# Tests are layered (packages/backend/tests/{unit,integration,system,acceptance,e2e}).
pnpm test                 # backend unit+all (vitest run) — see test:unit / :integration / :system / :acceptance / :e2e for one layer
pnpm test:coverage        # enforced thresholds: statements/functions/lines 80, branches 75

# Run ONE test file or ONE test by name (the `test` script is `vitest run`, so it forwards args):
pnpm --filter @spa/backend test tests/unit/generation/simhash.spec.ts -t "deterministic"
#   or, from inside packages/backend:
npx vitest run tests/unit/generation/simhash.spec.ts -t "deterministic"
#   -t matches concatenated describe+it text (substring/regex); other tests report as skipped.
#   Unit specs are nested under tests/unit/<subdir>/, not flat.

pnpm test:infra:up        # SEPARATE test DB/Redis stack (infra/docker-compose.test.yml) — distinct from `pnpm infra:up`

# Browser posting, two modes — KNOW WHICH ONE YOU ARE RUNNING:
pnpm dry-run              # safe: opens a real browser, navigates & types for real, but intercepts the final submit
                          #   click (screenshot + synthetic post URL). LLM calls and trending scrapes are STILL REAL.
pnpm --filter @spa/backend live   # DANGER: real posts/likes/comments. Not exposed at repo root. Prompts for the
                          #   literal word "yes" unless --yes/-y. Uses `tsc`, not `nest build`.
```

Infra runs on **non-standard ports on purpose** (avoid colliding with host services and the sibling CAP repo's
Redis on 6380): Postgres `:5433`, Redis `:6381` (test stack uses Postgres `:5434`). API `:3100` (`/api/v1`,
Swagger at `/docs`), UI `:3101`. Node ≥22, pnpm ≥10.

## Architecture

Monorepo: `@spa/shared` (Zod schemas + domain types — the **single source-of-truth contract**, editing a
schema breaks backend *and* UI at compile time), `@spa/backend` (NestJS 11, hexagonal), `@spa/ui` (Vue 3 +
Vite + Pinia). The backend `src/domain/` folder is *only* re-exports; types and schemas physically live in
`packages/shared`.

**Hexagonal ports/adapters.** Domain ports are NestJS DI tokens declared as `Symbol(...)` in
`packages/backend/src/domain/ports/*.ts` (`ILlmPort`, `IBrowserPort`, `IContentPort`, `IEngagementDecisionPort`).
Services `@Inject(ILlmPort)` — never the concrete class. Each infra module binds the Symbol to an implementation
(`{ provide: ILlmPort, useExisting: LlmService }`, or a `useFactory`). **To swap an adapter, change only the
provider binding in the infra module.**

**Generation (LangGraph).** `src/modules/generation/generation.graph.ts` runs once **per topic** and fans out
to per-network parallel branches: `research_extract → hook_generation → angle_per_network →` then for each of
{X, THREADS, FACEBOOK} in parallel `[draft → critique → refine → visual_concept → ab_variant] → human_review →
save_to_db`. Each network gets a *genuinely different* hook (not one text reworded); a single run therefore
writes **three Post rows** sharing one `generation_run_id`. Per-network error isolation: a failed node sets that
network's `result.error` and downstream nodes short-circuit while other networks proceed. Caveats:
- `save_to_db` is a **misnomer** — it only formats graph state. Real Prisma persistence (plus SimHash
  near-duplicate filtering, skip when Hamming ≤3 vs last ~200 posts/30 days) happens *after* `graph.invoke()`
  returns, in `GenerationService`.
- Crash-resume: `RedisCheckpointSaver` (`src/infrastructure/checkpoint/redis-checkpoint.ts`) keys on
  `thread_id = ${runId}:${topic.topic}` (the file's own JSDoc wrongly says `runId` alone). Re-invoking with the
  same `thread_id` resumes from the checkpoint. The graph is lazy-compiled once via `GenerationService.getGraph()`.
- HITL: when review is on, `human_review` calls LangGraph `interrupt()`; resume via
  `GenerationService.resumeWithReview()` re-invoking with `new Command({ resume: {...} })`.
- **`GenerationService` emits no SSE events** — generation progress is not live in the UI.

**LLM router** (`src/infrastructure/llm/llm.service.ts`). Free-first fallback chain across up to 8
OpenAI-compatible providers (Groq → OpenRouter → DeepSeek → Cerebras → OpenAI → Google → NVIDIA → Ollama); only
providers with their API-key env var set are included, Ollama is appended keyless as last resort. All via
LangChain `ChatOpenAI`. Has a per-provider circuit breaker and a 5-min SHA256 response cache. Reasoning models
matching `/^(gpt-5|o1|o3|o4-mini)/` get `temperature` **omitted** (they 400 otherwise).

**Queue + cron + SSE.** BullMQ (`src/infrastructure/queue/queue.factory.ts`) creates one queue per
network×action (`spa-posting-x`, …), **concurrency=1** (serialize to look human), `jobId = postId` for
idempotent dedup; exhausted retries → Discord DLQ alert. BullMQ has no built-in cron, so `@nestjs/schedule`
crons are the trigger layer that *enqueue* into BullMQ. `approve()` sets status APPROVED and enqueues via
`ModuleRef` lazy resolution (deliberately, to break the PostsModule↔QueueModule cycle); the worker re-checks
status before posting. SSE (`src/infrastructure/sse/sse.service.ts`) decouples the worker from the API: the
worker PUBLISHes to Redis channel `spa:sse`, `SseService` SUBSCRIBEs and fans out to `EventSource` clients —
using **two separate** shared Redis connections because a subscriber-mode connection can't publish. SSE is
one-way; the UI does all actions (approve/pause) over REST.

**Browser (Camoufox).** Only `playwright-core` is a dependency (peer of `camoufox-js`); full Playwright was
removed to avoid ~800MB downloads. Camoufox is a real Firefox patched at C++ level (chosen over Playwright-
Chromium to kill the CDP detection vector). Headless is controlled by `CAMOUFOX_HEADLESS` (defaults to `true`
in `browser.factory.ts`; set `false` to watch a run). Selectors
resolve through a fallback chain (`data-testid → role → label → CSS → text`) with a drift detector at
`infrastructure/browser/selector-health.service.ts`. **Facebook diverges**: a single persistent Camoufox
context backed by an on-disk `user_data_dir` (shared, never pooled/closed, ignores the storageState arg) to
dodge "suspicious login" challenges; X/Threads use fresh pooled contexts (`BROWSER_POOL_SIZE`, default 3) with
saved storageState.

**Content source.** Content comes from `content-agent-platform` (CAP), a **sibling repo** at
`../content-agent-platform` relative to `process.cwd()` (NOT a subdirectory). `ContentReader`
(`src/infrastructure/content/content-reader.ts`) reads its `runs/brief-*`, `runs/topics-*`, `runs/create-*`
folders — so the working directory matters when running CLIs. `brand-voice.md` is likewise read from
`process.cwd()` at runtime and injected into every generation prompt.

**Feature-flag gating.** `app.module.ts` reads `process.env` **directly at module-load time** (not
`ConfigService`) and conditionally adds modules to `imports`. When `ENGAGEMENT_ENABLED` / `CAPTCHA_SOLVER_ENABLED`
/ `PROXY_ROTATION_ENABLED` / `QUOTE_CARDS_ENABLED` / `REPLIES_ENABLED` (all default `false`) are off, those
modules are **entirely absent** — services unresolvable, routes 404, not merely disabled. Toggling requires a
restart. The ~1300-line Engagement feature is frozen behind its flag. `RepliesModule.withEngagement(...)` is
composed only when both `REPLIES_ENABLED` and `ENGAGEMENT_ENABLED` are on.

**Autonomy (ADR-006).** The full auto pipeline exists (`modules/autonomy`, `modules/flow-control`,
`events/listeners/auto-approve.listener.ts`) but `AUTO_APPROVE_ENABLED` defaults to `false`, so a fresh `.env`
runs in manual HITL mode and nothing auto-posts. Flow-control is Redis flags (`flow:pause_*`) that services
poll to pause without a restart. Note there is also an internal EventEmitter2 domain-event bus
(`src/events/`) for post-lifecycle events — distinct from SSE.

## Traps that will cost you an hour

- **esbuild drops DI metadata.** Vitest transforms with esbuild, which doesn't emit `design:paramtypes`, so
  Nest resolves class-typed constructor params to `undefined` (only `@Inject(TOKEN)` survives). Every full-
  AppModule test (all integration/system/acceptance/e2e) restores it via `Reflect.defineMetadata('design:paramtypes', …)`
  — see `tests/helpers/sprint-o-paramtypes.ts`. **Adding an injectable or changing a constructor signature means
  updating those restore blocks**, or full-app tests fail with undefined-dependency errors.
- **CLIs must call `app.init()`** after `NestFactory.create()`, or `onModuleInit` hooks (e.g.
  `LlmService.buildProviderChain()`) never run and you get zero LLM providers.
- **Env validation is manual** (`validateEnv()` in `AppModule.onModuleInit`, not `ConfigModule.validationSchema`)
  — Joi defaults would overwrite `process.env` and break tests that set env after import. Don't "fix" this.
- **Vitest is single-threaded** (`poolOptions.threads.singleThread=true`) and `tests/setup.ts` mutates global
  `process.env` — tests are **not** isolated across workers.
- **Session encryption.** `SESSION_ENCRYPTION_KEY` (gen: `openssl rand -hex 32`) toggles AES-256-GCM on
  storageState at rest. Absent/malformed key = plaintext passthrough in dev but a **hard boot failure when
  NODE_ENV=production**. Encrypted values carry a `v1:` prefix; `schema.prisma`'s `storageState` is typed `Json`
  with a stale "cookies, localStorage" comment but actually holds ciphertext.
- **Two unrelated health modules:** `modules/health` (liveness controller) vs `modules/health-monitor` (F21
  hourly ban-detection + DLQ + reconciliation cron). Don't confuse them.
- **UI auth (JWT cookie).** `AUTH_ENABLED` (default `false`) gates all backend routes behind a JWT
  in an httpOnly cookie (`spa_token`), issued by `POST /auth/login`. When off → pass-through (VPN-only /
  tests). The admin account is bootstrapped from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars on startup
  (`AuthService.onModuleInit` — created if missing, password updated if env changes; scrypt hash, no
  external deps). `JwtAuthGuard` is the global `APP_GUARD` (replaced the old shared-API-key `ApiAuthGuard`).
  Public routes: `/auth/login`, `/health`. The UI (`@spa/ui`) has a `/login` page, Pinia `auth` store,
  router guard, and `axios` with `withCredentials: true`; SSE uses `EventSource(url, { withCredentials: true })`.
  The DB stores only `credentials_ref` (the env-var *name*), never social passwords;
  `RedactInterceptor` strips passwords/tokens/storageState/credentialsRef from logs by exact key match.
- **Green CI ≠ working posting.** Browser automation is mocked in tests; no test drives real X/Threads/Facebook
  selectors end-to-end. Use `pnpm dry-run` to validate against live pages.

## Integration test taxonomy

The four `tests/integration/*` files are named after ISO/IEC/IEEE 29119 techniques deliberately: **top-down**
(high-level modules, stub external ports), **bottom-up** (low-level modules + infra first), **sandwich** (both,
around Posting↔Sessions↔Browser), **big-bang** (full AppModule wired at once). Layers above: `system` (slice
across modules), `acceptance` (BDD scenarios + ATP cases), `e2e` (full flows).
