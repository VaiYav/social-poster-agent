# 05 — LLM Token-Cost Optimization

## Document maturity (non-canonical)

Feature status: `COST-001` in [the canonical register](../planning/FEATURES.md).

Proposal and reconciliation. SPA now has shared Redis/in-memory response-cache adapters, a corrected cache key, token budgets, structured cost/usage telemetry, a durable provider-attempt ledger, optional prompt compression/cost ordering and a local cost dashboard. Semantic cache, hook-cache Redis runtime and degradation actions remain future scope.

## Verified current state (2026-08-23)

The following local source/unit evidence is current at SHA `f95ff84`:

- `LlmService` cache keys include provider, model, max tokens, temperature, role and
  image identity where applicable; creative and vision calls bypass the response cache.
- Cache adapters support shared Redis and in-memory modes; this does not prove external
  Redis availability or multi-instance production behavior.
- Token budgets are orchestrator-hourly or generation-run scoped. Reservation, actual
  charge and release use an atomic Redis script; a denied reservation does not mutate
  usage counters.
- Attempt telemetry records usage, latency, provider/model identity, cost provenance and
  cache hits. EVAL-104 provides local synthetic redaction/coverage evidence only.
- `LlmUsageEvent` persists available provider attempts and `/analytics/cost` plus the Analytics
  cost card expose local account/provider/day aggregates. External billing and database evidence
  remain unverified.
- Semantic cache, prompt compression, cost-quality routing and per-account daily budget enforcement
  remain partially unverified: compression, opt-in price ordering and daily reservation are local;
  semantic cache, hook-cache Redis runtime and degradation actions remain open.

## Problem

As the platform adds multi-account, per-account prompts, image generation, and engagement, LLM spend grows quickly. Remaining gaps are:

- Semantic cache and prompt compression are not implemented.
- Cost-quality routing is not implemented; provider selection still follows configured chains.
- The same brand-voice/system prompt is sent repeatedly, uncompressed.
- Creative roles (`draft`, `hook`) bypass the cache entirely.
- There is no enforced per-account daily spend cap or degradation policy when a cap is reached.

## Product Outcome

Reduce aggregate LLM spend by 30-60% without lowering post quality, and give operators visibility into cost per account/day/model.

## Levers (from research)

Research sources:
- Kong AI Gateway: semantic routing, semantic cache, prompt compression, cost-based rate limiting: https://developer.konghq.com/cookbooks/llm-cost-optimization/
- Martin Kostov production case: caching + prompt compression + model routing cut costs 67%: https://martinkostov.me/blog/how-to-reduce-llm-api-costs-in-production
- Microsoft LLMLingua: up to 20x prompt compression: https://github.com/microsoft/LLMLingua

## Proposed Changes

### 1. Shared Redis L2 Response Cache

Status: implemented locally through the cache port and Redis/in-memory adapters; the
exact-key and cache-eligibility claims are source/unit verified. External Redis and
multi-instance behavior remain unverified.

Replace or extend the in-process `Map` in `LlmService` with a cache port:

```ts
export interface ILlmCachePort {
  get(key: string): Promise<LlmResponse | null>;
  set(key: string, value: LlmResponse, ttlMs: number): Promise<void>;
  clear(): Promise<void>;
}
```

- `RedisLlmCache` for production / multi-instance.
- `MemoryLlmCache` for tests and single-instance dev.

Fix the cache key to include:
- `provider` name,
- `model`,
- `maxTokens`,
- `temperature` (normalized),
- `role`,
- SHA-256 of `systemPrompt` and `userPrompt`.

### 2. Semantic Cache (optional phase 2)

Before calling the LLM, embed the user prompt and search for semantically similar cached responses. Use a cheap local embedding via `transformers.js` or an external embedding provider. Store in Postgres or Redis with vector similarity.

Scope for the first version:
- Keep semantic cache **read-only** for deterministic roles (`facts`, `critique` on identical topics).
- Do not use for `draft`/`hook` because creative output should not be semantically cached.
- Threshold: cosine similarity ≥ 0.95.

### 3. Prompt Compression

Compress long system prompts (especially brand voice and examples) before sending. Options:

- **LLMLingua sidecar** (recommended for strongest savings): run a small Python HTTP service with `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`. `LlmService` calls it when `LLM_PROMPT_COMPRESSION_ENABLED=true` and prompt token count > threshold.
- **Simple heuristic fallback**: remove duplicate whitespace, collapse repeated examples, truncate if over a cap.

Add env:

```text
LLM_PROMPT_COMPRESSION_ENABLED=false
LLM_PROMPT_COMPRESSION_URL=http://localhost:8000/compress
LLM_PROMPT_COMPRESSION_MIN_TOKENS=500
LLM_PROMPT_COMPRESSION_RATE=0.6
```

### 4. Cost-Aware Model Routing

Enhance `LLM_ROLE_CHAINS` with cost/quality tiers:

