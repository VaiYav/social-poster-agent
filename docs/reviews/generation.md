# Module: `modules/generation`

## 1. What this module does

`modules/generation` is the core content-generation pipeline. It transforms astrology content topics into platform-specific social-media drafts (X, Threads, Facebook). It is the most complex module in the backend: a LangGraph workflow per topic, per-network parallel fan-out, LLM-as-a-Judge, multi-stage threads, human-in-the-loop (HITL), and several content-enhancement integrations.

**Main responsibilities:**
- Fetch topics from `ContentSourceService` and enrich them (trending topics, content-pillar steering, topic prioritization/freshness, trend guardrail).
- Run a `StateGraph` (`generation.graph.ts`) once per topic to produce 3 posts in parallel (one per network).
- Persist generated drafts as `Post` rows with `status=DRAFT`, SimHash dedup, and rich `llmMetadata`.
- Support article repurposing, evergreen recycling, and multi-stage threads.
- Expose REST endpoints for manual/cron/scheduled generation, resumability, HITL review, and provider status.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `generation.module.ts` | NestJS module wiring | `GenerationModule` — imports `LlmModule`, `CheckpointModule`, `SseModule`, `ContentSourceModule`, `AccountsModule`, `PostsModule`, `TrendingModule`, `ContentEnhancementsModule` |
| `generation.service.ts` | Main orchestration service | `generate()`, `repurposeFromArticles()`, `recycleTopPosts()`, `recycleById()`, `resumeRun()`, `resumeWithReview()`, `pauseRun()`, `listRuns()`, `getRun()`, `listCheckpoints()`, `getCheckpointState()` |
| `generation.graph.ts` | LangGraph workflow definition | `buildGenerationGraph()`, `createInitialState()`, `GenerationState`, `clearHookCache()`, `getHookCacheStats()` |
| `generation.controller.ts` | REST endpoints | `POST /generation/run`, `POST /generation/repurpose`, `POST /generation/recycle`, `GET /generation/runs`, `POST /generation/runs/:id/resume`, `POST /generation/runs/:id/review`, `POST /generation/runs/:id/pause`, `GET /generation/models`, `GET /generation/provider-status`, `POST /generation/reset-circuit-breakers` |
| `cron.service.ts` | Scheduled trigger | `CronService` — dynamic `CronJob` registered from `CRON_GENERATION_SCHEDULE` (default `0 9,21 * * *`) |
| `simhash.ts` | Near-duplicate detection | `simhash()`, `hammingDistance()`, `isNearDuplicate()`, `isDuplicateHash()`, `isDuplicateAgainstCorpus()` |
| `topic-prioritization.ts` | Pure topic ordering | `prioritizeTopics()` — freshness-first + round-robin category rotation |
| `prompts/judge-prompt.ts` | Shared judge prompt templates | `JUDGE_SYSTEM_PROMPT`, `JUDGE_USER_PROMPT_TEMPLATE` |

## 3. How it works

### 3.1 Entry points

1. **Cron** — `CronService.onModuleInit()` registers a `cron` job that calls `GenerationService.generate(3, undefined, CRON)` twice a day (unless `ORCHESTRATOR_ENABLED` or `SPA_DRY_RUN`).
2. **Manual** — `GenerationController.run()` parses `GeneratePostsDto` and calls `generate()`.
3. **Repurposing** — `repurposeFromArticles()` takes articles from content source, extracts each fact, and generates one post per fact per network.
4. **Recycling** — `recycleTopPosts()` and `recycleById()` find old `POSTED` posts and regenerate them with a fresh angle.

### 3.2 `generate()` high-level flow

```
1. Create GenerationRun (status RUNNING)
2. SSE: generation_started
3. Get topics from ContentSourceService
4. Optional: enrich with trending topics (40% cap, guardrail filter)
5. Optional: inject content-pillar hint into keywords
6. Prioritize topics (freshness + category rotation)
7. For each batch of up to 3 topics:
   a. Round-robin pick language from POSTING_LANGUAGES
   b. For each topic: generatePostsForTopic()
8. Mark run completed/failed
9. SSE: generation_completed/failed
```

### 3.3 Per-topic graph flow (`generation.graph.ts`)

