# Phase 3 — P2: Stability, Security, Env Validation, Infra Hardening

> **FROZEN CHECKLIST SNAPSHOT.** Status below is historical. Reproduce through
> `PLAN-005` before creating/updating work in `docs/planning/BACKLOG.md`.

Security hardening, environment variable validation, and infrastructure resilience improvements.

---

## 3.1 Env validation gaps (batch quick-win)

### 3.1.1 — `DATABASE_URL` — validate as PostgreSQL URI

**Status:** `[x]` | **Effort:** XS

**Files:** `packages/backend/src/env.validation.ts`

**Description:** `DATABASE_URL` is not validated as a valid PostgreSQL URI. A malformed value (e.g., missing `postgresql://` scheme) would cause a confusing Prisma connection error at runtime instead of a clear validation error at startup. Add a Joi pattern check for `^postgresql://` and a clear error message.

### Checklist

- [x] Read `env.validation.ts` to find the `DATABASE_URL` declaration
- [x] Add `string().uri({ scheme: ['postgres', 'postgresql'] })` or a regex pattern
- [x] Add a test that rejects an invalid URI
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Invalid `DATABASE_URL` is rejected at startup with a clear message

---

### 3.1.2 — `REDIS_URL` — validate as URI

**Status:** `[x]` | **Effort:** XS

**Files:** `packages/backend/src/env.validation.ts`

**Description:** `REDIS_URL` is not validated as a valid Redis URI. A malformed value would cause IORedis to fail with an unclear error. Add a Joi pattern check for `^redis://` or `^rediss://` and a clear error message.

### Checklist

- [x] Read `env.validation.ts` to find the `REDIS_URL` declaration
- [x] Add `string().uri({ scheme: ['redis', 'rediss'] })` or a regex pattern
- [x] Add a test that rejects an invalid URI
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Invalid `REDIS_URL` is rejected at startup with a clear message

---

### 3.1.3 — `DISCORD_WEBHOOK_URL`, `DISCORD_ALERTS_ENABLED` validation

**Status:** `[x]` | **Effort:** XS

**Files:** `packages/backend/src/env.validation.ts`

**Description:** Discord webhook URL and alerts-enabled flag are not declared in the env validation schema. This means typos in these env vars are silently ignored. Declare them with appropriate types and validation (URL for webhook, boolean for alerts).

### Checklist

- [x] Read `env.validation.ts` to find the Discord-related vars
- [x] Add `DISCORD_WEBHOOK_URL: string().uri().optional()`
- [x] Add `DISCORD_ALERTS_ENABLED: boolean().default(false)`
- [x] Add a test that verifies validation
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Discord env vars are declared and validated
- Invalid values are rejected at startup

---

### 3.1.4 — `SSE_CHANNEL` — declare + align default

**Status:** `[x]` | **Effort:** XS

**Files:** `packages/backend/src/env.validation.ts`, `packages/backend/src/infrastructure/sse/sse.service.ts`

**Description:** `SSE_CHANNEL` is not declared in env validation, and the default in the code (`spa:events`) may differ from `.env.example` (`spa:sse`). Declare it and align the default across all locations.

### Checklist

- [x] Search for `SSE_CHANNEL` across the codebase
- [x] Add it to `env.validation.ts` with default `spa:sse` (matching `.env.example`)
- [x] Ensure all code that reads it uses the same default
- [x] Run `npx tsc --noEmit`

### Acceptance criteria

- `SSE_CHANNEL` is declared in env validation
- Default is consistent across codebase and `.env.example`

---

### 3.1.5 — `CAMOUFOX_*`, `BROWSER_*`, `PROXY_*`, `CAPTCHA_*` numeric checks

**Status:** `[x]` | **Effort:** S

**Files:** `packages/backend/src/infrastructure/config/env.validation.ts`, `packages/backend/tests/unit/config/env.validation.spec.ts`

**Description:** Many `CAMOUFOX_*`, `BROWSER_*`, `PROXY_*`, and `CAPTCHA_*` env vars are numeric but not validated as numbers. A non-numeric value (e.g., `BROWSER_POOL_SIZE=abc`) would cause a runtime NaN. Add numeric validation for all these vars.

### Checklist

- [x] Search for all `CAMOUFOX_*`, `BROWSER_*`, `PROXY_*`, `CAPTCHA_*` env vars in the codebase
- [x] Add each to `env.validation.ts` with `number().default(...)` or `number().optional()`
- [x] Add a test that rejects non-numeric values
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- All numeric infra env vars are validated as numbers
- Non-numeric values are rejected at startup

