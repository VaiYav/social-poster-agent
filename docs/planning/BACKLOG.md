# Active implementation backlog

> **Canonical task status as of 2026-08-23.**
> Contains only `TODO`, `READY`, `IN_PROGRESS`, `BLOCKED`, `VERIFY`.
> Terminal tasks move to [archive](./archive/README.md).

## Status summary

| Status | Meaning in this file |
|---|---|
| `IN_PROGRESS` | Existing active worktree changes; preserve ownership. |
| `READY` | Dependency-complete and suitable for the next implementation slice. |
| `TODO` | Defined but waits for dependency/priority. |
| `BLOCKED` | Cannot progress without the named condition. |
| `VERIFY` | Implementation/design exists; evidence or reconciliation is missing. |

`VERIFY` rows carry an `evidence:` tag (DOCS-102 convention): `auto` = closure needs only
automatable proof (tests/build/SHA) an agent can produce; `manual` = closure additionally
requires a named human/external gate (live accounts, staging soak, operator approval,
30-day uptime). The full tagging pass over legacy `VERIFY` rows is tracked as `DOCS-102`.

### Manual `VERIFY` checklist

The tagged rows remain open until the applicable checklist item has named evidence attached:

| Gate class | Rows | Required evidence before archive |
|---|---|---|
| Live account/platform | `ACCOUNT-101/102`, `PERSONA-101/102`, `ENGAGE-101`, `REFACTOR-101/103/104`, `SYND-101`, `NETWORK-101` | Real isolated accounts, native browser/API behavior, permalink/canonical proof and rollback notes. |
| Staging/production | `ACCOUNT-201`, `MEDIA-101`, `REL-102`, `DIST-101`, `ATTR-104`, `CI-001/002`, `REFACTOR-100/102/105/108` | Clean-resource build, staging soak or deploy/CI run with exact SHA and terminal logs. |
| Human/privacy/policy | `CRM-101`, `GROUND-101`, `INTEL-101`, `POLICY-101/102`, `PERSONA-100/103`, `EVAL-501/502/701/702` | Named operator/editorial/privacy review, calibration or official-policy source evidence. |
| Long-running gate | `REFACTOR-106/107`, `DESIGN-101` | External/live acceptance where applicable, ORCH-102 30-day dual-path evidence, or manual visual/accessibility review. |
| Operator transport | `TGBOT-101` | Real Telegram approve/reject/pause-resume round-trip, non-allowlisted chat rejection and one alert drill per subscribed chat. |

## Work intake — what can be claimed now

Finish existing ownership before opening overlapping work:

1. `ACCOUNT-101` remains an owned runtime slice in `VERIFY`; persona generation is the current
   downstream slice in the same user-owned worktree.
2. `PLAN-002` is complete: ADR-008 and ADR-010..014 were accepted on 2026-08-23 with
   explicit v1 boundaries. Their implementation/promotion evidence remains in the downstream tasks.
3. `SYND-101` local implementation is verified in the current worktree; the task remains
   `VERIFY` under Orca task `task_5847d7d0398e` because live/external/manual acceptance is
   still absent. Its exact ownership was limited to the syndication/article-publish and
   canonical-verification file family recorded in the task prompt.

The CRM foundation is now the active dependency-complete implementation slice after the local
`INTEL-101`, `ENGAGE-101` and `POLICY-101` foundations. `EVAL-302` and `EVAL-303` remain blocked
on a named manual/editorial curator and must not be filled with synthetic placeholder quality
evidence. External verification gates remain distinct from implementation.

WIP limits:

- maximum three concurrent code slices plus one documentation-only slice;
- one owner per task and one task per overlapping file family;
- do not run `REL-102` beside account/tracing/browser slices: it touches all of them;
- claim protocol is `READY → IN_PROGRESS` with owner/worktree/date before editing.

## Documentation governance

| Task | Status | Owner | Depends on | Deliverable / acceptance |
|---|---|---|---|---|
| `PLAN-006` Add automated planning-document guard | `VERIFY` | current user/parallel worktree | `PLAN-003..005` ✅ | `scripts/validate-planning-docs.mjs` and the `planning:check` CI step validate canonical task/feature/archive rows, duplicate IDs, roadmap-spec mapping and non-canonical active status rows; local evidence is in `packages/backend/artifacts/evaluation/PLAN-006-local-evidence-2026-08-23.md`; first clean GitHub Actions run remains. evidence: manual |

