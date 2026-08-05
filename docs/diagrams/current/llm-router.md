# LLM Router — Provider Fallback Chain — Current State

> **Free-first fallback:** How SPA routes LLM requests across 15 OpenAI-compatible providers.
> **As-is:** Groq → SambaNova → Cerebras → OpenRouter → DeepSeek → OpenAI → Google → NVIDIA → GitHub → xAI → Mistral → HuggingFace → Together → Cohere → Ollama (local, keyless last resort).

```mermaid
flowchart TD
    Request([LLM request<br/>generateChat / generate]) --> Entry[LlmService entry<br/>resolve role chain<br/>LLM_ROLE_CHAINS]

    Entry --> Concurrency{Concurrency cap<br/>LLM_MAX_CONCURRENT<br/>in-flight < max?}
    Concurrency -->|no| Wait[Wait in queue<br/>waiters]
    Wait --> Concurrency

    Concurrency -->|yes| CacheCheck{Check cache<br/>SHA256(messages+options)<br/>5-min TTL}

    CacheCheck -->|hit| ReturnCached[Return cached response]
    ReturnCached --> Done([Done])

    CacheCheck -->|miss| RoleRoute{Role-specific chain?<br/>LLM_ROLE_CHAINS}
    RoleRoute -->|yes, role match| RoleChain[Use role chain<br/>e.g. draft=google,deepseek]
    RoleRoute -->|no| DefaultChain[Use default chain<br/>all configured providers]

    RoleChain --> Provider1
    DefaultChain --> Provider1

    Provider1[Provider 1: Groq<br/>FREE — llama-3.3-70b] --> CB1{Circuit open?<br/>3 failures → 1 min cooldown}
    CB1 -->|open| Skip1[Skip provider]
    Skip1 --> Provider2
    CB1 -->|closed| Call1[Invoke ChatOpenAI<br/>LangChain]
    Call1 --> Result1{Result}
    Result1 -->|success| Record1[Record success<br/>reset breaker]
    Record1 --> Cache[Cache response<br/>5-min TTL]
    Cache --> Return([Return response])
    Return --> Done
    Result1 -->|429 / rate-limit| RL1[Rate-limit backoff<br/>retry same provider once<br/>LLM_RATE_LIMIT_RETRY_MS]
    RL1 --> Call1
    RL1 -->|still 429| Fail1[Record failure]
    Fail1 --> Provider2
    Result1 -->|empty content| Empty1[Empty-content cooldown<br/>60s skip]
    Empty1 --> Provider2
    Result1 -->|401/402/403 terminal| Term1[Terminal cooldown<br/>6h (LLM_CB_TERMINAL_COOLDOWN_MS)]
    Term1 --> Provider2
    Result1 -->|other error| Fail1

    Provider2[Provider 2: SambaNova<br/>FREE — 20M tok/day] --> CB2{Circuit open?}
    CB2 -->|open| Skip2[Skip]
    Skip2 --> Provider3
    CB2 -->|closed| Call2[Invoke]
    Call2 --> Result2{Result}
    Result2 -->|success| Cache
    Result2 -->|fail| Provider3

    Provider3[Provider 3: Cerebras<br/>FREE — gpt-oss-120b] --> Provider4
    Provider4[Provider 4: OpenRouter<br/>FREE — llama-3.3-70b:free] --> Provider5
    Provider5[Provider 5: DeepSeek<br/>cheap — deepseek-chat] --> Provider6
    Provider6[Provider 6: OpenAI<br/>gpt-5-nano — reasoning model<br/>temperature omitted] --> Provider7
    Provider7[Provider 7: Google<br/>FREE — gemini-2.5-flash] --> Provider8
    Provider8[Provider 8: NVIDIA<br/>FREE — llama-3.3-70b] --> Provider9
    Provider9[Provider 9: GitHub<br/>FREE — 150 RPD] --> Provider10
    Provider10[Provider 10: xAI<br/>grok-4.1-fast] --> Provider11
    Provider11[Provider 11: Mistral<br/>FREE — EU multilingual] --> Provider12
    Provider12[Provider 12: HuggingFace<br/>FREE — router] --> Provider13
    Provider13[Provider 13: Together<br/>FREE — $25 credits] --> Provider14
    Provider14[Provider 14: Cohere<br/>trial — 1000 calls/mo] --> Provider15
    Provider15[Provider 15: Ollama<br/>LOCAL — keyless last resort<br/>always appended] --> AllFailed{All failed?}
    AllFailed -->|yes| ThrowError([Throw last error<br/>caller handles])
    AllFailed -->|Ollama success| Cache

    %% Langfuse callbacks via AsyncLocalStorage
    Entry -.->|ALS callbacks| Langfuse[Langfuse tracing<br/>AsyncLocalStorage<br/>callbacks merged + deduped]
    Call1 -.-> Langfuse

    classDef entry fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#000
    classDef provider fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#000
    classDef cache fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:#000
    classDef terminal fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#000
    classDef external fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px,color:#000

    class Request,Entry entry
    class Provider1,Provider2,Provider3,Provider4,Provider5,Provider6,Provider7,Provider8,Provider9,Provider10,Provider11,Provider12,Provider13,Provider14,Provider15 provider
    class CacheCheck,Cache,ReturnCached cache
    class ThrowError,Done,Return terminal
    class Langfuse external
```

