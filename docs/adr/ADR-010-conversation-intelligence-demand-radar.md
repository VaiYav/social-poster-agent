# ADR-010: Public Conversations Become Reviewed Demand Clusters, Not Raw Topics

**Status:** Accepted — narrow v1 scope
**Date:** 2026-08-22
**Decider:** Valentyn Yakovliev
**Feature:** `INTEL-001` in `docs/planning/FEATURES.md`
**Extends:** ADR-004, ADR-008, ADR-009
**Roadmap:** proposal `(10)`; milestone integration is unblocked by `PLAN-002`

**Acceptance record:** Product owner approved on 2026-08-23. v1 accepts minimized English public
Threads/X signals, reviewed `AudienceQuestionCluster` proposals and transparent demand scoring;
private/DM data, sensitive trait inference, automatic product/FAQ mutation and aggregate insight
remain excluded or HOLD.

## Context

SPA can discover trends and public posts, but raw listening results do not represent validated
audience demand. A single viral post, repeated text from one author or an LLM-generated label can
create false priorities. Soulwise subject areas also contain sensitive health/relationship content
that must not become marketing input by default.

## Decision

### 1. `AudienceQuestionCluster` is the durable demand unit

Eligible public sources produce minimized typed `AudienceSignal` records. Signals are grouped into
versioned clusters with canonical question, domain, risk, source count/diversity, score components,
review status, answer state and output links.

### 2. Privacy/minimization occurs before storage, embedding or LLM extraction

Initial scope is English public Threads/X content already encountered by authorized workflows.
Exclude DMs, private/protected sources and all private Soulwise data. Do not infer sensitive traits.
High-risk/crisis signals route to safety review, not content opportunity.

### 3. Clustering is incremental and explainable at initial scale

Use domain/risk/language filters, exact normalization, Postgres full-text and optional pgvector
candidates. Assign only above calibrated thresholds; ambiguous cases require review. Do not add a
separate BERTopic/Python/vector service for initial volume.

### 4. Demand scoring is decomposed

Store frequency, recency, author diversity, conversation depth, unanswered state, product relevance,
confidence and safety eligibility separately. One viral author cannot dominate; missing diversity
keeps a cluster provisional.

### 5. Outputs are proposals

A validated cluster may propose a `Topic`, FAQ/editorial insight or product insight. It never
mutates product backlog/FAQ or executes a reply automatically. Portfolio Planner owns account/action
assignment.

### 6. Every model/config change passes ADR-009

Extractor, privacy classifier, cluster threshold, labeler and demand weights are AI-affecting
changes with held-out evaluation and traceability.

## Rationale

- Clusters compound repeated needs while preserving evidence and source diversity.
- Minimization-before-embedding prevents an irreversible privacy copy from becoming the default.
- Deterministic filters plus reviewed ambiguity are right-sized for initial volume.
- Proposal outputs preserve human product/editorial ownership.
- Decomposed scoring makes priority explainable and testable.

## Consequences

### Positive

- Content and product insights reflect recurring audience language/questions.
- Demand-derived topics can be compared against generic/trending sources.
- Sensitive data and individual profiles remain outside the product loop.
- Cluster merge/split/history and purge are auditable.
- Demand feeds the same Portfolio Planner rather than creating a parallel publishing path.

### Negative

- Human review is required for cluster quality and routing.
- Public content remains personal data even after hashing/minimization.
- Low initial volume may produce many provisional clusters and inconclusive outcomes.
- Re-embedding/reclustering needs versioned operations later.

## Alternatives considered

### Feed every scraped post directly into `Topic`

Rejected. It amplifies noise, duplicates and single-author virality and loses question evidence.

### LLM generates a daily list of “top audience needs”

Rejected as source of truth. It is unauditable and prone to invented frequency/intent.

### Full psychographic/author profiling

Rejected on privacy, safety and product grounds.

### Separate topic-modelling/vector platform immediately

Rejected as premature. PostgreSQL and existing memory/vector roadmap are sufficient.

### Automatically write accepted clusters into Soulwise backlog

Rejected. Product insights remain reviewed proposals through the Editorial Data Bridge boundary.

## Constraints

- Source deletion/opt-out propagates to embeddings/membership/counts.
- Author hashes are treated as personal/linkable data.
- High-risk signal marketing eligibility is zero until reviewed.
- Raw source retention is bounded/configurable.
- `SKIP`/no-output is a correct result.
- Proposal `(10)` owns detailed schema, scoring, API, evaluation and rollout.

## Validation before implementation and promotion

- privacy/forbidden-source contract approved;
- labelled extraction and clustering set with calibrated thresholds;
- one-author dominance and ambiguous assignment tests;
- cluster → Topic preserves evidence and review status;
- no automatic product/FAQ mutation;
- purge removes lexical/vector/membership data;
- external platform retention/read-policy verification complete.

## References

- `docs/roadmap/10-conversation-intelligence-demand-radar.md`
- `docs/roadmap/07-additional-features-research.md`
- `docs/roadmap/08-editorial-personas-conversational-engagement.md`
- `packages/backend/prisma/schema.prisma`
- `packages/backend/src/infrastructure/content/adapters/content-adapter.interface.ts`
