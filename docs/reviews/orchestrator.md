# Module: `modules/orchestrator`

## 1. What this module does

`modules/orchestrator` implements the LangGraph-based agent loop that replaces the legacy cron scheduling layer. It continuously observes the system, decides the next action, executes it, and sleeps adaptively. The module is feature-flagged behind `ORCHESTRATOR_ENABLED` and is intended to be the single heartbeat-driven controller for the Social Poster Agent.

**Main responsibilities:**
- `OrchestratorService` — lifecycle (start/stop/restart), graph loop, heartbeat, interruptible sleep, status/history.
- `orchestrator.graph.ts` — the `OBSERVE → DECIDE → EXECUTE → EVALUATE` `StateGraph` with `RedisCheckpointSaver` for crash-resume.
- `StateCollectorService` — OBSERVE node; collects `WorldState` from DB, Redis, and services in parallel.
- `DecisionEngineService` — DECIDE node; runs `HardRules → LLM/RuleFallback → Guardrails`.
- `HardRulesService` — deterministic H1-H10 safety checks plus `RECOVER_SESSION` cooldown.
- `LlmDecisionService` — LLM call, JSON parsing, timeout, and `orchestrator-system` prompt.
- `GuardrailsService` — G2-G8 validation/clamping of chosen actions.
- `ActionExecutorService` / `action-handlers.ts` — EXECUTE node; dispatches to one handler per action type.
- `PostingWindowService` — engagement-heatmap-driven posting-window recommendations.
- `OrchestratorHistoryService` — Redis-backed bounded cycle history.
- `WatchdogCron` — the only remaining `@Cron` decorator in the codebase; restarts the orchestrator if heartbeat is stale.
- `OrchestratorController` — REST API for status, history, pause/resume, restart, and checkpoint reset.
- `feature-flag.ts` / `ports.ts` — `isOrchestratorEnabled()` and DI tokens for engagement/replies feature-flagged services.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `orchestrator.module.ts` | NestJS module | `OrchestratorModule` — conditional on `ORCHESTRATOR_ENABLED` |
| `orchestrator.service.ts` | Lifecycle + graph loop | `start()`, `stop()`, `isRunning()`, `getStatus()`, `getHistory()`, `resetCheckpoint()` |
| `orchestrator.graph.ts` | LangGraph `StateGraph` | `buildOrchestratorGraph()`, `createInitialOrchestratorState()`, `OrchestratorState` annotation, `OrchestratorStateType` |
| `state-collector.service.ts` | OBSERVE node | `collectWorldState()` |
| `decision-engine.service.ts` | DECIDE node | `decide()`, `getActionsThisHour()`, `recordAction()` |
| `hard-rules.service.ts` | Phase 1 safety | `check()` |
| `llm-decision.service.ts` | Phase 2 LLM | `decide()`, `parseLlmResponse()` (private) |
| `guardrails.service.ts` | Phase 3 clamping | `apply()` |
| `action-executor.service.ts` | EXECUTE dispatcher | `execute()` |
| `action-handlers.ts` | Action handlers | `GenerateTopicsHandler`, `GeneratePostsHandler`, `PostHandler`, `BrowseHandler`, `RecoverSessionHandler`, `CheckRepliesHandler`, `RefreshTrendsHandler`, `HealthCheckHandler`, `ReconcileHandler`, `ScrapeMetricsHandler`, `RecycleContentHandler`, `AggregateHooksHandler` |
| `action-handler.interface.ts` | Strategy interface | `IActionHandler` |
| `posting-window.service.ts` | Smart windows | `getRecommendation()` |
| `orchestrator-history.service.ts` | Cycle history | `record()`, `getHistory()` |
| `orchestrator.controller.ts` | REST API | `GET /orchestrator/status`, `GET /orchestrator/history`, `POST /orchestrator/pause`, `POST /orchestrator/resume`, `POST /orchestrator/restart`, `POST /orchestrator/reset` |
| `watchdog.cron.ts` | Safety cron | `checkHeartbeat()` via `@Cron('*/5 * * * *')` |
| `feature-flag.ts` | Feature flag | `isOrchestratorEnabled()` |
| `ports.ts` | Hexagonal ports | `IBrowsingSessionPort`, `IRepliesMonitorPort` |
| `prompts/orchestrator-prompt.ts` | Inline prompt | `ORCHESTRATOR_SYSTEM_PROMPT`, `buildOrchestratorUserPrompt()` |
| `types.ts` | Domain types | `WorldState`, `Action`, `ActionResult`, `WAIT_ACTION`, `RECOVER_ACTION`, `OrchestratorState` |

## 3. How it works

### 3.1 `OrchestratorService` lifecycle

- `onModuleInit()` reads `ORCHESTRATOR_ENABLED` and calls `start()` if true (`orchestrator.service.ts:71-75`).
- `start()` builds the graph with `buildOrchestratorGraph(deps)`, optionally attaches `RedisCheckpointSaver`, and launches `runGraphLoop()` in the background (`orchestrator.service.ts:81-126`).
- `runGraphLoop()` uses `thread_id = 'orchestrator'`. It checks for an existing checkpoint; if `cycle > 1_000_000` it resets to avoid a known doubling path (`orchestrator.service.ts:182-224`).
- On the first iteration it passes the full `createInitialOrchestratorState()`; on later iterations it intentionally passes only `{ world: null, action: null, result: null }` so that the `cycle` reducer does not double the cycle counter (`orchestrator.service.ts:216-218`).
- `writeHeartbeat()` writes a Redis key with `PX` TTL (`orchestrator.service.ts:238-244`). `sleep()` uses an `AbortController` so `stop()` can interrupt it (`orchestrator.service.ts:248-272`).
- `onEngagementCheck()` calls `EngagementSchedulerService.checkStaleAndEnqueue(world)` fire-and-forget from the OBSERVE node (`orchestrator.service.ts:283-292`).
- `onCycleEnd()` records history and emits `OrchestratorEvents.CYCLE_END` (`orchestrator.service.ts:296-311`).
- `stop()` sets `stopRequested`, aborts the current sleep, and waits up to 10 s for `graphPromise` (`orchestrator.service.ts:128-157`).
- `resetCheckpoint()` deletes Redis keys matching `spa:checkpoint*` (`orchestrator.service.ts:167-178`).

