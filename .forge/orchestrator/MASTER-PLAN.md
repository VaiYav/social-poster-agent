# Master Plan: LangGraph Orchestrator

> Status: DRAFT | Version: 1.0 | Date: 2026-07-01
> Feature: `orchestrator` | Size: Large | Mode: V-Model (critical features) + Standard (rest)
>
> Replaces: ALL @Cron decorators with a single adaptive LangGraph agent loop

---

## 1. Overview

### Problem Statement

The system runs on 11 independent cron jobs with fixed schedules. This is rigid:
posts go out at 12:00 even if the audience is active at 21:00; topics generate
when the pool is already full (43/30); sessions expire and aren't recovered until
the next posting attempt; browsing sessions conflict with generation runs.

### Solution Summary

A single LangGraph orchestrator that continuously cycles through
OBSERVE → DECIDE → EXECUTE → EVALUATE, replacing all 11 crons. The decision engine
is a hybrid: hard rules for safety (sessions, rate limits, circuit breakers) + LLM
for optimization (when to post, which topic, when to browse). An adaptive loop
interval (15s during recovery, 60s active, 300s idle, 600s night). A watchdog cron
restarts the orchestrator if it hangs.

### Key Decisions (from brainstorm)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Decision engine | Hybrid (rules + LLM) | Safety + flexibility |
| Loop interval | Adaptive | Efficiency + responsiveness |
| Posting windows | Smart (data-driven) | User requested; uses engagement history |
| Cron replacement | Full + watchdog | Single system + safety net |
| Scope | Complete replacement | User requested |

---

## 2. Architecture

### 2.1 Orchestrator Graph

```
                    ┌─────────────────────────────────────────┐
                    │           ORCHESTRATOR GRAPH             │
                    │                                         │
                    │  ┌──────────┐                           │
                    │  │  START   │                           │
                    │  └────┬─────┘                           │
                    │       ▼                                 │
                    │  ┌──────────┐    ┌──────────────────┐   │
                    │  │ OBSERVE  │───▶│   DECIDE         │   │
                    │  │          │    │                  │   │
                    │  │ DB state │    │ Phase 1: Rules   │   │
                    │  │ Redis    │    │ Phase 2: LLM     │   │
                    │  │ Sessions │    │ Phase 3: Guard   │   │
                    │  │ Metrics  │    │                  │   │
                    │  │ Trends   │    └────────┬─────────┘   │
                    │  └──────────┘             │             │
                    │                           ▼             │
                    │              ┌──────────────────┐       │
                    │              │     EXECUTE      │       │
                    │              │                  │       │
                    │              │ Action router →  │       │
                    │              │ existing service │       │
                    │              └────────┬─────────┘       │
                    │                       ▼                 │
                    │              ┌──────────────────┐       │
                    │              │     EVALUATE     │       │
                    │              │                  │       │
                    │              │ Result + side    │       │
                    │              │ effects + sleep  │       │
                    │              └────────┬─────────┘       │
                    │                       │                 │
                    │                       ▼                 │
                    │              ┌──────────────────┐       │
                    │              │   CHECKPOINT     │       │
                    │              │   (Redis)        │       │
                    │              └────────┬─────────┘       │
                    │                       │                 │
                    │                       ▼                 │
                    │              ┌──────────────────┐       │
                    │              │   LOOP BACK      │       │
                    │              │   → OBSERVE      │       │
                    │              └──────────────────┘       │
                    └─────────────────────────────────────────┘

External safety net:
  ┌──────────────────┐
  │  WATCHDOG CRON   │  every 5 min: check heartbeat
  │  (only @Cron     │  if stale > 10 min → restart
  │   that remains)  │  orchestrator
  └──────────────────┘
```

### 2.2 State Schema (LangGraph Annotation)

