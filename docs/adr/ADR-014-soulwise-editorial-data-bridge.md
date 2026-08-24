# ADR-014: Soulwise Exposes a Versioned Read-Only Editorial Feed to SPA

**Status:** Accepted — read-only PUBLIC_FACT v1
**Date:** 2026-08-22
**Decider:** Valentyn Yakovliev
**Feature:** `BRIDGE-001` in `docs/planning/FEATURES.md`
**Extends:** ADR-004, ADR-007, ADR-008
**Roadmap:** proposal `(14)`; milestone integration is unblocked by `PLAN-002`

**Acceptance record:** Product owner approved on 2026-08-23. v1 is a one-way, read-only,
allowlisted `PUBLIC_FACT` feed with internal auth, cursor/ETag/hash/tombstone semantics. Personalized
data and write-back are forbidden; `AGGREGATE_INSIGHT` remains HOLD.

## Context

SPA needs current Soulwise ephemeris, curated knowledge and public product facts. Generic API
mapping or direct database/module access could expose personalized health/relationship data, store
secrets in content configuration, lose provenance or publish stale product claims.

Soulwise already has a public non-personalized today-sky endpoint and an internal-token
service-to-service pattern. It also has authenticated personalized endpoints that must never become
social content sources.

## Decision

### 1. Create a dedicated read-only `EditorialFeed` API

Soulwise exports a strict versioned envelope with cursor pagination, ETag, item versions/hashes,
classification, claims/evidence, review status, validity and tombstones.

### 2. Only allow three v1 classifications

- `PUBLIC_FACT`
- `CURATED_KNOWLEDGE`
- `PRODUCT_UPDATE`

`AGGREGATE_INSIGHT` is HOLD pending a separate privacy threat model/ADR. User-level/personalized
data is forbidden.

### 3. Use explicit producer adapters and field allowlists

Soulwise `EditorialFeedAssembler` reads only registered adapters through bounded-context
ports/public APIs. No generic reflection/query and no cross-context direct service imports.

### 4. SPA uses a dedicated typed adapter

`SoulwiseEditorialClient`/`SoulwiseEditorialAdapter` owns auth, timeout, circuit breaker, schema,
cursor, ETag, receipts, freshness and tombstones. Do not use the generic `ApiAdapter`, which is too
permissive and can store headers in content-source configuration.

### 5. Soulwise remains source of truth

SPA stores receipts and normalized Topic/KnowledgeEvidence candidates with provenance. Retractions,
expiry and tombstones remove eligibility/cache/retrieval. SPA never reaches Soulwise MongoDB.

### 6. V1 is one-way

Demand/product insights from SPA remain reviewed export artifacts. A write-back API requires a
separate ADR and product workflow.

## Rationale

- Strict classification/allowlists make the privacy boundary testable.
- Dedicated adapter isolates the internal token and rich provenance semantics.
- Version/hash/validity/tombstone support prevents stale or retracted claims.
- Reusing Soulwise Swiss Ephemeris avoids duplicate calculations/calendars.
- Read-only pull with cursor/ETag is simpler and safer than cross-project events/CDC at initial scale.

## Consequences

### Positive

- Social content uses canonical public Soulwise facts.
- Personalized endpoints are structurally excluded.
- Cross-project contract and deployment order become testable.
- Source outage/staleness has deterministic behavior.
- Proposal `(08)` grounding and Portfolio Planner gain a high-quality source.

### Negative

- Requires coordinated changes/deployments in two repositories.
- Editorial review/validity/tombstone ownership must be established in Soulwise.
- Cached/synced data duplicates a bounded subset across systems.
- Cross-project contract versioning and runbooks add operational work.

## Alternatives considered

### Use the generic SPA `ApiAdapter`

Rejected due dynamic mapping, weak classification/provenance/tombstones and secret-in-config risk.

### Direct SPA read from Soulwise database

Rejected for security, data ownership and schema coupling.

### Import Soulwise backend package/code into SPA

Rejected across repository/bounded-context boundaries.

### Scrape `CHANGELOG.md`/docs at runtime

Rejected as unreviewed, unversioned public copy and unreliable deployment coupling.

### Stream all Soulwise domain events

Rejected initially due privacy blast radius and unnecessary complexity. A curated pull feed is
right-sized.

### Export anonymized user trends immediately

Rejected/HOLD. Hashing is not anonymization; aggregate privacy needs separate design.

## Constraints

- Internal token in env/secret manager only.
- Unknown major schema fails closed.
- Cursor advances transactionally with applied receipts.
- Same item/version different hash is an incident.
- Tombstones override cache and propagate to retrieval.
- Time-sensitive sky data cannot exceed validity.
- Producer contract tests prove forbidden fields cannot serialize.
- Proposal `(14)` owns detailed API, data, sync, privacy and rollout.

## Validation before implementation and deployment

- data-classification/forbidden-source threat model;
- v1 JSON schema and producer/consumer contract fixtures;
- today-sky mapping and authenticated share-card exclusion;
- internal auth/secret/log verification;
- cursor/ETag/idempotency/hash/tombstone/freshness tests;
- cross-project deployment/rollback rehearsal;
- product/editorial owner approval.

## References

- `docs/roadmap/14-soulwise-editorial-data-bridge.md`
- `docs/roadmap/08-editorial-personas-conversational-engagement.md`
- `docs/adr/ADR-004-hexagonal-ports.md`
- `docs/adr/ADR-007-link-attribution-zodiac.md`
- `/Users/valentinyakovlev/projects/my_zodiac_ai/back/src/modules/astrology/astrology-features/features/cosmic-weather/controllers/v3/cosmic-weather-v3-public.controller.ts`
- `/Users/valentinyakovlev/projects/my_zodiac_ai/back/src/modules/wellness/cycles/controllers/share-card.controller.ts`
- `packages/backend/src/infrastructure/content/adapters/content-adapter.interface.ts`
- `packages/backend/src/infrastructure/content/adapters/api.adapter.ts`
