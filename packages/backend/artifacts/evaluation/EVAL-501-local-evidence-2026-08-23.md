# EVAL-501 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local source/unit/schema evidence; no real database migration, Langfuse sync, staging, production, or operator acceptance.

## Implemented

- Additive `PostReviewDecision` Prisma model and migration. Historical `Post.status` values are
  not converted into synthetic review decisions.
- Shared Zod feedback contract with reason codes, optional rubric, duplicate-code rejection and
  500-character comment bound.
- Approve/reject now execute conditional `Post` transition plus one review decision in the same
  Prisma transaction. Concurrent transitions are rejected by the conditional update.
- Decisions preserve original/final SHA-256 content hashes, Unicode-aware normalized edit distance,
  generation run and optional Langfuse trace metadata, actor id and `PENDING` sync state.
- Existing clients remain compatible: feedback and actor identity are optional; reason enforcement
  is opt-in through `REVIEW_FEEDBACK_ENFORCE_REASONS=false`.

## Local evidence

- PostsService + controller — exit 0, 2 files / 46 tests.
- Review hash/edit-distance utilities — exit 0, 1 file / 4 tests.
- Feedback-enabled UI store/dialog — exit 0, 2 files / 12 tests.
- Broad backend unit lane excluding only the independent QuoteCard render file — exit 0,
  149 files / 1,878 tests.
- `pnpm exec prisma generate` — exit 0.
- `pnpm exec prisma validate` — exit 0.
- Backend TypeScript typecheck — exit 0 after generated client update.

## Not proven

`EVAL-501` remains `VERIFY`: the migration was not applied to a real PostgreSQL instance in this
lane, and no production/operator review or Langfuse synchronization evidence exists. `EVAL-502`
must add idempotent sync/reconciliation before the feedback loop can be considered complete.
