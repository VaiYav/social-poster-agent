# GROUND-101 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local structured evidence/memory lifecycle and lexical retrieval; no hosted/vector
retrieval, live knowledge review or held-out retrieval quality evidence.

## Implemented

- Additive `KnowledgeEvidence` and `PersonaMemory` models with migration
  `20260823180000_add_grounding_evidence_memory`.
- Domain ports `IKnowledgeRetrievalPort` and `IPersonaMemoryPort`; Prisma-backed GroundingService
  keeps consumers independent of storage details.
- Evidence is eligible for retrieval only when `VERIFIED` and within validity dates; memory starts
  as `CANDIDATE` unless explicitly marked otherwise and supports approve/reject/supersede/purge.
- Bounded deterministic lexical retrieval returns IDs, source metadata and scores; no vector DB is
  introduced before the planned M4 corpus/eval gate.
- Admin API exposes ingestion/review/search and memory lifecycle operations.
- Grounding review endpoints are admin-guarded and expose bounded evidence/memory queues; the
  operator UI supports evidence verify/reject and memory candidate approve/reject actions.
- AuthorContext resolution accepts a bounded retrieval query and attaches lexical memory/evidence
  traces to generation prompt context; unavailable retrieval is recorded as `UNAVAILABLE`.
- Engagement suggestions fail closed for factual/high-risk claims without verified evidence IDs and
  for first-person claims without an approved persona memory.
- Explainable conflict detector compares retrieved memory/evidence subject overlap and opposing
  polarity, returning `OPPOSING_POLARITY_REVIEW_REQUIRED` without auto-selecting a truth.

## Local evidence

- Grounding/persona/policy/engagement focused lane — exit 0, 6 files / 46 tests.
- Grounding review UI lane — exit 0, 1 file / 2 tests; UI type-check — exit 0.
- Contradiction detector lane — exit 0, 2 files / 4 tests.
- Backend TypeScript typecheck and Prisma validate — exit 0.
- Owned formatting/lint checks — exit 0.
- Broad backend unit lane excluding the known resource-sensitive QuoteCard test — exit 0,
  159 files / 1,924 tests.

## Remaining gate

- Connect retrieved evidence/memory into suggestion claim gates and add retrieval-specific
  regression coverage for active persona contexts.
- Add contradiction/evidence held-out evaluation and privacy deletion verification; the current
  detector is deterministic triage, not a truth verdict.
- Hosted/vector retrieval, re-embedding and production purge evidence remain future M4/manual gates.
