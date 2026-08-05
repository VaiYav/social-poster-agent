# Posting Sequence — Current State

> **End-to-end flow:** From cron trigger to published post on X/Threads/Facebook.
> **As-is:** Cron → generation → HITL → approve → BullMQ → Camoufox → platform → verify → SSE.

```mermaid
sequenceDiagram
    autonumber
    participant Cron as CronService
    participant Gen as GenerationService
    participant Graph as LangGraph<br/>(GenerationGraph)
    participant LLM as LlmService<br/>(15-provider router)
    participant Langfuse as Langfuse
    participant DB as PostgreSQL
    participant Redis as Redis<br/>(checkpoints)
    participant UI as Vue Dashboard
    participant Operator as Operator
    participant Queue as BullMQ Queue<br/>(spa-posting-{network})
    participant Worker as BullMQ Worker
    participant Poster as Poster<br/>(X/Threads/Facebook)
    participant Camoufox as Camoufox Browser
    participant Platform as Platform<br/>(X/Threads/Facebook)
    participant SSE as SSE Service<br/>(Redis pub/sub)
    participant Discord as Discord

    Note over Cron: Trigger: CRON_GENERATION_SCHEDULE<br/>(default: 0 9,21 * * * — 2x/day)
    Cron->>Gen: generate({ topics, language })
    Gen->>Gen: SimHash dedup check (last 200 posts / 30 days)
    Gen->>Graph: graph.invoke(state, { thread_id: runId:topic })
    Graph->>Redis: Save checkpoint
    Graph->>LLM: research_extract (prompt: research-extract)
    LLM->>Langfuse: Trace + fetch prompt (5-min cache)
    LLM-->>Graph: Facts extracted
    Graph->>LLM: hook_generation (prompt: hook-generation)
    LLM-->>Graph: 3-5 hooks
    Graph->>LLM: angle_per_network → draft (per network, parallel)
    LLM-->>Graph: Draft posts (X, THREADS, FACEBOOK)
    Graph->>LLM: critique → refine (per network)
    LLM-->>Graph: Refined posts
    Graph->>LLM: judge (per network, non-blocking)
    LLM-->>Graph: Judge scores (4 criteria, 0.0-1.0)
    Graph->>LLM: visual_concept → ab_variant (per network)
    LLM-->>Graph: Final posts with variants

    alt AUTO_APPROVE_ENABLED = true AND score ≥ threshold
        Graph->>Graph: Auto-approve (skip interrupt)
    else HITL mode (default)
        Graph->>Graph: interrupt() — pause for review
        Graph-->>Gen: Paused state
        Gen-->>UI: SSE: generation_paused
        UI->>Operator: Show posts for review
        Operator->>UI: Approve / Reject / Edit
        UI->>Gen: POST /posts/:id/approve
        Gen->>Graph: resumeWithReview(Command({ resume }))
    end

    Graph->>Graph: save_to_db (format state)
    Graph-->>Gen: Final state (3 posts)
    Gen->>DB: Prisma: create Post rows (status = APPROVED)
    Gen-->>UI: SSE: generation_complete

    Note over Gen,Queue: Approval triggers queue enqueue
    Gen->>Queue: enqueuePosting(postId, network)<br/>(jobId = postId for idempotent dedup)
    Queue->>Queue: Concurrency = 1 (serialize to look human)

    Queue->>Worker: Process job
    Worker->>DB: Re-check Post.status = APPROVED
    Worker->>Poster: postById(postId)

    Poster->>Camoufox: acquireContext(network)
    Note over Camoufox: X/Threads: pooled context<br/>Facebook: persistent context (user_data_dir)
    Camoufox-->>Poster: Browser context

    Poster->>Camoufox: Session warm-up (browse feed)
    Poster->>Camoufox: Navigate to compose
    Poster->>Camoufox: Type content (human-like typing)
    Poster->>Camoufox: Ctrl+Enter / click Publish
    Camoufox->>Platform: Submit post
    Platform-->>Camoufox: Post published

    Poster->>Camoufox: verifyPosted (navigate to profile)
    Camoufox->>Platform: Fetch profile page
    Platform-->>Camoufox: Post visible
    Camoufox-->>Poster: Verified

    Poster->>DB: Update Post.status = POSTED, set permalink
    Poster->>SSE: Publish to Redis channel spa:sse
    SSE-->>UI: EventSource: post_published
    UI->>Operator: Show success notification

    alt Posting fails
        Poster->>Queue: Throw error
        Queue->>Queue: Retry (3-8 retries, exponential backoff 60s)
        alt All retries exhausted
            Queue->>Discord: DLQ alert webhook
            Queue->>DB: Update Post.status = FAILED
        end
    end
```

