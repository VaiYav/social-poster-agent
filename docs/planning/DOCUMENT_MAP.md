# Documentation map and overlap register

> **Status:** `ACTIVE` governance index
> **Audit date:** 2026-08-23
> **Purpose:** explain where every planning-like document belongs and prevent a new
> roadmap/backlog from appearing outside `docs/planning/`.

## Placement rules

| Information | Canonical location | Examples |
|---|---|---|
| Feature status | `docs/planning/FEATURES.md` | `EVAL-001 = SPEC_READY` |
| Non-terminal task status | `docs/planning/BACKLOG.md` | `EVAL-101 = READY` |
| Terminal task/evidence | `docs/planning/archive/YYYY-QN.md` | `PLATFORM-401 = DONE` |
| Product sequencing/gates | `docs/planning/ROADMAP.md` (EN; root `ROADMAP_V2.md` archived RU original) | M0–M6, Z1–Z6 |
| Dependency delivery waves | `docs/planning/EXECUTION_ROADMAP.md` | Wave 0–6, WIP and claiming |
| Feature specification | `docs/roadmap/NN-*.md` or a domain hub | roadmap 08, evaluation hub |
| Architecture decision | `docs/adr/ADR-NNN-*.md` | ADR-009 |
| Operational procedure | `docs/runbooks/*.md` | rollback, failed posts |
| Code-review/audit evidence | `docs/reviews/`, `docs/audit/` | snapshot findings |
| Historical task breakdown | `docs/refactor/`, `.forge/` | reference only, frozen status |
| Research input | named research/audit file | not a backlog |

No new file outside `docs/planning/` may call itself the active backlog, task tracker,
current sprint, feature register or single source of status.

## Current canonical entry points

- [Planning rules](./README.md)
- [Feature register](./FEATURES.md)
- [Active backlog](./BACKLOG.md)
- [Execution roadmap](./EXECUTION_ROADMAP.md)
- [Task archive](./archive/README.md)
- [Product roadmap](./ROADMAP.md)
- [Evaluation domain](../evaluation/README.md)
- [Roadmap specification index](../roadmap/README.md)
- [ADR directory](../adr/)

## Feature specification map

| Document | Feature ID | Role | Overlap decision |
|---|---|---|---|
| `roadmap/01-multi-account.md` | `ACCOUNT-001` | Product/component proposal | Primary concise proposal. |
| `roadmap/01-multi-account-plan.md` | `ACCOUNT-001` | Companion implementation detail | Keep temporarily; consolidate after current account work (`PLAN-004`). |
| `roadmap/02-per-account-settings.md` | `ACCOUNT-002` | Component specification | Distinct child of multi-account. |
| `roadmap/03-gemini-nano-image-generation.md` | `MEDIA-001` | Feature specification | No duplicate runtime image feature found. |
| `roadmap/04-per-account-prompts-brand-voice.md` | `PERSONA-001` | Supporting component specification | Account voice/profile mechanics; roadmap 08 owns the broader persona product. |
| `roadmap/05-llm-token-cost-optimization.md` | `COST-001` | Feature specification | Cost mechanics; evaluation owns comparative quality/cost measurement. |
| `roadmap/06-self-healing-resilience.md` | `REL-001` | Feature specification | Technical recovery; roadmap 12 owns external policy/reputation authorization. |
| `roadmap/07-additional-features-research.md` | none | Research inbox | Decompose into feature IDs before work; never use its checklist as backlog. |
| `roadmap/08-editorial-personas-conversational-engagement.md` | `PERSONA-001`, `ENGAGE-001`, `GROUND-001` | Aggregate product/technical specification | Owns persona, reviewed conversation execution and memory boundaries. |
| `roadmap/09-ai-change-release-gate.md` | `EVAL-001` | Roadmap/milestone proposal | Detailed contracts are superseded by `docs/evaluation/`; safe reduction tracked by `PLAN-003`. |
| `evaluation/*` | `EVAL-001` | Normative domain specification | Owns rubrics, datasets, telemetry, CI and promotion contracts. |
| `roadmap/10-conversation-intelligence-demand-radar.md` | `INTEL-001` | Feature specification | Aggregates reviewed public demand; does not execute replies. |
| `roadmap/11-reply-to-revenue-assisted-attribution.md` | `ATTR-002` | Feature specification | Assisted/incremental layer; ADR-007 remains direct attribution. |
| `roadmap/12-platform-policy-reputation-control-plane.md` | `POLICY-001` | Feature specification | External authorization/reputation; not technical resilience. |
| `roadmap/13-creator-relationship-crm.md` | `CRM-001` | Feature specification | Public relationship workflow; not interaction memory or demand clustering. |
| `roadmap/14-soulwise-editorial-data-bridge.md` | `BRIDGE-001` | Cross-repository feature specification | Dedicated sensitive boundary; generic content adapters remain infrastructure. |
| `roadmap/15-network-api-first-posters.md` | `NETWORK-001` | Feature specification (2026-08-23) | Owns the API-first transport decision for Bluesky/Mastodon; browser posters conserved behind flag. |
| `roadmap/16-telegram-control-bot.md` | `CONTROL-001` | Feature specification (2026-08-23) | Operator transport only; no business logic duplication, editing stays in dashboard. |

