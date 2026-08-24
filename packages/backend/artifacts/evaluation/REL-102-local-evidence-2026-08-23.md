# REL-102 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local source/unit/UI evidence only; no provider, real Redis/Postgres chaos, staging, production, or manual recovery evidence.

## Implemented

- `ResilienceModule` is global and binds `IResiliencePort` to `ResilienceService`.
- LLM router reports `HEALTHY` after a successful/fallback response and `CRITICAL` after total
  provider failure, without turning telemetry failure into an LLM failure.
- Browser disconnects report `browser=CRITICAL`; a fresh launch reports `browser=HEALTHY`.
- Queue workers report `HEALTHY` on completion and `CRITICAL` on failed/stalled jobs, and register
  jittered recovery probes for queue liveness.
- Posting reports per-account health; session login/health checks register jittered per-account
  probes for expired/banned sessions.
- LLM provider availability is registered as a deferred jittered probe, so a provider chain can
  recover without waiting for a generation request.
- `HealthMonitorService` aggregates sessions/posting/queue health and runs due recovery probes.
- Readiness probes report PostgreSQL, Redis and queue health to the resilience store.
- `GET /health/degradation` exposes sorted subsystem snapshots to the admin UI.
- Monitor renders subsystem levels, reasons, probe streaks and refresh/error states.

Review reconciliation runs independently of the posting path: in cron mode it uses the
`review-feedback-sync` scheduler job; in orchestrator mode OBSERVE calls the bounded
`FeedbackSyncService.syncIfDue()` path.

## Local evidence

- Focused resilience/LLM/queue/health/state tests — exit 0, 4 files / 137 tests.
- Full backend unit suite — exit 0, 148 files / 1,865 tests.
- Backend `pnpm exec tsc --noEmit --pretty false` — exit 0.
- UI full Vitest suite — exit 0, 16 files / 93 tests.
- UI type-check and production build — exit 0.
- Focused formatting/lint and `git diff --check` — exit 0.

## Not proven

`REL-102` remains `VERIFY`: no real provider failover, Redis/Postgres kill-and-recover,
browser process crash, staging soak, production health snapshot, or manual recovery drill was run.