```typescript
import { Annotation } from '@langchain/langgraph';

const OrchestratorState = Annotation.Root({
  // ── OBSERVE: world state snapshot ──
  world: Annotation<WorldState>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: {} as WorldState,
  }),

  // ── DECIDE: chosen action ──
  action: Annotation<Action>({
    reducer: (_, next) => next,
    default: null as unknown as Action,
  }),

  // ── EXECUTE: result of last action ──
  result: Annotation<ActionResult>({
    reducer: (_, next) => next,
    default: null as unknown as ActionResult,
  }),

  // ── EVALUATE: loop control ──
  cycle: Annotation<number>({
    reducer: (prev, next) => prev + next,
    default: 0,
  }),
  sleepMs: Annotation<number>({
    reducer: (_, next) => next,
    default: 60000,
  }),
  heartbeat: Annotation<number>({
    reducer: (_, next) => next,
    default: Date.now(),
  }),

  // ── Error tracking ──
  errors: Annotation<Error[]>({
    reducer: (prev, next) => [...prev, ...next].slice(-50),
    default: [],
  }),
});
```

### 2.3 WorldState (collected by OBSERVE)

```typescript
interface WorldState {
  timestamp: number;

  // Content pipeline
  topicPool: { count: number; threshold: number; oldestAgeMs: number };
  drafts: { pending: number; approved: number; rejected: number };
  queueDepth: { x: number; threads: number; facebook: number };

  // Sessions
  sessions: Record<SocialNetwork, {
    status: SessionStatus;
    lastCheckMs: number;
    circuitBreaker: 'closed' | 'open' | 'half_open';
  }>;

  // Rate limits
  rateLimits: Record<SocialNetwork, {
    dailyRemaining: number;
    weeklyRemaining: number;
    minIntervalMs: number;
    lastPostMs: number;
  }>;

  // Timing
  now: Date;
  utcHour: number;
  utcDayOfWeek: number;
  postingWindows: Record<SocialNetwork, PostingWindow | null>;
  inPostingWindow: Record<SocialNetwork, boolean>;

  // Performance (from PostMetrics)
  performance: Record<SocialNetwork, {
    lastPostMetrics?: { impressions: number; likes: number; comments: number; shares: number };
    recentAvgEngagement: number;
    bestHours: number[];  // top 3 UTC hours by historical engagement
  }>;

  // Engagement
  engagement: {
    lastBrowseMs: Record<SocialNetwork, number>;
    uncheckedReplies: number;
    warmupPhase: Record<SocialNetwork, string>;
  };

  // Health
  health: {
    bans: number;
    dlqDepth: number;
    stuckPosting: number;
    orphanedPosts: number;
    killSwitch: boolean;
  };

  // Trends
  trends: {
    lastRefreshMs: number;
    count: number;
  };

  // Flow control
  flowControl: {
    pauseAll: boolean;
    pauseGeneration: boolean;
    pausePosting: boolean;
    pauseEngagement: boolean;
    pauseReplies: boolean;
  };
}
```

### 2.4 Action Types

```typescript
type ActionType =
  | 'GENERATE_TOPICS'      // LLM topic generation
  | 'GENERATE_POSTS'       // Generation graph (existing subgraph)
  | 'POST'                 // Enqueue post to BullMQ
  | 'BROWSE'               // Engagement browsing session
  | 'RECOVER_SESSION'      // Login + 2FA recovery
  | 'CHECK_REPLIES'        // Scrape + reply to comments
  | 'REFRESH_TRENDS'       // Scrape Google/X trends
  | 'HEALTH_CHECK'         // Full health scan
  | 'RECONCILE'            // Re-enqueue stuck posts
  | 'SCRAPE_METRICS'       // Collect engagement metrics
  | 'RECYCLE_CONTENT'      // Recycle top-performing old posts
  | 'AGGREGATE_HOOKS'      // Hook performance bank aggregation
  | 'WAIT';                // No-op, sleep

interface Action {
  type: ActionType;
  network?: SocialNetwork;
  reason: string;
  source: 'hard_rule' | 'llm' | 'guardrail_override';
  params?: Record<string, unknown>;
}
```

