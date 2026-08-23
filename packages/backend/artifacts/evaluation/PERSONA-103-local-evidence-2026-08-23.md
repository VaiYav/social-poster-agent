# PERSONA-103 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local deterministic portfolio planner, generation dispatch and persistence/provenance;
no hosted evaluation or production outcome evidence.

## Implemented

- Additive `EditorialOpportunity` and `EditorialAssignmentRecord` models with migration
  `20260823170000_add_editorial_portfolio_planner`.
- Deterministic planner applies open/expiry/thesis-saturation/health/policy/risk-capacity hard
  constraints before scoring candidates.
- Explainable score components cover persona fit, demand, freshness, novelty, pillar/funnel deficit,
  conversation opportunity, review capacity and cost efficiency.
- Tie-breaking is deterministic by account ID; `SKIP` and `DEFER` are explicit terminal outputs.
- Persona module exposes opportunity listing and a validated planning endpoint; assignment persistence
  is transactionally idempotent and wired into generation dispatch per network.
- Generation dispatch creates/reuses a network-scoped opportunity, ranks active account/persona
  candidates, reorders the selected account before graph execution and stores `editorialAssignmentId`
  in draft `llmMetadata` provenance. Existing active assignments are reused on retry.

## Local evidence

- Portfolio planner/service/persona/generation focused lane — exit 0, 3 files / 50 tests.
- Backend TypeScript typecheck — exit 0.
- Prisma generate/validate — exit 0.
- Owned formatting/lint checks — exit 0.
- Broad backend unit lane excluding the known resource-sensitive QuoteCard test — exit 0,
  159 files / 1,924 tests.

## Remaining gate

- Add held-out portfolio duplicate/contradiction evaluation and EVAL-203 release-gate evidence.
- Validate account/policy/reputation inputs against staging/live state; no external outcome evidence is
  claimed here.
