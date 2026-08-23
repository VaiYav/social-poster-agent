# 01 — Multi-Account Support: Detailed Implementation Plan

> **Planning boundary:** task status is canonical only under `ACCOUNT-001` in
> [docs/planning](../planning/README.md). Checklists here explain implementation intent
> and are not updated as a parallel backlog.

> Companion to [`01-multi-account.md`](./01-multi-account.md).  
> This plan is based on source-level analysis of the SPA backend, external research (Exa) on multi-account operational security, Camoufox per-context fingerprinting, and Threads/Instagram account linkage.

---

## 0. Executive summary

We want N active social accounts per network in a single SPA instance. The Prisma schema is already largely ready (`SocialAccount` has `network`/`handle`, `Session` and `Post` are keyed to `accountId`). The hard work is moving the **runtime assumption of one account per network** out of:

- `AccountsService` (seed, lookup, credentials)
- `SessionsService` (login/session keyed by network)
- `BrowserFactory` (context pool keyed by network, single Facebook persistent profile)
- `RateLimitService` (Redis keys per network)
- `QueueFactory` (one posting queue per network)
- `PostingService` / `GenerationService` (which account does the post belong to?)

The biggest risk is **account correlation** on Meta platforms (Threads/Instagram/Facebook). The plan therefore makes **browser/session isolation per account non-negotiable**, with per-account fingerprint, per-account persistent profile directory, and per-account proxy override.

### Non-goals for this feature