---

### 3.1.6 — `RATE_LIMIT_PREFIX`, `CHECKPOINT_*`, `HOOK_*` — declare

**Status:** `[x]` | **Effort:** S

**Files:** `packages/backend/src/infrastructure/config/env.validation.ts`

**Description:** `RATE_LIMIT_PREFIX`, `CHECKPOINT_*`, and `HOOK_*` env vars are used in the code but not declared in the validation schema. Declare them with appropriate types and defaults.

### Checklist

- [x] Search for these env vars in the codebase
- [x] Add each to `env.validation.ts` with appropriate type and default
- [x] Run `npx tsc --noEmit`

### Acceptance criteria

- All referenced env vars are declared in the validation schema

---

### 3.1.7 — `PRISMA_CONNECTION_LIMIT`, `PRISMA_POOL_TIMEOUT_MS`, `PRISMA_TRANSACTION_TIMEOUT_MS`

**Status:** `[x]` | **Effort:** S

**Files:** `packages/backend/src/infrastructure/config/env.validation.ts`, `packages/backend/src/infrastructure/prisma/prisma.service.ts`, `packages/backend/src/modules/generation/generation.service.ts`

**Description:** Prisma connection tuning env vars are referenced in `prisma.service.ts` but not declared in env validation. Declare them with numeric types and sensible defaults. Also wire `PRISMA_TRANSACTION_TIMEOUT_MS` into the `$transaction` calls (see task 1.3).

### Checklist

- [x] Read `prisma.service.ts` to find which env vars are used
- [x] Add all three to `env.validation.ts` with `number().default(...)`
- [x] Wire `PRISMA_TRANSACTION_TIMEOUT_MS` into `generation.service.ts` transaction options
- [x] Run `npx tsc --noEmit`

### Acceptance criteria

- All Prisma env vars are declared and validated
- `PRISMA_TRANSACTION_TIMEOUT_MS` is used in transaction options

---

## 3.2 Security

### 3.2.1 — Admin role guard on `FlowControlController`

**Status:** `[x]` | **Effort:** S | **Ref:** flow-control.md S1

**Files:** `packages/backend/src/modules/auth/admin.guard.ts`, `packages/backend/src/modules/auth/auth.module.ts`, `packages/backend/src/modules/flow-control/flow-control.controller.ts`, `packages/backend/tests/unit/auth/admin.guard.spec.ts`

**Description:** `FlowControlController` endpoints (pause/resume) are not protected by an admin role guard. Any authenticated user can pause/resume the system, not just admins. Add an admin role guard to all endpoints in this controller.

### Checklist

- [x] Read `flow-control.controller.ts` to find all endpoints
- [x] Add `@UseGuards(AdminGuard)` or equivalent role-based guard
- [x] Add a unit test that verifies non-admin users get 403
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Only admin users can access flow control endpoints
- Non-admin users get 403

---

### 3.2.2 — Admin role guard on `HealthMonitorController`

**Status:** `[x]` | **Effort:** S | **Ref:** health-monitor.md

**Files:** `packages/backend/src/modules/auth/admin.guard.ts`, `packages/backend/src/modules/auth/auth.module.ts`, `packages/backend/src/modules/health-monitor/health-monitor.controller.ts`, `packages/backend/tests/unit/auth/admin.guard.spec.ts`

**Description:** `HealthMonitorController` endpoints (run health check, reconciliation) are not admin-protected. Any authenticated user can trigger expensive health check operations. Add an admin role guard.

### Checklist

- [x] Read `health-monitor.controller.ts` to find all endpoints
- [x] Add `@UseGuards(AdminGuard)` to the controller or individual endpoints
- [x] Add a unit test that verifies non-admin users get 403
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Only admin users can trigger health monitor operations
- Non-admin users get 403

---

### 3.2.3 — `debug-sentry` endpoint — guard or remove from production

**Status:** `[x]` | **Effort:** XS | **Ref:** health.md B3

**Files:** `packages/backend/src/modules/auth/admin.guard.ts`, `packages/backend/src/modules/auth/auth.module.ts`, `packages/backend/src/modules/health/health.controller.ts`, `packages/backend/src/modules/health/health.controller.ts`

