# Module: `modules/accounts`

## 1. What this module does

`modules/accounts` is a small module that manages the `SocialAccount` table. It seeds social accounts from environment variables on startup, exposes a list endpoint, and provides credentials (from env, never DB) to `SessionsService` and `PostingService`. It is the single source of truth for which networks are active and which credentials to use.

**Main responsibilities:**
- `AccountsService` — seed accounts from env, list active accounts, find account by network, retrieve credentials from env.
- `AccountsController` — list configured accounts.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `accounts.module.ts` | NestJS module | `AccountsModule` — imports `WarmupModule` |
| `accounts.service.ts` | Core service | `onModuleInit`/`seedFromEnv()`, `findAll()`, `findByNetwork(network)`, `getCredentials(network)` |
| `accounts.controller.ts` | REST API | `GET /accounts` |

## 3. How it works

### 3.1 `AccountsService.onModuleInit()` / `seedFromEnv()`

- Defines three hardcoded account configs (X, Threads, Facebook) with `handle`, `credentialsRef`, and `warmup`.
- For each network, checks if a `SocialAccount` with that `network` and `handle` already exists.
- If not, creates it with `credentialsRef` and starts warm-up if `SOCIAL_{NETWORK}_WARMUP=true`.
- Does not update existing accounts. This means if credentials change in env, the account row stays with the old handle. To re-seed, the row must be deleted.

### 3.2 `findAll()` / `findByNetwork()`

- `findAll` loads active accounts and includes the latest session.
- `findByNetwork` returns the active account for a network.

### 3.3 `getCredentials(network)`

- Reads `SOCIAL_{NETWORK}_{USERNAME|EMAIL|PASSWORD}` and `SOCIAL_FACEBOOK_PAGE_SLUG` from `ConfigService`.
- Returns credentials object. Never reads from DB.

## 4. Dependencies

**Downstream:**
- `infrastructure/prisma` — `PrismaService`.
- `modules/sessions` — `WarmupService`.
- `infrastructure/config` — `parseBool`.

**Upstream:**
- `modules/sessions` — `SessionsService` uses `findByNetwork` to get `accountId`.
- `modules/posting` — `PostingService` uses `findByNetwork` to get account/handle.
- UI — `AccountsController`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `SOCIAL_X_USERNAME` | `myzodiacai` | `seedFromEnv`, `getCredentials` | X handle / username |
| `SOCIAL_X_PASSWORD` | — | `getCredentials` | X password |
| `SOCIAL_X_WARMUP` | `false` | `seedFromEnv` | Start warm-up for new X account |
| `SOCIAL_THREADS_USERNAME` | `myzodiacai` | `seedFromEnv`, `getCredentials` | Threads handle |
| `SOCIAL_THREADS_PASSWORD` | — | `getCredentials` | Threads password |
| `SOCIAL_THREADS_WARMUP` | `false` | `seedFromEnv` | Start warm-up for new Threads account |
| `SOCIAL_FACEBOOK_EMAIL` | `myzodiacai@facebook.com` | `seedFromEnv`, `getCredentials` | Facebook email |
| `SOCIAL_FACEBOOK_PASSWORD` | — | `getCredentials` | Facebook password |
| `SOCIAL_FACEBOOK_PAGE_SLUG` | — | `getCredentials` | Facebook page slug |
| `SOCIAL_FACEBOOK_WARMUP` | `false` | `seedFromEnv` | Start warm-up for new Facebook account |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `AccountsService.seedFromEnv` does not update existing accounts if the env handle changes**
- `accounts.service.ts:66-69` only checks existence by `network` and `handle`. If an account exists with the old handle, it won't create a new one with the new handle. This means changes to `SOCIAL_X_USERNAME` in env are ignored after the first seed. To update, operator must manually delete the row. This is a data drift issue.

**B2. `AccountsService.seedFromEnv` does not update `active` status or `credentialsRef` for existing accounts**
- If `credentialsRef` changes, the DB still has the old value. Not critical because `credentialsRef` is a static string, but `active` flag could be toggled by env. No env var for `active`.

**B3. `AccountsService.getCredentials` uses `SocialNetwork.X` etc. and returns `username`/`password` for Threads and Facebook. For Facebook, `username` is actually email. The naming is misleading for Facebook.**

**B4. `AccountsService.getCredentials` returns `extra` for Facebook `PAGE_SLUG` but `facebook.poster.ts` may use `account.credentialsRef`? Need to verify. `getCredentials` is not used by `SessionsService` (which reads env directly). It may be used by `facebook.poster.ts` for posting to a page. But `findByNetwork` returns the account. The page slug is only in `getCredentials`. If `facebook.poster.ts` doesn't call `getCredentials`, the page slug is ignored. This is a potential gap.**

**B5. `AccountsService.findByNetwork` returns `findFirst` where `active: true`. If there are multiple accounts for the same network (one active, one inactive), it returns the active one. But if there are multiple active accounts, it returns an arbitrary one. The system is designed for one account per network. Good.**

**B6. `AccountsService.findAll` includes `sessions` with `take: 1` and `orderBy: { createdAt: 'desc' }`. Good. But if the account is in `warmup` and `findAll` returns `warmupEnabled` etc., the UI can display. Good.**

