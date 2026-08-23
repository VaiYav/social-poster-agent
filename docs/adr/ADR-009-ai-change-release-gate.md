# ADR-009 — AI change release gate and evaluation system

> **Status:** Accepted for design; implementation pending
> **Date:** 2026-08-22
> **Feature:** `EVAL-001` in [the canonical feature register](../planning/FEATURES.md)
> **Detailed specification:** [evaluation hub](../evaluation/README.md)
> **Roadmap proposal:** [09 AI Change Release Gate](../roadmap/09-ai-change-release-gate.md)

## Context

SPA has a mature deterministic test suite, a multi-provider LLM router, LangGraph
workflows, Langfuse tracing/Prompt Management, a post-quality judge and operator
approve/edit/reject actions. These pieces do not currently produce a reproducible,
human-calibrated answer to “is candidate configuration B better than production A?”

The live Langfuse baseline has observations but no datasets or score configs, incomplete
prompt/provider attribution and substantial failed provider-attempt churn. Status-only
review data cannot explain why an output was edited/rejected, and browser mocks do not
prove real platform behavior.

AI-affecting changes include prompts, models, role routing, personas, judges,
retrieval/memory, tool/action policies and agent harness controls. They require a
different release boundary from ordinary deterministic code changes.

## Decision

Build one `EVAL-001` capability with four evidence lanes:

1. deterministic PR checks without external secrets;
2. trusted PR Langfuse smoke experiments;
3. frozen pre-release full regression and promotion manifest;
4. nightly drift plus post-release shadow/canary monitoring.

Use these ownership boundaries:

- Langfuse hosted datasets/experiments/scores are the evaluation system of record.
- PostgreSQL is the durable product/human-review system of record.
- The existing SPA runtime is invoked behind side-effect-free evaluation ports.
- Browser dry-run/replay is a separate reliability lane.
- The canonical feature/task status lives in `docs/planning`, not in roadmap or domain
  specification documents.

Every candidate is an immutable manifest containing source SHA, dataset boundary and
digest, exact role/model/prompt configuration, evaluator versions, budgets and run
evidence. Strict model candidates cannot use hidden fallback. Production-control runs
may use fallback only when every attempt and actual model are recorded.

Promotion applies hard gates first and paired quality/reliability/cost/latency
comparison second. Passing an experiment makes a candidate eligible for human-approved
canary; it never automatically changes production.

## Consequences

### Positive

- Model/prompt/harness decisions become reproducible and comparable.
- Provider churn is visible instead of hidden behind one final model label.
- Human decisions calibrate judge automation.
- Deterministic, semantic, manual, online and browser evidence remain distinguishable.
- A failure can be promoted into a regression dataset and permanently harnessed.

### Costs

- Curating/maintaining 120 V1 cases and human labels is ongoing product work.
- Full experiments consume provider budget and time.
- Review persistence and Langfuse synchronization require an additive DB model/worker.
- CI needs a trusted-secret lane unavailable to fork PRs.
- A strong attribution/coverage foundation must land before dashboards and model
  promotion are meaningful.

### Risks and mitigations

| Risk                       | Mitigation                                                           |
| -------------------------- | -------------------------------------------------------------------- |
| Judge bias/self-preference | Fixed external judge, human calibration, paired order randomization. |
| Test leakage/overfitting   | Train/dev/test split; one-shot held-out promotion run.               |
| Provider/model drift       | Snapshot IDs or explicit alias risk; actual model recorded.          |
| Langfuse outage            | Local immutable artifact; external result marked `BLOCKED/ERROR`.    |
| CI side effects            | Code-enforced fake/recording ports and experiment namespace.         |
| Cost runaway               | Per-stage budgets, bounded concurrency and stop-scheduling behavior. |
| Planning duplication       | Central feature register/backlog; other documents own design only.   |

## Alternatives rejected

### Use the existing Vitest suite only

Rejected because mocked deterministic tests cannot measure open-ended quality, model
variance or provider behavior.

### Use production Langfuse traces without datasets

Rejected because observational traffic is confounded, unpaired and not reproducible.

### Store evaluation only in PostgreSQL

Rejected because SPA would duplicate Langfuse experiments, annotations, scores and
analytics while coupling product state to evaluation infrastructure.

### Use one aggregate judge score

Rejected because it can average away factual/safety failures and is untrustworthy
before calibration.

### Benchmark `openrouter/free` as one candidate

Rejected because dynamic routing and free-model availability do not provide stable
model identity.

### Automatically promote the highest-scoring candidate

Rejected because metrics can be biased/incomplete and live provider/platform behavior
requires explicit canary/rollback judgment.

## Compatibility and rollout

- Runtime behavior is unchanged by this ADR.
- Database/API changes are additive and feature-flagged.
- V1 is CLI/CI-first; mutation APIs/dashboard controls are later work.
- Current LangGraph and hexagonal architecture remain.
- Existing prompt fallback remains available; evaluation identifies it explicitly.
- Rollout order and tasks are canonical in
  [BACKLOG.md](../planning/BACKLOG.md), feature `EVAL-001`.

## Revisit triggers

Revisit this ADR if Langfuse removes hosted experiments/score capabilities, the project
becomes multi-tenant with stricter data residency, evaluation volume makes the hosted
cost unacceptable, or the browser agent becomes the primary AI decision-maker rather
than a deterministic execution adapter.
