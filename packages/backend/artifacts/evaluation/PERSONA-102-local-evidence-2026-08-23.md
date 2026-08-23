# PERSONA-102 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local generation graph, prompt and persistence evidence; no provider, staging, manual
operator or held-out distinguishability proof.

## Implemented

- Generation graph accepts structured per-network `AuthorContext` and renders role, worldview,
  voice mode, network rules, disclosure, claim policy and first-person policy into hook/draft/
  critique/refine context.
- Existing prompt templates remain compatible: context is also embedded into existing brand voice
  or gate variables so older Langfuse prompt versions receive it.
- Generated outputs carry account, persona revision, voice mode, experiment assignment and source;
  persisted `Post` rows store the revision/mode fields and bounded provenance in `llmMetadata`.
- Generation traces include per-network account/revision/mode/source metadata.
- Global fallback remains explicit and forbids fabricated biography or lived experience.

## Local evidence

- Generation/persona focused lane — exit 0, 3 files / 66 tests.
- Backend TypeScript typecheck — exit 0.
- Prisma generate/validate — exit 0.
- UI type-check/build — exit 0 for the existing operator surface.
- Owned formatting and lint checks — exit 0.

## Remaining gate

- Held-out paired persona evaluation must show intended voice distinguishability without unsafe
  first-person claims.
- Persona assignment UI is covered by PERSONA-101; generated-context preview and live review remain
  unimplemented.
- Provider/staging/manual evidence for Langfuse trace linkage and real account selection remains
  `VERIFY`, not local PASS.
