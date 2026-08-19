# 06 — Self-Healing & Graceful Degradation

## Status

Proposal. SPA has retries, circuit breakers, and a `HealthMonitorService`, but no unified model of degradation levels and automatic recovery.

## Problem

The user wants a "more stable system that knows how to recover itself" — failures should lead to recovery, not just retries. Current gaps:

- `LlmService` fails over to the next provider, but there is no global "LLM subsystem degraded" signal.
- `BrowserFactory` context crashes are handled ad-hoc in `PostingService`.
- `SessionsService` login failures accumulate but do not degrade gracefully to "wait and probe".
- `Queue` workers can stall; stuck `POSTING` posts are cleaned by reconciliation, but there is no recovery policy.
- SSE clients lose events on reconnect (`Last-Event-ID` not implemented).
- There is no dashboard concept of "system is degraded but operating".

## Product Outcome

A unified resilience layer that:

1. Tracks health per subsystem in 4-5 explicit levels.
2. Automatically degrades to safe fallbacks when a subsystem is unhealthy.
3. Probes recovery with canary operations.
4. Re-promotes subsystems to healthy when probes pass.
5. Surfaces degradation status in the operator dashboard and batched alerts.

## Degradation Levels

| Level | Meaning | Example |
|-------|---------|---------|
| `HEALTHY` | Normal operation | All providers responsive |
| `DEGRADED` | Fallback active, service continues | Using cheaper LLM, text-only image, cached response |
| `RECOVERING` | Probing after failure | One login attempt every 5 min |
| `CRITICAL` | Feature paused, will retry | Account banned, queue worker stopped |
| `DOWN` | Needs human intervention | All LLM providers down, DB unreachable |

## Subsystems to Monitor

- LLM provider pool
- Langfuse prompt fetch
- Browser / session pool per account
- Posting per account/network
- BullMQ queue workers
- Redis
- PostgreSQL / Prisma
- Image generation
- Content source (CAP vs DB topics)

## Resilience Patterns

From external research:
- Graceful degradation patterns: https://sujeet.pro/articles/graceful-degradation
- Self-healing microservices framework (case study: MTTR 38 min → 12 sec): https://www.ijirset.com/upload/2024/june/292_Designing%20Self-Healing%20Microservices%20in%20Cloud-Native%20Architectures.pdf

Patterns to apply:

- **Circuit breakers with half-open probes** — already partially in `LlmService`; extend to login and posting per account.
- **Bulkheads** — isolate accounts/networks so one failure does not block others. Per-account queues and per-account browser contexts (Feature 01).
- **Retry budgets** — cap retries per account/day; after budget, defer to DLQ.
- **Fallback chains** — fresh → cached → simpler model → static/default → skip.
- **Staggered recovery with jitter** — avoid thundering herd after recovery.
- **Synthetic canaries** — cheap periodic operations that prove a subsystem is healthy.

## Graceful Degradation Table

| Failure | Degraded Behavior | Recovery Probe |
|---------|-------------------|----------------|
| LLM provider 429/5xx | Use next provider; if all fail, use cache or pause auto | Cheap completion prompt every 60s |
| Langfuse prompt fetch fails | Use inline fallback prompts | Try fetch every 5 min |
| Browser context crash | Release, re-acquire, retry once | Login health check every 5 min |
| Session/login fails | Mark account `BANNED`/`ERROR`; pause posting; try re-login later | Login attempt with jitter |
| Rate limit hit | Defer post via BullMQ; no immediate retry until window | Rate-limit status check |
| Image generation fails | Post text-only | Generate a test image every hour |
| Judge/critique fails | Skip judge scores, continue with draft | Call judge on a sample post |
| Queue worker stall | Requeue `POSTING` posts older than threshold | Worker heartbeat |
| Redis unavailable | Use in-memory fallback, alert | Redis ping |
| DB connection error | Pause stateful operations, queue writes | DB ping |

## New Service: `ResilienceService`

Domain port `IResiliencePort` and implementation `ResilienceService`:

```ts
export interface IResiliencePort {
  reportHealth(subsystem: string, level: DegradationLevel, reason?: string): Promise<void>;
  getHealth(subsystem: string): Promise<HealthSnapshot>;
  withFallback<T>(subsystem: string, options: FallbackOptions, fn: () => Promise<T>): Promise<T>;
  scheduleProbe(subsystem: string, probe: () => Promise<boolean>, intervalMs: number): void;
}
```

Store health in Redis:

```
spa:health:{subsystem} -> { level, since, reason, lastProbe, consecutiveProbes, nextProbeAt }
```

## Integration Points

| Component | Change |
|-----------|--------|
| `LlmService` | Wrap `invokeWithFallback` with resilience reporting; expose `cost/quality` budget |
| `BrowserFactory` | Report context crash; trigger re-acquire and session recovery |
| `SessionsService` | Use per-account circuit breaker with half-open probe; report `login:{accountId}` health |
| `PostingService` | Check subsystem health before posting; degrade to text-only image on image upload failure |
| `QueueFactory` / workers | Report worker liveness; reschedule stuck `POSTING` posts |
| `HealthMonitorService` | Write health snapshots to Redis; run recovery probes |
| `FlowControlService` | `ResilienceService` can pause/unpause posting/networks |
| `SseService` | Implement `Last-Event-ID` replay (`docs/refactor/phase-6-7-p3-strategic-features.md` 6.8) |
| `DiscordNotificationService` | Batch alerts and cooldowns (`docs/refactor/phase-6-7-p3-strategic-features.md` 6.9) |

## Recovery Loop

```
1. Failure detected -> subsystem DEGRADED
2. Fallback behavior active
3. After cooldown, run canary probe (with jitter)
4. Probe success -> RECOVERING -> another success -> HEALTHY
5. Probe failure -> remain DEGRADED, double cooldown up to max
```

For **banned accounts**, use the existing `BANNED` → `RECOVER` flow with `bannedAt` field (`docs/refactor/phase-6-7-p3-strategic-features.md` 7.7):

- Mark `BANNED` after N consecutive failures in a window.
- Set `recoveryNextAt` based on `BAN_RECOVERY_HOURS`.
- Probe by attempting a low-risk operation (e.g. navigate to profile).
- On success, mark `ACTIVE` and gradually ramp posting.

## UI / API

- `GET /health/degradation` — full subsystem health map.
- Dashboard "System Health" panel with levels and actions (force probe, pause subsystem).
- Batched alerts instead of one Discord message per failure.

## Metrics

Add Prometheus endpoint `/health/metrics` (existing proposal 7.8):

```
spa_degradation_level{subsystem="llm"} 0..4
spa_recovery_probes_total{subsystem="browser",result="success"}
spa_recovery_probes_total{subsystem="browser",result="failure"}
spa_posts_text_only_fallback_total{account_id="..."}
```

## Testing

- Unit tests for `ResilienceService` state machine.
- Integration tests that simulate LLM provider failure and verify fallback.
- Chaos-style tests: kill Redis, kill browser context, verify graceful behavior.

## Risks

| Risk | Mitigation |
|------|------------|
| False recovery triggers more bans | Use conservative probe intervals and low-risk operations |
| Over-engineering | Start with 3 subsystems: LLM, browser/session, posting queue |
| Alert fatigue | Batch alerts with cooldowns per subsystem per account |
| Recovery loops never stabilize | Cap max cooldown, escalate to human after threshold |

## Acceptance Criteria

- [ ] `IResiliencePort` and `ResilienceService` track subsystem health in Redis.
- [ ] LLM, browser/session, and posting subsystems report health.
- [ ] Degradation table is implemented for at least 5 failure modes.
- [ ] Recovery probes with jitter are implemented for banned accounts and LLM providers.
- [ ] Dashboard shows subsystem health and recovery status.
- [ ] Alerts are batched with cooldowns.

## Open Questions

- Should health levels be per-account or global per subsystem? (Likely both: global LLM health, per-account session health.)
- Which canary operations are safe enough to run automatically without annoying platforms?
- Should recovery be fully autonomous for bans, or require human approval after a timeout?

## Effort Estimate

**L** (3-5 weeks). Core state machine is moderate; the work is integrating it everywhere without breaking existing flows.

## Related Internal Docs

- `packages/backend/src/modules/health-monitor/health-monitor.service.ts`
- `packages/backend/src/modules/posting/posting.service.ts`
- `packages/backend/src/modules/sessions/sessions.service.ts`
- `packages/backend/src/infrastructure/llm/llm.service.ts`
- `packages/backend/src/infrastructure/sse/sse.service.ts`
- `packages/backend/src/infrastructure/notifications/discord-notification.service.ts`
- `docs/refactor/phase-6-7-p3-strategic-features.md` (6.8 SSE replay, 6.9 alert batching, 7.7 bannedAt, 7.8 Prometheus)
