# ENGAGE-101 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local candidate/suggestion contracts and policy-gated executor evidence; no live
Threads/X review or network execution.

## Implemented

- Deterministic `EngagementCandidateScorer` evaluates empty/generic/unsafe/duplicate candidates,
  topic fit, conversation invitation, novel-value potential and continuity. `SKIP` is terminal.
- Additive `EngagementSuggestion` Postgres model stores account, persona revision, source snapshot,
  intent, content, claim/memory/judge traces, policy mode, expiry and version.
- `EngagementSuggestionService` persists proposed suggestions and supports idempotent-ish
  optimistic-concurrency approve/edit/reject/expire transitions. Disabled-policy suggestions and
  unsafe text are rejected before persistence.
- Admin suggestion API exposes list/detail and review lifecycle endpoints. It does not execute
  network actions; execution remains separately gated by POLICY-101.
- HumanBehaviorEngine now runs the scorer before LLM action selection and routes reply/quote
  actions with `SUGGEST_ONLY` or `HUMAN_APPROVAL_REQUIRED` into the durable suggestion queue;
  direct EngagementService and PostingService still use POLICY-101 immediately before side effects.
- Operator suggestion queue UI supports approve, edit-and-approve, reject and expire through the
  versioned admin API; the UI explicitly states that review does not execute a network action.

## Local evidence

- Candidate scorer suite — exit 0, 1 file / 3 tests.
- Suggestion service + policy/engagement focused lane — exit 0, 4 files / 16 tests.
- HumanBehaviorEngine integration lane — exit 0, 17 files / 215 tests.
- UI suggestion review lane — exit 0, 1 file / 2 tests; UI type-check — exit 0.
- Backend TypeScript typecheck and Prisma validate — exit 0.
- Owned formatting/lint checks — exit 0.
- Broad backend unit lane excluding the known resource-sensitive QuoteCard test — exit 0,
  155 files / 1,908 tests.

## Remaining gate

- Run manual Threads/X review/execute workflow; local UI review is implemented but does not prove
  native network execution.
- Run held-out quality/truth/first-person calibration and real reviewed-question soak. These are
  not proven by local unit tests.