```
START
  → research_extract  (LLM facts, or use pre-extracted facts)
  → hook_generation   (3-5 hook variants, cached per topic)
  → angle_per_network (assign hook + angle + style + humor per network)
  → parallel draft_x / draft_threads / draft_facebook
  → parallel critique_x / critique_threads / critique_facebook
  → parallel refine_x / refine_threads / refine_facebook
  → parallel judge_x / judge_threads / judge_facebook
      (one conditional retry to refine if anti_ai_tone < threshold)
  → parallel visual_concept_x / ... (optional)
  → parallel ab_variant_x / ... (optional)
  → human_review (HITL interrupt, optional)
  → save_to_db (format final posts, actual DB write in GenerationService)
  → END
```

- `save_to_db` does **not** write to DB. It returns `GeneratedPost[]` in graph state. `GenerationService` then iterates, runs SimHash dedup, creates `Post` rows via `PostsService.create()`.
- Error isolation: per-network draft/critique/refine failures set `results[network].error` and short-circuit that branch, but other networks continue.

### 3.4 Persistence of drafts

`generatePostsForTopic()`:
1. Loads active accounts for each network and checks `findBySourceAndNetwork` for duplicates (dedup since `DEDUP_SINCE_DAYS`, default 14).
2. Builds initial state and invokes graph with `thread_id = ${runId}:${topic.topic}` and `recursionLimit: 50`.
3. Wraps `graph.invoke()` in `withLlmCallbacks()` for Langfuse tracing.
4. For each generated post: computes SimHash, checks against last 200 posts/30 days using a **Hamming-distance threshold of 8** (`simhash.ts:116, 132, 144`), creates `Post` row.
5. Enforces per-network character limits (`NETWORK_LIMITS` in `generation.graph.ts:219-223`: X 280, Threads 500, Facebook 500) and injects length guidance (`NETWORK_LENGTH_GUIDANCE`, `generation.graph.ts:230-234`) into draft/critique/refine/judge prompts.
6. Optionally runs `ThreadDepthController` for multi-stage threads (X/Threads). It computes a configurable depth (1-5) based on content richness, network, and pillar (`generation.service.ts:778-824`), with an F2 fallback if the controller is unavailable, and uses `generateContinuationContent` (line 925) for LLM-planned continuations. Creates `PostThread` + continuation `Post` rows atomically.
7. Records content pillar via `ContentPillarTracker`.

### 3.5 Resumability

- `pauseRun()` aborts `activeRuns` and marks `GenerationRun` as `PAUSED`.
- `resumeRun()` re-fetches topics from `run.sourceTopics`, then re-invokes the graph with the same `thread_id` so LangGraph checkpoints skip already-completed nodes.
- `resumeWithReview()` sends a `Command({ resume: { approved, edits } })` to continue from the `human_review` interrupt.

## 4. Dependencies

**Downstream (called by generation):**
- `infrastructure/llm` — `ILlmPort` for all LLM calls.
- `infrastructure/checkpoint` — `RedisCheckpointSaver` for graph state persistence.
- `infrastructure/sse` — `SseService` for progress/lifecycle events.
- `infrastructure/prompt` — `IPromptPort` for Langfuse prompt management.
- `infrastructure/langfuse` — `LangfuseService` for tracing.
- `infrastructure/prisma` — `PrismaService` for `GenerationRun` and `Post` persistence.
- `modules/content-source` — `ContentSourceService` for topics.
- `modules/accounts` — `AccountsService.findByNetwork()`.
- `modules/posts` — `PostsService.create()` and `emitDraftGenerated()`.
- `modules/trending` — `TrendingService`, `TrendingScraperService` (optional).
- `modules/content-enhancements` — `ContentPillarTracker`, `HookPerformanceBank`, `VisualConceptService`, `ThreadDepthController`, `ABVariantGenerator`, `checkTrendSafety()`, `buildHumanizeInstruction()`, `buildBaitRewriteInstruction()`, `getSlopListForPrompt()`, `getLanguageExamples()`, `pickContentStyle`, `getHumorPromptGuidance`, etc.

