# Tasks: LangGraph Orchestrator

> **FROZEN LEGACY BREAKDOWN.** The unchecked boxes below predate the current runtime
> and are not canonical status. Reconcile them through `ORCH-101` in
> [`docs/planning/BACKLOG.md`](../../docs/planning/BACKLOG.md); new work uses stable
> canonical task IDs.

> All tasks reference MASTER-PLAN.md work streams (WS-1 through WS-8)
> V-Model tasks are tagged [V] and have corresponding spec files

---

## Phase 1: Foundation (WS-6 + WS-1)

### Task 1.1: Add ORCHESTRATOR_ENABLED env var
- [ ] Add `ORCHESTRATOR_ENABLED` to `env.validation.ts` (default: 'false')
- [ ] Add to `.env.example` with comment
- [ ] Add `ORCHESTRATOR_LLM_ENABLED` (default: 'true')
- [ ] Add `ORCHESTRATOR_MAX_ACTIONS_PER_HOUR` (default: 15)
- [ ] Add `ORCHESTRATOR_HEARTBEAT_TTL_MS` (default: 600000)
- [ ] Add `ORCHESTRATOR_CHECKPOINT_KEY` (default: 'spa:orchestrator:checkpoint')
- [ ] Add `ORCHESTRATOR_HEARTBEAT_KEY` (default: 'spa:orchestrator:heartbeat')

### Task 1.2: Create orchestrator module structure
- [ ] Create `src/modules/orchestrator/orchestrator.module.ts`
- [ ] Create `src/modules/orchestrator/types.ts` (WorldState, Action, ActionResult types)
- [ ] Add OrchestratorModule to AppModule imports (conditional on ORCHESTRATOR_ENABLED)
- [ ] Verify app boots with module loaded (no errors)

### Task 1.3: [V] Implement StateCollector — DB queries
- [ ] Create `src/modules/orchestrator/state-collector.service.ts`
- [ ] Implement `collectTopicPool()` — prisma.topic.count + findFirst
- [ ] Implement `collectDraftCounts()` — prisma.post.count by status
- [ ] Implement `collectSessions()` — prisma.session.findFirst per network
- [ ] Implement `collectPerformanceMetrics()` — prisma.postMetrics.findMany
- [ ] Implement `collectEngagementStatus()` — prisma.browsingSession + incomingComment
- [ ] Implement `collectHealthStatus()` — prisma.post.count (FAILED, stuck POSTING)
- [ ] All queries use `getEnabledNetworks()` to filter

### Task 1.4: [V] Implement StateCollector — Redis + service reads
- [ ] Implement `collectQueueDepth()` — QueueFactory.getJobCounts per network
- [ ] Implement `collectCircuitBreakers()` — CircuitBreakerRegistry.getStates()
- [ ] Implement `collectRateLimits()` — RateLimitService.getStatus per network
- [ ] Implement `collectFlowControl()` — FlowControlService.getStatus()
- [ ] Implement `collectTrendsAge()` — TrendingScraperService cache inspection

### Task 1.5: [V] Implement StateCollector — timing + posting windows
- [ ] Implement `collectTiming()` — UTC hour, day of week, current Date
- [ ] Implement `collectPostingWindows()` — call PostingWindowService (stub for now)
- [ ] Implement `collectInPostingWindow()` — check if current hour in recommended hours

### Task 1.6: [V] Implement StateCollector — orchestration
- [ ] Implement `collectWorldState()` — calls all collectors in parallel
- [ ] Implement error handling — partial failures don't abort
- [ ] Implement degraded fields tracking
- [ ] Add `_collectedAt` timestamp
- [ ] Log collection time + degraded fields

### Task 1.7: [V] Unit tests for StateCollector (V9)
- [ ] Test each collector method with mocked Prisma
- [ ] Test each collector method with mocked Redis/services
- [ ] Test partial failure — one source fails, others succeed
- [ ] Test all sources fail — returns WorldState with all defaults
- [ ] Test enabled networks filter works
- [ ] Test timestamp is set

### Task 1.8: [V] Integration tests for StateCollector (V7)
- [ ] Test with real Prisma (test DB) — verify counts match
- [ ] Test with real Redis — verify rate limits match
- [ ] Test with real FlowControlService — verify flags match
- [ ] Test collection time < 500ms