```text
LLM_ROLE_CHAINS=draft=anthropic:cheap,openai:cheap,google;critique=groq,cerebras;sambanova;judge=groq,cerebras
```

Or add a `CostRouter` that:
- knows per-provider per-model price per 1M tokens,
- picks the cheapest provider whose circuit breaker is closed,
- upgrades to a premium provider only if the cheaper one returns low quality or fails.

Track per-call cost in a new `LlmUsageEvent` table or Redis stream.

### 5. Per-Account / Per-Run Cost Budgets

Add `CostLedgerService`:

```ts
{
  accountId?: string;
  runId?: string;
  model: string;
  provider: string;
  role: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cached: boolean;
  createdAt: Date;
}
```

Enforce per-account daily spend cap. When exceeded:
- skip image generation,
- skip non-essential judge calls,
- degrade to cheapest model,
- alert operator.

### 6. Hook Cache Improvements

The graph already has an in-process `hookCache` (`generation.graph.ts`). Move it to Redis so it survives process restarts and works across instances:

```
spa:cache:hook:{sha256(topic,keywords,facts)}
```

### 7. Precomputed Assets

- Compute per-language `slopList` once and cache.
- Build per-account `brandVoice` blob once per run and reuse across graph nodes (already in state, but verify it is not re-read from disk per node).
- Cache Langfuse prompt compilations by label for 5 minutes.

## Data Model / Tables

```prisma
model LlmUsageEvent {
  id          String   @id @default(uuid())
  accountId   String?
  postId      String?
  runId       String?
  provider    String
  model       String
  role        String
  tokensIn    Int
  tokensOut   Int
  costUsd     Decimal  @db.Decimal(10, 6)
  cached      Boolean  @default(false)
  durationMs  Int?
  createdAt   DateTime @default(now())

  @@index([accountId, createdAt])
  @@index([runId])
  @@index([role, createdAt])
}
```

## API / UI

- `GET /analytics/cost?accountId=&from=&to=` — cost breakdown.
- Dashboard "Cost Today" card with per-account and per-model bars.
- Alert when account daily budget exceeds 80%.

## Service Integration

| Service | Change |
|---------|--------|
| `LlmService` | inject `ILlmCachePort`; fixed cache key; optional compression pre-call; cost tracking |
| `PromptRegistry` | cache compiled prompts by label for 5 min |
| `GenerationService` | track per-run cost; pass per-account budget signal to `LlmService` |
| `ImageGenerationService` | track image cost in `CostLedgerService` |
| `RateLimitService` | add cost-based rate-limit keys |
| `Orchestrator` | choose actions based on remaining budget |

## Environment Variables

```text
LLM_CACHE_SHARED=true                # existing, ensure Redis implementation
LLM_CACHE_TTL_MS=300000
LLM_SEMANTIC_CACHE_ENABLED=false
LLM_PROMPT_COMPRESSION_ENABLED=false
LLM_PROMPT_COMPRESSION_URL=...
LLM_PROMPT_COMPRESSION_MIN_TOKENS=500
LLM_PROMPT_COMPRESSION_RATE=0.6
LLM_COST_ROUTER_ENABLED=false
LLM_DAILY_BUDGET_PER_ACCOUNT_USD=10.0
```

## Risks

| Risk | Mitigation |
|------|------------|
| Semantic cache returns wrong creative output | only cache deterministic roles; high similarity threshold |
| Prompt compression drops important instruction | test on judge/critique output; keep rate conservative (0.6) |
| Cost router degrades quality | define minimum quality per role; fail closed for critical roles |
| Multi-instance cache inconsistency | use Redis-backed cache with short TTL |

## Acceptance Criteria

- [x] `ILlmCachePort` exists with Redis and in-memory adapters.
- [x] Cache key includes model/provider/maxTokens/temperature/role.
- [x] Durable `LlmUsageEvent` records every available LLM provider attempt with cost.
- [x] Per-account daily cost budget is enforced through an optional conservative pre-call reservation.
- [ ] `hookCache` is backed by Redis.
- [x] Prompt compression sidecar integration is documented and optional.
- [x] Dashboard shows local cost analytics.

## Open Questions

- Should prompt compression be applied before or after caching?
- Should cost router prefer free providers even if latency is higher?
- Do we want a global daily spend cap in addition to per-account caps?
- For semantic cache, which embedding model/runtime should we use? `transformers.js` is the easiest Node-native option.

## Effort Estimate

**M** (2-3 weeks) for exact cache + cost tracking + hook cache. **M-L** (3-4 weeks) if semantic cache and prompt compression sidecar are included.

## Related Internal Docs

- `packages/backend/src/infrastructure/llm/llm.service.ts`
- `packages/backend/src/modules/generation/generation.graph.ts` (hook cache)
- `packages/backend/src/infrastructure/prompt/prompt-registry.ts`
- `docs/features/multi-instance-distribution.md`
