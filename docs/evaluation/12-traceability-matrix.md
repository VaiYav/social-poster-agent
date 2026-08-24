# Evaluation traceability matrix

> **Document maturity:** `DESIGN READY`; canonical feature status is `EVAL-001`.
> Task status is resolved from [the canonical backlog](../planning/BACKLOG.md), not
> duplicated here.

## Product and system requirements

| Requirement | Success measure | Evaluator/evidence | Dataset/signal | Canonical tasks |
|---|---|---|---|---|
| `REQ-EVAL-001` Compare immutable agent configurations | candidate/source/dataset digests present | manifest validator and report | every offline run | `EVAL-201`, `EVAL-401`, `EVAL-402` |
| `REQ-EVAL-002` Prevent hidden model mixing | unknown attribution <=1%; strict fallback violations 0 | attempt metadata validator | all LLM attempts | `EVAL-102`, `EVAL-104` |
| `REQ-EVAL-003` Preserve prompt identity | native linkage >=95% | prompt-link coverage | managed-prompt generations | `EVAL-103`, `EVAL-104` |
| `REQ-EVAL-004` Prevent eval side effects | prohibited mutations 0 | recording/failing ports | runtime/system fixtures | `EVAL-202` |
| `REQ-EVAL-005` Measure publishable content | approval unchanged/edit/reject and rubric | human scores | 60 generation cases + production review | `EVAL-302`, `EVAL-501`, `EVAL-502` |
| `REQ-EVAL-006` Protect factuality | human factual pass >=90% | deterministic evidence + human/judge | generation/safety cases | `EVAL-203`, `EVAL-302`, `EVAL-505` |
| `REQ-EVAL-007` Evaluate orchestrator action | valid decision >=99%; hard-rule failures 0 | exact/allowed action evaluator | 30 world-state cases | `EVAL-303` |
| `REQ-EVAL-008` Evaluate runtime resilience | task completion >=95%; fallback/error taxonomy | trajectory/attempt evaluators | 20 resilience cases | `EVAL-102`, `EVAL-303` |
| `REQ-EVAL-009` Cover adversarial boundaries | safety/policy compliance 100% | deterministic safety evaluator | 10 adversarial cases | `EVAL-203`, `EVAL-303` |
| `REQ-EVAL-010` Reproduce dataset input | item count/split/digest exact | dataset validator | hosted dataset + manifest | `EVAL-301..304` |
| `REQ-EVAL-011` Quantify nondeterminism | repeated outcome variance reported | repeat aggregator | smoke/pilot/final runs | `EVAL-204`, `EVAL-401` |
| `REQ-EVAL-012` Control cost | no stage budget overrun | budget evaluator | every external run | `EVAL-401`, `EVAL-402` |
| `REQ-EVAL-013` Calibrate the judge | held-out kappa >=0.60 for gating | confusion matrix/kappa | 30 double-labelled cases | `EVAL-503..505` |
| `REQ-EVAL-014` Keep human feedback durable | review transaction success; sync p95 <15m | DB integration + reconciliation | production reviews | `EVAL-501`, `EVAL-502` |
| `REQ-EVAL-015` Prevent secret leakage | redaction canaries absent | telemetry self-test | trace/score/artifact | `EVAL-104`, `EVAL-601` |
| `REQ-EVAL-016` Gate trusted changes | hard regressions fail trusted job | Langfuse experiment action/report | PR/nightly/promotion | `EVAL-601`, `EVAL-602` |
| `REQ-EVAL-017` Detect online drift | documented SLO/alert coverage | dashboard/alert tests | sampled production observations | `EVAL-701`, `EVAL-702` |
| `REQ-EVAL-018` Choose balanced model | promotion policy and paired CI pass | comparator + human approval | control/GPT/OpenRouter matrix | `EVAL-801..804` |
| `REQ-EVAL-019` Separate browser truth | replay, dry-run and live evidence labelled | browser validators/manual soak | browser fixture/platform | `BROWSER-101`, `BROWSER-102` |
| `REQ-EVAL-020` Preserve planning truth | one feature/task status location | link/status validation | documentation repository | `PLAN-001`, `PLAN-002` |

## Story-to-scenario mapping

| Story | Acceptance scenario | Evidence boundary |
|---|---|---|
| As an operator, I can explain a rejection. | Reject with reason code; DB decision and Langfuse score agree. | Integration + Langfuse external. |
| As a product owner, I can compare mini/nano/free candidates. | Same held-out cases/repeats, exact models and paired report. | External experiment + manual promotion. |
| As an engineer, I can localize fallback churn. | Trace shows every provider attempt, actual model and normalized error. | Synthetic and production trace. |
| As a reviewer, I can trust the judge boundary. | Held-out confusion matrix/kappa and error taxonomy visible. | Manual double labels + experiment. |
| As CI, I cannot post/engage during eval. | Prohibited ports throw and zero mutation events are recorded. | System tests. |
| As on-call, I know whether quality or provider reliability regressed. | Separate quality, task and attempt dashboards/alerts. | Online monitoring. |
| As an AI agent, I know what is actually in progress. | Feature/task ID resolves to one canonical row and terminal work to archive. | Documentation validation. |

## Coverage rule

A requirement is not considered implemented because a task exists. It becomes covered
only when the task is archived with the evidence type shown above. `MANUAL`, `EXTERNAL`
and provider/staging gaps remain visible in the archive record.
