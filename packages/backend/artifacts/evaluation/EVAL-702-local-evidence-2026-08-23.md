# EVAL-702 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local deterministic/sampling/alert unit evidence; no production observation stream, Sentry project, Discord webhook, hosted semantic judge, staging or production SLO window.

## Implemented

- `OnlineEvaluationService` runs six bounded deterministic checks on every final generated output.
- Semantic evaluation starts at configurable 5% random sampling and force-includes rejections,
  material edits, hard failures, unknown provider/model and fallback depth >2.
- Rolling bounded SLO snapshot exposes completion, unknown attribution, usage/cost coverage,
  prompt-link coverage, fallback p95 and semantic sample coverage.
- Full alert catalog foundation routes EVAL-A01–A12 to Discord/Sentry or dashboard-only as
  specified, with stable IDs, 30-minute cooldown and critical fingerprint-change behavior.
- Generation persistence invokes the online lane for root and continuation final outputs.
- `GET /analytics/online-evaluation` exposes the SLO snapshot and dashboard-only alert state;
  Analytics renders the monitoring surface.

## Local evidence

- Online evaluator/alert suite — exit 0, 1 file / 7 tests.
- Generation integration lane — exit 0, 1 file / 45 tests.
- Analytics API/evaluator focused lane — exit 0, 2 files / 13 tests.
- Backend TypeScript typecheck — exit 0.
- Backend focused formatting/lint — exit 0.
- Analytics UI focused view — exit 0, 1 test; UI typecheck/build — exit 0.

## Not proven

`EVAL-702` remains `VERIFY`: no real online output stream, hosted semantic judge, Sentry/Discord
delivery, four-week SLO baseline, or production alert drill was run. The semantic evaluator seam
is intentionally injectable and reports `UNAVAILABLE` when no judge is configured.
