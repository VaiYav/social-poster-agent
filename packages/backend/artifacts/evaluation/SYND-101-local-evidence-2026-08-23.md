# SYND-101 local evidence — 2026-08-23

## Boundary

- Canonical task: `SYND-101`; feature: `SYND-001`.
- Orca run: `run_643d18afe78c`.
- Orca task: `task_5847d7d0398e`.
- Dispatches: `ctx_895e5b85926e` (incomplete first attempt), `ctx_27c73f4fe878`,
  `ctx_793f0fc699b8` (worker reports); coordinator verification followed in the same
  worktree.
- Initial/final `HEAD`: `f95ff84a4359f209461371d2038d6647bc3ae09c`.
- Dirty boundary: pre-existing broad dirty boundary was preserved; coordinator baseline
  recorded 138 porcelain entries, final `git status --short --untracked-files=all` recorded
  147 entries after the canonical planning/evidence updates. No reset, checkout, clean,
  stash, stage, or commit was used.
- No live social posting, deployment, hosted-provider mutation, or real account/browser
  activity was performed.

## Implemented local slice

- `ArticleGenerationCron` now reads bounded source topics, calls the existing article
  generator, selects configured `DEVTO`/`HASHNODE`/`LINKEDIN` targets, and persists explicit
  `DRAFT` `ARTICLE` posts per available account with JSON article content, canonical URL,
  source metadata, judge metadata, and run ID. A source topic is marked used only after at
  least one draft persists; empty/no-account/generation-error paths do not consume it.
- `SyndicationModule` directly imports the modules exporting `IContentPort`, accounts, and
  posts so the new cron dependencies resolve when `SYNDICATION_ENABLED=true`.
- Article posting rejects malformed content, invalid canonical input, and an unvalidated
  published URL. The old page-URL fallback is removed.
- Article verification requires both browser visibility and the injected
  `CanonicalUrlService.verifyCanonical()` result. Missing or mismatching canonical data
  fails closed, keeps the published URL in the `POSTED` boundary, and lets the existing
  re-verification path retry without re-publishing.
- Test-only Nest parameter metadata was updated for the new cron constructor.

## Coordinator verification

All commands below were run from `packages/backend` unless noted; each exited `0`.

```text
pnpm exec vitest run tests/unit/syndication/article-generation.cron.spec.ts tests/unit/posting/article-base.poster.spec.ts tests/unit/posting/posting.service.spec.ts tests/unit/canonical/canonical-url.service.spec.ts --reporter=dot
  4 files, 74 tests passed

pnpm exec vitest run tests/e2e/posting-flow.e2e.spec.ts --reporter=dot
  1 file, 10 tests passed; mocked Nest/browser integration only

pnpm exec tsc --noEmit --pretty false
pnpm exec tsc -p tsconfig.build.json --noEmit --pretty false
pnpm exec oxlint src/modules/syndication/article-generation.cron.ts src/modules/syndication/syndication.module.ts src/modules/posting/posters/article-base.poster.ts src/modules/posting/posting.service.ts tests/helpers/restore-paramtypes.ts tests/unit/syndication/article-generation.cron.spec.ts tests/unit/posting/article-base.poster.spec.ts tests/unit/posting/posting.service.spec.ts
pnpm exec oxfmt --check src/modules/syndication/article-generation.cron.ts src/modules/syndication/syndication.module.ts src/modules/posting/posters/article-base.poster.ts src/modules/posting/posting.service.ts tests/helpers/restore-paramtypes.ts tests/unit/syndication/article-generation.cron.spec.ts tests/unit/posting/article-base.poster.spec.ts tests/unit/posting/posting.service.spec.ts
git diff --check -- packages/backend/src/modules/syndication/article-generation.cron.ts packages/backend/src/modules/syndication/syndication.module.ts packages/backend/src/modules/posting/posters/article-base.poster.ts packages/backend/src/modules/posting/posting.service.ts packages/backend/tests/helpers/restore-paramtypes.ts packages/backend/tests/unit/syndication/article-generation.cron.spec.ts packages/backend/tests/unit/posting/article-base.poster.spec.ts packages/backend/tests/unit/posting/posting.service.spec.ts
```

## Evidence classification and gaps

| Class | Result |
|---|---|
| `LOCAL` | Unit tests, deterministic mocks, source/type/build checks, lint/format and diff checks pass. |
| `INTEGRATION` | Mocked Nest `AppModule` E2E compiles with `SYNDICATION_ENABLED=true` and 10 tests pass; no real browser or platform is used. |
| `EXTERNAL` | Not run: real Dev.to account, published article, external canonical HTML, staging or production. |
| `PROVIDER` | Not run: no Dev.to/LLM/browser provider call or hosted service mutation. |
| `MANUAL` | Not run: operator approval, live canonical inspection, rollback drill and production observation. |

## Planning decision

The implementation and local acceptance evidence are sufficient for `VERIFY`, not a
terminal archive entry. The remaining external/manual gates are required before `SYND-101`
can be archived. Rollback is a targeted revert/removal of the listed SYND-101 source/test
paths; no destructive Git operation is required.
