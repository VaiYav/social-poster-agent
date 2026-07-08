# Module: `infrastructure/prisma`

## 1. What this module does

`infrastructure/prisma` is the persistence adapter for the SPA backend. It owns the `PrismaClient` lifecycle and exposes the generated Prisma ORM API to the rest of the NestJS application. Unlike the LLM, browser, and prompt infrastructure, there is **no domain port / repository abstraction** here: business logic calls `PrismaService` (a thin `PrismaClient` subclass) directly in ~30 modules.

Key responsibilities:

- Construct and connect/disconnect a single long-lived `PrismaClient` at application lifecycle boundaries.
- Provide the generated `PrismaService`/`PrismaClient` API globally so any module can persist and query PostgreSQL.
- Define the data model (`schema.prisma`) and migration history under `packages/backend/prisma/`.
- Enable transaction-aware calls through an optional `Prisma.TransactionClient` parameter in `PostsService.create`.

The module is intentionally minimal. It does not implement custom repositories, a unit of work, query logging, a Prisma exception filter, connection-pool tuning, or an `IPrismaPort` hexagonal port.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `packages/backend/src/infrastructure/prisma/prisma.service.ts` | `PrismaClient` lifecycle wrapper | `PrismaService extends PrismaClient`; `onModuleInit`/`onModuleDestroy` connect/disconnect; exposes all generated model methods and `$transaction`, `$queryRaw`, `$executeRaw` |
| `packages/backend/src/infrastructure/prisma/prisma.module.ts` | Global NestJS module | `@Global()` module that provides/exports `PrismaService` |
| `packages/backend/prisma/schema.prisma` | Data model + datasource config | 11 models, 7 enums, indexes, FK relations, `datasource db { url = env("DATABASE_URL") }` |
| `packages/backend/prisma/migrations/*` | Sequential SQL migrations | 12 migration files from `20260626110230_init` through `20260704100000_add_post_language_field` |

## 3. Architecture & data flow

### 3.1 Module wiring

```mermaid
flowchart TB
    subgraph NestApp [NestJS Application]
        AppModule -->|imports| PrismaModule
        PrismaModule -->|provides| PrismaService
        PrismaService -->|extends| PrismaClient
    end

    PrismaClient -->|SQL over TCP| Postgres[(PostgreSQL 16)]

    subgraph Callers [~30 upstream modules]
        PostsService
        GenerationService
        SessionsService
        AccountsService
        HealthController
        OrchestratorModules[Orchestrator, Autonomy, Replies, Engagement, ...]
    end

    Callers -->|inject| PrismaService
```

Important wiring facts:

- `PrismaModule` is imported by `AppModule` and declared `@Global()`, so it is available everywhere without explicit module imports (`packages/backend/src/app.module.ts:82-90`).
- `PrismaService` is constructed once per process; it is a subclass of `PrismaClient` with `log: ['warn', 'error']` (`packages/backend/src/infrastructure/prisma/prisma.service.ts:8-12`).
- `onModuleInit` calls `$connect()` (`prisma.service.ts:14-17`); `onModuleDestroy` calls `$disconnect()` (`prisma.service.ts:19-22`). `main.ts` enables NestJS shutdown hooks (`packages/backend/src/main.ts:81-83`) so disconnect runs on SIGTERM/SIGINT.
- Connection parameters (`connection_limit`, `pool_timeout`, `transactionOptions`) are **not** set in code; they can only be influenced through `DATABASE_URL` query parameters or `schema.prisma` defaults.

### 3.2 Schema overview

```mermaid
erDiagram
    SocialAccount ||--o{ Session : has
    SocialAccount ||--o{ Post : posts
    SocialAccount ||--o{ PostThread : threads
    SocialAccount ||--o{ Interaction : interactions
    SocialAccount ||--o{ BrowsingSession : browsingSessions
    GenerationRun ||--o{ Post : posts
    PostThread ||--o{ Post : posts
    Post ||--o{ PostMetrics : metrics
    Post ||--o{ IncomingComment : incomingComments
    BrowsingSession ||--o{ Interaction : interactions
    SocialAccount {
        string network
        string handle
        string credentialsRef
        boolean active
        boolean warmupEnabled
    }
    Post {
        string network
        string content
        Json sourceRef
        Json llmMetadata
        string simhash
        string status
        string language
    }
    Session {
        Json storageState
        string status
        datetime lastHealthCheck
    }
```

