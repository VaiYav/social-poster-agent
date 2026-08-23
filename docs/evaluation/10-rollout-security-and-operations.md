# Rollout, security and operations

> **Document maturity:** `DESIGN READY`; canonical feature status is `EVAL-001`.
> **Rollout posture:** observe first, gate later, automate promotion last.

## Rollout phases

| Phase | Capability | Exit gate |
|---|---|---|
| 0. Measurement repair | Trace identity, usage, prompt linkage and baseline audit. | Mandatory coverage thresholds demonstrated. |
| 1. Local/static harness | Schemas, evaluators, manifests, statistics and side-effect barrier. | Unit/system tests green. |
| 2. Offline experiments | Hosted dataset, smoke/pilot/final runners and reports. | Production baseline reproducible. |
| 3. Human feedback | Durable review decisions and Langfuse score sync. | Sync/reconciliation evidence and annotation protocol. |
| 4. Calibration | Human-human and judge-human reports. | Judge classified TRUST or ANNOTATE_ONLY. |
| 5. Online observation | Deterministic checks + 5% semantic sample. | Four-week stable telemetry/SLO baseline. |
| 6. CI and canary gates | Trusted PR/nightly/promotion workflows. | Two stable experiment windows, rollback tested. |
| 7. Routing optimization | Promote model/role-chain candidates. | Explicit promotion record and canary pass. |

No phase enables auto-approve or live posting as a side effect.

## Proposed feature flags and controls

```text
EVAL_HARNESS_ENABLED=false
EVAL_FEEDBACK_CAPTURE_ENABLED=false
EVAL_FEEDBACK_SYNC_ENABLED=false
EVAL_ONLINE_DETERMINISTIC_ENABLED=false
EVAL_ONLINE_JUDGE_SAMPLE_RATE=0.05
EVAL_STRICT_MODEL_PINNING=true
EVAL_MAX_CONCURRENCY=1
EVAL_SMOKE_BUDGET_USD=2
EVAL_PILOT_BUDGET_USD=10
EVAL_FINAL_BUDGET_USD=25
```

All are validated centrally. Changing sampling, budget or strict pinning requires a
restart and a recorded config/version change. Production defaults remain off until the
corresponding phase gate passes.

## Security boundaries

### Secrets

- Langfuse secret key and model-provider keys remain server/CI secrets.
- Frontend never receives `LANGFUSE_SECRET_KEY`.
- Fork PRs receive no external secrets.
- CLI output and artifacts contain provider/model names, never key fragments.
- Redaction tests include representative OpenAI, Langfuse, proxy, cookie and social
  token canaries.

### Authorization

- Running paid/full experiments is CLI/trusted-CI only in V1.
- Future experiment mutation endpoints require explicit admin authorization and rate
  limiting; they are not part of V1.
- Read-only evaluation analytics use the existing global auth boundary.
- Reviewer identity comes from authenticated server context, never caller-supplied
  username.

### Prompt/source data

- Treat source topics, comments and external text as untrusted.
- Expected output is isolated from candidate execution.
- Prompt injection cases are redacted before dataset publication.
- Do not store full production conversations merely to improve evaluator convenience.

## Data classification and retention

| Data | Classification | Default retention |
|---|---|---:|
| Raw trace input/output | Sensitive operational content | 30 days |
| Trace metadata without content | Internal telemetry | 180 days |
| Scores and aggregate experiment metrics | Internal quality evidence | 365 days |
| Curated redacted dataset items | Reviewed test asset | Until superseded + archived |
| Human review decisions | Product operational record | 365 days or product policy |
| CI reports/manifests | Engineering evidence | 180 days |
| Secrets/session/browser state | Restricted | Never in evaluation data |

If the configured Langfuse plan cannot enforce the intended retention, mark the gap
`EXTERNAL` and apply deletion/export controls through the supported API.

Deletion must be traceable by post/run/trace ID across PostgreSQL and Langfuse. Dataset
items derived from deleted/private content are reviewed and removed or irreversibly
anonymized.

## Cost controls

- validate budget before starting;
- reserve expected per-item spend and stop scheduling before ceiling;
- provider retries and judge calls count toward the same candidate budget;
- report provider-reported versus estimated cost separately;
- no automatic budget increase;
- free-model zero price does not bypass rate/concurrency budgets;
- online judge sampling has a daily budget and degrades to deterministic-only.

## Reliability

- experiment items are isolated; one failure does not corrupt the run;
- local result journal is append-only so completed evidence survives process failure;
- Langfuse flush is mandatory on normal exit and best-effort on signals;
- feedback sync uses idempotent score IDs and bounded retry;
- reconciliation reports unresolved rows;
- dataset and candidate digests are checked before resume;
- resuming never changes candidate configuration.

## Rollback

A model/prompt/harness rollout stores the previous candidate manifest and prompt
labels. Rollback restores configuration, not old code by destructive Git operations.

Trigger rollback when:

- safety/platform hard gate fails;
- task completion or attribution SLO breaches in canary;
- human quality falls >5 percentage points with sufficient sample;
- cost exceeds 2x baseline without approved explanation;
- unknown model/router drift makes the canary incomparable.

After rollback, preserve traces and create a regression dataset item before closing the
incident.

## Operational cadence

| Cadence | Activity |
|---|---|
| Per change | Static evaluators and docs/contracts checks. |
| Nightly | Trusted smoke/full experiment depending on changed areas and budget. |
| Weekly | Quality/fallback/cost dashboard review and failure intake. |
| Monthly | Judge calibration and dataset coverage review when enough labels exist. |
| Before promotion | Frozen held-out experiment and explicit decision record. |
| Quarterly | Retention, privacy, evaluator bias and provider/model catalog review. |

## Manual and external evidence

The following remain explicitly non-automated:

- second human calibration labels;
- final rubric/taxonomy approval;
- provider quota/account availability;
- production social-platform posting/soak;
- go/no-go for auto-approve or autonomous engagement;
- changes to data-retention policy.

Missing manual/external evidence produces `BLOCKED` or `HOLD`, never a green gate.

## Definition of ready for implementation

- ADR accepted;
- contracts/rubrics/dataset shape reviewed;
- task dependencies and owners agreed;
- Langfuse access and provider budgets available;
- dirty worktree ownership understood;
- no implementation starts by creating dashboards before attribution truth is fixed.
