# 05 — LLM Token-Cost Optimization

## Status

Proposal. SPA already routes across providers and has an in-memory response cache, but there is no semantic cache, prompt compression, or cost-aware routing.

## Problem

As the platform adds multi-account, per-account prompts, image generation, and engagement, LLM spend grows quickly. Today:

- `LlmService` caches by SHA-256 of `systemPrompt + userPrompt + temperature` only; it omits `model`, `maxTokens`, `role`, `provider` from the key.
- The cache is in-process, so multi-instance deployments duplicate calls.
- The same brand-voice/system prompt is sent repeatedly, uncompressed.
- Creative roles (`draft`, `hook`) bypass the cache entirely.
- There is no cost budget per account or per run.
- Provider selection is based on env chain, not on the actual cost/quality needs of the call.

## Product Outcome

Reduce aggregate LLM spend by 30-60% without lowering post quality, and give operators visibility into cost per account/day/model.

## Levers (from research)

Research sources:
- Kong AI Gateway: semantic routing, semantic cache, prompt compression, cost-based rate limiting: https://developer.konghq.com/cookbooks/llm-cost-optimization/
- Martin Kostov production case: caching + prompt compression + model routing cut costs 67%: https://martinkostov.me/blog/how-to-reduce-llm-api-costs-in-production
- Microsoft LLMLingua: up to 20x prompt compression: https://github.com/microsoft/LLMLingua

## Proposed Changes

### 1. Shared Redis L2 Response Cache

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

- [ ] `ILlmCachePort` exists with Redis and in-memory adapters.
- [ ] Cache key includes model/provider/maxTokens/temperature/role.
- [ ] `LlmUsageEvent` records every LLM call with cost.
- [ ] Per-account daily cost budget is enforced.
- [ ] `hookCache` is backed by Redis.
- [ ] Prompt compression sidecar integration is documented and optional.
- [ ] Dashboard shows cost analytics.

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