### 3.3 Typical call patterns

1. **CRUD without transaction**: most services call `this.prisma.post.findMany`, `update`, `create`, etc. directly.
2. **CRUD inside an interactive transaction**: `GenerationService` and `PostsService.create` support passing a `tx` client (`packages/backend/src/modules/posts/posts.service.ts:74-100` and `packages/backend/src/modules/generation/generation.service.ts:799-850, 882-917`).
3. **Health probe**: `HealthController` uses `this.prisma.$queryRaw`SELECT 1`` bounded by `withTimeout` (`packages/backend/src/modules/health/health.controller.ts:31-36`).
4. **Application-level JSON filtering**: `PostsService.findBySourceAndNetwork` loads all posts for `(network, since, status notIn FAILED/REJECTED)` then filters by `sourceRef.path` in Node.js because Prisma JSON path filtering is not used (`packages/backend/src/modules/posts/posts.service.ts:207-230`).

## 4. Schema evolution

| Migration | Date | What it adds |
|-----------|------|--------------|
| `20260626110230_init` | 26 Jun | Initial enums (`SocialNetwork`, `PostStatus`, `SessionStatus`, `GenerationRunStatus`, `GenerationTrigger`), `SocialAccount`, `Session`, `GenerationRun`, `PostThread`, `Post` |
| `20260626182058_add_warmup_and_banned_status` | 26 Jun | `SessionStatus.WARMUP`, `SessionStatus.BANNED`; `SocialAccount.warmupEnabled`, `warmupStartedAt`, `warmupDaysTotal` |
| `20260627120000_add_paused_run_status` | 27 Jun | `GenerationRunStatus.PAUSED` |
| `20260627125254_add_post_metrics` | 27 Jun | `PostMetrics` model |
| `20260627130000_add_simhash_to_post` | 27 Jun | `Post.simhash` + index |
| `20260627140000_add_thread_progress` | 27 Jun | `ThreadProgress` model |
| `20260627161453_add_incoming_comments` | 27 Jun | `IncomingComment` model + `CommentStatus` enum |
| `20260629124137_add_admin` | 29 Jun | `Admin` model |
| `20260630120000_add_topic_model` | 30 Jun | `Topic` model |
| `20260703000000_add_repost_quote_interaction_types` | 3 Jul | `InteractionType.REPOST`, `InteractionType.QUOTE` |
| `20260704100000_add_post_language_field` | 4 Jul | `Post.language` |

The schema has changed rapidly (12 migrations in ~8 days). Several migrations are additive only and do not include data backfills.

## 5. Environment variables

| Variable | Default | Purpose | Where validated/used |
|----------|---------|---------|----------------------|
| `DATABASE_URL` | `postgresql://spa:spa@localhost:5433/social_poster` | PostgreSQL connection string | `packages/backend/src/infrastructure/config/env.validation.ts:96`, `packages/backend/prisma/schema.prisma:11`, `.env.example:154` |

No dedicated `PRISMA_CONNECTION_LIMIT`, `PRISMA_POOL_TIMEOUT`, or `PRISMA_TRANSACTION_TIMEOUT` variables exist. Pool tuning must be done via `DATABASE_URL` query parameters, which are not documented in the env schema comments.

## 6. Findings

### 6.1 Bugs / correctness

#### B1 — `DATABASE_URL` is not validated as a URL

`env.validation.ts:96` declares `DATABASE_URL: Joi.string().default(...)`. `Joi.string()` accepts any non-empty string, including malformed connection strings, missing credentials, or wrong protocols. Validation failure is therefore discovered only when `PrismaService.onModuleInit` calls `$connect()` and Prisma throws a runtime error.

