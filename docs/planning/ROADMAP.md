# SPA Product Roadmap — from autoposter to lead machine

> **Role:** product goals, milestone sequence and GATEs. Canonical home of this
> document is `docs/planning/` (moved from root `ROADMAP_V2.md`, 2026-08-23).
> **Feature/task status:** [FEATURES.md](./FEATURES.md) and [BACKLOG.md](./BACKLOG.md)
> only. Dependency waves and claiming rules:
> [EXECUTION_ROADMAP.md](./EXECUTION_ROADMAP.md).
> Statuses/checklists inside roadmap/spec/review files are NOT current state and must
> not be maintained in parallel with the planning hub.
>
> **Version:** 3.0 · **Date:** 2026-08-23 · **Status:** ACTIVE
> Supersedes root `ROADMAP_V2.md` (v2.4, RU, kept as archived original) and
> `ROADMAP.md` (phases 0–6, sprints A–G — completed).
>
> Product: an autonomous social-media operations agent (X / Threads / Facebook +
> syndication) that generates, publishes and promotes content. The primary success
> metric is **attributable leads** into
> [my_zodiac_ai](https://github.com/valentinyakovlev/my_zodiac_ai), not "posts published".

---

## Legend

| Label | Meaning |
|---|---|
| **Z1–Z6** | Ownership zones (§2). Every task maps to one zone |
| **M0…M6** | Roadmap phases (§4). Phases partially overlap |
| **GATE** | Measurable phase-closure criterion. Next phase does not start until the GATE passes |
| **R1…R9** | Refactor register items (§6) |
| **P1/P2/P3** | Priority within a phase (must / should / nice-to-have) |
| *(NN)* | Reference to a proposal in `docs/roadmap/01..16`; status lives under the feature ID in `docs/planning/FEATURES.md` |

---

## §1 Goals & KPIs

### Goal 1 — Lead acquisition (PRIMARY)

Social networks → clicks → quiz funnel `quiz.my-zodiac-ai.com` → signups/payment.
All attribution lives in `my_zodiac_ai/back` (`attribution-links` module):
click → quiz session → snapshot → subscription, stitched by `quizSessionId`, with the
conversion (`convertedAt/revenue/subscriptionId`) written back to the click.

| KPI | Measurement | Baseline |
|---|---|---|
| Posts with a trackable link | `%` of posts with `ctaUrl != null` | 0% (prompts forbade URLs) |
| Link CTR | clicks / impressions via funnel reports | — |
| Leads per week | `AttributionClick` → signup, campaign=`social-agent` | 0 |
| Conversions / revenue | `GET :id/funnel` → revenue for agent links | 0 |
| Reply-assisted outcomes | direct / assisted / incremental reports separated; conversions per approved reply *(11)* | — |

### Goal 2 — Brand awareness

| KPI | Measurement |
|---|---|
| Follower growth | 30-day delta per account (PostMetrics + profiles) |
| Impressions / engagement rate | PostMetrics (likes/comments/shares/impressions); scraping exists |
| Presence stability | % of days with ≥1 post per network (orchestrator health) |
| Conversation quality | suggestion approval/edit rate, author reply rate, repeat meaningful interactions *(08)* |
| Demand from conversations | validated demand clusters → topics/FAQ/product insight, matched outcome delta *(10)* |
| Creator partnerships | reciprocal relationships, accepted/completed collaborations, attributed outcomes *(13)* |

### Goal 3 — High-quality agent system

| KPI | Measurement |
|---|---|
| Autonomous-loop uptime | ≥99% over 30 days (watchdog + self-healing) |
| Operator-free action share | orchestrator actions / manual interventions |
| Cost per post | Langfuse token telemetry, $/post, downward trend |
| Content quality | judgeScores (anti_ai_tone ≥0.7) + correlation with operator decisions |
| Persona stability | persona fidelity/distinctness, contradiction rate, unsupported-claim rate *(08)* |
| AI release quality | PASS/FAIL/ERROR gates, critical regression count, drift/rollback *(09)* |
| Policy/reputation health | stale policy blocks, reputation state, time-to-contain/recover *(12)* |

---

## §2 Ownership zones

Work is split into six zones. A zone = "who owns the problem", not a code directory.

### Z1 — Orchestrator & Reliability
The autonomous OBSERVE→DECIDE→ACT loop as the single execution path. 13 action
handlers, adaptive sleep, watchdog (`*/5 * * * *`). GA switch
(`ORCHESTRATOR_ENABLED=true` default, 11 crons unregistered) and dual-path removal.
Platform Policy & Reputation Control Plane *(12)* constrains execution capability and can
idempotently downgrade/pause account/topic/action scope. GATE owner: uptime ≥99%.

### Z2 — Content Intelligence
Prompts and generation quality: research → hooks → draft → critique → refine → judge
(Langfuse Prompt Management, 7 prompts). CTA policy, versioned EditorialPersona +
AuthorContext + memory/RAG *(04,08)*, fact-checking pipeline (a differentiator none of
Postiz/Mixpost/Typefully/Hypefury/Buffer/Publer/Taplio has), persona/first-person/
sensitive-domain gates, hook bank → few-shot feedback. Conversation Intelligence /
Demand Radar *(10)*, Cross-Account Portfolio Planner *(08)* and the read-only Soulwise
Editorial Data Bridge *(14)* form the source→opportunity→assignment contour.

### Z3 — Accounts & Networks
Multi-account core *(01)*: per-account selection instead of "first active"; isolated
sessions/browser contexts/limits/warm-up. Per-account settings *(02)*. Persona assignment
and platform execution policy for conversational engagement *(08)*. End-to-end syndication
(article graph: Dev.to/Hashnode/LinkedIn long-form + real `verifyCanonical()`).
Network validation with the transport rule (free API → API, else stealth browser;
see §9 and roadmap 15). Poster capabilities: first-reply CTA delivery for X/Threads.
Image gen *(03)*. N-resource fan-out via PublisherRegistry (§9).

### Z4 — Link Attribution (client of zodiac-back)
**Integration zone.** No own link infrastructure is built — redirects, clicks,
conversions and revenue live in `my_zodiac_ai/back`
(`modules/business/attribution-links`).

Attribution flow:

```
Post generation
   │ ZodiacLinkClient.createTrackableLink({network, campaign, postId})
   │ POST {ZODIAC_API_URL}/internal/attribution-links   (X-Internal-Token)
   ▼
my_zodiac_ai/back · attribution-links
   │ slug → shortUrl https://quiz.my-zodiac-ai.com/r/{slug}
   ▼
Post.ctaUrl = shortUrl → poster publishes (X/Threads: link as first reply)
   ▼
click → /r/[slug] → resolveForRedirect() → AttributionClick (geo/device/ipHash)
      → 302 to destinationUrl + utm_* → quiz → signup → payment → conversion written back
   ▼
social-poster dashboard ◄── GET /internal/attribution-links/:id/funnel (clicks→conversions→revenue)
```

social-poster responsibilities:
- `ILinkPort`: `createTrackableLink()` / `getFunnelReport()` / `buildDirectUtmUrl()` (fallback)
- `Post ↔ attributionLinkId/slug` mapping in Prisma
- Fallback when zodiac is unreachable: direct UTM link (revived `source-url.util.ts`)
- Dashboard: aggregation of funnel reports by campaign/network

zodiac-back contract (implemented): `AttributionLink{slug, platform(=utm_source),
medium, campaign, content, refTag, customFields(post_id...),
destinationUrl(allowlist *.my-zodiac-ai.com)}` + `AttributionClick` (per-click,
geo/os/browser, stitch-key `quizSessionId`, TTL 30d, conversion writeback).

Env: `ZODIAC_API_URL`, `ZODIAC_INTERNAL_TOKEN`, `ZODIAC_DEFAULT_DESTINATION_URL`.

Reply-first measurement is extended with a privacy-safe account/persona/time cohort
layer *(11)*: direct attribution stays canonical in zodiac; assisted association and
incremental estimates are stored/shown as distinct evidence types.

### Z5 — Analytics & Learning
Dashboards (Vue 3 UI): conversion dashboard v1, judge calibration, best-time-to-post.
A/B at scale: `PostVariant` → metrics → automatic winner selection → hook-bank feedback.
Persona/mode experiments and conversation outcomes keep separate normalized assignments
*(08)*. Posting windows from real PostMetrics. Demand clusters/outcomes *(10)*,
assisted/incremental reporting *(11)* and Creator Relationship CRM *(13)* feed the
learning loop but cannot weaken safety/policy gates automatically.

### Z6 — Platform Health
Tech Radar (§5): LangGraph 0.2→1.x upgrade, Zod 3→4, playwright-core patch-site audit.
Refactor register (§6). Planning-doc consolidation (§8). Token cost optimization *(05)*.
ResilienceService *(06)*. AI Change Release Gate *(09)* and policy-drift registry *(12)*
own pre-release and external-policy evidence.

---

## §3 Current-state snapshot (2026-08-23)

**Working today:**
- Generation: LangGraph research→hooks→draft→critique→refine→judge→visual_concept;
  Redis checkpoints, crash resume; LLM-as-a-Judge scores stored in `judgeScores`.
  Service decomposition landed: persistence/lifecycle/review seams + post factory.
- Prompts in Langfuse Prompt Management (7 prompts, versioning, circuit breaker, fallbacks).
- Posting: X / Threads / Facebook through Camoufox (patched playwright-core),
  verification pipeline decomposed into guard chain / dispatcher / thread orchestrator /
  CTA attribution / verification services; URL patterns single-sourced in
  `domain/network-profiles`. Trackable CTA links wired end-to-end in the backend
  (ATTR-102/103 archived): zodiac short links with UTM fallback, X/Threads first-reply
  delivery, conversion dashboard locally verified.
- Orchestrator: 13 action handlers, HardRules → LLM → Guardrails, heartbeat, watchdog;
  crons disabled when `ORCHESTRATOR_ENABLED=true` (dual-path removal still gated by ORCH-102).
- Foundations locally verified (VERIFY rows): multi-account slices, per-account settings,
  editorial persona + portfolio planner, reviewed engagement suggestions, durable review
  truth + calibration dashboards, demand radar, creator CRM, grounding, reputation state,
  image-gen quota foundation, article syndication slice.
- Hardening track (HARDEN-001) locally verified through the current refactor/design slices:
  CI coverage+UI gates, prod Redis `noeviction` fix, posting/generation god-class
  decomposition, unified import convention, English-only config cleanup, cron/config hygiene
  and the initial UI primitive set. CI first-green, clean-worktree formatting, visual/manual
  accessibility and external/live gates remain separate.
- Observability: Sentry + Langfuse traces with judge metadata.

**Still missing (the primary gap remains revenue evidence):**
- **Zero live funnel**: backend contract done, but no deployed zodiac-back integration and
  no real click/conversion has flowed yet (ATTR-101 blocked on deployment).
- Multi-account acceptance on real two-account infrastructure.
- Engagement/Replies remain feature-flagged pending reviewed pilots.
- Dual-path: cron removal waits for the 30-day uptime gate.
- Blocking AI release manifest/dataset gate *(09)*, hosted judge runs, human calibration.
- Dependencies lag: LangGraph ^0.2 (current 1.x), zod ^3.24 (current 4.x).

**Strategic context:**
- Official X API since Feb 2026 ≈ $0.20 per post with a link ⇒ browser strategy
  confirmed for X; APIs are adopted wherever free (Bluesky/Mastodon decision 2026-08-23).
- Competitors do not cover: fact-checking, autonomous orchestrator with LLM decisions,
  end-to-end attribution down to payment — our differentiators.

---

## §4 Phases

### M0 (weeks 1–2) — Measurability foundation

| # | Zone | Task | P |
|---|---|---|---|
| M0.1 | Z4 | Prisma migration: `Post += ctaUrl?, attributionLinkId?, attributionSlug?` (done) | P1 ✅ |
| M0.2 | Z4 | `ILinkPort` domain port + internal-API ADR (done, ADR-007/ATTR-102) | P1 ✅ |
| M0.3 | Z4* | **Cross-project:** `/internal/attribution-links` controller in zodiac-back (contract ready; deployment pending) | P1 |
| M0.4 | Z6 | Dependency audit → Tech Radar report (LangGraph, Zod, patch sites) | P1 |
| M0.5 | Z6 | Planning-doc consolidation: archive banners (done) | P2 ✅ |
| M0.6 | Z4 | Revive `source-url.util.ts` as the direct-UTM fallback core (done via ATTR-102, closes R1) | P2 ✅ |
| M0.7 | Z2/Z5/Z6 | AI Change Release Gate *(09)* | P1 |
| M0.8 | Z3/Z6 | Platform Policy Registry foundation *(12)* (locally verified; promotion evidence open) | P1 |

**GATE M0:** migration applied and tested; internal-API ADR agreed and endpoint deployed
in zodiac-back; tech-radar report recorded; legacy docs archived; seeded AI regression
blocked without side effects; evaluator ERROR never becomes PASS; every enabled
side-effect action has unexpired evidence-backed compiled policy.

### M1–M2 — Account Foundation

| # | Zone | Task | P |
|---|---|---|---|
| M1.1 | Z3 | Multi-account core *(01)*: per-account selection, isolation of sessions/contexts/limits/warm-up, per-account WorldState | P1 |
| M1.2 | Z3 | Per-account settings *(02)*: schema + resolver + UI | P2 |
| M1.3 | Z2/Z3 | EditorialPersona v1 *(04,08)*: immutable revisions, assignment, AuthorContext, normalized traces | P1 |
| M1.4 | Z3 | End-to-end syndication: article-graph publish + real `verifyCanonical()` (closes R7; local slice verified) | P2 |
| M1.5 | Z6 | Self-healing phase 1 *(06)*: ResilienceService skeleton, health levels | P2 |
| M1.6 | Z2/Z3 | Cross-Account Portfolio Planner *(08)* (locally verified; held-out eval open) | P1 |
| M1.H | Z6 | **Hardening track H0–H3** (`HARDEN-001`): CI coverage+UI gates, Redis eviction fix, god-class decomposition (generation/posting/x.poster), `.js` import unification, network-profile single source, design-system primitives, single English roadmap | P1 |

**GATE M1-M2:** two same-network accounts operate in isolation (posting, sessions,
limits); an article publishes end-to-end with canonical verification; every new Post
stores an immutable persona revision + voice mode and a paired eval distinguishes two
personas; unsupported first-person claims are blocked; the planner never assigns
duplicate/contradictory thesis and keeps an explainable constraint/score trace.

### M2–M3 — Lead Funnel v1 ⭐ (flagship phase)

| # | Zone | Task | P |
|---|---|---|---|
| M2.1 | Z4 | `ZodiacLinkClient` adapter over `ILinkPort`; graceful UTM degradation; circuit breaker + timeout (backend done) | P1 ✅ |
| M2.2 | Z2 | Prompt CTA policy: per-network URL rules; Langfuse prompt updates | P1 |
| M2.3 | Z3 | First-reply link capability for X/Threads posters (backend done) | P1 ✅ |
| M2.4 | Z5 | Conversion dashboard v1 (local UI verified; live data gate open) | P2 |
| M2.5 | Z4 | Replies unfreeze: dialogue-graph soak, question-only auto-reply, safety escalation, reply rate limits | P2 |
| M2.6 | Z2/Z3/Z5 | Conversational engagement pilot *(08)*: deterministic value/policy gate, bounded context, suggestion queue + operator review; Threads=`HUMAN_APPROVAL_REQUIRED`, X outbound=`SUGGEST_ONLY` | P1 |
| M2.7 | Z2/Z5 | Conversation Intelligence & Demand Radar pilot *(10)* | P2 |
| M2.8 | Z4/Z5 | Reply-to-Revenue v1 *(11)*: bio links, conversation windows, direct-vs-assisted dashboard | P1 |
| M2.9 | Z2/Z4* | **Cross-project:** Soulwise Editorial Feed v1 *(14)*: PUBLIC_FACT envelope, ETag/cursor API, dedicated client | P1 |
| M2.10 | Z4 | Deploy zodiac-back internal endpoint + execute `ATTR-101`: first real tracked post → visible non-zero funnel event | P1 |

**GATE M2-M3:** the first post with a trackable link is published; a click is visible in
the dashboard (funnel report returns non-zero data); replies answered ≥10 real questions
without incidents; the fallback path is proven (zodiac off → post ships with direct UTM);
the conversation pilot cannot bypass execution policy, `skip` stays terminal, X has no
unsolicited auto-reply path, and two persona voices are distinguishable in held-out reply
eval. Demand Radar stores only privacy-eligible reviewed clusters; direct and assisted
attribution separated; Editorial Feed contract blocks forbidden user-level fields.

### M3–M4 — Orchestrator GA

| # | Zone | Task | P |
|---|---|---|---|
| M3.1 | Z1 | Close remaining `.forge` work streams (reconciled via ORCH-101) | P1 |
| M3.2 | Z1 | Self-healing GA *(06)*: resilience integrations, auto-recovery playbook | P1 |
| M3.3 | Z1 | 24–48h staging soak with real sessions; watchdog kill→restart proven | P1 |
| M3.4 | Z1 | Switch default `ORCHESTRATOR_ENABLED=true`; delete dual-path crons (closes R3) | P1 |
| M3.5 | Z5 | Posting windows from real PostMetrics | P2 |
| M3.6 | Z1/Z3/Z6 | Reputation Monitor *(12)*: HEALTHY→WATCH→LIMITED→PAUSED→INCIDENT, scoped FlowControl auto-pause + staged recovery | P1 |
| M3.7 | Z2/Z6 | AI gate shadow/nightly drift *(09)*: fixed slices, production drift detection, rollback-capable canary | P1 |

**GATE M3-M4:** 30 days uptime ≥99%; zero missed critical actions; production registers
no cron paths; dual-path code deleted; seeded reputation incidents produce expected scoped
effects, sentiment-only cannot pause an account, nightly gate detects seeded drift, and
canary/rollback creates no duplicate side effects.

### M4–M5 — Scale & Visuals

| # | Zone | Task | P |
|---|---|---|---|
| M4.1 | Z3 | Network validation *(15)*: API-first Bluesky (AT Protocol) + Mastodon (REST); Facebook battle-test, Telegram channel, LinkedIn short-form via browser where no free API | P1 |
| M4.2 | Z3 | Image gen *(03)*: IImagePort GA — credentials, HITL preview, native/staging upload evidence (quota foundation locally verified) | P2 |
| M4.3 | Z2 | Fact-checking pipeline v1: claim extraction → verification → flag/refuse | P2 |
| M4.4 | Z5 | Best-time-to-post windows per network/account | P2 |
| M4.5 | Z4 | Bio-link page v1 (optional; value re-check now that links go straight to the quiz) | P3 |
| M4.6 | Z2/Z5 | Durable persona memory + grounding *(08)*: reviewed evidence, contradiction/expiry/purge, hybrid retrieval behind ports | P2 |
| M4.7 | Z5 | Creator Relationship CRM *(13)*: public identity, staged relationships, human-reviewed collaborations only | P2 |
| M4.8 | Z2/Z4* | Soulwise Editorial Feed expansion *(14)*: curated knowledge, tombstones/retraction re-index | P2 |
| M4.9 | Z6 | Operator control bot *(16)* `CONTROL-001`: Telegram status/alerts/approve/reject/pause-resume with chat allowlist | P2 |

**GATE M4-M5:** ≥4 networks stable in battle; ≥1 network publishes a verified image path;
fact-check blocks factual errors on the test set; held-out retrieval/evidence thresholds
passed, stale/contradictory evidence is not injected, privacy purge removes lexical/vector
retrieval. Creator CRM holds no private enrichment and has no auto-outreach; Editorial Feed
tombstone/expiry removes eligibility/cache/retrieval with proven cross-project rollback.

### M5–M6 — Learning Loop

| # | Zone | Task | P |
|---|---|---|---|
| M5.1 | Z5 | A/B at scale: variant metrics → winner selection → hook-bank feedback | P1 |
| M5.2 | Z5 | Judge calibration UI: judgeScores ↔ operator decisions, correlation ≥0.7 | P2 |
| M5.3 | Z2 | Hook bank → generation: top hooks as few-shot in hook prompt | P2 |
| M5.4 | Z6 | Token cost optimization *(05)*: semantic cache, compression, cost router, budget ledger | P2 |
| M5.5 | Z2/Z3/Z5 | Conversational autonomy go/no-go *(08)* after the M2.6 pilot | P2 |
| M5.6 | Z6 | Close P1 refactor-register items | P2 |
| M5.7 | Z2/Z5/Z6 | Fine-tuning assessment *(08)*: baseline comparison, GO/NO-GO ADR | P3 |
| M5.8 | Z2/Z4/Z5 | Conversation learning evidence *(10,11,13)*: matched outcomes, pre-registered incrementality, collaboration outcomes; insufficient sample returns NO_CONCLUSION | P2 |

**GATE M5-M6:** the A/B loop is closed (variant→metric→winner→prompt); judge↔human
correlation measured and ≥0.7; persona learning reproducible/versioned/reversible without
truth/safety regression; cost per approved output reduced or the reason documented;
execution-mode and fine-tuning decisions have separate evidence-backed go/no-go records;
assisted association is never presented as causal lift, and incrementality/creator/demand
reports return uncertainty or NO_CONCLUSION without auto-promoting strategy.

---

## §5 Tech Radar

| Ring | Technologies |
|---|---|
| **Adopt** | Structured outputs (Zod schemas on all LLM calls where possible); semantic LLM cache; Langfuse versioned datasets/experiments + blocking AI release manifest *(09)*; evidence-backed most-restrictive action policy *(12)* |
| **Trial** | LangGraph 0.2→1.x (assessment M0.4, migration after GA); Zod 3→4; MCP wrapper around SPA as a tool for external agents |
| **Assess** | Deep Agents/subagents for generation decomposition; computer-use models vs Camoufox selectors (anti-detect outweighs); official APIs wherever cheap (Telegram already API) |
| **Hold** | New networks beyond §9 entry conditions (one platform per iteration, ≥2-week soak); official X API ($0.20/post — browser strategy confirmed); multi-tenant SaaS/RBAC/billing; own link infrastructure (lives in my_zodiac_ai/back) |

Rule: Adopt←Trial transitions require an ADR plus a ≥2-week soak period.

---

## §6 Refactor register

Source: `docs/refactor/phase-1..7` + August 2026 audit; execution status tracked in
[BACKLOG.md](./BACKLOG.md) ("Platform hardening and unification track").

| ID | P | What | When |
|---|---|---|---|
| R1 | P1 | Revive `source-url.util.ts` as the direct-UTM fallback core | M0.6 ✅ (ATTR-102) |
| R2 | P1 | Unify relative-import style (explicit `.js` extensions repo-wide) + lint gate | REFACTOR-105 (VERIFY; CI first green and deployment remain) |
| R3 | P1 | Delete cron/orchestrator dual path after the 30-day GA gate | M3.4 / ORCH-102 |
| R4 | P1 | Split frozen engagement code behind ports before the conversational pilot | M2.6 |
| R5 | P2 | Direct `process.env` reads outside sanctioned list → ConfigService | REFACTOR-108 (VERIFY) |
| R6 | P2 | Planning-doc consolidation, archive banners | M0.5 ✅ |
| R7 | P2 | Real `CanonicalUrlService.verifyCanonical()` | M1.4 ✅ (SYND-100) |
| R8 | P3 | UI component/view tests | DESIGN-101/102 + CI ui job (partial) |
| R9 | P0 | God-class decomposition (generation.service, posting.service, x.poster) + platform-knowledge single source | REFACTOR-101..108 (HARDEN-001; VERIFY evidence recorded) |

---

## §7 Non-goals

- **Own link infrastructure** — redirect endpoints, shortener, click model (lives in
  my_zodiac_ai/back and evolves there).
- Reddit / Quora / Substack / RU platforms without API before §9 entry conditions hold
  (ban/reputation risk).
- Official X API for posting ($0.20/post economics).
- Unsolicited automated replies and keyword-triggered comment spam; X outbound replies
  stay `SUGGEST_ONLY` without explicit platform approval; Threads approval-required *(08)*.
- Passing synthetic editorial personas off as real people; fabricated lived experience *(08)*.
- Separate vector DB and per-account fine-tuned models in the first persona release *(08)*.
- User-level social→quiz identity stitching; assisted association labelled causal *(11)*.
- Automatic policy promotion, sentiment-only autopause, enforcement bypass attempts *(12)*.
- Automated creator DMs/outreach, private contact enrichment, psychographic profiling *(13)*.
- Exporting Soulwise birth/cycle/couple/chat/personalized data; AGGREGATE_INSIGHT before a
  dedicated privacy ADR *(14)*.
- Multi-tenant SaaS, external-user RBAC, billing.
- Video generation.
- Separate shortener domain (short links live on the zodiac quiz domain).

---

## §8 Archive map

| Document | Status | Fate |
|---|---|---|
| `ROADMAP.md` (root) | ARCHIVED | Phases 0–6, sprints A–G completed; banner points here (M0.5) |
| `ROADMAP_V2.md` (root) | ARCHIVED 2026-08-23 | Russian v2.4 original; this file is the canonical English continuation |
| `FEATURE_WISHLIST.md` | ARCHIVED | F1–F22 distributed (see v2.4 §8) |
| `docs/roadmap/01..16` | SPECIFICATIONS | Intent/design only; status lives in planning hub |
| `.forge/orchestrator/*` | LEGACY Z1 detail | Reconciled read-only via ORCH-101 |
| `docs/refactor/phase-1..7` | Source | Moved into §6 (R1–R9) |
| `CONSTITUTION.md` | Requirements/history | Holds no status; see FEATURES.md |
| `AGENTS.md` | CURRENT | Operational conventions (import rule R2, Z4 env) |

---

## §9 Parking lot — publish-everywhere fan-out

### Transport selection rule (owner decision, 2026-08-22; applied 2026-08-23)

> **Free official API available → use the API. Paid or absent → stealth browser (Camoufox).**

Transport is fixed per-platform in a capability manifest; behaviours differ, the contract
is shared. Applied first to Bluesky (AT Protocol) and Mastodon (REST) — *(15)*; Threads/FB
API migrations stay assess-only behind their entry conditions.

| | API publisher | Stealth-browser publisher |
|---|---|---|
| Post latency | seconds | minutes (human-like pacing) |
| Parallelism | free | bounded by browser pool |
| Ban risk | none (official channel) | managed (warm-up, limits, fingerprints) |
| Fragility | API versions | selectors/DOM |
| Cost | $0 | browser infrastructure |

### Fan-out architecture ("one piece of content → N properties simultaneously")

```
GeneratedPost (graph output, ctaUrl already resolved via Z4)
   ▼
PublisherRegistry ─► per-platform capability manifest
   │                 {transport: api|browser, maxChars, media,
   │                  ctaPolicy, replyLinkSupport, rateLimits}
   ▼
PublishFanout (BullMQ fan-out, job = platform × account)
   ├── api.publisher       Dev.to, Hashnode, Medium, Telegram, Bluesky…
   └── browser.publisher   X, Threads, FB, Quora… (shared Camoufox pool)
   ▼
verifyPosted() → PostMetrics scraper → zodiac funnel reports → dashboard
```

Fan-out requirements (nothing blocks anything else):

- **Isolation**: queue-per-platform, per-job timeout — one platform failing delays no other.
- **Per-platform circuit breaker**: 3 consecutive failures → 30-min cooldown → operator alert.
- **Attempt logging**: `{platform, accountId, attempt, outcome, latencyMs, screenshotRef}`;
  correlated with the Langfuse trace runId; Sentry for crash-level.
- **Graceful-degradation matrix**: zodiac unreachable → direct UTM; platform down → skip +
  dashboard report; session expired → relogin flow → operator escalation.
- **Observability**: weekly success-rate per platform on the Z5 dashboard; alert below threshold.

### Candidates (classified by the transport rule)

| Platform | Transport by rule | Status | Entry condition |
|---|---|---|---|
| X | browser (Basic $200+/mo, ~$0.20/post) | live | — |
| Threads | browser now; free official Threads API (Meta review) → migrate per rule | live; assess | after GA M3-M4 |
| Facebook | browser for profile; Graph API free for Pages → move if Page | live; decide | multi-account M1-M2 |
| Dev.to | API (free) | M1.4 | — |
| Hashnode | GraphQL API (free) | M1.4 | — |
| LinkedIn | API (free; app review) — articles done, short-form M4.1 | planned | — |
| Medium | API (free token) | parking | after GATE M1-M2 |
| Telegram (channel) | Bot API (free) | M4.1 | — |
| Bluesky | AT Protocol API (free) | **M4.1 — selected (15)** | — |
| Mastodon | REST API (free) | **M4.1 — selected (15)** | — |
| Tumblr | API (free) | parking | P3 |
| WordPress / Ghost / Blogger | API (free) | parking | P3 — own SEO hub; decide after M2-M3 lead metrics |
| VK | API (free) | parking | P3, RU audience |
| Instagram | Content Publishing API (Business; photo/video only) | parking | after image gen M4.2 |
| Pinterest | API v5 (free) | parking | after image gen M4.2 |
| Reddit | conditional-free API; commercial use paid | Hold | ADR after GA — reputational risk |
| Quora | no API → browser | Hold | high ban risk |
| Substack | no official API → browser-assess | Hold | questionable value/effort |
| Habr / VC.ru / Dzen | no stable API → browser-assess | Hold | RU loop, if VK lands |

**Entry rule:** max one new platform per iteration; ≥2-week soak before adding the next.
Concurrent load bounded by the browser pool and per-account limits (M1.1). API platforms
scale freer — prioritize them.

---

## §10 Changelog

| Date | Version | Changes |
|---|---|---|
| 2026-08-22 | 2.0 | Initial edition (RU): lead-gen goals, zones Z1–Z6, phases M0–M6, zodiac-back attribution integration, Tech Radar, refactor register, archival of ROADMAP.md / FEATURE_WISHLIST.md |
| 2026-08-22 | 2.1 | §9 parking lot: transport rule, fan-out architecture, candidate table |
| 2026-08-22 | 2.2 | Proposal *(08)*: personas, conversational suggestion policy, R4→M2.6, memory/RAG→M4.6, learning/fine-tune gates→M5–M6 |
| 2026-08-22 | 2.3 | Proposals *(09–14)*: AI release gate, Demand Radar, assisted attribution, portfolio planner, policy/reputation control plane, creator CRM, Soulwise bridge |
| 2026-08-22 | 2.4 | Canonical Wave 0–6 dependency order, intake queue, WIP/ownership rules, evidence-first handoff |
| 2026-08-23 | 3.0 | English rewrite and relocation to `docs/planning/ROADMAP.md`; §3 snapshot updated to current truth (lead-funnel backend done, hardening track executing); transport rule applied to Bluesky/Mastodon *(15)*; control bot *(16)* added as M4.9; refactor register refreshed (R9); archive map extended |