**Upstream (callers of generation):**
- `CronService` triggers `generate()`.
- `GenerationController` exposes endpoints.
- `modules/recycling` may call `recycleById()`.
- `modules/autonomy` may call generation indirectly.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `POSTING_LANGUAGES` | `en` | `generation.service.ts:102` | Comma-separated ISO 639-1 codes; round-robin per topic |
| `JUDGE_REFINE_THRESHOLD` | `0.6` | `generation.service.ts:129` | anti_ai_tone threshold for one judge-triggered refine retry |
| `DEDUP_SINCE_DAYS` | `14` | `generation.service.ts:642` | Window for source-path dedup per network |
| `GENERATION_TEMPERATURE_HOOK` | `0.95` | `generation.graph.ts:24` | Hook generation temperature |
| `GENERATION_TEMPERATURE_DRAFT` | `0.8` | `generation.graph.ts:25` | Draft generation temperature |
| `GENERATION_TEMPERATURE_REFINE` | `0.6` | `generation.graph.ts:26` | Refine generation temperature |
| `CRON_GENERATION_SCHEDULE` | `0 9,21 * * *` | `cron.service.ts:51` | Cron expression for generation |
| `CHECKPOINT_TTL_SECONDS` | `604800` (7d) | `redis-checkpoint.ts:48` | Checkpoint Redis TTL |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `process.env` reads in generation service and graph (minor drift from config convention)**
- `generation.service.ts:102` `process.env.POSTING_LANGUAGES`
- `generation.service.ts:129` `process.env.JUDGE_REFINE_THRESHOLD`
- `generation.service.ts:642` `process.env.DEDUP_SINCE_DAYS`
- `generation.graph.ts:24-26` `process.env.GENERATION_TEMPERATURE_*`
- The project uses `ConfigService` for env values in `LlmService` and `RedisCheckpointSaver`, but `GenerationService` reads `process.env` directly in constructor and at runtime. This is inconsistent and can surprise tests (they must set `process.env` before the module loads if the constructor path is exercised). It is not a bug per se, but a maintainability risk.

**B2. `recycleById` and `recycleTopPosts` create synthetic topics with `language: 'en'` hardcoded**
- `generation.service.ts:502` and `generation.service.ts:587` set `language: 'en'` regardless of `POSTING_LANGUAGES` config.
- This means recycled content is not routed through the multilingual rotation, which may reduce reach for non-English accounts.

**B3. `repurposeFromArticles` also hardcodes English**
- `generation.service.ts:378` calls `generatePostsForTopic(..., false)` with no language argument, so it defaults to `'en'` (`generation.service.ts:626`).
- Articles from non-English sources may still be generated in English.

**B4. `generate()` batching uses `Promise.allSettled` but `postIds` ordering loses batch/topic correlation**
- `generation.service.ts:284` `Promise.allSettled` returns results in the same order as the batch, but the code only pushes IDs to a flat `postIds` array. The `sourceTopics` sent to `markRunCompleted` comes from `prioritizedTopics`, not the actual successfully generated topics. If one topic in a batch fails, the source topic list still includes all topics, but only some post IDs are saved. This is mostly a logging/status issue, not a data-loss bug.

**B5. `resumeRun` and `resumeWithReview` do not re-check SimHash against the same batch context**
- When a batch is interrupted mid-topic, `recentHashes` is lost. On resume, each topic reloads its own `recentHashes` from DB. This is safe for DB-backed dedup, but if a crash happened *after* a post was created but *before* `recentHashes` was updated in the loop, the next topic could generate a duplicate. The window is small and the DB already guards, but worth noting.

**B6. `JUDGE_REFINE_THRESHOLD` parsing is not validated against `[0,1]`**
- `generation.service.ts:129` `Number(process.env.JUDGE_REFINE_THRESHOLD ?? '0.6')` then `Number.isFinite(rawThreshold) ? rawThreshold : 0.6`. An env value of `2` or `-1` would be accepted, leading to always/never triggering judge retry.

**B7. `generateContinuationContent` uses a generic fallback that may violate the "no engagement bait" rule**
- `generation.service.ts:959` fallback is `What's your take on ${topic.toLowerCase()}?`. The deterministic `buildBaitRewriteInstruction` would flag `"What's your take"` as engagement bait depending on how the detector is configured. If the LLM call fails, the fallback may be rewritten again or rejected. Better to keep the fallback free of any bait-like phrasing.

