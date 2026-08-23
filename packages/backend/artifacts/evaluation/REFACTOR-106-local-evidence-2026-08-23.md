# REFACTOR-106 dead multilingual config removal local evidence

Date: 2026-08-23  
Source SHA: `74a1e7cc5e32bb90453f2809876f840724cc6a24` plus current dirty worktree changes  
Boundary: English-only generation configuration cleanup and local regression evidence; no
production, provider, staging or live-network acceptance evidence.

## Implemented

- Removed the dead `POSTING_LANGUAGES` environment surface and the multilingual posting-language
  field from shared account settings, backend defaults/resolution and the Accounts UI.
- Removed the unused language-pack module and multilingual prompt instruction tables.
- Kept the generation path explicitly English-only while preserving immutable source/topic language
  metadata and the post language contract used by downstream records.
- Updated account-settings and English-only generation tests plus the per-account settings roadmap
  contract so the source of truth matches the runtime.

## Local evidence

- Backend typecheck (`npx tsc --noEmit`) — exit 0.
- Backend lint (`pnpm lint`, oxlint + explicit emitted-import validator) — exit 0.
- Full backend unit lane (`tests/unit/`) — exit 0, 175 files / 1,972 tests.
- UI typecheck (`pnpm type-check`, vue-tsc) — exit 0.
- UI test lane — exit 0, 24 files / 113 tests.
- Targeted account-settings regression lane — exit 0, 18 tests.
- Repository `git diff --check` — exit 0.
- Repository scan found no remaining `POSTING_LANGUAGES`, `postingLanguages`,
  `postingLanguage`, `language-packs`, `LANGUAGE_NAMES` or `LANGUAGE_INSTRUCTIONS` references in
  backend source, shared source, UI source, backend tests, `.env.example` or the affected roadmap.

## Remaining gate

- Clean-resource verification, CI/deployment, provider credentials, staging soak, native browser
  and live-network acceptance remain `VERIFY`.
