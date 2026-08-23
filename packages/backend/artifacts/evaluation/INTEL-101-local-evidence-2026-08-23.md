# INTEL-101 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local privacy-first demand signal/cluster foundation; no hosted extractor, live public
source ingestion, human cluster review or product export evidence.

## Implemented

- Additive `AudienceSignal`, `AudienceQuestionCluster`, `AudienceClusterMembership` and
  `ProductInsightProposal` models with migration `20260823190000_add_demand_radar_foundation`.
- Public signal minimization blocks private/Soulwise/sensitive personal input, supports English-only
  pilot, redacts links/emails and stores bounded text plus hashed author reference only.
- Idempotent signal ingestion by network/source snapshot/signal type and exact normalized cluster
  assignment with bounded demand score/counts.
- Cluster review states and aggregate-only product insight proposal guard; no automatic FAQ/product
  backlog mutation.
- Admin API exposes signal ingest/list, cluster list/review, insight proposal and author purge.
- Operator Demand Radar UI lists privacy-minimized clusters, exposes human review/validation/archive
  actions and permits aggregate-only insight proposals after validation.
- Deterministic bounded extractor proposes English public question candidates and marks ambiguous or
  sensitive candidates for review without persisting or auto-validating them.

## Local evidence

- Demand/extractor/persona/policy/engagement focused lane — exit 0, 2 files / 6 extractor tests
  (plus the existing 7-file / 49-test lane).
- UI Demand Radar lane — exit 0, 1 file / 2 tests; UI type-check — exit 0.
- Backend TypeScript typecheck and Prisma validate — exit 0.
- Owned formatting/lint checks — exit 0.
- Broad backend unit lane excluding the known resource-sensitive QuoteCard test — exit 0,
  159 files / 1,924 tests.

## Remaining gate

- Add richer cluster assignment beyond exact normalized keys and validate the extractor with the
  EVAL-203 dataset/release gate.
- Add source deletion recomputation and outcome instrumentation.
- Live public-source, privacy review, held-out quality and Soulwise bridge export evidence remain
  unproven.