---

## 3. Feature Breakdown — 8 Work Streams

Each work stream is a self-contained deliverable with its own spec, tasks, and tests.

### WS-1: State Collector (OBSERVE node)
**Criticality: High** — everything depends on accurate state
**V-Model: YES** — data correctness is safety-critical

Collects WorldState from DB, Redis, sessions, metrics, trends, flow-control.
Single `collectWorldState()` function called by OBSERVE node.

### WS-2: Decision Engine (DECIDE node)
**Criticality: Critical** — wrong decisions = wrong actions
**V-Model: YES** — the brain of the system

Three-phase: hard rules → LLM → guardrails. Hard rules are non-negotiable safety
checks. LLM optimizes soft decisions. Guardrails clamp LLM output.

### WS-3: Action Executor (EXECUTE node)
**Criticality: High** — calls existing services
**V-Model: NO** (standard) — thin wrapper around existing tested services

Routes Action to existing service method. No business logic — just dispatch.
Each action type maps to one service call.

### WS-4: Posting Window Engine (Smart)
**Criticality: Medium** — optimization, not safety
**V-Model: NO** (standard) — data-driven, not safety-critical

Builds engagement heatmap from PostMetrics history. Recommends best posting
slots per network per day. Used by DECIDE node.

### WS-5: Orchestrator Graph + Loop
**Criticality: Critical** — the main loop
**V-Model: YES** — crash-resume, state persistence, loop control

LangGraph StateGraph with OBSERVE → DECIDE → EXECUTE → EVALUATE → loop.
Redis checkpoint for crash-resume. Adaptive sleep between cycles.

### WS-6: Watchdog + Feature Flag
**Criticality: High** — safety net
**V-Model: NO** (standard) — simple, well-understood pattern

One @Cron (every 5 min) that checks orchestrator heartbeat. Feature flag
`ORCHESTRATOR_ENABLED` to toggle between orchestrator and old crons.

### WS-7: Cron Migration
**Criticality: High** — removing old crons
**V-Model: NO** (standard) — mechanical removal with feature flag

Disable old @Cron decorators when `ORCHESTRATOR_ENABLED=true`. Keep them
as fallback when flag is off. Clean removal after stabilization.

### WS-8: Observability + SSE
**Criticality: Medium** — monitoring
**V-Model: NO** (standard) — extends existing SSE infrastructure

Orchestrator emits SSE events: cycle started, action chosen, action completed,
errors. Dashboard shows current state + action history.

---

## 4. V-Model Application

V-Model applies to 3 critical work streams (WS-1, WS-2, WS-5). For each,
the V-Model progression is:

```
Requirements → Acceptance Tests → System Design → System Tests
→ Architecture Design → Integration Tests → Module Design → Unit Tests
→ Implementation (bottom-up) → Test Execution (bottom-up)
```

### V-Model for WS-1: State Collector

| V-Step | Artifact |
|--------|----------|
| V1 Requirements | `specs/ws-1-requirements.md` — what state to collect, accuracy requirements |
| V3 Acceptance Tests | `tests/ws-1-acceptance.spec.ts` — E2E: collect full WorldState from real DB |
| V4 System Design | `specs/ws-1-system-design.md` — StateCollector class, DB queries, Redis reads |
| V5 System Tests | `tests/ws-1-system.spec.ts` — integration: DB + Redis + sessions → WorldState |
| V6 Architecture Design | `specs/ws-1-architecture.md` — module structure, DI, ports |
| V7 Integration Tests | `tests/ws-1-integration.spec.ts` — each data source → correct field in WorldState |
| V8 Module Design | `specs/ws-1-module-design.md` — method signatures, error handling |
| V9 Unit Tests | `tests/ws-1-unit.spec.ts` — each collector method with mocked DB/Redis |

### V-Model for WS-2: Decision Engine

