# COST-101 reconciliation (read-only)

Date: 2026-08-23  |  source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c`  |  worktree: dirty (pre-existing; no files staged)

This is a historical reconciliation snapshot. The subsequent local ledger/compression/budget
follow-up is recorded in `COST-001-ledger-local-evidence-2026-08-23.md`.

## Evidence boundary

All evidence below is LOCAL source inspection or LOCAL synthetic/unit-test evidence. No provider calls, Langfuse mutations, external/manual, staging, production, billing, database, or Redis evidence was obtained. The referenced EVAL-104 artifact explicitly records this boundary (`packages/backend/artifacts/evaluation/eval-104-telemetry-self-test.json:5-17`).

## Claim reconciliation

| Proposal claim / requirement | Classification | Source-backed finding |
|---|---|---|
| Cache key includes provider, model, maxTokens, temperature, role | ALREADY_FIXED | `llm.service.ts:1062-1088` hashes prompts plus all five dimensions; six cache-key tests pass. |
| Creative output must bypass response cache | ALREADY_FIXED | `llm.service.ts:1193-1197` excludes `draft`, `hook`, and `vision`; routing test LS-006 passes. |
| Shared Redis and in-memory cache adapters | ALREADY_FIXED | `llm-cache.ts:4-9,16-61,63-108`; bounded service tests exercise both configured modes. This is implementation evidence, not external Redis availability evidence. |
| Semantic cache, prompt compression, cost-aware routing | SURVIVES | Not implemented in the inspected LLM path; remains COST-102/out of scope. |
| Per-account daily ledger/dashboard/API | SURVIVES | No account ledger or `LlmUsageEvent` was found in the inspected path; token budget is only orchestrator-hourly or generation-run scoped. |
| Token/cost reserve before call and actual adjustment | ALREADY_FIXED | `llm.service.ts:1298-1317,1379-1391`; failed attempts release reservations at `1418-1433`. |
| Provider/price-table/unknown cost provenance | ALREADY_FIXED | Provider metadata is preferred, then price table when usage exists, otherwise `unknown` (`llm.service.ts:1351-1371`); cache hits preserve cached provenance (`1218-1225`). |
| Usage, latency, attempt and normalized failure telemetry | ALREADY_FIXED | Attempt collector records success/error/cache-hit, token fields, cost source and latency (`llm.service.ts:1208-1225,1400-1416,1434-1443`); EVAL-104 reports full local synthetic coverage. |
| Graceful disabled observability path and redaction | ALREADY_FIXED | EVAL-104 is passed with disabled handler and 24/24 redaction injections; provider/Langfuse boundaries remain unverified externally. |
| Budget reservation rejection does not increment usage | NEEDS_DECISION | `token-budget.service.ts:55-57` promises no increment, but `atomicDelta()` executes `INCRBY/INCRBYFLOAT` before checking limits (`116-150`) and does not roll back on rejection. This is a current correctness gap, not fixed here because runtime edits are prohibited. |
| Budget scope TTL | ALREADY_FIXED | Generation keys use 24h TTL and hourly keys use 2h TTL (`token-budget.service.ts:160-179`). |

## Commands and results

* `cd packages/backend && npx vitest run tests/unit/llm/llm-service-cache.spec.ts tests/unit/llm/llm-service-routing.spec.ts tests/unit/infrastructure/llm.service.spec.ts tests/unit/evaluation/telemetry-self-test.spec.ts` — **PASS**, 4 files / 77 tests.
* `cd packages/backend && npx tsc --noEmit` — **PASS**.
* `git rev-parse HEAD` — `f95ff84a4359f209461371d2038d6647bc3ae09c`; initial `git status --short` showed extensive pre-existing dirty changes, including owned runtime/test paths. No files were modified by this reconciliation except this additive report.

## Decision

COST-101 has sufficient LOCAL source/test telemetry evidence to proceed to review, but should remain `VERIFY` pending an explicit decision and follow-up fix/test for rejected budget reservations. No production cost, quality, provider, billing, or deployment claim is supported.