### 3.2 `orchestrator.graph.ts` graph and state

- `OrchestratorState` is an `Annotation.Root` with explicit reducers (`orchestrator.graph.ts:22-60`):
  - `world`, `action`, `result` — replaced each write (`reducer: (_, next) => next`).
  - `cycle` — accumulated `prev + next` with default `0`.
  - `sleepMs` and `heartbeat` — replaced.
  - `errors` — `prev.concat(next).slice(-50)`.
- The graph has four nodes: `observe → decide → execute → evaluate` (`orchestrator.graph.ts:233-249`).
- `observeNode` collects `WorldState` and fires `onEngagementCheck(world)` in parallel (`orchestrator.graph.ts:85-100`).
- `decideNode` returns a `WAIT` action if `world` is missing, otherwise calls `DecisionEngineService.decide()` (`orchestrator.graph.ts:105-114`).
- `executeNode` writes a heartbeat before executing non-`WAIT` actions and catches handler errors (`orchestrator.graph.ts:120-144`).
- `evaluateNode` computes `sleepMs` via `calculateAdaptiveSleep()`, writes a heartbeat, calls `onCycleEnd()`, and sleeps unless stopped (`orchestrator.graph.ts:149-170`).
- `calculateAdaptiveSleep()` returns 15 s for `RECOVER_SESSION`, 60 s for `pauseAll`/`circuit open`, waits until midnight for exhausted daily limits, 10 min at night, 60 s for any non-`WAIT` action, and 120 s as the default `WAIT` sleep (`orchestrator.graph.ts:174-224`).

### 3.3 `StateCollectorService` (OBSERVE)

- `collectWorldState()` runs 11 collectors in `Promise.all`, each catching its own errors and returning `null` so that partial state is never lost (`state-collector.service.ts:42-101`).
- Per-network collectors are parallelized: `collectQueueDepth`, `collectSessions`, `collectRateLimits`, `collectEngagement`, `collectHealth` (ban/DLQ sub-loops), `collectPerformance` (`state-collector.service.ts:133-403`).
- `collectHealth()` builds `bans` by counting consecutive `FAILED` posts in a `BAN_DETECTION_WINDOW_HOURS` window and sums DLQ depth across posting queues (`state-collector.service.ts:336-403`).
- `collectEngagement()` reads last browsing session per network and counts `status: 'NEW'` incoming comments (`state-collector.service.ts:284-334`).
- `collectPerformance()` builds a 24-hour engagement histogram from `PostMetrics` with exponential decay (`state-collector.service.ts:232-282`).

### 3.4 `DecisionEngineService`

- `decide()` enriches `world` with `PostingWindowService` recommendations, then runs `HardRulesService.check()` (`decision-engine.service.ts:54-63`).
- If no hard rule matches, it calls `LlmDecisionService.decide()` when `ORCHESTRATOR_LLM_ENABLED` is true; otherwise it falls back to `rulesOnlyDecision()` (`decision-engine.service.ts:65-76`).
- `GuardrailsService.apply()` clamps the action (`decision-engine.service.ts:79-85`).
- `G6` (hourly action budget) is enforced outside guardrails via a Redis sorted set (`ACTION_HISTORY_KEY`) using `getActionsThisHour()` and `recordAction()` (`decision-engine.service.ts:87-103`, `193-222`).
- `rulesOnlyDecision()` prioritizes `GENERATE_TOPICS` → `POST` → `GENERATE_POSTS` → `CHECK_REPLIES` → `REFRESH_TRENDS` → `WAIT` (`decision-engine.service.ts:111-175`).

### 3.5 `HardRulesService`

- `check()` evaluates H1-H10 in priority order and returns the first match, or `null` to proceed to the LLM (`hard-rules.service.ts:28-126`).
- H1 `pauseAll` → `WAIT`.
- H2 `EXPIRED`/`ERROR` session → `RECOVER_SESSION` with a 5 min per-network cooldown (`RECOVER_COOLDOWN_MS` / `RECOVER_COOLDOWN_KEY`) (`hard-rules.service.ts:37-50`, `128-148`).
- H3 `BANNED` → `WAIT`.
- H4 all circuits open → `WAIT`.
- H5 all daily limits exhausted → `WAIT`.
- H6 all weekly limits exhausted → `WAIT`.
- H7 DLQ > 10 → `HEALTH_CHECK`.
- H8 stuck posting > 5 / H8b stuck browsing sessions > 0 → `RECONCILE`.
- H9 `bans > 0` → `WAIT`.
- H10 queue depth > 5 per network → `WAIT`.

### 3.6 `LlmDecisionService`