**B8. `stripHashtags` only handles Latin + Cyrillic word characters**
- `generation.graph.ts:241` regex `#[\w\u0400-\u04FF\u0500-\u052F]+` does not catch other scripts (Greek, Arabic, CJK, etc.). If a multilingual prompt produces hashtags in other scripts, they slip through.

**B9. `researchExtractNode` returns one fallback fact even if LLM fails or returns empty**
- `generation.graph.ts:393` pushes `No verified facts available — write from the hook alone; do NOT invent statistics or specifics.` This is fine, but the same literal is duplicated as `facts[0]` on line 403. Any change must be kept in sync.

**B10. `createInitialState` does not copy `topic.outline` into state, but draft nodes use `state.topic.outline` directly**
- Not a bug, but `state.topic` is the full `ContentTopic` object, so the graph state carries the entire topic. Fine.

**B11. `humanReviewNode` edits apply only to `refined`, but if `refined` is empty and `draft` is non-empty, reviewer edits are silently lost**
- `humanReviewNode` collects `draftsForReview[network] = netResult.refined || netResult.draft` (line 1405). On edits, it sets `refined: reviewResult.edits[network]`. Since `save_to_db` reads `refined || draft`, this is fine. But if `refined` is empty because of a skipped refine (e.g., `VERDICT: GOOD`), `draftsForReview` shows `draft` and edits set `refined`, which `save_to_db` then uses. Correct.

**B12. `GenerationController.run` does not validate `humanReview` from DTO**
- `generation.controller.ts:22` casts `rawBody as { humanReview?: boolean }` and `body.humanReview ?? false`. The Zod DTO `GeneratePostsDtoSchema` may not include `humanReview`; if it does, it should be part of the schema. If not, the endpoint silently ignores a malformed `humanReview`.

**B13. `recycle`/`repurpose` endpoints cast networks without validation**
- `generation.controller.ts:65` and `generation.controller.ts:78` cast `body.networks` to `['X','THREADS','FACEBOOK'] | undefined`. No runtime check, so a client can pass invalid enum values and they flow into `GenerationService` until Prisma throws.

**B14. `GenerationController` uses `LlmService` directly for `/models`, `/provider-status`, `/reset-circuit-breakers`**
- These endpoints are in `generation.controller.ts` but probably belong in a dedicated `llm` controller. Not a bug, but a responsibility leak.

**B15. `cron.service.ts` uses `configService` to read `SPA_DRY_RUN` but `GenerationService` uses `process.env` for other flags**
- Inconsistent style across the module.

### 6.2 Performance

**P1. Hook cache is an unbounded-ish global `Map` (50 entries max) with no TTL per-entry eviction**
- `generation.graph.ts:40-76` is good: 50-entry FIFO, 30-min TTL. The one concern: TTL expiry uses `Date.now()` but does not run a cleanup sweep; stale entries sit in the map until accessed or evicted. For 50 entries this is negligible.

**P2. `loadRecentPostHashes` loads 200 recent posts and potentially computes `simhash()` on the fly for old rows**
- `generation.service.ts:1119-1149` loads all posts from 30 days, `take: 200`, and calls `simhash(post.content)` for any row missing `simhash` and `llmMetadata.simhash`. This is O(n) per generated post and 200 rows is small. However, if the rollout starts without `simhash` column populated, the first runs could compute many hashes. Consider a one-time backfill migration.

**P3. `filterTrendingTopics` runs `checkTrendSafety` in parallel batches of 3, but `DEDUP_SINCE_DAYS` check is per network per topic, and `findBySourceAndNetwork` is also called per network in `generatePostsForTopic`.**
- For 3 topics × 3 networks, this is fine. At scale, the N+1 fix in `generatePostsForTopic` already batches account lookup per network. But `findBySourceAndNetwork` is still called once per network per topic (3×3 = 9 queries per batch). It filters by `createdAt` and source path. This is acceptable for the current load.

**P4. `graph.invoke()` recursion limit is 50, but the graph has a conditional loop that can trigger at most one retry per network**
- `generation.service.ts:670` `recursionLimit: 50` is generous. With the current graph depth (≈10 nodes + one possible extra refine), this is safe. If loops are added, it may hide infinite loops. Fine.

