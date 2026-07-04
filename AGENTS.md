# AGENTS.md — Project conventions for AI agents

## Langfuse LLM observability (`packages/backend/src/infrastructure/langfuse/`)

### Auto-enable (no feature flag)

Langfuse tracing activates automatically when `LANGFUSE_PUBLIC_KEY` is set — no separate `LANGFUSE_ENABLED` flag. When the env var is absent/empty, `LangfuseService.isEnabled` returns false, `createHandler()` returns undefined, and no callbacks are attached (zero overhead). This is different from the feature-flag pattern used by Engagement/Replies/Orchestrator (which conditionally register entire modules). `LangfuseModule` is a `@Global()` module — always loaded, no-op when disabled.

### OTel SDK initialization (import order matters)

`langfuse-instrumentation.ts` is imported at the top of `main.ts` alongside `instrument.ts` (Sentry). The `NodeSDK` with `LangfuseSpanProcessor` must start before any tracing calls happen. The file exports `langfuseEnabled` and `shutdownLangfuse()` — the latter is called by `LangfuseService.onModuleDestroy()` for graceful flush on shutdown.

### AsyncLocalStorage callback propagation

`LlmService` uses a module-level `AsyncLocalStorage<BaseCallbackHandler[]>` (`callbackStorage`) to propagate Langfuse callbacks through the LangGraph workflow without threading them through every node function signature. `GenerationService` wraps `graph.invoke()` in `withLlmCallbacks(handler, fn)` — all `llm.generateChat()` calls inside graph nodes automatically read the ALS store and attach the callbacks to `model.invoke()`. This is async-safe for concurrent generation runs (up to 3 topics per batch). Callers can also pass callbacks explicitly via `GenerateOptions.callbacks` — those are merged with ALS callbacks (deduped by reference).

### Traced components

- **GenerationService** — one `CallbackHandler` per topic with `sessionId=runId`, `tags=['generation', language, ...networks]`, `traceMetadata={topic, runId, language, networks}`. Applied to all 3 `graph.invoke()` call sites (initial, resume, review-resume) via the `tracedGraphInvoke()` helper that centralises callback wiring.
- **LlmDecisionService** (orchestrator) — one handler per `decide()` call with `tags=['orchestrator', 'decision']`, `traceMetadata={utcHour, utcDayOfWeek, degraded}`.
- **LlmService** — merges ALS callbacks + explicit `options.callbacks`, passes to `model.invoke(messages, { callbacks })` only when callbacks are non-empty (avoids creating empty config objects). Does NOT inject `LangfuseService` — it receives callbacks via `GenerateOptions.callbacks` and ALS only.

### Env vars

`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` — all optional, validated in `env.validation.ts`. Default base URL in `.env.example` is `https://us.cloud.langfuse.com` (US cloud).

### Prompt Management (Langfuse Prompt Management)

All production prompts are stored in Langfuse Prompt Management and can be edited in the Langfuse UI without redeploying. The `PromptRegistry` (`infrastructure/llm/prompt-registry.ts`) fetches from Langfuse first (5-min cache, production label), falls back to local `PromptTemplate` files (`prompts/v0.4.0/`), then to inline fallbacks passed by graph nodes.

**7 prompts in Langfuse:**
- `research-extract` (chat) — fact extraction from topic + outline
- `hook-generation` (chat) — 3-5 scroll-stopping hooks per topic
- `draft-post` (chat) — full post draft per network (X/Threads/Facebook)
- `critique-post` (text) — editor critique with quality score
- `refine-post` (text) — rewrite based on critique
- `orchestrator-system` (text) — orchestrator action selection system prompt
- `post-quality-judge` (chat) — LLM-as-a-Judge quality evaluation

**Migration script:** `packages/backend/scripts/migrate-prompts-to-langfuse.ts` — one-time script that creates all prompts in Langfuse. Run with: `npx tsx --env-file=../../.env scripts/migrate-prompts-to-langfuse.ts`. Re-running creates new versions (Langfuse supports versioning + labels).

**Variable syntax:** Langfuse uses `{{double-brace}}` syntax. Local fallbacks use `{single-brace}` syntax (interpolated by the `interpolate()` helper in `prompt-registry.ts`). Graph nodes pre-compute all variables (including conditional content like `performanceGuidance`, `baitInstruction`) and pass them as strings.

**Prompt-to-trace linking:** `GenerationService` adds `promptNames` to `traceMetadata` so traces can be filtered by which prompts were used. `LlmDecisionService` adds `promptNames: 'orchestrator-system'`.

### LLM-as-a-Judge (Stage 2)

The `post-quality-judge` prompt evaluates each generated post on 4 criteria (0.0-1.0 each):
- `anti_ai_tone` — does it sound human or like ChatGPT?
- `hook_strength` — does the first line stop scrolling?
- `factual_accuracy` — are the astrology facts correct?
- `character_limit` — does it fit the platform's limit?

**Graph integration:** The judge node (`makeJudgeNode`) runs AFTER refine and BEFORE visual_concept in the generation graph. It's non-blocking — if the judge LLM call fails, the post proceeds with `judgeScores: undefined`.

**Score storage:** Judge scores are stored in `NetworkResult.judgeScores` → `GeneratedPost.judgeScores` → `Post.llmMetadata.judgeScores` (as JSON). This enables quality tracking over time and A/B comparison of prompt versions.

**Judge calibration:** To calibrate the judge against human decisions, compare `judgeScores.anti_ai_tone` with operator approve/reject decisions over time. Posts with `anti_ai_tone < 0.5` that were approved by operators indicate the judge is too strict; posts with `anti_ai_tone > 0.8` that were rejected indicate it's too lenient. Adjust the judge prompt in Langfuse UI and track the correlation.

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
