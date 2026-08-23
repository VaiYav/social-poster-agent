# ADR-008: Editorial Persona, Memory, and Conversational Engagement Boundaries

**Status:** Accepted — v1 scope
**Date:** 2026-08-22
**Decider:** Valentyn Yakovliev
**Features:** `PERSONA-001`, `ENGAGE-001`, `GROUND-001` in `docs/planning/FEATURES.md`
**Extends:** ADR-003 (LangGraph generation), ADR-004 (hexagonal ports), ADR-006 (autonomous agent)
**Roadmap:** `ROADMAP_V2.md` v2.2, proposal `(08)`

**Acceptance record:** Product owner approved on 2026-08-23. v1 is limited to versioned
personas/AuthorContext, structured Postgres memory, Threads `HUMAN_APPROVAL_REQUIRED`, X
`SUGGEST_ONLY`, no fabricated lived experience, and no autonomous outreach or truth-changing
memory writes. Execution-mode promotion still requires the gates below.

## Context

SPA is moving from one global brand voice and network-level personas to 2–3 distinct English
editorial accounts for Soulwise AI. The initial networks are Threads and X. Threads discovery is
expected to be reply-first; X replies require a stricter suggestion/approval boundary.

The current architecture has useful foundations but no stable author identity:

- generation state carries a global `brandVoice` and network-level persona;
- the account is selected outside the graph and is not part of the author context;
- engagement `PostContext` does not carry persona, prior-conversation, grounding, risk, or policy
  context;
- prompt examples encourage human impersonation and invented lived experience;
- Redis checkpoints are temporary workflow state, not durable memory;
- outcome analytics are not versioned by persona revision or experiment assignment.

The new design must preserve SPA’s hexagonal architecture, prevent cross-account memory leakage,
remain right-sized for two initial accounts, and fail closed for medical, relationship, privacy and
platform-policy risk.

## Decision

### 1. Editorial Persona is a versioned domain aggregate

Create an `EditorialPersona` aggregate with immutable `PersonaRevision` snapshots and time-bounded
`AccountPersonaAssignment` records.

- Persona identity is independent from `SocialAccount` and `SocialNetwork`.
- One persona may be shared across related network accounts through different network adapters.
- One account has at most one active persona assignment.
- Editing a persona creates a new revision; published content retains the original revision ID.
- Public disclosure and safety policy are mandatory parts of every active revision.

### 2. Generation and engagement consume one resolved AuthorContext

Introduce `IAuthorContextPort`. Its implementation composes:

- account and active persona revision;
- network adapter;
- selected voice mode and experiment assignment;
- validated persona memories and approved examples;
- verified knowledge evidence;
- recent-output and prior-interaction exclusions;
- first-person, claim, safety and execution policy.

`GenerationService`, `EngagementDecisionService`, and the orchestrator consume this port. They do
not query persona tables directly.

### 3. Account + persona revision is the creative generation unit

Topic grounding may be shared across accounts, but hooks, examples, draft, critique, refine and
persona evaluation run per target account/persona revision. A generated post is never copied to
multiple same-network persona accounts as the normal personalized path.

### 3.1 A deterministic portfolio planner owns cross-account assignment

Introduce `EditorialOpportunity` and immutable assignment records above generation/engagement.
The planner chooses account, action, thesis, angle and voice mode while enforcing hard constraints
for duplicate theses, persona commitments, pillar/funnel coverage, account health, risk and platform
policy.

For two to three accounts, use deterministic constraints plus explainable weighted scoring. Reject
an LLM-only planner and a general optimisation solver at initial scale. `SKIP`/`DEFER` remain valid
outcomes, and planner configuration changes pass the AI Change Release Gate `(09)`.

### 4. Durable memory is explicit domain data in PostgreSQL

Create typed persona and interaction memory records in PostgreSQL behind `IPersonaMemoryPort` and
`IKnowledgeRetrievalPort`.

- Redis/LangGraph checkpoints remain short-lived crash-resume/HITL state.
- M1–M3 starts with structured metadata, recency and approved-example retrieval.
- M4 may add Postgres full-text search plus `pgvector` hybrid retrieval.
- No separate vector-database service is introduced initially.
- Embedding model/version and source provenance are stored with every embedded record.

LangGraph may technically accept a Store, but domain code will not depend directly on a generic
LangGraph Store. An adapter may use Store semantics internally if it preserves the domain port.

### 5. Memory classes and write authority remain separate

The system distinguishes:

- verified knowledge;
- persona stance;
- persona episode;
- approved style example;
- published commitment;
- interaction summary;
- performance memory;
- invocation working context.

Generated output creates a `MemoryCandidate`, not verified memory. Facts, lived experiences,
contradictions and sensitive material require operator approval. Engagement performance may adjust
mode recommendations but cannot change facts, biography, safety rules or disclosure.

### 6. Global prompts receive persona variables