**Description:** The `debug-sentry` endpoint triggers a Sentry test event and is exposed in all environments. In production, this could be abused to spam Sentry. Guard it with an admin check or only register the route when `NODE_ENV !== 'production'`.

### Checklist

- [x] Read `health.controller.ts:56` to find the `debug-sentry` endpoint
- [x] Add `@UseGuards(AdminGuard)` or wrap the route registration in a `NODE_ENV` check
- [x] Add a unit test that verifies the endpoint is guarded/absent in production
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `debug-sentry` is not accessible to non-admins or not registered in production

---

### 3.2.4 — Rate limiting on `POST /auth/login`

**Status:** `[x]` | **Effort:** S | **Ref:** auth.md

**Files:** `packages/backend/src/modules/auth/login-rate-limit.guard.ts`, `packages/backend/src/modules/auth/auth.controller.ts`, `packages/backend/src/modules/auth/auth.module.ts`, `packages/backend/src/infrastructure/config/env.validation.ts`, `packages/backend/tests/unit/auth/login-rate-limit.guard.spec.ts`

**Description:** The login endpoint has no rate limiting, making it vulnerable to brute-force attacks. Add a rate limiter (e.g., `@nestjs/throttler` or a custom guard) that limits login attempts per IP (e.g., 5 per minute).

### Checklist

- [x] Read `auth.controller.ts` to find the login endpoint
- [x] Add `ThrottleGuard` or a custom rate-limiting guard
- [x] Configure: 5 attempts per minute per IP
- [x] Add a unit test that verifies rate limiting triggers after 5 attempts
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Login endpoint is rate-limited
- Excessive attempts get 429 Too Many Requests

---

### 3.2.5 — `/auth/logout` add to public routes

**Status:** `[x]` | **Effort:** XS | **Ref:** auth.md B2

**Files:** `packages/backend/src/modules/auth/jwt-auth.guard.ts`, `packages/backend/tests/unit/auth/jwt-auth.guard.spec.ts`

**Description:** `/auth/logout` is not in the public routes list, so the JWT guard blocks it. A user with an expired token cannot log out. Add `/auth/logout` to the public routes list.

### Checklist

- [x] Read `jwt-auth.guard.ts:35` to find the public routes list
- [x] Add `'auth/logout'` to the list
- [x] Add a unit test that verifies logout works without a valid token
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `/auth/logout` is accessible without a valid JWT
- Unit test confirms access

---

### 3.2.6 — `/auth/me` return default admin when `AUTH_ENABLED=false`

**Status:** `[x]` | **Effort:** XS | **Ref:** auth.md B7

**Files:** `packages/backend/src/modules/auth/auth.controller.ts`, `packages/backend/src/modules/auth/auth.service.ts`, `packages/backend/tests/unit/auth/auth.controller.spec.ts`

**Description:** When `AUTH_ENABLED=false`, `/auth/me` returns `null` because there's no JWT. The UI then shows a logged-out state even though auth is disabled. Return a default admin user object when auth is disabled.

### Checklist

- [x] Read `auth.controller.ts:84-87` to find the `/auth/me` handler
- [x] When `AUTH_ENABLED=false`, return `{ username: ADMIN_USERNAME, role: 'admin' }`
- [x] Add a unit test that verifies the default admin response
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `/auth/me` returns a default admin user when auth is disabled
- UI shows logged-in state when auth is off

---

### 3.2.7 — SSE connection limits + rate limiting

**Status:** `[x]` | **Effort:** S | **Ref:** events.md S3, infrastructure-sse.md

**Files:** `packages/backend/src/infrastructure/sse/sse.service.ts`, `packages/backend/src/modules/events/events.controller.ts`, `packages/backend/src/infrastructure/config/env.validation.ts`, `packages/backend/tests/unit/infrastructure/sse.service.spec.ts`, `packages/backend/tests/unit/events.controller.spec.ts`

**Description:** SSE endpoints have no connection limits or rate limiting. A malicious client could open thousands of SSE connections, exhausting server resources. Add a max-connections-per-IP limit and close idle connections after a timeout.

### Checklist

- [x] Read `sse.service.ts` and `events.controller.ts` to find SSE connection handling
- [x] Add a per-IP connection counter and reject new connections above a limit (e.g., 10)
- [x] Add an idle timeout that closes connections with no activity (e.g., 5 minutes)
- [x] Add a unit test that verifies the connection limit is enforced
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- SSE connections are limited per IP
- Idle connections are closed after timeout
- Unit test confirms limits

