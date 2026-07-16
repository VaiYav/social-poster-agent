# Phase 4 — P2: Architecture & DRY

Architecture improvements, DRY violations, module boundary fixes, and shared schema extraction.

---

## 4.1 `process.env` → `ConfigService` (batch)

> **Do NOT touch** the intentional reads listed in `AGENTS.md`: `getEnabledNetworks()`, `isOrchestratorEnabled()`, `app.module.ts`.

### 4.1.1 — `GenerationService` env reads

**Status:** `[ ]` | **Effort:** S

**Files:** `packages/backend/src/modules/generation/generation.service.ts`

**Description:** `GenerationService` reads `POSTING_LANGUAGES`, `JUDGE_REFINE_THRESHOLD`, `DEDUP_SINCE_DAYS`, and `GENERATION_TEMPERATURE_*` directly from `process.env` at runtime. This bypasses env validation and makes the service harder to test (env vars must be set before module load). Inject `ConfigService` and read all values through it.

### Checklist

- [ ] Find all `process.env` reads in `generation.service.ts`
- [ ] Inject `ConfigService` (if not already injected)
- [ ] Replace each `process.env.X` with `this.configService.get('X')`
- [ ] Ensure all env vars are declared in `env.validation.ts`
- [ ] Update any unit tests that set `process.env` directly
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/generation/`

### Acceptance criteria

- No `process.env` reads in `generation.service.ts` (except intentional ones per AGENTS.md)
- All values read through `ConfigService`

---

### 4.1.2 — `SessionsService` env reads

**Status:** `[ ]` | **Effort:** S

**Files:** `packages/backend/src/modules/sessions/sessions.service.ts`

**Description:** `SessionsService` reads `CAMOUFOX_HEADLESS`, `SESSION_RELOGIN_CRON`, and `SPA_DRY_RUN` from `process.env`. Switch to `ConfigService` for consistency and testability.

### Checklist

- [ ] Find all `process.env` reads in `sessions.service.ts`
- [ ] Inject `ConfigService` and replace reads
- [ ] Ensure env vars are declared in `env.validation.ts`
- [ ] Update unit tests
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/sessions/`

### Acceptance criteria

- No `process.env` reads in `sessions.service.ts`
- All values read through `ConfigService`

---

### 4.1.3 — `XPoster` / `BasePoster` env reads

**Status:** `[ ]` | **Effort:** S

**Files:** `packages/backend/src/modules/posting/posters/x.poster.ts`, `packages/backend/src/modules/posting/posters/base.poster.ts`

**Description:** `XPoster` and `BasePoster` read `SOCIAL_X_USERNAME` and `THREAD_CONTINUATION_DELAY_MS` from `process.env`. Switch to `ConfigService`.

### Checklist

- [ ] Find all `process.env` reads in `x.poster.ts` and `base.poster.ts`
- [ ] Inject `ConfigService` and replace reads
- [ ] Ensure env vars are declared in `env.validation.ts`
- [ ] Update unit tests
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/posting/`

### Acceptance criteria

- No `process.env` reads in poster files
- All values read through `ConfigService`

---

### 4.1.4–4.1.9 — Remaining `process.env` → `ConfigService` conversions

**Status:** `[ ]` | **Effort:** XS each

**Files (per module):**
- `engagement-decision.service.ts` — `ENGAGEMENT_COMMENT_TEMPERATURE`, `ENGAGEMENT_QUOTE_TEMPERATURE` (also task 2.10.2)
- `replies-monitor.service.ts` — `REPLIES_TEMPERATURE`
- `metrics-scraper.service.ts` — `METRICS_SCRAPER_ENABLED`, `METRICS_SCRAPER_SCHEDULE`
- `recycling.service.ts` — `RECYCLING_CRON_ENABLED`, `RECYCLING_CRON_SCHEDULE`
- `hook-performance-bank.ts` — `HOOK_BANK_AGGREGATE_SCHEDULE`
- `autonomous-runner.service.ts` — `AUTONOMOUS_RUNNER_SCHEDULE`
- `email-reader.service.ts` — `EMAIL_*`

**Description:** Each of these services reads configuration from `process.env` directly instead of using `ConfigService`. This bypasses validation and makes testing harder. Convert each to use `ConfigService` injection.

### Checklist (per service)

- [ ] Find all `process.env` reads in the service
- [ ] Inject `ConfigService` and replace reads
- [ ] Ensure env vars are declared in `env.validation.ts`
- [ ] Update unit tests
- [ ] Run `npx tsc --noEmit` and relevant unit tests

### Acceptance criteria

- No `process.env` reads in any of the listed services
- All values read through `ConfigService`

---

## 4.2 DRY / Single source of truth

### 4.2.1 — `NETWORK_LIMITS` — extract to single config

**Status:** `[ ]` | **Effort:** S | **Ref:** autonomy.md B17, posts.md

**Files:** `packages/backend/src/modules/autonomy/auto-check.service.ts`, `packages/backend/src/modules/posts/posts.service.ts`

**Description:** `NETWORK_LIMITS` (character limits per network) is duplicated in `auto-check.service.ts` and `posts.service.ts`. Changes to one copy are not reflected in the other. Extract to a single shared config file (e.g., `domain/network-limits.ts` or `packages/shared`).

### Checklist

- [ ] Find all definitions of `NETWORK_LIMITS` in the codebase
- [ ] Create a single source in `packages/shared` or `src/domain/`
- [ ] Update all consumers to import from the single source
- [ ] Remove the duplicate definitions
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/`

