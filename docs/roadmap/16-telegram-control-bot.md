# 16 · Telegram operator control bot

> **Feature:** `CONTROL-001` · **Task:** `TGBOT-101`
> **Status of this document:** specification (2026-08-23). Live task status lives only
> in [BACKLOG](../planning/BACKLOG.md); feature status only in
> [FEATURES](../planning/FEATURES.md).

## Product goal

Close the HITL loop from the operator's phone. Today approving, rejecting or pausing
requires the dashboard; the bottleneck of the whole pipeline is the human at the
monitor. The bot mirrors the dashboard's operator actions in Telegram.

## Scope

| Command / push | Behaviour |
|---|---|
| `/status` | Pipeline snapshot: orchestrator state, queue depth, drafts awaiting review, flow-control switches, today's cost |
| `/approve <postId>` | Same code path as `POST /posts/:id/approve` (no business logic duplicated) |
| `/reject <postId>` [reason] | Same as `POST /posts/:id/reject`; reason persisted as review feedback |
| `/pending` | List drafts awaiting review (id + network + hook line) |
| `/pause <flow>` · `/resume <flow>` | Mirror of FlowControl crisis switches (posting/generation/engagement/replies/all) |
| Push alerts | DLQ depth growth, ban detection, failed-post streaks, circuit-open events (reuses Discord alert triggers) |

## Architecture

- New NestJS module `modules/control-bot/`, reusing the existing Telegram Bot API
  adapter in `infrastructure/telegram/`.
- Long-polling (`getUpdates`) — no public webhook endpoint, no inbound port.
- All commands call the same services/controllers the dashboard uses
  (PostsService approve/reject, FlowControlService). The bot is a **transport**, not a
  second brain (GRASP: information expert stays in existing services).
- Alerts subscribe to the existing EventEmitter2 events already used by the Discord
  notifier.

## Security

- `TELEGRAM_CONTROL_CHAT_IDS` allowlist — messages from other chats are ignored and
  logged.
- Bot token separate from any notification-only token.
- Every command is audit-logged with chat id + post id (correlation id propagated).

## Environment

```
TELEGRAM_CONTROL_BOT_TOKEN=
TELEGRAM_CONTROL_CHAT_IDS=123456789,987654321
CONTROL_BOT_ENABLED=false   # default off
```

## Non-goals

- No post text editing in chat — editing stays in the dashboard editor (rich context,
  char counters, preview).
- No autonomous bot decisions: it never posts, likes, or generates anything by itself.
- No multi-admin RBAC in v1 (single-operator product).

## Acceptance / required evidence

- Local integration tests for command routing against mocked services.
- Manual evidence: one approve + one reject + one pause/resume round-trip from a real
  Telegram client; allowlisted-chat rejection proof.
- Alert drill: seeded DLQ/ban event produces exactly one push per subscribed chat.