### Task 1.9: Watchdog cron skeleton
- [ ] Create `src/modules/orchestrator/watchdog.cron.ts`
- [ ] Implement `@Cron('*/5 * * * *')` — check heartbeat
- [ ] Read `ORCHESTRATOR_HEARTBEAT_KEY` from Redis
- [ ] If key missing or TTL expired → log warning (restart logic in Phase 5)
- [ ] Unit test: heartbeat fresh → no action
- [ ] Unit test: heartbeat stale → log warning

---

## Phase 2: Brain (WS-2 + WS-4)

### Task 2.1: [V] Implement hard rules (safety checks)
- [ ] Create `src/modules/orchestrator/decision-engine.service.ts`
- [ ] Implement `checkHardRules(world): Action | null`
- [ ] H1: pauseAll → WAIT(60s)
- [ ] H2: session EXPIRED → RECOVER_SESSION
- [ ] H3: session BANNED → WAIT(300s)
- [ ] H4: circuit OPEN → WAIT(60s)
- [ ] Implement priority ordering — first match wins
- [ ] Return null if no hard rule matches

### Task 2.2: [V] Implement hard rules (continued)
- [ ] H5: dailyRemaining === 0 → WAIT(until reset)
- [ ] H6: weeklyRemaining === 0 → WAIT(until reset)
- [ ] H7: DLQ > 10 → HEALTH_CHECK
- [ ] H8: stuckPosting > 5 → RECONCILE
- [ ] H9: bans > 0 → WAIT(300s)
- [ ] H10: queueDepth > 5 → WAIT(60s)

### Task 2.3: [V] Implement rules-only fallback
- [ ] Implement `rulesOnlyDecision(world): Action`
- [ ] If topicPool < threshold → GENERATE_TOPICS
- [ ] If approved > 0 AND inWindow → POST
- [ ] If approved > 0 AND !inWindow → WAIT
- [ ] If topicPool >= threshold AND approved === 0 → GENERATE_POSTS
- [ ] If lastBrowse > 4h → BROWSE
- [ ] If uncheckedReplies > 0 → CHECK_REPLIES
- [ ] If trends stale > 2h → REFRESH_TRENDS
- [ ] Default → WAIT(120s)

### Task 2.4: [V] Design + implement LLM orchestrator prompt
- [ ] Create `src/modules/orchestrator/prompts/orchestrator-prompt.ts`
- [ ] System prompt: role, rules, output format
- [ ] User prompt template: summarized WorldState
- [ ] Output schema: `{action, network, reason}` as JSON
- [ ] Include all relevant state fields in summary
- [ ] Include posting window info
- [ ] Include recent performance metrics

### Task 2.5: [V] Implement LLM decision invocation
- [ ] Implement `llmDecision(world): Promise<Action>`
- [ ] Call `ILlmPort.generateChat(systemPrompt, userPrompt)`
- [ ] Parse JSON response → Action object
- [ ] 10s timeout — use Promise.race with timeout
- [ ] If timeout/error/invalid JSON → fall back to rulesOnlyDecision()
- [ ] Log full prompt + response for audit

### Task 2.6: [V] Implement guardrails
- [ ] Implement `applyGuardrails(action, world): Action`
- [ ] G1: validate action type → WAIT if invalid
- [ ] G2: validate network enabled → WAIT if disabled
- [ ] G3: POST + rate limit 0 → WAIT
- [ ] G4: POST/BROWSE + session expired → RECOVER_SESSION
- [ ] G5: POST + queue > 5 → WAIT
- [ ] G6: actions/hour > 15 → WAIT
- [ ] G7: flow paused for action → WAIT
- [ ] Log original vs clamped action

### Task 2.7: [V] Implement DecisionEngine.decide()
- [ ] Wire three phases: hardRules → LLM → guardrails
- [ ] If ORCHESTRATOR_LLM_ENABLED=false → skip LLM, use rulesOnly
- [ ] Log: phase matched, action chosen, reason
- [ ] Return Action object (never null, never throw)

### Task 2.8: Implement PostingWindowService — heatmap builder
- [ ] Create `src/modules/orchestrator/posting-window.service.ts`
- [ ] Implement `buildHeatmap(network): Promise<Map<hour, score>>`
- [ ] Query PostMetrics for last 30 days per network
- [ ] Weight by recency (exponential decay, 30-day half-life)
- [ ] Score = weighted avg of (likes + comments*2 + shares*3) / impressions
- [ ] Cache heatmap in Redis (1h TTL, key: `spa:posting-window:heatmap:{network}`)

