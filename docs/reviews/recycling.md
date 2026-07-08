# Module: `modules/recycling`

## 1. What this module does

`modules/recycling` identifies old `POSTED` posts (≥30 days) and creates new rewritten drafts via `GenerationService`. It is intended as Sprint O / F13 "evergreen revival": turn top-performing old content into fresh drafts without verbatim duplicates, protected by SimHash deduplication.

**Main responsibilities:**
- `RecyclingService` — find candidates, run batch recycling, schedule optional cron.
- `RecyclingController` — REST endpoints for candidates, run, and single-post recycle.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `recycling.module.ts` | NestJS module | `RecyclingModule` — imports `GenerationModule` |
| `recycling.controller.ts` | REST API | `GET /recycling/candidates`, `POST /recycling/run`, `POST /recycling/:postId/recycle` |
| `recycling.service.ts` | Core service | `findRecyclablePosts(limit)`, `runRecycling(limit)`, `recyclePost(postId)`, `onModuleInit()` |

## 3. How it works

### 3.1 `findRecyclablePosts`

- Queries `post` with `status: POSTED`, `postedAt < 30 days ago`, `llmMetadata.recycled != true`.
- `orderBy: { postedAt: 'desc' }`, `take: limit * 2`.
- Computes SimHash of each candidate content and filters out any with Hamming distance ≤ 5 vs recent 7-day posts.
- Returns up to `limit` candidates.

### 3.2 `recyclePost`

- Delegates to `GenerationService.recycleById(postId)`.
- `GenerationService.recycleById` marks original `llmMetadata.recycled = true`, creates a synthetic `ContentTopic` with path `recycle://${postId}` and topic `topic (evergreen revival)`, language `en`, facts/keywords empty.
- Calls `generatePostsForTopic` to produce rewritten drafts per network.
- Updates new posts' `sourceRef` with `type: 'recycle'`, `originalPostId`, `originalTopic`, `recycledAt`.
- Returns `{ id: posts[0].id, status: PostStatus.DRAFT }` or `null`.

### 3.3 `runRecycling`

- Gets candidates, loops, calls `recyclePost`, counts `recycled`/`skipped`.
- Logs errors per candidate and continues.

### 3.4 `onModuleInit`

- Skips cron if `isOrchestratorEnabled()`.
- Checks `process.env.RECYCLING_CRON_ENABLED` (default `false`).
- If enabled, schedules `RECYCLING_CRON_SCHEDULE` (default `0 8 * * 1` — weekly Monday 8am).

## 4. Dependencies

- `modules/generation` — `GenerationService.recycleById`.
- `infrastructure/prisma` — `PrismaService`.
- `modules/generation/simhash` — `simhash` and `hammingDistance`.
- `modules/orchestrator` — `isOrchestratorEnabled()`.
- `infrastructure/guards` — `LocalhostGuard` on write endpoints.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `RECYCLING_CRON_ENABLED` | `false` | `onModuleInit` | Enable auto-recycling cron |
| `RECYCLING_CRON_SCHEDULE` | `0 8 * * 1` | `onModuleInit` | Cron schedule |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `RecyclingService.onModuleInit` uses `process.env` for `RECYCLING_CRON_ENABLED` and `RECYCLING_CRON_SCHEDULE`**
- Unlike the `orchestrator`/`enabled-networks`/`feature-flag` `process.env` reads (which are intentional by design per `AGENTS.md`), there is no documented reason for a cron service to bypass `ConfigService`. Should be `ConfigService` for validation and consistency.

**B2. `findRecyclablePosts` filters by `llmMetadata.recycled != true` using Prisma JSON path**
- `llmMetadata` is a `Json` column. The `path: ['recycled'], not: true` filter is Prisma's `not` operator on `json` path. It likely matches `null`, `undefined`, `false`, and non-recycled posts. If `llmMetadata` is `null` or `DbNull`, the `path` filter may be excluded? It uses `llmMetadata: { not: Prisma.DbNull }`? No, it doesn't. It just `llmMetadata: { path: ['recycled'], not: true }`. This might not work correctly if `llmMetadata` is `DbNull`. It may be a bug. Should explicitly check `llmMetadata` not null or use `not: Prisma.DbNull`.

