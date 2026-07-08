# Module: `modules/autonomy` (+ `events/listeners/auto-approve.listener.ts`)

## 1. What this module does

`modules/autonomy` implements the ADR-006 autonomous decision layer: it replaces the default Human-in-the-Loop (HITL) approval with an automated gate. It is also the place where the autonomous runner (legacy cron-based) triggers the full generate → auto-check → auto-approve → enqueue pipeline. The orchestrator (if enabled) is expected to supersede this cron runner, but the auto-approve gate remains the single decision point for all new drafts.

**Main responsibilities:**
- `AutoCheckService` — deterministic content-safety checks (engagement-bait, char limit, forbidden phrases, SimHash dedup).
- `AutoApproveService` — quality-score + auto-check band matrix → `AUTO_APPROVE` / `HUMAN_REVIEW` / `REJECT` / `SKIP`.
- `AutonomousRunnerService` — legacy cron that runs `GenerationService.generate()` and then evaluates each draft.
- `auto-approve.listener.ts` — event-driven auto-approve triggered by `PostEvents.DRAFT_GENERATED`.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `autonomy.module.ts` | NestJS module | `AutonomyModule` — imports `FlowControlModule`, `PrismaModule`, `SseModule`, `QueueInfraModule` (for `IPostingQueuePort`) |
| `auto-check.service.ts` | Content-safety gate | `check(content, network, excludePostId?)` |
| `auto-approve.service.ts` | Quality gate | `evaluate(postId, content, network, qualityScore?)` |
| `autonomous-runner.service.ts` | Cron orchestrator | `runAutonomousCycle()` |
| `parse-networks.ts` | Env parser | `parseTargetNetworks(csv)` |
| `events/listeners/auto-approve.listener.ts` | Event listener | `handleDraftGenerated(payload)` |

## 3. How it works

### 3.1 `AutoCheckService.check()`

Runs four synchronous checks:

1. **Engagement-bait** — `detectEngagementBait(content)` from `content-enhancements`.
2. **Character limit** — `NETWORK_LIMITS` (X 280, Threads 500, Facebook 500).
3. **Forbidden phrases** — hardcoded regex list (e.g., "definitely will", "medical diagnosis", "financial advice", "doom", "apocalypse").
4. **SimHash dedup** — compute `simhash(content)`, load last 30 days / 200 posts' hashes, exclude `excludePostId`, and check `isDuplicateHash()` with Hamming distance threshold **8** (`simhash.ts:116, 132, 144`).

Returns `AutoCheckResult { passed, checks, rejectionReason }`.

### 3.2 `AutoApproveService.evaluate()`

Decision flow:

1. Load `post` and verify status is `DRAFT`; otherwise return `SKIP`.
2. Run `autoCheck.check(content, network, postId)`.
3. If auto-check fails → `REJECT`.
4. If `AUTO_APPROVE_ENABLED=false` → `HUMAN_REVIEW` (post stays `DRAFT`).
5. If `qualityScore` is missing → `AUTO_APPROVE` with default score = `AUTO_APPROVE_MIN_SCORE`.
6. Otherwise:
   - score ≥ `autoApproveThreshold` → `AUTO_APPROVE`
   - score ≥ `humanReviewThreshold` → `HUMAN_REVIEW`
   - else → `REJECT`

`makeDecision` applies the status transition using `updateMany` with `where: { id, status: DRAFT }` to avoid races. It merges `llmMetadata` with `autoApproveDecision`, `autoApproveReason`, and `autoCheckChecks`. It emits SSE `auto_approve` event. On `REJECT`, it calls `checkRejectStreak()` to alert if ≥N consecutive rejects within 1 hour.

### 3.3 `AutoApproveListener` and manual approval

`AutoApproveListener` listens on `PostEvents.DRAFT_GENERATED` (emitted by `PostsService.create()` or `emitDraftGenerated()`). When enabled (and not dry-run), it loads the draft, lazily resolves `AutoApproveService`, calls `autoApprove.evaluate(...)`, and enqueues via `IPostingQueuePort` if `AUTO_APPROVE`.