## Current worktree ownership

| Task | Feature | Status | Owner | Started | Deliverable / acceptance |
|---|---|---|---|---|---|
| `ACCOUNT-101` Account isolation/settings slice | `ACCOUNT-001`, `ACCOUNT-002` | `VERIFY` | current user/parallel worktree | 2026-08-22 | Account-aware generation, queue ownership, per-account limits, WorldState snapshots and settings UI are locally source/unit verified in `packages/backend/artifacts/evaluation/ACCOUNT-101-local-evidence-2026-08-23.md`; live isolation evidence remains open.  evidence: manual |
| `PERSONA-103` Cross-account portfolio planner | `PERSONA-001` | `VERIFY` | current user/parallel worktree | 2026-08-23 | Deterministic portfolio constraints/scoring, transactionally idempotent assignment persistence, generation dispatch and draft provenance are locally verified in `packages/backend/artifacts/evaluation/PERSONA-103-local-evidence-2026-08-23.md`; held-out, EVAL-203 and external evidence remain.  evidence: manual |
| `POLICY-102` Reputation state machine and scoped recovery | `POLICY-001` | `VERIFY` | current user/parallel worktree | 2026-08-23 | Signal dedup/TTL, deterministic multi-signal state transitions, scoped FlowControl pause, staged recovery and operator safety UI are locally verified in `packages/backend/artifacts/evaluation/POLICY-102-local-evidence-2026-08-23.md`; calibration, staging soak and live evidence remain.  evidence: manual |
| `MEDIA-101` Image generation quota foundation | `MEDIA-001` | `VERIFY` | current user/parallel worktree | 2026-08-23 | IImagePort, official REST Gemini adapter, atomic per-account quota/budget, Post.media metadata, X/Threads/Facebook upload helper and text-only fallback are locally implemented in `packages/backend/artifacts/evaluation/MEDIA-101-local-evidence-2026-08-23.md`; credential, native/staging and UI gates remain.  evidence: manual |
| `CRM-101` Public creator relationship foundation | `CRM-001` | `VERIFY` | current user/parallel worktree | 2026-08-23 | Public creator identity, account/persona relationship, idempotent evidence, cooldown-aware next action, DO_NOT_ENGAGE, human-only collaboration proposal, explicit cross-network identity link/unlink and operator signal board/timeline are locally verified in `packages/backend/artifacts/evaluation/CRM-101-local-evidence-2026-08-23.md`; privacy evaluation, real DB and manual outreach gates remain.  evidence: manual |
| `REFACTOR-101` Network profile registry | `NETWORK-001` | `VERIFY` | current user/parallel worktree | 2026-08-23 | Canonical network profiles and migrated limits/angle/CTA/persona/permalink consumers are locally verified in `packages/backend/artifacts/evaluation/REFACTOR-101-local-evidence-2026-08-23.md`; clean-resource full typecheck and live network evidence remain.  evidence: manual |
| `REFACTOR-102` Generation service decomposition | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | GenerationPersistence, PostFactory, GenerationRunLifecycle and ReviewResume seams preserve the GenerationService public surface; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-102-local-evidence-2026-08-23.md`; clean-resource typecheck and external/live gates remain.  evidence: manual |
| `REFACTOR-103` Posting service decomposition | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | PostingGuardChain, PostingDispatcher, ThreadOrchestrator, CtaAttributionService and verification/side-effect seams preserve the PostingService public surface; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-103-local-evidence-2026-08-23.md`; runtime integration and external/live gates remain.  evidence: manual |
| `REFACTOR-104` X poster page objects | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | XComposePage, XThreadReplies and XVerification page objects are used by XPoster; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-104-local-evidence-2026-08-23.md`; native/staging/live gates remain.  evidence: manual |
| `REFACTOR-105` Unified `.js` import convention | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | Backend relative imports use emitted `.js` specifiers, the lint validator is wired and the obsolete trending shim is removed; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-105-local-evidence-2026-08-23.md`; CI first green and deployment gates remain.  evidence: manual |
| `REFACTOR-106` Dead multilingual config removal | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | English-only generation is enforced; dead non-English posting configuration, language packs and UI/schema surface are removed while immutable source metadata remains; local evidence is recorded in `packages/backend/artifacts/evaluation/REFACTOR-106-local-evidence-2026-08-23.md`; external/live acceptance remains open.  evidence: manual |
| `REFACTOR-107` Cron dual-path hygiene | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | All cron consumers now import the canonical `domain/feature-flags` module; the orchestrator-local re-export and dead legacy-registration env keys are removed; local evidence is recorded in `packages/backend/artifacts/evaluation/REFACTOR-107-local-evidence-2026-08-23.md`; dual-path remains until the ORCH-102 30-day gate.  evidence: manual |
| `REFACTOR-108` Sanctioned env-access enforcement | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | DI-managed runtime configuration now uses `ConfigService`; only documented bootstrap/domain/instrumentation exceptions remain; local evidence is recorded in `packages/backend/artifacts/evaluation/REFACTOR-108-local-evidence-2026-08-23.md`.  evidence: manual |
| `DESIGN-101` Design-system primitive completion | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | `Modal`, `Table`, `Tabs` and `Tooltip` are implemented and exported in the existing Tailwind token style; scoped typecheck, UI suite and primitive formatting evidence is recorded in `packages/backend/artifacts/evaluation/DESIGN-101-local-evidence-2026-08-23.md`; global workspace formatting remains dirty outside this slice.  evidence: manual |
| `NETWORK-101` API-first network validation | `NETWORK-001` | `VERIFY` | current user/parallel worktree | 2026-08-23 | Native Bluesky AT Protocol and Mastodon REST posters, API permalink verification and explicit browser rollback switches are locally implemented; ADR-015 is accepted. evidence: manual |
| `DESIGN-102` Views adopt primitives | `Z6` | `VERIFY` | current user/parallel worktree | 2026-08-23 | Queue-facing PostEditor uses the shared Modal; Analytics uses Table; Calendar uses Modal; Queue/Dashboard/Monitor contain no remaining ad-hoc table/dialog primitives; local evidence is recorded in `packages/backend/artifacts/evaluation/DESIGN-102-local-evidence-2026-08-23.md`. evidence: manual |

