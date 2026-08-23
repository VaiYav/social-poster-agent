# Completed and cancelled task archive

Terminal tasks are moved here from `../BACKLOG.md`. Files are quarterly and append-only
except for factual corrections.

Required archive fields:

```text
task ID
feature ID
DONE or CANCELLED
completion date
owner/worktree
source SHA or dirty boundary
deliverable
automated evidence
manual/external evidence
rollback/compatibility note
```

Rules:

- Never archive a task solely because code exists; required acceptance evidence must
  exist or the task remains `VERIFY`.
- Never delete cancelled work history; record the superseding task/decision.
- A completed feature stays visible in `../FEATURES.md` as `DONE` while its tasks live
  only in archive files.
- Do not edit historical status to make a later regression disappear. Open a new task.

Archives:

- [2026 Q3](./2026-Q3.md)
