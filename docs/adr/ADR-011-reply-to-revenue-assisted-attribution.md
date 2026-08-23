# ADR-011: Reply-to-Revenue Reporting Separates Direct, Assisted, and Incremental Evidence

**Status:** Accepted — direct/assisted v1; incremental HOLD
**Date:** 2026-08-22
**Decider:** Valentyn Yakovliev
**Feature:** `ATTR-002` in `docs/planning/FEATURES.md`
**Extends:** ADR-007, ADR-008
**Roadmap:** proposal `(11)`; milestone integration is unblocked by `PLAN-002`

**Acceptance record:** Product owner approved on 2026-08-23. Direct attribution remains canonical;
assisted association is aggregate account/persona/time evidence only; incremental estimates remain
`INSUFFICIENT_EVIDENCE`/HOLD until a pre-registered experiment has enough traffic.

## Context

ROADMAP Z4 measures direct clicks and conversions through Soulwise attribution links. Reply-first
activity often causes profile discovery followed by a bio-link click, so no reply/post ID exists on
the canonical click. Joining recent replies to bio conversions naively would overclaim causality and
invite privacy-invasive identity stitching.

## Decision

### 1. Three evidence layers are separate types

- `DIRECT`: canonical observed link/click/session/conversion/revenue.
- `ASSISTED_ASSOCIATION`: aggregate bio-link outcome joined to account/persona/time activity window.
- `INCREMENTAL_ESTIMATE`: pre-registered experiment estimate with uncertainty/quality.

APIs, persistence and UI retain these names. Association is never relabelled as causation.

### 2. Attribution joins at account/persona/time level only

Use one stable canonical bio link per account/persona assignment. SPA aggregates approved/executed
conversation activity into time windows and joins aggregate funnel reports for the same link/window.
Do not join a social user to a quiz user, fingerprint visitors or import individual click/session
rows into SPA.

### 3. Soulwise remains the direct attribution source of truth

Reuse existing `ILinkPort` and `my_zodiac_ai/back` attribution-link/funnel report. SPA stores link
assignments, conversation windows and aggregate versioned report snapshots/references only.

### 4. Causal claims require a pre-registered experiment

When volume permits, use account-time switchback/matched blocks with immutable assignment,
intent-to-treat, declared exclusions/lag/stopping and balance/missingness/compliance checks. Return
`INSUFFICIENT_EVIDENCE` rather than force a winner.

### 5. Strategy cannot trade away safety/policy

Revenue/lead metrics never override persona, safety, account health or platform policy gates.
Assisted association alone cannot promote an autonomous reply mode.

## Rationale

- Stable bio links capture the real funnel without invasive identity resolution.
- Typed evidence prevents dashboards from turning correlation into causal marketing claims.
- Existing Z4 infrastructure already supports `bio_link`, custom fields and time-bounded funnel
  reports.
- Switchback units match the operational treatment (account activity over time) better than an
  impossible user-level randomized assignment.

## Consequences

### Positive

- The project can evaluate reply-first business value.
- Direct revenue remains canonical and unmodified.
- Privacy risk is limited by aggregate account-time joins.
- Low-volume uncertainty is visible.
- Experiment protocols and calculations are reproducible.

### Negative

- Low conversion volume may prevent causal conclusions for months.
- Own posts, campaigns, audience growth and platform events remain confounders.
- Late conversions require versioned recomputation.
- Operators must maintain stable bio links and experiment discipline.

## Alternatives considered

### Last-touch every bio conversion to the latest reply

Rejected as false precision and causal overclaim.

### Fingerprint/profile-visitor identity matching

Rejected for privacy, platform and architecture reasons.

### Multi-touch fractional attribution model immediately

Rejected. Arbitrary credit weights do not establish incrementality.

### Report only direct links forever

Rejected because reply-first acquisition would remain economically unmeasurable.

### Complex MMM/Bayesian/synthetic-control system initially

Rejected as premature for two accounts and low volume. Start with transparent windows and
pre-registered switchback analysis.

## Constraints

- Revenue uses the project’s established integer/decimal money boundary.
- Missing/late source data is unknown/incomplete, never zero.
- Individual quizSessionId/IP/device data remains in Soulwise.
- Reporting cohorts enforce privacy thresholds.
- Calculation/config changes pass ADR-009.
- Proposal `(11)` owns detailed data model, quality checks, experiment and rollout.

## Validation before implementation and promotion

- canonical bio links and custom fields confirmed end-to-end;
- direct/assisted/incremental UI cannot be confused;
- no individual cross-system identity join exists;
- source lag/missing/late conversion tests;
- pre-registration/balance/compliance/insufficient-evidence behavior approved;
- privacy/analytics owner review.

## References

- `docs/roadmap/11-reply-to-revenue-assisted-attribution.md`
- `docs/adr/ADR-007-link-attribution-zodiac.md`
- `docs/roadmap/08-editorial-personas-conversational-engagement.md`
- `/Users/valentinyakovlev/projects/my_zodiac_ai/back/src/modules/business/attribution-links/`
- <https://eprint.iacr.org/2023/437>