**Impact**: A typo in `DATABASE_URL` produces a late, low-level Prisma error instead of a clear env-validation message at boot.

**Fix**: Change the Joi rule to `Joi.string().uri({ scheme: ['postgresql', 'postgres'] })` or a custom regex that at least validates `postgresql://user:pass@host:port/db`.

#### B2 — No retry/backoff on initial connection

`prisma.service.ts:14-17` calls `await this.$connect()` with no retry. If the database is not yet reachable during a container startup race, the whole bootstrap fails and the process exits.

**Impact**: Cold-start flapping in Kubernetes / Railway / Docker Compose unless the orchestrator restarts the container.

**Fix**: Wrap `$connect()` in a small `p-retry` or custom loop (3 attempts, ~1s exponential backoff) with bounded logging. This is a startup-only concern; runtime queries should still fail fast.

#### B3 — No Prisma exception filter exists

`infrastructure/filters/zod-validation.filter.ts:23-74` catches `ZodError`, `HttpException`, and all other errors, but it never handles `Prisma.PrismaClientKnownRequestError` specifically. Services call `prisma.post.update`, `delete`, `upsert` in many places without guarding against `P2025` (Record to update not found), `P2002` (unique constraint), `P2024` (connection pool timeout), or `P2010` (raw query failure). When these occur they become generic HTTP 500 with redacted messages, but the log still receives verbose Prisma internals.

**Example**: `posts.service.ts:179-182` calls `this.prisma.post.update({ where: { id } })` after `findById` only checks `DRAFT` status, but another concurrent request could delete/reject the post between the read and write.

**Fix**: Add a dedicated `PrismaClientExceptionFilter` (or extend `ZodValidationFilter` with Prisma-specific branches):

- `P2002` → `ConflictException`
- `P2025` → `NotFoundException`
- `P2024` → `ServiceUnavailableException`
- Other known request errors → generic 500 with redacted messages

#### B4 — `PrismaService` does not configure `transactionOptions` or `errorFormat`

`prisma.service.ts:8-12` only passes `log: ['warn', 'error']`. The default `PrismaClient` transaction options are `maxWait: 2000` and `timeout: 5000`. `GenerationService` runs multi-row thread assembly inside `$transaction` (`generation.service.ts:799-850` and `generation.service.ts:882-917`); with many continuation posts or slow I/O the default 5-second timeout can abort the transaction and leave a partially persisted thread.

**Impact**: Generation run ends with partially created posts, requiring manual cleanup or reconcile.

**Fix**: Set explicit transaction defaults in `PrismaService` and allow per-call override where needed. For long threads, wrap only the DB writes (as already attempted) but increase timeout to 15-30s.

#### B5 — `PrismaService` is concrete, not a hexagonal port

Other infrastructure adapters (`LlmService`, `BrowserFactory`, `PromptRegistry`) are bound through domain ports (`ILlmPort`, `IBrowserPort`, `IContentPort`, `IPromptPort`) in `packages/backend/src/domain/ports/`. There is no `IPrismaPort` or repository abstraction. `PrismaService` is injected directly by ~30 services (`posts.service.ts`, `generation.service.ts`, `sessions.service.ts`, `autonomy/*`, `orchestrator/*`, `replies/*`, etc.).

**Impact**: Business logic is tightly coupled to the Prisma-generated API. Swapping PostgreSQL for another backend, introducing sharding, or writing integration tests with an in-memory store requires touching many services.

**Fix**: Introduce `domain/ports/prisma.port.ts` (or split into `IPostRepository`, `ISessionRepository`, `IAccountRepository`, `IUnitOfWork`) and bind implementations in `PrismaModule`. This is a large refactor; start with the most reused patterns (`findById`, `create`, `updateStatus`) if a full port is too big.

#### B6 — `createMockPrismaService` is missing newer models