- `decide()` builds the user prompt, fetches `orchestrator-system` from `IPromptPort` (Langfuse Prompt Management with inline fallback), creates a Langfuse trace handler, and calls `ILlmPort.generateChat()` with `temperature: 0.3` and `maxTokens: 200` (`llm-decision.service.ts:45-76`).
- It races the LLM call against `ORCHESTRATOR_LLM_TIMEOUT_MS` (default 30 s, min 5 s) (`llm-decision.service.ts:38-43`, `83-87`).
- `parseLlmResponse()` extracts the first `{ ... }` with a greedy regex, `JSON.parse`s it, validates the action type, and picks the first valid `SocialNetwork` from pipe-separated candidates (`llm-decision.service.ts:89-130`).

### 3.7 `GuardrailsService`

- `apply()` validates the action returned by the LLM or rules fallback (`guardrails.service.ts:22-119`).
- G2 disabled network → `WAIT`.
- G3 `POST` with `dailyRemaining === 0` → `WAIT`.
- G4 `POST`/`BROWSE` with paused flow → `WAIT`; session not active → `RECOVER_SESSION`.
- G5 `POST` with queue depth > 5 → `WAIT`.
- G6 (hourly budget) is implemented in `DecisionEngineService`.
- G7 `isFlowPausedForAction()` checks `pauseGeneration`, `pausePosting`, `pauseEngagement`, `pauseReplies`.
- G8 if action is `WAIT`/`BROWSE` and approved drafts exist, override to `POST` for the ready network with the oldest `lastPostMs` (`guardrails.service.ts:74-110`).

### 3.8 `ActionExecutorService` and `action-handlers.ts`

- `ActionExecutorService` builds a `Map<string, IActionHandler>` in its constructor and `execute()` routes the action by `action.type` (`action-executor.service.ts:34-95`).
- Handlers are injectable classes: `GenerateTopicsHandler`, `GeneratePostsHandler`, `PostHandler`, `BrowseHandler`, `RecoverSessionHandler`, `CheckRepliesHandler`, `RefreshTrendsHandler`, `HealthCheckHandler`, `ReconcileHandler`, `ScrapeMetricsHandler`, `RecycleContentHandler`, `AggregateHooksHandler` (`action-handlers.ts:45-349`).
- Optional/feature-flagged services are resolved via `ModuleRef.resolveOptional()` or `@Inject(IBrowsingSessionPort)` / `@Inject(IRepliesMonitorPort)` (`action-handlers.ts:35-41`, `155-173`, `199-221`).
- `PostHandler` enqueues the oldest approved draft via `QueueService.enqueuePosting()` with a random delay between `AUTONOMOUS_POSTING_DELAY_MIN_MS` and `MAX_MS` (`action-handlers.ts:126-149`).
- `GeneratePostsHandler` calls `GenerationService.generate()` and, if `AUTO_APPROVE_ENABLED` is true, runs `AutoApproveService.evaluate()` over the generated drafts (`action-handlers.ts:76-113`).

### 3.9 `PostingWindowService`

- `getRecommendation()` returns `bestHours`, `inWindow` (within ±1 h of current UTC hour), and `confidence` (`posting-window.service.ts:58-94`).
- It builds a 24-hour heatmap from `PostMetrics` over `POSTING_WINDOW_DECAY_DAYS` using exponential decay, caches it in Redis for `CACHE_TTL_SEC` (1 h), and falls back to `POSTING_WINDOW_FALLBACK_HOURS` when sample count < `POSTING_WINDOW_MIN_SAMPLES` (`posting-window.service.ts:99-175`).
- `POSTING_WINDOW_BYPASS=true` forces `inWindow=true` (`posting-window.service.ts:48-51`).

### 3.10 `OrchestratorHistoryService`

- `record()` pushes a JSON entry to `ORCHESTRATOR_HISTORY_KEY` and trims to `HISTORY_MAX` (200) with `lpush`/`ltrim` (`orchestrator-history.service.ts:28-43`).
- `getHistory()` reads the list and parses it (`orchestrator-history.service.ts:45-53`).

### 3.11 `watchdog.cron.ts`

- `@Cron('*/5 * * * *')` runs `checkHeartbeat()` (`watchdog.cron.ts:50`).
- If the orchestrator heartbeat is missing or older than `ORCHESTRATOR_HEARTBEAT_TTL_MS`, it calls `orchestratorService.stop()` → 5 s sleep → `start()` and sends a Discord warning (`watchdog.cron.ts:72-98`).
- The watchdog is gated by `ORCHESTRATOR_ENABLED` in `checkHeartbeat()` itself (`watchdog.cron.ts:51`).

### 3.12 `OrchestratorController`

- `GET /orchestrator/status` returns `enabled`, `running`, `cycle`, `heartbeat`, `heartbeatAgeMs` (`orchestrator.controller.ts:26-29`).
- `GET /orchestrator/history?limit=` returns cycle history (`orchestrator.controller.ts:31-36`).
- `POST /orchestrator/pause` and `POST /orchestrator/resume` call `FlowControlService` (`orchestrator.controller.ts:38-50`).
- `POST /orchestrator/restart` stops, waits 3 s, then starts (`orchestrator.controller.ts:52-59`).
- `POST /orchestrator/reset` calls `resetCheckpoint()` (`orchestrator.controller.ts:61-66`).

### 3.13 `feature-flag.ts` and `ports.ts`

- `isOrchestratorEnabled()` reads `ORCHESTRATOR_ENABLED` via `parseBool()` so cron modules can skip registration at module-init time (`feature-flag.ts:17-19`).
- `ports.ts` defines `IBrowsingSessionPort` and `IRepliesMonitorPort` tokens so the orchestrator can inject engagement/replies services without importing their concrete modules when feature flags are off (`ports.ts:14-36`).

