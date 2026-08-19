# Module: `modules/sessions`

## 1. What this module does

`modules/sessions` manages persistent browser sessions for posting/engagement across X, Threads, and Facebook. It stores `storageState` (cookies + localStorage) encrypted at rest, acquires sessions on demand, automatically logs in when no active session exists, performs health checks, and handles 2FA/challenge flows (manual in headed mode, email polling + API code submission in headless mode). `WarmupService` is a separate service for new account warm-up phases.

**Main responsibilities:**
- `SessionsService` — get/create sessions, cookie auth, form auto-login, health checks, 2FA code API, cleanup, mark expired.
- `SessionsController` — list sessions, trigger health check, submit 2FA code.
- `WarmupService` — manage `WARMUP` → `ACTIVE` account lifecycle.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `sessions.module.ts` | NestJS module | `SessionsModule` — imports `BrowserModule`, `AccountsModule`, `PrismaModule`, `CryptoModule`, `WarmupModule` |
| `sessions.service.ts` | Core service | `getOrCreateSession(network)`, `healthCheck(network)`, `updateStorageState()`, `createSession()`, `decryptStorageState()`, `markSessionExpired()`, `cleanupExpiredSessions()`, `setVerificationCode()`, `waitForVerificationCode()` |
| `sessions.controller.ts` | REST API | `GET /sessions`, `POST /sessions/health-check?network=X`, `POST /sessions/verify-code?network=X&code=...` |
| `warmup.module.ts` | Module | `WarmupModule` |
| `warmup.service.ts` | Warmup logic | `startWarmup()`, `getWarmupStatus()`, `canPost()`, `completeWarmup()` |

## 3. How it works

### 3.1 `getOrCreateSession(network)`

- Looks up `Account` by `network`.
- Finds the most recent `ACTIVE` session for that account.
- If found, returns it.
- If not, acquires a per-network in-memory lock (`this.sessionLocks`) to avoid concurrent login attempts.
- Double-checks DB after lock acquisition.
- Calls `tryCookieAuth(network)` first (cookie strings from env).
- If cookie auth fails or is absent and `opts.deferFormLogin` + `SESSION_DEFERRED_LOGIN` are true, returns `null` (posting will retry; a relogin cron handles it later).
- Otherwise, enforces `FORM_LOGIN_COOLDOWN_MS` and then calls `autoLogin(network)`.

### 3.2 `autoLogin(network)`

- Loads credentials from `SOCIAL_{X|THREADS|FACEBOOK}_{USERNAME|EMAIL|PASSWORD}` env vars.
- Creates a browser context via `IBrowserPort`.
- For Facebook, first checks `c_user` cookie in persistent context.
- Navigates to the network login page using `navigateWithRetry`.
- Fills username/password using `typeHuman` for X, `pressSequentially` for others.
- Handles X multi-step wizard (username → Next → identity verification → password → 2FA).
- Handles challenge pages (captcha, 2FA, checkpoint) — in headed mode waits up to 600s; in headless mode waits for `c_user` cookie or fails.
- If 2FA is detected for X in headless mode, polls `EmailReaderService` for a code, then falls back to `waitForVerificationCode()` (operator submits via API).
- On success, takes a screenshot, saves `storageState`, encrypts it, and persists a new `Session` row.
- On failure, returns `null` and logs/screenshots.

### 3.3 `healthCheck(network)`

- Loads the latest `ACTIVE` session.
- Decrypts `storageState` with `decryptStorageState()`.
- `acquireContext` from browser pool with the storage state.
- Navigates to the network home page.
- If URL contains `/login` or `/auth`, marks session `EXPIRED`.
- Checks required auth cookies (e.g., `c_user`/`xs` for Facebook, `auth_token`/`ct0` for X, `sessionid` for Threads) and their expiry.
- Marks session `EXPIRED` if cookies are missing or expired.
- Updates `lastHealthCheck` and returns `{ healthy, message }`.
- Always releases context and closes page.

### 3.4 `markSessionExpired` / `cleanupExpiredSessions`

- `markSessionExpired` allows `PostingService` to force a session to `EXPIRED` so `getOrCreateSession` will create a new one.
- `cleanupExpiredSessions` keeps the most recent 5 expired sessions per account and deletes older ones.