`packages/backend/tests/mocks/index.ts:209-261` mocks `generationRun`, `post`, `postThread`, `session`, `account`, `socialAccount`, `browsingSession`, `$queryRaw`, and `$transaction`, but does not stub `topic`, `postMetrics`, `threadProgress`, `incomingComment`, `interaction`, or `admin`. Tests that use these models must add their own mocks, reducing the value of the shared mock and increasing boilerplate.

**Fix**: Add the missing model stubs to `createMockPrismaService` and keep a single source-of-truth mapping (e.g. generate stubs from `Prisma.ModelName`).

### 6.2 Performance

#### P1 — Connection pool not tuned in code

`PrismaService` does not set `connection_limit`, `pool_timeout`, or `transactionOptions`. Prisma defaults are `2 * numCPUs + 1` connections and `pool_timeout = 10s`. With BullMQ workers, cron jobs, concurrent generation runs, and engagement sessions, the pool can saturate and throw `P2024` if `DATABASE_URL` does not override these.

**Impact**: Sporadic `P2024` timeouts under load; hard to reproduce locally with a single CPU.

**Fix**: Expose `PRISMA_CONNECTION_LIMIT`, `PRISMA_POOL_TIMEOUT_MS`, `PRISMA_TRANSACTION_TIMEOUT_MS` env vars and pass them in the `PrismaClient` constructor:

```ts
super({
  log: ['warn', 'error'],
  datasources: {
    db: { url: process.env.DATABASE_URL },
  },
});
```

or use `DATABASE_URL` query parameters and document them.

#### P2 — Default 5-second transaction timeout for thread assembly

See B4. The `$transaction` calls in `generation.service.ts` rely on default `timeout: 5000`. If thread creation involves more than a handful of rows or the DB is under load, the transaction can time out.

**Fix**: increase default to 15-30s, or pass `{ timeout: 30000 }` at the two `$transaction` call sites.

#### P3 — `findBySourceAndNetwork` filters JSON in application code

`posts.service.ts:207-230` loads **all** posts for `(network, createdAt >= since, status notIn [FAILED, REJECTED])` and then filters `sourceRef.path` in Node.js. There is no database index on `sourceRef->>'path'` and no `sourcePath` normalized column. As the `Post` table grows, `findMany` returns an ever-increasing number of rows just to be discarded.

**Impact**: O(n) memory/JSON parse per call, increasing with post volume. If a topic is reused often, this is a warm path during topic deduplication and recycling.

**Fix**:
- Option A (fastest): add a `sourcePath String?` column and populate it from `sourceRef.path` at creation time, with a composite index `(network, sourcePath, createdAt)`.
- Option B (smaller schema change): create a PostgreSQL expression index `CREATE INDEX idx_post_source_path ON "Post" USING btree ((("sourceRef" ->> 'path')::text));` and use Prisma's `path` JSON filter if the client version supports it, or `where: { sourceRef: { path: { equals: sourcePath } } }`.

#### P4 — No query performance telemetry

`PrismaService` does not register `$on('query')` handlers or middleware to log slow queries. The `log` array excludes `'query'`, which is good for avoiding credential leakage, but there is no visibility into slow queries, N+1 patterns, or connection-pool pressure.

**Impact**: Database regressions are discovered only via Sentry/Discord 500 errors or manual Postgres logs.

**Fix**: Add an opt-in Prisma middleware that records query durations in OpenTelemetry/Sentry spans or a histogram metric. Do not log the full raw query text in production to avoid leaking data; log hashed query signatures and duration.

#### P5 — `Post.simhash` index exists but dedup still loads 200 rows

`generation.service.ts:1115-1129` loads up to 200 recent posts with `select: { id, simhash, llmMetadata, sourceRef }` to compute Hamming distance for near-duplicate detection. The index on `simhash` helps exact matches, but the sliding-window scan is not time-bounded in the query: it uses `orderBy: { createdAt: 'desc' }` and `take: 200`.

**Impact**: As the number of posts grows, the query becomes a sort + limit over the whole table; although `createdAt` has no direct index, the `Post` table has no `(createdAt DESC)` index. With millions of rows this can become expensive.