| V-Step | Artifact |
|--------|----------|
| V1 Requirements | `specs/ws-2-requirements.md` — decision matrix, hard rules, LLM prompt spec |
| V3 Acceptance Tests | `tests/ws-2-acceptance.spec.ts` — E2E: given world state → correct action |
| V4 System Design | `specs/ws-2-system-design.md` — three-phase decision flow |
| V5 System Tests | `tests/ws-2-system.spec.ts` — integration: rules + LLM mock + guardrails |
| V6 Architecture Design | `specs/ws-2-architecture.md` — DecisionEngine class, LLM prompt structure |
| V7 Integration Tests | `tests/ws-2-integration.spec.ts` — each phase in isolation |
| V8 Module Design | `specs/ws-2-module-design.md` — rule functions, LLM prompt, guardrail clamps |
| V9 Unit Tests | `tests/ws-2-unit.spec.ts` — each rule, each guardrail, LLM prompt format |

### V-Model for WS-5: Orchestrator Graph + Loop

| V-Step | Artifact |
|--------|----------|
| V1 Requirements | `specs/ws-5-requirements.md` — loop behavior, crash-resume, adaptive sleep |
| V3 Acceptance Tests | `tests/ws-5-acceptance.spec.ts` — E2E: full cycle with real services (mocked browser) |
| V4 System Design | `specs/ws-5-system-design.md` — StateGraph structure, checkpoint strategy |
| V5 System Tests | `tests/ws-5-system.spec.ts` — integration: graph + checkpoint + loop control |
| V6 Architecture Design | `specs/ws-5-architecture.md` — OrchestratorService, graph compilation, lifecycle |
| V7 Integration Tests | `tests/ws-5-integration.spec.ts` — OBSERVE→DECIDE→EXECUTE→EVALUATE chain |
| V8 Module Design | `specs/ws-5-module-design.md` — node functions, state transitions, sleep logic |
| V9 Unit Tests | `tests/ws-5-unit.spec.ts` — each node in isolation, checkpoint save/load |

---

## 5. Roadmap

### Phase 1: Foundation (WS-6 + WS-1)
**Goal:** Feature flag + state collector working independently

```
Task 1.1: Add ORCHESTRATOR_ENABLED env var + feature flag
Task 1.2: Create orchestrator module structure (NestJS module)
Task 1.3: Implement StateCollector.collectWorldState() — DB queries
Task 1.4: Implement StateCollector — Redis reads (rate limits, flow control)
Task 1.5: Implement StateCollector — session status + circuit breakers
Task 1.6: Implement StateCollector — metrics + performance data
Task 1.7: Implement StateCollector — trends + engagement status
Task 1.8: Unit tests for StateCollector (V-Model V9)
Task 1.9: Integration tests for StateCollector (V-Model V7)
Task 1.10: Watchdog cron skeleton (heartbeat check, no restart yet)
```

### Phase 2: Brain (WS-2 + WS-4)
**Goal:** Decision engine + posting windows working independently

```
Task 2.1: Implement hard rules (session expired, rate limit, kill switch)
Task 2.2: Implement hard rules (circuit breaker open, DLQ overflow)
Task 2.3: Implement hard rules (flow control paused, queue depth)
Task 2.4: Design + implement LLM orchestrator prompt
Task 2.5: Implement LLM decision invocation (with structured output)
Task 2.6: Implement guardrails (validate + clamp LLM output)
Task 2.7: Implement guardrails (network enabled check, max actions/hour)
Task 2.8: Implement PostingWindowEngine — heatmap builder from PostMetrics
Task 2.9: Implement PostingWindowEngine — best slot recommender
Task 2.10: Implement PostingWindowEngine — cold-start fallback (when <10 posts)
Task 2.11: Unit tests for DecisionEngine (V-Model V9)
Task 2.12: Integration tests for DecisionEngine (V-Model V7)
Task 2.13: Unit tests for PostingWindowEngine
```

### Phase 3: Execution (WS-3)
**Goal:** Action executor dispatches to all existing services

