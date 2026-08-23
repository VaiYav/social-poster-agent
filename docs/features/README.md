# Feature Proposals — SPA Backend

> **Legacy feature dossiers and implementation evidence.** Current feature status is
> owned only by [the canonical feature register](../planning/FEATURES.md); active tasks
> live in [the canonical backlog](../planning/BACKLOG.md). Do not create new status
> checklists in this directory.

> See also the product expansion specifications in `docs/roadmap/README.md`.

This directory preserves high-level proposals and evidence dossiers. New cross-module
features receive a stable ID in the planning hub and one primary specification in
`docs/roadmap/` or the relevant domain folder.

Each proposal explains:

- the current state and gap,
- the proposed feature,
- data model or infra changes,
- integration points,
- effort estimate,
- related review files.

> **⚠️ Dossiers may drift.** Re-verify source references before implementation; update
> design/evidence here but update live status only in `docs/planning/`.

## Proposals

| Feature | Dossier snapshot (non-canonical) | Effort | Why it matters | Related reviews |
|---------|--------|--------|----------------|-----------------|
| [A/B Testing Infrastructure](./ab-testing-infrastructure.md) | Implemented | S–M | Closes the feedback loop between `abVariants`, `judgeScores`, and real-world approve/reject/engagement. | `content-enhancements.md`, `infrastructure-llm.md`, `analytics.md` |
| [Content Adapters Beyond CAP](./content-adapters.md) | Implemented | M | Decouples content discovery from the sibling `content-agent-platform` repo; enables RSS, APIs, Google Trends, etc. | `content-source.md`, `infrastructure-prisma.md`, `recycling.md` |
| [Operator Dashboard](./operator-dashboard.md) | Implemented | M–L | Single pane of glass for posts, queues, sessions, LLM provider health, alerts, and quality. | `analytics.md`, `queue.md`, `sessions.md`, `health-monitor.md`, `events.md` |
| [Multi-Instance Distribution](./multi-instance-distribution.md) | Proposal | M–L | Enables horizontal scaling: shared LLM cache, leader election for orchestrator, distributed engagement lock. | `infrastructure-llm.md`, `infrastructure-redis.md`, `orchestrator.md`, `engagement.md` |
| [Browser E2E Replay Harness](./browser-e2e-replay.md) | Proposal | L | Records and replays real browser flows from `dry-run`, giving CI coverage for selector drift. | `infrastructure-browser.md`, `posting.md`, `engagement.md`, `replies.md` |
| [Prompt Versioning & A/B in Langfuse](./prompt-versioning-langfuse.md) | Implemented | S–M | `PROMPT_VERSION` wired to Langfuse labels, per-prompt overrides, fallback chain, and `pnpm prompts:diff` CLI. | `infrastructure-llm.md`, `ab-testing-infrastructure.md` |

## How these relate to planning and reviews

The review files (`docs/reviews/*.md`) describe historical/current findings. Dossiers
here explain a feature. Neither owns status. `docs/planning/FEATURES.md` records feature
state and `docs/planning/BACKLOG.md` records all non-terminal tasks.

## How to use

1. Pick a proposal.
2. Re-verify all source references and update the proposal if needed.
3. Create a `docs/adr/ADR-00X-*.md` if the feature has architectural consequences.
4. Break the proposal into stable task IDs in `docs/planning/BACKLOG.md`.
