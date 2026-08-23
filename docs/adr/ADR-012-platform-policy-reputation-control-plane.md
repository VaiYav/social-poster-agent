# ADR-012: Platform Policy and Reputation Form an External Runtime Control Plane

**Status:** Accepted — fail-closed v1
**Date:** 2026-08-22
**Decider:** Valentyn Yakovliev
**Feature:** `POLICY-001` in `docs/planning/FEATURES.md`
**Extends:** ADR-001, ADR-006, ADR-008
**Roadmap:** proposal `(12)`; milestone integration is unblocked by `PLAN-002`

**Acceptance record:** Product owner approved on 2026-08-23. v1 uses a versioned policy registry,
most-restrictive compilation, downgrade-only source changes, scoped FlowControl pauses and staged
recovery. It does not claim browser automation is compliant with any platform policy.

## Context

SPA currently distributes execution authority across feature flags, prompts, guards, rate limits,
account health and browser capabilities. Official platform policy changes outside Git, and technical
health cannot detect semantic/reputation incidents. A prompt cannot be the authority for whether an
action is allowed.

## Decision

### 1. Create a versioned Platform Policy Registry

Store primary evidence and approved policy versions per network/action/transport/target relationship
with execution mode, requirements, effective/expiry dates, reviewer and history.

### 2. Runtime policy is a most-restrictive deterministic intersection

Compile global safety, network/action, transport, account approval, target relationship, reputation
state and flow-control/health state. Missing/stale/revoked required evidence resolves to a safe
floor (`DISABLED`/`SUGGEST_ONLY`), never broader permission.

### 3. Automatic policy changes only downgrade

Source expiry/change/unavailability may downgrade and alert. It cannot interpret broader permission
or promote automation. Promotion requires human primary-source review and a new approved version.

### 4. Create a separate Reputation state machine

Normalize technical/enforcement, public semantic and self-generated behavioral signals into
`HEALTHY`, `WATCH`, `LIMITED`, `PAUSED`, `INCIDENT`. Sentiment alone is advisory; transition beyond
WATCH requires a critical trusted signal or corroboration across independent signal families.

### 5. Executors reauthorize immediately before side effect

Every action records exact compiled policy/version/hash and reputation state. Expired/hash-mismatched
authorization is rejected and recomputed.

### 6. The control plane integrates with FlowControl but remains distinct

Policy/reputation decides allowed capability/scope; FlowControl applies pause/resume operationally.
Recovery is staged, audited and cannot jump directly from INCIDENT to HEALTHY.

## Rationale

- Platform policy is external mutable evidence, not code configuration alone.
- Most-restrictive compilation prevents account/prompt overrides from loosening safety.
- Downgrade-only automation is safer than machine interpretation of legal/policy wording.
- Reputation needs semantic signals but must resist sentiment false positives.
- Exact decision lineage supports incidents, audits and rollback.

## Consequences

### Positive

- Enabled actions have current traceable evidence.
- Stale/changed policies fail closed automatically.
- Reputation incidents can pause a narrow topic/action/account scope early.
- Operators can inspect evidence, signals, state and recovery.
- Policy changes are covered by AI release and deterministic tests.

### Negative

- Policy evidence requires ongoing human ownership.
- Benign source changes may temporarily reduce capability.
- Reputation classification introduces false-positive/false-negative calibration work.
- Control-plane unavailability can block actions after cache expiry.

## Alternatives considered

### Keep policy in prompts/AGENTS/roadmap

Rejected. Documentation is not an enforceable runtime authorization decision.

### Environment flags only

Rejected. Flags lack evidence/version/expiry/target context and are easy to misconfigure.

### LLM reads policy page and decides automatically

Rejected. Summaries are advisory; they cannot grant capability.

### Sentiment threshold auto-pauses account

Rejected. Criticism is not abuse/incident and sentiment is too noisy.

### Combine reputation with infrastructure health score

Rejected. Semantic public risk and runtime component health require distinct evidence/state while
sharing the final most-restrictive decision.

## Constraints

- External fetch uses allowlist, SSRF protection, bounded content and no credentials/cookies.
- Raw incident/public content is minimized/redacted from telemetry.
- Manual transitions are role-controlled, reasoned and optimistic-concurrency protected.
- Policy/reputation changes pass ADR-009.
- No control is described as making browser automation compliant.
- Proposal `(12)` owns detailed state, schema, runbooks, metrics and rollout.

## Validation before implementation and promotion

- current primary X/Threads evidence and owner review;
- stale/change/revocation downgrade tests;
- runtime hash/expiry reauthorization;
- sentiment-only no-pause test;
- critical/multi-signal pause and staged recovery;
- FlowControl integration and incident runbooks;
- false-positive calibration/override audit.

## References

- `docs/roadmap/12-platform-policy-reputation-control-plane.md`
- `docs/roadmap/08-editorial-personas-conversational-engagement.md`
- `docs/adr/ADR-001-camoufox-browser-automation.md`
- `docs/adr/ADR-006-autonomous-agent-architecture.md`
- <https://help.x.com/en/rules-and-policies/x-automation>
- <https://about.fb.com/news/2024/10/find-your-community-with-new-threads-educational-insights/>
- <https://genai.owasp.org/llm-top-10/>