### 3.5 2FA verification code API

- `setVerificationCode(network, code)` stores `spa:verify-code:${network}` in Redis with 5-min TTL.
- `waitForVerificationCode(network, timeoutMs)` polls Redis every 2 seconds and deletes the code after consuming it.

### 3.6 `WarmupService`

- `startWarmup` sets `warmupEnabled=true`, `warmupStartedAt`, and `warmupDaysTotal` on the account and creates a `WARMUP` session.
- `getWarmupStatus` computes `daysElapsed` and derives phase: `browse-only` → `light` → `moderate` → `full`.
- `canPost` returns true if not in warm-up or in `moderate`/`full`.
- `completeWarmup` sets `warmupEnabled=false` and updates `WARMUP` sessions to `ACTIVE`.

## 4. Dependencies

**Downstream (called by sessions):**
- `modules/accounts` — `AccountsService`.
- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/crypto` — `EncryptionService`.
- `infrastructure/notifications` — `DiscordNotificationService`.
- `infrastructure/redis` — `SHARED_REDIS` for verification codes.
- `infrastructure/email` — `EmailReaderService`.
- `domain/retry` — `navigateWithRetry`.
- `domain/circuit-breaker` — `CircuitBreakerRegistry`.

**Upstream (callers):**
- `modules/posting` — `PostingService` calls `getOrCreateSession` for each network.
- `modules/engagement` — `BrowsingSessionService` may acquire sessions.
- `modules/health-monitor` — may run health checks or cleanup.
- UI — `SessionsController`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `SOCIAL_X_USERNAME` / `SOCIAL_X_PASSWORD` | `''` | `accounts.service.ts:109-110` | X login credentials (validated in `env.validation.ts`) |
| `SOCIAL_THREADS_USERNAME` / `SOCIAL_THREADS_PASSWORD` | `''` | `accounts.service.ts:114-115` | Threads credentials (validated) |
| `SOCIAL_FACEBOOK_EMAIL` / `SOCIAL_FACEBOOK_PASSWORD` / `SOCIAL_FACEBOOK_PAGE_SLUG` | `''` | `accounts.service.ts:119-121` | Facebook credentials and page slug (validated) |
| `SOCIAL_X_COOKIES` / `SOCIAL_THREADS_COOKIES` / `SOCIAL_FACEBOOK_COOKIES` | `''` | `sessions.service.ts:297-298` `tryCookieAuth()` | Cookie auth for all networks (validated) |
| `FORM_LOGIN_COOLDOWN_MS` | `0` | `sessions.service.ts:118` constructor | Throttle form logins (not validated in `env.validation.ts`) |
| `SESSION_DEFERRED_LOGIN` | `false` | `sessions.service.ts:120` constructor | Defer form login from posting path (not validated) |
| `SESSION_RELOGIN_CRON` | `*/15 * * * *` | `sessions.service.ts:259` `onModuleInit` | Out-of-band relogin cron (not validated) |
| `CAMOUFOX_HEADLESS` | `true` (when unset) | `sessions.service.ts:640`, `:760`, `:943` | Headless mode; set to `false` for manual challenge (not validated; read as `process.env`) |
| `SPA_DRY_RUN` | `false` | `sessions.service.ts:517` | Dump login HTML for debugging (not validated; read as `process.env`) |
| `WARMUP_DAYS_TOTAL` | `7` | `warmup.service.ts:29` | Warm-up duration (validated in `env.validation.ts`) |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `SessionsService` `getOrCreateSession` in-memory lock uses a `Map<string, Promise<void>>` but does not handle rejected promises correctly**
- `sessions.service.ts:145` `await existingLock.catch(() => {});` catches the rejection. But if `autoLogin` throws, the lock promise rejects; `resolveLock()` is in `finally`, so `finally` always resolves. Actually, `lockPromise` resolves when `resolveLock()` is called, which is in `finally` and `try`/`catch` always executes `finally`. So the lock resolves. Good. But if `autoLogin` returns null, `finally` resolves. Good.

**B2. `SessionsService` `getOrCreateSession` does not check `WarmupService.canPost` before creating a session for a new account**
- A new account in `WARMUP` might still get a session created. `WarmupService` is in `WarmupModule`, but `SessionsService` does not inject it. `PostingService` should check `canPost` before calling `getOrCreateSession`. Not sure if it does. But `getOrCreateSession` returning a session for a WARMUP account is not a bug per se; it just creates a session. The `WarmupService` is separate.

**B3. `SessionsService` `autoLogin` for X multi-step uses `page.waitForFunction` with `document.querySelector` and CSS style checks**
- `sessions.service.ts:673-681` waits for `opacity !== '0'` and `pointerEvents !== 'none'` and `aria-hidden !== 'true'`. This is a fragile DOM heuristic. But it is documented and tested in production.

**B4. `SessionsService` `autoLogin` for X uses `input[name="password"]` selector explicitly, not `selectors.passwordInput` (which is broader)**
- `sessions.service.ts:671` `page.locator('input[name="password"]').first()` — `selectors.passwordInput` is `input[name="password"], input[type="password"], input[autocomplete="current-password"]`. The explicit `input[name="password"]` is a subset. It might miss if X changes the password input name. But the `selectors.passwordInput` is not used for the wait. Minor.

**B5. `SessionsService` `autoLogin` for X 2FA `has2FA` uses `isVisible()` + URL regex. The comment says `isVisible` with timeout option is deprecated and returns immediately. It could miss slow-rendering fields. They added URL regex as fallback. Good. But the `twoFAInput.fill(code)` may still fail if the input is not the correct one. It dumps input fields to log. Good.**

**B6. `SessionsService` `autoLogin` sets `lastFormLoginAt` after `discord.warning` but before calling `breaker.execute` — if the form login fails, the cooldown is still set, blocking retries for the cooldown period.**
- `sessions.service.ts:229` `this.lastFormLoginAt.set(network, Date.now());` is set before `breaker.execute(() => this.autoLogin(network))`. This means even if the login fails within the breaker, the next attempt respects the cooldown. That is intended to throttle attempts. But if the login failed due to a transient network issue, the cooldown may be too aggressive. Acceptable.

**B7. `SessionsService` `autoLogin` catches `CircuitOpenError` and returns null, but does not update the breaker failure count for `autoLogin` exceptions? The `breaker.execute` handles failure recording internally.**
- `CircuitBreaker.execute` likely records failure on throw. Good. But `autoLogin` returns `null` on many failures instead of throwing. The breaker won't record a failure for `null` returns. This means the breaker doesn't open for failed logins that return null (most of them). It only opens if `autoLogin` throws. `autoLogin` rarely throws (it catches internal errors and returns null). So the circuit breaker may never trip. This is a bug. The `getOrCreateSession` should consider `null` from `autoLogin` as a failure and call `breaker.recordFailure()` or modify `autoLogin` to throw on terminal failures.

**B8. `SessionsService` `tryCookieAuth` does not verify the `storageState` with `saveStorageState`? It saves after verifying. Good.**

**B9. `SessionsService` `tryCookieAuth` `parseCookieString` parses `name=value` with `;` delimiter. It doesn't support quotes, comma, or `HttpOnly` attributes. Fine for simple env string.**

**B10. `SessionsService` `healthCheck` uses `await context.cookies()` but `context` is from `IBrowserPort.acquireContext`. It may be a `BrowserContext` with `addCookies`? `IBrowserPort` interface likely has `acquireContext`. Fine. But it does not close the context, only `page.close()` and `releaseContext`. Good.**

**B11. `SessionsService` `healthCheck` does not handle `context` `null` from `acquireContext`? It checks `if (!session)`. `acquireContext` could throw or return null. `navigateWithRetry` may throw. It catches top. Good. But `context` type `Awaited<ReturnType<IBrowserPort['acquireContext']>> | null`. `acquireContext` likely returns context. If it returns null, `context.newPage()` would throw. Minor.**

**B12. `SessionsService` `cleanupExpiredSessions` loads all `EXPIRED` sessions with only `id` and `accountId` selected (`packages/backend/src/modules/sessions/sessions.service.ts:1437-1439`) and deletes all but the 5 most recent per account. The projection keeps the payload small, but there is still no `take` / `skip` on the initial query, so a very large table could momentarily load many rows. **

**B13. `SessionsService` `markSessionExpired` only updates one session. Good.**

**B14. `SessionsService` `updateStorageState` and `createSession` encrypt `JSON.parse(storageState)`. If `storageState` is not a valid JSON string, `JSON.parse` throws. Should catch. `createSession` is called from controller? The controller does not expose `createSession` currently. `updateStorageState` is called from posters. If a poster passes invalid JSON, it will crash. But storageState is from `browser.saveStorageState()` which returns JSON string. Good.**

**B15. `SessionsService` `decryptStorageState` is `public` and returns `string`. If `session.storageState` is null (not expected), it returns `'null'`. Good. But `JSON.parse(storageState)` in `updateStorageState` may fail if `decrypt` returns non-string. `EncryptionService.decrypt` returns `unknown`. `decryptStorageState` stringifies it. `updateStorageState` does `JSON.parse(storageState)`. So `storageState` must be JSON string. Good.**

**B16. `SessionsService` `autoLogin` uses `process.env.CAMOUFOX_HEADLESS` instead of `ConfigService` or `this.configService`**
- `sessions.service.ts:640` `const isHeaded = process.env.CAMOUFOX_HEADLESS === 'false';`. This is a `process.env` read. AGENTS.md says `process.env` reads are intentional for some cases, but `CAMOUFOX_HEADLESS` is not in that list. Should be `configService.get('CAMOUFOX_HEADLESS') === 'false'`. Also `parseBool` could be used.

**B17. `SessionsService` `onModuleInit` uses `process.env.SESSION_RELOGIN_CRON` instead of `ConfigService`**
- `sessions.service.ts:259` `const cronExpr = process.env.SESSION_RELOGIN_CRON ?? '*/15 * * * *';`. Same issue.

**B18. `SessionsService` `autoLogin` uses `parseBool(process.env.SPA_DRY_RUN)` in the middle of auto-login**
- `sessions.service.ts:517` `if (parseBool(process.env.SPA_DRY_RUN))`. Should use `configService`.

**B19. `SessionsService` `LOGIN_SELECTORS` is a large hardcoded object. This is a maintenance burden but unavoidable for browser automation.**

**B20. `SessionsService` `LOGIN_SELECTORS` for `THREADS` `submitButton` uses `:has-text("Log in")` but also excludes `Instagram`. The `threads.com` login may share with Instagram. Fine.**

**B21. `SessionsService` `healthCheck` uses `networkidle` waitUntil which is slower than `domcontentloaded` but more reliable. Good.**

**B22. `SessionsService` `getOrCreateSession` `findFirst` orders by `createdAt desc` and returns the newest session. Good.**

**B23. `SessionsService` does not distinguish `network` per account; `accountsService.findByNetwork(network)` returns one account per network. If there are multiple accounts per network, only one is used. Good for single account per network.**

**B24. `WarmupService` `getWarmupPhase` for `totalDays <= 3` uses `daysElapsed < 1` for browse-only, `daysElapsed < 2` for light, else full. It doesn't use `moderate` for short warmups. Fine.**

**B25. `WarmupService` `startWarmup` and `completeWarmup` use `status: 'WARMUP' as SessionStatus`. `WARMUP` is present in the `SessionStatus` enum (`packages/backend/prisma/schema.prisma:37`), so this is not a runtime bug. The `as` cast is still a type-assertion smell, but the value is valid.**

**B27. `SessionsController` `healthCheck` and `submitVerifyCode` type `network` as the literal union `'X' | 'THREADS' | 'FACEBOOK'` and document it via `@ApiQuery({ enum: [...] })`. Runtime validation could be hardened with a `ParseEnumPipe`, but the current implementation is not an unvalidated string cast. **

**B28. `SessionsController` `submitVerifyCode` trims `code` and passes to `setVerificationCode`. It doesn't validate length. Good.**

**B29. `SessionsService` `healthCheck` does not set `status: EXPIRED` if `acquireContext` or `navigateWithRetry` throws. It returns `healthy: false` but leaves the session `ACTIVE`. The next call will retry the same broken session. Should mark `EXPIRED` on navigation errors. This is a gap.**

**B30. `SessionsService` `getOrCreateSession` returns `null` if `account` not found. Posting will fail. Good.**

### 6.2 Performance

**P1. `SessionsService` is 1521 lines and does a lot: cookie auth, form login, 2FA, health check, cleanup, verification code API. This is a God-class / long file.**
- Split into `CookieAuthService`, `FormLoginService`, `SessionHealthService`.

**P2. `SessionsService` `autoLogin` for X uses many `randomDelay` calls (total 30-60s per login). This makes login slow but human-like.**

**P3. `SessionsService` `healthCheck` opens a browser context each time. For frequent health checks, this is heavy. But health checks are likely infrequent.**

**P4. `SessionsService` `cleanupExpiredSessions` loads all expired sessions. Could add `take` to limit.**

### 6.3 Architecture / anti-patterns

**A1. `SessionsService` is a large God-class with many responsibilities**
- Refactor into smaller services.

**A2. `SessionsService` uses `process.env` in multiple places (B16, B17, B18)**
- Inconsistent with `ConfigService` usage in constructor.

**A3. `SessionsService` is tightly coupled to `IBrowserPort` and network-specific selectors**
- The selectors are in `SessionsService` but browser actions are in `IBrowserPort`. Consider `ILoginStrategy` per network.

**A4. `WarmupService` is in `modules/sessions` but not imported by `SessionsService`**
- The separation is good, but `SessionsService` does not use `WarmupService`. `PostingService` may use it.

**A5. `SessionsService` `autoLogin` uses `CircuitBreakerRegistry` but doesn't record failures for `null` returns (B7)**
- The circuit breaker is effectively non-functional.

**A6. `SessionsService` `healthCheck` mutates DB state (sets EXPIRED) within a service that returns a health check result. This is a side effect. Acceptable.**

**A7. `SessionsService` `autoLogin` writes debug HTML to `/tmp/spa-debug` in `SPA_DRY_RUN`. This is a side effect. Fine.**

### 6.4 TypeScript / type safety

**T1. `SessionsService` constructor uses `private readonly redis: InstanceType<typeof import('ioredis').default>`. This is a dynamic import type. Fine.**

**T2. `LOGIN_SELECTORS` object is typed implicitly. `THREADS` and `FACEBOOK` have empty strings for `nextButton`, `twoFactorInput`, etc. This is a code smell. Could use a separate type per network. But acceptable.**

**T3. `SessionsService` `decryptStorageState` accepts `{ storageState: unknown }` and returns `string`. The `unknown` is good. But `session` is passed as `any` from Prisma? `Session` model has `storageState` as `Json` → `unknown`. Good.**

**T4. `SessionsController` `network` param is `string` and cast. Should use `SocialNetwork` enum.**

### 6.5 Security / reliability

**S1. `SessionsService` stores credentials in env vars and cookies in env vars. If env is secure, fine. But the `SOCIAL_*` credentials are plaintext. `EncryptionService` only encrypts `storageState`. Credentials are not encrypted at rest. This is expected for env vars.**

**S2. `SessionsService` `decryptStorageState` is public, so any caller can decrypt. It requires the encryption key. Fine. But it exposes the `storageState` string to any caller. `PostingService` needs it.**

**S3. `SessionsController` endpoints can be called by any authenticated user (if `AUTH_ENABLED`). `GET /sessions` exposes storageState? `prisma.session.findMany` includes `account` but `storageState` is encrypted. Good.**

**S4. `SessionsController` `healthCheck` is a POST but no body. Could be GET. Minor.**

**S5. `SessionsService` `autoLogin` logs `username` length and `password` length? It logs `username.length` and `password` length? It logs `username.length` in debug, not the actual value. Good. But `password` length is logged in debug. Good.**

**S6. `SessionsService` `updateStorageState` and `createSession` use `JSON.parse(storageState)`. If `storageState` is a string from an untrusted source (controller), it could be a vector. But `SessionsController` doesn't expose these. They are called internally by `PostingService`. Fine.**

**S7. `SessionsService` `verification code` is stored in Redis with `EX 300`. Good. But `waitForVerificationCode` uses a busy-wait loop with `randomDelay`. It could be improved with Redis pub/sub or `BLPOP`/`BRPOP`. Minor.**

**S8. `SessionsService` `autoLogin` for X in headed mode waits up to 120s for 2FA, in challenge mode up to 600s. In a container, headed mode may not work. But the code handles it. Good.**

**S9. `SessionsService` `getOrCreateSession` if `opts.deferFormLogin` and `SESSION_DEFERRED_LOGIN` true returns `null` and `PostingService` will fail the post with retryable. The out-of-band `refreshSessions` cron should eventually create a session. But if the cron is not running (or `SESSION_DEFERRED_LOGIN` false), the post is retried and fails. Good design.**

## 7. New feature / improvement ideas

**F1. Fix `CircuitBreaker` usage in `getOrCreateSession`**
- Record `null` from `autoLogin` as a failure. Or wrap `autoLogin` to throw on terminal failure.

**F2. Use `ConfigService` for `CAMOUFOX_HEADLESS`, `SPA_DRY_RUN`, `SESSION_RELOGIN_CRON`**
- Remove `process.env` reads.

**F3. Add `ParseEnumPipe` for `network` in `SessionsController`**
- Validate network.

**F4. Add `SessionsService` `healthCheck` mark EXPIRED on navigation errors**
- Currently only marks on URL/cookie checks.

**F5. Refactor `SessionsService` into smaller services**
- `CookieAuthService`, `FormLoginService`, `SessionHealthService`, `VerificationCodeService`.

**F6. Add `ILoginStrategy` per network**
- Inject strategies and remove network `if/else` in `SessionsService`.

**F7. (Resolved) `WARMUP` is already in the Prisma `SessionStatus` enum (`packages/backend/prisma/schema.prisma:37`). Remove the stale warning or convert it to a type-hardening task (drop the `as SessionStatus` cast).**

**F8. Add `SessionsService` `cleanupExpiredSessions` `take` limit**
- Performance.

**F9. Add `SessionsService` metrics**
- `session_created`, `session_expired`, `login_failed`, `health_check_failures`.

**F10. Add `verification code` via Redis pub/sub or `BLPOP`**
- Avoid busy-wait.

**F11. Add `autoLogin` fallback to manual operator queue for non-2FA challenges**
- Use a "pending manual action" queue with UI.

**F12. Add `SessionsService` `getOrCreateSession` check for `WarmupService.canPost`?**
- Not sessions' responsibility; but `PostingService` should ensure warm-up phase is respected.

**F13. Add `healthCheck` endpoint for all networks (`POST /sessions/health-check/all`)**
- UI convenience.

## 8. Cross-references

- `modules/posting` — `PostingService` calls `getOrCreateSession` and `markSessionExpired`.
- `modules/accounts` — `AccountsService`.
- `infrastructure/browser` — `IBrowserPort`.
- `infrastructure/crypto` — `EncryptionService`.
- `infrastructure/email` — `EmailReaderService`.
- `infrastructure/notifications` — `DiscordNotificationService`.
- `infrastructure/redis` — `SHARED_REDIS`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.
- `domain/retry` — `navigateWithRetry`.
- `domain/circuit-breaker` — `CircuitBreakerRegistry`.

## 9. Overall assessment

- **Health**: 5/10. The module is functional and handles complex login flows well, but it is a 1521-line God-class, has `process.env` reads, non-functional circuit breaker for `null` failures, and `healthCheck` doesn't expire sessions on navigation errors.
- **Biggest strengths**: encrypted `storageState` at rest, cookie-first auth, 2FA/challenge handling with manual/API fallback, health check with auth cookie validation, `SESSION_DEFERRED_LOGIN` design.
- **Biggest risks**: circuit breaker not tripping on failed logins; `process.env` reads; health check leaves broken sessions ACTIVE; cleanup loads all expired sessions without a `take` limit.
- **Recommended next actions**:
  1. Fix circuit breaker to record `autoLogin` failures (return null as failure).
  2. Replace `process.env` reads with `ConfigService`.
  3. Add `ParseEnumPipe` to `SessionsController`.
  4. Mark sessions EXPIRED on `healthCheck` navigation errors.
  5. Harden `WarmupService` `SessionStatus` casts (or remove them) — `WARMUP` is already a valid enum value.
  6. Refactor `SessionsService` into smaller services.