**Fix**: Add a composite index `(createdAt DESC, network)` and consider a `since` filter for the dedup window (e.g. last 30 days) to reduce the scan.

### 6.3 Architecture / anti-patterns

#### A1 — Data-access layer is a single thin service

`PrismaService` is a direct `PrismaClient` subclass with no repository, query builder, or unit-of-work abstraction. Persistence concerns (where-clause construction, `updateMany` filters, JSON casting, transaction scoping) are spread across business modules.

**Impact**: Domain logic knows the schema, relation names, and `Prisma` JSON input types. This inverts the dependency direction compared with LLM/browser/content adapters that expose narrow domain ports.

**Fix**: Adopt repository ports. Start with high-churn modules (`Posts`, `Sessions`, `Accounts`) and migrate incrementally; keep `PrismaService` for low-level operations only.

#### A2 — `@Global()` module hides data-access dependencies

`prisma.module.ts:10` marks `PrismaModule` `@Global()`. Any service can silently depend on `PrismaService` without declaring `PrismaModule` in its module imports. This makes the module graph harder to reason about and encourages tight coupling.

**Impact**: Removing a feature module may leave `PrismaService` usages scattered; circular dependencies can form without being visible in `app.module.ts`.

**Fix**: Remove `@Global()` and import `PrismaModule` explicitly where needed, or replace it with repository ports bound per domain module. This is a large refactor and should follow the repository port work.

#### A3 — `PrismaService` lifecycle assumes a single long-lived client

There is one `PrismaClient` per process. No per-request or per-tenant client routing, no test isolation other than full mocks, and no way to reset connection state without restarting.

**Impact**: Long-running processes accumulate query-engine / connection state; tests cannot exercise real transactions against a test database easily; multi-tenant routing is impossible.

**Fix**: For tests, expose a `PrismaService.forUrl(url)` factory and use a dedicated test `DATABASE_URL`. For production, the singleton is fine.

#### A4 — Mixed `.js` / `.ts` import extensions for the same file

Most modules import `prisma.service` from `.../prisma/prisma.service` (CJS resolution). However, `engagement/browsing-session.service.ts:15`, `engagement/engagement.service.ts:5`, `engagement/human-behavior-engine.ts:21`, and `content-enhancements/hook-performance-bank.ts:28` import `.../prisma/prisma.service.js`. The project is `type: commonjs` and both compile, but the inconsistency is a maintenance paper cut and could break ESM conversion later.

**Fix**: Standardize on one extension. Since the repo is CJS and orchestrator files use `.js`, align all backend imports to `.../prisma/prisma.service.js` if NestJS/ts-node resolves it, or remove `.js` everywhere if `allowArbitraryExtensions` permits.

### 6.4 TypeScript / type safety

#### T1 — `PrismaService` does not re-export `Prisma` types

Services import `Prisma` namespace types directly from `@prisma/client` (`posts.service.ts:4`, `sessions.service.ts:10`). This is standard but couples the domain to the generated client.

**Fix**: Minor — re-export `Prisma`, `Post`, `PostStatus`, etc. from `infrastructure/prisma` so callers import from the adapter layer.

#### T2 — `PostsService.create` typing is loose for the transaction client

`posts.service.ts:89` uses `client: Prisma.TransactionClient = this.prisma` as the default. This works because `PrismaService` extends `PrismaClient`, but the type signature does not make it obvious that the parameter is meant to be a transaction client.

**Fix**: Rename parameter to `tx` with type `PrismaClient | Prisma.TransactionClient` and document the pattern, or use a `IUnitOfWork` interface.

#### T3 — `PrismaService` subclass adds no behavior beyond construction

The service only overrides `constructor`, `onModuleInit`, and `onModuleDestroy`. A plain `{ provide: PrismaClient, useFactory: () => new PrismaClient(...) }` would be cleaner than a subclass with `Logger`.

**Fix**: Keep the subclass if lifecycle hooks are valuable; otherwise move construction to `PrismaModule` provider factory and use `OnModuleInit` in the module itself.

### 6.5 Security / reliability