## Key details

### Trigger layer
- **CronService** (`modules/generation/cron.service.ts`) — dynamic registration via `SchedulerRegistry.addCronJob()` in `onModuleInit()`
- Schedule: `CRON_GENERATION_SCHEDULE` (default `0 9,21 * * *` — 2x/day)
- Skips when `ORCHESTRATOR_ENABLED=true` (orchestrator replaces crons) or `SPA_DRY_RUN=true`
- **OrchestratorGraph** (when enabled) replaces all crons with OBSERVE → DECIDE → EXECUTE loop

### Generation
- **GenerationService** wraps `graph.invoke()` with Langfuse callbacks via ALS
- SimHash dedup BEFORE generation — skip near-duplicate topics
- Per-topic: one graph invocation → 3 Post rows (X, THREADS, FACEBOOK)
- Crash-resume via `RedisCheckpointSaver` (key: `runId:topic`)

### HITL (Human-in-the-Loop)
- **Default mode:** `AUTO_APPROVE_ENABLED=false` → `human_review` node calls `interrupt()`
- Operator reviews in Vue dashboard, approves/rejects/edits
- Resume via `GenerationService.resumeWithReview()` with `new Command({ resume: {...} })`
- **Auto-approve mode:** `AUTO_APPROVE_ENABLED=true` + judge score ≥ `AUTO_APPROVE_MIN_SCORE` (default 7) → skip interrupt

### Queue + Worker
- **BullMQ** — one queue per network×action: `spa-posting-x`, `spa-posting-threads`, `spa-posting-facebook`
- `concurrency=1` — serialize to look human (B9 mitigation)
- `jobId = postId` — idempotent dedup (same post won't be queued twice)
- Worker re-checks `Post.status = APPROVED` before posting (race condition guard)
- Retry: 3 retries (posting: 8), exponential backoff (60s base)
- DLQ → Discord webhook alert

### Browser posting
- **X/Threads:** pooled context (`BROWSER_POOL_SIZE=3`), fresh context per post, storageState saved
- **Facebook:** persistent context (`user_data_dir` on disk, never pooled/closed)
- Session warm-up: browse feed before posting (anti-detect)
- Human-like typing: `humanType()`, `humanClick()`, `randomDelay()`
- Multi-fallback text entry: execCommand → fill → clipboard paste → keyboard.type
- Selector chain: `data-testid → role → label → CSS → text` (with drift detector)

### Verification
- `verifyPosted()` — navigate to profile, check post is visible
- Resource blocking: `blockImages=true` on verify (only needs text + URL pattern)
- Sets `Post.status = POSTED`, saves permalink

### SSE (real-time UI updates)
- Worker PUBLISHes to Redis channel `spa:sse`
- `SseService` SUBSCRIBEs (separate connection — subscriber can't publish)
- Fans out to `EventSource` clients in Vue dashboard
- Events: `generation_paused`, `generation_complete`, `post_published`, `post_failed`

### What's missing (future state)
- **No `POST_VERIFIED` event** — currently only `POSTED`. Future: verify → `VERIFIED` → emit event → IndexNow + social promo
- **No canonical URL** — posts don't link back to a blog. Future: POSSE canonical URL management
- **No article generation** — only short social posts. Future: article graph (research → outline → draft → judge → refine)
- **No syndication** — only X/Threads/Facebook. Future: 11 platforms via Camoufox + LLM-in-the-loop