Keep a small global prompt registry in Langfuse and pass structured persona context as variables.
Do not create normal-operation prompt labels per account. Per-account/per-persona labels are
reserved for explicit experiments, so prompt lineage remains manageable.

Prompt precedence is:

1. global platform/truth/safety/privacy/disclosure policy;
2. verified evidence and claim eligibility;
3. immutable persona revision;
4. network adapter;
5. voice mode/content style;
6. validated memories/examples;
7. current untrusted topic or public conversation.

Lower-priority context cannot loosen higher-priority policy.

### 7. Conversational engagement is suggestion-first and value-gated

Introduce a deterministic `EngagementCandidateScorer` before LLM action selection. It evaluates
topic fit, persona fit, conversational invitation, novel-value potential, continuity, duplication,
safety, and platform-policy eligibility.

- `SKIP` is terminal.
- A remaining comment budget cannot convert `SKIP`, `READ`, or a low-value decision into a reply.
- Every reply/quote begins as a persisted `EngagementSuggestion` with structured intent, claim
  trace, memory trace, judge results and policy mode.
- Approval/execution is idempotent and protected by optimistic concurrency.

### 8. Platform execution policy is an explicit versioned boundary

Introduce `IEngagementPolicyPort` with modes:

- `DISABLED`
- `SUGGEST_ONLY`
- `HUMAN_APPROVAL_REQUIRED`
- `APPROVED_AUTOMATION`

Initial decisions:

- Threads outbound replies: `HUMAN_APPROVAL_REQUIRED`.
- X outbound replies to strangers: `SUGGEST_ONLY`.
- X replies to mentions/opt-in: `SUGGEST_ONLY` until explicit written approval and an approved
  transport are recorded.
- Quotes/reposts: `HUMAN_APPROVAL_REQUIRED`.

Promoting an execution mode requires current primary-source policy evidence, an ADR/roadmap
decision, staged soak, auditability and a kill switch. A prompt or environment-variable change
alone is insufficient.

### 9. Truth and first-person contracts are hard gates

Every claim is classified as factual, lived experience, opinion, symbolic interpretation, or
product fact.

- Factual claims require eligible evidence.
- Lived experience requires an approved persona episode.
- Opinions must not disguise medical/factual certainty.
- Astrology is framed as interpretation, not deterministic causation.
- Cycle content cannot diagnose or treat.
- Relationship content cannot infer private conditions or make deterministic life decisions.
- High-risk failure routes to rewrite, human review, or skip; it never degrades to unchecked text.

### 10. Load-bearing analytics dimensions are normalized

`Post`, `Interaction`, and `EngagementSuggestion` store normalized persona revision, voice mode,
policy mode and experiment assignment IDs. Variable retrieval/claim/prompt traces remain JSON.

Persona experiments are separate from current `PostVariant` copy variants. Identity remains fixed
per account; voice mode, prompt label, example selection and thresholds are safer online treatment
variables.

### 11. Fine-tuning is held behind an evidence gate

Initial personalization uses versioned profiles, dynamic few-shot examples, memory/RAG and evals.
Fine-tuning is considered only after a held-out baseline and a substantial approved edit/output
dataset exist. If approved, prefer a shared persona-conditioned style model, while knowledge and
memory remain retrieval-based.

## Rationale

- Separating persona from account allows one identity to adapt across networks without duplicating
  or drifting its core worldview.
- Immutable revisions make every published action reproducible and rollback-safe.
- Explicit domain memory prevents workflow checkpoints and generated output from becoming an
  unaudited truth store.
- A shared AuthorContext prevents generation and engagement from developing incompatible voices.
- A single portfolio planner prevents accounts from cannibalising topics or publishing
  contradictory/duplicate theses while keeping persona identity independent.
- Suggestion-first engagement supports product learning without assuming that every platform
  permits unsolicited automated replies.
- Global prompts plus persona variables avoid Langfuse label explosion.
- PostgreSQL is sufficient for the initial scale and keeps joins with posts, interactions,
  experiments and metrics straightforward.
- Hard truth/first-person gates address the highest-trust failure in the current prompts: invented
  human experience.

## Consequences

### Positive

- Distinct accounts become testable and auditable.
- Generation, comments, quotes and inbound replies use one identity model.
- Persona changes are reproducible and reversible.
- Memory can grow without silently poisoning facts or biography.
- Platform policy becomes executable configuration with evidence, not an informal prompt rule.
- Sensitive Soulwise domains gain explicit safety and privacy boundaries.
- Existing LangGraph, Langfuse, Prisma, PostMetrics and operator-dashboard investments are reused.

### Negative

- Additional schema, admin UI, background workers and eval datasets are required.
- Account-specific creative generation multiplies some LLM calls.
- Human review remains necessary for the conversational pilot.
- Hybrid retrieval adds operational complexity when introduced in M4.
- Two accounts cannot establish a clean causal persona winner because audience effects are
  confounded.
- Policy uncertainty can block automation promotion even when local tests are green.

### Neutral / accepted trade-offs