## Key details

### Free-first chain (15 providers)
- **Order:** Groq → SambaNova → Cerebras → OpenRouter → DeepSeek → OpenAI → Google → NVIDIA → GitHub → xAI → Mistral → HuggingFace → Together → Cohere → Ollama.
- **Only providers with their API-key env var set are included** — `buildProviderChain()` skips any provider whose `keyEnv` is empty.
- **Ollama is always appended** (`alwaysInclude: true`, `defaultApiKey: 'ollama'`) — keyless local last resort so the chain is never empty.
- All providers expose an OpenAI-compatible API, so **LangChain `ChatOpenAI`** is used for all of them (one client class, different `baseURL` + `apiKey`).
- Provider definitions are data (`PROVIDER_DEFINITIONS` array in `llm.service.ts`) — adding a provider is one array entry, no if/push blocks.

### Per-provider circuit breaker
- **3 consecutive failures → 1 min cooldown** (`LLM_CB_THRESHOLD=3`, `LLM_CB_COOLDOWN_MS=60000`).
- **Terminal errors (401/402/403) → 6h cooldown** (`LLM_CB_TERMINAL_COOLDOWN_MS`) — auth/billing failures are permanent until a human acts; retrying every minute just repeats the same failure.
- **Empty-content cooldown (60s)** — when a provider returns empty content (model refused / parsing issue), skip it to avoid the cascade where Groq 429s → OpenRouter empty → Cerebras empty → caller times out before reaching SambaNova.
- **Rate-limit (429) handling:** one retry on the **same** provider after `LLM_RATE_LIMIT_RETRY_MS` (2.5s) before failover — a 429 is a reason to wait, not to switch. Separate from the circuit breaker (`LlmProviderRateLimit`).

### 5-min SHA256 response cache
- Cache key: `SHA256(messages + options)` — identical prompts return cached response.
- **Redis shared cache by default** (`LLM_CACHE_SHARED=true`, prefix `spa:cache:llm`) — in-memory fallback when `false`.
- TTL: `LLM_CACHE_TTL_MS=300000` (5 min). Max size (in-memory): `LLM_CACHE_MAX_SIZE=100`.

### Reasoning model temperature handling
- Models matching `/^(gpt-5(\.\d+)?|o1|o3|o4-mini|codex-mini)/` get `temperature` **omitted** — they return HTTP 400 if you send it.
- `supportsTemperature=false` for those models; both `temperature` and `maxTokens` are omitted from the `ChatOpenAI` config.
- `customize()` callback on the OpenAI provider spec detects reasoning models by name and sets `supportsTemperature` + a longer timeout (60s).

### Per-role routing (`LLM_ROLE_CHAINS`)
- Env format: `"draft=google,deepseek;judge=groq,ollama"` (role=comma-separated provider names).
- Parsed in `onModuleInit()` into `roleChains: Map<string, string[]>`.
- When a request carries a `role` (e.g. `draft`, `hook`, `critique`, `judge`), the router uses that role's provider subset instead of the full chain.
- Example chains: `draft=anthropic,google,openai`, `hook=anthropic,google,openai`, `critique=groq,cerebras,sambanova` — routes creative tasks to stronger models, critique to fast free ones.

### AsyncLocalStorage for Langfuse callbacks
- `LlmService` uses a module-level `AsyncLocalStorage<LlmContext>` (`llmContextStorage`) to propagate Langfuse callbacks through the LangGraph workflow without threading them through every node function signature.
- `GenerationService` wraps `graph.invoke()` in `withLlmCallbacks(handler, fn)` — all `llm.generateChat()` calls inside graph nodes automatically read the ALS store and attach callbacks to `model.invoke()`.
- Async-safe for concurrent generation runs (up to 3 topics per batch) — each gets its own ALS context.
- Callers can also pass callbacks explicitly via `GenerateOptions.callbacks` — those are **merged** with ALS callbacks (deduped by reference).
- Callbacks are only attached when non-empty (avoids creating empty config objects).

### Global concurrency cap
- `LLM_MAX_CONCURRENT=4` (default) — prevents 429 cascades on free-tier providers when parallel graph branches fan out (3 topics × 3 networks × N nodes).
- Requests exceeding the cap wait in a `waiters` queue until an in-flight call completes.