---

### 3.2.8 — Stop logging partial API keys in `LlmService.onModuleInit`

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-llm.md B17

**Files:** `packages/backend/src/infrastructure/llm/llm.service.ts`

**Description:** `LlmService.onModuleInit` logs partial API keys (e.g., first 4 and last 4 characters) for debugging. Even partial keys can be sensitive in logs, especially if logs are shipped to a central system. Remove the key logging or replace with a boolean `hasKey: true` indicator.

### Checklist

- [x] Read `llm.service.ts` `onModuleInit` to find the key logging
- [x] Replace key logging with `logger.log('Provider X: API key configured')`
- [x] Remove any partial key display
- [x] Run `npx tsc --noEmit`

### Acceptance criteria

- No API key fragments appear in logs
- Provider status is still logged (just without key fragments)

---

### 3.2.9 — `sanitizeUntrustedInput` in all prompt builders with external text

**Status:** `[x]` | **Effort:** S | **Ref:** infrastructure-llm.md B12

**Files:** `packages/backend/src/modules/engagement/engagement-decision.service.ts`, `packages/backend/src/modules/replies/replies-monitor.service.ts`

**Description:** Prompt builders that incorporate external text (scraped comments, trending topics, reply content) do not sanitize the input. A malicious user could inject prompt-injection text via a comment that the bot scrapes. Add `sanitizeUntrustedInput()` to strip control characters, prompt delimiters, and excessive length before including external text in prompts.

### Checklist

- [x] Find or create a `sanitizeUntrustedInput` utility
- [x] Apply it to all external text before it enters a prompt in `engagement-decision.service.ts`
- [x] Apply it in `replies-monitor.service.ts` for scraped comment text
- [x] Apply it in `trending-scraper.service.ts` for scraped trend text
- [x] Add unit tests that verify sanitization strips dangerous content
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- All external text is sanitized before entering prompts
- Unit tests verify sanitization of prompt-injection attempts

---

### 3.2.10 — `JwtAuthGuard` — replace `endsWith` with `@Public()` decorator

**Status:** `[x]` | **Effort:** S | **Ref:** auth.md

**Files:** `packages/backend/src/modules/auth/jwt-auth.guard.ts`

**Description:** `JwtAuthGuard` uses `request.url.endsWith(path)` to check public routes, which is fragile (e.g., `/auth/login/` with trailing slash would not match). Replace with a `@Public()` decorator + `Reflector` metadata approach, which is the NestJS idiomatic pattern.

### Checklist

- [x] Read `jwt-auth.guard.ts` to find the `endsWith` checks
- [x] Create a `@Public()` decorator using `SetMetadata`
- [x] Update `JwtAuthGuard` to use `Reflector.getAllAndOverride` to check for `@Public()`
- [x] Apply `@Public()` to all currently-public routes (`/auth/login`, `/health`, `/auth/logout`)
- [x] Remove the `endsWith` logic
- [x] Add unit tests for both public and protected routes
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Public routes use `@Public()` decorator
- No `endsWith` string matching in `JwtAuthGuard`
- Unit tests confirm both public and protected access

---

## 3.3 Infrastructure hardening

### 3.3.1 — `PrismaClientExceptionFilter` — P2002/P2025/P2024 → HTTP exceptions

**Status:** `[x]` | **Effort:** S | **Ref:** infrastructure-prisma.md B3

**Files:** `packages/backend/src/infrastructure/filters/` (new file)

**Description:** Prisma errors (P2002 unique constraint, P2025 record not found, P2024 transaction timeout) are not caught and converted to HTTP exceptions. They bubble up as 500 Internal Server Error with raw Prisma error messages. Create a `PrismaClientExceptionFilter` that maps these to appropriate HTTP status codes (409, 404, 504).

### Checklist

- [x] Create `prisma-exception.filter.ts` implementing `ExceptionFilter`
- [x] Map P2002 → 409 Conflict, P2025 → 404 Not Found, P2024 → 504 Gateway Timeout
- [x] Register the filter globally in `main.ts`
- [x] Add unit tests for each error code mapping
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Prisma errors are converted to appropriate HTTP status codes
- Raw Prisma error messages are not exposed to clients
- Unit tests cover all mapped error codes

---

### 3.3.2 — `PrismaService` — connection pool tuning

**Status:** `[x]` | **Effort:** S | **Ref:** infrastructure-prisma.md

