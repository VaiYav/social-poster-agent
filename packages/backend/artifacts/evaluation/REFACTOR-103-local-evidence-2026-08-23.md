# REFACTOR-103 posting service decomposition local evidence

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local posting pipeline decomposition and regression evidence; no production, provider,
staging or live-network acceptance evidence.

## Implemented

- `PostingGuardChain` owns network, flow-control, status, policy, rate-limit and warm-up gates.
- `PostingDispatcher` owns network-to-poster dispatch and lazy article poster resolution.
- `ThreadOrchestrator` owns legacy reply threads, multi-stage ordering and continuation scheduling.
- `CtaAttributionService` owns CTA assignment, inline/reply delivery and policy re-authorization.
- `PostVerificationService` owns permalink validation, article verification and re-verification.
- `PostSideEffectsService` owns pillar and A/B side effects.
- `PostingService` remains the public facade for browser lifecycle, retry/recovery, state transitions
  and batch operations; the old duplicated guard/dispatch/thread/CTA implementations are removed.

## Local evidence

- PostingService regression lane — exit 0, 46 tests.
- CTA contract lane — exit 0, 2 tests.
- Full backend unit lane (`tests/unit/`) — exit 0, 175 files / 1,974 tests.
- Full backend typecheck (`npx tsc --noEmit`) — exit 0.
- Owned `oxlint` lane — exit 0.
- Owned `oxfmt` lane — exit 0.
- Owned `git diff --check` — exit 0.

## Remaining gate

- Runtime Nest integration, real queue/browser/provider behavior, staging soak and live network
  acceptance remain `VERIFY`.
