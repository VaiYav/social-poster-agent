# Module: `modules/posts`

## 1. What this module does

`modules/posts` is the central `Post` entity lifecycle module. It persists generated drafts, handles status transitions, enqueues approved posts to the posting queue, and emits domain events for the rest of the system (auto-approve, SSE, analytics). It is the glue between `modules/generation`, `modules/autonomy`, and `modules/posting`/`modules/queue`.

**Main responsibilities:**
- `PostsService` — CRUD, status transitions, `approve()`/`reject()`, `findBySourceAndNetwork()` for generation dedup, `findThreadContinuations()` for multi-stage threads.
- `PostsController` — REST API for listing, creating, approving, rejecting, and updating post status.
- `network-limits.ts` — per-network character limits and `checkContentLength()`.
- `Post` events — `DRAFT_GENERATED`, `APPROVED`, `POSTING_STARTED`, `POSTED`, `FAILED`.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `posts.module.ts` | NestJS module | `PostsModule` — imports `EventEmitterModule`, `QueueInfraModule` (for `IPostingQueuePort`) |
| `posts.service.ts` | Core service | `findMany()`, `findById()`, `findDrafts()`, `create()`, `updateStatus()`, `approve()`, `reject()`, `findBySourceAndNetwork()`, `findThreadContinuations()`, `emitDraftGenerated()` |
| `posts.controller.ts` | REST API | `GET /posts`, `GET /posts/drafts`, `GET /posts/:id`, `POST /posts`, `PATCH /posts/:id/status`, `POST /posts/:id/approve`, `POST /posts/:id/reject` |
| `network-limits.ts` | Length validation | `NETWORK_LIMITS`, `checkContentLength()` |

## 3. How it works

### 3.1 `Post` schema (Prisma)

The `Post` model includes: `id`, `accountId`, `network`, `language`, `content`, `status` (`DRAFT`, `APPROVED`, `POSTING`, `POSTED`, `FAILED`, `REJECTED`), `postUrl`, `errorMessage`, `threadId`, `threadPosition`, `generationRunId`, `sourceRef` (JSON), `llmMetadata` (JSON), `simhash`, `createdAt`, `approvedAt`, `postedAt`.

### 3.2 `PostsService.create()`

- Creates a `Post` row in Prisma.
- Optionally accepts a transaction `client` and `emitEvent: false` for atomic thread creation.
- Emits `PostEvents.DRAFT_GENERATED` unless `opts.emitEvent === false`.
- Returns the created `Post`.

### 3.3 `PostsService.approve()`

- Loads the post by `id`.
- Validates the post is `DRAFT` (`ConflictException` otherwise).
- Validates effective content length with `checkContentLength()`.
- If `editedContent` is provided and non-empty, updates `content`.
- Updates status to `APPROVED` and `approvedAt`.
- Emits `PostEvents.APPROVED`.

### 3.4 `PostsController.approve()`

- Parses `ApprovePostDtoSchema` (body `{ editedContent?: string }`).
- Calls `postsService.approve(id, dto.editedContent)`.
- Enqueues the post via `IPostingQueuePort.enqueuePosting()`.
- Swallows enqueue errors (the reconciliation cron will re-enqueue missed `APPROVED` posts).

### 3.5 `PostsService.updateStatus()`

- Loads the post.
- Updates `status` and optionally `postUrl`, `errorMessage`.
- Sets `approvedAt`/`postedAt` for `APPROVED`/`POSTED`.
- Emits `POSTING_STARTED`, `POSTED`, `FAILED` events.
- Logs the transition.

### 3.6 `PostsService.findBySourceAndNetwork()`

- Loads posts for a network in the last `sinceDays` (default 14) excluding `FAILED`/`REJECTED`.
- Filters by `sourceRef.path` in code (Prisma JSON filtering limitation).
- Used by generation dedup to avoid generating the same topic twice.

### 3.7 `PostsService.findThreadContinuations()`

- Loads `Post` rows with `threadId`, `threadPosition > 0`, and `status: APPROVED`.
- Ordered by `threadPosition` ascending.

### 3.8 `network-limits.ts`