## ADR map

| ADR | Decision status | Feature/role |
|---|---|---|
| ADR-001 Camoufox | Accepted | Browser transport foundation. |
| ADR-002 BullMQ | Accepted | Queue foundation. |
| ADR-003 LangGraph generation | Accepted | Generation foundation. |
| ADR-004 Hexagonal ports | Accepted | Architecture foundation. |
| ADR-005 SSE | Accepted | Realtime foundation. |
| ADR-006 autonomous architecture | Accepted | `ORCH-001`/autonomy foundation. |
| ADR-007 link attribution | Accepted | `ATTR-001` direct attribution. |
| ADR-008 persona/memory/engagement | Accepted 2026-08-23 | `PERSONA-001`, `ENGAGE-001`, `GROUND-001`. |
| ADR-009 AI release gate | Accepted for design | `EVAL-001`. |
| ADR-010 demand radar | Accepted 2026-08-23 | `INTEL-001`. |
| ADR-011 assisted attribution | Accepted 2026-08-23 | `ATTR-002`. |
| ADR-012 policy/reputation | Accepted 2026-08-23 | `POLICY-001`. |
| ADR-013 creator CRM | Accepted 2026-08-23 | `CRM-001`. |
| ADR-014 editorial bridge | Accepted 2026-08-23 | `BRIDGE-001`. |

ADR decision status is legitimate and separate from implementation status. An accepted
ADR does not make its feature `DONE`.

## Evidence dossiers and supporting docs

| Location | Role | Rule |
|---|---|---|
| `docs/features/ab-testing-infrastructure.md` | `PLATFORM-001` completion dossier | Further judge work belongs to `EVAL-001`. |
| `docs/features/content-adapters.md` | `PLATFORM-002` completion dossier | A new adapter receives a new task, not a reopened status table. |
| `docs/features/operator-dashboard.md` | `PLATFORM-003` completion dossier | Evaluation panels belong to `EVAL-701`. |
| `docs/features/prompt-versioning-langfuse.md` | `PLATFORM-004` completion dossier | Native trace linkage belongs to `EVAL-103`. |
| `docs/features/browser-e2e-replay.md` | `BROWSER-001` supporting proposal | Canonical work is `BROWSER-101..102`. |
| `docs/features/multi-instance-distribution.md` | `DIST-001` supporting proposal | Current readiness conflict is `DIST-101`. |
| `docs/DEEP_ANALYSIS_LLM_GENERATION_2026-07-05.md` | Historical technical research | Findings must be re-verified and converted into canonical tasks. |
| `docs/RESEARCH_JUDGING_v0.5.2.md` | Historical research/judging | Calibration design is now in `docs/evaluation/07-*`. |
| `docs/ARCHITECTURE_AUDIT_v0.5.1.md` | Historical audit | Evidence snapshot, not current architecture spec. |

## Frozen/historical trackers

| Document | Historical value | Current rule |
|---|---|---|
| `CONSTITUTION.md` | Original requirements, resolved questions and changelog | Historical requirements snapshot; no current feature/task status. |
| `ROADMAP.md` | Completed phases 0–6 and old release evidence | Archived. `docs/planning/ROADMAP.md` owns sequencing; root `ROADMAP_V2.md` is the archived RU v2.4 original. |
| `FEATURE_WISHLIST.md` | F1–F22 brainstorm history | Archived; ideas require a feature ID. |
| `docs/audit/08-BACKLOG.md` | June audit remediation order/evidence | Frozen audit snapshot. |
| `docs/reviews/ACTION_PLAN.md` | Review-derived task inventory | Frozen finding index. |
| `docs/refactor/*` | Detailed old acceptance/checklists | Frozen evidence; reconcile through `PLAN-005`. |
| `.forge/orchestrator/*` | Original orchestrator workstream design | Frozen task status; map through `ORCH-101`. |

Runbooks keep operational checkboxes because they are procedures, not task status.

## Known overlap requiring later consolidation

### `PLAN-003`: roadmap 09 versus evaluation package

Similarity audit confirms material overlap, especially CI, rollout and observability.
Do not delete user-authored content during active work. After review, reduce roadmap 09
to product scope/milestones and keep technical contracts only in `docs/evaluation/`.

### `PLAN-004`: two multi-account documents

The proposal and companion plan are highly similar. Wait for `ACCOUNT-101` ownership to
finish, then merge stable implementation detail into one specification or retain an
explicit short product-summary/technical-plan split.

### `PLAN-005`: unchecked legacy refactor tasks

Old refactor/audit trackers contain hundreds of unchecked or snapshot-completed boxes.
They cannot be bulk-copied into the active backlog because code has drifted. Reproduce
each surviving finding, create a stable canonical task only if still valid, and archive
or cancel the rest with evidence.

## New-document checklist

Before adding a planning-like Markdown file:

1. Search this map and `FEATURES.md` for the concept.
2. Reuse the existing feature ID or create one `IDEA` row.
3. State document role and canonical feature status link in the header.
4. Do not add live task status/checklists outside `BACKLOG.md`.
5. Link an ADR for a real architectural decision.
6. Add the document to this map.
