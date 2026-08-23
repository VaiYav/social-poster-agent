# CI-001 coverage and UI enforcement local evidence

Date: 2026-08-23
Source SHA: `92ffc15` plus current dirty worktree changes
Boundary: local CI command and UI lane only; no GitHub Actions run or clean-SHA evidence.

## Implemented

- `.github/workflows/ci.yml` runs backend `test:coverage` and a separate UI
  `vue-tsc` + Vitest job.
- Both CI jobs pin Node `24.19.0`, matching the workspace/backend/UI engine
  contract `>=24.0.0 <25.0.0`.
- `packages/backend/test:coverage` serializes the coverage worker with
  `--maxWorkers=1`, preventing inter-file Nest fixture races and shared V8 temp
  directory collisions observed under parallel lanes.
- Current committed coverage ratchet in `packages/backend/vitest.config.mts`
  excludes generated Prisma and CLI/dry-run entrypoints and enforces statements
  73%, branches 64%, functions 70%, lines 74%. The original roadmap target
  remains 80/75/80/80 and is not claimed here.
- Shared integration mocks cover the POLICY-101/reputation dependencies used by
  application-level E2E flows; browser-only legacy E2E explicitly selects the
  browser transport for Bluesky/Mastodon.
- Platform policy hashes no longer include the rolling default validity window,
  so immediate reauthorization is stable while policy/evidence changes still
  invalidate the hash.

## Local evidence

- Backend typecheck (`npx tsc --noEmit`) — exit 0.
- Workspace lint (`pnpm lint`) — exit 0.
- Targeted integration/system/acceptance regression lane — exit 0, 4 files /
  109 tests.
- Orchestrator Z1/Z5 safety lane — exit 0, 19 files / 109 tests. It covers hard-rule
  short-circuiting, LLM/rules fallback, full-loop and action budgets, Redis
  degradation, strategy dispatch, cancellation, bounded cycle history and
  leader/start-stop/checkpoint lifecycle, plus complete `StateCollectorService`
  WorldState aggregation and degraded-source fallback.
- Queue/localhost safety lane — exit 0, 2 files / 18 tests. It covers deterministic
  triage filters, side-effect application, dry-run/pause behavior, and trusted
  proxy/loopback/Docker address boundaries.
- Content/Telegram adapter lane — exit 0, 2 files / 13 tests. It covers DB topic
  mapping/health/mark-used semantics and Telegram channel/control-bot HTTP
  success, validation, HTTP, JSON, and network failure paths.
- CAPTCHA safety lane — exit 0, 1 file / 7 tests. It covers disabled/key-gated
  behavior, reCAPTCHA/hCaptcha detection and injection, provider rejection,
  polling timeout/error, malformed responses, and DOM/fetch failure fallback.
- Engagement lane — exit 0, 16 files / 213 tests. The added engager contract
  tests cover X/Threads/Facebook action wrappers, URL/profile validation,
  unsupported Facebook actions, and common navigation/scroll/extraction helpers.
- Content-pillar learning lane — exit 0, 1 file / 13 tests. It covers all
  classifier priorities, rolling ratios, recommendation/tie-break behavior,
  Redis increment/expiry semantics, and recordPost delegation.
- Recycling lane — exit 0, 1 file / 6 tests. It covers age/status candidate
  selection, SimHash duplicate filtering, batch success/skip/error accounting,
  and orchestrator/cron registration gates.
- Guarded controller lane — exit 0, 3 files / 9 tests. It covers quote-card
  file traversal/success/error paths, recycling query caps/run delegation, and
  trending event/scraper/cache endpoint delegation.
- Domain configuration lane — exit 0, 1 file / 7 tests. It covers default and
  env-backed domain values, brand-voice/prompt caching, structured JSON
  overrides/fallbacks, complete snapshots, and module initialization.
- Event-listener safety lane — exit 0, 2 files / 19 tests. It covers social
  promo POST_VERIFIED disabled/missing/success/error paths alongside SSE
  publish failure recovery, keeping the event bus fire-and-forget safe.
- Policy/engagement control-plane lane — exit 0, 2 files / 5 tests. It covers
  policy evidence/version validation and lifecycle delegation plus suggestion
  approve/edit/reject/expire validation and dispatch.
- Fixed a real QueueTriageService infinite-loop bug: `result.decisions` was
  mutated while iterating the same decision array, causing repeated REJECT
  applications and Vitest worker crashes. Decisions are now recorded once.
- Fixed a deterministic fallback starvation bug: `GeneratePostsRule` now yields
  to reply checks, DLQ triage and trend refresh when no generation network is
  healthy; the regression matrix is covered in the RulesEngine lane.
- UI typecheck — exit 0.
- UI Vitest suite — exit 0, 29 files / 136 tests.
- Latest backend unit lane on the current worktree (`pnpm --filter
  @spa/backend test:unit`, 2026-08-24) — exit 0, 206 files / 2,192 tests.
- Latest backend integration lane (`pnpm --filter @spa/backend test:integration`,
  2026-08-24) — exit 0, 5 files / 39 tests.
- Latest backend system lane (`pnpm --filter @spa/backend test:system`,
  2026-08-24) — exit 0, 3 files / 46 tests.
- Latest backend acceptance lane (`pnpm --filter @spa/backend test:acceptance`,
  2026-08-24) — exit 0, 2 files / 82 tests.
- Latest backend E2E lane (`pnpm --filter @spa/backend test:e2e`, 2026-08-24)
  — exit 0, 7 files / 47 tests.
- Full layered suite without coverage — PASS_LOCAL, 223 files / 2,406 tests and
  0 failures in the worktree based on `92ffc15`.
- Full serialized coverage suite — PASS_LOCAL in the latest terminal run:
  223 files, 2,405 passed, 1 skipped, 0 failed; Statements `75.75%`, Branches
  `66.58%`, Functions `73.82%`, Lines `77.19%`. All current ratchet floors
  `73/64/70/74` passed. The earlier full-flow 404 and STC-022 failures were
  non-reproducible under the final serialized run; the affected files also pass
  in isolation. This is local evidence only, not production or GitHub Actions
  evidence.
- The original roadmap target `80/75/80/80`, exact clean-SHA reconciliation and
  the first green GitHub Actions run remain open.
- The SimHash performance benchmark is explicitly skipped under V8
  instrumentation because coverage distorts wall-clock measurements; it remains
  active in the normal unit lane.

## Remaining gate

- Keep `CI-001` in `VERIFY` until the current scope/ratchet is reconciled on an
  exact clean SHA, the original target decision is explicit, and the first
  green GitHub Actions run is captured.
