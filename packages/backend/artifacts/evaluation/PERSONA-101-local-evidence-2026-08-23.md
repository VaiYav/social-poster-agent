# PERSONA-101 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local schema/shared-contract/service evidence; no live persona operator acceptance, staging, production, or held-out distinguishability eval.

## Implemented

- Shared validated `PersonaProfileSchema` with identity, voice, modes, pillars, network adapters,
  first-person and claim policies.
- Additive Prisma models `EditorialPersona`, `PersonaRevision` and
  `AccountPersonaAssignment`; normalized `Post.personaRevisionId`, `voiceMode` and
  `experimentAssignmentId` fields.
- `PersonaProfileService` validates profiles, calculates stable checksums, creates immutable
  revisions, deactivates old assignments transactionally, resolves safe global fallback and seeds
  two DRAFT defaults (`cosmic_analyst`, `rhythm_companion`).
- `IAuthorContextPort` contract preserves persona revision, voice mode, disclosure and safety
  policy identity without exposing Prisma to consumers.
- Generation now resolves AuthorContext per selected network account with a global fallback,
  and saves only revision/mode/account provenance on the generated post.
- Persona management API exposes list/create/revision/assignment/context resolution routes.
- Persona management routes are admin-guarded; operator UI shows revision checksums, disclosure,
  voice modes and assigns one immutable revision/mode to an account.

## Local evidence

- Persona service/schema focused suite — exit 0, 1 file / 6 tests.
- Generation graph persona contract — exit 0, 1 file / 21 tests including PERSONA-102 context
  prompt and output propagation regression.
- Prisma generate/validate — exit 0.
- Backend TypeScript typecheck — exit 0.
- Owned formatting checks — exit 0.
- Persona management UI lane — exit 0, 1 file / 2 tests; UI type-check — exit 0.

## Remaining PERSONA-001 / PERSONA-102 work

Operator preview/UI, first-person/truth gate evaluation and held-out two-persona
distinguishability evaluation remain. Provider/staging/manual persona acceptance is also not
proven by this local snapshot.
