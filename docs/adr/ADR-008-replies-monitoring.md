# ADR-008: Adaptive Replies Monitoring and Human-Review UI

## Status
Accepted — implemented in Sprint Q / Phase 0.

## Context
The product posts to X, Threads, and Facebook multiple times per day. Users reply and comment on those posts. Manually reading and replying to every comment does not scale, while fully automated replies risk brand-damage, prompt injection, and platform bans.

F4 (Adaptive Reply Handling) requires a system that:
- Detects new comments on recently posted content.
- Classifies each comment for safety, tone, and intent.
- Generates brand-aligned replies when it is safe and appropriate.
- Escalates complex, sensitive, or ambiguous comments to a human operator.
- Enforces a daily per-network reply budget.

## Decision
We built a dedicated `RepliesModule` with a browser-driven monitoring cycle and a dedicated `/replies` UI view.

### Backend
- `RepliesMonitorService` runs on a configurable cron, gated by `REPLIES_ENABLED`.
- It discovers recent `POSTED` posts (last 24h) and scrapes their comment threads via `IBrowserPort`.
- Each new comment is persisted as `IncomingComment` and deduplicated by a stable `commentId` (platform native id or hash of `author + text + postId`).
- A pipeline of classifiers decides the final action:
  - `CommentSafetyClassifierService` — prompt injection, spam, toxic content.
  - `QuestionClassifierService` — detects genuine questions.
  - `DialogueService` — end-to-end decision (auto_reply / human_review / skip / like).
  - `ToneAnalyzerService` — adapts the reply tone to the original comment.
- Auto-replies are posted through the engagement module's engagers.
- A Redis Lua script reserves a daily per-network reply slot (`REPLIES_MAX_PER_DAY`) to prevent runaway replies.
- `RepliesController` exposes REST endpoints (`/replies/pending`, `/replies/stats`, `/replies/:id/manual-reply`, `/replies/:id/dismiss`, `/replies/run`) with Swagger/OpenAPI documentation.
- The service integrates with the orchestrator: when `ORCHESTRATOR_ENABLED=true`, the cron is not registered and the orchestrator invokes the monitor directly.

### Frontend
- `packages/ui/src/views/Replies.vue` is a dedicated human-review page reachable from the sidebar.
- `packages/ui/src/stores/replies.ts` manages pending comments, stats, manual replies, dismissals, and cycle triggers.
- The page displays counts (new, replied, skipped, human review, manual), a real-time pending queue, and controls to run the monitoring cycle.
- `App.vue` dispatches `replies_monitor` and `reply_posted` SSE events to the replies store.

## Consequences
- Operators can review, approve, or dismiss flagged comments from one place.
- Daily reply budgets, safety classifiers, and tone matching reduce the risk of bad auto-replies.
- The module is feature-flagged off by default and can be paused via `FlowControlService`.
- Comment scraping depends on live platform selectors and can drift; `selector-health.service.ts` is used to detect breakage.

## Alternatives considered
- **WebSocket notifications from platforms** — not available for X/Threads/Facebook without official APIs; browser scraping is the only realistic option.
- **Notification-page scraping instead of post-page scraping** — faster for mentions, but requires additional network-specific selectors and does not cover comments on our own posts better than post-page scraping. Post-page scraping is the MVP source; notification scraping remains a future enhancement.
- **Template-based replies** — rejected; all reply content is LLM-generated with no template fallback to avoid stale or robotic responses.

## Future work
- Notification-page scraping (X notifications, Threads activity, Facebook page inbox) as an additional, faster source.
- Factual grounding for question replies by querying the content-agent-platform factbase.
- Deep-link reply posting (reply directly under a specific comment when `commentUrl` is available).