### Task 2.9: Implement PostingWindowService — recommender
- [ ] Implement `getRecommendation(network): Promise<PostingWindow>`
- [ ] Get heatmap from cache or rebuild
- [ ] Return top N hours (POSTING_WINDOW_TOP_HOURS, default 3)
- [ ] If < POSTING_WINDOW_MIN_SAMPLES posts → use fallback hours
- [ ] Return: `{ bestHours: number[], inWindow: boolean, confidence: 'high'|'medium'|'low' }`

### Task 2.10: Implement PostingWindowService — cold start
- [ ] Fallback hours from env: `POSTING_WINDOW_FALLBACK_HOURS=9,12,18,21`
- [ ] When < 10 posts with metrics → use fallback
- [ ] Confidence = 'low' when using fallback
- [ ] Confidence = 'medium' when 10-50 posts
- [ ] Confidence = 'high' when > 50 posts

### Task 2.11: [V] Unit tests for DecisionEngine (V9)
- [ ] Test each hard rule in isolation
- [ ] Test hard rule priority ordering
- [ ] Test LLM decision with mocked ILlmPort
- [ ] Test LLM timeout → rules fallback
- [ ] Test LLM invalid JSON → rules fallback
- [ ] Test each guardrail in isolation
- [ ] Test guardrail override logging
- [ ] Test ORCHESTRATOR_LLM_ENABLED=false → no LLM call
- [ ] Test rules-only fallback logic for all scenarios

### Task 2.12: [V] Integration tests for DecisionEngine (V7)
- [ ] Test full three-phase flow with real services (mocked LLM)
- [ ] Test: expired session → RECOVER (hard rule, no LLM)
- [ ] Test: clean state → LLM called → action returned
- [ ] Test: LLM returns POST for disabled network → guardrail → WAIT
- [ ] Test: 16th action in hour → guardrail → WAIT

### Task 2.13: Unit tests for PostingWindowService
- [ ] Test heatmap builder with mocked PostMetrics
- [ ] Test exponential decay weighting
- [ ] Test recommender with full heatmap
- [ ] Test cold start fallback (< 10 posts)
- [ ] Test Redis caching (build → cache → read from cache)
- [ ] Test confidence levels

---

## Phase 3: Execution (WS-3)

### Task 3.1: Implement ActionExecutor — GENERATE_TOPICS
- [ ] Create `src/modules/orchestrator/action-executor.service.ts`
- [ ] Implement `execute(action): Promise<ActionResult>`
- [ ] GENERATE_TOPICS: call GenerationService (topic generation mode)
- [ ] Return: `{ success: boolean, duration: number, sideEffects?: Record<string, unknown> }`

### Task 3.2: Implement ActionExecutor — GENERATE_POSTS
- [ ] GENERATE_POSTS: call `GenerationService.generate(count, networks, 'AUTONOMOUS')`
- [ ] Auto-approve if AUTO_APPROVE_ENABLED=true
- [ ] Return: `{ success, postsGenerated: number, postsApproved: number }`

### Task 3.3: Implement ActionExecutor — POST
- [ ] POST: call `QueueService.enqueuePosting(postId, network)`
- [ ] Find oldest approved draft for the network
- [ ] If no approved draft → return `{ success: false, reason: 'no approved drafts' }`
- [ ] Apply human-like delay (AUTONOMOUS_POSTING_DELAY_MIN/MAX_MS)

### Task 3.4: Implement ActionExecutor — BROWSE
- [ ] BROWSE: call EngagementService to start browsing session
- [ ] Enqueue as BullMQ delayed job (reuse existing engagement queue)
- [ ] Return: `{ success, sessionId: string }`

### Task 3.5: Implement ActionExecutor — RECOVER_SESSION
- [ ] RECOVER_SESSION: call `SessionsService.getOrCreateSession(network)`
- [ ] This triggers auto-login + 2FA flow (already implemented)
- [ ] Return: `{ success, sessionStatus: string }`

### Task 3.6: Implement ActionExecutor — CHECK_REPLIES
- [ ] CHECK_REPLIES: call `RepliesMonitorService.runMonitoringCycle()`
- [ ] Return: `{ success, repliesProcessed: number, autoReplied: number }`