**Files:** `packages/backend/src/infrastructure/prisma/prisma.service.ts`

**Description:** `PrismaService` does not configure connection pool settings (`connection_limit`, `pool_timeout`). In production with multiple concurrent operations, the default pool size may be too small or too large. Add `connection_limit` and `pool_timeout` to the `DATABASE_URL` or Prisma client config, driven by env vars.

### Checklist

- [x] Read `prisma.service.ts` to find the Prisma client initialization
- [x] Add `connection_limit` and `pool_timeout` parameters from env vars
- [x] Add env vars to `env.validation.ts` (see task 3.1.7)
- [x] Document recommended values in `.env.example`
- [x] Run `npx tsc --noEmit`

### Acceptance criteria

- Connection pool is configurable via env vars
- Defaults are sensible for production

---

### 3.3.3 — `SseService.publish` — catch Redis errors internally

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-sse.md B3

**Files:** `packages/backend/src/infrastructure/sse/sse.service.ts`, `packages/backend/tests/unit/infrastructure/sse.service.spec.ts`

**Description:** `SseService.publish` does not catch Redis PUBLISH errors. If Redis is down, the error propagates to the caller, which may not handle it. Make `publish` fire-and-forget safe by catching errors internally and logging them.

### Checklist

- [x] Read `sse.service.ts` to find the `publish` method
- [x] Wrap the Redis PUBLISH in `try/catch` with `logger.error`
- [x] Ensure the method returns `void` (or a resolved promise) even on error
- [x] Add a unit test that simulates Redis failure and verifies no throw
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `publish` never throws to the caller
- Redis errors are logged
- Unit test confirms graceful failure

---

### 3.3.4 — Discord notifications — retry + circuit breaker

**Status:** `[x]` | **Effort:** S | **Ref:** infrastructure-notifications.md

**Files:** `packages/backend/src/infrastructure/notifications/discord-notification.service.ts`

**Description:** Discord notification sending has no retry logic or circuit breaker. A transient Discord API failure causes a lost alert. Add 2 retry attempts with backoff and a circuit breaker that stops sending after consecutive failures.

### Checklist

- [x] Read `discord-notification.service.ts` to find the send logic
- [x] Add retry logic (2 attempts, exponential backoff)
- [x] Add a circuit breaker (3 failures → 5 min cooldown)
- [x] Add unit tests for retry and circuit breaker behavior
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Transient Discord failures are retried
- Circuit breaker stops sending after consecutive failures
- Unit tests cover both behaviors

---

### 3.3.5 — Discord embed fields — truncate to 1024 chars

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-notifications.md

**Files:** `packages/backend/src/infrastructure/notifications/discord-notification.service.ts`

**Description:** Discord embed field values have a 1024-character limit, but the code does not truncate. Long error messages or post content cause the Discord API to reject the webhook. Truncate all field values to 1024 characters before sending.

### Checklist

- [x] Read `discord-notification.service.ts` to find embed field construction
- [x] Add a `truncate(text, 1024)` utility and apply to all field values
- [x] Add a unit test with a >1024 char field value
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- All embed field values are ≤1024 characters
- Unit test confirms truncation

---

### 3.3.6 — `EncryptionService` — strict 64-hex key validation

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-crypto.md B1

**Files:** `packages/backend/src/infrastructure/crypto/encryption.service.ts`

**Description:** `EncryptionService` validates the encryption key loosely. A malformed key (wrong length, non-hex) could cause subtle encryption errors or data corruption. Add strict validation: exactly 64 hex characters, and share the regex with `env.validation.ts`.

### Checklist

- [x] Read `encryption.service.ts` to find the key validation
- [x] Add strict check: `/^[0-9a-f]{64}$/i`
- [x] Share the regex between `encryption.service.ts` and `env.validation.ts`
- [x] Add a unit test that rejects malformed keys
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Encryption key is strictly validated as 64 hex chars
- Malformed keys are rejected at startup

---

### 3.3.7 — `isEncrypted` — improve check

**Status:** `[x]` | **Effort:** XS | **Ref:** infrastructure-crypto.md B5

**Description:** `isEncrypted` checks if a value starts with `v1:` to determine if it's encrypted. This is fragile — a plaintext value that happens to start with `v1:` would be treated as encrypted. Improve the check by verifying the parts after `v1:` are valid hex and have the expected structure (IV + ciphertext + tag).

### Checklist

