# REFACTOR-105 unified emitted `.js` imports local evidence

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local import-convention migration and regression evidence; no production/deployment
acceptance evidence.

## Implemented

- All relative imports and dynamic imports under backend `src`, `tests` and `scripts` now use
  explicit emitted `.js`/`.json` specifiers; TypeScript source suffixes are not used in runtime
  imports.
- Added `scripts/validate-js-imports.mjs` and wired it into the backend `lint` script so mixed
  relative-import style cannot return silently.
- Removed the obsolete `modules/trending/google-trends-rss.ts` re-export shim; the trending
  scraper and parser tests import the infrastructure parser directly.

## Local evidence

- Import validator — exit 0, `MISSING=0`.
- Full backend typecheck (`npx tsc --noEmit`) — exit 0.
- Full backend unit lane (`tests/unit/`) — exit 0, 175 files / 1,974 tests.
- Official backend lint (`pnpm lint`, oxlint + import validator) — exit 0.
- Owned `git diff --check` — exit 0.

## Remaining gate

- CI first green run and production/deployment evidence remain `VERIFY`.