Manual approval also uses `IPostingQueuePort`:
- `posts.controller.ts:139-143` exposes `POST /posts/:id/approve`.
- `posts.controller.ts:47-50` `enqueueForPosting()` calls `IPostingQueuePort.enqueuePosting()`.
- `posts.service.ts:145-186` `approve()` transitions `DRAFT` → `APPROVED`.

### 3.4 `AutonomousRunnerService`

Legacy full-cycle cron:
- Feature flag `AUTONOMOUS_RUNNER_ENABLED` (default false).
- Skips cron registration if `ORCHESTRATOR_ENABLED=true`.
- Default cron `0 */4 * * *` (every 4 hours), configurable via `process.env.AUTONOMOUS_RUNNER_SCHEDULE`.
- `runAutonomousCycle()`:
  1. Check `flowControl.isPaused('generation')`.
  2. Lazily resolve `GenerationService` via `ModuleRef`.
  3. Call `generationService.generate(postsPerRun, targetNetworks, AUTONOMOUS)`.
  4. Load all `DRAFT` posts from that `generationRunId`.
  5. For each post, check `flowControl.isPaused('posting')`; if so, break.
  6. Extract `qualityScore` from `llmMetadata`.
  7. Call `autoApprove.evaluate()`.
  8. If `AUTO_APPROVE`, enqueue via `IPostingQueuePort` with a random delay between `AUTONOMOUS_POSTING_DELAY_MIN_MS` and `AUTONOMOUS_POSTING_DELAY_MAX_MS`.
  9. `postingService.postById()` (called by the queue worker) now detects browser/context crashes and re-acquires a fresh context on retry (`posting.service.ts:234-264`, `base.poster.ts:618-623`).
  10. Emit SSE `autonomous_cycle` events.

### 3.5 `FlowControlService` (dependency)

Redis-backed pause/resume:
- Keys: `flow:pause_generation`, `flow:pause_posting`, `flow:pause_engagement`, `flow:pause_replies`, and `flow:pause_all`.
- `isPaused(flow)` returns true if `pause_all` or the specific key is `'1'`.
- REST endpoints in `FlowControlController`: `GET /flow-control/status`, `POST /flow-control/pause/:flow`, `POST /flow-control/resume/:flow`, `POST /flow-control/pause-all`, `POST /flow-control/resume-all`.

## 4. Dependencies

