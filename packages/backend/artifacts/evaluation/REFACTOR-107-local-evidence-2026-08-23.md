# REFACTOR-107 cron dual-path hygiene local evidence

Date: 2026-08-23  
Source SHA: `74a1e7cc5e32bb90453f2809876f840724cc6a24` plus current dirty worktree changes  
Boundary: cron/orchestrator feature-flag wiring and local regression evidence; the legacy
dual-path remains intentionally enabled until the ORCH-102 30-day gate.

## Implemented

- `isOrchestratorEnabled()` has one canonical implementation in `src/domain/feature-flags.ts`.
- All legacy cron consumers import that domain module directly, so the module-local
  `orchestrator/feature-flag.ts` compatibility re-export is no longer part of the runtime graph.
- Removed dead configuration surfaces `ORCHESTRATOR_CHECKPOINT_KEY` and
  `CRON_PARTICIPATION_SCHEDULE`; active cron schedules and feature switches remain because the
  legacy dual-path is still an explicit operating mode.
- Added direct unit coverage for accepted truthy/falsy forms and fail-closed handling of unknown
  orchestrator flag values.

## Local evidence

- Focused cron/orchestrator lane — exit 0, 4 files / 32 tests.
- Full backend typecheck (`npx tsc --noEmit`) — exit 0.
- Backend lint (`pnpm lint`, oxlint + explicit emitted-import validator) — exit 0.
- Full backend unit lane (`tests/unit/`) — exit 0, 176 files / 1,985 tests.
- Source scan confirms no backend runtime/test import of `orchestrator/feature-flag.js`, no
  `skipIfOrchestrator` helper and no removed env-key references.
- Repository `git diff --check` — exit 0.

## Remaining gate

- Legacy cron/orchestrator dual-path removal remains gated by ORCH-102 30-day evidence; clean
  resource, CI/deployment and production soak evidence remain `VERIFY`.