```
Task 3.1: Implement ActionExecutor — GENERATE_TOPICS handler
Task 3.2: Implement ActionExecutor — GENERATE_POSTS handler (calls GenerationService)
Task 3.3: Implement ActionExecutor — POST handler (enqueues to BullMQ)
Task 3.4: Implement ActionExecutor — BROWSE handler (engagement session)
Task 3.5: Implement ActionExecutor — RECOVER_SESSION handler (SessionsService)
Task 3.6: Implement ActionExecutor — CHECK_REPLIES handler
Task 3.7: Implement ActionExecutor — REFRESH_TRENDS handler
Task 3.8: Implement ActionExecutor — HEALTH_CHECK + RECONCILE handler
Task 3.9: Implement ActionExecutor — SCRAPE_METRICS + RECYCLE + AGGREGATE handler
Task 3.10: Implement ActionExecutor — WAIT handler (no-op)
Task 3.11: Unit tests for ActionExecutor (each handler)
```

### Phase 4: Graph + Loop (WS-5)
**Goal:** Full orchestrator graph running with checkpoint

```
Task 4.1: Define OrchestratorState (LangGraph Annotation)
Task 4.2: Implement OBSERVE node (calls StateCollector)
Task 4.3: Implement DECIDE node (calls DecisionEngine)
Task 4.4: Implement EXECUTE node (calls ActionExecutor)
Task 4.5: Implement EVALUATE node (result + adaptive sleep calculation)
Task 4.6: Build StateGraph — wire nodes + edges + loop
Task 4.7: Implement Redis checkpoint integration (thread_id = "orchestrator")
Task 4.8: Implement OrchestratorService — start/stop lifecycle
Task 4.9: Implement adaptive sleep logic (15s/60s/300s/600s tiers)
Task 4.10: Implement heartbeat writer (Redis key with TTL)
Task 4.11: System tests for OrchestratorGraph (V-Model V5)
Task 4.12: Acceptance tests for OrchestratorGraph (V-Model V3)
```

### Phase 5: Safety Net (WS-6 completion)
**Goal:** Watchdog restarts orchestrator if it hangs

```
Task 5.1: Implement watchdog heartbeat check (read Redis key)
Task 5.2: Implement watchdog restart logic (stop + start orchestrator)
Task 5.3: Implement watchdog Discord alert on restart
Task 5.4: Unit tests for watchdog
Task 5.5: Integration test: kill orchestrator → watchdog restarts it
```

### Phase 6: Migration (WS-7)
**Goal:** Disable old crons when orchestrator enabled

```
Task 6.1: Add ORCHESTRATOR_ENABLED check to each @Cron method (early return)
Task 6.2: Conditionally start OrchestratorService in AppModule when flag on
Task 6.3: Conditionally start WatchdogCron when flag on
Task 6.4: Integration test: flag off → old crons run, orchestrator idle
Task 6.5: Integration test: flag on → orchestrator runs, old crons skip
Task 6.6: Deploy with flag OFF → verify no behavior change
Task 6.7: Deploy with flag ON → verify orchestrator takes over
```

### Phase 7: Observability (WS-8)
**Goal:** Orchestrator visible in UI + SSE events

```
Task 7.1: Add SSE events for orchestrator (cycle_start, action_chosen, action_result)
Task 7.2: Add orchestrator status endpoint (GET /api/v1/orchestrator/status)
Task 7.3: Add orchestrator action history endpoint (GET /api/v1/orchestrator/history)
Task 7.4: Add orchestrator control endpoints (pause/resume/restart)
Task 7.5: Unit tests for endpoints
```

### Phase 8: Stabilization + Cleanup
**Goal:** Remove old crons after stabilization period

```
Task 8.1: Monitor orchestrator for 48h with flag ON
Task 8.2: Fix any issues found during monitoring
Task 8.3: Remove @Cron decorators (keep methods as callable functions)
Task 8.4: Remove cron-related env vars from .env.example
Task 8.5: Update CLAUDE.md with orchestrator architecture
Task 8.6: Final regression test suite
```