No other task may edit overlapping files until these workstreams are reconciled.

## Current Wave 0 continuation claims

The ORCH-101 read-only reconciliation is archived. No Wave 0 continuation claim is active.

## Current Wave 1 claim

`SYND-101` is locally verified and remains a P1 article-syndication `VERIFY` gate in the
current worktree; its Orca ownership and exact file family are recorded in the intake and
task row above.
`EVAL-302` and `EVAL-303` are held for manual/editorial curation and are not dispatched.

## Evaluation and AI release gate

Feature: `EVAL-001`.

| Task | Status | Priority | Depends on | Deliverable / required evidence |
|---|---|---:|---|---|
| `EVAL-302` Curate generation cases | `BLOCKED` | P0 | `EVAL-301`, manual/editorial curator | 60 reviewed X/Threads cases across five languages/six archetypes; human review required before dataset evidence. |
| `EVAL-303` Curate orchestrator/runtime/safety cases | `BLOCKED` | P0 | `EVAL-301`, manual/editorial curator | 30 action, 20 resilience and 10 adversarial cases; human review required before dataset evidence. |
| `EVAL-304` Upload/version hosted Langfuse dataset | `BLOCKED` | P0 | `EVAL-302`, `EVAL-303` | Langfuse is reachable, but hosted dataset and score-config counts are both zero; no synthetic/local manifest is uploaded. Read-only preflight: `packages/backend/artifacts/evaluation/EVAL-304-langfuse-preflight-2026-08-23.md`. Human/editorial curation remains required. |
| `EVAL-401` Langfuse experiment runner | `TODO` | P0 | `EVAL-202`, `EVAL-203`, `EVAL-304` | Hosted dataset run, item/run scores, bounded concurrency/budget, flush. |
| `EVAL-402` Immutable JSON/Markdown report | `TODO` | P1 | `EVAL-204`, `EVAL-401` | SHA/dataset/candidate-bound artifact with missing evidence. |
| `EVAL-501` Durable review decision model | `VERIFY` | P0 | `ACCOUNT-101` | Additive model/migration, transactional Post+review write, shared DTO/UI feedback contract and local tests are recorded in `packages/backend/artifacts/evaluation/EVAL-501-local-evidence-2026-08-23.md`; real DB/operator evidence remains open.  evidence: manual |
| `EVAL-502` Feedback score sync/reconciliation | `VERIFY` | P0 | `EVAL-501`, `EVAL-101` | Idempotent score IDs, claim-before-sync, bounded retry, disabled-path durability, redaction, cron/orchestrator reconciliation and local tests are implemented; real Langfuse outage/recovery and hosted score evidence remain open.  evidence: manual |
| `EVAL-503` Human annotation queue and taxonomy | `BLOCKED` | P0 | `EVAL-304`, `EVAL-501` | Create score configs before queue; human open-code 50 samples. |
| `EVAL-504` Double-label calibration set | `BLOCKED` | P1 | `EVAL-503` | 30 independent two-human labels and adjudication; `MANUAL`. |
| `EVAL-505` Judge calibration experiment | `TODO` | P1 | `EVAL-401`, `EVAL-504` | Confusion matrix, kappa, TPR/TNR and TRUST/ANNOTATE_ONLY verdict. |
| `EVAL-602` Trusted Langfuse smoke/nightly/promotion CI | `TODO` | P1 | `EVAL-401`, `EVAL-402` | Pinned action/SDK/dataset, fork-secret boundary and regression report. |
| `EVAL-701` Evaluation dashboards and SLO queries | `VERIFY` | P1 | `EVAL-104`, `EVAL-502` | Review evidence/calibration dashboard and API expose coverage, sync, confusion metrics and kappa locally in `packages/backend/artifacts/evaluation/EVAL-701-local-evidence-2026-08-23.md`; real human calibration, hosted runs, cost export and production SLO evidence remain open.  evidence: manual |
| `EVAL-702` Online evaluators and alert catalog | `VERIFY` | P1 | `EVAL-505`, `EVAL-701` | Deterministic checks, 5%/force-included semantic sampling, bounded SLO snapshots and Sentry/Discord alert routing are locally verified in `packages/backend/artifacts/evaluation/EVAL-702-local-evidence-2026-08-23.md`; hosted judge, production stream and alert drills remain open.  evidence: manual |
| `EVAL-801` Freeze production-control candidate | `TODO` | P0 | `EVAL-401` | Recorded fallback manifest and reproducible baseline run. |
| `EVAL-802` Run GPT-5.4 mini/nano/hybrid matrix | `BLOCKED` | P1 | `EVAL-505`, `EVAL-801` | Provider budget/keys and held-out experiment evidence. |
| `EVAL-803` Run locked OpenRouter free candidates | `BLOCKED` | P2 | `EVAL-801` | Exact model IDs/quota locked after preflight; no floating router. |
| `EVAL-804` Promotion record and canary | `TODO` | P1 | `EVAL-802` or `EVAL-803`, `REL-001` | PROMOTE/HOLD/REJECT record; rollback-capable canary. |

