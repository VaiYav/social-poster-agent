# ADR-013: Creator CRM Tracks Public Relationship Evidence and Keeps Outreach Human-Controlled

**Status:** Accepted — human-controlled foundation
**Date:** 2026-08-22
**Decider:** Valentyn Yakovliev
**Feature:** `CRM-001` in `docs/planning/FEATURES.md`
**Extends:** ADR-008, ADR-010, ADR-012
**Roadmap:** proposal `(13)`; milestone integration is unblocked by `PLAN-002`

**Acceptance record:** Product owner approved on 2026-08-23. v1 is public-data-only, network-scoped,
DO_NOT_ENGAGE-first, recommendation-only and human-controlled for identity linking, meaningful
relationship stages and outreach. No DMs, cold outreach or private enrichment.

## Context

SPA stores public interactions but has no durable model for repeated professional relationships,
creator ownership by account/persona, cooldown, collaboration proposals or outcomes. Optimizing only
reply count risks repetitive targeting and misses higher-value collaborations.

## Decision

### 1. Model a network-scoped public creator identity

`CreatorProfile` stores minimal public professional fields, sources, status and freshness. Clear
handles are personal data and remain protected/purgeable. Cross-network identity links require
explicit public evidence and human confirmation.

### 2. Relationship stage is evidence-backed and human-governed

Use `DISCOVERED`, `OBSERVED`, `ENGAGED`, `RECIPROCAL`, `COLLABORATION_CANDIDATE`,
`ACTIVE_COLLABORATOR`, `DORMANT`, `DO_NOT_ENGAGE`. Automated evidence may propose a transition;
meaningful stages and DO_NOT_ENGAGE changes require human review.

### 3. CRM recommends but does not execute outreach

Next actions and collaboration opportunities are suggestions. No automated DMs, cold pitches,
follow/unfollow campaigns or external contact enrichment are added.

### 4. No sensitive/psychographic profiling

Do not infer health, fertility, relationship distress, mental state, wealth or other vulnerability.
Store shared public topics and interaction evidence only.

### 5. One account/persona owns relationship continuity

A relationship edge is account-specific with optional persona revision. Portfolio Planner respects
ownership, cooldown and collaboration reservations to prevent multiple SPA accounts targeting the
same creator inconsistently.

### 6. Success is reciprocity/collaboration, not CRM size

Measure repeated substantive exchanges, collaboration acceptance/completion and direct/assisted
campaign outcomes. Follower count/touch volume are secondary context.

## Rationale

- Durable relationships produce more strategic value than indiscriminate comments.
- Network-scoped identity avoids unsafe automatic entity resolution.
- Human outreach preserves context and platform expectations.
- Explicit cooldown/DO_NOT_ENGAGE prevents harassment-like repetition.
- Existing Interaction, persona memory, demand clusters and Z4 attribution are reusable.

## Consequences

### Positive

- Operator sees history, shared topics, ownership and next-action rationale.
- Collaboration workflow and outcomes become measurable.
- Repetitive targeting is constrained.
- Privacy boundary is narrower than a conventional enriched CRM.

### Negative

- Manual review/outreach limits autonomous scale by design.
- Clear public handles require access control, retention and purge.
- Cross-network identity and relationship stages can be ambiguous.
- Collaboration outcomes are sparse and slow.

## Alternatives considered

### Rank creators by followers/engagement and auto-comment

Rejected due poor relevance, spam incentives and relationship harm.

### Buy/enrich private contact data

Rejected as out of scope and privacy-incompatible.

### Use interaction log without a CRM model

Rejected because logs do not express ownership, stage, cooldown, collaboration or DO_NOT_ENGAGE.

### Fully automated outreach agent

Rejected. The initial system is recommendation/manual execution only.

### Global creator identity across platforms by model similarity

Rejected. Require evidence and human confirmation.

## Constraints

- Public professional data and purpose limitation only.
- DO_NOT_ENGAGE precedes all candidate recommendations.
- No raw profile/content archive beyond retention need.
- Clear identity/manual notes excluded from Langfuse/Sentry.
- Stage/action models pass ADR-009.
- Proposal `(13)` owns schema, workflow, privacy, analytics and rollout.

## Validation before implementation and promotion

- privacy/retention/do-not-engage policy;
- identity ambiguity and unlink tests;
- cooldown/over-targeting gates;
- human-only outreach proof;
- stage/next-action labelled evaluation;
- purge across relationships/evidence/recommendations;
- collaboration attribution and operator workflow review.

## References

- `docs/roadmap/13-creator-relationship-crm.md`
- `docs/roadmap/08-editorial-personas-conversational-engagement.md`
- `docs/roadmap/10-conversation-intelligence-demand-radar.md`
- `docs/roadmap/11-reply-to-revenue-assisted-attribution.md`
- `docs/roadmap/12-platform-policy-reputation-control-plane.md`