---

## 6. File Structure

```
packages/backend/src/modules/orchestrator/
├── orchestrator.module.ts              # NestJS module
├── orchestrator.service.ts             # Lifecycle: start/stop graph
├── orchestrator.controller.ts          # REST endpoints (status/control)
├── state-collector.service.ts          # WS-1: OBSERVE — collect WorldState
├── decision-engine.service.ts          # WS-2: DECIDE — rules + LLM + guardrails
├── action-executor.service.ts          # WS-3: EXECUTE — dispatch to services
├── posting-window.service.ts           # WS-4: Smart posting windows
├── orchestrator.graph.ts               # WS-5: LangGraph StateGraph
├── watchdog.cron.ts                    # WS-6: Safety net cron
├── types.ts                            # Shared types (WorldState, Action, etc.)
└── prompts/
    └── orchestrator-prompt.ts          # LLM prompt for soft decisions

packages/backend/tests/
├── unit/orchestrator/
│   ├── state-collector.spec.ts         # WS-1 V9
│   ├── decision-engine.spec.ts         # WS-2 V9
│   ├── action-executor.spec.ts         # WS-3 unit
│   ├── posting-window.spec.ts          # WS-4 unit
│   ├── orchestrator-graph.spec.ts      # WS-5 V9
│   └── watchdog.spec.ts               # WS-6 unit
├── integration/orchestrator/
│   ├── state-collector.integration.ts  # WS-1 V7
│   ├── decision-engine.integration.ts  # WS-2 V7
│   └── orchestrator-graph.integration.ts # WS-5 V7
├── system/orchestrator/
│   ├── state-collector.system.ts       # WS-1 V5
│   ├── decision-engine.system.ts       # WS-2 V5
│   └── orchestrator-graph.system.ts    # WS-5 V5
└── acceptance/orchestrator/
    ├── state-collector.acceptance.ts   # WS-1 V3
    ├── decision-engine.acceptance.ts   # WS-2 V3
    └── orchestrator-graph.acceptance.ts # WS-5 V3

.forge/orchestrator/
├── MASTER-PLAN.md                      # This file
├── specs/
│   ├── ws-1-requirements.md            # V-Model V1
│   ├── ws-1-system-design.md           # V-Model V4
│   ├── ws-1-architecture.md            # V-Model V6
│   ├── ws-1-module-design.md           # V-Model V8
│   ├── ws-2-requirements.md            # V-Model V1
│   ├── ws-2-system-design.md           # V-Model V4
│   ├── ws-2-architecture.md            # V-Model V6
│   ├── ws-2-module-design.md           # V-Model V8
│   ├── ws-5-requirements.md            # V-Model V1
│   ├── ws-5-system-design.md           # V-Model V4
│   ├── ws-5-architecture.md            # V-Model V6
│   └── ws-5-module-design.md           # V-Model V8
```

---

## 7. Decision Matrix (Hard Rules)

Priority-ordered. First match wins. These are NON-NEGOTIABLE — LLM never sees these.

| # | Condition | Action | Reason |
|---|-----------|--------|--------|
| H1 | `flowControl.pauseAll === true` | WAIT 60s | Kill switch active |
| H2 | `sessions[network].status === EXPIRED` | RECOVER_SESSION | Session down |
| H3 | `sessions[network].status === BANNED` | WAIT 300s | Account banned, don't retry |
| H4 | `sessions[network].circuitBreaker === open` | WAIT 60s | Circuit open, let it reset |
| H5 | `rateLimits[network].dailyRemaining === 0` | WAIT until reset | Daily limit hit |
| H6 | `rateLimits[network].weeklyRemaining === 0` | WAIT until reset | Weekly limit hit |
| H7 | `health.dlqDepth > 10` | HEALTH_CHECK + ALERT | DLQ overflowing |
| H8 | `health.stuckPosting > 5` | RECONCILE | Posts stuck in POSTING |
| H9 | `health.bans > 0` | WAIT 300s + ALERT | Ban detected, back off |
| H10 | `queueDepth[network] > 5` | WAIT 60s | Queue backed up, don't pile on |

