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

## Playwright coreBundle.js post-install patch

Camoufox's Juggler protocol emits `Page.uncaughtError` **without** a `location` field for some uncaught JS errors. Playwright's Firefox driver unconditionally dereferences `pageError.location.url` → `TypeError: Cannot read properties of undefined (reading 'url')`. The crash is in the **driver subprocess** — it kills the browser and **cannot be caught** from the Node client. This breaks engagement browsing sessions (scroll_feed on X/Threads feeds, which throw lots of uncaught third-party JS errors). `suppressPageErrors` in `browser.factory.ts` is useless here — the crash happens in the driver before the event reaches the client.

Refs: [camoufox#635](https://github.com/daijro/camoufox/issues/635), [playwright#41046](https://github.com/microsoft/playwright/issues/41046), [playwright#41169](https://github.com/microsoft/playwright/issues/41169). Upstream Playwright declined the defensive fix (PR #40982) — their own Firefox always supplies `location`; Camoufox doesn't.

**Fix:** `packages/backend/scripts/patch-playwright.js` patches three sites in `playwright-core/lib/coreBundle.js` (null-guard for `pageError.location`). Idempotent. Runs via:
- `postinstall` in `packages/backend/package.json` (local dev)
- `RUN node .../patch-playwright.js` in `docker/Dockerfile.backend` after `pnpm install` (both builder + production stages)

**When upgrading `playwright-core`**: re-run `node packages/backend/scripts/patch-playwright.js` and verify the patch sites still match. The script logs a warning if no sites matched (version drift).
