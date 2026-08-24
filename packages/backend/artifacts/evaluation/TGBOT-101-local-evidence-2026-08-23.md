# TGBOT-101 Telegram operator control bot local evidence

Date: 2026-08-23  
Source SHA: `74a1e7cc5e32bb90453f2809876f840724cc6a24` plus current dirty worktree changes  
Boundary: local command/status/event routing only; no real Telegram client or external Bot API
acceptance evidence.

## Implemented

- `/status` reports draft count, flow-control state, aggregate BullMQ waiting/active/delayed/failed
  counts, orchestrator heartbeat state and today's durable LLM cost.
- `/pending`, `/approve`, `/reject`, `/pause`, `/resume` and allowlist routing reuse existing
  PostsService/FlowControl paths; no second business logic path was introduced.
- Queue DLQ exhaustion, session-ban, posting circuit-open and failed-post streak events route to
  every allowlisted control chat; failed streak alerts are emitted once per network streak and
  reset after recovery.
- Removed a duplicate `ControlBotModule` registration from `AppModule` so long polling has one
  lifecycle owner.

## Local evidence

- Control-bot service lane — exit 0, 1 file / 24 tests.
- Backend typecheck (`npx tsc --noEmit`) — exit 0.
- Backend lint + emitted-import validator (`pnpm lint`) — exit 0.
- Full backend unit lane — exit 0, 178 files / 2,011 tests.
- Static registration check confirms one `...controlBotImports` AppModule spread.

## Remaining gate

- Manual Telegram evidence: real allowlisted approve/reject/pause/resume round-trip, rejection of
  a non-allowlisted chat and one seeded DLQ/ban/circuit alert drill with exactly one push per
  subscribed chat. Keep task `VERIFY` until these are recorded.