**P5. `generate()` is not parallelized across batches; it processes batches sequentially**
- `generation.service.ts:282-305` uses `for` loop over batches of 3, then `Promise.allSettled` inside each batch. This caps concurrency at 3 topics. Given the LLM concurrency limit is 4 in `LlmService`, this is deliberate throttling to avoid provider cascades. Good.

**P6. `loadBrandVoice()` reads `brand-voice.md` from disk every time the service is instantiated, not per call**
- `generation.service.ts:962-974` caches in `this.brandVoice`. Good. But if the file changes during runtime, the service must restart. Acceptable.

**P7. `simhash()` is O(words) and `isDuplicateHash()` is O(n) per check against 200 hashes**
- `simhash.ts` is 147 lines, simple. For 200 hashes × 3 posts per topic, 600 hamming-distance checks per topic. Hamming distance uses `BigInt` and loops over set bits, which is fast enough. No hot path issue.

**P8. `LlmService` cache is global and bypasses `role: 'draft'` and `role: 'hook'`**
- `llm.service.ts:737` `cacheable = options?.role !== 'draft' && options?.role !== 'hook'`. This means `facts`, `critique`, `judge` calls can be cached. For generation, this is likely beneficial (same facts/critique prompts). However, if the same topic is generated twice with different `POSTING_LANGUAGES`, the cache key does not include language, so a cached English `facts` response could be reused for Ukrainian. The `facts` node does not include language in prompts, so it is safe. `critique` and `judge` include language-specific slop lists, so they are safe.

### 6.3 Architecture / anti-patterns

**A1. `GenerationService` is a large class (1461 lines) with many responsibilities**
- It orchestrates generation, repurpose, recycling, resumes, HITL, multi-stage threads, SimHash dedup, trending enrichment, pillar tracking, and provider status. It has improved from a pure god object by extracting `topic-prioritization.ts` and `simhash.ts`, but still does too much. Consider splitting into `GenerationOrchestrator`, `RepurposeService`, `RecycleService`, `GenerationResumer`.

**A2. `GenerationController` mixes LLM provider endpoints with generation endpoints**
- `/models`, `/provider-status`, `/reset-circuit-breakers` are LLM lifecycle concerns, not generation. This creates an unnecessary dependency from `GenerationController` on `LlmService` and violates SRP.

**A3. `generation.graph.ts` nodes are hardcoded per network (X, Threads, Facebook)**
- `buildGenerationGraph()` adds 3 draft/critique/refine/judge/visual/ab nodes each. Adding a new network requires editing this function. A dynamic fan-out using `state.targetNetworks` would be more extensible. However, the current hardcoding is deliberate and easy to understand.

**A4. The graph is not typed with `RunType` or `OutputType`**
- `graph.invoke()` returns `Record<string, unknown>` and casts are used in `GenerationService`. The `GenerationState` is strongly typed, but `graph.invoke` output is not.

**A5. `GenerationService` directly depends on `RedisCheckpointSaver` concrete class instead of an abstract port**
- `generation.service.ts:88` `private readonly checkpointSaver: RedisCheckpointSaver` breaks the hexagonal port pattern used for `ILlmPort` and `IPromptPort`. The module should depend on an `ICheckpointSaver` port.

**A6. `GenerationService` directly depends on `ContentSourceService`, `AccountsService`, `PostsService`, `TrendingService`, `TrendingScraperService`, `ContentPillarTracker`, `HookPerformanceBank`, `VisualConceptService`, `ThreadDepthController`, `ABVariantGenerator` concrete classes**
- Many of these are optional (`@Optional()`) but still concrete. This is a common pattern in the codebase, but it reduces testability. The important ones are already injected via NestJS DI, so mocking is still possible, just more verbose.

**A7. `tracedGraphInvoke` mutates `config.callbacks`**
- `generation.service.ts:150-162` mutates the `config` argument. Since `config` is created fresh per call, this is safe, but it is a side effect. Consider returning a new config object.

**A8. `generation.graph.ts` uses module-level state (`hookCache`, `HOOK_TEMPERATURE`, etc.)**
- The hook cache is global per process, not per graph instance. This is fine for a single backend, but multi-instance deployments won't share the cache. If horizontal scaling is a goal, the cache should be Redis-backed.

