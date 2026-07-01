# WS-5 Requirements: Orchestrator Graph + Loop

> V-Model Phase: V1 (Requirements)
> Work Stream: WS-5 — Orchestrator Graph + Loop
> Criticality: Critical — the main loop that replaces all crons

---

## 1. Purpose

The Orchestrator Graph is a LangGraph StateGraph that continuously cycles
through OBSERVE → DECIDE → EXECUTE → EVALUATE, replacing all 11 cron jobs.
It persists state to Redis for crash-resume, uses adaptive sleep between
cycles, and is monitored by an external watchdog cron.

## 2. Functional Requirements

### 2.1 Graph Structure

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.1 | Graph has 4 nodes: OBSERVE, DECIDE, EXECUTE, EVALUATE | Must | Unit: verify graph nodes |
| FR-5.2 | Edges: START→OBSERVE→DECIDE→EXECUTE→EVALUATE→OBSERVE (loop) | Must | Unit: verify edges |
| FR-5.3 | Graph is compiled with RedisCheckpointSaver | Must | Integration: checkpoint saved |
| FR-5.4 | Thread ID for checkpoint: `orchestrator` (single persistent thread) | Must | Unit: verify thread_id |
| FR-5.5 | Graph state uses LangGraph Annotation with typed fields | Must | Unit: verify state type |

### 2.2 OBSERVE Node

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.6 | Calls `StateCollector.collectWorldState()` | Must | Unit: verify collector called |
| FR-5.7 | Stores result in `state.world` | Must | Unit: verify state update |
| FR-5.8 | Updates `state.heartbeat` to `Date.now()` | Must | Unit: verify heartbeat |
| FR-5.9 | Increments `state.cycle` | Must | Unit: verify cycle increment |

### 2.3 DECIDE Node

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.10 | Calls `DecisionEngine.decide(state.world)` | Must | Unit: verify engine called |
| FR-5.11 | Stores result in `state.action` | Must | Unit: verify state update |
| FR-5.12 | Logs: cycle number, action type, network, reason | Must | Unit: verify log |

### 2.4 EXECUTE Node

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.13 | Calls `ActionExecutor.execute(state.action)` | Must | Unit: verify executor called |
| FR-5.14 | Stores result in `state.result` | Must | Unit: verify state update |
| FR-5.15 | If action is WAIT → skip executor, set result to {type: 'WAIT'} | Must | Unit: WAIT → no executor call |
| FR-5.16 | Catches execution errors → stores in `state.errors` | Must | Unit: error → state.errors updated |

### 2.5 EVALUATE Node

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.17 | Calculates adaptive sleep based on action type + state | Must | Unit: verify sleep calculation |
| FR-5.18 | Stores sleep duration in `state.sleepMs` | Must | Unit: verify state update |
| FR-5.19 | Actually sleeps for `state.sleepMs` before returning | Must | Integration: verify delay |
| FR-5.20 | Writes heartbeat to Redis with TTL before sleeping | Must | Integration: verify Redis key |

### 2.6 Adaptive Sleep Logic

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.21 | If action was RECOVER_SESSION → sleep 15s | Must | Unit: verify 15s |
| FR-5.22 | If action was any non-WAIT → sleep 60s | Must | Unit: verify 60s |
| FR-5.23 | If action was WAIT + idle → sleep 120s | Must | Unit: verify 120s |
| FR-5.24 | If night (01:00-07:00 UTC) + no pending → sleep 600s | Must | Unit: verify 600s at night |
| FR-5.25 | If circuit breaker open → sleep 60s | Must | Unit: verify 60s |
| FR-5.26 | If rate limited → sleep until reset time (max 3600s) | Must | Unit: verify calculated sleep |
| FR-5.27 | If kill switch → sleep 60s | Must | Unit: verify 60s |

### 2.7 Lifecycle Management

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.28 | `OrchestratorService.start()` begins the graph loop | Must | Unit: start → graph.invoke called |
| FR-5.29 | `OrchestratorService.stop()` gracefully stops the loop | Must | Unit: stop → loop exits |
| FR-5.30 | On startup, if checkpoint exists → resume from checkpoint | Must | Integration: checkpoint → resume |
| FR-5.31 | On startup, if no checkpoint → start fresh cycle 0 | Must | Unit: no checkpoint → fresh start |
| FR-5.32 | Service is started only when `ORCHESTRATOR_ENABLED=true` | Must | Integration: flag check |
| FR-5.33 | Service implements `OnModuleInit` → auto-start when enabled | Must | Integration: verify auto-start |

### 2.8 Crash Recovery

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-5.34 | Checkpoint saved after every EVALUATE node | Must | Integration: verify checkpoint |
| FR-5.35 | On crash + restart, graph resumes from last checkpoint | Must | System: kill + restart → resume |
| FR-5.36 | Checkpoint TTL: 24 hours (configurable) | Must | Unit: verify TTL config |
| FR-5.37 | Heartbeat Redis key TTL: 10 minutes | Must | Unit: verify TTL |
| FR-5.38 | If checkpoint corrupted → start fresh (log warning) | Must | Unit: corrupt → fresh start |

## 3. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Performance | Full cycle (OBSERVE+DECIDE+EXECUTE+EVALUATE) < 12s including LLM |
| Reliability | Survives crash + restart via checkpoint |
| Concurrency | Single instance only (watchdog ensures this) |
| Observability | Every cycle logged. SSE event per cycle. Heartbeat in Redis. |
| Memory | State object < 10KB (summarized, not raw DB rows) |

## 4. State Transitions

```
START
  │
  ▼
OBSERVE ─── collectWorldState() ─── update state.world, state.heartbeat, state.cycle++
  │
  ▼
DECIDE ─── decisionEngine.decide(state.world) ─── update state.action
  │
  ▼
EXECUTE ─── actionExecutor.execute(state.action) ─── update state.result
  │         (skip if action.type === 'WAIT')
  │
  ▼
EVALUATE ─── calculate sleep ─── update state.sleepMs
  │          write heartbeat to Redis
  │          sleep(state.sleepMs)
  │
  ▼
CHECKPOINT ─── save to Redis
  │
  ▼
LOOP ─── → OBSERVE
```

## 5. Acceptance Criteria

- [ ] AC-1: Graph runs continuously: OBSERVE→DECIDE→EXECUTE→EVALUATE→repeat
- [ ] AC-2: After crash + restart, graph resumes from last checkpoint (cycle number preserved)
- [ ] AC-3: Adaptive sleep works: RECOVER=15s, active=60s, idle=120s, night=600s
- [ ] AC-4: Heartbeat written to Redis before every sleep
- [ ] AC-5: WAIT action skips EXECUTE node (no service calls)
- [ ] AC-6: Execution errors are caught and stored, don't crash the loop
- [ ] AC-7: `ORCHESTRATOR_ENABLED=false` → graph never starts
- [ ] AC-8: `ORCHESTRATOR_ENABLED=true` → graph auto-starts on module init
- [ ] AC-9: `stop()` gracefully exits within 5s (doesn't wait for sleep)
- [ ] AC-10: Full cycle completes in < 12s (excluding sleep)
- [ ] AC-11: SSE event emitted at cycle start with cycle number + action
- [ ] AC-12: SSE event emitted at cycle end with result + sleep duration
