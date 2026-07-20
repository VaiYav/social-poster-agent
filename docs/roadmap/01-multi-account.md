# 01 — Multi-Account Support

## Status

Proposal. The current codebase is built around **one active account per network**.

## Problem

The user wants to run **2+ Threads accounts** (and likely the same for X/Facebook later). Today:

- `SocialAccount` already has `@@unique([network, handle])`, so multiple rows per network are possible.
- `AccountsService.findByNetwork()` returns **the first active account** via `findFirst`.
- `SessionsService.getOrCreateSession()` keys sessions by `network`, not account.
- `RateLimitService` uses Redis keys like `rate_limit:x`, shared across all accounts on a network.
- `BrowserFactory` pools contexts per network, not per account.
- `PostingService` uses `post.accountId` but assumes a single account is available.
- `GenerationService` picks one account per network per topic.

This means a second Threads account cannot be posted to independently, and adding one risks platform-side account correlation (same browser fingerprint / cookies / IP).

## Product Outcome

An operator can configure N social accounts per network in the same SPA instance. Each account:

- has its own handle/credentials/cookies,
- has its own persistent session pool,
- has its own rate-limit counter,
- can be enabled/disabled independently,
- is selectable/visible in the dashboard,
- gets distinct content when per-account prompts (Feature 04) are enabled.

## Data Model Changes

No schema rewrite is required for the core table because `SocialAccount` already supports `(network, handle)` uniqueness. Add small helper fields:

```prisma
model SocialAccount {
  // existing fields ...
  displayName      String?  // human label, e.g. "Soulwise US"
  priority         Int      @default(0)  // higher = preferred for round-robin
  groupId          String?  // optional AccountGroup for shared proxy/fingerprint
  fingerprintSeed  String?  // deterministic seed for per-account browser fingerprint
  proxyUrl         String?  // optional per-account proxy override
  active           Boolean  @default(true)
  // ...
}

model AccountGroup {
  id          String    @id @default(uuid())
  name        String
  proxyUrl    String?   // shared rotating/sticky proxy for all accounts in group
  timezone    String?   // e.g. America/New_York
  fingerprintProfile Json? // Camoufox per-context fingerprint preset
  accounts    SocialAccount[]
}
```

Accounts for the same network should be selectable by `priority` and `active`.

## Environment Seeding

Keep env as the source of truth for credentials. Support numbered account suffixes:

```text
SOCIAL_THREADS_USERNAME_1=account_a
SOCIAL_THREADS_PASSWORD_1=...
SOCIAL_THREADS_COOKIES_1=...
SOCIAL_THREADS_ACTIVE_1=true

SOCIAL_THREADS_USERNAME_2=account_b
SOCIAL_THREADS_PASSWORD_2=...
...
```

`AccountsService.seedFromEnv()` should loop indices until no `SOCIAL_{NETWORK}_USERNAME_{N}` is found. Existing un-suffixed vars map to index `1` for backward compatibility.

## Service Changes

### `AccountsService`

- `findByNetwork(network)` → **returns an array** of active accounts sorted by `priority DESC, createdAt ASC`.
- Add `findById(id)`.
- Add `getCredentials(account)` (by account row, not by network).
- Add `getNextAccountForNetwork(network, options?)` for round-robin / priority selection.
- Update controller: `GET /accounts` returns all accounts; `GET /accounts?network=THREADS` filters.

### `SessionsService`

- Change key from `login:{network}` to `login:{accountId}`.
- `getOrCreateSession(accountId, network)`.
- Each account gets its own `Session` row keyed by `accountId`.
- For Threads: remember that every Threads account is backed by an Instagram account; `credentialsRef` per account must point to the matching Instagram credentials.

### `BrowserFactory` / `IBrowserPort`

- Pooled contexts keyed by `network:accountId` instead of `network`.
- For Facebook persistent contexts: store each account in a separate `CAMOUFOX_PROFILE_DIR/{network}/{handle}` directory.
- Use Camoufox per-context fingerprint isolation (`context.addInitScript`) with a deterministic seed derived from `accountId`. Relevant upstream patch docs: `packages/backend/src/infrastructure/browser/browser.factory.ts` currently launches one global Camoufox identity; per-context patches are documented at https://github.com/daijro/camoufox/blob/adc44fc8/docs/per-context-patches.md.
- Optional per-account proxy via `BrowserFactory` launch args or context proxy.

### `PostingService`

- `postById()` already has `post.accountId`; load the account and pass it to session/poster selection.
- Use account-specific session and browser context.
- Queue job id stays `postId` (posts are unique per account after generation).