- [x] Read `encryption.service.ts` to find `isEncrypted`
- [x] Improve: split by `:`, verify 3 parts, verify each is valid hex, verify expected lengths
- [x] Add unit tests for: valid encrypted, plaintext starting with `v1:`, malformed encrypted
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `isEncrypted` correctly distinguishes encrypted from plaintext
- Edge case `v1:plaintext` is not treated as encrypted

---

### 3.3.8 — Camoufox patch — fail fast in production if not applied

**Status:** `[x]` | **Effort:** S | **Ref:** infrastructure-browser.md

**Files:** `packages/backend/src/infrastructure/browser/browser.factory.ts`

**Description:** The Camoufox `coreBundle.js` patch (see `AGENTS.md`) may not be applied if `postinstall` was skipped. In production, this leads to crashes during engagement browsing. Add a startup check that verifies the patch is applied and fails fast in production if not.

### Checklist

- [x] Read `patch-playwright.js` to understand what the patch modifies
- [x] Add a check in `browser.factory.ts` `onModuleInit` that verifies a known patch site exists in `coreBundle.js`
- [x] If `NODE_ENV=production` and patch is missing, throw an error
- [x] If not production, log a warning
- [x] Add a unit test for both production and non-production behavior
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- Production fails fast if Camoufox patch is not applied
- Non-production logs a warning
- Unit tests cover both paths

---

### 3.3.9 — `QueueFactory` — reuse `SHARED_REDIS` connections

**Status:** `[x]` | **Effort:** M | **Ref:** infrastructure-redis.md B2, cross-module-synthesis.md #5

**Files:** `packages/backend/src/infrastructure/queue/queue.factory.ts:120-131`

**Description:** `QueueFactory` creates its own Redis connections instead of reusing the shared ones from `RedisModule`. This leads to extra connections, wasted memory, and the connection URL being logged. Refactor to inject and reuse the shared Redis connections.

### Checklist

- [x] Read `queue.factory.ts:120-131` to find the Redis connection creation
- [x] Read `redis.module.ts` to find the shared Redis connections
- [x] Inject the shared Redis connections into `QueueFactory`
- [x] Remove the duplicate connection creation
- [x] Verify BullMQ works with the shared connections (BullMQ may need specific connection settings)
- [x] Add a unit test that verifies no new connections are created
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `QueueFactory` reuses shared Redis connections
- No duplicate connections are created
- No Redis URL is logged

---

## 3.4 Health endpoint

### 3.4.1 — Split `/health` into `/health/live` + `/health/ready`

**Status:** `[x]` | **Effort:** S | **Ref:** health.md B2/A1/F1

**Files:** `packages/backend/src/modules/health/health.controller.ts`

**Description:** The single `/health` endpoint returns 200 even when the system is degraded, which is incorrect for Kubernetes readiness probes. Split into `/health/live` (always 200, for liveness) and `/health/ready` (503 when degraded, for readiness). `/health/ready` should check Redis, DB, and queue connectivity.

### Checklist

- [x] Read `health.controller.ts` to find the current `/health` endpoint
- [x] Create `/health/live` — always returns 200
- [x] Create `/health/ready` — checks DB, Redis, queue; returns 503 if any is down
- [x] Keep `/health` as a redirect or alias to `/health/live` for backward compat
- [x] Add unit tests for both endpoints
- [x] Run `npx vitest run tests/unit/`

### Acceptance criteria

- `/health/live` always returns 200
- `/health/ready` returns 503 when any dependency is down
- Backward compatibility maintained for `/health`

---

### 3.4.2 — `HEALTH_CHECK_TIMEOUT_MS` — env-driven

**Status:** `[x]` | **Effort:** XS | **Ref:** health.md B1/F2

**Files:** `packages/backend/src/modules/health/health.controller.ts`

**Description:** The health check timeout is hardcoded to 2000ms. In slower environments, this may be too short and cause false negatives. Make it configurable via `HEALTH_CHECK_TIMEOUT_MS` env var with a default of 2000.

### Checklist

- [x] Read `health.controller.ts` to find the hardcoded timeout
- [x] Replace with `ConfigService.get('HEALTH_CHECK_TIMEOUT_MS', 2000)`
- [x] Add `HEALTH_CHECK_TIMEOUT_MS` to `env.validation.ts`
- [x] Run `npx tsc --noEmit`

### Acceptance criteria

- Health check timeout is configurable via env var
- Default is 2000ms
