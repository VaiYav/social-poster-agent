# EVAL-304 Langfuse preflight evidence

Date: 2026-08-23
Boundary: read-only hosted Langfuse preflight; no dataset, prompt, score or experiment mutation.

## Results

- Langfuse health endpoint — HTTP `200`, hosted version `4.16.0`.
- Production prompt inventory — `17` prompts; the required generation, judge and
  orchestrator prompts are present with `production` labels.
- Hosted datasets — `0`.
- Score configurations — `0`.
- Credentials were loaded through Node's `--env-file=.env` mechanism; no secret
  values were printed or persisted.

## Decision boundary

`EVAL-304` remains `BLOCKED`: the hosted service is reachable, but the required
human/editorial curation from `EVAL-302` and `EVAL-303` does not exist. The local
120-case manifest is synthetic/local evidence and must not be uploaded as reviewed
ground truth or used to claim a hosted experiment. `EVAL-401`, `EVAL-503` and
`EVAL-505` remain downstream of this missing evidence.
