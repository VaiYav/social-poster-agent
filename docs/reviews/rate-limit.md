# Module: `modules/rate-limit`

## 1. What this module does

`modules/rate-limit` provides a Redis-backed sliding-window rate limiter for posts and engagement actions. It enforces per-network daily/weekly limits and a minimum interval between posts. It supports both bare network keys (posting) and composite `NETWORK-ACTION` keys (engagement) with separate limits.

**Main responsibilities:**
- `RateLimitService` — check, record, and report rate-limit status.
- `RateLimitController` — expose `GET /rate-limit/:network/status`.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `rate-limit.module.ts` | NestJS module | `RateLimitModule` |
| `rate-limit.service.ts` | Core service | `checkRateLimit(network)`, `recordPost(network)`, `getStatus(network)` |
| `rate-limit.controller.ts` | REST API | `GET /rate-limit/:network/status` |

## 3. How it works

### 3.1 Limits configuration

- Post limits: `RATE_LIMIT_{X|THREADS|FACEBOOK}_MAX_PER_DAY` (default 1), `_MAX_PER_WEEK` (default 5), `RATE_LIMIT_MIN_DELAY_MS` (default 5 min).
- Interaction limits: `RATE_LIMIT_INTERACTION_{ACTION}_MAX_PER_DAY` / `_MAX_PER_WEEK` (defaults: like 60/300, comment 20/100, follow 15/75, reply 20/100, repost 10/50, quote 5/25), `RATE_LIMIT_INTERACTION_MIN_DELAY_MS` (default 0).
- `resolveLimits(network)` parses `X-like` → `action=like` and returns interaction limits; bare `X` → post limits.

### 3.2 `checkRateLimit(network)`

- If `redis` is missing, returns `allowed: true` with a warning.
- Builds daily/weekly/interval keys based on current UTC date and Monday-based week start.
- Reads `daily` and `weekly` counts from Redis.
- Checks `dailyLimit`, `weeklyLimit`, `minIntervalMs`.
- Does not increment counters — call `recordPost` after success.

### 3.3 `recordPost(network)`

- Increments daily and weekly Redis counters.
- Sets `EX` on first increment (25h for daily, 7d+1h for weekly).
- Sets interval timestamp with `PX` TTL.

### 3.4 `getStatus(network)`

- Returns `dailyCount`, `dailyLimit`, `weeklyCount`, `weeklyLimit`, `lastPostAt`, `minIntervalMs`.

### 3.5 Key formats

- `spa:ratelimit:{network}:daily:{YYYY-MM-DD}`
- `spa:ratelimit:{network}:weekly:{YYYY-MM-DD}` (week start)
- `spa:ratelimit:{network}:interval`

## 4. Dependencies

- `infrastructure/redis` — `SHARED_REDIS`.
- `infrastructure/config` — `ConfigService`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `RATE_LIMIT_PREFIX` | `spa:ratelimit` | constructor | Redis key prefix |
| `RATE_LIMIT_MIN_DELAY_MS` | `300000` | constructor | Min interval between posts |
| `RATE_LIMIT_X_MAX_PER_DAY` | `1` | constructor | X daily post limit |
| `RATE_LIMIT_X_MAX_PER_WEEK` | `5` | constructor | X weekly post limit |
| `RATE_LIMIT_THREADS_MAX_PER_DAY` | `1` | — | Threads daily limit |
| `RATE_LIMIT_THREADS_MAX_PER_WEEK` | `5` | — | Threads weekly limit |
| `RATE_LIMIT_FACEBOOK_MAX_PER_DAY` | `1` | — | Facebook daily limit |
| `RATE_LIMIT_FACEBOOK_MAX_PER_WEEK` | `5` | — | Facebook weekly limit |
| `RATE_LIMIT_INTERACTION_LIKE_MAX_PER_DAY` | `60` | — | Likes daily limit |
| ... | ... | ... | Per-action limits |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `RateLimitService.checkRateLimit` is not atomic**
- `redis.get` for daily, then `redis.get` for weekly, then `redis.get` for interval. Between the three reads, another process could `recordPost`. This can allow a double-post slightly above the limit. For high concurrency, use `Redis` Lua script or `WATCH`/`MULTI`/`EXEC`.