- `NETWORK_LIMITS` mirrors generation/AB-variant limits: X 280, Threads 500, Facebook 500.
- `checkContentLength()` counts Unicode code points (spreads `content` into an array) to avoid UTF-16 over-counting emoji.

## 4. Dependencies

**Downstream (called by posts):**
- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/event-emitter` — `EventEmitter2` for domain events.
- `infrastructure/queue` — `IPostingQueuePort` (via `QueueInfraModule`).

**Upstream (callers):**
- `modules/generation` — calls `PostsService.create()` to persist drafts.
- `modules/autonomy` — auto-approve listener triggers on `DRAFT_GENERATED` and may `evaluate`/`approve`/`reject`.
- `modules/posting` — calls `findById`, `updateStatus`, `findThreadContinuations`.
- `modules/queue` — worker triggers `postById` which calls `PostsService`.
- `modules/accounts` — `accountId` is FK.
- UI — `PostsController`.

## 5. Environment variables

None directly. `sourceRef` dedup window is passed from callers (`DEDUP_SINCE_DAYS` in `GenerationService`).

## 6. Findings

### 6.1 Bugs / correctness

**B1. `PostsService.findBySourceAndNetwork` filters `sourceRef.path` in code after loading all matching posts from DB**
- `posts.service.ts:211-229` loads all posts for `network` in the last 14 days excluding `FAILED`/`REJECTED`, then filters in JS. This is N+1-ish if many posts exist. But with 200 posts it's fine. More importantly, it doesn't filter `sourceRef.path` in the database, which is a Prisma JSON limitation. However, `sourceRef` is a JSON object and Prisma has `json` filtering in some versions. The code is safe but not optimal.

**B2. `PostsService.findBySourceAndNetwork` excludes `FAILED`/`REJECTED` but not `DRAFT` or `POSTING`**
- `DRAFT` and `POSTING` posts may exist for the same topic. If a draft is generated for topic X and remains in DRAFT, the next generation will see it and avoid regenerating. This is intentional for HITL. But if a draft is stale and never approved, the topic is blocked. There is a stale draft cleanup? Not in this module. Should be a reconciliation job.

**B3. `PostsService.findBySourceAndNetwork` does not filter by `accountId`**
- If multiple accounts post to the same network, this method returns all posts. For dedup, the source path should be unique per network, but account context is missing. This is a source-path dedup, not per-account. Fine for single account per network.

**B4. `PostsService.updateStatus` does not validate the status transition**
- `posts.service.ts:111-139` updates any status to any status. For example, `POSTED` → `DRAFT` or `REJECTED` → `APPROVED` is allowed. It should enforce valid transitions (e.g., `DRAFT` → `APPROVED`, `APPROVED` → `POSTING` → `POSTED`/`FAILED`). The `approve()`/`reject()` methods enforce some transitions, but `updateStatus` is a backdoor.

**B5. `PostsController.updateStatus` catches any error and throws `NotFoundException` even if it's a status transition error**
- `posts.controller.ts:117-121` `try { ... } catch { throw new NotFoundException(...) }`. This masks the real error. If `updateStatus` later throws an error for invalid transition, it will be reported as "not found".

**B6. `PostsController.approve()` catches errors and throws `NotFoundException` for non-HTTP errors**
- `posts.controller.ts:146-158` catches errors, passes through `BadRequest`/`Conflict`/`NotFound`, but for any other error throws `NotFoundException`. If `approve()` fails due to a DB error, the user gets a misleading 404.

**B7. `PostsController.create()` parses `rawBody` with Zod and returns `BadRequestException` for Zod errors. Good.** But `PostsService.create()` does not validate the network or account. It relies on `CreatePostDtoSchema`.

**B8. `PostsService.create()` does not set `simhash` if the caller does not provide it**
- `posts.service.ts:74-100` creates `Post` with `data` as provided. If `simhash` is missing, it is `null`. The auto-check and posting dedup then compute it on the fly. This is okay but could be normalized at creation time.

**B9. `PostsService.findMany` and `findById` include `account` and `thread` but `findBySourceAndNetwork` does not**
- Inconsistent include. Minor.

**B10. `PostsService.findThreadContinuations` filters by `status: APPROVED`**
- Used by `PostingService` to post continuations. If a continuation is `DRAFT` or `REJECTED`, it is skipped. Good.

**B11. `PostsService.approve()` validates `checkContentLength` but `posts.controller.ts` `approve` does not validate `editedContent` beyond Zod schema**
- `ApprovePostDtoSchema` likely validates `editedContent` max length and type. Good.

**B12. `PostsService.updateStatus` does not emit `REJECTED` event when `reject()` is called**
- `reject()` emits no event. `updateStatus` only emits events for `POSTED`, `FAILED`, and `POSTING` — for `REJECTED`, none of the `if/else if` branches match, so no event is emitted at all. There's a `REJECTED` enum in `PostEvents` but it's never emitted. The `AutoApproveService` directly updates status to `REJECTED` and does not emit `REJECTED` event. The listener `AutoApproveListener` does not listen to `REJECTED`. This is a gap — the UI may not receive an event when a post is rejected.

**B13. `PostsService.updateStatus` sets `approvedAt` for `APPROVED` status but `approve()` already sets `approvedAt`**
- `approve()` calls `prisma.post.update` directly and does not use `updateStatus()`. So `updateStatus` is only used for manual status changes (e.g., admin). If `updateStatus` is called with `APPROVED`, it sets `approvedAt` again. Fine.

**B14. `PostsController.approve()` does not check if `posting` flow is paused before enqueuing**
- It enqueues regardless. The queue may be paused or the `PostingService` will check `FlowControl.isPaused('posting')` and throw, which causes BullMQ retry. But if the flow is paused, it's better to not enqueue and let the user know. The queue pause will stop processing, but the job is in queue. If the user unpauses, it will post. Acceptable.

**B15. `PostsController` `enqueueForPosting` swallows errors**
- `posts.controller.ts:47-53` catches and logs. If enqueue fails, the post is approved but not queued. The reconciliation cron should catch this. But the user gets a successful response. This is documented in the comment. Good for resilience, but the UI may think the post is queued.

**B16. `PostsService.findBySourceAndNetwork` has `sinceDays` default `14` but the caller `GenerationService` passes `DEDUP_SINCE_DAYS` (14). Good.**

**B17. `PostsService.findBySourceAndNetwork` `status: { notIn: [FAILED, REJECTED] }` means that if a post was `POSTED` and then deleted or `FAILED`, it can be regenerated. Good. But `DRAFT` and `POSTING` are included, so a topic with a draft blocks new generation. This is by design for HITL.**

### 6.2 Performance

**P1. `PostsService.findBySourceAndNetwork` loads all posts in 14-day window for a network and filters in JS**
- If there are many posts, this could be slow. Add `orderBy: { createdAt: 'desc' }` and `take` to limit. The current code has `take`? No, it doesn't. It loads all posts in the window. This is a potential hot path during generation. `GenerationService` calls `findBySourceAndNetwork` once per network per topic (3 topics × 3 networks = 9 calls per batch). If the DB has 1000 posts per network in 14 days, it loads 9000 rows. But `take` in `loadRecentHashes` is 200, not here. Here no `take`. Add `take` limit.

**P2. `PostsService.findMany` uses `include: { account: true, thread: true }` which may be heavy for list endpoints**
- `findMany` is used by `PostsController` and `posting.service.postAllApproved`. For listing, including `account` and `thread` may be fine. For `postAllApproved`, it doesn't need `account`/`thread` but it's loaded. Minor.

**P3. `PostsService.findById` includes `generationRun` which may be heavy**
- `posts.service.ts:52-61` includes `generationRun`. For each `findById` in `postById`, it loads the generation run. Usually one per post. Fine.

### 6.3 Architecture / anti-patterns

**A1. `PostsService` mixes CRUD, status transitions, and dedup logic**
- This is normal for a small service. But `approve()`/`reject()` are business logic, while `updateStatus()` is a generic backdoor. It could be split into `PostLifecycleService` and `PostRepository`.

**A2. `PostsController` directly enqueues to `IPostingQueuePort` after `approve()`**
- This is a side effect that should live in `PostsService.approve()` or an event listener. The `PostEvents.APPROVED` event is emitted but `PostsController` also enqueues directly. This is because the listener pattern may be delayed. But it creates two paths: `approve()` from controller enqueues, `approve()` from service does not. The autonomous runner calls `AutoApproveService.evaluate()` which updates status and then enqueues in `AutonomousRunnerService`. Auto-approve listener enqueues. So the `approve()` service itself does not enqueue. This is consistent: the controller is the orchestrator. But the `PostEvents.APPROVED` event is not used to enqueue. There is an opportunity to move enqueue to an `APPROVED` event listener to decouple `PostsController` from queue. However, the current design with `IPostingQueuePort` is fine and avoids the cycle.

**A3. `PostsController` `approve` catches all non-HTTP errors and throws `NotFoundException`**
- This is a misuse of HTTP status codes. `NotFound` should only be for missing post. Other errors should be 500. The `catch` block is too broad.

**A4. `PostsService.updateStatus` is a generic update that can bypass business rules**
- It should be limited to the posting worker (status `POSTING` → `POSTED`/`FAILED`) and not exposed via controller for arbitrary transitions. The controller exposes `PATCH /posts/:id/status`. An admin could set a post to `POSTED` without it being posted. This is a security/operational risk.

**A5. `network-limits.ts` duplicates `NETWORK_LIMITS` from `content-enhancements` and `generation`**
- DRY violation. Single source of truth should be `domain/network-limits.ts`.

**A6. `PostsController` uses `rawBody: unknown` and casts `as CreatePostDto` after Zod parse. Good.**

**A7. `PostsController` `findDrafts` accepts `network` as a string but does not validate with Zod/Pipe. It passes to `postsService.findDrafts` which expects `SocialNetwork | undefined`. If an invalid network is passed, it might be filtered at Prisma or cause runtime error. But `findDrafts` in `posts.service.ts` uses `where: { network }` directly. If `network` is invalid, Prisma will reject? `SocialNetwork` is enum, so Prisma may throw. Better to validate in controller.**

### 6.4 TypeScript / type safety

**T1. `PostsController` `findDrafts` `network?: 'X' | 'THREADS' | 'FACEBOOK'` is hardcoded and not derived from `SocialNetwork` enum**
- Could be `SocialNetwork`.

**T2. `PostsService.create` `data` type is inline and not a shared type. `CreatePostDto` is in `domain/dtos`. `PostsService` uses its own inline shape. There is a mismatch risk if `CreatePostDto` evolves.**

**T3. `PostsService.updateStatus` takes `UpdatePostStatusDto` from `domain/dtos` but doesn't validate inside the service. It relies on controller.**

### 6.5 Security / reliability

**S1. `PostsController` `PATCH /posts/:id/status` allows arbitrary status transitions if no additional guard**
- As noted, an admin could set `POSTED` without verification. Should restrict to `POSTING`/`POSTED`/`FAILED` transitions and require admin or worker context. Also should validate `postUrl`/`errorMessage` based on status.

**S2. `PostsController` `POST /posts/:id/approve` can be called by any authenticated user. If `AUTH_ENABLED` false, pass-through. Approve should be operator/admin.**

**S3. `PostsController` `POST /posts` (manual create) can be called by any user and creates a post in DRAFT. It should be operator/admin.**

**S4. `PostsService.create` does not validate `accountId` exists in `Account` table**
- If `accountId` is invalid, Prisma will reject due to FK. Good.

**S5. `PostsService.create` `llmMetadata` and `sourceRef` are `Prisma.InputJsonValue` and not validated. If a caller passes a non-JSON object, it could fail at DB.**

**S6. `PostsController` `approve` enqueues to queue even if the `post` is not approved? No, it calls `approve` first. Good.**

**S7. `PostsService.approve` with `editedContent` updates `content` but does not update `simhash` if it was precomputed**
- If `simhash` is stored, `approve` with edited content may invalidate the hash. The `content` changes but `simhash` remains old. This can cause `isDuplicateHash` to compare old hash or wrong content. `approve` should recompute `simhash` when `content` changes. **Bug.**

**S8. `PostsService` `approve` with `editedContent` does not re-run `AutoCheck` or content safety checks**
- If an operator edits in a forbidden phrase or engagement bait, the `approve` endpoint will approve and enqueue. The `PostingService` does not re-check. The post could be published with policy violations. **Bug.**

**S9. `PostsService` `approve` with `editedContent` does not update `llmMetadata` to reflect the edit or mark manual approval**
- `llmMetadata` is not touched. Should record `editedAt`, `editedBy`, `manualApproval`.

**S10. `PostsService.updateStatus` does not record `updatedAt` / `updatedBy`**
- Audit trail is missing.

## 7. New feature / improvement ideas

**F1. Add status-transition state machine**
- Enforce valid transitions and reject invalid `updateStatus` calls.

**F2. Move `approve()` enqueue to `PostEvents.APPROVED` listener**
- Decouple `PostsController` from queue and make `approve()` from any source trigger enqueue.

**F3. Recompute `simhash` on `approve` when content is edited**
- Prevent stale hash and dedup mismatch.

**F4. Re-run `AutoCheck` on `approve` with edited content**
- Ensure operator edits don't bypass safety gates.

**F5. Add `REJECTED` event emission**
- UI should receive reject notifications.

**F6. Add audit columns (`updatedBy`, `editedBy`, `manualApprover`)**
- Track who changed the post.

**F7. Add `findBySourceAndNetwork` limit and `orderBy`**
- Performance and determinism.

**F8. Add `Post` soft-delete or stale draft cleanup**
- Drafts older than N days should be auto-rejected or purged.

**F9. Add `Post` metrics**
- `posts_by_status`, `approval_rate`, `time_to_approve`.

**F10. Add `Post` search / full-text search**
- For UI and analytics.

**F11. Single source of truth for `NETWORK_LIMITS`**
- Move to `domain/network-limits.ts` and reuse.

**F12. Add `approve` endpoint with `POST` and `PUT` semantics**
- `PUT /posts/:id/approve` is idempotent.

**F13. Add `PostsService` `archive` or `cancel` for `POSTING` posts**
- Currently a post stuck in `POSTING` can only be recovered by the queue.

## 8. Cross-references

- `modules/generation` — creates `Post` rows.
- `modules/autonomy` — auto-approve gate, reject, and `AutoApproveListener`.
- `modules/posting` — reads and updates `Post` status.
- `modules/queue` — `IPostingQueuePort` is used by `PostsController`.
- `modules/accounts` — `accountId` FK.
- `modules/content-enhancements` — `NETWORK_LIMITS` duplicate.
- `events/listeners` — `AutoApproveListener` on `DRAFT_GENERATED`.
- `infrastructure/prisma` — `Post` model.
- `infrastructure/sse` — events from `PostsService` and `AutoApproveService`.

## 9. Overall assessment

- **Health**: 6/10. The module is the core data model but has several correctness issues: stale `simhash` on edit, no safety recheck on edit, broad `updateStatus` backdoor, no `REJECTED` event, and missing audit trail.
- **Biggest strengths**: clean CRUD, `approve`/`reject` transition guards, `IPostingQueuePort` decoupling, event emission for EDA.
- **Biggest risks**: `approve` with edited content doesn't update `simhash` or re-run `AutoCheck`; `PATCH /posts/:id/status` allows arbitrary transitions; `findBySourceAndNetwork` no `take`/`orderBy`; no `REJECTED` event; `updateStatus` not restricted to worker/admin.
- **Recommended next actions**:
  1. Recompute `simhash` and re-run `AutoCheck` when `editedContent` is approved.
  2. Restrict `updateStatus` to worker/admin and enforce state machine.
  3. Add `REJECTED` event emission.
  4. Add `findBySourceAndNetwork` `orderBy` and `take` limits.
  5. Single source of truth for `NETWORK_LIMITS`.
  6. Add role guards to `approve`/`reject`/`status` endpoints.