## Product foundation and roadmap work

`PERSONA-103`, `MEDIA-101`, `POLICY-102` and `CRM-101` appear only once, in
[Current worktree ownership](#current-worktree-ownership) (deduplicated 2026-08-23).

| Task | Feature | Status | Priority | Depends on | Deliverable / acceptance |
|---|---|---|---:|---|---|
| `ACCOUNT-102` Multi-account isolation acceptance | `ACCOUNT-001` | `VERIFY` | P0 | `ACCOUNT-101` | Local two-account selection/session/browser/limits/WorldState contract is recorded in `packages/backend/artifacts/evaluation/ACCOUNT-102-local-evidence-2026-08-23.md`; real two-account Redis/Postgres, staging and manual platform evidence remain required.  evidence: manual |
| `ACCOUNT-201` Complete per-account settings resolver/UI | `ACCOUNT-002` | `VERIFY` | P1 | `ACCOUNT-101` | Resolver, API/UI and local tests are complete; staging/manual operator acceptance remains required.  evidence: manual |
| `PERSONA-100` Verify committed per-account voice override | `PERSONA-001` | `VERIFY` | P1 | `ACCOUNT-101` | Commit `8132759` exists; focused override-grouping and global-fallback tests now pass in `generation.service.spec.ts`; current dirty-worktree reconciliation and broader persona decision remain open.  evidence: manual |
| `PERSONA-101` Immutable persona revision model | `PERSONA-001` | `VERIFY` | P1 | `ACCOUNT-102`, `EVAL-201` | Shared schema, immutable revision/assignment migration, safe defaults, admin-guarded AuthorContext/management API and persona assignment UI are locally verified in `packages/backend/artifacts/evaluation/PERSONA-101-local-evidence-2026-08-23.md`; external acceptance remains open.  evidence: manual |
| `PERSONA-102` Persona generation and trace propagation | `PERSONA-001` | `VERIFY` | P1 | `PERSONA-101`, `EVAL-101` | Structured per-network AuthorContext prompt injection, account/revision/mode Post provenance and trace metadata are locally implemented in `packages/backend/artifacts/evaluation/PERSONA-102-local-evidence-2026-08-23.md`; held-out distinguishability and provider/staging trace evidence remain.  evidence: manual |
| `ENGAGE-101` Engagement ports/value-policy refactor | `ENGAGE-001` | `VERIFY` | P1 | `PERSONA-101` | Candidate scoring now precedes LLM selection, suggestions persist with review concurrency, policy-gated execution/recording seams and the operator approve/edit/reject/expire queue UI are locally verified in `packages/backend/artifacts/evaluation/ENGAGE-101-local-evidence-2026-08-23.md`; live review and native execution remain.  evidence: manual |
| `ENGAGE-102` Reviewed Threads/X suggestion pilot | `ENGAGE-001` | `TODO` | P1 | `ENGAGE-101`, `EVAL-505` | Threads approval-required, X suggest-only, skip terminal, no fabricated experience. |
| `ENGAGE-103` Replies question/safety soak | `ENGAGE-001` | `TODO` | P1 | `PLAN-002`, `POLICY-101`, `EVAL-203` | Question-only reply path, safety escalation, rate limits and >=10 real reviewed questions without incident. |
| `REL-102` Resilience integration and state-machine evidence | `REL-001` | `VERIFY` | P1 | `REL-101` | LLM/browser/session/queue integrations, recovery probes, health endpoint/dashboard and local tests are recorded in `packages/backend/artifacts/evaluation/REL-102-local-evidence-2026-08-23.md`; real failure/recovery and staging evidence remain required.  evidence: manual |
| `COST-102` Cost-quality router experiment | `COST-001` | `TODO` | P2 | `EVAL-801`, `COST-101` | Role routing chosen by promotion evidence, not price alone. |
| `SYND-101` Complete article publish flow | `SYND-001` | `VERIFY` | P1 | — | Orca task `task_5847d7d0398e` was locally verified in the current worktree; evidence `packages/backend/artifacts/evaluation/SYND-101-local-evidence-2026-08-23.md` covers draft generation/persistence, canonical fail-closed verification, mocked Nest integration and focused tests. Live Dev.to, external canonical HTML, deployment, operator approval and rollback-drill evidence remain required before archive.  evidence: manual |
| `NETWORK-101` API-first network validation (Bluesky/Mastodon) | `NETWORK-001` | `VERIFY` | P1 | `REFACTOR-101`, ADR-015 | 2026-08-23 transport decision applies the standing rule "free official API → API, else stealth browser": Bluesky via AT Protocol API and Mastodon via Mastodon API as native posters + verification patterns registered in `domain/network-profiles`; browser posters for these two networks are conserved behind a feature flag; Facebook/LinkedIn remain browser-only. Local dry-run/API/type/unit evidence is recorded in `packages/backend/artifacts/evaluation/NETWORK-101-local-evidence-2026-08-23.md`; per-network live evidence remains. evidence: manual |
| `TGBOT-101` Telegram operator control bot | `CONTROL-001` | `VERIFY` | P2 | REFACTOR-105 ✅(VERIFY), [Roadmap 16](../roadmap/16-telegram-control-bot.md) | Local command/status/alert routing is implemented and tested; manual evidence remains for one real Telegram approve/reject/pause-resume round-trip, allowlist rejection and alert drill. evidence: manual |
| `ORCH-102` Orchestrator GA/dual-path gate | `ORCH-001` | `TODO` | P1 | `REL-102`, `EVAL-505` | 72h soak, watchdog/recovery, no duplicate cron registration, rollback. |
| `ORCH-103` Posting-window evidence and scheduling gate | `ORCH-001` | `TODO` | P2 | `ORCH-102`, real `PostMetrics` | Per-account/network recommendations beat static baseline without violating limits. |
| `DIST-101` Multi-instance readiness audit | `DIST-001` | `VERIFY` | P2 | `REL-102` | Report `packages/backend/artifacts/evaluation/DIST-101-reconciliation-2026-08-23.md` reconciles cache/locks/leader/watchdog/queue/checkpoint claims; remains VERIFY pending REL-102, watchdog ownership decision and multi-instance integration evidence.  evidence: manual |
| `GROUND-101` Reviewed evidence/retrieval model | `GROUND-001` | `VERIFY` | P2 | `PERSONA-102`, `EVAL-301` | Structured evidence/memory lifecycle, lexical retrieval ports, AuthorContext traces, admin-guarded review queues, grounding UI and purge are locally verified in `packages/backend/artifacts/evaluation/GROUND-101-local-evidence-2026-08-23.md`; contradiction eval, privacy deletion and hosted/vector gates remain.  evidence: manual |
| `INTEL-101` Demand Radar implementation foundation | `INTEL-001` | `VERIFY` | P2 | `PLAN-002`, `ENGAGE-102` | Privacy-first signal minimization, deterministic bounded extractor, exact cluster foundation, review states, aggregate-only product insight proposal and operator Demand Radar UI are locally verified in `packages/backend/artifacts/evaluation/INTEL-101-local-evidence-2026-08-23.md`; richer clustering, ambiguity evaluation, live source and EVAL gates remain.  evidence: manual |
| `ATTR-101` Direct attribution live funnel gate | `ATTR-001` | `BLOCKED` | P1 | `ATTR-103`, `ATTR-104`, external deployment | Local SPA/zodiac-back route/auth contract is reconciled in `packages/backend/artifacts/evaluation/ATTR-101-cross-project-contract-2026-08-23.md`; non-zero click→session→conversion evidence and deployed exact-SHA endpoint remain unavailable. |
| `ATTR-104` Conversion dashboard UI and live data | `ATTR-001` | `VERIFY` | P1 | `ATTR-103`, external deployment | Local conversion dashboard is implemented and verified in `packages/backend/artifacts/evaluation/ATTR-104-local-evidence-2026-08-23.md`; deployed live funnel and revenue evidence remain required.  evidence: manual |
| `ATTR-201` Assisted attribution implementation foundation | `ATTR-002` | `TODO` | P2 | `PLAN-002`, `ATTR-101`, `ENGAGE-102` | Account/persona/time association with explicit direct/assisted/incremental types. |
| `POLICY-101` Policy registry and compiled authorization foundation | `POLICY-001` | `VERIFY` | P1 | `PLAN-002`, `REL-102`, `EVAL-203` | Versioned evidence, most-restrictive compile, pre-side-effect reauthorization and Policy Registry UI are locally verified in `packages/backend/artifacts/evaluation/POLICY-101-local-evidence-2026-08-23.md`; official-source review, promotion and live evidence remain.  evidence: manual |
| `BRIDGE-101` Versioned Soulwise editorial feed contract | `BRIDGE-001` | `BLOCKED` | P1 | `PLAN-002`, cross-repo owner | Read-only allowlisted API/adapter, ETag/version/tombstone and privacy contract in both repositories. |
| `BRIDGE-102` Curated knowledge and retraction expansion | `BRIDGE-001` | `TODO` | P2 | `BRIDGE-101`, `GROUND-101` | Reviewed knowledge/product updates, tombstone/expiry re-index and cross-project rollback. |
| `PERSONA-201` Approved-edit learning and conversational go/no-go | `PERSONA-001`, `ENGAGE-001` | `TODO` | P2 | `EVAL-505`, `ENGAGE-102` | Versioned reversible learning with no truth/safety regression and explicit execution-mode decision. |
| `EVAL-805` Fine-tuning assessment | `EVAL-001`, `PERSONA-001`, `COST-001` | `TODO` | P3 | `EVAL-802`, `PERSONA-201` | Prompt/few-shot/RAG baseline versus fine-tune quality/cost report and GO/NO-GO ADR. |

## Platform hardening and unification track (`HARDEN-001`)

File-disjoint from account/eval/policy lanes (owned worktrees above). Owner of this
track: current agent worktree, claimed 2026-08-23. Sequence is H0 → H1 → H2 → H3;
details in [EXECUTION_ROADMAP.md](./EXECUTION_ROADMAP.md) "Hardening track".

| Task | Status | Priority | Depends on | Deliverable / acceptance |
|---|---|---:|---:|---|
| `CI-001` Enforce coverage + UI tests in CI | `VERIFY` | P0 | — | `ci.yml` backend+ui jobs: worktree based on `92ffc15` has full noncoverage 223 files / 2406 tests / 0 failures; latest serialized coverage is 75.75/66.58/73.82/77.19 with 223 files, 2405 passed, 1 skipped, 0 failed against ratchet floors 73/64/70/74. Original 80/75/80/80, exact clean-SHA reconciliation and first real GitHub Actions run remain open. Evidence: `packages/backend/artifacts/evaluation/CI-001-local-evidence-2026-08-23.md`; evidence: manual |
| `CI-002` Prod Redis eviction policy fix | `VERIFY` | P0 | — | `docker/docker-compose.prod.yml` shared Redis uses `noeviction` with BullMQ-safety comment + `CHECKPOINT_REDIS_URL` split guidance; maxmemory is 512mb. Local Compose config renders and parses successfully; production/staging exact-SHA deployment and live Redis inspection remain. Evidence: `packages/backend/artifacts/evaluation/CI-002-local-evidence-2026-08-23.md`. evidence: manual |
| `REFACTOR-100` Cross-module hygiene fixes | `VERIFY` | P1 | — | `monitoring` injects `ILlmPort` (+ optional-port degradation); infra queue module renamed `QueueInfraModule` (collision removed, all 9 importers updated); `Generate.vue` raw `fetch()` → shared axios instance (UI suite green); both Dockerfiles aligned: dead better-sqlite3 native handling removed (optional peer only), deterministic Camoufox pre-fetch+COPY, heap cap, prisma-schema-before-install, `--filter @spa/backend`, prod `--ignore-scripts`. Backend full typecheck blocked by two pre-existing errors in a CONCURRENT foreign slice (`generation-persistence.*`) — re-run after that slice settles.  evidence: manual |
| `REFACTOR-101` Network profile registry | `VERIFY` | P0 | `REFACTOR-100` | New `packages/backend/src/domain/network-profiles/` canonical source of per-network knowledge (`charLimit`, `toneGuidance`, `angle`, `ctaPolicy`, `personaGuidance`, `verificationPattern`) is consumed by generation/posts/posters; clean-resource full typecheck and live network evidence remain.  evidence: manual |
| `REFACTOR-102` Generation service decomposition | `VERIFY` | P0 | `REFACTOR-101` | `generation.service.ts` split along existing seams into `GenerationRunLifecycle` (start/pause/resume/crash-recovery), `GenerationPersistence` (Post rows, llmMetadata, SimHash), `ReviewResumeService` (HITL interrupt) and `PostFactory`. Public behavior unchanged; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-102-local-evidence-2026-08-23.md`; clean-resource typecheck and external/live gates remain.  evidence: manual |
| `REFACTOR-103` Posting service decomposition | `VERIFY` | P0 | `REFACTOR-101` | `posting.service.ts` split into `PostingGuardChain`, `PostingDispatcher`, `ThreadOrchestrator` (legacy + multi-stage), `CtaAttributionService`, plus verification and side-effect seams; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-103-local-evidence-2026-08-23.md`; runtime integration and external/live gates remain.  evidence: manual |
| `REFACTOR-104` X poster page objects | `VERIFY` | P1 | `REFACTOR-103` | `x.poster.ts` decomposed into `XComposePage` / `XThreadReplies` / `XVerification` page objects; canonical profile/permalink shared seams preserved; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-104-local-evidence-2026-08-23.md`; native/staging/live gates remain.  evidence: manual |
| `REFACTOR-105` Unified `.js` import convention | `VERIFY` | P1 | `REFACTOR-102..104` | All backend relative imports use explicit `.js` extensions; lint gate added so mixed style cannot return; `google-trends-rss` shim removed after consumers migrate; local evidence is in `packages/backend/artifacts/evaluation/REFACTOR-105-local-evidence-2026-08-23.md`; CI first green and deployment gates remain.  evidence: manual |
| `REFACTOR-106` Dead multilingual config removal | `VERIFY` | P2 | `REFACTOR-101` | English-only content path enforced as the only path: ru/uk/es/it language tables, language packs and `POSTING_LANGUAGES` surface removed (YAGNI); local typecheck, lint, backend/UI tests and import/static checks pass; external/live acceptance remains open.  evidence: manual |
| `REFACTOR-107` Cron dual-path hygiene | `VERIFY` | P2 | — | Single source of truth for `isOrchestratorEnabled` in `domain/feature-flags`; orchestrator-local re-export and dead `ORCHESTRATOR_CHECKPOINT_KEY` / `CRON_PARTICIPATION_SCHEDULE` surfaces removed; local typecheck, lint, focused cron tests and full unit tests pass; dual-path itself stays until the `ORCH-102` 30-day gate.  evidence: manual |
| `REFACTOR-108` Sanctioned env-access enforcement | `VERIFY` | P2 | — | Direct runtime reads outside the documented bootstrap/domain/instrumentation exceptions now use `ConfigService` (trending events, dry-run flags, Prisma URL, continuation delay, browser wrapper and X diagnostics); local typecheck, lint, targeted and full unit tests pass.  evidence: manual |
| `DESIGN-101` Design-system primitive completion | `VERIFY` | P1 | `REFACTOR-105` | `Modal`, `Table`, `Tabs` (+ `Tooltip`) are built in the existing shadcn-flavored style over Tailwind v4 tokens, exported from the UI barrel and covered by component tests; local evidence is in `packages/backend/artifacts/evaluation/DESIGN-101-local-evidence-2026-08-23.md`; light mode remains parked.  evidence: manual |
| `DESIGN-102` Views adopt primitives | `VERIFY` | P1 | `DESIGN-101` ✅(VERIFY) | Ad-hoc dialogs/tables are reconciled across the priority views and remaining UI surfaces; local evidence is in `packages/backend/artifacts/evaluation/DESIGN-102-local-evidence-2026-08-23.md`; manual visual/accessibility review remains. evidence: manual |
| `EXTRACT-001` Move persona editorial defaults out of code | `HARDEN-001` | `PLANNED` | P2 | `PERSONA-101` | `persona.defaults.ts` hardcodes the deployment vertical (astrology-flavored Soulwise defaults) inside OSS src — contradicts CONSTITUTION "domain lives in user markdown" and required a sanctioned carve-out in the CI branding gate. Extract DEFAULT_PERSONA_PROFILES to config/markdown-driven loading, then remove the carve-out entry. |
Track rules:

- one slice at a time inside the track (its own WIP limit of 3 concurrent code slices
  still applies globally);
- every task ends with `tsc --noEmit` + full vitest green before the next starts;
- REFACTOR tasks keep public service APIs stable unless the task says otherwise.

## Backlog rules

- A task appears once. Domain specifications reference the ID instead of copying status.
- New implementation details become subtasks only when they can be independently
  accepted; otherwise keep them in the primary spec.
- `BLOCKED` rows name the condition in `Depends on`/acceptance.
- On completion, move the entire row with evidence to `archive/YYYY-QN.md`.
