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

All production prompts are stored in Langfuse Prompt Management and can be edited in the Langfuse UI without redeploying. The `PromptRegistry` (`infrastructure/prompt/prompt-registry.ts`) is a thin facade that implements `IPromptPort` (`domain/ports/prompt.port.ts`). It fetches from Langfuse first (5-min cache, production label, 3s timeout, 1 retry, circuit breaker), then falls back to the inline fallback prompts defined in `modules/generation/prompts/fallback-prompts.ts` and passed by graph nodes.

**Architecture (hexagonal):** Consumers (`generation.graph.ts`, `LlmDecisionService`, `LlmService`) depend on `IPromptPort` (domain port), not the concrete `PromptRegistry`. The port is bound in `PromptRegistryModule` (`@Global`) via `{ provide: IPromptPort, useExisting: PromptRegistry }`. `LlmModule` no longer re-exports `PromptRegistryModule` — it's imported separately in `app.module.ts`.

**SDK native fallback:** The Langfuse SDK's `prompt.get()` accepts a `fallback` parameter — if the fetch fails, the SDK returns a prompt client with `isFallback: true` containing the fallback content. `PromptRegistry` converts inline fallbacks from `{var}` to `{{var}}` Mustache syntax (via `toMustache()`) before passing to the SDK. This eliminates the manual 3-tier fallback chain.

**Circuit breaker:** `LangfuseService` wraps prompt fetches in a `CircuitBreaker` (3 failures → 1 min cooldown). When the circuit is open, fetches return `undefined` immediately, triggering fallback without waiting for timeouts.

**7 prompts in Langfuse:**
- `research-extract` (chat) — fact extraction from topic + outline
- `hook-generation` (chat) — 3-5 scroll-stopping hooks per topic
- `draft-post` (chat) — full post draft per network (X/Threads/Facebook)
- `critique-post` (text) — editor critique with quality score
- `refine-post` (text) — rewrite based on critique
- `orchestrator-system` (text) — orchestrator action selection system prompt
- `post-quality-judge` (chat) — LLM-as-a-Judge quality evaluation

**Migration script:** `packages/backend/scripts/migrate-prompts-to-langfuse.ts` — one-time script that creates all prompts in Langfuse. Run with: `npx tsx --env-file=../../.env scripts/migrate-prompts-to-langfuse.ts`. Re-running creates new versions (Langfuse supports versioning + labels).

**Variable syntax:** Langfuse uses `{{double-brace}}` Mustache syntax. Inline fallbacks in graph nodes use `{single-brace}` syntax (interpolated by `interpolate()` in `domain/prompt-interpolation.ts` when Langfuse is disabled). The `toMustache()` helper (same file) converts `{var}` → `{{var}}` before passing fallbacks to the SDK. Graph nodes pre-compute all variables (including conditional content like `performanceGuidance`, `baitInstruction`) and pass them as strings.

**Prompt-to-trace linking:** `GenerationService` adds `promptNames` to `traceMetadata` so traces can be filtered by which prompts were used. `LlmDecisionService` adds `promptNames: 'orchestrator-system'`.

### LLM-as-a-Judge (Stage 2)

The `post-quality-judge` prompt evaluates each generated post on 4 criteria (0.0-1.0 each):
- `anti_ai_tone` — does it sound human or like ChatGPT?
- `hook_strength` — does the first line stop scrolling?
- `factual_accuracy` — are the stated facts correct?
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

## Browser memory optimization (`packages/backend/src/infrastructure/browser/browser.factory.ts`)

### firefox_user_prefs (launch-time, global)

