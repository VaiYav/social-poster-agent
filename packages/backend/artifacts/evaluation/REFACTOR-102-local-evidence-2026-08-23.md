# REFACTOR-102 generation service decomposition local evidence

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local module decomposition and regression evidence; no production, provider, staging or
live-network acceptance evidence.

## Implemented

- `GenerationPersistenceService` owns SimHash deduplication, account rotation, Post persistence,
  A/B variant persistence and online evaluation coordination.
- `PostFactory` owns `PostUncheckedCreateInput` and `llmMetadata` construction, including prompt,
  persona, judge and SimHash provenance.
- `GenerationRunLifecycleService` owns run start, active cancellation controllers, pause/resume
  state transitions, completion checkpoint cleanup and failure SSE/state handling.
- `ReviewResumeService` owns the HITL `Command({ resume })` path, reviewed graph output account
  loading, persistence and completion SSE.
- `GenerationService` keeps its public methods and delegates through compatibility seams; the old
  duplicated persistence implementation was removed.

## Local evidence

- Generation regression lane — exit 0, 46 tests.
- Persistence, lifecycle and review-resume contract lane — exit 0, 5 tests.
- Full backend unit lane (`tests/unit/`) — exit 0, 175 files / 1,974 tests.
- Owned `oxlint` lane — exit 0.
- Owned `oxfmt` lane — exit 0.
- Owned `git diff --check` — exit 0.

## Remaining gate

- Full backend `tsc --noEmit` — exit 0 after the dependent posting decomposition import/DI seams
  were reconciled.
- Full-suite, clean-resource typecheck and production/live acceptance remain separate gates.
