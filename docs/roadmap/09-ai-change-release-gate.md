# 09 — AI Change Release Gate

> **Document maturity:** DESIGN READY — this is a product and milestone summary,
> not an implementation status tracker.
> **Canonical feature status:** `EVAL-001` in [the feature register](../planning/FEATURES.md).
> **Decision:** [ADR-009](../adr/ADR-009-ai-change-release-gate.md).
> **Normative technical contracts:** [the evaluation hub](../evaluation/README.md).
> **Task status:** [the active backlog](../planning/BACKLOG.md).

## 1. Product problem and outcome

SPA can change a prompt, model, persona, retriever, judge or execution policy without
being able to reproduce whether the change improved quality or increased safety risk.
The product needs an evidence-gated release path for AI-affecting changes.

The outcome is an immutable, reviewable decision that links a candidate to its source
SHA, prompt/model configuration, dataset version, evaluator results and rollback target.
The gate protects quality and safety without turning local mocks into provider or
production evidence.

## 2. Product decision

Use four progressively stronger lanes:

1. **Deterministic PR lane** — local contracts, safety rules, side-effect isolation and
   static checks; no remote secrets required.
2. **Trusted smoke lane** — a small hosted Langfuse experiment for trusted changes.
3. **Pre-release lane** — a pinned full dataset, candidate manifest and human review.
4. **Nightly/production lane** — drift, shadow/canary and reviewed production feedback.

The lanes are additive. A passing deterministic lane never substitutes for a missing
hosted, provider, human or production gate.

## 3. Milestone sequence

| Milestone | Product outcome | Canonical work |
|---|---|---|
| M0 | Trace, prompt, model and usage identity is trustworthy. | `EVAL-101..104` |
| M1 | Local evaluation contracts and a reproducible dataset boundary exist. | `EVAL-201..204`, `EVAL-301..304`, `EVAL-601` |
| M2 | Human review survives outages and can calibrate automated judges. | `EVAL-501..505`, `EVAL-701` |
| M3 | Candidate changes can run in shadow/canary with rollback. | `EVAL-401..402`, `EVAL-602`, `EVAL-702`, `EVAL-801` |
| M4 | Trusted model/router comparisons can inform promotion. | `EVAL-802..804`, `COST-102` |
| M5 | Reviewed production failures refresh the evaluation set and drift loop. | `EVAL-805`, `PERSONA-201` |

The dependency order, ownership and evidence boundaries are maintained in
`docs/planning/EXECUTION_ROADMAP.md`; this table intentionally does not duplicate task
status or acceptance checklists.

## 4. What enters the gate

The gate is relevant when a change affects any of the following product decisions:

- prompts or prompt labels used in production;
- provider/model selection or fallback routing;
- persona, author context or retrieval behavior;
- structured outputs, tools, action selection or execution policy;
- judge prompts, thresholds or evaluator behavior;
- privacy, medical, relationship, platform or account-isolation rules;
- evaluation dependencies or release-control configuration.

The change detector selects the smallest applicable lane. Prompt changes made in the
Langfuse UI still require a candidate version, a pinned experiment and a promotion record.

## 5. Release decisions

Every candidate receives one of four product-level verdicts:

| Verdict | Product meaning |
|---|---|
| `PASS` | Required critical checks and agreed regression bounds pass; normal review still applies. |
| `WARN` | Non-critical drift or low directional sample; merge may proceed only with an owner and expiry, never with autonomy promotion. |
| `FAIL` | A critical case fails or an agreed regression bound is exceeded; block the candidate. |
| `ERROR` | Dataset, evaluator, provider or experiment infrastructure failed; block AI-affecting promotion and retry/diagnose. |

Critical safety, privacy, forbidden-action and cross-account failures cannot be averaged
away by a quality score. A manual override requires an owner, reason, risk acceptance,
expiry and a linked runbook; it cannot override secret leakage or forbidden side effects.

## 6. Candidate lifecycle

```text
detect change
  → run deterministic checks
  → load a pinned dataset/version
  → run candidate with recording side-effect ports
  → compare against the frozen baseline
  → record manifest and verdict
  → human review
  → shadow/canary
  → promote or roll back
```

The detailed dataset item shape, evaluator taxonomy, metric definitions, experiment API,
manifest schema, CI secret policy and rollback contracts belong exclusively to
`docs/evaluation/`. Langfuse is the experiment system of record; runtime and operational
systems retain only the immutable references required for audit and rollback.

## 7. Safety and operating boundaries

- CI and experiments never call real social side-effect ports.
- Fork PRs use sanitized deterministic checks; hosted secrets are trusted-trigger only.
- Dataset items are redacted, versioned and kept separate from held-out labels.
- Missing evaluator output or provider infrastructure is `ERROR`, not a passing zero.
- A candidate cannot self-promote; promotion and rollback remain explicit operator actions.
- Local, integration, provider, staging, manual and production evidence are reported
  separately.

## 8. Non-goals

This roadmap does not promise universal factual correctness, automatic model promotion,
one-score quality decisions, unreviewed social actions, or fine-tuning before a
held-out prompt/few-shot/RAG baseline exists.

## 9. Source-of-truth and current boundary

- Product direction and milestone order: [`docs/planning/ROADMAP.md`](../planning/ROADMAP.md).
- Feature status: [`docs/planning/FEATURES.md`](../planning/FEATURES.md).
- Task status and evidence: [`docs/planning/BACKLOG.md`](../planning/BACKLOG.md).
- Dependency order: [`docs/planning/EXECUTION_ROADMAP.md`](../planning/EXECUTION_ROADMAP.md).
- Normative evaluation design: [`docs/evaluation/README.md`](../evaluation/README.md).
- Architectural decision: [`ADR-009`](../adr/ADR-009-ai-change-release-gate.md).

At the current boundary, local contracts, deterministic evaluators, telemetry and UI
foundations exist, while reviewed curation, hosted datasets, human calibration, provider
experiments and promotion evidence remain task-scoped gates. See the backlog for the
current evidence classification; do not infer completion from this proposal.