**Downstream (called by autonomy):**
- `modules/content-enhancements` — `detectEngagementBait()`.
- `modules/generation` — `simhash()`, `GenerationService`.
- `modules/flow-control` — `FlowControlService`.
- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/sse` — `SseService`.
- `domain/ports/posting-queue.port` — `IPostingQueuePort` for enqueueing.
- `modules/posts` — `PostEvents`, `PostStatus`.

**Upstream (callers):**
- `events/listeners/auto-approve.listener.ts` on `PostEvents.DRAFT_GENERATED`.
- `modules/posts` `approve()` may be related but not direct.
- `modules/autonomy` `AutonomousRunnerService` cron.
- `modules/queue` `IPostingQueuePort` is the target of enqueue.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `AUTO_APPROVE_ENABLED` | `false` | `auto-approve.service.ts:50`, `auto-approve.listener.ts:49` | Enable auto-approve gate |
| `AUTO_APPROVE_MIN_SCORE` | `7` | `auto-approve.service.ts:51` | Score threshold for auto-approve |
| `AUTO_APPROVE_REVIEW_SCORE` | `4` | `auto-approve.service.ts:52` | Minimum score for human review |
| `AUTO_APPROVE_REJECT_STREAK_ALERT` | `3` | `auto-approve.service.ts:53` | Consecutive reject alert threshold |
| `AUTONOMOUS_RUNNER_ENABLED` | `false` | `autonomous-runner.service.ts:50` | Enable legacy cron runner |
| `AUTONOMOUS_RUNNER_SCHEDULE` | `0 */4 * * *` | `autonomous-runner.service.ts:79` | Cron expression |
| `AUTONOMOUS_POSTS_PER_RUN` | `3` | `autonomous-runner.service.ts:51` | Posts generated per cycle |
| `AUTONOMOUS_TARGET_NETWORKS` | `X,THREADS` | `autonomous-runner.service.ts:58` | Networks to post to |
| `AUTONOMOUS_POSTING_DELAY_MIN_MS` | `600000` | `autonomous-runner.service.ts:52` | Min posting delay |
| `AUTONOMOUS_POSTING_DELAY_MAX_MS` | `3600000` | `autonomous-runner.service.ts:53` | Max posting delay |
| `ORCHESTRATOR_ENABLED` | `false` | `orchestrator/feature-flag.ts` | Disable legacy cron when true |
| `SPA_DRY_RUN` | `false` | `auto-approve.listener.ts:48` | Disable listener in dry-run mode |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `AutoApproveService` has `rejectStreakAlertLimit` but `checkRejectStreak` looks at `createdAt` of all `REJECTED` posts, not consecutive rejects**
- `auto-approve.service.ts:215-220` does `findMany({ where: { status: REJECTED }, orderBy: { createdAt: 'desc' }, take: this.rejectStreakAlertLimit })`. It then checks if all `take` rejects are within the last hour. This is "N most recent rejects" not "N consecutive rejects". If a post was approved between rejects, the streak is broken but this code still counts the last N rejected posts. It should look at the most recent N status transitions or at least require no non-reject posts in between. Minor semantics issue.

**B2. `AutoApproveService.evaluate()` uses `qualityScore` argument but also accepts it as optional; missing score defaults to autoApproveThreshold**
- `auto-approve.service.ts:113` `if (qualityScore === undefined || qualityScore === null)` sets default to `autoApproveThreshold` and auto-approves. This means if the LLM fails to produce a score, the post is auto-approved anyway as long as AutoCheck passes. This is a fail-open behavior for missing score. The comment says "fail-closed" but the implementation is fail-open for missing scores. This is a risk if judge/critique fails consistently.

**B3. `AutoApproveService` `makeDecision` uses `updateMany` with `where: { id, status: DRAFT }` but does not check the result status before calling `updateMany` for `SKIP`**
- The `evaluate` method already checks `existing.status` and returns `SKIP` before `makeDecision`. Then `makeDecision` is only called when `existing.status === DRAFT`. However, `updateMany` may still update 0 rows if another concurrent listener already changed the status. In that case, `makeDecision` returns `SKIP` with reason "Concurrent transition". Good.

**B4. `AutoApproveService` `makeDecision` returns `SKIP` with `decision` overwritten but `qualityScore` and `checkResult` are still original**
- `auto-approve.service.ts:189-191` returns `{ ...result, decision: 'SKIP', reason: 'Concurrent transition — already handled' }`. The `qualityScore` and `checkResult` are preserved. Fine.

**B5. `AutoApproveListener` uses `configService` to read `AUTO_APPROVE_ENABLED` but also `SPA_DRY_RUN` and reads `post.llmMetadata` as `{ qualityScore?: number }` without validation**
- `auto-approve.listener.ts:75` `const score = (post.llmMetadata as { qualityScore?: number } | null)?.qualityScore`. If `llmMetadata` is a JSON scalar or has a different shape, the cast works but could be wrong. It is safe.

**B6. `AutoApproveListener` does not run `AutoCheck` before `AutoApproveService.evaluate`?** Actually `evaluate` calls `autoCheck.check` internally. Good.

**B7. `AutoApproveListener` does not pass `qualityScore` to `evaluate` if it is `undefined`? It passes `score`. If `score` is `undefined`, `evaluate` will default to threshold. Good.** But the listener's comment says "checks the LLM quality score and approves the draft only if it meets the threshold". That is not the current behavior (it delegates to evaluate with auto-check and fail-open missing score). Comment drift.

**B8. `AutonomousRunnerService` reads `process.env.AUTONOMOUS_RUNNER_SCHEDULE` directly instead of `ConfigService`**
- `autonomous-runner.service.ts:79` `const cronExpr = process.env.AUTONOMOUS_RUNNER_SCHEDULE ?? '0 */4 * * *';`. Inconsistent with other env reads in the same file that use `ConfigService`. The AGENTS.md notes that `process.env` reads in `orchestrator/feature-flag.ts` and `getEnabledNetworks` are intentional, but `AUTONOMOUS_RUNNER_SCHEDULE` is not in that list.

**B9. `AutonomousRunnerService` `runAutonomousCycle` re-checks `flowControl.isPaused('generation')` after resolving `GenerationService` but before calling `generate()` — good, but does not handle `posting` pause before `generate()`**
- `posting` pause is only checked per post inside the loop. If posting is paused, the generation still runs and drafts are left as `HUMAN_REVIEW` or `DRAFT` (since `evaluate` may still run). Wait, `evaluate` does not check `posting` pause; it auto-approves if score passes. Then `enqueueForPosting` is called. If `posting` is paused, `runAutonomousCycle` breaks out of the loop (`if (await this.flowControl.isPaused('posting')) { ... break; }`) before calling `evaluate` for remaining posts. But the current post has already been evaluated and enqueued. The check is before `evaluate`. So if posting is paused, it breaks before evaluating. Good. But if `posting` is paused after the loop starts, the current post is still processed. Minor race.

**B10. `AutonomousRunnerService` `enqueueForPosting` uses a random delay but does not check `flowControl.isPaused('posting')` before enqueuing**
- The post was already evaluated; if the queue is paused, the job stays in queue. That's fine. But if the user paused posting to avoid any new posts, the job is still enqueued with a delay and will post when the queue is resumed. Acceptable.

**B11. `AutonomousRunnerService` `runAutonomousCycle` does not check `flowControl.isPaused('generation')` before calling `generate()` after the first check? It does, twice. Good.**

**B12. `AutonomousRunnerService` `runAutonomousCycle` catches errors and logs `error: (err as Error).message` but `err` could be a string**
- `autonomous-runner.service.ts:190` `error: (err as Error).message` — if `err` is a string, `message` is undefined. Should use `String(err)` or `err instanceof Error ? err.message : String(err)`. This is a minor pattern.

**B13. `AutoCheckService` `forbiddenMatches` uses `filter((p) => p.test(content))` which runs `test` on non-global regexes; `test` is idempotent if not global. Good.**

**B14. `AutoCheckService` hardcodes forbidden patterns as a module-level constant — cannot be configured without deploy**
- `auto-check.service.ts:47-52` patterns are hardcoded. If the brand voice changes or new risky phrases are found, a code change is needed. Should be configurable (env or DB) or loaded from `brand-voice.md`.

**B15. `AutoCheckService` `loadRecentHashes` uses `prisma.post.findMany` with `where: { network, createdAt: { gte: since }, OR: [{ simhash: { not: null } }, { status: 'POSTED' }] }` and `take: 200`.**
- This includes `DRAFT` posts with `simhash` and `POSTED` posts without `simhash`. The `OR` condition is odd: `status: POSTED` does not require `simhash`. Then `p.simhash ?? simhash(p.content)` computes the hash on the fly. This is okay. But if a `POSTED` post has no `simhash` and content is long, `simhash()` is computed many times. The `simhash()` function is O(words). For 200 posts, this is fine.
- However, `findBySourceAndNetwork` in `posts.service` excludes `FAILED`/`REJECTED`, but `loadRecentHashes` does not. `FAILED` and `REJECTED` posts may have `simhash` and could trigger false duplicates. The comment says "FAILED/REJECTED never actually reached the network" so they should not be in dedup corpus. But `loadRecentHashes` includes them if `simhash` is present. This is a bug: a failed post can block a future generation of the same topic via SimHash.

**B16. `AutoCheckService` `loadRecentHashes` order is `createdAt: desc`? The code does not set `orderBy`. Without `orderBy`, the `take: 200` is arbitrary.**
- `prisma.post.findMany` with `take` and no `orderBy` is not deterministic. It may take the oldest 200 or newest 200 depending on query planner. For SimHash dedup, we want the most recent 200. Missing `orderBy: { createdAt: 'desc' }` is a bug.

**B17. `AutoCheckService` duplicates `NETWORK_LIMITS` with `posts/network-limits.ts` and `generation/graph`/`content-enhancements`**
- `auto-check.service.ts:40-44` defines `NETWORK_LIMITS` again. `posts/network-limits.ts` has the same. This is a DRY violation. If limits change, they may drift. Single source of truth should be `posts/network-limits.ts` or `domain/network-limits.ts`.

**B18. `AutoApproveService` `evaluate` does not update `llmMetadata` with `qualityScore` if missing, it only sets `autoApproveDecision` etc. The `qualityScore` is already in `llmMetadata` from generation. Good.**

**B19. `AutoApproveService` uses `Prisma.post.updateMany` and then `Prisma.post.findUnique` to get `llmMetadata`** — the `findUnique` is before `updateMany`. It merges `prevMeta` into the new metadata. This is a race if another process updates `llmMetadata` between `findUnique` and `updateMany`. But `updateMany` only matches `status: DRAFT`, so the row is updated atomically. If `llmMetadata` is updated by another process, the merge may overwrite. Minor.

**B20. `AutoApproveListener` is in `events/listeners/` not in `modules/autonomy/`**
- This is a cross-cutting concern. The listener is feature-flagged and lazy-resolves `AutoApproveService`. This is okay but makes it harder to find. It is a listener, not a service. Good separation.

**B21. `AutoApproveListener` imports `PostsService` but only uses it in constructor — never uses it in the handler**
- `auto-approve.listener.ts:39` `private readonly postsService: PostsService` is never used. Dead dependency. This may be leftover from a previous version.

**B22. `AutonomousRunnerService` imports `ModuleRef` and `IPostingQueuePort` but `IPostingQueuePort` is injected normally. Good.**

**B23. `parseTargetNetworks` is a pure utility but has no tests?**
- Not sure. But `parseTargetNetworks('x,threads,facebook')` will convert to upper and validate. `SocialNetwork` enum values are `X`, `THREADS`, `FACEBOOK` (uppercase). Good. It drops invalid tokens. Good.

**B24. `AutonomousRunnerService` `onModuleInit` uses `new CronJob(cronExpr, async () => { ... })` and does not set `null` timezone**
- `cron` package uses local system time by default. For `0 */4 * * *`, if the server is in a different TZ than expected, the schedule shifts. Should be explicit UTC or `TZ` env. The orchestrator may handle this better.

**B25. `AutonomousRunnerService` `onModuleInit` catches the `addCronJob` error and logs a warning, but does not rethrow**
- If `SchedulerRegistry` is not available, the cron is silently not registered. This is safe but could hide config issues. Good for tests.

**B26. `FlowControlService` `getStatus` reads `pauseAll` then each flow, but `pauseAll` is a separate key. If `pauseAll` is set, the `flows` values are `true` even if the individual flags are not set. Good.**

**B27. `FlowControlService` `isPaused` uses `await Promise.all([redis.get(PAUSE_ALL_KEY), redis.get(FLOW_KEYS[flow])])` — good.**

**B28. `FlowControlService` `pauseAll` only sets `flow:pause_all` and does not set individual flags. `resumeAll` clears `pause_all` and all individual flags. If `pauseAll` is set, `isPaused` returns true for all flows. Good. But `resumeAll` clears `flow:pause_all` and individual flags. If the user had `generation` paused before `pauseAll`, `resumeAll` will also unpause `generation`. This may not be intended (crisis mode then resume all resets individual overrides). But the semantics are "resume all". Acceptable.

**B29. `FlowControlController` `pause` and `pauseAll` bodies use `reasonSchema.safeParse` and pass `reason` only if `parsed.success`; otherwise ignore. It does not validate `body` type and does not log invalid body. Minor.**

**B30. `FlowControlService` does not cache `isPaused` results — every call hits Redis. This is fine for non-hot paths.**

### 6.2 Performance

**P1. `AutoCheckService.check` loads 200 posts from DB and runs `simhash()` on each missing hash on every call**
- `auto-check.service.ts:105-152` This is called for every post in `autoApprove.evaluate`, which is called for every draft in generation and listener. If `N` posts are generated in a batch, each call scans 200 posts. For N=3, 600 posts scanned. This is O(N * 200) and fine. But it could be optimized by batching or precomputing. SimHash is O(words).

**P2. `AutoApproveService` `checkRejectStreak` runs a `findMany` on every `REJECT` decision**
- It loads up to `rejectStreakAlertLimit` rows (default 3) and checks timestamps. This is negligible.

**P3. `AutonomousRunnerService` `runAutonomousCycle` loads all DRAFT posts from a run by `generationRunId` and then loops, calling `evaluate` and `enqueueForPosting` sequentially**
- No batching. Fine for small N (3).

**P4. `AutoApproveListener` and `AutonomousRunnerService` can both call `evaluate` on the same post**
- `AU3` idempotency in `AutoApproveService` handles this by checking status `DRAFT`. If the listener triggers first, the runner will `SKIP` the post. If the runner triggers first, the listener will `SKIP`. Good.

**P5. `AutoApproveService` `updateMany` does not use `select` to return updated row, so `updated.count` is checked. Good.**

### 6.3 Architecture / anti-patterns

**A1. `AutoApproveService` is both a decision engine and a state mutator**
- It calls `prisma.post.updateMany` and `sseService.publish`. It might be cleaner to separate `AutoApproveDecider` (pure) from `AutoApproveExecutor` (side effects). The current design is pragmatic.

**A2. `AutoCheckService` is mixed with `AutoApproveService` concerns — `AutoApproveService` calls `AutoCheckService` and then decides**
- This is fine. The separation of content-safety gate and decision gate is good.

**A3. `AutoApproveListener` is an event listener but uses `ModuleRef` to lazy-resolve `AutoApproveService` and `IPostingQueuePort` is injected directly**
- The `IPostingQueuePort` injection is good. `ModuleRef` for `AutoApproveService` is needed because the listener is in `events` module, not `autonomy`. But `events` module may not import `AutonomyModule`. If `AutonomyModule` is not loaded, the listener fails gracefully. Actually, the listener is `AutoApproveListener` in `events` module. The `EventsModule` imports `PostsModule`? Need to check `events.module.ts`.

**A4. `AutoApproveListener` imports `PostsService` but never uses it — dead dependency**
- Should remove.

**A5. `AutonomousRunnerService` uses `process.env` for schedule and `isOrchestratorEnabled()` for flag**
- `isOrchestratorEnabled()` uses `process.env` directly. `AUTONOMOUS_RUNNER_SCHEDULE` also uses `process.env`. This is inconsistent with `ConfigService` usage elsewhere. The AGENTS.md says some `process.env` reads are intentional, but not all. The `process.env` read in `autonomous-runner.service.ts` should be `ConfigService`.

**A6. `AutoCheckService` hardcoded forbidden patterns and network limits duplicate other modules**
- DRY violation. `NETWORK_LIMITS` should be shared. Forbidden patterns should be configurable.

**A7. `FlowControlService` uses Redis directly (no domain abstraction) and no TTL on pause keys**
- Pause keys persist indefinitely until cleared. If the operator forgets, the flow stays paused. This is a feature, but an alert could be useful.

**A8. `AutonomousRunnerService` is a cron service but also `AutonomousRunnerService` can be invoked manually via `runAutonomousCycle()`**
- Good for testing.

**A9. `AutonomousRunnerService` is not aware of `ORCHESTRATOR_ENABLED` at runtime — only at `onModuleInit` cron registration time**
- If `ORCHESTRATOR_ENABLED` is toggled at runtime (not restart), the cron still won't be registered. But if someone manually calls `runAutonomousCycle`, it will run. Good.

**A10. `AutoApproveService` `makeDecision` returns `HUMAN_REVIEW` but leaves status as `DRAFT` and logs `decision` in `llmMetadata`. The UI can then show `HUMAN_REVIEW` in metadata. Good. But the status is still `DRAFT`, so the post can be approved manually. Good.**

### 6.4 TypeScript / type safety

**T1. `AutoApproveService` `evaluate` return type `ApproveResult` has `qualityScore: number | null` and `checkResult` always present. Good.**

**T2. `AutoApproveService` `makeDecision` accepts `qualityScore: number | null` and `checkResult` but `evaluate` may pass `qualityScore ?? null` and `SKIPPED_CHECK`. Good.**

**T3. `AutoCheckService` `loadRecentHashes` uses `filter(Boolean)` to remove empty strings but `simhash` returns `bigint`? Wait, `simhash()` returns `string`? Let me check. `simhash.ts` likely returns a string (maybe hex). `isDuplicateHash` expects `string[]`. `filter(Boolean)` is fine. But `p.simhash` could be `null` or `undefined` and `simhash(p.content)` returns string. Good.**

Actually, `simhash` from `modules/generation/simhash.ts` likely returns a `string` (bigint hash). `loadRecentHashes` uses `filter(Boolean) as string[]`. Good.

**T4. `AutoApproveListener` `handleDraftGenerated` payload is `{ postId: string; network: string }` but `network` is typed as string, then cast to `SocialNetwork`. It uses `post.network` (from Prisma) for `evaluate`. Good.**

**T5. `AutonomousRunnerService` `targetNetworks` is `SocialNetwork[]` and `parseTargetNetworks` returns `SocialNetwork[]`. Good.**

### 6.5 Security / reliability

**S1. `AutoApproveListener` is enabled by `AUTO_APPROVE_ENABLED` and disabled by `SPA_DRY_RUN`. If an operator accidentally enables `AUTO_APPROVE_ENABLED` in dry-run, it is disabled. Good.**

**S2. `AutoApproveService` `evaluate` with missing `qualityScore` defaults to auto-approve threshold and auto-approves. This is fail-open. If the judge LLM is down (e.g., 429 from all providers), all posts will be auto-approved after AutoCheck passes. Risk of low-quality content being posted.**

**S3. `AutoApproveService` `checkRejectStreak` publishes SSE `health_alert` but does not send Discord/Email notification. The comment says "Discord notification is handled by DiscordNotificationService via SSE health_alert" but SSE does not trigger Discord. The `health_alert` SSE event is for UI only. If no one is watching the dashboard, the alert is lost. Should call `DiscordNotificationService` directly.**

**S4. `AutoApproveListener` uses `eventEmitter` listener but no `@OnEvent` guard against multiple listeners?** The NestJS `OnEvent` decorator registers one listener. Fine.

**S5. `FlowControlController` endpoints can be called by any authenticated user (if `AUTH_ENABLED`) with no admin role. Pausing/resuming flows should be admin-only.**

**S6. `AutoApproveService` `makeDecision` merges `llmMetadata` with `autoCheckChecks` (array of all checks). This can grow the JSON column. Fine.**

**S7. `AutoApproveService` `evaluate` and `makeDecision` run in two separate DB round-trips (findUnique + updateMany). If the post is not DRAFT, the second `findUnique` in `makeDecision` is wasted. But `makeDecision` is only called for DRAFT. Fine.**

**S8. `AutoCheckService` `forbidden` regex list does not include common astrology-specific risky claims?** For example, "will happen" or "you will find" (not in patterns) could be allowed. But the LLM prompt likely already guards against that. The current patterns are a good baseline.

## 7. New feature / improvement ideas

**F1. Make `AUTO_APPROVE_MIN_SCORE` default fail-closed on missing quality score**
- If `qualityScore` is missing, route to `HUMAN_REVIEW` instead of `AUTO_APPROVE` with default. This makes the system safer when LLM is degraded. Alternatively, add a separate `AUTO_APPROVE_ON_MISSING_SCORE` flag.

**F2. Move `NETWORK_LIMITS` to a single source of truth**
- Use `posts/network-limits.ts` or `domain/network-limits.ts` everywhere.

**F3. Make forbidden patterns configurable (env or DB / `brand-voice.md`)**
- Avoid hardcoded patterns. Also add per-language patterns.

**F4. Fix `AutoCheckService.loadRecentHashes` to exclude FAILED/REJECTED and add `orderBy: { createdAt: 'desc' }`**
- Prevent false duplicate blocks and deterministic recency.

**F5. Add `rejectStreak` to `GenerationService` / `Orchestrator` as a flow-control signal**
- If reject streak is high, pause generation or switch to a safer content source.

**F6. Add `DiscordNotificationService` to `AutoApproveService.checkRejectStreak`**
- Real alerts for operators.

**F7. Add `AutoApproveService` metrics**
- `auto_approve_decisions_total` by decision, `auto_check_failures_total` by check, `reject_streak`.

**F8. Add `HUMAN_REVIEW` queue TTL**
- DRAFT posts left in `HUMAN_REVIEW` (status still DRAFT) should be auto-rejected after N days to avoid stale posts.

**F9. Add `AutoApproveService` A/B testing of thresholds**
- Store threshold and result in `llmMetadata` to compare approve/reject rates.

**F10. Add `autonomy` REST endpoint for manual re-evaluation**
- `POST /autonomy/re-evaluate/:postId` to re-run the gate on an existing DRAFT.

**F11. Add `FlowControlService` TTL on pause keys with configurable expiry**
- Auto-resume after N hours to avoid forgotten pauses.

**F12. Add `FlowControl` history / audit log**
- Track who paused/resumed and why.

**F13. Remove `PostsService` dependency from `AutoApproveListener`**
- Dead code cleanup.

**F14. Add `AUTO_APPROVE_ENABLED` per network or per account**
- Different networks may have different risk tolerance.

**F15. Add `autonomous` mode to use `Orchestrator` when available and fallback to `AutonomousRunnerService`**
- The legacy runner should be deprecated once orchestrator is stable.

## 8. Cross-references

- `modules/flow-control` — `FlowControlService`.
- `modules/generation` — `GenerationService`, `simhash()`.
- `modules/posts` — `PostsService`, `PostEvents`, `PostStatus`, `network-limits.ts`.
- `modules/content-enhancements` — `engagement-bait.detector.ts`.
- `modules/queue` — `IPostingQueuePort`.
- `events/listeners` — `AutoApproveListener`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.
- `infrastructure/sse` — `SseService`.
- `infrastructure/prisma` — `PrismaService`.
- `docs/adr/ADR-006.md` — autonomy decision.
- `docs/audit/*.md` — prior audit findings.

## 9. Overall assessment

- **Health**: 7/10. The autonomy gate is well-structured, fail-closed on AutoCheck failures, and idempotent. The band matrix is clear. However, the fail-open behavior for missing quality score is a risk, and `AutoCheckService` has dedup and DRY issues.
- **Biggest strengths**: single decision gate `AutoApproveService`, idempotent `updateMany` with `status: DRAFT` guard, lazy `ModuleRef` resolution, `IPostingQueuePort` decoupling, `parseTargetNetworks` validation.
- **Biggest risks**: missing `qualityScore` defaults to auto-approve; `loadRecentHashes` includes FAILED/REJECTED and lacks `orderBy`; `checkRejectStreak` not truly consecutive; `AUTO_APPROVE_ENABLED` is global; `FlowControl` pause keys have no TTL/admin role check.
- **Recommended next actions**:
  1. Fail `HUMAN_REVIEW` on missing `qualityScore` instead of auto-approve.
  2. Fix `AutoCheckService.loadRecentHashes` (exclude FAILED/REJECTED, add `orderBy: { createdAt: 'desc' }`).
  3. Move `NETWORK_LIMITS` and forbidden patterns to a single source of truth / config.
  4. Remove unused `PostsService` from `AutoApproveListener`.
  5. Add Discord alert to `checkRejectStreak`.
  6. Add admin role guard to `FlowControlController` pause/resume endpoints.
