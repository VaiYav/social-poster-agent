# DOCS-102 VERIFY reconciliation local evidence

Date: 2026-08-23  
Source SHA: `74a1e7cc5e32bb90453f2809876f840724cc6a24` plus current dirty worktree changes  
Boundary: backlog evidence classification and archive reconciliation; no runtime behavior or
external gate was changed.

## Reconciled

- Every remaining non-terminal `VERIFY` task row in `docs/planning/BACKLOG.md` carries an explicit
  `evidence: manual` tag because each still has a live, staging, provider, human, privacy,
  accessibility or long-running gate.
- `DOCS-100` and `DOCS-101` were the only fully automatable planning rows in this pass; both were
  archived with exact local evidence before this task was archived.
- The backlog now contains a grouped manual checklist that names the evidence required for live
  account/platform, staging/production, human/privacy/policy and long-running gates.
- No row was marked `DONE` merely because code exists; all unresolved implementation rows remain
  `VERIFY` with their local evidence and explicit remaining boundary.

## Local evidence

- Section-aware verification audit — exit 0: 43 tagged task rows, no untagged task `VERIFY` rows.
- Archive audit — exit 0: DOCS-100, DOCS-101 and DOCS-102 are in `archive/2026-Q3.md` and absent
  from the active backlog.
- Repository `git diff --check` — exit 0.

## Remaining gate

- Manual/external evidence listed by the retained checklist must be collected per task before any
  of those rows can move from `VERIFY` to the quarterly archive as `DONE`.