**B2. `RateLimitService.checkRateLimit` and `recordPost` use `new Date().toISOString().slice(0, 10)` for day/week keys. This uses UTC date. Good.**

**B3. `RateLimitService.getWeekStart` uses UTC and computes Monday. Good. But the `weekly` key is the date string of the Monday, not a week number. This is fine.**

**B4. `RateLimitService.recordPost` uses `incr` then `expire` on first increment. This is two commands. If the process crashes between `incr` and `expire`, the key has no TTL. Use `set ... NX EX`? Not for incr. Better to use `incr` with `expire` in a Lua script or use `expire` always (it returns 0 if key doesn't exist, no harm). `expire` always is idempotent. Good.**

**B5. `RateLimitService.checkRateLimit` returns `allowed: true` if Redis is missing. This is fail-open. If Redis is down, unlimited posting. This is risky. Should fail-closed (return false) or at least log a critical alert.**

**B6. `RateLimitController` `getStatus` accepts `network` string and calls `network.toUpperCase()` but doesn't validate. If network is `x-foo`, it becomes `X-FOO`, `resolveLimits` looks for dash and action `foo`. Fine. But if network is `abc`, it resolves to post limits `1/5` with `minIntervalMs=300000`. It doesn't check `network` is valid. Should validate with enum or known keys.**

**B7. `RateLimitService.resolveLimits` for composite keys uses `network.indexOf('-')` and `action = network.slice(dashIdx + 1).toLowerCase()`. If network is `X-foo-bar`, action becomes `foo-bar`. If action is not in `interactionDailyLimits`, falls back to post limits. Fine. But for `X-like`, `action` is `like`. Good.**

**B8. `RateLimitService` interaction limits use `Number(this.configService.get<string>(...)) || def`. If env is set to `'0'`, `Number('0')` is 0, `|| def` returns def. This means `0` cannot be used to disable a limit. Same for `RATE_LIMIT_MIN_DELAY_MS`? It uses `configService.get<number>` (default). If config returns `0`, it will be `0`? `ConfigService.get<number>` returns number, but `0` is valid. However, for interaction, `configService.get<string>` + `Number` + `||` treats `0` as falsy. Could be a bug if someone wants to set `0` to disable. But `interactionMinIntervalMs` defaults to 0 via `|| 0`? Wait `Number(...) || 0` if `Number` is `0`, returns 0 because `0 || 0` is 0. Actually `0 || 0` is 0. If `Number` is `NaN` (empty string), `NaN || 0` is 0. If `Number` is `'foo'` → `NaN || 0` → 0. So `0` works as default. If someone sets `RATE_LIMIT_INTERACTION_MIN_DELAY_MS=1000`, it's 1000. If set to `0`, `Number('0')` is 0, `0 || 0` is 0. Good. But if they set `RATE_LIMIT_INTERACTION_LIKE_MAX_PER_DAY=0`, `Number('0')` is 0, `0 || 60` is 60. So `0` is treated as missing. This is a bug. Should use `Number.isNaN` check.**

**B9. `RateLimitService` `dailyLimits` for post limits uses `configService.get<number>` (with default). If env `'0'`, `ConfigService.get<number>` may return 0 (depending on ConfigModule). If it returns 0, `dailyLimits` is 0. But `checkRateLimit` uses `dailyCount >= dailyLimit` and if `dailyLimit` is 0, no posts allowed. Good. But `ConfigService.get<number>` may parse string as number? It uses `get` which returns string by default? The code passes `1` as default (number). If env value is `'0'`, `get<number>` may return `'0'` (string) and `dailyCount >= '0'` (string comparison) is true? Actually `parseInt('0')` is 0. `dailyCount` is `parseInt(...)` which returns number. `dailyLimit` is `configService.get<number>` which may be string if ConfigService doesn't parse. Then `dailyCount >= dailyLimit` with `dailyLimit` string `'0'` is `0 >= '0'` → true, so no posts allowed. If `dailyLimit` is `'1'`, `dailyCount >= '1'` is `0 >= 1`? Wait, `0 >= '1'` is `0 >= 1` false. If `dailyCount` is `1`, `1 >= '1'` is true. So string comparison can be weird. Better to `Number` the limits. The interaction limits use `Number`. The post limits do not. So if `configService.get<number>` returns string, `dailyLimit` is string. This is a bug. Should `Number(...)` post limits.**

**B10. `RateLimitService.checkRateLimit` uses `parseInt((await this.redis.get(dailyKey)) ?? '0', 10)`. Good. But `dailyLimit` may be string. It should be `Number(dailyLimit)`. Similarly for weeklyLimit.**

**B11. `RateLimitService` `getStatus` returns `dailyCount` and `weeklyCount` parsed. Good. But `dailyLimit`/`weeklyLimit`/`intervalMs` are from `resolveLimits` and may be strings. Should be numbers.**

**B12. `RateLimitService` `recordPost` sets `intervalKey` with `PX` TTL. `intervalMs` may be string. `redis.set(key, value, 'PX', intervalMs)` may accept string. Fine. But `intervalMs` from `resolveLimits` may be string. Should be number.**

**B13. `RateLimitService` `minIntervalMs` in constructor is `globalMinDelay` from `configService.get<number>` with default 300000. If env is `'0'`, `ConfigService.get<number>` may return `'0'` or 0. Then `this.minIntervalMs[net] = globalMinDelay` (string or number). `checkRateLimit` does `intervalMs > 0` and `elapsed < intervalMs` and `waitMs = intervalMs - elapsed`. If `intervalMs` is string `'300000'`, arithmetic with numbers works via JS coercion. But `waitMs` is string subtraction → number. Still works. `recordPost` uses `PX intervalMs` where string is fine. But it's a type issue. Should be `Number(globalMinDelay)`.**

**B14. `RateLimitService` `checkRateLimit` returns reason with `dailyCount`/`dailyLimit` but `dailyLimit` may be string. The message is string concatenation. Fine.**

**B15. `RateLimitService` `onModuleDestroy` is empty. The comment says Redis connection managed by RedisModule. Good.**

**B16. `RateLimitService` `getWeekStart` uses `now.getUTCDate() + diff` to create `Date.UTC` and then `new Date(Date.UTC(...))`. Good. But `diff` can be negative. `getUTCDate() + diff` for a negative diff (e.g., Sunday `diff = -6`) results in a valid previous day. `Date.UTC` handles that. Good.**

**B17. `RateLimitService` `checkRateLimit` checks `dailyCount >= dailyLimit` but `recordPost` increments after posting. So if `dailyLimit` is 1 and `dailyCount` is 0, it allows, then `recordPost` makes it 1. Next check sees 1 and blocks. Good. The `>=` is correct for `recordPost` pre-increment. Since `check` doesn't increment, it allows `dailyLimit` posts. Good. But if `check` and `recordPost` are not called atomically, two concurrent posts can both see 0 and both post. This is the atomic issue.**

**B18. `RateLimitService` `recordPost` increments daily/weekly and sets interval. If `recordPost` is called but the actual post fails, the counters are incremented. Callers should only call `recordPost` after success. PostingService likely calls it after success. Good.**

**B19. `RateLimitService` `checkRateLimit` does not record `lastPostAt` for `recordPost`. The interval key is updated only in `recordPost`. Good.**

### 6.2 Performance

**P1. `RateLimitService.checkRateLimit` does 3 Redis `get` calls sequentially. Could be `Promise.all` or `MGET` for daily/weekly. The interval is independent. But `MGET` can reduce round trips.**

**P2. `RateLimitService.recordPost` does 4 Redis commands (2 incr, 2 expire, 1 set). Could pipeline. But not a hot path for typical volume.**

**P3. `RateLimitController.getStatus` only for one network. Good. No list status.**

### 6.3 Architecture / anti-patterns

**A1. `RateLimitService` uses `ConfigService` for config but doesn't validate numeric values. It uses `Number` for interactions but not for posts. Inconsistent.**

**A2. `RateLimitService` is fail-open on missing Redis (`allowed: true`). Should be configurable (fail-closed for production).**

**A3. `RateLimitService` only supports three hardcoded networks and six interaction actions. New actions require code change. Could be data-driven.**

**A4. `RateLimitService` `checkRateLimit` + `recordPost` is two-step. Not atomic. Could use Redis Lua script or `Redlock`/`ioredis` `multi`.**

**A5. `RateLimitController` `network` param is not validated. Should use `ParseEnumPipe` or validate against `VALID_NETWORKS` or known action suffixes.**

### 6.4 TypeScript / type safety

**T1. `RateLimitService` `dailyLimits` etc. are `Record<string, number>` but may be assigned string values from `configService.get<number>` if ConfigService returns string. Type is `number` but runtime may be string. Need runtime `Number()` conversion.**

**T2. `RateLimitController` `network: string` not `SocialNetwork`. Should validate.**

**T3. `RateLimitService` `resolveLimits` returns `number` but sources may be strings. Type safety is violated.**

### 6.5 Security / reliability

**S1. `RateLimitService` is fail-open on Redis failure. If Redis is down, unlimited posts. This is a reliability risk. Should fail-closed or at least alert.**

**S2. `RateLimitService` counters are not linked to a specific account. If multiple accounts per network, they share the same `network` key. For one account per network, fine. But for multi-account, this is a bug. Should key by `accountId` or `network:accountId`.**

**S3. `RateLimitService` does not protect the `GET /rate-limit/:network/status` endpoint. It exposes counts. Not sensitive. Fine.**

## 7. New feature / improvement ideas

**F1. Make rate-limit check atomic with Lua script or Redis `multi`/`WATCH`**
- Prevent race-condition over-posts.

**F2. Add `failClosed` option for Redis failures**
- Production should fail-closed.

**F3. Add per-account rate limit keys**
- `accountId` in the key for multi-account support.

**F4. Add `Number()` conversion for all numeric env values**
- Fix type safety and `0` handling.

**F5. Add rate-limit status for all networks endpoint**
- `GET /rate-limit/status`.

**F6. Add `recordEngagement(action)` or unify `recordPost` into `record(action)`**
- Use `network` as composite key.

**F7. Add rate-limit metrics**
- `rate_limit_hits_total`, `rate_limit_allowed_total`.

**F8. Add `checkRateLimit` to also return `retryAfter` timestamp**
- Useful for queue delayed scheduling.

**F9. Validate network/action in controller and service**
- Use `ParseEnumPipe` and known action set.

**F10. Add `rate-limit` `reset` admin endpoint**
- Clear counters for a network.

## 8. Cross-references

- `modules/posting` — `PostingService` calls `checkRateLimit` and `recordPost`.
- `modules/engagement` — `EngagementService` may use composite `NETWORK-ACTION` keys.
- `modules/autonomy` — `AutonomousRunnerService` may check rate limits before posting.
- `modules/queue` — queue delay can use rate limit status.
- `infrastructure/redis` — `SHARED_REDIS`.

## 9. Overall assessment

- **Health**: 6/10. The module is simple and functional but has type safety issues, non-atomic check/record, and is fail-open on Redis failure.
- **Biggest strengths**: Redis-backed sliding window, separate interaction limits, UTC week boundaries, TTLs.
- **Biggest risks**: non-atomic `checkRateLimit`/`recordPost` can allow over-posts; fail-open on Redis down; `0` handling for interaction limits; post limits may be strings; no network validation; per-network not per-account.
- **Recommended next actions**:
  1. Add numeric conversion/validation for all limits.
  2. Make `checkRateLimit`/`recordPost` atomic (Lua script or `MULTI`/`EXEC`).
  3. Add per-account keys.
  4. Add fail-closed option for Redis failures.
  5. Validate network in controller.
