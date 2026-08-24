# ADR-006: Autonomous Agent Architecture (Full Autonomy Mode)

**Status:** Accepted  
**Date:** 2026-08-18  
**Decider:** Valentyn Yakovliev  
**Supersedes:** None (extends ADR-003 LangGraph generation, ADR-004 hexagonal ports)

## Context

The Social Poster Agent was originally designed with a **human-in-the-loop (HITL) approval gate**:
every generated draft required manual operator approval before posting (DRAFT → APPROVED → POSTING).

As the system matured, the need for **full autonomy** emerged:

1. **Operator bottleneck**: Manual approval of 20-50 drafts/day is tedious and slow
2. **Quality consistency**: LLM quality scores (1-10) are already generated but unused for gating
3. **24/7 operation**: The agent should generate, validate, and post without human presence
4. **Safety automation**: Existing checks (engagement-bait detector, brand-voice, SimHash dedup,
   fact extraction) are already running but not blocking bad content

The goal: **a fully autonomous agent** where the frontend is a monitoring/analytics dashboard,
not an approval queue. The operator can stop/restart flows but does not need to approve
individual posts.

## Decision

Implement a **multi-layer autonomous pipeline** with an auto-approve gate that replaces
the manual HITL step. The pipeline runs on a cron schedule and requires zero operator
intervention for the happy path.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS PIPELINE (cron)                       │
│                                                                     │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐        │
│  │ Generate │──▶│ AutoCheck│──▶│ AutoApprove│──▶│ Schedule │        │
│  │ (LangGraph)│ │ (pipeline)│  │  (gate)   │   │ (BullMQ) │        │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘        │
│       │              │              │              │                │
│       ▼              ▼              ▼              ▼                │
│  GenerationRun  CheckResult  ApproveDecision  ScheduledJob          │
│  (3 posts per   (pass/fail)  (auto/reject/   (delayed enqueue       │
│   topic)                     human-review)    per network)          │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              FLOW CONTROL (Redis flags)                  │      │
│  │  pause_all | pause_generation | pause_posting |          │      │
│  │  pause_engagement | pause_replies                         │      │
│  └──────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     FRONTEND (monitoring dashboard)                 │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Monitor  │  │ Analytics│  │ Reports  │  │ Flow Ctrl│           │
│  │ (live)   │  │ (charts) │  │ (export) │  │ (stop/   │           │
│  │          │  │          │  │          │  │  restart)│           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer 1: AutoCheck Pipeline (content validation)

Runs **after generation, before approval**. A series of synchronous checks that can
reject content before it reaches the auto-approve gate.

| Check | Source (existing) | Action on fail |
|-------|-------------------|----------------|
| Engagement-bait detector | `engagement-bait.detector.ts` | Reject (algorithm penalty) |
| Brand-voice compliance | LLM critique node (qualityScore) | Reject if score < threshold |
| SimHash dedup | `generation.service.ts` | Reject if near-duplicate |
| Character limit | `NETWORK_LIMITS` in generation.graph.ts | Reject (truncation = bad UX) |
| Forbidden phrases | `brand-voice.md` do/don't list | Reject |
| Fact plausibility | LLM fact extraction (Sprint E) | Flag for review if low confidence |

**New module:** `AutoCheckService` — orchestrates all checks, returns
`{ passed: boolean; checks: CheckResult[]; rejectionReason?: string }`.

### Layer 2: AutoApprove Gate

Replaces the manual HITL step. Uses the LLM quality score + AutoCheck results
to make an automated decision.

**Decision matrix:**

| qualityScore | AutoCheck | Decision |
|-------------|-----------|----------|
| ≥ 8 | passed | **AUTO_APPROVE** → enqueue for posting |
| 6-7 | passed | **AUTO_APPROVE** (configurable threshold) |
| 4-5 | passed | **HUMAN_REVIEW** (flag for optional operator review) |
| < 4 | passed | **REJECT** → regenerate with different hook |
| any | failed | **REJECT** → log rejection reason |

**New module:** `AutoApproveService` — reads qualityScore from Post.llmMetadata,
runs AutoCheck, makes decision, transitions Post status.

**Feature flag:** `AUTO_APPROVE_ENABLED=true` (already in env.validation.ts).
When false, falls back to manual HITL (backward compatible).

### Layer 3: Autonomous Generation Cron

A cron job that triggers the full pipeline without operator intervention:

```
cron (every 4h)
  → GenerationService.generate() for N topics
  → AutoCheckService.check() for each generated post
  → AutoApproveService.decide() for each post
  → if AUTO_APPROVE: QueueFactory.enqueuePosting() with delay
  → if HUMAN_REVIEW: leave as DRAFT (operator can review in dashboard)
  → if REJECT: mark as REJECTED, log reason
```

**New module:** `AutonomousRunnerService` — orchestrates the cron-driven pipeline.

### Layer 4: Flow Control (pause/restart)

Redis-based flags that allow the operator to pause any flow without restarting
the backend:

| Flag | Scope | Effect |
|------|-------|--------|
| `flow:pause_all` | Global | Pauses generation, posting, engagement, replies |
| `flow:pause_generation` | Generation | Stops new generation runs (in-flight completes) |
| `flow:pause_posting` | Posting | Stops enqueueing new posts (in-flight completes) |
| `flow:pause_engagement` | Engagement | Stops engagement sessions |
| `flow:pause_replies` | Replies | Stops reply monitoring |