If no hard rule matches → proceed to LLM decision phase.

---

## 8. LLM Decision Prompt (Soft Decisions)

```
SYSTEM: You are a social media orchestrator agent. You decide what action to take next
based on the current world state. You must choose exactly ONE action.

Rules:
- Never choose an action for a disabled network
- Never choose POST if dailyRemaining === 0
- Prefer GENERATE_TOPICS if topicPool.count < threshold
- Prefer GENERATE_POSTS if approved drafts === 0 and topicPool sufficient
- Prefer POST if approved drafts > 0 AND inPostingWindow === true
- Prefer BROWSE if lastBrowse > 4h ago AND session active
- Prefer CHECK_REPLIES if uncheckedReplies > 0
- Prefer REFRESH_TRENDS if trends.lastRefresh > 2h ago
- Prefer SCRAPE_METRICS if last scrape > 24h ago
- Prefer HEALTH_CHECK if last health check > 1h ago
- Prefer RECONCILE if stuckPosting > 0
- Prefer WAIT if none of the above apply
- Consider posting windows: post when audience is most active
- Consider recent performance: if last post underperformed, wait longer

USER:
Current state (UTC {hour}:{minute}, {dayOfWeek}):
- Topic pool: {topicCount}/{threshold} (oldest: {oldestAgeHours}h)
- Approved drafts: {approvedCount}
- Queue depth: X={queueX}, THREADS={queueThreads}
- Sessions: X={sessionX}, THREADS={sessionThreads}
- Rate limits: X daily={dailyX}/weekly={weeklyX}, THREADS daily={dailyT}/weekly={weeklyT}
- Last post: X={lastPostXHours}h ago, THREADS={lastPostTHours}h ago
- Posting window: X={inWindowX} (best hours: {bestHoursX}), THREADS={inWindowT}
- Last browse: X={lastBrowseXHours}h ago, THREADS={lastBrowseTHours}h ago
- Unchecked replies: {uncheckedReplies}
- Trends: {trendCount} (last refresh: {trendAgeHours}h ago)
- Health: bans={bans}, DLQ={dlqDepth}, stuck={stuckPosting}
- Recent engagement: X avg={avgEngagementX}, THREADS avg={avgEngagementT}

Respond with JSON:
{"action": "ACTION_TYPE", "network": "X|THREADS|null", "reason": "one sentence"}
```

---

## 9. Guardrails (Post-LLM Validation)

| Check | If Failed | Action |
|-------|-----------|--------|
| Action type valid? | Unknown type | Override to WAIT |
| Network enabled? | Disabled network | Override to WAIT |
| Network in ENABLED_NETWORKS? | Not in list | Override to WAIT |
| Rate limit OK for POST? | dailyRemaining === 0 | Override to WAIT |
| Session active for POST/BROWSE? | Session expired | Override to RECOVER_SESSION |
| Queue depth OK for POST? | depth > 5 | Override to WAIT |
| Max actions/hour? | > 15 actions this hour | Override to WAIT |
| Max posts/day? | > configured limit | Override to WAIT |
| Flow control paused for action? | Is paused | Override to WAIT |

---

## 10. Adaptive Sleep Tiers

| Situation | Sleep | Reason |
|-----------|-------|--------|
| RECOVER_SESSION just executed | 15s | Check if recovery worked |
| Any action just executed | 60s | Active mode, quick next cycle |
| WAIT chosen (idle) | 120s | Normal idle |
| Night (01:00-07:00 UTC) + no pending | 600s | Audience asleep |
| Circuit breaker open | 60s | Wait for reset |
| Rate limited | Until reset time | Don't waste cycles |
| Kill switch active | 60s | Check if lifted |

---

