# EVAL-701 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local read-only analytics contract/UI evidence; no calibrated human dataset, hosted Langfuse experiment, staging or production SLO data.

## Implemented

- `GET /analytics/review-calibration?days=1..365` reports durable review decisions,
  reason/rubric/trace/hash coverage, sync status, average edit distance and preliminary
  judge-human agreement, confusion metrics and Cohen's kappa.
- Calibration explicitly returns `INSUFFICIENT_SAMPLE` until 30 paired dimension labels exist;
  it is diagnostic and cannot promote a judge automatically.
- Pure calibration metrics include confusion counts, accuracy, precision, recall, F1, TPR, TNR
  and Cohen's kappa with explicit nulls for empty/single-class evidence.
- Analytics UI renders evidence coverage, sync status, paired sample count and agreement state.

## Local evidence

- AnalyticsService review-calibration suite — exit 0, 1 file / 8 tests.
- Pure calibration metrics suite — exit 0, 1 file / 3 tests.
- Backend TypeScript typecheck — exit 0.
- Analytics UI view — exit 0, 1 test.
- UI typecheck — exit 0.
- UI final full suite — exit 0, 17 files / 97 tests.
- UI production build — exit 0.
- Broad backend unit lane excluding only the independent QuoteCard render file, before the final
  pure calibration-metrics addition — exit 0, 149 files / 1,878 tests.

## Not proven

`EVAL-701` remains `VERIFY`: no real human calibration labels, kappa/confusion report,
production SLO window, provider cost export or hosted evaluation run was available.
