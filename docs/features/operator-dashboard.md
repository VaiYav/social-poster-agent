# Feature Proposal: Operator Dashboard

## Document maturity (non-canonical)

Feature status: `PLATFORM-003` in [the canonical register](../planning/FEATURES.md).

**Implemented** (via `HealthMonitorService`, not a separate `DashboardService`). The `GET /dashboard` endpoint lives in `health-monitor.controller.ts` and aggregates pipeline state. The UI screen is `packages/ui/src/views/Dashboard.vue` with flow-control, stats, and recent-posts cards, routed at `/dashboard`.

## Problem

The operator currently has no single endpoint or UI screen that aggregates the state of the whole pipeline. Decisions about approving, pausing, or debugging require cross-referencing `QueueController`, `HealthMonitorController`, `PostsService`, `SessionsService`, and `LlmService` separately. A unified dashboard would reduce MTTR and give operators confidence in autonomous mode.

## Current state

- `modules/analytics/analytics.controller.ts` exposes `GET /analytics/daily`, `/analytics/top`, `/analytics/metrics`.
- `modules/queue/queue.controller.ts` exposes queue stats, failed jobs, pause/resume.
- `modules/health-monitor/health-monitor.controller.ts` exposes dashboard and health check endpoints.
- `modules/events/events.controller.ts` provides SSE for real-time updates.
- `LlmService.getProviderStatus()` exists but is not consumed by a dashboard endpoint.
- No aggregated `/dashboard` resource.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/src/modules/analytics/analytics.controller.ts" lines="1-50" />

## Proposed feature

A single `GET /dashboard` endpoint (and corresponding UI screen) returning a snapshot of the system. Sample payload:

```json
{
  "pendingReview": { "total": 42, "byNetwork": { "X": 30, "THREADS": 8, "FACEBOOK": 4 } },
  "postingToday": { "posted": 12, "failed": 2, "inFlight": 3 },
  "sessions": { "active": 5, "expired": 2, "banned": 1, "warmup": 1 },
  "queueDepth": { "waiting": 8, "active": 3, "failed": 2, "delayed": 5 },
  "flowControl": { "paused": ["X"], "autonomous": true, "orchestratorEnabled": false },
  "llmProviders": [
    { "name": "groq", "available": true, "circuitBreaker": "closed", "rateLimitedUntil": null },
    { "name": "openai", "available": false, "circuitBreaker": "open", "rateLimitedUntil": 175... }
  ],
  "recentAlerts": [
    { "severity": "warning", "message": "X session banned", "timestamp": "..." }
  ],
  "abTestsActive": [
    { "topic": "Mercury retrograde", "variantA": 12, "variantB impressions": 15, "winner": null }
  ],
  "qualityScores": { "mean": 7.2, "rejectedToday": 3 }
}
```

## Key components

1. **`DashboardService`** in `modules/analytics/` (or a new `modules/dashboard/`).
2. **Aggregation over existing services** (no new cron, call services at request time; add caching if it becomes hot).
3. **SSE feed** `dashboard.events` with periodic snapshots every N seconds (or on significant state changes).
4. **UI route/screen** in `@spa/ui` with cards for each section and drill-down links.

## Integration points

- `modules/posts/posts.service.ts` — `pendingReview` counts and recent failed posts.
- `modules/sessions/sessions.service.ts` — session counts by status.
- `modules/queue/queue.service.ts` — queue depth and failed jobs.
- `modules/flow-control/flow-control.service.ts` — pause/resume flags.
- `modules/autonomy/auto-approve.service.ts` — autonomous runner status.
- `modules/orchestrator/orchestrator.service.ts` — `isRunning`, cycle count.
- `infrastructure/llm/llm.service.ts` — `getProviderStatus()`.
- `infrastructure/notifications/discord-notification.service.ts` — recent alert log (or add a tiny in-memory alert log if not persisted).

## Open questions / risks

- Should this endpoint be cached (e.g., 30s) or real-time? For the first version, a 10–30s cache is fine.
- Auth: dashboard is admin-only when `AUTH_ENABLED=true`.
- Some data is expensive to compute (e.g., queue job list); return only counts unless requested.
- Real-time updates should reuse existing SSE channel `spa:sse` with `type: dashboard`.

## Effort estimate

**M–L** (2–4 weeks). Backend aggregation is ~1 week; UI design and widgets are the rest.

## Related reviews

- `analytics.md`
- `queue.md`
- `sessions.md`
- `health-monitor.md`
- `events.md` (SSE)