### `RateLimitService`

- Include `accountId` in Redis keys: `spa:ratelimit:{network}:{accountId}:day`.
- The existing Lua script only needs a composite `network` string (e.g. `"X:account_123"`); however, per-account limits must be configurable (see Feature 02).
- This overlaps with `docs/refactor/phase-6-7-p3-strategic-features.md` 7.5 "Per-account rate limit keys".

### `QueueFactory`

Current queues are `spa-posting-x`, `spa-posting-threads`, `spa-posting-facebook` with `concurrency=1`.

Options:

1. **Single queue per network, concurrency=1** (simplest): all accounts on a network serialize. One stuck account blocks others.
2. **One queue per account**: `spa-posting-x:{accountId}` with concurrency=1. Better isolation but more Redis queues and workers.
3. **One queue per network with worker concurrency = active accounts + per-account mutex**: complex but preserves queue count.

**Recommendation:** start with option 2 behind a flag `BULLMQ_PER_ACCOUNT_QUEUES=true`. When disabled, fall back to option 1 for small deployments.

### `GenerationService`

If accounts share the same prompt/brand voice, the same generated post can be round-robin assigned to accounts. If per-account prompts are enabled (Feature 04), each account needs its own graph run. For this feature:

- Accept an optional `accountId` in generation entry points.
- If no `accountId` is passed, pick the next active account for each network (round-robin) and write `post.accountId`.
- In a future phase, run the graph per account when per-account prompts are on.

## UI / API Changes

- `GET /accounts` — list all accounts with status and latest session.
- `POST /accounts` — create account (credentials still come from env by reference; `credentialsRef` stored).
- `PATCH /accounts/:id` — enable/disable, set `displayName`, `priority`, `groupId`.
- `DELETE /accounts/:id` — soft-delete (set `active=false`) to preserve history.
- Dashboard accounts card with per-account post/session/rate-limit status.

## Stealth & Risk Notes

This is the highest-risk feature because of **account correlation**.

- **Browser fingerprint isolation is non-negotiable.** Multiple Threads accounts accessed from the same browser profile/cookies/IP will be linked by Meta. Use per-context Camoufox fingerprints and, ideally, per-account residential proxies.
- **Threads is not standalone.** Each Threads account is an Instagram account. One Instagram account = one Threads profile. Multi-account means managing separate Instagram credentials per account. See external research: https://blog.send.win/manage-multiple-threads-accounts-multi-account-management-guide-2026/
- **Stagger posting times** and avoid cross-posting identical text across accounts.
- **Session cookies/storage must be isolated** per account. The current `Session.storageState` is per `Session` row and keyed to `accountId` already, so the schema is ready; the code path needs to load the right session.
- **Rate limits per account** prevent one hot account from starving others.

## Acceptance Criteria

- [ ] `AccountsService` seeds N accounts per network from indexed env vars.
- [ ] `findByNetwork` returns an array and all callers handle it.
- [ ] `SessionsService` creates/loads sessions per `accountId`.
- [ ] `BrowserFactory` provides isolated contexts per account (pooled + fingerprint seed).
- [ ] `RateLimitService` keys include `accountId`.
- [ ] `PostingService` posts using the account attached to the `Post` row.
- [ ] `GenerationService` assigns an account to each generated `Post`.
- [ ] Queue worker can process posts for multiple accounts without cross-account cookie leaks.
- [ ] UI lists and manages accounts per network.
- [ ] Dry-run mode works for each account independently.

## Open Questions

- Should accounts be grouped by `AccountGroup` for shared proxy/fingerprint profile, or should every account get its own proxy?
- How do we rotate accounts when posting the same topic? Round-robin, priority, or manual per-post selection?
- Do we allow per-account `ENABLED_NETWORKS`, or is that still global?
- For Threads/Instagram, do we store the Instagram handle separately, or reuse `handle`?

## Effort Estimate

**L** (2-4 weeks). Touches account model, sessions, browser factory, rate limits, queue, posting, generation, and UI. Browser isolation is the hard part.

## Related Internal Docs

- `docs/reviews/accounts.md` (F5 multi-account idea)
- `docs/refactor/phase-6-7-p3-strategic-features.md` 7.5 per-account rate-limit keys
- `docs/features/multi-instance-distribution.md`
- `packages/backend/src/modules/accounts/accounts.service.ts`
- `packages/backend/src/modules/sessions/sessions.service.ts`
- `packages/backend/src/infrastructure/browser/browser.factory.ts`