**B3. `findRecyclablePosts` candidate selection is by age only, not performance**
- The JSDoc says "top-performing posts" but the query does not use `metrics` (likes/comments/shares). It picks the most recent posts older than 30 days. If metrics are not used, "recycling" may recycle mediocre posts. The `recycleTopPosts` in `GenerationService` also uses `orderBy: { createdAt: 'desc' }` and filters by `sourceRef` topic, not metrics. This is a known limitation acknowledged in JSDoc (AN1). But the function names and docs suggest performance-based. Should be flagged.

**B4. `findRecyclablePosts` `take: limit * 2` then filters by SimHash, then `slice(0, limit)`**
- If the first `limit*2` posts are all too similar to recent posts, the returned list may be empty even though older candidates exist. It should continue querying until it finds enough or exhausts. This is a minor issue.

**B5. `findRecyclablePosts` `loadRecentHashes` uses `createdAt: { gte: sevenDaysAgo }` and `take: 100` without `orderBy`**
- It picks 100 arbitrary recent posts. If there are more, it may miss the most recent ones. `orderBy: { createdAt: 'desc' }` should be added.

**B6. `loadRecentHashes` uses `simhash(p.content)` if `p.simhash` is null**
- `simhash` computes hash on the fly. If `p.simhash` is null (e.g., old posts didn't have it), it works. But if content is long, it computes per post. Not critical. However, `simhash` on a 30-day-old post might be similar to `p.content` on a recent post even if rewritten. That's fine.

**B7. `RecyclingService.recyclePost` returns `posts[0]` status `DRAFT` regardless of how many networks were generated**
- `GenerationService.recycleById` calls `generatePostsForTopic` for `targetNetworks` (default all enabled). It returns an array of generated posts (one per network). `recyclePost` returns only the first post's id. The caller loses the other generated posts. The `runRecycling` counts `recycled++` for one candidate even if multiple posts were generated. This is a counting bug. It should return the number of generated posts or all ids.

**B8. `GenerationService.recycleById` and `recycleTopPosts` set `language: 'en'` hardcoded**
- Recycled posts are always generated in English. The original post may have been in another language. This is a bug. It should use the original post's language from `sourceRef` or `llmMetadata`.

**B9. `GenerationService.recycleById` sets `keywords: []` and `facts: []` on the recycled topic**
- The generation graph will have no source facts or keywords. The prompt may fall back to the topic string only. It should extract keywords/facts from the original post or source.

**B10. `GenerationService.recycleById` marks original `llmMetadata.recycled = true` before `generatePostsForTopic` succeeds**
- If generation fails, the original is marked as recycled even though no new draft was created. This is not idempotent in the wrong direction. It should mark after success, or at least allow retry if generation fails. The comment says "idempotent" but it means re-running won't recycle twice. However, if generation fails, the original is marked recycled and won't be tried again. This is a bug.

**B11. `RecyclingService.runRecycling` `skipped` count increments on errors and null results. It does not distinguish.**
- Fine.

**B12. `RecyclingController` `POST /recycling/run` uses `LocalhostGuard` and `runRecycling` returns a promise. It returns the promise. Good. But the `runRecycling` can take a while (multiple LLM calls). The endpoint may timeout. This is a general issue with synchronous endpoints. Not a bug but a risk. **B13. `RecyclingController` `POST /recycling/:postId/recycle` uses `LocalhostGuard`. Good. It returns `recyclePost`. Good. **B14. `RecyclingController` `GET /recycling/candidates` is not guarded. It can be called externally. It returns content of old posts. Not a security risk if public. But if `AUTH_ENABLED=true`, `LocalhostGuard` only; no `JwtAuthGuard`. The global `JwtAuthGuard` should apply. But `LocalhostGuard` is not a Nest guard? It's `@UseGuards(LocalhostGuard)`. The global `JwtAuthGuard` is `APP_GUARD`. `@UseGuards` adds to the global guard list. So it should be protected when auth enabled. But the `LocalhostGuard` may bypass auth if IP is localhost. Not a bug. **B15. `RecyclingController` `getCandidates` `limit` query: `Math.min(parseInt(limit, 10) || 10, 50)`. If `limit` is `'abc'`, `parseInt` returns `NaN`, `|| 10` => 10. Good. If `limit` is `100`, `Math.min(100,50)` => 50. Good. `POST /recycling/run` `limit` default 5, max 20. Good. **B16. `RecyclingService` `onModuleInit` does not check `RECYCLING_ENABLED` env (none exists). It only checks `RECYCLING_CRON_ENABLED`. The module is always loaded. The `runRecycling` endpoint can be called even if `RECYCLING_CRON_ENABLED=false`. That's intentional. Good. **B17. `RecyclingService` imports `GenerationModule` which is a large dependency. The module-level circular dependency? `RecyclingModule` imports `GenerationModule` and `GenerationService` imports `PostStatus` etc. No circular. Good. **B18. `RecyclingService` `findRecyclablePosts` `select` includes `accountId` and `sourceRef` but not `sourceRef` usage. It uses content only for simhash. `sourceRef` is not used. Fine. **B19. `RecyclingService` `findRecyclablePosts` `content` is the posted content. If the post was in a thread, `content` is the root tweet? The `post` model stores `content` per network. It is the generated content. Good. **B20. `RecyclingService` `runRecycling` loops sequentially. It calls `recyclePost` which generates for all networks. This may take a long time. The cron runs weekly. Fine. But if `runRecycling` endpoint is called, it may take minutes. The `GenerationService` has `runQueue` concurrency? It might not. The batch could overload LLM. It is sequential. Good. **B21. `RecyclingService` `findRecyclablePosts` `recycled` flag in `llmMetadata` is `not: true`. If `llmMetadata` is `null` or `Prisma.DbNull`, Prisma's `path` filter might fail. Need to verify. The `llmMetadata` is optional `Json?` in schema? It might be non-null. If non-null, `path` works. If null, the `llmMetadata: { path: ... }` would be null and not match. This is a bug if nulls are allowed. It should use `llmMetadata: { not: Prisma.DbNull, path: ['recycled'], not: true }` or `llmMetadata: { equals: null }` with OR. But this is Prisma-specific. Let's check schema. `llmMetadata` likely is `Json` non-null default. The `recycling` service uses `path: ['recycled'], not: true`. This is `llmMetadata` `Json` filter. It checks if `recycled` is not true. It may work for `null`/`undefined` as `not true`. But if `llmMetadata` is `null` it may be false? Need to test. **B22. `RecyclingService` `loadRecentHashes` does not filter by `status` or `POSTED`/`APPROVED`. It includes `DRAFT` and `REJECTED` posts from the last 7 days. Drafts may have content that is later changed, and rejected posts may be poor. It should filter `status: { in: [POSTED, APPROVED] }` or similar. **B23. `RecyclingService` `loadRecentHashes` `take: 100` without `orderBy` may pick arbitrary recent posts. It should `orderBy: { createdAt: 'desc' }`. **B24. `RecyclingService` `findRecyclablePosts` Hamming threshold is `<= 5` while `GenerationService` SimHash dedup uses `<= 3`. Inconsistent threshold. The `recycling` service may recycle posts that are more similar than the generation pipeline's dedup threshold, leading to near-duplicates. **B25. Critical.** The `GenerationService` dedup uses `<= 3` to reject. The `recycling` service uses `<= 5` to consider recyclable. It should align with the generation pipeline (≤ 3). Otherwise it can produce a recycled draft that is not too similar to the recent posts by the recycling threshold (≤5) but is rejected by the generation pipeline (≤3). This is a bug. **B26. `RecyclingService` `findRecyclablePosts` filters by `postedAt < thirtyDaysAgo` but the `GenerationService.recycleTopPosts` and `recycleById` do not re-check age. The manual endpoint can recycle any post. The `recyclePost` endpoint can recycle a post that is not 30 days old. The controller doesn't validate. The `GenerationService.recycleById` only checks `status === POSTED`. This is a bug: the single-post recycle endpoint can recycle a post from yesterday. **B27. `RecyclingService` `recyclePost` calls `GenerationService.recycleById` which is not guarded by `flowControl.isPaused` or `FlowControlService`. If `PAUSE_GENERATION` is set, recycling still runs. It should respect flow control. **B28. `RecyclingService` `recyclePost` uses `GenerationService.recycleById` which creates a `generationRun` with `triggeredBy: MANUAL`. The `runRecycling` cron creates `MANUAL` too? Wait `runRecycling` calls `recyclePost` which calls `recycleById`. `recycleById` creates `GenerationTrigger.MANUAL`. The cron should perhaps use `GenerationTrigger.CRON` or `RECYCLE`. Not a bug. **B29. `RecyclingService` `runRecycling` returns `{ recycled, skipped }` but does not return which posts were recycled or error details. Fine. **B30. `RecyclingService` `findRecyclablePosts` does not exclude posts that are currently in `APPROVED` or pending queue. It only excludes `recycled`. So the same post could be recycled multiple times if `recycled` flag is not set. `recycled` flag is set only when `recycleById` is called. If `findRecyclablePosts` returns candidates and `runRecycling` is called, `recycleById` marks them. If `runRecycling` fails mid-way, some are marked, some not. The next run will not re-candidate the marked ones. Good. But if `findRecyclablePosts` is called and `recyclePost` for a single post is called, it marks it. Good. **B31. `GenerationService.recycleById` `recycledTopic` has `publishedAt: new Date()` and `sourceType: 'topic'`. It uses `path: 'recycle://${id}'`. The `TrendGuardrail.isTrendingSource` checks `path` for `trending/`. It won't match. Good. The `sourceType` is `'topic'`, not `'recycle'`. Fine. **B32. `GenerationService.recycleById` `sourceRef` for new posts is `type: 'recycle'` but the `ContentTopic.sourceType` is `'topic'`. This inconsistency may cause confusion. The `sourceRef` JSON is for the `Post` record, while `ContentTopic.sourceType` is for the generation pipeline. Fine. **B33. `GenerationService.recycleById` does not set `llmMetadata.recycled` on the new posts; it sets `sourceRef` with `recycledAt`. The `RecyclingService.findRecyclablePosts` checks `llmMetadata.recycled` on the original. Good. The new posts don't have `llmMetadata.recycled` so they won't be re-recycled. Good. **B34. `GenerationService.recycleById` sets `llmMetadata.recycled` on original immediately. If the original was already recycled and the `recyclePost` endpoint is called again, `recycleById` will still mark and generate. It doesn't check `llmMetadata.recycled`. The `recycling.service.findRecyclablePosts` excludes it, but the manual endpoint doesn't. So manual recycling can create multiple copies. The `recycling.service.recyclePost` is guarded by `LocalhostGuard`, but a user can call it repeatedly. This is a bug. The `recycleById` should check if original already recycled and return null or new draft. **B35. `RecyclingService` `onModuleInit` does not check `RECYCLING_ENABLED` module flag. It is always loaded. The `RecyclingModule` is imported in `app.module.ts`? Need to check. If `RecyclingModule` is imported conditionally, the module is loaded. If not, it is always loaded. The `AGENTS.md` says `RecyclingService` is one of the 11 cron services. It is likely always loaded. Good. **B36. `RecyclingService` `onModuleInit` uses `parseBool` from `infrastructure/config/parse-bool.js`. Good. **B37. `RecyclingService` `onModuleInit` `cronExpr` from `process.env`. Should be `ConfigService`. **B38. `RecyclingService` imports `GenerationService` from `../generation/generation.service.js` with `.js` extension? The file is `recycling.service.ts` and imports `generation.service.js`? The import is `from '../generation/generation.service.js';`. The AGENTS.md says orchestrator uses `.js` extensions; other modules may omit. This is inconsistent but works. Not a bug. **B39. `RecyclingService` `recycling.controller.ts` imports `RecyclingService` without `.js` extension. Fine. **B40. `RecyclingService` `recycling.module.ts` imports `RecyclingService` and `RecyclingController` without `.js` extension. Fine. **

### 6.2 Performance

**P1. `findRecyclablePosts` `take: limit * 2` with SimHash computation in memory.**
- Good.

**P2. `loadRecentHashes` `take: 100` without `orderBy` or status filter.**
- Could return arbitrary hashes and include drafts.

**P3. `runRecycling` loops sequentially and each `recyclePost` calls `generatePostsForTopic` for all enabled networks.**
- For `limit = 5` and 3 networks, 15 generation runs. This is 15 LLM calls. Could be slow. The endpoint is localhost-guarded and cron is weekly. Fine.

**P4. `findRecyclablePosts` and `loadRecentHashes` both query `post` with content. Good.**

### 6.3 Architecture / anti-patterns

**A1. `RecyclingService` is small and focused. Good.**

**A2. `RecyclingService` delegates generation to `GenerationService`. Good.**

**A3. `RecyclingController` write endpoints are `LocalhostGuard` protected. Good.**

**A4. `RecyclingService` uses `process.env` instead of `ConfigService` for cron. Should be consistent.**

**A5. `RecyclingService` `runRecycling` returns aggregate counts, not per-post ids. Could be extended.**

### 6.4 TypeScript / type safety

**T1. `RecyclingService` `recyclePost` return type `Promise<{ id: string; status: string } | null>`. `status` is `PostStatus.DRAFT` string. Good.**

**T2. `RecyclingController` `recyclePost` param `postId: string`. Good.**

**T3. `RecyclingController` `getCandidates` `limit?: string`. It parses with `parseInt`. Good.**

**T4. `RecyclingService` `findRecyclablePosts` return type includes `postedAt: Date | null`. In Prisma, `postedAt` is `DateTime?` so it can be null. Good.**

**T5. `GenerationService.recycleById` returns `Promise<{ id: string; status: string } | null>`. It doesn't expose the full posts. Fine.**

### 6.5 Security / reliability

**S1. `RecyclingController` write endpoints are `LocalhostGuard`. Good.**

**S2. `RecyclingController` `getCandidates` is not guarded. Could leak old content. But if `AUTH_ENABLED`, global `JwtAuthGuard` applies. Good.**

**S3. `RecyclingService` `runRecycling` can be called via cron and endpoint. If `runRecycling` is running, concurrent calls may cause duplicates. No locking. The `recycleById` marks original `recycled` but concurrent calls could both see `recycled != true` before one marks. The `RecyclingService.runRecycling` queries candidates and then recycles. If the cron and manual endpoint run concurrently, they may get overlapping candidates. Since `recycleById` marks original, the second one may still be able to mark and generate if the `findRecyclablePosts` query was done before the first mark. This is a race. Not a major issue. **S4. `RecyclingService` `runRecycling` does not abort if `flowControl.pauseGeneration` is set. It should check.**

**S5. `RecyclingService` `runRecycling` catches errors and logs, but the `recyclePost` may fail due to LLM errors. It counts as skipped. Good.**

**S6. `RecyclingService` `recyclePost` for a single post can be called on a non-eligible post. No validation in controller. `GenerationService.recycleById` only checks `POSTED`. It doesn't check age. This is a bug. **S7. `RecyclingService` `recyclePost` can be called repeatedly on the same post, generating multiple drafts. `GenerationService.recycleById` doesn't check `llmMetadata.recycled`. This is a bug. **S8. `RecyclingService` `runRecycling` `recycled` count may be wrong because `recyclePost` returns one post id even if `generatePostsForTopic` produced multiple. It counts candidates, not generated posts. The log says `recycled: X recycled, Y skipped` where `recycled` is number of candidates. If one candidate generates 3 posts, it says 1. This is misleading. **S9. `RecyclingService` `findRecyclablePosts` `llmMetadata` JSON filter may not handle null. **S10. `RecyclingService` `loadRecentHashes` should filter by status and order. **S11. `RecyclingService` SimHash threshold mismatch with generation. **

## 7. New feature / improvement ideas

**F1. Use `ConfigService` for `RECYCLING_CRON_ENABLED` and `RECYCLING_CRON_SCHEDULE`.**

**F2. Filter `findRecyclablePosts` by metrics/performance.**
- Use `PostMetrics` to sort by engagement. Candidate selection should be age + performance.

**F3. Add `orderBy: { createdAt: 'desc' }` and `status` filter to `loadRecentHashes`.**

**F4. Align SimHash threshold with `GenerationService` (≤ 3).**

**F5. Validate post age in `recyclePost`/`recycleById`.**
- Reject posts newer than 30 days.

**F6. Check `llmMetadata.recycled` in `recycleById` before generating.**
- Prevent duplicate manual recycling.

**F7. Mark original as `recycled` only after `generatePostsForTopic` succeeds.**
- Avoid losing recycling opportunities on generation failure.

**F8. Pass original language, keywords, and facts to the recycled topic.**
- Avoid hardcoded English and empty keywords/facts.

**F9. Return all generated post IDs from `runRecycling`/`recyclePost`.**
- Better observability and counting.

**F10. Gate `runRecycling` and `recyclePost` with `FlowControlService`.**
- Respect `pauseGeneration`.

**F11. Add `RECYCLING_ENABLED` feature flag for module loading.**
- If not needed, skip module entirely.

**F12. Add metrics and SSE events for recycling.**
- `recycling_started`, `recycling_completed`, `recycling_failed`.

## 8. Cross-references

- `modules/generation` — `GenerationService.recycleById`, `GenerationService.recycleTopPosts`, `simhash`.
- `modules/autonomy` — `auto-approve` could auto-approve recycled drafts.
- `modules/posts` — `Post` status transitions, `sourceRef`, `llmMetadata`.
- `modules/analytics` — `PostMetrics` needed for performance-based recycling.
- `modules/flow-control` — should be checked before running recycling.
- `infrastructure/prisma` — `PrismaService`, `Post`, `PostStatus`, `GenerationRun`.
- `infrastructure/guards` — `LocalhostGuard`.

## 9. Overall assessment

- **Health**: 5/10. The recycling module is small and correctly delegates rewriting to `GenerationService`, but it has significant correctness gaps: performance-based selection is missing, SimHash threshold is inconsistent with generation, hardcoded English, original marked `recycled` before success, and manual endpoint can recycle any age or duplicate.
- **Biggest strengths**: uses generation graph to avoid verbatim copies, SimHash deduplication against recent posts, guard-protected write endpoints, dynamic cron registration.
- **Biggest risks**: `findRecyclablePosts` may return empty due to small `take` and strict-ish SimHash; recycling not based on actual performance; language/kw/facts lost in recycled topic; manual recycling can duplicate or recycle recent posts; `recycled` flag set before success.
- **Recommended next actions**:
  1. Use `ConfigService` for `RECYCLING_CRON_ENABLED` and `RECYCLING_CRON_SCHEDULE`.
  2. Add `PostMetrics` to `findRecyclablePosts` sorting and selection.
  3. Fix SimHash threshold to match `GenerationService` (≤ 3).
  4. Preserve original post language, keywords, and facts in the recycled topic.
  5. Mark `recycled` only after `generatePostsForTopic` succeeds.
  6. Validate age and `recycled` flag in `recycleById` before generating.
  7. Add `flowControl` pause checks.
