# Feature Proposals — SPA Backend

This directory contains high-level feature proposals that are **not yet prioritized** in `docs/reviews/ACTION_PLAN.md`. They are intentionally separate from the bug-fix and hardening backlog because most of them require schema, UI, or cross-module architecture work.

Each proposal explains:

- the current state and gap,
- the proposed feature,
- data model or infra changes,
- integration points,
- effort estimate,
- related review files.

> **⚠️ Living documents.** These proposals are written against the current source tree. Before implementing, re-verify file references and update the proposal if the code has moved on.

## Proposals

| Feature | Status | Effort | Why it matters | Related reviews |
|---------|--------|--------|----------------|-----------------|
| [A/B Testing Infrastructure](./ab-testing-infrastructure.md) | Implemented | S–M | Closes the feedback loop between `abVariants`, `judgeScores`, and real-world approve/reject/engagement. | `content-enhancements.md`, `infrastructure-llm.md`, `analytics.md` |
| [Content Adapters Beyond CAP](./content-adapters.md) | Implemented | M | Decouples content discovery from the sibling `content-agent-platform` repo; enables RSS, APIs, Google Trends, etc. | `content-source.md`, `infrastructure-prisma.md`, `recycling.md` |
| [Operator Dashboard](./operator-dashboard.md) | Implemented | M–L | Single pane of glass for posts, queues, sessions, LLM provider health, alerts, and quality. | `analytics.md`, `queue.md`, `sessions.md`, `health-monitor.md`, `events.md` |
| [Multi-Instance Distribution](./multi-instance-distribution.md) | Proposal | M–L | Enables horizontal scaling: shared LLM cache, leader election for orchestrator, distributed engagement lock. | `infrastructure-llm.md`, `infrastructure-redis.md`, `orchestrator.md`, `engagement.md` |
| [Browser E2E Replay Harness](./browser-e2e-replay.md) | Proposal | L | Records and replays real browser flows from `dry-run`, giving CI coverage for selector drift. | `infrastructure-browser.md`, `posting.md`, `engagement.md`, `replies.md` |
| [Prompt Versioning & A/B in Langfuse](./prompt-versioning-langfuse.md) | Implemented | S–M | `PROMPT_VERSION` wired to Langfuse labels, per-prompt overrides, fallback chain, and `pnpm prompts:diff` CLI. | `infrastructure-llm.md`, `ab-testing-infrastructure.md` |

## How these relate to `docs/reviews/`

The review files (`docs/reviews/*.md`) describe the **current state and its bugs**. The proposals here describe **what to build next**. Before any feature here is added to the active backlog, its underlying review files should be stable and the quick wins in `ACTION_PLAN.md` should be closed — otherwise the new feature is built on top of known leaks and inconsistencies.

## How to use

1. Pick a proposal.
2. Re-verify all source references and update the proposal if needed.
3. Create a `docs/adr/ADR-00X-*.md` if the feature has architectural consequences.
4. Break the proposal into tasks in `docs/reviews/ACTION_PLAN.md` when the team is ready to start it.