**A9. Save-to-DB logic is split between graph and service**
- `save_to_db` node in the graph only formats output; the actual DB write and dedup is in `GenerationService`. This is explicitly called out in comments and is an intentional design choice, but it is confusing. The graph "save_to_db" node name is misleading.

**A10. `generate()` and `resumeRun()` duplicate post-persistence logic**
- `generatePostsForTopic` (line 699-861), `resumeRun` (line 1303-1331), and `resumeWithReview` (line 1403-1431) all contain similar loops: `simhash`, `isDuplicateHash`, `accountsService.findByNetwork`, `postsService.create`, `recentHashes.push`. This violates DRY and is a maintenance risk. A single `persistGeneratedPosts()` helper should be extracted.

### 6.4 TypeScript / type safety

**T1. `GenerationController` uses `rawBody as { ... }` casts**
- `generation.controller.ts` casts `rawBody` to objects for `repurpose`, `recycle`, `run`, `resetCircuitBreakers`. The `GeneratePostsDtoSchema` is used for `/run`, but other endpoints bypass Zod. This is a runtime safety gap.

**T2. `GenerationService` has many optional dependencies typed as concrete classes with `@Optional()`**
- This is convenient for feature flags, but it makes it easy to forget to provide a service when it should be required. Consider using `Symbol` ports for optional features.

**T3. `GenerationState` reducer for `results` is shallow merge**
- `generation.graph.ts:193-196` `reducer: (old, update) => ({ ...old, ...update })`. This means if a node returns `results: { X: { ... } }`, it overwrites the entire `X` network result, not just the changed fields. The nodes are careful to spread `...netResult`, but this is a footgun. Using `LangGraph` channels with `add`/`send` semantics would be safer.

### 6.5 Security / reliability

**S1. `GenerationController` `/provider-status` and `/reset-circuit-breakers` are admin operations but live in the same controller as public generation endpoints**
- If `AUTH_ENABLED` is true, the global `JwtAuthGuard` protects all. If false, the localhost guard might not be enough for these destructive operations. The global guard is the only protection; ensure `/reset-circuit-breakers` is not exposed to VPN-only users without admin role.

**S2. `resumeRun` spawns an unawaited background promise with no task tracking**
- `generation.service.ts:1276` `void (async () => { ... })();` starts resume in the background. If the process crashes, the resume is not tracked. Also, concurrent calls to `resumeRun` for the same run could happen. There is no re-entrancy guard.

**S3. `pauseRun` aborts the controller but does not check if the graph is actually running**
- `generation.service.ts:1218-1231` aborts and marks `PAUSED`. If the `activeRuns` map is empty (e.g., graph finished), it still marks PAUSED. This is mostly harmless but could be confusing.

**S4. `generate()` uses `Promise.allSettled` but a single topic failure does not mark the run failed**
- `generation.service.ts:296-304` logs the error and continues. The run is marked `COMPLETED` at the end, even if some topics failed. This may hide partial failures in UI. The `errorMessage` is only set if the outer `try` catches.

## 7. New feature / improvement ideas

**F1. Multilingual parity for repurpose/recycle**
- Pass `language` through `repurposeFromArticles` and `recycleTopPosts`/`recycleById` and rotate it as `generate()` does.

**F2. Extract a `GenerationPostPersister` / `DraftPersister` helper**
- Centralize the repeated post-persistence logic (SimHash, dedup, account lookup, `postsService.create`, thread creation, pillar recording) used by `generate`, `resumeRun`, and `resumeWithReview`.

**F3. Add a `RetryQueue` for failed topics**
- When a topic's `graph.invoke()` throws, the current code logs and continues. Add a dead-letter queue so a background worker can retry individual topics without regenerating the whole run.

**F4. Add per-network quality gating**
- Use `judgeScores` to auto-reject posts below a configurable threshold (e.g., `anti_ai_tone < 0.3`) before saving them as DRAFT. Currently the judge is only used for one refine retry.

**F5. Dynamic network fan-out**
- Refactor `buildGenerationGraph` to iterate `targetNetworks` dynamically instead of hardcoding X/Threads/Facebook nodes.

