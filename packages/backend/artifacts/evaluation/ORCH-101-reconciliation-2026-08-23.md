# ORCH-101 frozen-workstream reconciliation

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c`  
Boundary: read-only `.forge/orchestrator/**` plus canonical planning/source inspection; no files edited, staged or committed.

## Mapping

| Frozen workstream | Current classification | Canonical route | Evidence/gap |
|---|---|---|---|
| WS-1 State Collector, legacy tasks 1.1–1.9 | `ALREADY_FIXED` | `ORCH-102`, `REL-102` | Source and `state-collector.fleet.spec.ts` cover the current implementation; real DB/Redis timing and recovery integration remain open. |
| WS-2/WS-4 rules, decision, guardrails and windows, tasks 2.1–2.13 | `ALREADY_FIXED` | `ORCH-102`, `ORCH-103`, `REL-102`, `EVAL-505` | Current services and local guardrail/LLM tests exist; outcome baseline, GA/safety and soak evidence remain open. |
| WS-3 action executor, tasks 3.1–3.11 | `ALREADY_FIXED` | `ORCH-102` | Action handlers and local tests exist; end-to-end side-effect/recovery proof remains open. |
| WS-5 graph/loop/checkpoint, tasks 4.1–4.12 | `ALREADY_FIXED` | `ORCH-102` | Graph/service/checkpoint/heartbeat source exists; system, crash-resume and acceptance evidence remain open. |
| WS-6 watchdog, tasks 5.1–5.5 | `ALREADY_FIXED` | `ORCH-102` | Watchdog skeleton exists; restart/alert/live evidence remains open. |
| WS-7 cron/legacy suppression, tasks 6.1–6.5 | `ALREADY_FIXED` | `ORCH-102` | Dynamic `SchedulerRegistry` gating exists; dual-path/no-duplicate/72-hour soak remains open. |
| WS-8 dashboard/history/SSE, tasks 7.1–7.5 | `NEEDS_DECISION` / stale | no new ID; product decision required | Controller/history endpoints exist, but the frozen dashboard/SSE checklist has no surviving canonical task. Do not copy boxes without scope approval. |
| Phase 8 cleanup/soak, tasks 8.1–8.6 | `ALREADY_FIXED` as implementation history | `ORCH-102` | Remaining work is GA soak/regression/cleanup evidence, not new frozen tasks. |

No legacy item justified a new canonical task ID. The frozen checkbox count is historical and
is not evidence of missing source implementation.

## Evidence

- `git status --short --branch`, `git rev-parse HEAD`, bounded `rg/find/sed/nl` inspection: exit 0.
- Local source/unit evidence only; no provider, browser, deployment, staging, production, Redis-cluster or manual evidence.
- Existing dirty `.forge/orchestrator/MASTER-PLAN.md` and `TASKS.md` were preserved.

## Verdict

`ORCH-101` reconciliation is complete and can be archived. `ORCH-001` remains `IN_PROGRESS`.
The next canonical work is `REL-102`, then `ORCH-102`/`ORCH-103`; WS-8 requires a product/scope
decision and must not be reconstructed from historical checkboxes.