### Acceptance criteria

- `NETWORK_LIMITS` is defined in exactly one location
- All consumers import from that location

---

### 4.2.2 — `persistGeneratedPosts()` — extract helper

**Status:** `[ ]` | **Effort:** S | **Ref:** generation.md A1

**Files:** `packages/backend/src/modules/generation/generation.service.ts`

**Description:** The post persistence logic (SimHash dedup + Prisma transaction) is duplicated in `generate`, `resumeRun`, and `resumeWithReview`. Extract into a shared `persistGeneratedPosts()` helper method and call it from all three paths.

### Checklist

- [ ] Read `generation.service.ts` to find the three duplicated persistence blocks
- [ ] Extract the common logic into a private `persistGeneratedPosts()` method
- [ ] Call the method from `generate`, `resumeRun`, and `resumeWithReview`
- [ ] Verify all three paths still work with unit tests
- [ ] Run `npx vitest run tests/unit/generation/`

### Acceptance criteria

- Post persistence logic exists in exactly one method
- All three code paths call the shared method
- Unit tests pass

---

### 4.2.3 — `CircuitBreakerRegistry` — use it or remove it

**Status:** `[ ]` | **Effort:** XS | **Ref:** posting.md B1

**Files:** `packages/backend/src/modules/posting/` (find `CircuitBreakerRegistry`)

**Description:** `CircuitBreakerRegistry` is created but not wired into any service. Either wire it into the posting pipeline (to track per-network circuit breaker state) or remove it to reduce dead code.

### Checklist

- [ ] Search for `CircuitBreakerRegistry` in the codebase
- [ ] If it has a use case: wire it into the posting pipeline
- [ ] If not: remove the class, its tests, and any references
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/`

### Acceptance criteria

- `CircuitBreakerRegistry` is either used or removed
- No dead code remains

---

## 4.3 Inline prompts → Langfuse Prompt Management

### 4.3.1–4.3.4 — Migrate inline prompts to Langfuse

**Status:** `[ ]` | **Effort:** S each

**Files:**
- `topic-generation.service.ts:109-131` — topic generation prompt
- `replies-monitor.service.ts` — reply prompt
- `trending-scraper.service.ts` — trending relevance prompt
- `engagement-decision.service.ts` — engagement comment/quote prompts

**Description:** These four prompts are defined inline in the service code, not in Langfuse Prompt Management. This means they can't be edited without redeploying. Migrate each to Langfuse (create the prompt in the UI, add it to the `PromptRegistry`, and add an inline fallback). Follow the pattern established by the 7 existing Langfuse prompts (see `AGENTS.md`).

### Checklist (per prompt)

- [ ] Read the inline prompt definition in the service
- [ ] Create the prompt in Langfuse (via the migration script or UI)
- [ ] Add the prompt name to the `PromptRegistry` fetch list
- [ ] Add an inline fallback in the service (using `{var}` syntax)
- [ ] Update the service to fetch from `IPromptPort` instead of using the inline prompt directly
- [ ] Add `promptNames` to trace metadata
- [ ] Test with Langfuse enabled and disabled (fallback path)
- [ ] Run `npx vitest run tests/unit/`

### Acceptance criteria

- All 4 prompts are managed in Langfuse
- Inline fallbacks exist and work when Langfuse is disabled
- Traces include the prompt name in metadata

---

## 4.4 Module boundaries

### 4.4.1 — `AutoApproveListener` → move to `modules/autonomy`

**Status:** `[ ]` | **Effort:** S | **Ref:** events.md A1, cross-module-synthesis.md #11

**Files:** `packages/backend/src/events/listeners/auto-approve.listener.ts` → `packages/backend/src/modules/autonomy/`

**Description:** `AutoApproveListener` is in the generic `events/listeners/` directory but is an autonomy-domain listener. Moving it to `modules/autonomy/` aligns the file structure with the domain boundary and makes the autonomy module self-contained.

### Checklist

- [ ] Move `auto-approve.listener.ts` to `modules/autonomy/`
- [ ] Update all imports that reference the old path
- [ ] Ensure the listener is still registered in the module
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/`

### Acceptance criteria