#### S1 — `log: ['warn', 'error']` may leak query context in logs

Prisma `warn` and `error` logs can include query text, field names, table names, and record identifiers. These logs are not routed through `RedactInterceptor` (which only redacts explicit response fields), so they may contain sensitive data.

**Impact**: Verbose Prisma errors in container logs could leak schema details or row IDs. `query` log level is already excluded, which is good.

**Fix**: Set `errorFormat: 'minimal'` for `NODE_ENV=production` and/or route Prisma logs through a sanitizer. Avoid `query` log level in prod entirely.

#### S2 — `Session.storageState` schema comment is stale

`schema.prisma:114` says `// Playwright storageState (cookies, localStorage)`. In reality `SessionsService` encrypts the storage state as a string with a `v1:` prefix before storing it in the `Json` field (`packages/backend/src/modules/sessions/sessions.service.ts`). The `Json` type is technically valid because the ciphertext is stored as a JSON string, but the comment implies plaintext JSON.

**Impact**: A developer or auditor reading the schema may assume storageState is not encrypted, creating compliance/audit confusion.

**Fix**: Update the comment to `// encrypted Playwright storageState (string with v1: prefix)` and add a runtime `@db.Text` or `String?` column if the encrypted payload is no longer JSON.

#### S3 — `.env.example` ships a default database password

`.env.example:154` uses `postgresql://spa:spa@localhost:5433/social_poster`. This is acceptable for local dev only, but it is a pattern that could be copy-pasted to production.

**Impact**: Low for local dev, but onboarding docs should explicitly warn not to reuse this in production and not to commit real credentials.

**Fix**: Add a comment in `.env.example` and onboarding docs that this is a dev-only default.

## 7. New feature / improvement ideas

1. **Prisma exception filter** — map Prisma error codes to HTTP status codes and redact raw internals.
2. **Env-driven connection-pool tuning** — `PRISMA_CONNECTION_LIMIT`, `PRISMA_POOL_TIMEOUT_MS`, `PRISMA_TRANSACTION_TIMEOUT_MS`.
3. **Slow-query / N+1 middleware** — opt-in query-duration metrics without logging full SQL text.
4. **Repository / unit-of-work ports** — align data access with the hexagonal architecture used for LLM/browser/content/prompt adapters.
5. **Better `sourceRef` indexing** — add a `sourcePath` column or expression index to avoid in-memory JSON filtering.
6. **`createdAt` composite indexes** — improve `findBySourceAndNetwork`, `findMany` with `orderBy`, and SimHash dedup scans.
7. **Prisma seed script** (`prisma/seed.ts`) — provide local dev/test fixtures (admin, accounts, sample topics, posts) so new contributors don't craft data manually.
8. **Re-export `Prisma` namespace** from `infrastructure/prisma` to centralize adapter imports.
9. **Production `errorFormat: 'minimal'`** and sanitized logging.
10. **Complete `createMockPrismaService`** for `topic`, `postMetrics`, `threadProgress`, `incomingComment`, `interaction`, `admin`.
11. **Database snapshot / integration tests** against a real Postgres instance in `docker-compose.test.yml` to catch schema drift and migration failures in CI.

## 8. Cross-references

| File / module | Why it matters |
|---------------|----------------|
| `packages/backend/src/app.module.ts:82-90` | `PrismaModule` imported as global; `AppModule.onModuleInit` calls `validateEnv()` |
| `packages/backend/src/main.ts:81-83` | `enableShutdownHooks()` triggers `PrismaService.onModuleDestroy` |
| `packages/backend/src/infrastructure/config/env.validation.ts:96` | `DATABASE_URL` validation rule |
| `packages/backend/src/modules/posts/posts.service.ts:74-101, 207-230` | `create` with transaction client; `findBySourceAndNetwork` JSON filtering |
| `packages/backend/src/modules/generation/generation.service.ts:799-850, 882-917` | Multi-row thread persistence in interactive transactions |
| `packages/backend/src/modules/health/health.controller.ts:31-36` | `prisma.$queryRaw`SELECT 1`` health probe |
| `packages/backend/src/infrastructure/filters/zod-validation.filter.ts:23-74` | Global filter that does **not** handle Prisma errors specifically |
| `packages/backend/tests/mocks/index.ts:209-261` | Shared Prisma mock missing newer models |
| `packages/backend/prisma/schema.prisma` | Data model, indexes, relations, `Json` fields |
| `docker/Dockerfile.backend:34,68,74-77,97-98` | `prisma generate`, copy generated client, `prisma migrate deploy` on startup |
| `packages/backend/package.json:23-25` | `prisma:migrate`, `prisma:generate`, `prisma:studio` scripts |