**New module:** `FlowControlService` — reads/writes Redis flags, exposed via REST API
and visible in frontend dashboard.

**Crisis mode:** `POST /flow-control/pause-all` sets all flags at once.

### Layer 5: Frontend Monitoring Dashboard

The frontend transforms from an **approval queue** to a **monitoring/analytics dashboard**:

| View | Purpose | Autonomy role |
|------|---------|---------------|
| Dashboard | Pipeline stats, success rates, autonomous mode status | At-a-glance health |
| Monitor | Live event feed, active flows, queue health | Real-time monitoring |
| Analytics | Engagement metrics, content performance, trend analysis | Data-driven tuning |
| Reports | CSV/PDF export, weekly summaries, audit trail | Compliance/reporting |
| Flow Control | Pause/restart buttons per flow, crisis mode | Emergency intervention |
| Queue | Read-only post history (no approval needed) | Audit/review |
| Generate | Manual trigger (optional, for ad-hoc content) | Override autonomy |

## Rationale

- **Existing infrastructure**: LangGraph, BullMQ, SSE, SimHash, engagement-bait detector,
  quality scores — all already exist. Autonomy is an orchestration layer on top.
- **Feature-flagged**: `AUTO_APPROVE_ENABLED` default=false → backward compatible.
  Operators can enable autonomy incrementally.
- **Safety layers**: AutoCheck + AutoApprove + Flow Control = 3 layers of protection
  before content reaches social platforms.
- **Observable**: All autonomous decisions are logged with reasons. The dashboard
  shows what was auto-approved, what was rejected, and why.
- **Reversible**: Flow control allows instant pause of any flow. Crisis mode
  stops everything in one click.

## Consequences

**Positive:**
- Zero operator intervention for happy path (saves 2-4h/day of manual work)
- 24/7 content generation and posting
- Consistent quality gating (LLM score + checks > human judgment for routine content)
- Full audit trail of auto-approve/reject decisions
- Operator can focus on exceptions (HUMAN_REVIEW queue) instead of every draft
- Frontend becomes a monitoring tool, not a bottleneck

**Negative:**
- Risk of bad content slipping through if AutoCheck thresholds are too lenient
- Requires tuning quality score thresholds per network (X vs Facebook audience)
- Initial period of monitoring auto-approved content to build trust
- More complex than pure HITL (5 new services/modules)
- Need alerting for autonomous failures (Discord/Sentry already integrated)

## Mitigations

1. **Conservative thresholds initially**: qualityScore ≥ 8 for auto-approve,
   lower to 6 after 100+ successful auto-posts
2. **HUMAN_REVIEW fallback**: scores 4-7 stay as DRAFT for optional review
3. **Flow Control**: instant pause if anything goes wrong
4. **Audit trail**: every auto-approve/reject logged with reason + timestamp
5. **Discord alerts**: auto-notify on REJECT streaks (>3 consecutive rejects)
6. **Daily report**: autonomous summary posted to Discord every 24h

## Implementation Plan

### Phase 1: AutoCheck + AutoApprove (3-4 days)
- `AutoCheckService` — orchestrates existing checks
- `AutoApproveService` — decision matrix + status transition
- Wire into `GenerationService.generate()` post-generation hook
- Unit tests for all check combinations

### Phase 2: Autonomous Runner (2-3 days)
- `AutonomousRunnerService` — cron-driven pipeline
- `AutonomousModule` — NestJS module with providers
- Integration tests with mocked LLM + browser

### Phase 3: Flow Control (1-2 days)
- `FlowControlService` — Redis flags
- `FlowControlController` — REST API (pause/resume/status)
- Wire into all services (generation, posting, engagement, replies check flags)

### Phase 4: Frontend Dashboard (3-4 days)
- Transform Queue view → read-only history
- Add Flow Control view (pause/restart buttons)
- Enhance Analytics (autonomous metrics, auto-approve rate, reject reasons)
- Add Reports view (CSV export, weekly summary)

### Phase 5: Tuning & Monitoring (ongoing)
- Monitor auto-approve rate, reject reasons, engagement metrics
- Adjust thresholds based on real performance data
- Add anomaly detection (engagement drop → auto-pause)

## Alternatives Considered

1. **Keep HITL only**: Rejected — operator bottleneck limits scale, 24/7 impossible
2. **External approval tool (Slack/Telegram bot)**: Rejected — adds external dependency,
   still requires human, latency for approval
3. **Full auto without checks**: Rejected — too risky, brand damage from bad content
4. **Hybrid (auto-approve low-risk, HITL for high-risk)**: Partially adopted —
   HUMAN_REVIEW tier (scores 4-7) allows optional review of borderline content

## References

- ADR-003: LangGraph generation workflow (foundation for AutoCheck integration)
- ADR-004: Hexagonal ports (AutoCheck/AutoApprove as domain services)
- ADR-005: SSE real-time (autonomous events → dashboard)
- CONSTITUTION §10: Generation pipeline architecture
- CONSTITUTION §12: Risk register (autonomy risk mitigation)
- FEATURE_WISHLIST.md: F1 (Autonomous Agent), F11 (Best Time to Post)