Camoufox/Firefox consumes ~340-500 MB RSS per process (benchmark: [camoufox#87](https://github.com/daijro/camoufox/issues/87)). `BrowserFactory` applies memory-saving `firefox_user_prefs` at launch via the `firefox_user_prefs` field of `LaunchOptions` (camoufox-js). Gated by `CAMOUFOX_MEMORY_PREFS=true` (default on). Prefs applied:

- **Session history**: `max_total_viewers=0`, `max_entries=3` — automation never uses go_back/go_forward, cached viewers are pure overhead (~10-30 MB each).
- **Session restore**: `max_tabs_undo=0`, `resume_from_crash=false` — automation controls lifecycle.
- **Focus/IME**: `focusmanager.testmode=false` — Camoufox defaults to `true` for headless, but this breaks real key events in X's DraftJS/Lexical composer and prevents typing in some IME/Cyrillic scenarios.
- **Cache**: `disk.enable=false`, `memory.capacity=65536` (64 MB cap), `media.memory_cache_max_size=16384` — default auto-sizes to 50-100 MB+ in containers. The previous 16 MB / 8 MB caps were too aggressive and caused the X compose page (React/Lexical) to crash the Camoufox renderer.
- **JS GC**: `high_water_mark=256` (trigger GC at 256 MB vs default ~256), `gc_incremental_slice_ms=5`, `compact_on_user_inactive=true` + delay 5000 — less aggressive than the earlier 128 MB mark to avoid crashes on X's heavy SPA.
- **Memory pressure**: `memory.free_dirty_pages=true` — aggressive dirty page freeing (helps jemalloc fragmentation).
- **Image decode**: `image.mem.decode_bytes_at_a_time=8192` (configurable via `CAMOUFOX_IMAGE_DECODE_CHUNK`) — fix for camoufox#87 OOM on scroll; the previous 4096 default was too aggressive for X's compose page and 32768 (Camoufox default) causes excessive memory on media-heavy feeds.
- **Telemetry/devtools**: `datareporting.policy.dataSubmissionEnabled=false`, `toolkit.telemetry.reportingpolicy.firstRun=false`, `devtools.jsonview.enabled=false` — no background network traffic.

**Intentionally NOT touched**: `dom.ipc.processCount` — Camoufox enables fission/web-content-isolation for anti-detect (WAF suspicion). Lowering processCount would risk detection. Playwright's `playwright.cfg` sets `dom.ipc.processCount=60000` and some prefs there cannot be overridden via `firefox_user_prefs` (known limitation, [playwright#15405](https://github.com/microsoft/playwright/issues/15405)) — but cache/session-history/JS-GC prefs apply fine.

Applied to both `launchBrowser()` (X/Threads pooled contexts) and `launchPersistentContext()` (Facebook persistent context). For persistent contexts, Playwright writes prefs to `user.js` in the profile dir.

### Resource blocking (`applyResourceBlocking`, runtime, per-page)

`IBrowserPort.applyResourceBlocking(page, { blockImages })` centralises `page.route()` request interception. Media + fonts are blocked at every call site (no use case needs them). Images are blocked only when `opts.blockImages=true` AND `CAMOUFOX_BLOCK_IMAGES_READONLY=true` (default on).

**Call sites (read-only contexts — all block media + fonts + images):**
- `browsing-session.service.ts` (engagement scroll) — `blockImages: true` (only needs text for like/comment)
- `trending-scraper.service.ts` (X trends scrape) — `blockImages: true` (only needs trend label text)
- `base.poster.ts` `verifyPosted()` — `blockImages: true` (only needs post text + URL pattern)
- `replies-monitor.service.ts` (comment scraping) — `blockImages: true` (scrolls media-heavy feeds for comment text)

**NOT called on:**
- **Posting path (x/threads/facebook posters)** — no resource blocking; full page render needed for compose + visual verification
- **Sessions service** (login flows) — no blocking; login pages may need full render

**Why per-page `page.route()` instead of launch-time `block_images`**: `page.route()` is runtime — no browser relaunch needed to toggle, and posting path keeps images. Launch-time `permissions.default.image=2` would block globally including posting.

### Existing memory infrastructure (pre-existing, not part of this optimization)

`BrowserFactory` already has: pool size=1 (default), idle context TTL=3 min, orphan context sweep, browser lifetime restart (15 min default, `BROWSER_MAX_LIFETIME_MS`), persistent (Facebook) context idle close (`PERSISTENT_CONTEXT_IDLE_TTL_MS`). These handle *process lifecycle* memory; the new `firefox_user_prefs` + resource blocking handle *in-process* memory.

## Redis memory and BullMQ

- `CHECKPOINT_TTL_SECONDS` defaults to 3600 (1 hour). Generation checkpoints are deleted immediately after a successful run (`RedisCheckpointSaver.deleteRunCheckpoints`). Failed/paused runs keep checkpoints until TTL expires.
- `CHECKPOINT_REDIS_URL` can point checkpoints to a separate Redis instance. If unset, checkpoints use the shared `REDIS_URL` connection.
- `BULLMQ_EVENTS_MAX_LENGTH` (default 100) caps the BullMQ events stream per queue. The app does not use `QueueEvents`, so setting it to 0 is safe and disables the stream entirely.
- `BULLMQ_REMOVE_ON_COMPLETE` / `BULLMQ_REMOVE_ON_FAIL` control job retention.
- **Railway / managed Redis:** do not set `maxmemory-policy` to `allkeys-lru` on the same Redis instance used by BullMQ. BullMQ requires `noeviction` to avoid silently losing jobs. If you want to use `allkeys-lru` for checkpoints, set `CHECKPOINT_REDIS_URL` to a separate Redis instance and keep `REDIS_URL` on `noeviction`.

## Camoufox 0.12+ update (2026-08-22)

`BrowserFactory` now passes the full `camoufox-js@0.12.0` `LaunchOptions` surface to `Camoufox()`, controlled from `.env`:

- `CAMOUFOX_HEADLESS` accepts `true` | `false` | `virtual` (virtual uses an Xvfb buffer in headless environments).
- `CAMOUFOX_BLOCK_WEBRTC` / `CAMOUFOX_BLOCK_WEBGL` / `CAMOUFOX_DISABLE_COOP` for privacy/fingerprint hardening.
- `CAMOUFOX_MAIN_WORLD_EVAL` enables `page.evaluate("mw:...")` in the real page context.
- `CAMOUFOX_DEBUG` prints the Camoufox launch config to stderr.
- `CAMOUFOX_FF_VERSION` pins the Firefox version (e.g. `150`, `152`).
- `CAMOUFOX_WINDOW` and `CAMOUFOX_SCREEN` constrain or fix window/screen dimensions.
- `CAMOUFOX_FINGERPRINT_FILE` loads a BrowserForge fingerprint JSON to pin identity.
- `CAMOUFOX_ADDONS` / `CAMOUFOX_EXCLUDE_ADDONS` load custom addons or exclude defaults (`UBO`).
- `CAMOUFOX_VIRTUAL_DISPLAY` sets an explicit Xvfb display number.

`CAMOUFOX_INSTALL_DIR` is wired for containers:
- `docker/Dockerfile.backend` pre-fetches the binary into `/app/.cache/camoufox` during the build stage and copies it to the production image.
- `docker-compose.prod.yml` mounts `browser_data` at `/app/.cache/camoufox` and sets `CAMOUFOX_INSTALL_DIR`.

The `playwright-core` patch (`scripts/patch-playwright.js`) was verified to still apply on `playwright-core@1.60.0`; the `camoufox-js` peer constraint keeps Playwright below `1.61.0`.