**F6. Add `outline` to `createInitialState` and use structured outlines more**
- `ContentTopic` has `outline` array, but `createInitialState` simply stores the whole topic. The research node uses `outline` but `hook`/`draft` nodes only use headings. If outlines have entity/section data, use them to improve factual grounding.

**F7. Improve `stripHashtags` for all Unicode scripts**
- Replace the regex with a broader `
**F8. Add a `generation` port / `IGenerationPort` for hexagonal compliance**
- Define a Symbol port for the generation service and inject it into `CronService`, `RecyclingService`, `Autonomy` etc. This would make `GenerationService` easier to mock in higher-level tests.

**F9. Add `run.sourceTopics` versioning / snapshotting**
- `resumeRun` re-fetches topics from `ContentSourceService` using `sourceTopics` as a list of topic titles. If a topic file has changed, the resumed content may differ. Store a snapshot of the topic in the `GenerationRun` row or checkpoint.

**F10. Add metrics and alert thresholds**
- Emit metrics: `generation_run_duration`, `topic_success_rate`, `judge_score_histogram`, `simhash_dedup_rate`, `llm_tokens_per_post`. Feed them into the analytics/health monitor.

**F11. Add parallel generation across languages**
- Currently one language per topic. For multi-language accounts, generate the same topic in multiple languages and create separate posts per language/network.

**F12. Reduce `GenerationService` size by splitting `repurpose`/`recycle` into separate services**
- `GenerationService` should focus on the core generation flow. `repurposeFromArticles` and `recycleTopPosts` are distinct features deserving their own classes.

**F13. Add an `ICheckpointSaver` port**
- Replace direct `RedisCheckpointSaver` dependency with a port, and test with `MemorySaver` in unit tests.

**F14. Add deterministic `thread_id` collision protection**
- `thread_id = ${runId}:${topic.topic}` could collide if two different runs have the same `topic.topic` value. Use a sanitized stable slug plus a run-specific salt.

**F15. Add a `generation_aborted` / `generation_partial` status**
- Distinguish a completed run with partial failures from fully successful runs.

## 8. Cross-references

- `modules/content-source` — topic ingestion.
- `modules/posts` — draft persistence and status transitions.
- `modules/accounts` — account lookup.
- `modules/queue` — post approval → worker queue.
- `modules/autonomy` — auto-approve and auto-check flow.
- `modules/recycling` — top-post recycling.
- `modules/trending` — trending enrichment.
- `modules/content-enhancements` — hook bank, visual concept, A/B variants, humanizer, slop lexicon, content styles, humor mechanics, pillar tracker, thread depth.
- `infrastructure/llm` — LLM provider fallback chain.
- `infrastructure/prompt` — Langfuse prompt management.
- `infrastructure/checkpoint` — Redis checkpoint saver.
- `infrastructure/sse` — real-time events.
- `infrastructure/langfuse` — tracing.
- `docs/audit/02-bug-report.md`, `docs/audit/07-code-review-findings.md` — prior audit findings.
- `docs/DEEP_ANALYSIS_LLM_GENERATION_2026-07-05.md` — prior deep analysis of LLM generation.

## 9. Overall assessment

- **Health**: 7/10. The core graph is well-structured, documented, and has good error isolation. The codebase has clearly been through several quality passes.
- **Biggest strengths**: per-network parallel fan-out, LLM-as-a-Judge, Langfuse tracing integration, checkpoint resume, SimHash dedup, multi-stage thread support.
- **Biggest risks**: `GenerationService` is a large god class with duplicated post-persistence logic; direct `process.env` reads; mixed responsibilities in `GenerationController`; multilingual gaps in repurpose/recycle; and no dedicated `ICheckpointSaver` port.
- **Recommended next actions** (in order):
  1. Extract `persistGeneratedPosts()` helper to remove duplication between `generate`, `resumeRun`, `resumeWithReview`.
  2. Move `/models`, `/provider-status`, `/reset-circuit-breakers` endpoints to a dedicated `llm` controller.
  3. Replace `process.env` reads in `GenerationService` with `ConfigService`.
  4. Add `language` rotation to `repurposeFromArticles` and `recycleTopPosts`/`recycleById`.
  5. Introduce `ICheckpointSaver` port and an in-memory test adapter.
