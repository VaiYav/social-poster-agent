# Legacy Refactor Task Tracker — SPA Backend

> **FROZEN SNAPSHOT.** Checkboxes/status/“current sprint” below are historical and do
> not authorize implementation. Reproduce a still-relevant finding through `PLAN-005`
> and create one task in [`docs/planning/BACKLOG.md`](../planning/BACKLOG.md).

Structured task breakdown derived from `docs/reviews/ACTION_PLAN.md`, `docs/audit/`, and `docs/reviews/cross-module-synthesis.md`. Each phase file contains detailed task descriptions (2-5 sentences), affected files, step-by-step checklists, and acceptance criteria.

> **Trust source, not prose.** Re-verify file/line references against current source before implementing. See `CLAUDE.md` — "The docs lag the code".

## Historical status legend

- `[ ]` — not started
- `[~]` — in progress
- `[x]` — completed / verified fixed
- `[!]` — blocked / needs decision

## Already fixed (verified in prior session)

These items were confirmed fixed in the codebase and are excluded from the active task files:

| ID | Description | Verified |
|----|-------------|----------|
| 2.6.1 | `WAIT` action `sleepMs` — `calculateAdaptiveSleep` now reads `action.params.sleepMs` | `orchestrator.graph.ts:278` |
| 2.6.2 / 5.2 | `resetCheckpoint` uses `SCAN` instead of `KEYS` | `redis-checkpoint.ts:184` |
| 2.6.3 | `stop()`/`start()` race condition mitigated | `orchestrator.service.ts:214` |
| 2.6.4 | LLM timeout cancellation via `AbortController` | `llm-decision.service.ts:88` |
| — | SimHash self-match bug (BUG-1) fixed in `AutoCheckService` | `auto-check.service.ts:127` |
| — | Unified auto-approve gate (`AutoApproveListener` delegates to `AutoApproveService.evaluate`) | `auto-approve.listener.ts:75` |
| — | Health check timeout (BUG-8) + `LocalhostGuard` (SEC-1/SEC-2) | `localhost.guard.ts:42` |
| — | Engagement scheduling issues (BUG-2/BUG-10) | `engagement.service.ts:120` |

## Phase files

| File | Priority | Status | Tasks | Focus |
|------|----------|--------|-------|-------|
| [phase-1-p0-critical.md](phase-1-p0-critical.md) | P0 | `[x]` | 6 | Critical bugs, resource leaks, data corruption |
| [phase-2-p1-correctness.md](phase-2-p1-correctness.md) | P1 | `[x]` | 40 | Correctness bugs across all modules |
| [phase-3-p2-security-infra.md](phase-3-p2-security-infra.md) | P2 | `[x]` | 25 | Security, env validation, infra hardening |
| [phase-4-p2-architecture-dry.md](phase-4-p2-architecture-dry.md) | P2 | `[ ]` | 15 | Architecture, DRY, module boundaries |
| [phase-5-p2-performance.md](phase-5-p2-performance.md) | P2 | `[ ]` | 11 | Performance optimizations |
| [phase-6-7-p3-strategic-features.md](phase-6-7-p3-strategic-features.md) | P3 | `[ ]` | 17 | Strategic refactors + new features (backlog) |

## Quick wins (XS, single-pass batch)

See [quick-wins.md](quick-wins.md) for a consolidated checklist of all XS tasks that can be done in one pass.

## Historical recommended execution order

```
Phase 1 (P0)   ← historical order 1
Phase 2 (P1)   ← historical order 2
Phase 3 (P2a)  ← historical order 3
Phase 4 (P2b)  ← architecture / DRY
Phase 5 (P2c)  ← performance
Phase 6 (P3a)  ← strategic refactors (backlog)
Phase 7 (P3b)  ← new features (backlog)
```

## Summary

~80 tasks total: ~30 quick wins (XS), ~35 short tasks (S), ~10 medium (M), ~5 large (L).