**B7. `AccountsService` `getCredentials` returns `password` from env. It never returns `cookies`. `SessionsService` reads cookies directly from env. This is fine but `getCredentials` is incomplete. `SessionsService` uses `credPrefix` and `configService.get` directly. Maybe `getCredentials` should be used by `SessionsService` to centralize credential access.**

**B8. `AccountsService.seedFromEnv` uses `handle` from env but defaults to placeholder values like `myzodiacai` and `myzodiacai@facebook.com`. If the operator doesn't set `SOCIAL_X_USERNAME`, the account is seeded with `myzodiacai`. This could be fine for testing but misleading in production.**

**B9. `AccountsService` does not validate credentials presence on seed. If `SOCIAL_X_PASSWORD` is missing, it still creates an account. `SessionsService` will fail to login later. Better to validate or mark account inactive if credentials missing.**

**B10. `AccountsService` `warmup` injection is `@Optional()`. If `WarmupModule` is not available, `warmupService` is undefined. Fine. But `AccountsModule` imports `WarmupModule`, so it's available. Good.**

### 6.2 Performance

**P1. `seedFromEnv` does three `findFirst` + `create` calls sequentially. Negligible.**

**P2. `findAll` includes `sessions` with `take: 1`. Good.**

### 6.3 Architecture / anti-patterns

**A1. `AccountsService` is a small, focused service. Good.**

**A2. `AccountsService` seeds accounts from env in `onModuleInit`. This is a one-time bootstrapping. Good.**

**A3. `AccountsService` `getCredentials` uses `ConfigService` but `SessionsService` reads env directly. `AccountsService` is not the single source of truth for credentials. Sessions duplicates env reads. DRY issue.**

**A4. `AccountsService` `findByNetwork` only returns active account. `SessionsService` `getOrCreateSession` uses `findByNetwork` and returns null if no account. Good. But `PostingService` may also use `findByNetwork` and if account is inactive, it fails. Should there be an explicit `enabled` check at `PostingService`? The DB filter handles it.**

**A5. `AccountsService` hardcodes three networks. It cannot support multiple accounts per network or new networks. Good for current scope.**

### 6.4 TypeScript / type safety

**T1. `AccountsService.getCredentials` uses `switch` on `SocialNetwork` but no `default` or `never` exhaustiveness. Good enough.**

**T2. `AccountsService` `seedFromEnv` `accounts` array is inline. Could be a config object. Minor.**

### 6.5 Security / reliability

**S1. `AccountsService` never stores passwords in DB. Good. `credentialsRef` is just the env var name. Good.**

**S2. `AccountsController` `GET /accounts` returns `credentialsRef` which is the env var name. Not sensitive. But it also returns `sessions` with `storageState` (encrypted). Good. However, if `RedactInterceptor` is global, it strips credentials. Good.**

**S3. `AccountsService` `getCredentials` returns the actual password in plaintext to callers. This is necessary for `SessionsService` to use. But the caller must not log or expose. `RedactInterceptor` handles log redaction.**

**S4. `AccountsService` `getCredentials` returns `'SOCIAL_X_USERNAME/PASSWORD'` as `credentialsRef`. This is a string that tells which env vars to read. Not a secret. Good.**

## 7. New feature / improvement ideas

**F1. Add `SOCIAL_{NETWORK}_ACTIVE` env var to enable/disable accounts without deleting DB row**
- Currently `active` is not seeded from env.

**F2. Update existing accounts on seed if env changes**
- Upsert based on `network` instead of `network`+`handle`. Or add `seed` with `update` if `handle` differs.

**F3. Centralize credential access in `AccountsService`**
- `SessionsService` should call `getCredentials` instead of reading env directly. `getCredentials` should include cookies and 2FA email if needed.

**F4. Validate credentials presence on seed**
- If password missing, mark account inactive or warn.

**F5. Support multiple accounts per network**
- Add `accountId` to `Post` and `Session`? Already there. `findByNetwork` returns `findFirst`. To support multiple, `PostingService` would need to select account.

**F6. Add account-level metrics**
- `posts_per_account`, `sessions_per_account`, `login_failures`.

**F7. Add `POST /accounts` / `PATCH /accounts/:id` for dynamic account management**
- UI to manage accounts without env changes.

**F8. Add `AccountsService` method to disable/enable accounts**
- For operational use.

## 8. Cross-references

- `modules/sessions` — `SessionsService` uses `findByNetwork`, `WarmupService`.
- `modules/posting` — `PostingService` may use `findByNetwork` and `getCredentials`.
- `infrastructure/prisma` — `SocialAccount` model.
- `infrastructure/config` — `parseBool`.

## 9. Overall assessment

- **Health**: 7/10. The module is small and does its job. It does not store credentials in DB. However, it doesn't update accounts if env changes, and `SessionsService` duplicates credential env reads.
- **Biggest strengths**: credentials in env, no DB secrets, warm-up integration on seed.
- **Biggest risks**: seed doesn't upsert existing accounts; `getCredentials` not used by `SessionsService`; no env-driven `active` flag; default handles are placeholders.
- **Recommended next actions**:
  1. Upsert accounts on seed (or at least update `handle`/`credentialsRef` on env change).
  2. Add `SOCIAL_{NETWORK}_ACTIVE` env support.
  3. Centralize credential reading: `SessionsService` should call `accountsService.getCredentials`.
  4. Validate credential presence on seed.