### Task 3.7: Implement ActionExecutor — REFRESH_TRENDS
- [ ] REFRESH_TRENDS: call `TrendingScraperService.refreshCache()`
- [ ] Return: `{ success, trendsCount: number }`

### Task 3.8: Implement ActionExecutor — HEALTH_CHECK + RECONCILE
- [ ] HEALTH_CHECK: call `HealthMonitorService.runHealthCheck()`
- [ ] RECONCILE: call `HealthMonitorService.runReconciliation()`
- [ ] Return appropriate results

### Task 3.9: Implement ActionExecutor — SCRAPE_METRICS + RECYCLE + AGGREGATE
- [ ] SCRAPE_METRICS: call `MetricsScraperService.collectMetrics()`
- [ ] RECYCLE_CONTENT: call `RecyclingService.runRecycling()`
- [ ] AGGREGATE_HOOKS: call `HookPerformanceBank.aggregateStats()`

### Task 3.10: Implement ActionExecutor — WAIT
- [ ] WAIT: no-op, return `{ success: true, type: 'WAIT' }`
- [ ] No service calls

### Task 3.11: Unit tests for ActionExecutor
- [ ] Test each action handler with mocked services
- [ ] Test error handling — service throws → ActionResult with error
- [ ] Test WAIT → no service calls made
- [ ] Test unknown action type → error result

---

## Phase 4: Graph + Loop (WS-5)

### Task 4.1: [V] Define OrchestratorState
- [ ] Create `src/modules/orchestrator/orchestrator.graph.ts`
- [ ] Define `OrchestratorState` using LangGraph `Annotation.Root`
- [ ] Fields: world, action, result, cycle, sleepMs, heartbeat, errors
- [ ] Proper reducers for each field

### Task 4.2: [V] Implement OBSERVE node
- [ ] `observeNode(state): Partial<OrchestratorState>`
- [ ] Call `stateCollector.collectWorldState()`
- [ ] Return `{ world, heartbeat: Date.now(), cycle: 1 }` (cycle increments via reducer)

### Task 4.3: [V] Implement DECIDE node
- [ ] `decideNode(state): Partial<OrchestratorState>`
- [ ] Call `decisionEngine.decide(state.world)`
- [ ] Log: cycle, action, reason
- [ ] Return `{ action }`

### Task 4.4: [V] Implement EXECUTE node
- [ ] `executeNode(state): Partial<OrchestratorState>`
- [ ] If action.type === 'WAIT' → return `{ result: { type: 'WAIT' } }`
- [ ] Call `actionExecutor.execute(state.action)`
- [ ] Catch errors → `{ errors: [err] }`
- [ ] Return `{ result }`

### Task 4.5: [V] Implement EVALUATE node
- [ ] `evaluateNode(state): Partial<OrchestratorState>`
- [ ] Calculate adaptive sleep based on action + state
- [ ] Write heartbeat to Redis (SET with TTL)
- [ ] Actually sleep: `await new Promise(r => setTimeout(r, sleepMs))`
- [ ] Return `{ sleepMs }`

### Task 4.6: [V] Build StateGraph
- [ ] `const graph = new StateGraph(OrchestratorState)`
- [ ] Add nodes: observe, decide, execute, evaluate
- [ ] Add edges: START→observe, observe→decide, decide→execute, execute→evaluate
- [ ] Add conditional edge: evaluate→observe (loop)
- [ ] Compile with RedisCheckpointSaver

### Task 4.7: [V] Implement Redis checkpoint integration
- [ ] Use existing `RedisCheckpointSaver`
- [ ] Thread ID: `orchestrator` (constant, single persistent thread)
- [ ] Verify checkpoint saves after EVALUATE
- [ ] Verify resume picks up from checkpoint

### Task 4.8: [V] Implement OrchestratorService
- [ ] Create `src/modules/orchestrator/orchestrator.service.ts`
- [ ] `start()`: compile graph, invoke with thread_id
- [ ] `stop()`: set stop flag, graph exits after current cycle
- [ ] `OnModuleInit`: auto-start if ORCHESTRATOR_ENABLED=true
- [ ] `OnModuleDestroy`: graceful stop