## 11. Dependencies (New)

```
# No new npm packages needed — LangGraph already installed
# Existing: @langchain/langgraph, @langchain/core
# Existing: ioredis (SHARED_REDIS)
# Existing: All services already injected
```

---

## 12. Env Vars (New)

```bash
# Orchestrator
ORCHESTRATOR_ENABLED=false              # Feature flag (default off)
ORCHESTRATOR_LLM_ENABLED=true           # Use LLM for soft decisions (false = rules only)
ORCHESTRATOR_MAX_ACTIONS_PER_HOUR=15    # Guardrail
ORCHESTRATOR_HEARTBEAT_TTL_MS=600000    # 10 min — watchdog threshold
ORCHESTRATOR_CHECKPOINT_KEY=spa:orchestrator:checkpoint  # Redis key
ORCHESTRATOR_HEARTBEAT_KEY=spa:orchestrator:heartbeat    # Redis key

# Posting Windows (Smart)
POSTING_WINDOW_MIN_SAMPLES=10           # Min posts before using smart windows
POSTING_WINDOW_TOP_HOURS=3              # How many top hours to recommend
POSTING_WINDOW_DECAY_DAYS=30            # Weight recent posts more (exponential decay)
POSTING_WINDOW_FALLBACK_HOURS=9,12,18,21 # Cold-start fallback hours
```

---

## 13. Risks & Mitigations

| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| Orchestrator hangs | Med | High | Watchdog cron restarts it |
| LLM makes bad decisions | Med | Med | Guardrails clamp all output |
| State collector slow | Low | Med | Cache + parallel queries |
| Checkpoint corruption | Low | High | TTL + clean restart capability |
| Old crons + orchestrator both run | Med | High | Feature flag is mutually exclusive |
| LLM cost too high | Med | Low | Only call LLM when hard rules pass |
| Posting window cold start | High | Low | Fallback to hardcoded hours when <10 posts |
| Concurrent action conflicts | Med | Med | BullMQ still serializes posting; orchestrator enqueues, doesn't post directly |

---

## 14. Success Criteria

1. **Functional:** All 11 cron jobs replaced by orchestrator. No @Cron except watchdog.
2. **Reliability:** Orchestrator survives restart (checkpoint resume). Watchdog restarts within 10 min of hang.
3. **Performance:** OBSERVE cycle < 500ms. DECIDE cycle < 2s (with LLM) or < 10ms (rules only).
4. **Cost:** LLM calls < 20/day (only when soft decision needed). ~$0.20/day at gpt-5-nano rates.
5. **Adaptivity:** Posting windows adjust based on engagement data within 30 days.
6. **Safety:** Zero unguarded actions. Every LLM decision passes guardrails. Hard rules never bypassed.
7. **Observability:** SSE events for every cycle. REST API for status + history. Dashboard shows live state.
8. **Rollback:** `ORCHESTRATOR_ENABLED=false` instantly reverts to old crons.

---

## 15. Open Questions

1. **BullMQ coexistence?** Orchestrator enqueues to BullMQ (doesn't post directly). BullMQ workers remain. This is by design — BullMQ handles retries, delays, serialization. Orchestrator decides WHAT to enqueue, not HOW to post.

2. **Multiple orchestrator instances?** No — single instance. Redis heartbeat + watchdog ensures this. If deployed as multiple replicas, use Redis SETNX lock for leader election (future enhancement).

3. **LLM model for decisions?** Use the existing LLM router (ILlmPort). Default model gpt-5-nano is cheap and sufficient for structured JSON decisions. Can pin a specific model via env var if needed.

4. **Posting window for THREADS?** THREADS API provides engagement metrics. Same heatmap approach works. For X (no API), use browser-scraped metrics from MetricsScraperService.

5. **What about the existing generation graph?** It stays as-is. Orchestrator calls `GenerationService.generate()` which invokes the existing graph. Orchestrator is a higher-level loop, not a replacement for the generation graph.
