# ACCOUNT-101 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus the current dirty worktree changes  
Boundary: local source/unit verification of the account/settings/session/reply/browser/limit slices; no staging, production, provider, or manual browser evidence.

## Local evidence

From `packages/backend`:

- `pnpm exec vitest run tests/unit/accounts/ tests/unit/orchestrator/state-collector.fleet.spec.ts tests/unit/sessions/sessions.service.spec.ts tests/unit/replies/replies.controller.spec.ts tests/unit/infrastructure/browser.factory.spec.ts tests/unit/infrastructure/rate-limit.service.spec.ts tests/unit/posting/posting.service.spec.ts tests/unit/infrastructure/queue.factory.spec.ts --reporter=dot` — exit 0, 9 files / 246 tests.
- `pnpm exec tsc --noEmit --pretty false` — exit 0.
- `pnpm --filter @spa/shared build` — exit 0.
- Owned oxlint and oxfmt checks plus `git diff --check` — exit 0.

The local suite covers indexed account seeding/selection/settings, account-bound session
paths, reply self-account handling, browser context behavior, rate-limit behavior, queue
idempotency and posting paths. It is LOCAL mocked/unit evidence only; browser log output
does not prove live platform behavior.

## Updated account-isolation slice

The follow-up implementation closed the source-level gaps identified below:

- generated drafts now assign one active account per network in round-robin order instead of
  duplicating one generated text to every account;
- autonomous generation checks daily/weekly capacity and in-flight posts per account and passes
  only ready account ids into `GenerationService`;
- posting queue payloads carry `accountId`, and account-scoped queue counts are available for
  waiting, active, and delayed jobs;
- `WorldState` now exposes `queueDepthByAccount` and `rateLimitsByAccount`, while preserving
  network aggregates for existing decision consumers;
- approval, auto-approve, autonomous-runner, health-reconciliation, triage, and multi-stage
  continuation enqueue paths propagate the post account id.

From `packages/backend` after those changes:

- the account-isolation lane (accounts, sessions, browser, rate-limit, posting, posts,
  autonomy, health-monitor, queue, queue factory, orchestrator, and generation tests) — exit 0,
  19 files / 408 tests;
- `pnpm exec tsc --noEmit --pretty false` — exit 0;
- `pnpm --filter @spa/shared build` — exit 0;
- full backend unit lane `pnpm exec vitest run tests/unit --reporter=dot` — exit 0,
  148 files / 1,865 tests;
- focused `oxfmt --check` and `oxlint` over the changed source/test contract — exit 0;
- `git diff --check` — exit 0.

The browser isolation contract was also exercised directly: `browser.factory.spec.ts` — exit 0,
1 file / 41 tests, including distinct same-network persistent profile paths for two account ids.

The account-settings resolver/UI slice also has local evidence:

- `tests/unit/accounts/account-settings.service.spec.ts` — exit 0, 1 file / 9 tests;
- `packages/ui` full Vitest suite — exit 0, 16 files / 93 tests;
- `packages/ui` `pnpm run type-check` and `pnpm run build` — exit 0;
- the new `/accounts` view submits only raw overrides with `PUT`, displays default/env/account
  provenance, and updates the persisted runtime `SocialAccount.active` switch.

New focused tests cover two same-network accounts with independent queue depth and rate-limit
snapshots, autonomous generation skipping an exhausted account, and round-robin draft assignment.

## Not proven

`ACCOUNT-101` remains `IN_PROGRESS`: no two same-network accounts were exercised together
through real Redis/Postgres, staging, production, or manual browser storage/fingerprint
verification. The local contract now proves account-aware selection, queue ownership,
rate-limit snapshots, and WorldState data with mocks; it does not prove live account isolation.
`ACCOUNT-102` must not be claimed from this snapshot alone.

## Source-level isolation gap

The prior source-level gap is resolved locally: `StateCollectorService.collectRateLimits()`
and `GeneratePostsHandler` use account-scoped status/capacity, and queue depth is exposed per
account from account-tagged jobs. The remaining ACCOUNT-101 gate is integration/manual/live
evidence, not another known network-only source path.
