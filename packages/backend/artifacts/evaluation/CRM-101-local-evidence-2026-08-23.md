# CRM-101 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local public creator identity/relationship foundation; no live platform ingestion,
provider/staging, production identity-linking or manual outreach evidence.

## Implemented

- Additive Prisma models and migration for `CreatorProfile`, `CreatorRelationship`,
  `CreatorInteractionEvidence`, `CollaborationOpportunity` and explicit
  `CreatorIdentityLink` records.
- Network-scoped canonical handles with SHA-256 lookup hashes and HTTPS allowlists for X,
  Threads and Facebook public profile URLs.
- Account/persona ownership edge with explicit relationship stages, explainable stage evidence and
  optimistic version checks for human-reviewed transitions.
- Idempotent evidence ingestion keyed by relationship, evidence type and evidence hash; repeated
  evidence does not inflate interaction or reciprocity counters.
- Explicit future cooldown records, cooldown-aware next-action recommendations with no autonomous
  outreach action, durable `DO_NOT_ENGAGE` propagation and proposal blocking.
- Human-created collaboration opportunity records containing rationale, risks and account/persona
  ownership; no DM, contact enrichment or private profile fields are implemented.
- Cross-network identity links require two existing network-scoped profiles plus explicit public
  evidence, reviewer and reason; unlinking is an auditable status change and profile purge cascades.
- Successful public like/comment/repost/quote outcomes now feed evidence only into an existing
  manually curated network/account relationship; unknown handles are ignored and CRM failures do
  not fail the engagement interaction.
- Admin controller endpoints for public profile curation, relationship/evidence review, transitions,
  cooldown-aware next action, collaboration proposals and purge.
- Operator UI for the relationship signal board, evidence counters, cooldown action and durable
  `DO_NOT_ENGAGE` action, with explicit copy that recommendations never send outreach.
- Operator evidence timeline and human-reviewed cross-network identity link/unlink controls.

## Local evidence

- `npx prisma generate` — exit 0.
- `npx prisma validate` — exit 0.
- Backend `npx tsc --noEmit` — exit 0.
- CRM unit lane — exit 0, 1 file / 9 tests.
- Engagement/CRM integration seam lane — exit 0, 2 files / 35 tests.
- UI Creator Relationships lane — exit 0, 1 file / 2 tests; UI type-check — exit 0.
- Owned `oxfmt`, `oxlint` and `git diff --check` — exit 0.

## Remaining gate

- Add interaction-to-relationship ingestion wiring and connect the cooldown/over-targeting gate to
  the engagement recommendation boundary (`ENGAGE-102` remains the follow-up pilot task).
- Run privacy/red-team, stage/next-action labelled evaluation and purge verification against a real
  Postgres database.
- Provider/platform, staging, manual human-outreach and collaboration attribution evidence remain
  `VERIFY`; this local slice does not authorize automated outreach or production claims.
