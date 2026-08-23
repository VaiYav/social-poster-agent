# PLAN-006 planning-document guard local evidence

Date: 2026-08-23
Boundary: planning-document governance only; no runtime behavior or task status was
claimed from code presence.

## Implemented

- Added `scripts/validate-planning-docs.mjs` and the root `planning:check` command.
- Added the guard to `.github/workflows/ci.yml` before runtime lint/build/test jobs.
- The validator checks required canonical planning entry points, task/feature/archive
  row IDs and statuses, duplicate canonical IDs, every `docs/roadmap/*.md` mapping in
  `DOCUMENT_MAP.md`, and active status rows outside canonical planning files.
- Research-only `roadmap/07-additional-features-research.md` is explicitly allowed to
  map to `none`; it cannot silently become a feature status source.
- `PLAN-003` and `PLAN-004` decisions are recorded in the planning archive, and the
  multi-account summary/detail boundary is documented without deleting either file.

## Local evidence

- `pnpm planning:check` — exit 0.
- `git diff --check` — exit 0 for the owned planning/guard slice.

## Remaining gate

`PLAN-006` remains `VERIFY` until the workflow runs on a clean SHA in GitHub Actions.