### Task 4.9: [V] Implement adaptive sleep logic
- [ ] `calculateSleep(action, world): number`
- [ ] RECOVER_SESSION → 15s
- [ ] Non-WAIT action → 60s
- [ ] WAIT + idle → 120s
- [ ] Night (01-07 UTC) + no pending → 600s
- [ ] Circuit open → 60s
- [ ] Rate limited → until reset (max 3600s)
- [ ] Kill switch → 60s

### Task 4.10: [V] Implement heartbeat writer
- [ ] `writeHeartbeat(): Promise<void>`
- [ ] `redis.set(HEARTBEAT_KEY, Date.now().toString(), 'PX', HEARTBEAT_TTL_MS)`
- [ ] Called before every sleep in EVALUATE node

### Task 4.11: [V] System tests for OrchestratorGraph (V5)
- [ ] Test full cycle with real DB + Redis (mocked browser/LLM)
- [ ] Test crash + restart → checkpoint resume
- [ ] Test adaptive sleep tiers
- [ ] Test heartbeat written to Redis

### Task 4.12: [V] Acceptance tests for OrchestratorGraph (V3)
- [ ] E2E: orchestrator runs 3 cycles with mocked services
- [ ] E2E: session expired → RECOVER → session recovered → POST
- [ ] E2E: kill switch → WAIT → resume → normal operation
- [ ] E2E: checkpoint persists cycle number across restart

---

## Phase 5: Safety Net (WS-6 completion)

### Task 5.1: Implement watchdog heartbeat check
- [ ] Read `ORCHESTRATOR_HEARTBEAT_KEY` from Redis
- [ ] If key exists → heartbeat fresh, no action needed
- [ ] If key missing → orchestrator may be dead

### Task 5.2: Implement watchdog restart logic
- [ ] Call `OrchestratorService.stop()` (graceful)
- [ ] Wait 5s for graceful shutdown
- [ ] Call `OrchestratorService.start()` (fresh)
- [ ] Log: "Watchdog restarted orchestrator (heartbeat stale)"

### Task 5.3: Implement watchdog Discord alert
- [ ] On restart: send Discord warning
- [ ] Include: last heartbeat time, restart reason, cycle number

### Task 5.4: Unit tests for watchdog
- [ ] Test: fresh heartbeat → no action
- [ ] Test: stale heartbeat → restart called
- [ ] Test: Redis error → log warning, don't crash

### Task 5.5: Integration test: watchdog restart
- [ ] Start orchestrator
- [ ] Kill it (simulate crash)
- [ ] Wait for watchdog cron
- [ ] Verify orchestrator restarted

---

## Phase 6: Migration (WS-7)

### Task 6.1: Add ORCHESTRATOR_ENABLED check to each @Cron
- [ ] `sessions.service.ts` refreshSessionsCron → early return if flag on
- [ ] `autonomous-runner.service.ts` runAutonomousCycle → early return
- [ ] `engagement-scheduler.service.ts` scheduleDailySessionsCron → early return
- [ ] `recycling.service.ts` recyclingCron → early return
- [ ] `hook-performance-bank.ts` scheduledAggregate → early return
- [ ] `metrics-scraper.service.ts` collectMetricsCron → early return
- [ ] `cron.service.ts` handleCronGeneration → early return
- [ ] `health-monitor.service.ts` runHealthCheck → early return
- [ ] `health-monitor.service.ts` runReconciliation → early return
- [ ] `replies-monitor.service.ts` runMonitoringCycle → early return
- [ ] `trending-scraper.service.ts` refreshCache → early return

### Task 6.2: Conditional module loading
- [ ] In AppModule: if ORCHESTRATOR_ENABLED=true → add OrchestratorModule
- [ ] If ORCHESTRATOR_ENABLED=false → don't load OrchestratorModule
- [ ] Watchdog cron always loaded (it checks flag internally)

### Task 6.3: Integration tests for migration
- [ ] Test: flag OFF → old crons run, orchestrator not started
- [ ] Test: flag ON → old crons skip, orchestrator runs

### Task 6.4: Deploy with flag OFF
- [ ] Deploy to Railway
- [ ] Verify no behavior change (old crons still run)
- [ ] Verify orchestrator module loaded but not started

### Task 6.5: Deploy with flag ON
- [ ] Set ORCHESTRATOR_ENABLED=true in Railway
- [ ] Deploy
- [ ] Verify orchestrator starts (logs: cycle started)
- [ ] Verify old crons skip (logs: "orchestrator enabled, skipping")
- [ ] Monitor for 1 hour — verify normal operation