- The design is intentionally phased: structured memory before vector retrieval, suggestions before
  autonomous replies, prompt/RAG before fine-tuning.
- `PostVariant` remains useful for copy variants but is not the persona experiment registry.
- Browser automation risks documented elsewhere are not solved by persona architecture.

## Alternatives considered

### Store persona as `SocialAccount.settings` JSON

Rejected as the canonical model. It is quick but loses immutable revision history, shared identity
across networks, normalized analytics, rollback, memory ownership and explicit invariants.

### Extend `AccountPromptProfile` with larger text blobs

Partially retained only as a migration source. Text blobs cannot reliably represent memory
lifecycle, evidence, contradictions, experiments or policy state.

### Create separate persona prompts/labels in Langfuse

Rejected for normal operation. It creates label proliferation and couples identity editing to
prompt deployment. Labels remain available for experiments.

### Use one persona per network

Rejected. Platform register is an adapter, not identity. A stable editorial author may appear on
both Threads and X.

### Compile LangGraph directly with a generic long-term Store

Rejected as the domain boundary. It is convenient but exposes framework-specific key/value
semantics to business logic and makes normalized analytics/privacy workflows harder. It remains a
possible adapter implementation.

### Introduce Pinecone/Chroma immediately

Rejected as premature for two initial accounts. PostgreSQL structured retrieval and later
`pgvector` provide a smaller operational surface.

### Fine-tune one model per account

Rejected for the initial system. It is costly, difficult to evaluate, stale for knowledge, and
incompatible with the current multi-provider fallback behavior.

### Automatically learn from every published/generated output

Rejected because it creates self-reinforcement, factual drift, clickbait optimization and memory
poisoning. All semantic learning passes through candidate validation.

### Enable `ENGAGEMENT_COMMENT_FIRST` and increase budgets

Rejected. The current behavior can convert a non-comment decision into a reply merely because a
budget remains. The new design requires a positive value/policy gate first.

## Implementation constraints

- Complete multi-account isolation before persona-enabled posting or engagement.
- Refactor engagement behind ports before enabling the conversational pilot (R4 moves earlier in
  `ROADMAP_V2`).
- Use existing `.js` import convention in orchestrator files.
- Preserve current Langfuse callback/ALS propagation and add only safe metadata.
- Never log raw memories, public handles, social content, private Soulwise data, or evidence text to
  Sentry/Langfuse.
- Run expensive integration/browser lanes serially and retain terminal evidence.
- External platform acceptance, policy approval and live API capability are separate from local
  code/test acceptance.

## Migration and rollback

1. Add nullable normalized foreign keys and new persona/memory/suggestion tables.
2. Seed two DRAFT personas and preview them without changing runtime behavior.
3. Assign personas behind feature flags; keep global brand voice as rollback fallback only before
   persona activation.
4. Record persona revision on new posts/suggestions; do not rewrite historical records.
5. Enable own-post generation per account after eval gates.
6. Enable suggestion queue without network execution.
7. Run Threads approval-required and X suggestion-only pilots.
8. Roll back by disabling feature flags and ending assignments; immutable data remains for audit.

No rollback deletes persona revisions, suggestions, memories or interaction history.

## Validation before implementation and promotion

Required before status changes to Accepted:

- proposal `(08)` reviewed and public persona copy approved;
- current external platform policy/API research attached;
- data ownership and privacy retention approved;
- migration reviewed;
- account/persona isolation tests designed;
- truth, first-person and sensitive-domain eval set approved;
- exact ROADMAP_V2 gates and owners accepted.

Required before any execution-mode promotion:

- provider/platform policy evidence;
- official transport capability verified;
- policy matrix tests;
- human-reviewed soak results;
- duplicate-execution and kill-switch evidence;
- observability dashboard and runbook.

## References

- `docs/roadmap/08-editorial-personas-conversational-engagement.md`
- `docs/roadmap/01-multi-account.md`
- `docs/roadmap/02-per-account-settings.md`
- `docs/roadmap/04-per-account-prompts-brand-voice.md`
- `docs/roadmap/05-llm-token-cost-optimization.md`
- `docs/adr/ADR-003-langgraph-generation.md`
- `docs/adr/ADR-004-hexagonal-ports.md`
- `docs/adr/ADR-006-autonomous-agent-architecture.md`
- `docs/reviews/engagement.md`
- `packages/backend/src/domain/ports/engagement-decision.port.ts`
- `packages/backend/src/modules/engagement/engagement-decision.service.ts`
- `packages/backend/src/modules/engagement/human-behavior-engine.ts`
- `packages/backend/src/modules/generation/generation.graph.ts`
- `packages/backend/src/modules/generation/generation.service.ts`
- Meta Threads creator guidance: <https://about.fb.com/news/2024/10/find-your-community-with-new-threads-educational-insights/>
- X automation rules: <https://help.x.com/en/rules-and-policies/x-automation>
- LangGraph memory: <https://docs.langchain.com/oss/javascript/langgraph/add-memory>
