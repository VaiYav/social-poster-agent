# REFACTOR-108 sanctioned env-access local evidence

Date: 2026-08-23  
Source SHA: `74a1e7cc5e32bb90453f2809876f840724cc6a24` plus current dirty worktree changes  
Boundary: runtime configuration access cleanup and local regression evidence; no production,
deployment or provider acceptance evidence.

## Implemented

- Moved DI-managed runtime reads to `ConfigService` for generation dry-run behavior, trending
  event-file loading, BrowserModule dry-run wrapping, PostsController continuation delay, X
  diagnostic output and Prisma connection URL resolution.
- Moved the optional EngagementModule selection behind `OrchestratorModule.forRoot(...)`; the
  bootstrap owner (`AppModule`) supplies the already-resolved flag instead of the orchestrator
  module reading `process.env` itself.
- Added and validated `SPA_DEBUG_DIR` in the env schema/example.
- Updated unit fixtures and added TrendingService coverage so configuration is injected rather
  than mutated through ambient process state.

## Local evidence

- Targeted runtime-config/orchestrator/browser/prisma lane — exit 0, 11 files / 101 tests.
- Full backend typecheck (`npx tsc --noEmit`) — exit 0.
- Backend lint (`pnpm lint`, oxlint + explicit emitted-import validator) — exit 0.
- Full backend unit lane (`tests/unit/`) — exit 0, 177 files / 1,987 tests.
- Source scan shows no direct runtime `process.env` reads in the changed DI-managed services or
  modules. Remaining reads are limited to env validation, documented domain helpers, AppModule
  bootstrap wiring, CLI/dry-run environment setup and pre-Nest instrumentation.
- Repository `git diff --check` — exit 0.

## Remaining gate

- Clean-resource verification, CI/deployment and production soak remain `VERIFY`; bootstrap and
  instrumentation exceptions remain intentional until a separate startup-configuration design
  task changes that boundary.
