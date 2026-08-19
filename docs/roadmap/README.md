# 2026 SPA Product Expansion Roadmap

This directory holds feature proposals for the next wave of **Social Poster Agent (SPA)** capabilities. Each file below covers one product/technical area in enough detail for product and engineering to estimate, sequence, and break the work into tasks.

> These are **proposals**, not implemented code. Before starting any of them re-verify file references against the current source tree.

## Context

- The system currently assumes **one active account per network** (`SocialAccount` has `@@unique([network, handle])`, `AccountsService.findByNetwork()` returns the first active account).
- All configuration is global (`.env.example` / `ConfigService`).
- All prompts derive from one `brand-voice.md` and a per-network persona.
- Posts are text-only; image support exists only as a disabled `QuoteCardService` and an experimental `VisualConceptService`.
- `LlmService` already has provider fallback, role chains, and an in-memory response cache, but no semantic cache or prompt compression.
- The codebase has retries, circuit breakers, and a `HealthMonitorService`, but no unified degradation/recovery model.
- Competitive/feature gap analysis: `docs/audit/05-features-and-competitors.md`
- Existing backlog: `docs/reviews/ACTION_PLAN.md` and `docs/refactor/phase-6-7-p3-strategic-features.md`

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

## Dependency Graph

```
1 Multi-account
  ├─ 2 Per-account settings
  │    ├─ 3 Image generation
  │    ├─ 4 Per-account prompts
  │    └─ 5 Token-cost optimization
  ├─ 4 Per-account prompts (also needs 2)
  └─ 6 Self-healing (benefits from per-account isolation)

5 Token-cost optimization ─ can run in parallel, but per-account budgets need 2.
7 Additional features ─ can start anytime; some items need 1/2/3.
```

## Suggested Sequencing

1. **Phase A — Account foundation:** `01-multi-account` + `02-per-account-settings`.
2. **Phase B — Voice per account:** `04-per-account-prompts-brand-voice`.
3. **Phase C — Visuals:** `03-gemini-nano-image-generation` (uses account settings and voice).
4. **Phase D — Efficiency:** `05-llm-token-cost-optimization` (protects spend from multi-account and image volume).
5. **Phase E — Reliability:** `06-self-healing-resilience` (operational backbone as scale grows).
6. **Phase F — Differentiation:** selected items from `07-additional-features-research`.

## How to Use These Docs

1. Read the relevant proposal.
2. Update acceptance criteria and effort based on the current state of the repo.
3. If it changes architecture, write an ADR in `docs/adr/`.
4. Move concrete tasks into `docs/reviews/ACTION_PLAN.md` when the team is ready to start.

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
- Internal competitive audit: `docs/audit/05-features-and-competitors.md`