---

## Phase 7: Observability (WS-8)

### Task 7.1: SSE events for orchestrator
- [ ] Add `orchestrator_cycle_start` event (cycle number, action)
- [ ] Add `orchestrator_cycle_end` event (result, sleep duration)
- [ ] Add `orchestrator_error` event (error details)
- [ ] Publish via SseService

### Task 7.2: Orchestrator status endpoint
- [ ] `GET /api/v1/orchestrator/status`
- [ ] Returns: enabled, running, currentCycle, lastAction, heartbeat, uptime
- [ ] Unit test

### Task 7.3: Orchestrator history endpoint
- [ ] `GET /api/v1/orchestrator/history?limit=50`
- [ ] Returns: last N actions with timestamp, type, network, result, duration
- [ ] Store action history in Redis list (key: `spa:orchestrator:history`, max 200 entries)

### Task 7.4: Orchestrator control endpoints
- [ ] `POST /api/v1/orchestrator/pause` → calls FlowControlService.pauseAll()
- [ ] `POST /api/v1/orchestrator/resume` → calls FlowControlService.resumeAll()
- [ ] `POST /api/v1/orchestrator/restart` → stop + start

### Task 7.5: Unit tests for endpoints
- [ ] Test status endpoint returns correct shape
- [ ] Test history endpoint returns action list
- [ ] Test pause/resume endpoints call FlowControlService
- [ ] Test restart endpoint calls stop + start

---

## Phase 8: Stabilization + Cleanup

### Task 8.1: Monitor orchestrator for 48h
- [ ] Watch logs for errors, stuck cycles, bad decisions
- [ ] Verify all action types are exercised
- [ ] Verify posting windows work
- [ ] Verify crash-resume works

### Task 8.2: Fix issues found during monitoring
- [ ] Triage and fix any bugs
- [ ] Tune adaptive sleep intervals if needed
- [ ] Tune LLM prompt if decisions are poor

### Task 8.3: Remove old @Cron decorators
- [ ] Remove @Cron from all 11 methods (keep methods as callable functions)
- [ ] Remove SchedulerRegistry dynamic cron registrations
- [ ] Remove cron-related env vars (CRON schedules)

### Task 8.4: Update .env.example
- [ ] Remove old cron schedule env vars
- [ ] Add orchestrator env vars (already done in Task 1.1)
- [ ] Update comments

### Task 8.5: Update CLAUDE.md
- [ ] Replace "cron + BullMQ" section with "orchestrator + BullMQ"
- [ ] Document orchestrator architecture
- [ ] Document adaptive loop, decision engine, watchdog
- [ ] Update env vars list

### Task 8.6: Final regression test suite
- [ ] Run full test suite (unit + integration + system + acceptance)
- [ ] Verify all tests pass
- [ ] Verify coverage ≥ 80%
- [ ] Deploy final version

---

## Task Summary

| Phase | Tasks | V-Model Tasks | Est. Complexity |
|-------|-------|---------------|-----------------|
| 1: Foundation | 9 | 6 | Medium |
| 2: Brain | 13 | 9 | High |
| 3: Execution | 11 | 0 | Low (thin wrappers) |
| 4: Graph + Loop | 12 | 12 | High |
| 5: Safety Net | 5 | 0 | Low |
| 6: Migration | 5 | 0 | Medium |
| 7: Observability | 5 | 0 | Low |
| 8: Cleanup | 6 | 0 | Low |
| **Total** | **66** | **27** | |

## Dependency Graph

```
Phase 1 (Foundation)
  ├─→ Phase 2 (Brain) — needs StateCollector
  │     └─→ Phase 4 (Graph) — needs DecisionEngine + ActionExecutor
  │           └─→ Phase 5 (Safety Net) — needs OrchestratorService
  │                 └─→ Phase 6 (Migration) — needs complete orchestrator
  │                       └─→ Phase 7 (Observability) — needs running orchestrator
  │                             └─→ Phase 8 (Cleanup) — needs stable orchestrator
  └─→ Phase 3 (Execution) — needs types only, can parallel with Phase 2
```

**Critical path:** Phase 1 → Phase 2 → Phase 4 → Phase 5 → Phase 6
**Parallelizable:** Phase 3 (can start after Phase 1, runs alongside Phase 2)