## 9. Overall assessment

| Dimension | Health (1-5) | Notes |
|-----------|--------------|-------|
| Correctness | 3 | Basic lifecycle works, but missing Prisma exception handling, URL validation, and transaction timeout configuration create operational bugs. |
| Performance | 2 | Connection pool not tuned, `findBySourceAndNetwork` loads + filters in memory, no query telemetry, `createdAt` indexing incomplete. |
| Architecture | 2 | Direct `PrismaClient` exposure to ~30 modules violates the hexagonal pattern used elsewhere; `@Global()` hides dependencies. |
| Type safety | 4 | Uses Prisma-generated types consistently, but adapter encapsulation is weak. |
| Security / reliability | 3 | Encrypted `storageState` is good, but log redaction and verbose error formatting are not addressed. |
| Testability | 3 | Shared mock exists but is incomplete; no test database factory. |

**Top 5 risks (ranked by impact × fix effort):**

1. **No repository port / `@Global()` module** — systemic coupling to `PrismaClient`; makes future storage changes expensive. (architectural)
2. **Default transaction timeout for thread assembly** — can abort multi-post generation and leave partial state. (correctness)
3. **Connection pool not tuned** — will degrade under concurrent workers/crons and is hard to debug without query telemetry. (performance/reliability)
4. **No Prisma exception filter** — raw Prisma errors become 500s and may leak internals. (correctness/security)
5. **`findBySourceAndNetwork` in-memory JSON filter** — will scale poorly as the `Post` table grows. (performance)

## 10. Recommended next actions (prioritized)

| Rank | Action | Effort | Module(s) |
|------|--------|--------|-----------|
| 1 | Add explicit transaction timeout overrides at `generation.service.ts:799` and `:882` and set global defaults in `prisma.service.ts` | S | `infrastructure/prisma`, `modules/generation` |
| 2 | Validate `DATABASE_URL` as a PostgreSQL URI in `env.validation.ts:96` | XS | `infrastructure/config` |
| 3 | Add `PrismaClientExceptionFilter` mapping `P2002/P2025/P2024` to NestJS HTTP exceptions | S | `infrastructure/filters` |
| 4 | Expose `PRISMA_CONNECTION_LIMIT`, `PRISMA_POOL_TIMEOUT_MS`, `PRISMA_TRANSACTION_TIMEOUT_MS` and pass to `PrismaClient` | S | `infrastructure/prisma`, `infrastructure/config` |
| 5 | Add a `sourcePath` column + composite index or expression index on `sourceRef->>'path'` | S | `prisma/schema`, `modules/posts` |
| 6 | Add query-telemetry middleware (span per query, slow-query histogram, no raw SQL text) | M | `infrastructure/prisma`, `infrastructure/langfuse` or Sentry |
| 7 | Complete `createMockPrismaService` with all current models | XS | `tests/mocks` |
| 8 | Define `IPrismaPort` / repository ports and migrate high-coupling services incrementally | L | `domain/ports`, `modules/posts`, `modules/sessions`, `modules/accounts` |
| 9 | Add `prisma/seed.ts` for local dev/test fixtures | S | `prisma` |
| 10 | Create a dedicated Postgres integration test in `tests/integration` that runs `prisma migrate deploy` and a real `PrismaService` | M | `tests/integration`, `infra/docker-compose.test.yml` |