- Per-account content / brand voice (that's Feature 04). In Feature 01 all accounts share the same prompt; we only assign posts round-robin.
- Advanced account groups with shared proxy/fingerprint profiles. We add the `AccountGroup` table/schema hook but only implement `groupId` storage; group-level orchestration is a follow-up.
- Re-architecting the entire queue system. We add a feature-flagged per-account queue mode behind `BULLMQ_PER_ACCOUNT_QUEUES`, keeping the existing network queue as default.

---

## 1. External research takeaways

### 1.1 Multi-account operational security

Running multiple social accounts safely is fundamentally an **isolation problem** at three layers: browser, network, device/timezone. External best-practice guides emphasize:

- **One isolated identity per account** — no shared cookies, local storage, canvas/WebGL hashes, IP, or timezone.
- **Per-account residential/sticky proxies** and matching timezone/locale. A fingerprint/proxy geography mismatch is a detection signal.
- **Warm-up** and staggered posting. New accounts must not post high-value actions immediately; posting times should be spread 15-30 min apart.
- **Never re-use a proxy** after an account is banned; quarantine it for 30+ days to avoid cross-contamination.
- **Anti-detect browsers** (AdsPower, GoLogin, Multilogin) keep separate profiles per account. SPA uses Camoufox; we must reproduce the same profile isolation ourselves.

### 1.2 Camoufox / per-context fingerprint isolation

Camoufox's default `CAMOU_CONFIG` makes **every context in one browser process share the same global identity**. The `per-context-patches.md` patch set adds per-Playwright-context fingerprinting by exposing `window.setXxx(seed)` functions that self-destruct after first call. The recommended Playwright pattern is:

```js
await context.addInitScript((values) => {
  if (typeof window.setCanvasSeed === 'function') window.setCanvasSeed(values.canvasSeed);
  if (typeof window.setAudioFingerprintSeed === 'function') window.setAudioFingerprintSeed(values.audioSeed);
  if (typeof window.setTimezone === 'function') window.setTimezone(values.timezone);
  // ... etc for navigator, screen, WebGL, WebRTC, fonts, speech voices
});
```

These patches are **not guaranteed to be in the stock `camoufox-js` binary** used by SPA. The implementation must therefore support two modes:

1. **Preferred**: per-context patches available → one browser, many isolated contexts.
2. **Fallback**: per-account browser launch with a custom `Fingerprint` object passed to Camoufox `launchOptions` (or even separate Camoufox processes) when per-context isolation is unavailable.

`camoufox-js` accepts a `fingerprint?: Fingerprint` launch option. We can build a deterministic `Fingerprint` per account using the `fingerprint-generator` package plus a deterministic mutation layer keyed by the account hash.

### 1.3 Threads/Instagram account linkage

Threads does not exist independently of Instagram. One Instagram account maps to exactly one Threads account, and Meta shares security data across Instagram, Threads, Facebook, and WhatsApp. This means:

- For every Threads account we need separate Instagram credentials.
- The `handle` in `SocialAccount` can be the Threads handle; the actual login username is read from env (which may be the Instagram username).
- Cookie/session isolation is critical: logging two Threads accounts into the same browser context will instantly link them in Meta's backend.

---

## 2. Current architecture snapshot

The following files contain the "one account per network" assumption.

### 2.1 Data model (`packages/backend/prisma/schema.prisma`)

- `SocialAccount` has `@@unique([network, handle])` and `@@index([network])` — multi-row support is already possible.
- `Session` is keyed to `accountId`; `Post` and `PostThread` are keyed to `accountId`.
- Missing: `priority`, `displayName`, `groupId`, `fingerprintSeed`, `proxyUrl`, and an `AccountGroup` table.

### 2.2 `AccountsService`

- `seedFromEnv()` seeds exactly one account per enabled network from `SOCIAL_X_USERNAME`, `SOCIAL_THREADS_USERNAME`, etc.
- `findByNetwork(network)` returns **one** `SocialAccount` (uses `findFirst`).
- `getCredentials(network)` reads env vars by network prefix.

### 2.3 `SessionsService`

- `getOrCreateSession(network)` loads `account = findByNetwork(network)`, then reads env credentials by network prefix.
- Session lock key is `login:{network}`. Health checks / ban marks are per `network`.
- `autoLogin(network)` and `tryCookieAuth(network)` assume one set of credentials per network.

### 2.4 `BrowserFactory`

- Context pool maps are keyed by `SocialNetwork` (`Map<SocialNetwork, ...>`).
- `acquireContext(network, storageState)` and `releaseContext(network, context)` have no account context.
- Facebook persistent profile directory is `${profileDir}/${network.toLowerCase()}` (shared for all accounts on the network).
- Per-context fingerprint seeding is not implemented.

### 2.5 `RateLimitService`

- Redis keys are `${prefix}:${network}:daily:${today}` etc. All accounts on a network share the same counter.

### 2.6 `QueueFactory`

- Queue name is `${prefix}-${action}-${network.toLowerCase()}`. One posting worker per network, `concurrency=1`.
- `enqueuePosting(postId, network)` only knows the network.

### 2.7 `PostingService`

- `postById(postId)` uses `post.accountId` only for the warmup check. It then calls `sessionsService.getOrCreateSession(post.network)` and `browser.acquireContext(post.network, storageState)`, so the actual session/browser used is whatever `findByNetwork(network)` returns today.
- Rate-limit check/record uses `String(post.network)`.
- `markSessionExpired/banned` calls pass `post.network`.

### 2.8 `GenerationService`

- `generatePostsForTopic` builds an `accountByNetwork` map with **one** account per network (`findByNetwork(network)`).
- `persistGeneratedPosts` uses `accountByNetwork.get(genPost.network)` and falls back to `findByNetwork(network)`.

### 2.9 `BrowsingSessionService` / `EngagementService` / `TrendingScraperService`

- All call `sessionsService.getOrCreateSession(network)` and `browser.acquireContext(network)` — engagement/trending will also leak cookies across accounts unless changed.

### 2.10 `QueueModule`

- Registers one posting worker per enabled network. Worker calls `postingService.postById(postId)`. The post itself already carries `accountId`, but the worker queue is network-scoped.

### 2.11 Dry-run / live-run CLIs

- `packages/backend/src/dry-run/live-run.cli.ts` and friends call `sessionsService.getOrCreateSession(args.network)` and `browser.acquireContext(args.network)`. They need account selection.

---

## 3. Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Account selection for generation | Round-robin by `priority DESC, createdAt ASC` across active accounts per network | Simple, deterministic, no UI blocking. Later phases can add manual/account-group selection. |
| Credentials storage | Keep env as source of truth; `SocialAccount.credentialsRef` becomes a compact env-var reference string | No passwords in DB. Indexed env vars like `SOCIAL_THREADS_USERNAME_2`/`PASSWORD_2` map to account #2. |
| `findByNetwork` return type | `Promise<SocialAccount[]>` (active, sorted) | Makes multi-account unavoidable for all callers; old single-account callers use `findFirstActiveByNetwork` helper if truly needed. |
| Session key | `login:{accountId}` | Prevents race conditions between accounts on the same network. |
| Browser context key | `{network}:{accountId}` (composite string) | Keeps pool maps simple, gives each account its own pool slot. |
| Facebook persistent profile | `${profileDir}/{network.toLowerCase()}/{accountId}` | Per-account profile directory. Idle persistent contexts should be closed after `PERSISTENT_CONTEXT_IDLE_TTL_MS` to avoid N persistent Firefox processes. |
| Fingerprint isolation | Two-tier: (1) per-context `addInitScript` if Camoufox exposes `window.setXxx`, (2) per-account custom `Fingerprint` object passed to `launchOptions` as fallback | Stock `camoufox-js` may not include per-context patches; the fallback must work out of the box. |
| Per-account proxy | `SocialAccount.proxyUrl` overrides `ProxyRotationService`; otherwise `ProxyRotationService.getProxy(network, accountId)` uses sticky key `{network}:{accountId}` | Allows per-account residential proxies for high-value accounts. |
| Rate-limit keys | Composite string `"{network}:{accountId}"` passed into `RateLimitService` | No Redis script change required; limits become per-account automatically. |
| Queue mode | Default = one queue per network (backward compatible). Flag `BULLMQ_PER_ACCOUNT_QUEUES=true` creates `spa-posting-{network}-{accountId}` with `concurrency=1` | Avoids queue explosion by default while enabling true account isolation for operators who need it. |
| Account group schema | Add `AccountGroup` table and `SocialAccount.groupId` but only implement data model in Feature 01 | Avoids another schema migration later. Group-level proxy/fingerprint is Feature 02 scope. |

---

## 4. Data model changes

### 4.1 Prisma migration

Add fields to `SocialAccount` and a new `AccountGroup` model.

```prisma
model AccountGroup {
  id                  String    @id @default(uuid())
  name                String
  proxyUrl            String?
  timezone            String?
  fingerprintProfile  Json?     // reserved for future group-level preset
  accounts            SocialAccount[]
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}

model SocialAccount {
  id              String         @id @default(uuid())
  network         SocialNetwork
  handle          String
  displayName     String?        // human label, e.g. "Soulwise US"
  priority        Int            @default(0)
  groupId         String?
  group           AccountGroup?  @relation(fields: [groupId], references: [id], onDelete: SetNull)
  fingerprintSeed String?        // optional deterministic seed override
  proxyUrl        String?        // optional per-account proxy override
  credentialsRef  String         // env var reference, e.g. "SOCIAL_THREADS_USERNAME_2,SOCIAL_THREADS_PASSWORD_2"
  active          Boolean        @default(true)
  warmupEnabled   Boolean        @default(false)
  warmupStartedAt DateTime?
  warmupDaysTotal Int            @default(7)
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  sessions        Session[]
  posts           Post[]
  threads         PostThread[]
  interactions    Interaction[]
  browsingSessions BrowsingSession[]

  @@unique([network, handle])
  @@index([network])
  @@index([priority])
  @@index([groupId])
}
```

Migration name: `20260720000000_add_multi_account_fields` (timestamp when implemented). Mark as non-destructive — it only adds nullable columns and a new table.

### 4.2 `credentialsRef` format

`credentialsRef` is a comma-separated list of env var names stored by `AccountsService.seedFromEnv()`. Examples:

- Legacy account #1 (backward compatible):
  - `SOCIAL_THREADS_USERNAME,SOCIAL_THREADS_PASSWORD` (or `SOCIAL_FACEBOOK_EMAIL,SOCIAL_FACEBOOK_PASSWORD,SOCIAL_FACEBOOK_PAGE_SLUG`)
- Indexed account #2:
  - `SOCIAL_THREADS_USERNAME_2,SOCIAL_THREADS_PASSWORD_2`
- With cookies:
  - `SOCIAL_THREADS_USERNAME_2,SOCIAL_THREADS_PASSWORD_2,SOCIAL_THREADS_COOKIES_2`

`AccountsService.getCredentials(account)` parses the reference string and reads those env vars by exact name.

### 4.3 Env var indexing convention

```text
SOCIAL_{NETWORK}_{FIELD}_{N}
```

Fields:
- `USERNAME` (or `EMAIL` for Facebook)
- `PASSWORD`
- `COOKIES`
- `PAGE_SLUG` (Facebook only)
- `WARMUP` (`true`/`false`)
- `ACTIVE` (`true`/`false` — per-account override, default true)
- `PROXY_URL` (optional per-account proxy)
- `DISPLAY_NAME` (optional human label)
- `PRIORITY` (optional integer)

`N` starts at `1`. Existing un-suffixed vars are treated as index `1` and remain valid.

---

## 5. Phase-by-phase implementation

### Phase 1 — Schema + `AccountsService` refactor

**Goal**: seed and query multiple accounts per network; credentials read by account reference.

#### 5.1.1 Files to modify

1. `packages/backend/prisma/schema.prisma` — add fields and `AccountGroup`.
2. `packages/backend/prisma/migrations/2026..._add_multi_account_fields/migration.sql` — generated/verified migration.
3. `packages/backend/src/modules/accounts/accounts.service.ts`
4. `packages/backend/src/modules/accounts/accounts.controller.ts` + new DTOs.
5. `packages/backend/src/infrastructure/config/env.validation.ts` — allow dynamic indexed env vars via `Joi.object().pattern()`.

#### 5.1.2 `AccountsService` changes

- Add `findById(id)`.
- Change `findByNetwork(network)` to return `Promise<SocialAccount[]>` sorted by `priority DESC, createdAt ASC` and filtered by `active: true`.
- Add `findFirstActiveByNetwork(network)` helper for callers that truly need one (e.g. legacy CLI, orchestrator quick checks).
- Add `getNextAccountForNetwork(network, opts?: { excludeAccountId?: string; strategy?: 'round-robin' | 'priority' })`.
  - Round-robin: maintain an in-memory/network Redis key `spa:account:rotation:{network}` storing the last used `accountId`, then pick next active by priority order.
  - Priority: pick the active account with highest `priority`, tie-break `createdAt ASC`.
- Add `getCredentials(account): { username; password; extra?; cookies? }`.
  - Parse `credentialsRef`.
  - For `THREADS`, `username` may be the Instagram username — that is the env operator's responsibility.
- Refactor `seedFromEnv()`:
  - Build a list of networks from `getEnabledNetworks()`.
  - For each network, loop `i = 1, 2, ...` until no `SOCIAL_{NETWORK}_USERNAME_{i}` (and no `EMAIL` for Facebook) is found.
  - For `i === 1`, also accept un-suffixed vars.
  - For each found account:
    - `handle` = env username, or for Facebook the email, or `displayName` override if `SOCIAL_FACEBOOK_DISPLAY_NAME_1` set.
    - `credentialsRef` = comma-separated list of relevant env var names with suffix `_i`.
    - `priority` = `SOCIAL_{NETWORK}_PRIORITY_{i}` or `0`.
    - `displayName` = `SOCIAL_{NETWORK}_DISPLAY_NAME_{i}` or null.
    - `proxyUrl` = `SOCIAL_{NETWORK}_PROXY_URL_{i}` or null.
    - `fingerprintSeed` = `SOCIAL_{NETWORK}_FINGERPRINT_SEED_{i}` or null.
    - `active` = `SOCIAL_{NETWORK}_ACTIVE_{i}` !== 'false'.
    - `warmupEnabled` = `SOCIAL_{NETWORK}_WARMUP_{i}` === 'true'.
    - If account does not exist `(network, handle)`, create it; **do not update existing** to avoid overwriting manual DB edits on every deploy.

#### 5.1.3 `AccountsController` changes

- `GET /accounts` — keep, returns all active accounts with latest session included.
- `GET /accounts?network=THREADS` — filter by network.
- `GET /accounts/:id` — return single account (no credentials).
- `PATCH /accounts/:id` — update `displayName`, `priority`, `groupId`, `active`, `proxyUrl`, `fingerprintSeed`. Reject credential field changes (env stays source of truth).
- `DELETE /accounts/:id` — soft delete, set `active=false`.

#### 5.1.4 `env.validation.ts` changes

Joi does not know dynamically named env vars. Add:

```ts
Joi.object().pattern(/^SOCIAL_(X|THREADS|FACEBOOK)_(USERNAME|EMAIL|PASSWORD|COOKIES|PAGE_SLUG|WARMUP|ACTIVE|PROXY_URL|DISPLAY_NAME|PRIORITY|FINGERPRINT_SEED)_\d+$/, Joi.string().allow(''))
```

Un-suffixed vars remain explicit fields.

#### 5.1.5 Tests

- Unit test: `tests/unit/accounts/accounts.service.spec.ts` (new or extend existing) covering seed with 0/1/2/3 accounts per network and `getNextAccountForNetwork` rotation.
- Integration test: seeding from `process.env` snapshots.

---

### Phase 2 — `SessionsService` per-account

**Goal**: every account has its own login/session lifecycle.

#### 5.2.1 Signature migration

Replace all usages of `getOrCreateSession(network, opts?)` with `getOrCreateSession(accountId: string, network: SocialNetwork, opts?)`.

Callers to update:
- `PostingService.postById`
- `PostingService` self-recovery loop
- `TrendingScraperService`
- `BrowsingSessionService`
- `EngagementService`
- `RepliesMonitorService`
- `live-run.cli.ts`, `dry-run.cli.ts`, health-check CLI
- `refreshSessions()` cron

#### 5.2.2 Internal changes

- Lock key: `login:{accountId}`.
- Load account via `AccountsService.findById(accountId)`. If missing/inactive, return `null`.
- Use `AccountsService.getCredentials(account)` to get username/password/cookies instead of building env prefix from network.
- `tryCookieAuth(accountId, network)` reads the cookie env var referenced by `credentialsRef`.
- `autoLogin(accountId, network)` passes the account into the login flow.
- `markSessionExpired` / `markSessionBanned` accept `accountId` instead of `network`.
- `checkSessionHealth` accepts `accountId` and loads the account's active session.
- `refreshSessions()` cron now iterates over `AccountsService.findAll()` grouped by account, calling `getOrCreateSession(account.id, account.network)`.

#### 5.2.3 Storage state isolation

`Session.storageState` already belongs to an `accountId`; only the lookup path needs fixing. Ensure `PostingService.persistSessionState` saves to the session that was actually used for that post (it already passes `session.id`).

#### 5.2.4 Tests

- Update `tests/unit/sessions/sessions.service.spec.ts` (or create) to inject a specific `accountId`.
- Add integration test for concurrent login attempts for two accounts on the same network (must not share lock).

---

### Phase 3 — `BrowserFactory` per-account isolation

**Goal**: contexts/profiles are keyed by account, and fingerprints are deterministic per account.

#### 5.3.1 `IBrowserPort` interface update

Add an optional `accountId` parameter to all network-scoped methods:

```ts
acquireContext(network: SocialNetwork, storageState?: string, accountId?: string): Promise<BrowserContext>;
releaseContext(network: SocialNetwork, context: BrowserContext, accountId?: string): void;
createContext(network: SocialNetwork, storageState?: string, accountId?: string): Promise<BrowserContext>;
// screenshot already takes network; add accountId to filename disambiguation:
screenshot(page: Page, network: SocialNetwork, phase: ScreenshotPhase, accountId?: string): Promise<string>;
```

Update all call sites (posters, sessions, engagement, trending, dry-run, live-run). Where `accountId` is not known (legacy CLI), pass `undefined`; the factory will fall back to `findFirstActiveByNetwork` internally **only** if absolutely necessary, and log a deprecation warning.

#### 5.3.2 Pool map key change

All `Map<SocialNetwork, ...>` become `Map<string, ...>` keyed by `${network}:${accountId ?? 'default'}`.

- `idleContexts`
- `inUseContexts`
- `pendingCreates`
- `contextWaiters`
- `persistentContexts` and `persistentContextPromises` (for Facebook)
- `persistentContextLastUsed`

#### 5.3.3 Per-account persistent profile directory (Facebook)

Change `launchPersistentContext`:

```ts
const profilePath = join(this.profileDir, network.toLowerCase(), accountId ?? 'default');
```

Ensure parent directories exist. Because each Facebook account now has its own persistent context, we cannot keep all of them open forever. Keep the existing idle TTL sweep but make it close per-account persistent contexts after `PERSISTENT_CONTEXT_IDLE_TTL_MS` of inactivity. When an account is needed again, relaunch.

#### 5.3.4 Fingerprint seeding

Create a new helper `AccountFingerprintService` or a private `BrowserFactory` method `getAccountFingerprint(accountId, seed?)`.

**Approach**

1. Compute a deterministic 64-bit integer hash from `accountId` + `fingerprintSeed` (if provided). Use e.g. `cyrb53` or `fnv1a`.
2. Generate a base `Fingerprint` with `fingerprint-generator` for the configured `targetOs` and locale.
3. Deterministically mutate:
   - `navigator.userAgent` — derive from hash.
   - `navigator.platform` / `oscpu` — pick one of the OS-appropriate values.
   - `navigator.hardwareConcurrency` — 2, 4, 8 based on hash.
   - `navigator.language` / `languages` — from locale or group timezone.
   - `screen.width/height/availWidth/availHeight` — within realistic ranges.
   - `videoCard.vendor/renderer` — choose from a small pool.
   - `fonts` — deterministic subset.
4. Return the mutated `Fingerprint`.

**Launch-time application**

When `camoufox-js` is launched (either shared browser for pooled contexts, or per-account browser), pass the `fingerprint` option with the per-account fingerprint. For pooled contexts where multiple accounts may share a single browser instance, this is not enough if the binary ignores per-context overrides. Therefore also:

5. **Per-context `addInitScript`**: after `context = await browser.newContext(...)`, call `context.addInitScript` with the same deterministic values (timezone, screen dimensions, canvas/audio seeds, navigator properties, WebGL vendor/renderer, WebRTC IPs, font list, speech voices). This is the Camoufox per-context patch pattern. If the functions are not present, the script silently no-ops; the launch-time `fingerprint` still provides isolation at the browser-launch level.

For **maximum safety** when per-context patches are unavailable and multiple accounts are active concurrently, add an env flag `CAMOUFOX_PER_ACCOUNT_BROWSER=true` that forces a **new Camoufox browser instance per account** instead of sharing one browser across pooled contexts. This consumes more memory but guarantees no cross-account fingerprint leakage.

#### 5.3.5 Per-account proxy in `createContext`

`createContext` should resolve proxy order:

1. `SocialAccount.proxyUrl` (if account known).
2. `AccountGroup.proxyUrl` (if `groupId` set and group has proxy).
3. `ProxyRotationService.getProxy(network, accountId)` (sticky key per account).
4. Global `CAMOUFOX_PROXY` / default none.

Use Playwright `proxy` in `contextOptions` for X/Threads. For Facebook persistent contexts, pass proxy at browser launch.

#### 5.3.6 Screenshot path

Include account handle or short account id in screenshot filenames to avoid overwrites:

```ts
`${screenshotDir}/${network.toLowerCase()}/${accountId ?? 'default'}/${phase}-${timestamp}.png`
```

#### 5.3.7 Tests

- Unit tests for `AccountFingerprintService` deterministic output.
- Integration test: two `createContext('THREADS', undefined, accountA)` and `accountB` produce different `navigator.userAgent` and `screen` dimensions.
- Mock test that `releaseContext` with account A does not put the context into account B's idle pool.

---

### Phase 4 — `RateLimitService` per-account keys

**Goal**: each account has its own daily/weekly/interval counters.

#### 5.4.1 Changes

`RateLimitService` already takes an arbitrary `network: string` and uses it verbatim in Redis keys. No service code change is needed — only callers must pass a composite key.

In `PostingService`:

```ts
const rateLimitKey = `${post.network}:${post.accountId}`;
const rateCheck = await this.rateLimitService.checkRateLimit(rateLimitKey);
// ...
await this.rateLimitService.recordPost(rateLimitKey);
```

Env var limits currently use `RATE_LIMIT_{NETWORK}_MAX_PER_DAY`. For per-account keys, `resolveLimits` will look up `dailyLimits['THREADS:account-id']` and fall back to `dailyLimits['THREADS']`. Adjust `resolveLimits` to support a composite key fallback:

```ts
const exact = this.dailyLimits[network]; // e.g. 'THREADS:uuid'
const baseNetwork = network.split(':')[0] as string;
return {
  daily: exact ?? this.dailyLimits[baseNetwork] ?? 1,
  weekly: this.weeklyLimits[network] ?? this.weeklyLimits[baseNetwork] ?? 5,
  intervalMs: this.minIntervalMs[network] ?? this.minIntervalMs[baseNetwork] ?? 300_000,
};
```

Add env vars `RATE_LIMIT_{NETWORK}_MAX_PER_DAY` and `RATE_LIMIT_{NETWORK}_MAX_PER_WEEK` continue to work. If per-account limits are needed later (Feature 02), they can be stored in `SocialAccount` config and passed as composite override.

#### 5.4.2 Tests

- Unit test: two accounts on the same network have independent counters.
- Test composite-key fallback to base network limits.

---

### Phase 5 — `QueueFactory` per-account queues (feature-flagged)

#### 5.5.1 Default mode (network queue)

No change. One queue per network, `concurrency=1`. This serializes posting across **all** accounts on the network. Acceptable for small deployments but one stuck account blocks others.

#### 5.5.2 Per-account queue mode

Env flag `BULLMQ_PER_ACCOUNT_QUEUES=true`.

Modify `QueueFactory`:

- `getQueue(network, action, accountId?)`.
  - If per-account mode and `accountId` provided, queue name = `${prefix}-${action}-${network.toLowerCase()}-${accountId}`.
  - Otherwise = `${prefix}-${action}-${network.toLowerCase()}`.
- `enqueuePosting(postId, network, opts, accountId?)`.
- `registerWorker(network, handler, action, accountId?)`.

When per-account mode is on, `QueueModule.onModuleInit` must register a worker for every **active account**, not just every enabled network. Account list can be fetched from `AccountsService.findAll()`.

Worker handler remains the same: it calls `postingService.postById(postId)`. The post row already knows its `accountId`.

#### 5.5.3 `IPostingQueuePort` update

```ts
interface IPostingQueuePort {
  enqueuePosting(postId: string, network: SocialNetwork, opts?: { priority?: number; delay?: number }, accountId?: string): Promise<void>;
}
```

Update all callers (`PostsController.approve`, `AutoApproveListener`, `PostingService` thread continuation, `Orchestrator`/`AutonomousRunner` posting decisions). They all have the `post` object available and can pass `post.accountId`.

#### 5.5.4 Tests

- Unit test: `getQueue('THREADS', 'posting', 'acc-1')` returns a distinct queue from `getQueue('THREADS', 'posting', 'acc-2')`.
- Integration test: per-account mode registers a worker per active account.

---

### Phase 6 — `PostingService` per-account posting

**Goal**: the account attached to a `Post` is the one used for session, browser, and rate-limit.

#### 5.6.1 Changes

In `postById`:

1. Load `post` with `account` included (or `accountsService.findById(post.accountId)`). If `post.account` is not active, fail the post non-retryably.
2. Use `post.accountId` for:
   - `warmupService.canPost(post.accountId)`
   - `sessionsService.getOrCreateSession(post.accountId, post.network, { deferFormLogin: true })`
   - `browser.acquireContext(post.network, storageState, post.accountId)`
   - `browser.releaseContext(post.network, context, post.accountId)`
   - `rateLimitService.checkRateLimit(`${post.network}:${post.accountId}`)`
   - `rateLimitService.recordPost(`${post.network}:${post.accountId}`)`
3. In self-recovery, `markSessionExpired` and `getOrCreateSession` use `post.accountId`.
4. Pass `post.accountId` to poster `post()`? Posters only need `context` and `content`; but `x.poster.ts`/`threads.poster.ts`/`facebook.poster.ts` may need account-specific selectors or page slug. For Facebook, the page slug comes from `account.credentialsRef` → `getCredentials(account).extra`. Add an optional `account` argument to poster `post()` methods.
5. `scheduleThreadPosting` already has `rootPost` and continuations; use `rootPost.accountId` for `enqueuePosting`.

#### 5.6.2 Poster changes

- Update `BasePoster.post()` signature to accept `account` (or `accountId` + `extra`):
  ```ts
  post(context: BrowserContext, browser: IBrowserPort, content: string, threadItems?: string[], account?: SocialAccount): Promise<PostResult>;
  ```
- `FacebookPoster` reads `account.credentialsRef` → `extra` = page slug.

#### 5.6.3 Tests

- Unit test: `postById` with a post whose `accountId` belongs to account B uses account B's session/browser/rate-limit keys, not account A's.
- Mock test: post fails non-retryably if account is inactive.

---

### Phase 7 — `GenerationService` account assignment

**Goal**: generated posts are assigned to a specific account per network.

#### 5.7.1 Changes

Replace the single `accountByNetwork` map with `accountsByNetwork: Map<SocialNetwork, SocialAccount[]>` (active accounts per network).

In `generatePostsForTopic`:

1. Load `accountsByNetwork` once:
   ```ts
   const accountsByNetwork = new Map<SocialNetwork, SocialAccount[]>();
   await Promise.all(
     resolvedTargetNetworks.map(async (network) => {
       const accounts = await this.accountsService.findByNetwork(network);
       accountsByNetwork.set(network, accounts.filter(a => a.active));
     })
   );
   ```
2. `activeNetworks` now means "networks with at least one active account".
3. The graph still runs once per topic and produces one generated post per network.
4. In `persistGeneratedPosts`:
   - For each `genPost.network`, pick the next account using `accountsService.getNextAccountForNetwork(genPost.network)`.
   - If round-robin, rotate per **post** (not per topic) so repeated topics spread across accounts.
   - Write `accountId: chosenAccount.id` into `Post` and `PostThread`.
5. Expose an optional `accountId` parameter in `generate()` and `generateForTopic()` for manual/API account selection. If provided, generate only for that account on its network.

#### 5.7.2 Multi-stage threads

Thread root and continuations must use the same account. In `generateContinuationContent` loop, reuse the account already assigned to the root post.

#### 5.7.3 Tests

- Unit test: generating 3 topics for `THREADS` with 2 active accounts creates posts alternating between accounts (round-robin).
- Unit test: `generate(..., accountId='acc-b')` assigns all posts for the matching network to account B.

---

### Phase 8 — Engagement / trending / replies per-account

**Goal**: all browser paths respect per-account sessions and contexts.

#### 5.8.1 Callers to update

- `BrowsingSessionService.runBrowsingSession(network, durationSec, accountId?)` — if `accountId` not provided, round-robin active accounts or use orchestrator decision.
- `EngagementService` like/comment/follow/repost/quote — accept `accountId`.
- `RepliesMonitorService` — reply jobs include the target `accountId` of the original post; use that account's session.
- `TrendingScraperService` — for X trends that require login, use the next active X account's session; rotate to avoid exhausting one account.
- `MetricsScraperService` (if it uses sessions) — per-account.

#### 5.8.2 Orchestrator / scheduler changes

The orchestrator and `AutonomousRunner` currently decide which network to post to. They must also pick an account. Use `AccountsService.getNextAccountForNetwork(network)` at decision time and pass `accountId` into action handlers.

#### 5.8.3 Tests

- Integration: two concurrent engagement sessions for two accounts on the same network do not share context.

---

### Phase 9 — Dry-run / live-run / health CLIs per-account

#### 5.9.1 `dry-run/cli.ts` and `live-run.cli.ts`

- Accept `--account-id` or `--account-handle` argument. If omitted, list active accounts and let the user choose, or use `findFirstActiveByNetwork` with a warning.
- Pass `accountId` to `sessionsService.getOrCreateSession()` and `browser.acquireContext()`.

#### 5.9.2 Health checks

- `SessionsService.checkSessionHealth` already needs `accountId`.
- Any cron that iterates networks should iterate active accounts.

---

### Phase 10 — UI / dashboard

**Goal**: operator can see and manage accounts per network.

#### 5.10.1 Backend API additions

Already covered in Phase 1 (`AccountsController`). Additionally:

- `GET /accounts/:id/posts` — recent posts for that account.
- `GET /accounts/:id/sessions` — session history.
- `GET /accounts/:id/rate-limit` — current daily/weekly counts from `RateLimitService` using composite key.

#### 5.10.2 Frontend changes (`packages/ui`)

- Accounts card on dashboard: list active accounts per network, with status (active, warm-up, banned), latest post time, and session health.
- Allow toggling `active` and editing `displayName`/`priority`.
- Generation/approval UI: show which account a draft will be posted to.

---

### Phase 11 — Testing, verification, and rollout

#### 5.11.1 Test layers

1. **Unit** — `AccountsService`, `RateLimitService`, `BrowserFactory` pool key logic, `AccountFingerprintService`.
2. **Integration** — multi-account seeding, per-account session creation, per-account rate-limit independence.
3. **System** — end-to-end: generate → approve → enqueue → post (mocked browser) with two accounts on one network.
4. **Acceptance** — BDD scenarios:
   - Given two Threads accounts, when generating posts, then posts are assigned round-robin.
   - Given account A is rate-limited, when generating for account B, then account B can still post.
   - Given account A session is banned, when posting for account B, then account A is skipped.
5. **Dry-run** — real browser against X/Threads with `--account-id` for each account; verify no cookie/fingerprint leakage.

#### 5.11.2 Verification commands

```bash
cd packages/backend
npx prisma migrate dev  # apply migration
npx tsc --noEmit        # type check
npx vitest run tests/unit/accounts tests/unit/sessions tests/unit/rate-limit tests/unit/browser
npx vitest run tests/integration
npx vitest run tests/system
pnpm dry-run --network=THREADS --account-id=<account-a-id>
pnpm dry-run --network=THREADS --account-id=<account-b-id>
```

#### 5.11.3 Rollout

- Deploy with `BULLMQ_PER_ACCOUNT_QUEUES=false` first (default).
- Add one extra Threads account via indexed env vars and run dry-run for both.
- Enable `BULLMQ_PER_ACCOUNT_QUEUES=true` once dry-run is clean and memory usage is acceptable.
- Monitor Sentry and Redis queue depth per account.

---

## 6. Risk register

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| R1 | Meta links two Threads/Instagram accounts because they share a browser context/profile/proxy | High (ban cascade) | Per-account profile dirs, per-account contexts, per-account proxy, deterministic fingerprint, no cookie sharing, no concurrent context reuse across accounts. |
| R2 | Multiple persistent Firefox profiles (Facebook) consume too much memory | Medium | Close idle persistent contexts after `PERSISTENT_CONTEXT_IDLE_TTL_MS`; allow `CAMOUFOX_PER_ACCOUNT_BROWSER=false` to reuse one browser for pooled contexts when safe. |
| R3 | `findByNetwork` signature change breaks many callers | Medium | Refactor in phases; add `findFirstActiveByNetwork` for callers that cannot handle an array; compiler + tests catch missed call sites. |
| R4 | Rate-limit composite key `"THREADS:uuid"` conflicts with existing interaction action suffixes (e.g. `X-like`) | Low | Use `:` separator consistently; `resolveLimits` already splits on the first `-`; composite keys use `:` so the split stays unambiguous. |
| R5 | `BULLMQ_PER_ACCOUNT_QUEUES=true` spawns many Redis queues/workers and increases memory | Medium | Make it opt-in; operators with 2-3 accounts can stay on network queues. |
| R6 | Deterministic fingerprint generator produces unrealistic/duplicate fingerprints | Medium | Validate generated `Fingerprint` with `fingerprint-generator` realistic ranges; log fingerprint hashes; dry-run compare `navigator.userAgent`/`screen` across accounts. |
| R7 | Indexed env vars not validated by Joi | Low | Use `Joi.object().pattern()` for indexed vars; keep un-suffixed explicit fields for backward compatibility. |
| R8 | `credentialsRef` parsing breaks if env var names contain commas | Low | Document format; env var names do not contain commas. |
| R9 | `Post.accountId` already exists but `PostingService` ignored it — verify no old posts have `accountId` mismatched with their network | Low | Migration should backfill `accountId` from the single active account of that network at migration time; seed runs after migration and creates accounts if missing. |

---

## 7. Open questions / operator decisions

1. **Account rotation strategy**: Round-robin (default) or priority-weighted? The plan implements round-robin with `priority` as tie-breaker. If the operator wants `priority` to mean "always prefer highest priority until rate-limited", implement a `getNextAccountForNetwork` strategy option.
2. **Per-account `ENABLED_NETWORKS`**: Should an account be able to opt out of a globally enabled network? The plan uses `SocialAccount.active` as a global opt-out. Per-network account opt-out is not included.
3. **Threads/Instagram handle divergence**: If an Instagram username differs from the Threads handle, do we need a separate `instagramHandle` field? The plan reuses the env `USERNAME` for login and `handle` for display; if this is insufficient, add `credentialsUsername` JSON field.
4. **Account group proxy/fingerprint**: The `AccountGroup` table is added but not used in Feature 01. Should Feature 02 implement group-level proxy/fingerprint before this ships? Recommendation: no, ship data model now, implement logic in Feature 02.
5. **Facebook multiple pages per account**: One `SocialAccount` per Facebook page or one account with multiple `PAGE_SLUG` env vars? The plan assumes one account per page (credentialsRef includes `PAGE_SLUG_1`, `PAGE_SLUG_2`).
6. **Post-generation account pre-selection**: Should the API allow `POST /generate` with an explicit `accountId` to generate for one account only? Plan includes it as optional in `generate()`; expose in controller if needed.

---

## 8. Migration & env checklist

### 8.1 Deployment checklist

- [ ] Create Prisma migration and apply to production.
- [ ] Backfill `Post.accountId`, `PostThread.accountId`, `Session.accountId` if any rows reference accounts that do not exist (seed will create them).
- [ ] Add indexed env vars for at least one extra account and test in dry-run.
- [ ] Set `BULLMQ_PER_ACCOUNT_QUEUES=false` for first deploy.
- [ ] Run `npx vitest run` and fix failing tests.
- [ ] Run `pnpm dry-run --network=THREADS` for each new account.
- [ ] Enable `BULLMQ_PER_ACCOUNT_QUEUES=true` after validation.
- [ ] Update `.env.example` with indexed var examples.
- [ ] Update dashboard UI to show per-account status.
- [ ] Add Sentry alert for `Session` BANNED status per account.

### 8.2 `.env.example` additions

```text
# Multi-account support (index 1 is the legacy un-suffixed var)
SOCIAL_THREADS_USERNAME_1=myzodiacai
SOCIAL_THREADS_PASSWORD_1=...
SOCIAL_THREADS_COOKIES_1=...
SOCIAL_THREADS_DISPLAY_NAME_1=Main
SOCIAL_THREADS_PRIORITY_1=10
SOCIAL_THREADS_ACTIVE_1=true
SOCIAL_THREADS_WARMUP_1=false
SOCIAL_THREADS_PROXY_URL_1=
SOCIAL_THREADS_FINGERPRINT_SEED_1=

SOCIAL_THREADS_USERNAME_2=myzodiacai_uk
SOCIAL_THREADS_PASSWORD_2=...
SOCIAL_THREADS_COOKIES_2=...
SOCIAL_THREADS_DISPLAY_NAME_2=UK
SOCIAL_THREADS_PRIORITY_2=5
SOCIAL_THREADS_ACTIVE_2=true
SOCIAL_THREADS_WARMUP_2=false
SOCIAL_THREADS_PROXY_URL_2=http://user:pass@uk-proxy.example.com:8080
SOCIAL_THREADS_FINGERPRINT_SEED_2=uk-account-seed

# Queue mode
BULLMQ_PER_ACCOUNT_QUEUES=false

# Browser isolation mode
CAMOUFOX_PER_ACCOUNT_BROWSER=false
```

---

## 9. Appendix: file impact summary

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `AccountGroup`, extend `SocialAccount` |
| `prisma/migrations/..._add_multi_account_fields/migration.sql` | Migration |
| `src/infrastructure/config/env.validation.ts` | Allow indexed env vars |
| `src/modules/accounts/accounts.service.ts` | Multi-account seed, `findByNetwork` → array, `getNextAccountForNetwork`, `getCredentials(account)`, `findById` |
| `src/modules/accounts/accounts.controller.ts` | New endpoints + DTOs |
| `src/modules/sessions/sessions.service.ts` | `getOrCreateSession(accountId, network)`, per-account login/cookies/health |
| `src/modules/sessions/warmup.service.ts` | Accept `accountId` already, verify no network assumption |
| `src/infrastructure/browser/browser.factory.ts` | Pool keys per account, per-account persistent profile, per-account fingerprint/proxy, `accountId` parameter |
| `src/domain/ports/browser.port.ts` | Add `accountId` to context methods |
| `src/infrastructure/proxy/proxy-rotation.service.ts` | `getProxy(network, accountId?)`, per-account sticky key |
| `src/modules/rate-limit/rate-limit.service.ts` | Composite key fallback logic |
| `src/infrastructure/queue/queue.factory.ts` | Optional per-account queues and workers |
| `src/domain/ports/posting-queue.port.ts` | Add `accountId` to `enqueuePosting` |
| `src/modules/queue/queue.module.ts` | Register per-account workers when flag is on |
| `src/modules/posting/posting.service.ts` | Use `post.accountId` everywhere |
| `src/modules/posting/posters/base.poster.ts` and implementations | Accept `account` parameter |
| `src/modules/generation/generation.service.ts` | Per-account selection in `persistGeneratedPosts`, optional `accountId` in `generate()` |
| `src/modules/engagement/browsing-session.service.ts` | Accept `accountId` |
| `src/modules/engagement/engagement.service.ts` | Accept `accountId` |
| `src/modules/replies/replies-monitor.service.ts` | Use post account |
| `src/modules/trending/trending-scraper.service.ts` | Rotate/accept account for X login |
| `src/modules/metrics/metrics-scraper.service.ts` | Per-account if session-based |
| `src/modules/orchestrator/*.ts` and `autonomous-runner.ts` | Pick account before posting |
| `src/dry-run/*.ts`, `src/dry-run/live-run.cli.ts` | `--account-id` argument |
| `src/modules/accounts/accounts.service.ts` `findByNetwork` callers | Update or use `findFirstActiveByNetwork` |
| UI components | Accounts dashboard |
| Tests | New/updated unit/integration/system/acceptance tests |

---

## 10. Appendix: external sources consulted

- [daijro/camoufox `per-context-patches.md`](https://github.com/daijro/camoufox/blob/adc44fc8/docs/per-context-patches.md) — Camoufox per-context fingerprint isolation API.
- [DeepWiki — Camoufox Per-Context Fingerprint Isolation](https://deepwiki.com/daijro/camoufox/5.6-per-context-fingerprint-isolation) — vector-by-vector breakdown.
- [Send.win — Manage Multiple Threads Accounts Without Bans](https://blog.send.win/manage-multiple-threads-accounts-multi-account-management-guide-2026/) — Threads/Instagram linkage and isolation requirements.
- [multiaccountops.com — Full multi-account stack architecture 2026](https://multiaccountops.com/blog/full-multi-account-stack-architecture-in-2026-anti-detect-proxies-phones-automat) — operational security stack (proxy, fingerprint, warm-up, quarantine).
- [Multilogin — Social Media Automation for Multi-Account Workflows](https://multilogin.com/social-media-automation/) — anti-detect profile isolation principles.

---

*Plan generated from source analysis + Exa research. Implementation should be phased; do not merge the whole plan in one PR.*
