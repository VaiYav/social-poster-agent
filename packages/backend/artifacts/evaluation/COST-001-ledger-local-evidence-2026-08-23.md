# COST-001 durable usage ledger local evidence

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local durable provider-attempt accounting and cost dashboard; no provider billing,
external Redis/Postgres, budget-enforcement or production cost evidence.

## Implemented

- Additive `LlmUsageEvent` model and migration stores provider/model/role, input/output tokens,
  cost provenance, cache hit, outcome and latency without prompt text or secrets.
- `LlmUsageLedgerService` persists every available provider attempt from `LlmService`; accounting
  failures are isolated from the generation response path.
- `GenerateOptions` accepts optional account/post attribution and generation run IDs are reused for
  durable run attribution.
- `GET /analytics/cost` aggregates cost, tokens, cache hits, account/provider totals and daily
  values; Analytics shows a seven-day LLM cost card.
- Optional `LLM_DAILY_BUDGET_PER_ACCOUNT_USD` performs a conservative atomic pre-call reservation
  keyed by account/day and fails closed before provider invocation when the cap is exhausted.
- Optional prompt compression supports a bounded sidecar contract and deterministic duplicate-line
  fallback; it is disabled by default and only runs above the configured token threshold.
- Optional cost-aware provider ordering uses the existing price table and preserves default role-chain
  ordering when disabled.

## Local evidence

- Prisma generate/validate — exit 0.
- Backend TypeScript typecheck — exit 0.
- LLM ledger, Analytics cost, budget and LLM service wiring lane — exit 0, 3 files / 58 tests.
- Prompt compression and cost-router focused tests — exit 0.
- UI Analytics cost card lane — exit 0, 1 file / 1 test; UI type-check — exit 0.
- Owned formatting and diff checks — exit 0.

## Remaining gate

- Add documented degradation actions after a cap (cheap model, judge/image suppression and operator
  alert) and verify the reservation under real Redis concurrency.
- Move hook cache to shared Redis and implement semantic cache only behind quality and cost evaluation
  gates; compression and opt-in price ordering are now locally wired.
- Provider billing, external database/Redis, staging, production and financial reconciliation remain
  `VERIFY`.
