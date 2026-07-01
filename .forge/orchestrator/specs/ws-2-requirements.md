# WS-2 Requirements: Decision Engine

> V-Model Phase: V1 (Requirements)
> Work Stream: WS-2 — Decision Engine (DECIDE node)
> Criticality: Critical — wrong decisions = wrong actions = bans/wasted posts

---

## 1. Purpose

The Decision Engine chooses the next action for the orchestrator to execute.
It uses a three-phase approach: hard rules (safety), LLM (optimization),
guardrails (validation). This ensures safety-critical decisions are
deterministic while allowing LLM flexibility for soft optimization.

## 2. Functional Requirements

### 2.1 Hard Rules (Phase 1 — Deterministic)

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-2.1 | If `flowControl.pauseAll === true` → return WAIT(60s) with reason "kill switch" | Must | Unit: paused state → WAIT |
| FR-2.2 | If any session is EXPIRED → return RECOVER_SESSION for that network | Must | Unit: expired session → RECOVER |
| FR-2.3 | If any session is BANNED → return WAIT(300s) with reason "banned" | Must | Unit: banned session → WAIT |
| FR-2.4 | If circuit breaker is OPEN for a network → return WAIT(60s) | Must | Unit: open breaker → WAIT |
| FR-2.5 | If rate limit dailyRemaining === 0 for all networks → return WAIT until reset | Must | Unit: no remaining → WAIT |
| FR-2.6 | If DLQ depth > 10 → return HEALTH_CHECK with reason "DLQ overflow" | Must | Unit: high DLQ → HEALTH_CHECK |
| FR-2.7 | If stuckPosting > 5 → return RECONCILE | Must | Unit: stuck posts → RECONCILE |
| FR-2.8 | If bans > 0 → return WAIT(300s) with reason "ban detected" | Must | Unit: bans → WAIT |
| FR-2.9 | If queueDepth > 5 for a network → return WAIT(60s) with reason "queue backed up" | Must | Unit: deep queue → WAIT |
| FR-2.10 | Hard rules are checked in priority order — first match wins | Must | Unit: multiple conditions → highest priority |
| FR-2.11 | Hard rules NEVER call LLM — pure deterministic code | Must | Code review: no ILlmPort in hard rules |
| FR-2.12 | If no hard rule matches → proceed to LLM phase | Must | Unit: clean state → LLM called |

### 2.2 LLM Decision (Phase 2 — Soft Optimization)

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-2.13 | LLM receives summarized WorldState (not raw DB objects) | Must | Unit: verify prompt format |
| FR-2.14 | LLM prompt includes: topic pool, drafts, sessions, rate limits, timing, windows, performance, trends, health | Must | Unit: verify all fields in prompt |
| FR-2.15 | LLM must return structured JSON: `{action, network, reason}` | Must | Unit: parse JSON response |
| FR-2.16 | If LLM fails (timeout/error/circuit open) → fall back to rules-only decision | Must | Unit: mock LLM error → rules fallback |
| FR-2.17 | If `ORCHESTRATOR_LLM_ENABLED=false` → skip LLM, use rules-only fallback | Must | Unit: flag off → no LLM call |
| FR-2.18 | LLM is only called when hard rules don't match (optimization, not safety) | Must | Unit: hard rule match → no LLM call |
| FR-2.19 | LLM response is logged with full prompt + response for audit | Must | Integration: verify log output |
| FR-2.20 | LLM call has 10s timeout — if exceeded, fall back to rules | Must | Unit: mock slow LLM → fallback |

### 2.3 Rules-Only Fallback (when LLM disabled or failed)

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-2.21 | If topicPool < threshold → GENERATE_TOPICS | Must | Unit: low pool → GENERATE_TOPICS |
| FR-2.22 | If approved drafts > 0 AND inPostingWindow → POST for that network | Must | Unit: drafts + window → POST |
| FR-2.23 | If approved drafts > 0 AND NOT inPostingWindow → WAIT until next window | Must | Unit: drafts + no window → WAIT |
| FR-2.24 | If topicPool >= threshold AND approved === 0 → GENERATE_POSTS | Must | Unit: pool full + no drafts → GENERATE_POSTS |
| FR-2.25 | If lastBrowse > 4h AND session active → BROWSE | Should | Unit: stale browse → BROWSE |
| FR-2.26 | If uncheckedReplies > 0 → CHECK_REPLIES | Should | Unit: replies waiting → CHECK_REPLIES |
| FR-2.27 | If trends lastRefresh > 2h → REFRESH_TRENDS | Should | Unit: stale trends → REFRESH |
| FR-2.28 | If none of above → WAIT(120s) | Must | Unit: idle state → WAIT |

### 2.4 Guardrails (Phase 3 — Validation)

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-2.29 | Validate action type is in allowed set | Must | Unit: invalid type → WAIT |
| FR-2.30 | Validate network is in ENABLED_NETWORKS | Must | Unit: disabled network → WAIT |
| FR-2.31 | If action is POST: check rate limit remaining > 0 | Must | Unit: no remaining → WAIT |
| FR-2.32 | If action is POST/BROWSE: check session is ACTIVE | Must | Unit: expired session → RECOVER |
| FR-2.33 | If action is POST: check queue depth < 5 | Must | Unit: deep queue → WAIT |
| FR-2.34 | Track actions per hour — if > 15 → WAIT | Must | Unit: 16th action → WAIT |
| FR-2.35 | If flow is paused for specific action type → WAIT | Must | Unit: paused flow → WAIT |
| FR-2.36 | Guardrail override is logged with original vs clamped action | Must | Unit: verify log |

## 3. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Performance | Hard rules < 1ms. LLM phase < 10s. Guardrails < 1ms. Total < 11s. |
| Reliability | Never throws — always returns an Action (even if WAIT) |
| Determinism | Hard rules are 100% deterministic (same input → same output) |
| Auditability | Every decision logged with: input state, phase matched, action chosen, reason |
| Cost | LLM called only when hard rules pass (estimated < 20 calls/day) |

## 4. Decision Priority Order

```
1.  H1: pauseAll          → WAIT(60s)
2.  H2: session EXPIRED   → RECOVER_SESSION
3.  H3: session BANNED    → WAIT(300s)
4.  H4: circuit OPEN      → WAIT(60s)
5.  H5: dailyLimit=0      → WAIT(until reset)
6.  H6: weeklyLimit=0     → WAIT(until reset)
7.  H7: DLQ > 10          → HEALTH_CHECK
8.  H8: stuck > 5         → RECONCILE
9.  H9: bans > 0          → WAIT(300s)
10. H10: queue > 5        → WAIT(60s)
    ── no hard rule → LLM phase ──
11. LLM decision          → (any action)
    ── guardrails ──
12. G1-G8: validate       → (action or WAIT)
```

## 5. Acceptance Criteria

- [ ] AC-1: Expired session → RECOVER_SESSION (not POST, not WAIT)
- [ ] AC-2: All rate limits exhausted → WAIT (not POST)
- [ ] AC-3: Kill switch active → WAIT (nothing else runs)
- [ ] AC-4: Clean state with approved drafts in posting window → POST
- [ ] AC-5: Clean state, no drafts, pool full → GENERATE_POSTS
- [ ] AC-6: LLM returns POST for disabled network → guardrail overrides to WAIT
- [ ] AC-7: LLM fails → rules-only fallback works correctly
- [ ] AC-8: 16th action in an hour → guardrail overrides to WAIT
- [ ] AC-9: Decision log includes: state summary, phase, action, reason
- [ ] AC-10: No unhandled exceptions — always returns an Action
