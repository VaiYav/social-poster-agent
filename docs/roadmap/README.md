# 2026 SPA Product Expansion Roadmap

> **Роль папки:** product/technical specifications, не backlog.
> Единственный текущий статус: [feature register](../planning/FEATURES.md) и
> [active backlog](../planning/BACKLOG.md). Статус в шапке конкретного proposal
> означает зрелость документа и может быть устаревшим.

> 📍 **Milestone mapping (не статус):** 09,12 policy/eval foundation → M0-M1;
> 01,02,04,08 foundation → M1-M2; 08,10,11,14 pilots → M2-M3;
> 06,09,12 runtime control → M3; 03,07,08,13,14 → M4-M5;
> 05,08,10,11,13 learning → M5-M6 в **[../planning/ROADMAP.md](../planning/ROADMAP.md)**.

This directory holds feature proposals for the next wave of **Social Poster Agent (SPA)** capabilities. Each file below covers one product/technical area in enough detail for product and engineering to estimate, sequence, and break the work into tasks.

> These are **proposals**, not implemented code. Before starting any of them re-verify file references against the current source tree.

## Context

- The system currently assumes **one active account per network** (`SocialAccount` has `@@unique([network, handle])`, `AccountsService.findByNetwork()` returns the first active account).
- All configuration is global (`.env.example` / `ConfigService`).
- All prompts derive from one `brand-voice.md` and a per-network persona.
- Engagement has no versioned account persona, durable interaction memory, or policy-safe
  suggestion queue; current comment-first behavior is not a substitute for a relevance/value gate.
- Posts are text-only; image support exists only as a disabled `QuoteCardService` and an experimental `VisualConceptService`.
- `LlmService` already has provider fallback, role chains, and an in-memory response cache, but no semantic cache or prompt compression.
- The codebase has retries, circuit breakers, and a `HealthMonitorService`, but no unified degradation/recovery model.
- Competitive/feature gap analysis: `docs/audit/05-features-and-competitors.md`
- Canonical backlog: `docs/planning/BACKLOG.md`; reviews/refactor files are inputs only.

## Proposals at a Glance

