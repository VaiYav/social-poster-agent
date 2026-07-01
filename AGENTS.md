# AGENTS.md — Project conventions for AI agents

## Orchestrator module (`packages/backend/src/modules/orchestrator/`)

### Direct `process.env` reads (by design)

Some utilities read `process.env` directly instead of using NestJS `ConfigService`:
- `getEnabledNetworks()` (`domain/enabled-networks.ts`) — used in static contexts, module loaders, and service constructors without DI
- `isOrchestratorEnabled()` (`modules/orchestrator/feature-flag.ts`) — checked in `onModuleInit()` of 11 cron services to skip cron registration when orchestrator is enabled
- `app.module.ts` — reads env at module-load time to conditionally register modules

This is intentional. `ConfigService` is only available after DI bootstrap, but these functions run during module loading. Don't "fix" this by switching to `ConfigService`.

### Import style

Orchestrator module files use `.js` extensions in imports (e.g., `import { X } from './foo.js'`) — required for ESM compatibility. Other modules in the codebase may omit `.js` extensions (CJS style). When editing orchestrator files, always use `.js` extensions.

### Service architecture (post-refactor)

- `OrchestratorService` — lifecycle (start/stop), graph loop, heartbeat, sleep, status
- `OrchestratorHistoryService` — Redis-backed cycle history
- `DecisionEngineService` — thin orchestrator: delegates to HardRules → LLM → Guardrails
- `HardRulesService` — H1-H10 deterministic safety checks + RECOVER cooldown
- `LlmDecisionService` — LLM call + JSON response parsing + timeout
- `GuardrailsService` — G1-G7 validation/clamping
- `ActionExecutorService` — dispatches to IActionHandler strategies via Map
- `IActionHandler` implementations (`action-handlers.ts`) — one per action type
- `StateCollectorService` — OBSERVE node, parallel per-network collection
- `PostingWindowService` — engagement heatmap + posting window recommendations
- `WatchdogCron` — safety net cron (`@Cron('*/5 * * * *')`, the only remaining `@Cron` decorator in the codebase), restarts orchestrator if heartbeat stale

### Cron services (post-refactor)

All 11 cron services (CronService, EngagementScheduler, SessionsService, TrendingScraper, MetricsScraper, RecyclingService, HookPerformanceBank, AutonomousRunner, RepliesMonitor, TopicGeneration, HealthMonitor) use **dynamic cron registration** via `SchedulerRegistry.addCronJob()` in `onModuleInit()`. When `ORCHESTRATOR_ENABLED=true`, they skip registration entirely — no timer, no CPU, no memory. The `@Cron` decorator is no longer used (except `WatchdogCron`). The old `skipIfOrchestrator()` guard function has been removed; use `isOrchestratorEnabled()` at registration time instead.

### Feature-flagged services

`BrowsingSessionService` and `RepliesMonitorService` are behind feature flags. The orchestrator depends on them via Symbol DI tokens (`IBrowsingSessionPort`, `IRepliesMonitorPort`) in `ports.ts`, not concrete classes. The engagement/replies modules bind the tokens via `useExisting` only when their feature flag is on.

### Build/test commands

```bash
# Typecheck
cd packages/backend && npx tsc --noEmit

# Unit tests
cd packages/backend && npx vitest run tests/unit/

# Full test suite
cd packages/backend && npx vitest run
```