- `AutoApproveListener` lives in `modules/autonomy/`
- All imports updated
- `npx tsc --noEmit` passes

---

### 4.4.2 — LLM endpoints → extract to `LlmController`

**Status:** `[ ]` | **Effort:** S | **Ref:** generation.md A2/A14

**Files:** `packages/backend/src/modules/generation/generation.controller.ts` → new `packages/backend/src/modules/llm/llm.controller.ts`

**Description:** LLM management endpoints (`/models`, `/provider-status`, `/reset-circuit-breakers`) are in `GenerationController` but are LLM-domain, not generation-domain. Extract them into a dedicated `LlmController` for cleaner module boundaries.

### Checklist

- [ ] Read `generation.controller.ts` to find the LLM endpoints
- [ ] Create `llm.controller.ts` in an appropriate module
- [ ] Move the endpoints and their dependencies
- [ ] Update routes if needed (or keep same paths for backward compat)
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/`

### Acceptance criteria

- LLM endpoints are in a dedicated `LlmController`
- `GenerationController` only has generation-related endpoints
- Routes still work (same paths or documented redirects)

---

### 4.4.3 — `ThreadDepthController` → rename to `ThreadDepthService`

**Status:** `[ ]` | **Effort:** XS | **Ref:** content-enhancements.md

**Files:** `packages/backend/src/modules/.../thread-depth.controller.ts` (find exact path)

**Description:** `ThreadDepthController` is named "Controller" but is a service (no HTTP endpoints, just business logic). Rename to `ThreadDepthService` to follow NestJS naming conventions and avoid confusion.

### Checklist

- [ ] Find `ThreadDepthController` in the codebase
- [ ] Rename to `ThreadDepthService`
- [ ] Update all imports and DI references
- [ ] Run `npx tsc --noEmit` and `npx vitest run tests/unit/`

### Acceptance criteria

- Class is named `ThreadDepthService`
- All references updated
- `npx tsc --noEmit` passes

---

### 4.4.4 — `modules/events` → rename to `modules/sse`

**Status:** `[ ]` | **Effort:** S | **Ref:** events.md A4

**Files:** `packages/backend/src/modules/events/` → `packages/backend/src/modules/sse/`

**Description:** `modules/events` is confused with `src/events/` (the EventEmitter2 domain event bus). The `modules/events` module is actually the SSE module. Rename to `modules/sse` to avoid confusion.

### Checklist

- [ ] Rename `modules/events/` to `modules/sse/`
- [ ] Update all imports
- [ ] Update `app.module.ts` to import `SseModule` instead of `EventsModule`
- [ ] Run `npx tsc --noEmit` and `npx vitest run`

### Acceptance criteria

- Module directory is `modules/sse/`
- All imports updated
- `npx tsc --noEmit` passes

---

## 4.5 Shared schemas

### 4.5.1 — `SSEvent` schema in `packages/shared`

**Status:** `[ ]` | **Effort:** S | **Ref:** events.md A2/T1, infrastructure-sse.md

**Files:** `packages/shared/src/schemas/sse-event.ts` (new), backend SSE service, UI event handlers

**Description:** SSE event payloads are untyped — the backend publishes arbitrary objects and the UI consumes them without type checking. Define a `SSEvent` Zod schema in `packages/shared` that types all SSE event payloads (post_status, generation_progress, etc.). Both backend and UI import this schema.

### Checklist

- [ ] Enumerate all SSE event types in the codebase
- [ ] Create `SSEvent` Zod schema with discriminated union by event type
- [ ] Export from `packages/shared`
- [ ] Update backend SSE publisher to use the schema
- [ ] Update UI event handlers to use the inferred type
- [ ] Run `npx tsc --noEmit` in both backend and UI

### Acceptance criteria

- SSE event payloads are typed in `packages/shared`
- Both backend and UI use the shared types
- Type errors catch mismatched payloads at compile time

---

### 4.5.2 — Event payload types in `packages/shared`

**Status:** `[ ]` | **Effort:** S | **Ref:** events.md T1

**Files:** `packages/shared/src/schemas/events.ts` (new), backend `events/`, listeners

**Description:** EventEmitter2 event payloads (`PostEvents.APPROVED`, `PostEvents.POSTED`, etc.) are untyped. Define Zod schemas for each event payload in `packages/shared` and use the inferred types in `emit()` and `@OnEvent()` handlers.

### Checklist

- [ ] Enumerate all domain events in `events/`
- [ ] Create Zod schemas for each event payload
- [ ] Export from `packages/shared`
- [ ] Update `emit()` calls to use typed payloads
- [ ] Update `@OnEvent()` handlers to use inferred types
- [ ] Run `npx tsc --noEmit`

### Acceptance criteria

- All domain event payloads are typed
- `emit()` and `@OnEvent()` use shared types
- Type errors catch mismatched payloads