| # | File | Feature | Product Goal | Touches | Effort | Risk |
|---|------|---------|--------------|---------|--------|------|
| 1 | [01-multi-account.md](./01-multi-account.md) | Multi-account support | Run 2+ Threads/X/Facebook accounts from one SPA instance | `SocialAccount`, `SessionsService`, `BrowserFactory`, `PostingService`, `RateLimitService`, `GenerationService` | **L** | High (correlation/ban risk) |
| 2 | [02-per-account-settings.md](./02-per-account-settings.md) | Per-account settings | Every configurable knob is overridable per account | New `AccountSettings` schema, resolver, UI | **M** | Medium |
| 3 | [03-gemini-nano-image-generation.md](./03-gemini-nano-image-generation.md) | Gemini Nano Banana image generation | Attach cheap AI-generated images to posts, with per-account daily limits | New `IImagePort`, posters image upload, quota/cost tracking | **M** | Medium |
| 4 | [04-per-account-prompts-brand-voice.md](./04-per-account-prompts-brand-voice.md) | Per-account prompts / brand voice | Each account has its own tone, persona, and prompt overrides | `AccountPromptProfile`, per-account graph state, `PromptRegistry` | **M** | Medium |
| 5 | [05-llm-token-cost-optimization.md](./05-llm-token-cost-optimization.md) | LLM token-cost optimization | Cut API spend across generation/judge/engagement | Shared/semantic cache, prompt compression, cost router, budget ledger | **M** | Low/Medium |
| 6 | [06-self-healing-resilience.md](./06-self-healing-resilience.md) | Self-healing & graceful degradation | Detect failures, fall back, and recover automatically | `ResilienceService`, health levels, circuit-breaker/bulkhead improvements | **L** | Medium |
| 7 | [07-additional-features-research.md](./07-additional-features-research.md) | Additional feature research | Calendar, analytics, UTM, fact-check, recycling, RBAC, etc. | Various | **S-L** | Low/Medium |
| 8 | [08-editorial-personas-conversational-engagement.md](./08-editorial-personas-conversational-engagement.md) | Editorial personas, conversational engagement & memory | Run two distinct Soulwise voices across posts and high-value Threads/X conversations with auditable memory, safety and platform policy | New `PersonaModule`, account assignments, generation/engagement context, suggestion queue, memory/RAG, analytics | **L** (phased) | High (health/privacy/platform policy) |
| 9 | [09-ai-change-release-gate.md](./09-ai-change-release-gate.md) | AI change release gate / evaluation harness | Reproducibly gate prompts, models, personas, judges and agent-policy changes | Langfuse datasets/experiments, CI, human feedback, telemetry | **L** (phased) | Medium |
| 10 | [10-conversation-intelligence-demand-radar.md](./10-conversation-intelligence-demand-radar.md) | Conversation intelligence & demand radar | Convert reviewed public questions into auditable content/product demand | Engagement outcomes, privacy filter, clustering, review | **L** | High (privacy/product truth) |
| 11 | [11-reply-to-revenue-assisted-attribution.md](./11-reply-to-revenue-assisted-attribution.md) | Reply-to-revenue assisted attribution | Separate direct, assisted association and incrementality evidence | Z4 funnel, conversation windows, analytics | **L** | High (causal claims) |
| 12 | [12-platform-policy-reputation-control-plane.md](./12-platform-policy-reputation-control-plane.md) | Platform policy & reputation control plane | Make every action evidence-backed, downgrade stale policy and contain semantic incidents | Policy registry/compiler, reputation state, FlowControl, runbooks | **L** | High (policy/reputation) |
| 13 | [13-creator-relationship-crm.md](./13-creator-relationship-crm.md) | Creator relationship & collaboration CRM | Build reciprocal public relationships and human-led collaborations instead of comment volume | Interaction evidence, creator relationships, collaboration workflow, Z4 | **M-L** | High (privacy/outreach) |
| 14 | [14-soulwise-editorial-data-bridge.md](./14-soulwise-editorial-data-bridge.md) | Soulwise editorial data bridge | Feed SPA versioned public facts, curated knowledge and product truth without personalized data | Cross-project internal API, typed adapter, provenance/tombstones | **L** (cross-project) | High (health/privacy/contract) |
| 15 | [15-network-api-first-posters.md](./15-network-api-first-posters.md) | API-first network posters (Bluesky, Mastodon) | Add validated networks via free official APIs instead of browser automation; transport rule "free API → API, else stealth" | AT Protocol/Mastodon API posters, `domain/network-profiles`, verification | **M** | Low/Medium |
| 16 | [16-telegram-control-bot.md](./16-telegram-control-bot.md) | Operator control bot (Telegram) | Full HITL loop from the operator's phone: status, alerts, approve/reject, pause/resume | New `control-bot` module over existing services, Telegram Bot API long-polling, chat allowlist | **S-M** | Medium (audit/security) |

## Dependency Graph

```
1 Multi-account
  ├─ 2 Per-account settings
  │    ├─ 3 Image generation
  │    ├─ 4 Per-account prompts
  │    └─ 5 Token-cost optimization
  ├─ 4 Per-account prompts (also needs 2)
  │    └─ 8 Editorial persona foundation
  │         ├─ Engagement ports refactor (R4)
  │         ├─ Conversational suggestion pilot
  │         └─ Durable memory/RAG (also needs fact-checking)
  └─ 6 Self-healing (benefits from per-account isolation)

5 Token-cost optimization ─ can run in parallel, but per-account budgets need 2.
7 Additional features ─ can start anytime; some items need 1/2/3.
8 Learning loop ─ also uses 5 plus normalized analytics/experiments.
9 AI release gate ─ starts before other AI-affecting implementations and gates 8/10/11 promotion.
10 Demand Radar ─ needs 8 conversational outcomes and 9 release/eval controls.
11 Assisted attribution ─ needs direct attribution plus reviewed outcomes from 8.
12 Policy/Reputation ─ starts with 9; authorizes 8 and controls orchestrator/engagement runtime.
13 Creator CRM ─ needs 8 outcomes, 10 demand context and 12 policy/reputation safeguards.
14 Soulwise Editorial Bridge ─ needs 9 contract gate; feeds 8 planner/grounding and 10 insights.
```