## 4. Dependencies

**Downstream (called by the orchestrator):**
- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/redis` — `SHARED_REDIS` for heartbeat, history, action-rate sorted set.
- `infrastructure/llm` — `ILlmPort` via `LlmService`, `IPromptPort` via `PromptRegistry`.
- `infrastructure/checkpoint` — `RedisCheckpointSaver`.
- `infrastructure/notifications` — `DiscordNotificationService` for watchdog alerts.
- `modules/queue` — `QueueService` / `QueueFactory`.
- `modules/rate-limit` — `RateLimitService`.
- `modules/flow-control` — `FlowControlService`.
- `modules/engagement` — `EngagementSchedulerService` (optional), `BrowsingSessionService` via `IBrowsingSessionPort`.
- `modules/replies` — `RepliesMonitorService` via `IRepliesMonitorPort`.
- `modules/sessions` — `SessionsService`.
- `modules/generation` — `GenerationService`.
- `modules/health-monitor` — `HealthMonitorService`.
- `modules/trending` — `TrendingScraperService`.
- `modules/analytics` — `MetricsScraperService`.
- `modules/recycling` — `RecyclingService`.
- `modules/content-enhancements` — `HookPerformanceBank`.
- `modules/autonomy` — `AutoApproveService` (optional).
- `modules/events` — `EventEmitter2` via `OrchestratorEvents`.

**Upstream (callers of orchestrator):**
- `app.module.ts` — conditionally imports `OrchestratorModule` when `ORCHESTRATOR_ENABLED=true`.
- `modules/engagement` — `EngagementSchedulerService.checkStaleAndEnqueue()` is called by `OrchestratorService.onEngagementCheck()`.
- `modules/engagement` / `modules/replies` — bind `IBrowsingSessionPort` / `IRepliesMonitorPort` tokens.
- UI — `OrchestratorController` REST API.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `ORCHESTRATOR_ENABLED` | `false` | `feature-flag.ts:17`, `orchestrator.service.ts:66`, `watchdog.cron.ts:37`, `app.module.ts:73` | Master feature flag for the orchestrator module |
| `ORCHESTRATOR_LLM_ENABLED` | `true` | `decision-engine.service.ts:46` | Enable LLM decision path (vs. rules-only fallback) |
| `ORCHESTRATOR_MAX_ACTIONS_PER_HOUR` | `60` | `decision-engine.service.ts:47` | Soft cap for non-`WAIT` actions per hour (G6) |
| `ORCHESTRATOR_LLM_TIMEOUT_MS` | `30000` | `llm-decision.service.ts:39-42` | LLM decision timeout |
| `ORCHESTRATOR_HEARTBEAT_KEY` | `spa:orchestrator:heartbeat` | `orchestrator.service.ts:67`, `watchdog.cron.ts:35` | Redis key for heartbeat timestamp |
| `ORCHESTRATOR_HEARTBEAT_TTL_MS` | `600000` (10 min) | `orchestrator.service.ts:68`, `watchdog.cron.ts:36` | Heartbeat TTL / watchdog staleness threshold |
| `ORCHESTRATOR_HISTORY_KEY` | `spa:orchestrator:history` | `orchestrator-history.service.ts:25` | Redis list key for cycle history |
| `ORCHESTRATOR_CHECKPOINT_KEY` | `spa:orchestrator:checkpoint` | `env.validation.ts:135` | **Defined but unused** — reset logic hardcodes `spa:checkpoint` |
| `CHECKPOINT_PREFIX` | `spa:checkpoint` | `redis-checkpoint.ts:49` | Redis prefix for all LangGraph checkpoints |
| `CHECKPOINT_TTL_SECONDS` | `604800` (7 days) | `redis-checkpoint.ts:48` | Checkpoint Redis TTL |
| `BAN_DETECTION_WINDOW_HOURS` | `2` | `state-collector.service.ts:359` | Time window for consecutive-fail ban detection |
| `F1_BROWSING_SESSION_MINUTES` | `15` | `state-collector.service.ts:339`, `engagement-scheduler.service.ts:258`, `action-handlers.ts:169` | Browsing session duration / stuck threshold |
| `POSTING_WINDOW_MIN_SAMPLES` | `10` | `posting-window.service.ts:43` | Min metrics samples before heatmap confidence |
| `POSTING_WINDOW_TOP_HOURS` | `3` | `posting-window.service.ts:44` | Number of best hours to return |
| `POSTING_WINDOW_DECAY_DAYS` | `30` | `posting-window.service.ts:45` | Heatmap exponential-decay window |
| `POSTING_WINDOW_FALLBACK_HOURS` | `9,12,18,21` | `posting-window.service.ts:46` | Cold-start posting hours |
| `POSTING_WINDOW_BYPASS` | `false` | `posting-window.service.ts:48` | Force `inWindow=true` |
| `TOPIC_POOL_MIN` | `30` | `state-collector.service.ts:35` | Threshold for `GENERATE_TOPICS` |
| `TOPIC_BATCH_SIZE` | `20` | `action-handlers.ts:58` | Batch size for topic generation |
| `AUTONOMOUS_POSTS_PER_RUN` | `3` | `action-handlers.ts:80` | Posts to generate per `GENERATE_POSTS` |
| `AUTONOMOUS_TARGET_NETWORKS` | `X,THREADS` | `action-handlers.ts:83` | Fallback target networks for `GENERATE_POSTS` |
| `AUTONOMOUS_POSTING_DELAY_MIN_MS` | `600000` | `action-handlers.ts:141` | Min enqueue delay for `POST` action |
| `AUTONOMOUS_POSTING_DELAY_MAX_MS` | `3600000` | `action-handlers.ts:142` | Max enqueue delay for `POST` action |
| `AUTO_APPROVE_ENABLED` | `false` | `action-handlers.ts:88` | Auto-approve generated drafts in `GeneratePostsHandler` |
| `ENGAGEMENT_ENABLED` | `false` | `orchestrator.module.ts:57`, `engagement-scheduler.service.ts:44` | Load `EngagementModule` and enable stale-session checks |
| `REPLIES_ENABLED` | `false` | `replies/replies.module.ts` | Bind `IRepliesMonitorPort` |
| `ENABLED_NETWORKS` | `X,THREADS` | `enabled-networks.ts:16` | Networks used by collectors, guardrails, and rules |
| `PROMPT_VERSION` | `latest` | `prompt-registry.ts:42` | Active prompt version label (returned by `getCurrentVersion()`) |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `calculateAdaptiveSleep` ignores `action.params.sleepMs` and hard-codes `WAIT` to 120 s.**
`HardRulesService` and `GuardrailsService` produce `WAIT` actions with explicit `params.sleepMs` values (e.g., `H3` banned = 5 min, `H5` all daily exhausted = 5 min, `H6` weekly exhausted = 10 min, `H9` bans = 5 min, `G3` rate-limit exhausted = 5 min, `G7` flow paused = 1 min). However, `evaluateNode` calls `calculateAdaptiveSleep(action, world)` and `calculateAdaptiveSleep` returns `120_000` for every `WAIT` unless it happens to hit the `pauseAll`/`circuit`/`rate-limit` branches (`orchestrator.graph.ts:174-224`). The `WAIT` payload's `sleepMs` is never read. This silently overrides the intentional cooldowns from hard rules and guardrails.

**B2. `calculateAdaptiveSleep` rate-limit and circuit-breaker checks are per-network, not per-action.**
The `dailyRemaining === 0` loop and `circuitBreaker === 'open'` loop iterate over *all* enabled networks and return early if any match (`orchestrator.graph.ts:181-198`). If `X` is rate-limited and `Threads` has approved drafts, the chosen `POST` action for `Threads` is forced to wait until midnight (max 1 h). It should only consider `action.network` and `action.type` (e.g., `POST`/`BROWSE`) in these branches.

**B3. `OrchestratorService.resetCheckpoint()` uses a broad `KEYS` pattern and deletes all checkpoints.**
`resetCheckpoint()` runs `this.redis.keys('${CHECKPOINT_KEY_PREFIX}*')` and `del`s all matches (`orchestrator.service.ts:167-178`). The `CHECKPOINT_KEY_PREFIX` constant is `'spa:checkpoint'`, which is also the prefix used by the generation graph. Resetting the orchestrator will therefore wipe generation checkpoints, breaking resume for every other LangGraph thread. It should `SCAN` for `${CHECKPOINT_PREFIX}:orchestrator*` only (or use the unused `ORCHESTRATOR_CHECKPOINT_KEY` env var).

**B4. `stop()` / `start()` can leave two `runGraphLoop()` instances running.**
`stop()` waits only 10 s for `graphPromise`, then sets `graphPromise = null` and `running = false` (`orchestrator.service.ts:144-152`). If `runGraphLoop()` is blocked inside `compiledGraph.invoke()` (e.g., a long DB call or a 15-minute `BROWSE`), the old loop continues. `start()` then sets `stopRequested = false` and creates a new `graphPromise` (`orchestrator.service.ts:93-95`, `120-121`). When the old `invoke()` eventually returns, its `while (!this.stopRequested)` check sees `false` and it continues executing, potentially causing two graph loops to race on the same `thread_id` and `RedisCheckpointSaver`.

**B5. `LlmDecisionService` timeout does not cancel the underlying LLM call.**
`decide()` uses `Promise.race([this.llm.generateChat(...), this.timeout()])` (`llm-decision.service.ts:69-76`). When the timeout wins, the `generateChat()` promise is left dangling. It can still complete, cache the response in `LlmService` (`llm.service.ts:789-792`), consume tokens, and finalize a Langfuse trace. The timeout should either use an `AbortController` that aborts the request, or the LLM service should expose a cancellable signal.

**B6. `parseLlmResponse` JSON extraction is fragile and not schema-validated.**
`text.match(/\{[\s\S]*\}/)` greedily matches from the first `{` to the last `}` in the entire response, including any surrounding explanation or extra JSON objects (`llm-decision.service.ts:90`). It then runs `JSON.parse` and casts fields without validation. It does not strip markdown code fences, validate `reason`, or populate `params`. There is no Zod/schema guard; a malformed LLM response produces a generic fallback to `rulesOnlyDecision`.

**B7. `executeNode` heartbeat before `BROWSE` does not prevent a watchdog restart mid-session.**
`executeNode` writes a heartbeat immediately before calling `ActionExecutorService.execute()` for long actions like `BROWSE` (`orchestrator.graph.ts:129-131`). Because the heartbeat TTL is 10 min and a browsing session can run 15 min, the heartbeat will go stale during the session and the watchdog will attempt a restart (`watchdog.cron.ts:50-62`). `executeNode` should either periodically refresh the heartbeat during a long action or split the action into shorter, heartbeating steps.

**B8. `buildOrchestratorUserPrompt` hard-codes `X` and `THREADS` and ignores `FACEBOOK`.**
The prompt lines for approved drafts and queue depth only print `X` and `THREADS` (`prompts/orchestrator-prompt.ts:64-66`). If `FACEBOOK` is enabled, the LLM is not told its queue depth or approved count, and the prompt's own rules tell it to choose for `X|THREADS|FACEBOOK`. The prompt should iterate over `getEnabledNetworks()` instead.

**B9. `buildOrchestratorUserPrompt` uses `Date.now()` instead of `world.now` for age calculations.**
`lastPost`, `lastBrowse`, and `trends` age are computed with `Date.now()` (`prompts/orchestrator-prompt.ts:87`, `108`, `119`). If `WorldState` is stale (e.g., `collectWorldState()` took a while or the checkpoint is reused), the LLM receives stale offsets.

**B10. `GuardrailsService` does not enforce `inPostingWindow` for an LLM-chosen `POST` action.**
`G8` only overrides `WAIT`/`BROWSE` to `POST` when a ready network exists (`guardrails.service.ts:74-110`). It does *not* reject a `POST` action chosen by the LLM for a network whose `inPostingWindow` is `false`. The LLM prompt instructs it to prefer posting in-window, but guardrails should clamp it.

**B11. `OrchestratorHistoryService` cycle number is off-by-one relative to `getStatus()`.**
`evaluateNode` reads `state.cycle` (the value *before* this cycle's increment) and passes it to `onCycleEnd()` (`orchestrator.graph.ts:160`, `orchestrator.service.ts:296-311`). `OrchestratorHistoryService.record()` uses that value, while `OrchestratorService` updates `currentCycle` from `resultState.cycle` (the value *after* the increment) (`orchestrator.service.ts:225-226`). History will show `cycle-1` for the same entry.

**B12. `ORCHESTRATOR_CHECKPOINT_KEY` is declared but unused, and `resetCheckpoint()` hardcodes the prefix.**
`env.validation.ts:135` defines `ORCHESTRATOR_CHECKPOINT_KEY` default `spa:orchestrator:checkpoint`, but `OrchestratorService` uses `const CHECKPOINT_KEY_PREFIX = 'spa:checkpoint'` (`orchestrator.service.ts:37`) and never reads the env var. If `CHECKPOINT_PREFIX` is overridden, the reset key pattern will be wrong.

### 6.2 Performance

**P1. `StateCollector.collectPerformance()` is sequential per network.**
`collectPerformance()` loops over `networks` with a `for...of` and does one `prisma.postMetrics.findMany()` per iteration (`state-collector.service.ts:232-281`). It could be parallelized with `Promise.all` like `collectSessions` and `collectRateLimits`.

**P2. `resetCheckpoint()` uses `KEYS` instead of `SCAN`.**
`orchestrator.service.ts:170` calls `this.redis.keys(...)`. This is an O(N) blocking command and is inconsistent with `RedisCheckpointSaver.scanKeys()` (`redis-checkpoint.ts:74-83`).

**P3. `calculateAdaptiveSleep()` recomputes network loops every cycle and does not respect `action.network`.**
The `pauseAll`/`circuit`/`rate-limit` loops iterate over all networks each `EVALUATE` node run (`orchestrator.graph.ts:174-198`). This is cheap, but the early returns are also the cause of the correctness bug in B2.

**P4. `LlmDecisionService` leaves a dangling LLM promise on timeout.**
As noted in B5, the abandoned promise continues to consume resources and may cache a response that is never used.

### 6.3 Architecture / anti-patterns

**A1. `WAIT` action `sleepMs` is dead metadata.**
`WAIT_ACTION()` and `RECOVER_ACTION()` are typed with `params: { sleepMs }` and `source: 'hard_rule'` (`types.ts:189-205`), but `calculateAdaptiveSleep()` never reads `action.params`. The architecture should either remove `sleepMs` from `WAIT` or have `evaluateNode`/`calculateAdaptiveSleep` honor it. The `RECOVER_ACTION` helper also hard-codes `source: 'hard_rule'`, which is misleading when `GuardrailsService` uses it.

**A2. `OrchestratorService.start()` swallows failures because `onModuleInit()` uses `void this.start()`.**
`orchestrator.service.ts:73` calls `void this.start()`. If `start()` throws before `graphPromise` is set, `running` may be left as `true` and `getStatus()` will misreport. The watchdog may restart, but the startup error is not propagated.

**A3. `stop()` does not truly cancel the graph.**
`runGraphLoop()` has no `AbortController` or early exit inside `invoke()`; it only checks `stopRequested` at the top of the `while` loop (`orchestrator.service.ts:209`). A long-running `observe`/`execute` cannot be interrupted, leading to the dual-loop risk in B4 and the watchdog mid-action risk in B7.

**A4. `action-handlers.ts` reads `process.env` directly and casts without validation.**
`GenerateTopicsHandler` (`action-handlers.ts:58`), `GeneratePostsHandler` (`action-handlers.ts:80-83`, `88`), `PostHandler` (`action-handlers.ts:141-143`), and `BrowseHandler` (`action-handlers.ts:169`) all use `process.env.*` with `Number()` and cast to `SocialNetwork[]`. Malformed env values produce `NaN` or invalid network arrays. These should go through `ConfigService` (or at least `getEnabledNetworks()`) and validate.

**A5. `DecisionEngineService` reads `process.env` directly in its constructor.**
`decision-engine.service.ts:46-47` reads `ORCHESTRATOR_LLM_ENABLED` and `ORCHESTRATOR_MAX_ACTIONS_PER_HOUR` from `process.env` instead of `ConfigService`. While `AGENTS.md` blesses direct reads in `feature-flag.ts` and `enabled-networks.ts`, this is a service constructor and should be consistent with the rest of the module.

**A6. `WatchdogCron` uses a hardcoded `*/5 * * * *` cron expression.**
`watchdog.cron.ts:50` has the only remaining `@Cron` decorator in the codebase. The schedule should be configurable (`ORCHESTRATOR_WATCHDOG_CRON` or `ORCHESTRATOR_WATCHDOG_INTERVAL_MS`). The staleness threshold is already configurable via `ORCHESTRATOR_HEARTBEAT_TTL_MS`, so the cron should be too.

**A7. `IActionHandler.actionType` is typed as `string` instead of `ActionType`.**
`action-handler.interface.ts:15` declares `readonly actionType: string`. `ActionExecutorService` then builds `Map<string, IActionHandler>` (`action-executor.service.ts:52`). Tightening the type to `ActionType` would catch missing handlers at compile time.

**A8. `orchestrator.controller.ts` `restart()` uses an inline `setTimeout` instead of a service method.**
`orchestrator.controller.ts:56` sleeps 3 s between `stop()` and `start()`. This logic belongs in `OrchestratorService.restart()` so callers and tests can use it consistently.

**A9. `types.ts` `OrchestratorState` interface is unused and wrong.**
`types.ts:177-185` defines `OrchestratorState` with `world: WorldState` (not nullable) and `action: Action`/`result: ActionResult` (non-nullable). The graph uses the generated `OrchestratorStateType` from `orchestrator.graph.ts`, and `createInitialOrchestratorState()` returns `null` for those fields. This interface is dead code and misleading.

### 6.4 TypeScript / type safety

**T1. `IActionHandler.execute()` has inconsistent signatures.**
`action-handler.interface.ts:18` declares `execute(action: Action)`, but `GenerateTopicsHandler` (`action-handlers.ts:55`) and `CheckRepliesHandler` (`action-handlers.ts:207`) define `execute()` with no parameter. TypeScript allows fewer parameters, but it is a maintenance trap; the implementations should accept `action` and use `_action` if unused.

**T2. `GeneratePostsHandler` casts `process.env.AUTONOMOUS_TARGET_NETWORKS` to `SocialNetwork[]`.**
`action-handlers.ts:83` does `(process.env.AUTONOMOUS_TARGET_NETWORKS ?? 'X,THREADS').split(',').map(... ) as SocialNetwork[]` without filtering `SocialNetwork` values. This can pass invalid networks to `GenerationService.generate()`.

**T3. `parseLlmResponse` relies on `as` casts for `ActionType` and `NetworkActionType`.**
`llm-decision.service.ts:96`, `118`, `125` cast `String(...)` results to union types. While the code validates `VALID_ACTIONS.includes`, the `GenericAction` branch casts `networkRaw as SocialNetwork | undefined` without the same pipe-split validation used for network actions.

**T4. `OrchestratorService` `AnyCompiledGraph` and `result as OrchestratorStateType` casts.**
`orchestrator.service.ts:29` and `225` use `as` casts to bridge `CompiledStateGraph` to the runtime return value. Since the graph is strictly typed, the generic `any` cast is unnecessary and weakens the graph contract.

### 6.5 Security / reliability

**S1. `resetCheckpoint()` deletes all LangGraph checkpoints.**
See B3. A manual reset via `POST /orchestrator/reset` can wipe generation checkpoints for in-progress human-review flows.

**S2. Watchdog restart can race with a running graph loop.**
`watchdog.cron.ts:77-81` and `orchestrator.controller.ts:55-57` call `stop()` then `start()` without ensuring the old `runGraphLoop()` has exited. This can spawn duplicate loops and double actions.

**S3. LLM timeout does not cancel in-flight requests.**
See B5. Dangling promises can consume API budget, cache invalid responses, and leave Langfuse traces half-open.

**S4. `executeNode` heartbeat before `BROWSE` does not cover the full action duration.**
See B7. A 15-minute browsing session will exceed the 10-minute heartbeat TTL and trigger a watchdog restart.

**S5. `resetCheckpoint()` can be called while the orchestrator is running.**
`orchestrator.controller.ts:61-66` allows resetting the checkpoint without stopping. The running `runGraphLoop()` may pass the partial `world/action/result` nulls into an inconsistent state, or the reset may delete keys while an `invoke()` is in progress.

**S6. `DecisionEngine` hourly rate tracker is not atomic.**
`getActionsThisHour()` does `zremrangebyscore` then `zcount` (`decision-engine.service.ts:199-208`), and `recordAction()` is `void`/`await`-less (`decision-engine.service.ts:102-103`). In a single-threaded Node process this is usually fine, but `recordAction` may not be persisted before the next cycle `getActionsThisHour()` if the event loop is busy.

**S7. `calculateAdaptiveSleep()` may keep the loop awake too long or wake it too soon.**
The per-network rate-limit branch can sleep 1 h even when other actions are available (B2), and the ignored `WAIT` `sleepMs` means hard-rule cooldowns are not respected (B1).

## 7. New feature / improvement ideas

1. **Honor `WAIT` sleepMs and action-aware rate checks.** Have `calculateAdaptiveSleep()` read `action.params?.sleepMs` for `WAIT` and restrict `dailyRemaining`/`circuitBreaker` checks to `action.network` when the action is network-scoped.
2. **Make `resetCheckpoint()` safe and configurable.** Use `SCAN` and target only the `orchestrator` thread; respect `ORCHESTRATOR_CHECKPOINT_KEY` or `CHECKPOINT_PREFIX` env vars.
3. **Cancellable LLM calls.** Pass an `AbortController`/`AbortSignal` through `ILlmPort.generateChat()` so `LlmDecisionService` can truly cancel on timeout.
4. **Schema-validate LLM output.** Replace the greedy regex with a Zod parser for `{ action, network, reason }` and provide a clearer error/fallback path.
5. **Refresh heartbeat during long actions.** For `BROWSE`, `GENERATE_POSTS`, or any action expected to exceed 10 min, spawn a periodic heartbeat writer or use `setInterval` in `executeNode`.
6. **Make watchdog cron configurable.** Move `*/5 * * * *` to `ORCHESTRATOR_WATCHDOG_CRON` and consider disabling the cron registration entirely when `ORCHESTRATOR_ENABLED=false`.
7. **Tighten env handling in handlers.** Move `TOPIC_BATCH_SIZE`, `AUTONOMOUS_*`, `F1_BROWSING_SESSION_MINUTES`, etc. to `ConfigService` with `Joi` validation and use `getEnabledNetworks()` for network lists.
8. **Type clean-up.** Remove unused `OrchestratorState` interface, change `IActionHandler.actionType` to `ActionType`, and align `GenerateTopicsHandler`/`CheckRepliesHandler` `execute` signatures.
9. **Langfuse handler flush.** Ensure `LlmDecisionService` flushes or closes the per-call `CallbackHandler` after the decision (or move to `withLlmCallbacks` wrapper like `GenerationService`).
10. **Prompt parametrization by enabled networks.** Make `buildOrchestratorUserPrompt()` iterate over `getEnabledNetworks()` and use `world.now` for all age calculations.

## 8. Cross-references

- `modules/engagement` — `BrowsingSessionService` binds `IBrowsingSessionPort`; `EngagementSchedulerService.checkStaleAndEnqueue()` is triggered by `OrchestratorService.onEngagementCheck()`.
- `modules/replies` — `RepliesMonitorService` binds `IRepliesMonitorPort`.
- `modules/queue` — `QueueService`/`QueueFactory` are used by `PostHandler` and `StateCollector.collectQueueDepth()`.
- `modules/flow-control` — `FlowControlService` is used by `OrchestratorController` and `StateCollector.collectFlowControl()`.
- `modules/sessions` — `SessionsService.getOrCreateSession()` is used by `RecoverSessionHandler`.
- `modules/generation` — `GenerationService.generate()` is used by `GeneratePostsHandler`.
- `modules/health-monitor` — `HealthMonitorService.runHealthCheck()` / `runReconciliation()` are used by `HealthCheckHandler` and `ReconcileHandler`.
- `modules/trending` — `TrendingScraperService.getGoogleTrends()` / `getXTrends()` are used by `RefreshTrendsHandler`.
- `modules/analytics` — `MetricsScraperService.collectMetrics()` is used by `ScrapeMetricsHandler`.
- `modules/recycling` — `RecyclingService.runRecycling()` is used by `RecycleContentHandler`.
- `modules/content-enhancements` — `HookPerformanceBank.aggregateStats()` is used by `AggregateHooksHandler`.
- `modules/autonomy` — `AutoApproveService.evaluate()` is used by `GeneratePostsHandler`.
- `infrastructure/llm` — `LlmService` implements `ILlmPort`; `PromptRegistry` implements `IPromptPort`.
- `infrastructure/checkpoint` — `RedisCheckpointSaver` is used as the graph checkpointer.
- `infrastructure/notifications` — `DiscordNotificationService` is used by `WatchdogCron`.
- `events` — `OrchestratorEvents.CYCLE_END` is emitted by `OrchestratorService.onCycleEnd()` and bridged to SSE by `SseEventListener`.
- `feature-flag.ts` — `isOrchestratorEnabled()` is used by `engagement-scheduler.service.ts` and the legacy cron modules to skip registration.

## 9. Overall assessment

**Health score: 6 / 10**

The orchestrator module is a clean, well-structured refactor of a cron-based system into a LangGraph loop. The separation into `OBSERVE → DECIDE → EXECUTE → EVALUATE`, the hexagonal port bindings for engagement/replies, the `RedisCheckpointSaver` integration, and the `StateCollector` error-isolation are all solid. However, the module has several correctness issues that are likely to cause real operational problems: the `WAIT`/`sleepMs` mismatch, `calculateAdaptiveSleep` over-scoping network state, the `resetCheckpoint()` broad deletion, the `stop()`/`start()` race window, and the non-cancellable LLM timeout. The watchdog heartbeat also does not cover 15-minute browsing sessions.

**Top recommended next actions:**

1. Fix `calculateAdaptiveSleep()` to honor `action.params.sleepMs` and to scope rate-limit/circuit checks to `action.network`.
2. Scope `OrchestratorService.resetCheckpoint()` to the orchestrator thread and use `SCAN` instead of `KEYS`.
3. Make `OrchestratorService.stop()`/`start()` lifecycle-safe: wait for the old `runGraphLoop()` to truly exit before starting a new one, or add a guard that prevents concurrent `invoke()` calls on the same thread.
4. Add abort/cancellation support to `LlmDecisionService` and `ILlmPort.generateChat()` so timeouts are real.
5. Add periodic heartbeat refresh for long-running actions (`BROWSE`, `GENERATE_POSTS`) or reduce the default browsing session to below the heartbeat TTL.
6. Tighten `action-handlers.ts` env handling: use `ConfigService`, validate `Number` results, and use `getEnabledNetworks()` for network lists.
7. Make `WatchdogCron` cron expression configurable and avoid registering it when `ORCHESTRATOR_ENABLED=false`.