## Suggested Sequencing

1. **Phase 0 — AI/policy control:** `09-ai-change-release-gate` plus policy-registry foundation
   from `12-platform-policy-reputation-control-plane`.
2. **Phase A — Account foundation:** `01-multi-account` + `02-per-account-settings`.
3. **Phase B — Voice and portfolio per account:** `04-per-account-prompts-brand-voice` plus the persona
   foundation slice of `08-editorial-personas-conversational-engagement`.
4. **Phase B2 — Conversational pilot:** close engagement refactor R4, then ship a reviewed Threads
   suggestion pilot and X suggestion-only flow from proposal `08`.
5. **Phase B3 — Demand and measurement:** `10` Demand Radar, `11` assisted attribution and the
   PUBLIC_FACT slice of `14` Editorial Bridge.
6. **Phase C — Runtime control:** `06` self-healing plus `09` drift/canary and `12` reputation state.
7. **Phase D — Visuals:** `03-gemini-nano-image-generation`.
8. **Phase E — Grounding and memory:** fact-checking, durable memory/RAG and curated `14` feed.
9. **Phase F — Relationships:** human-controlled creator CRM `13`.
10. **Phase G — Efficiency/learning:** `05` cost optimization plus evidence-gated learning from
    `08`, `10`, `11`, `13`; fine-tuning remains a go/no-go decision.

## How to Use These Docs

1. Read the relevant proposal.
2. Update acceptance criteria and effort based on the current state of the repo.
3. If it changes architecture, write an ADR in `docs/adr/`.
4. Add stable task IDs to `docs/planning/BACKLOG.md`; do not add a second checklist here.

## Research Sources

- Exa search — multi-brand publishing architecture: https://postproxy.dev/blog/multi-brand-social-media-publishing-architecture
- Exa search — Threads multi-account isolation: https://blog.send.win/manage-multiple-threads-accounts-multi-account-management-guide-2026/
- Exa search — browser fingerprint per-context (Camoufox): https://github.com/daijro/camoufox/blob/adc44fc8/docs/per-context-patches.md
- Exa search — Gemini image generation API: https://ai.google.dev/gemini-api/docs/image-generation
- Exa search — Nano Banana pricing: https://yingtu.ai/en/blog/nano-banana-pro-pricing-quota-guide-2026
- Exa search — LLM cost optimization (Kong AI Gateway): https://developer.konghq.com/cookbooks/llm-cost-optimization/
- Exa search — LLMLingua prompt compression: https://github.com/microsoft/LLMLingua
- Exa search — graceful degradation: https://sujeet.pro/articles/graceful-degradation
- Exa search — self-healing microservices: https://www.ijirset.com/upload/2024/june/292_Designing%20Self-Healing%20Microservices%20in%20Cloud-Native%20Architectures.pdf
- Meta Threads creator guidance — replies/discovery: https://about.fb.com/news/2024/10/find-your-community-with-new-threads-educational-insights/
- X automation rules — unsolicited/AI replies and non-API automation: https://help.x.com/en/rules-and-policies/x-automation
- LangGraph memory — checkpointer vs long-term Store: https://docs.langchain.com/oss/javascript/langgraph/add-memory
- Langfuse experiments in CI/CD: https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd
- Langfuse evaluation overview: https://langfuse.com/docs/evaluation/overview
- NIST Generative AI Profile: https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf
- OWASP LLM Top 10: https://genai.owasp.org/llm-top-10/
- Interoperable Private Attribution: https://eprint.iacr.org/2023/437
- Internal competitive audit: `docs/audit/05-features-and-competitors.md`
