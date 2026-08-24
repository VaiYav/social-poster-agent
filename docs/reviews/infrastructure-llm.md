# Module: `infrastructure/llm`

## 1. What this module does

`infrastructure/llm` and its sibling packages (`infrastructure/langfuse`, `infrastructure/prompt`, and `infrastructure/util`) provide the backbone for all LLM interactions in the Social Poster Agent backend.

- **`LlmService`** (`llm.service.ts`) is a multi-provider, OpenAI-compatible LLM router. It builds a fallback chain from configured env vars, supports 15 providers, routes by role (`LLM_ROLE_CHAINS`), imposes a global concurrency cap, retries same-provider on 429, and tracks per-provider circuit breakers and rate-limit backoff.
- **Caching** is a 5-minute, SHA-256-keyed, in-memory response cache with FIFO eviction. Creative roles (`draft`, `hook`) bypass it.
- **Langfuse tracing** is propagated through `AsyncLocalStorage` (`callbackStorage`) and merged with explicit `callbacks` in `GenerateOptions`. The `withLlmCallbacks` wrapper lets `GenerationService` pass one `CallbackHandler` into a LangGraph workflow so every nested `llm.generateChat()` call is traced.
- **`LangfuseService`** and `langfuse-instrumentation.ts` initialize OTel tracing and provide a prompt-management client.
- **`PromptRegistry`** implements `IPromptPort` — a Langfuse Prompt Management facade with SDK-native fallback, then intermediate fallback providers, then inline local fallbacks using `{var}` → `{{var}}` (`toMustache`/`interpolate`).
- **`infrastructure/util`** supplies `language-detector.ts` (TinyLD + script heuristic), `script-check.ts` (post-generation script consistency), `with-timeout.ts` (promise timeout), and `sanitize-untrusted-input.ts` (prompt-injection sanitization).

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `infrastructure/llm/llm.service.ts` | Multi-provider LLM router | `LlmService` implements `ILlmPort` (`generate`, `generateChat`, `getProviderStatus`, `getPromptVersion`, `resetCircuitBreakers`, `clearCache`, `getCacheStats`); `withLlmCallbacks<T>` exported for ALS callback propagation |
| `infrastructure/llm/llm.module.ts` | NestJS module | `LlmModule` — providers `LlmService` and `{ provide: ILlmPort, useExisting: LlmService }` |
| `infrastructure/llm/llm-provider-rate-limit.ts` | Per-provider 429 backoff | `LlmProviderRateLimit` (`isAvailable`, `recordRateLimit`, `recordSuccess`, `reset`, `getStatus`, `parseRetryAfterMs`, `extractStatusCode`) |
| `infrastructure/llm/prompts/index.ts` | Re-export barrel | Re-exports `v0.4.0/engagement-decision.ts` |
| `infrastructure/llm/prompts/v0.4.0/engagement-decision.ts` | Engagement prompts, builders, parsers | `ENGAGEMENT_DECISION_SYSTEM_PROMPT`, `ENGAGEMENT_COMMENT_*`, `ENGAGEMENT_QUOTE_*`, `buildDecisionUserPrompt`, `buildBatchDecisionUserPrompt`, `parseDecisionResponse`, `parseBatchDecisionResponse`, `buildCommentUserPrompt`, `buildQuoteUserPrompt` |
| `infrastructure/llm/sanitize-untrusted-input.ts` | Prompt-injection sanitizer | `sanitizeUntrustedInput(text, maxLen?)` |
| `infrastructure/langfuse/langfuse.service.ts` | Langfuse facade | `LangfuseService` (`createHandler`, `getChatPrompt`, `getTextPrompt`, `onModuleDestroy`) |
| `infrastructure/langfuse/langfuse.module.ts` | Global module | `LangfuseModule` — provides `LangfuseService` and `LANGFUSE_PROMPT_BREAKER` circuit breaker |
| `infrastructure/langfuse/langfuse.tokens.ts` | DI token | `LANGFUSE_PROMPT_BREAKER` |
| `langfuse-instrumentation.ts` | OTel SDK init | `langfuseEnabled`, `shutdownLangfuse()`; runs at import time |
| `infrastructure/prompt/prompt-registry.ts` | Prompt Management facade | `PromptRegistry` implements `IPromptPort` (`getCompiledChat`, `getCompiledText`, `getCurrentVersion`); `toMustache`, `interpolate` helpers |
| `infrastructure/prompt/prompt-registry.module.ts` | Global module | `PromptRegistryModule` — binds `IPromptPort` to `PromptRegistry` |
| `infrastructure/util/language-detector.ts` | Language detection | `detectLanguage`, `isLanguageDetectable` |
| `infrastructure/util/script-check.ts` | Script validation | `matchesScript`, `normalizeLanguage` |
| `infrastructure/util/with-timeout.ts` | Promise timeout | `withTimeout<T>` |

## 3. How it works

### 3.1 `LlmService` provider chain

- `PROVIDER_DEFINITIONS` (`llm.service.ts:81-230`) lists 15 OpenAI-compatible providers: Groq, OpenRouter, DeepSeek, Cerebras, Anthropic, OpenAI, Google, NVIDIA, SambaNova, GitHub Models, xAI, Mistral, HuggingFace, Together, Cohere, and Ollama (keyless, last-resort).
- `buildProviderChain()` (`llm.service.ts:372-400`) includes a provider only when its API-key env var is set (or `alwaysInclude` is true for Ollama). It reads model names from provider-specific env vars and applies `defaultModel` fallbacks.
- `customize` on the OpenAI provider (`llm.service.ts:135-141`) detects reasoning models (`gpt-5`, `o1`, `o3`, `o4-mini`, `codex-mini`) via `REASONING_MODEL_PATTERN` (`llm.service.ts:75`) and sets `supportsTemperature=false` and `timeout=60s`.
- `orderedProviders()` (`llm.service.ts:482-509`) applies `LLM_ROLE_CHAINS` (format `role=provider1,provider2;...`) and otherwise uses a sticky `lastWorkingProvider` first.

### 3.2 Model factory and per-call parameters

- `getModelForProvider()` (`llm.service.ts:416-457`) caches `ChatOpenAI` instances keyed by `provider:name:model:temperature:maxTokens:timeout` to avoid the earlier race condition where shared models were mutated per call.
- `temperature` is resolved as `options?.temperature ?? provider.temperature` when `provider.supportsTemperature`, otherwise omitted.
- `maxTokens` is resolved as `options?.maxTokens ?? -1` when `provider.supportsTemperature`, otherwise `undefined`. For OpenAI reasoning models, `maxCompletionTokens` is set if `maxTokens` is defined.

### 3.3 `invokeWithFallback` execution flow

- `invokeWithFallback()` (`llm.service.ts:686-854`) checks the response cache, acquires a global concurrency slot (`LLM_MAX_CONCURRENT`, default 4), then loops through the ordered provider chain.
- For each provider it calls `isProviderAvailable()` (`llm.service.ts:571-588`) which combines the `LlmProviderRateLimit` penalty box and `LlmService` circuit breaker.
- Each provider gets up to two attempts (`maxAttempts=2`). If a 429 is detected, it waits for `Retry-After` (if ≤10s) or an exponential/jittered backoff, then retries the same provider; otherwise it fails over.
- `recordRateLimit()` / `recordSuccess()` update the rate-limit state; `recordFailure()` (`llm.service.ts:608-626`) increments the circuit breaker, tripping immediately on terminal (401/402/403) or after `LLM_CB_THRESHOLD` failures.
- On success it extracts token usage from `usage_metadata` (or estimates `chars/4`), returns `LlmResponse`, and caches the result if the role is cacheable.

### 3.4 Response cache

- `cacheKey()` (`llm.service.ts:639-649`) hashes `systemPrompt || userPrompt || t=<temperature>` with SHA-256 and returns the first 32 hex characters.
- `getFromCache()` (`llm.service.ts:654-663`) deletes expired entries and returns the cached `LlmResponse`.
- `setInCache()` (`llm.service.ts:669-679`) stores with TTL `LLM_CACHE_TTL_MS` (default 5 min) and FIFO-evicts when `LLM_CACHE_MAX_SIZE` (default 100) is exceeded.
- `cacheable` is `false` for `role='draft'` and `role='hook'` so creative prompts always produce fresh output.

### 3.5 Langfuse callback propagation

- `callbackStorage` is a module-level `AsyncLocalStorage<BaseCallbackHandler[]>` (`llm.service.ts:245`).
- `withLlmCallbacks(callbacks, fn)` (`llm.service.ts:256-258`) stores the callbacks in ALS and runs `fn`.
- `generateChat()` (`llm.service.ts:856-862`) merges `callbackStorage.getStore()` with `options.callbacks`, deduplicates by reference, and passes them to `model.invoke(messages, { callbacks })` only when non-empty.

### 3.6 `LangfuseService` and tracing setup

- `langfuse-instrumentation.ts` (`packages/backend/src/langfuse-instrumentation.ts:59-96`) is imported at the top of `main.ts`. When `LANGFUSE_PUBLIC_KEY` is set it creates an isolated `BasicTracerProvider` with a `LangfuseSpanProcessor` and calls `setLangfuseTracerProvider()` so Sentry and Langfuse tracing stay separate.
- `LangfuseService` (`langfuse.service.ts`) constructs a `LangfuseClient` when `LANGFUSE_PUBLIC_KEY` is set, otherwise it is a no-op (`isEnabled=false`).
- `createHandler()` returns a `@langfuse/langchain` `CallbackHandler` per trace/session.
- `getChatPrompt()` / `getTextPrompt()` fetch prompts from Langfuse Prompt Management with `label='production'`, `cacheTtlSeconds=300`, `fetchTimeoutMs=3000`, `maxRetries=1`, and the optional `fallback` content. The calls are wrapped in a `CircuitBreaker` (`LANGFUSE_PROMPT_BREAKER`, 3 failures → 1 min cooldown).
- `onModuleDestroy()` calls `shutdownLangfuse()` to flush queued traces.

### 3.7 `PromptRegistry` fallback chain

- `getCompiledChat()` (`prompt-registry.ts:73-123`) and `getCompiledText()` (`prompt-registry.ts:135-175`) implement the same three-tier fallback:
  1. Try `LangfuseService` with SDK-native `fallback`.
  2. Iterate injected `PROMPT_FALLBACK_PROVIDERS`.
  3. Call `interpolate()` on the caller-supplied inline fallback.
- `toMustache()` (`prompt-registry.ts:198-200`) converts local `{var}` syntax to Mustache `{{var}}` before passing to the Langfuse SDK.
- `interpolate()` (`prompt-registry.ts:185-191`) replaces `{var}` with the supplied values for local fallback content.
- `getCurrentVersion()` (`prompt-registry.ts:50-52`) returns the `PROMPT_VERSION` env var (default `latest`), used only for metadata; the actual Langfuse label is hardcoded to `production`.

### 3.8 Utilities

- `detectLanguage()` (`language-detector.ts:53-75`) uses `tinyld.detect`, maps to the SPA-supported set `en/ru/uk/es/it`, and falls back to a script/character heuristic.
- `isLanguageDetectable()` (`language-detector.ts:82-87`) returns true when the text has at least 3 Cyrillic or ASCII Latin characters.
- `matchesScript()` (`script-check.ts:49-73`) checks that generated text contains enough of the expected script (Cyrillic for `ru`/`uk`, Latin for `en`/`es`/`it`) and that the wrong script does not dominate.
- `sanitizeUntrustedInput()` (`sanitize-untrusted-input.ts:27-38`) strips control characters, collapses whitespace, neutralizes common instruction-override phrases and role markers, replaces quotes with single quotes, and truncates to `maxLen`.
- `withTimeout()` (`with-timeout.ts:10-18`) races a promise against a `setTimeout` that is `unref()`-ed so it does not keep the process alive.

## 4. Dependencies

**Downstream (called by this module):**
- `@langchain/openai` `ChatOpenAI`
- `@langfuse/langchain` `CallbackHandler`
- `@langfuse/client` `LangfuseClient`
- `@langfuse/otel` `LangfuseSpanProcessor` and `@langfuse/tracing` `setLangfuseTracerProvider`
- `tinyld` for language detection
- `node:async_hooks` `AsyncLocalStorage`
- `node:crypto` `createHash`
- Domain ports: `ILlmPort`, `IPromptPort`, `BaseCallbackHandler`
- `ConfigService` for env vars

**Upstream (callers of this module):**
- `modules/generation/generation.service.ts` — wraps `graph.invoke()` with `withLlmCallbacks`; injects `IPromptPort`
- `modules/generation/generation.graph.ts` — calls `llm.generateChat` in every node (research, hook, draft, critique, refine, judge)
- `modules/engagement/engagement-decision.service.ts` — calls `llm.generateChat` and uses `detectLanguage`, `matchesScript`, `normalizeLanguage`, and the `v0.4.0` engagement parsers
- `modules/orchestrator/llm-decision.service.ts` — calls `llm.generateChat` and fetches `orchestrator-system` via `IPromptPort`
- `modules/replies/replies-monitor.service.ts` — calls `llm.generateChat` and uses `sanitizeUntrustedInput`
- `modules/trending/trending-scraper.service.ts` and `modules/content-enhancements/*` — call `llm.generateChat`
- `modules/autonomy/autonomous-runner.service.ts` and `dry-run/*.cli.ts` indirectly trigger `GenerationService`

## 5. Environment variables

| Variable | Default | Purpose | Where used |
|----------|---------|---------|------------|
| `OPENAI_API_KEY` | `''` | OpenAI API key | `llm.service.ts:132` |
| `OPENAI_MODEL` | `gpt-5-nano` | OpenAI model | `llm.service.ts:134`, `.env.example:55` |
| `ANTHROPIC_API_KEY` | `''` | Anthropic API key | `llm.service.ts:121` |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5` | Anthropic model | `llm.service.ts:123` |
| `GROQ_API_KEY` / `GROQ_MODEL` | `''` / `llama-3.3-70b-versatile` | Groq | `llm.service.ts:85-88` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | `''` / `meta-llama/...:free` | OpenRouter | `llm.service.ts:92-97` |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | `''` / `deepseek-chat` | DeepSeek | `llm.service.ts:100-105` |
| `CEREBRAS_API_KEY` / `CEREBRAS_MODEL` | `''` / `gpt-oss-120b` | Cerebras | `llm.service.ts:110-115` |
| `SAMBANOVA_API_KEY` / `SAMBANOVA_MODEL` | `''` / `Meta-Llama-3.3-70B-Instruct` | SambaNova | `llm.service.ts:162-167` |
| `GITHUB_TOKEN` / `GITHUB_MODEL` | `''` / `meta-llama/Llama-3.3-70B-Instruct` | GitHub Models | `llm.service.ts:171-176` |
| `XAI_API_KEY` / `XAI_MODEL` | `''` / `grok-4.1-fast` | xAI | `llm.service.ts:180-184` |
| `MISTRAL_API_KEY` / `MISTRAL_MODEL` | `''` / `mistral-small-latest` | Mistral | `llm.service.ts:189-193` |
| `HF_TOKEN` / `HF_MODEL` | `''` / `meta-llama/Llama-3.3-70B-Instruct` | HuggingFace | `llm.service.ts:198-202` |
| `TOGETHER_API_KEY` / `TOGETHER_MODEL` | `''` / `meta-llama/...-Turbo-Free` | Together AI | `llm.service.ts:207-211` |
| `COHERE_API_KEY` / `COHERE_MODEL` | `''` / `command-r7b` | Cohere | `llm.service.ts:216-220` |
| `OLLAMA_URL` / `OLLAMA_DEFAULT_MODEL` | `http://localhost:11434` / `gemma4` | Ollama local | `llm.service.ts:226` |
| `LLM_DEFAULT_MODEL` | `gpt-5-nano` | **Declared but unused** | `env.validation.ts:51` |
| `LLM_ROLE_CHAINS` | `''` | Per-role provider ordering | `llm.service.ts:332-333`, `464-474` |
| `LLM_MAX_CONCURRENT` | `4` | Global concurrency cap | `llm.service.ts:325` |
| `LLM_RATE_LIMIT_RETRY_MS` | `2500` | Same-provider 429 retry delay | `llm.service.ts:326` |
| `LLM_CB_THRESHOLD` | `3` | Failures before circuit opens | `llm.service.ts:318` |
| `LLM_CB_COOLDOWN_MS` | `60000` | Transient breaker cooldown | `llm.service.ts:319` |
| `LLM_CB_TERMINAL_COOLDOWN_MS` | `6h` | Auth/billing breaker cooldown | `llm.service.ts:322` |
| `LLM_CACHE_TTL_MS` | `300000` | Response cache TTL | `llm.service.ts:323` |
| `LLM_CACHE_MAX_SIZE` | `100` | Response cache max entries | `llm.service.ts:324` |
| `LLM_RATE_LIMIT_*` | see `.env.example` | Per-provider 429 backoff knobs | `llm-provider-rate-limit.ts:43-49` |
| `GENERATION_TEMPERATURE_HOOK` | `0.95` | Hook temperature | `generation.graph.ts` |
| `GENERATION_TEMPERATURE_DRAFT` | `0.8` | Draft temperature | `generation.graph.ts` |
| `GENERATION_TEMPERATURE_REFINE` | `0.6` | Refine temperature | `generation.graph.ts` |
| `REPLIES_TEMPERATURE` | `0.6` | Replies temperature | `replies-monitor.service.ts` |
| `ENGAGEMENT_COMMENT_TEMPERATURE` | `0.8` | Comment temperature | `engagement-decision.service.ts` |
| `ENGAGEMENT_QUOTE_TEMPERATURE` | `0.8` | Quote temperature | `engagement-decision.service.ts` |
| `LANGFUSE_PUBLIC_KEY` | `''` | Auto-enable Langfuse | `langfuse.service.ts:58`, `langfuse-instrumentation.ts:59` |
| `LANGFUSE_SECRET_KEY` | `''` | Langfuse secret | `langfuse.service.ts:74` |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` in code, `https://us.cloud.langfuse.com` in `.env.example` | Langfuse endpoint | `langfuse.service.ts:75`, `langfuse-instrumentation.ts:83` |
| `PROMPT_VERSION` | `latest` | Metadata-only prompt version | `prompt-registry.ts:42`, `prompt-registry.ts:50-52` |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `LLM_DEFAULT_MODEL` is declared but never used.**
`env.validation.ts:51` defines `LLM_DEFAULT_MODEL` with default `gpt-5-nano`, but `LlmService` ignores it. The OpenAI provider uses `OPENAI_MODEL` (`llm.service.ts:134`). If an operator sets `LLM_DEFAULT_MODEL` expecting it to control the default model, nothing happens.

**B2. Reasoning-model handling in `getModelForProvider` is incomplete and has a dead `maxCompletionTokens` branch.**
`llm.service.ts:416-457` sets `maxTokens = undefined` whenever `provider.supportsTemperature` is false (`llm.service.ts:422-424`). The OpenAI `customize` hook sets `supportsTemperature=false` for `gpt-5`, `o1`, `o3`, `o4-mini`, and `codex-mini` (`llm.service.ts:135-141`). Then `if (isOpenAIReasoning && maxTokens !== undefined)` (`llm.service.ts:440-443`) is always false because `maxTokens` is `undefined` for reasoning. Consequently there is no way to pass `max_completion_tokens` to a reasoning model, even when the caller sets `maxTokens`.

**B3. `ChatOpenAI` reasoning detection is narrower than `LlmService`'s pattern.**
LangChain's internal `ChatOpenAI` reasoning-model detection appears to be narrower than `LlmService.REASONING_MODEL_PATTERN` (`llm.service.ts:75`). The service marks `gpt-5*`, `o4-mini`, and `codex-mini` as reasoning models and suppresses `temperature`/`maxTokens`, but it is not verified that LangChain's driver auto-converts `system` to `developer` messages or uses `max_completion_tokens` for these newer OpenAI model families. This mismatch can produce wrong API parameters for reasoning models. (The exact LangChain source lines are in `node_modules` and should be re-checked when the package is upgraded.)

**B4. Response cache key does not include `maxTokens`, provider/model, or `role`.**
`cacheKey()` (`llm.service.ts:639-649`) hashes only `systemPrompt`, `userPrompt`, and a temperature-normalized string. The same prompt called with `maxTokens: 700` vs `maxTokens: 100` produces the same key and may return the wrong-length response. It also does not include the provider/model, so the same prompt resolved through different providers can share a cache entry (e.g., `role='facts'` first hits `google` then `groq`). The `model` field in a cached `LlmResponse` may then misattribute the actual source.

**B5. Cache key normalizes `temperature=0` and `temperature=undefined` both to `'reasoning'`.**
`llm.service.ts:646-647` treats `temp === 0 || temp === undefined` as `reasoning`. A non-reasoning model called with `temperature: 0` collides with a reasoning model called without temperature for the same prompt. Combined with B4, this can cache a reasoning-style output and serve it for a deterministic, temperature-0 call.

**B6. `LLM_RATE_LIMIT_STRIKE_THRESHOLD=0` makes the strike penalty fire on every 429.**
`llm-provider-rate-limit.ts:47` calls `readConfigNumber('LLM_RATE_LIMIT_STRIKE_THRESHOLD', 3, { allowZero: true })`. The helper (`llm-provider-rate-limit.ts:195-201`) returns `0` when `opts.allowZero` is true and `n >= 0`. Then `recordRateLimit()` (`llm-provider-rate-limit.ts:80-82`) checks `state.strikeHistory.length >= 0`, which is always true, so any 429 immediately triggers the 30-minute `strikePenaltyMs`. The intent was likely to allow disabling the penalty, not to make it always fire.

**B7. `getAvailableModels()` misclassifies most paid providers as free.**
`llm.service.ts:360-366` returns `free: p.name !== 'openai' && p.name !== 'anthropic'`. Google, NVIDIA, xAI, Mistral, Together, Cohere, HuggingFace, and GitHub Models may be paid or quota-limited but are reported as `free`. This would mislead a UI model picker.

**B8. `LangfuseService` and `langfuse-instrumentation.ts` default to `https://cloud.langfuse.com` while `.env.example` and docs say US.**
`langfuse.service.ts:75` and `langfuse-instrumentation.ts:83` default to the EU `https://cloud.langfuse.com`. `.env.example:418` and `AGENTS.md` say the default is `https://us.cloud.langfuse.com`. If `LANGFUSE_BASE_URL` is omitted, the backend will export to the wrong region.

**B9. `CallbackHandler` may not honor `LANGFUSE_BASE_URL` for tracing.**
`LangfuseService.createHandler()` (`langfuse.service.ts:92-110`) constructs `new CallbackHandler({ ... })` without passing `baseUrl`. The `@langfuse/langchain` SDK may read from env vars, but the prompt client uses the explicit `baseUrl` set in `LangfuseService`. If `LANGFUSE_BASE_URL` is set to a self-hosted instance, traces and prompt fetches could diverge to different endpoints.

**B10. `PromptRegistry` only preserves the first `system` and `user` messages from a compiled chat prompt.**
`prompt-registry.ts:91-95` filters `compiled` with `isChatMessage()` and returns the first `system` and `user` messages. If a Langfuse chat prompt contains more than two messages (e.g., few-shot examples or a `developer` message), the extra messages are silently discarded. The `CompiledChatPrompt` type itself only supports `systemPrompt` + `userPrompt`.

**B11. `PROMPT_VERSION` env var only affects metadata, not the fetched Langfuse label.**
`prompt-registry.ts:42` reads `PROMPT_VERSION` (default `latest`) and `getCurrentVersion()` returns it. However, `LangfuseService.getChatPrompt()` and `getTextPrompt()` hardcode `label: 'production'` (`langfuse.service.ts:130`, `162`). So setting `PROMPT_VERSION=latest` does not change which Langfuse label is fetched; it only changes `llmMetadata.promptVersion`.

**B12. `sanitizeUntrustedInput` is not used in engagement or generation prompt builders.**
`sanitize-untrusted-input.ts` is only imported in `replies-monitor.service.ts:39` (`grep` confirmed). The engagement builders in `engagement-decision.ts` (`buildDecisionUserPrompt`, `buildBatchDecisionUserPrompt`, `buildCommentUserPrompt`, `buildQuoteUserPrompt`) and the inline fallbacks in `generation.graph.ts` directly interpolate scraped `postText`, `authorHandle`, `comment.text`, etc. without sanitization. This leaves an open prompt-injection vector.

**B13. JSON parsers in `engagement-decision.ts` do not strip markdown fences and use greedy regex.**
`parseDecisionResponse()` (`engagement-decision.ts:364-392`) and `parseBatchDecisionResponse()` (`engagement-decision.ts:236-278`) use `/{[\s\S]*}/` and `/\[[\s\S]*\]/` respectively. If the model wraps the JSON in a markdown code block, the first `{` or `[` may be inside the fence and the last `}` or `]` may be inside or after the fence; `JSON.parse` can fail. It also over-matches if the response contains multiple JSON objects or nested arrays. They should strip markdown fences and use a JSON/Zod parser.

**B14. `heuristicFallback()` in `language-detector.ts` defaults Latin-script text to English.**
`language-detector.ts:32-45` returns `en` for any Latin text that TinyLD cannot classify. Short Spanish or Italian posts may therefore be misreported as English, causing the LLM to generate English comments on non-English posts. The function has no `es`/`it` fallback path.

**B15. `script-check.ts` only counts ASCII Latin letters.**
`script-check.ts:24-25` defines `LATIN_RE = /[a-zA-Z]/g`. Spanish/Italian text contains diacritics (`á`, `ñ`, `è`, `ì`, etc.) that are not counted, so `matchesScript()` may undercount Latin characters and incorrectly flag valid `es`/`it` output. `CYRILLIC_RE` is similarly narrow but Cyrillic is more block-consistent.

**B16. `withTimeout` does not cancel the underlying operation.**
`with-timeout.ts:10-18` only rejects the caller; it does not pass an `AbortSignal` or otherwise stop the promise. If the underlying operation is a hanging LLM socket call, it continues in the background, consuming resources and potentially charging tokens. `LlmDecisionService` (`llm-decision.service.ts:69-76`) uses `Promise.race` with the same limitation, leaving a dangling `generateChat()` promise.

**B17. `LlmService` logs a partial OpenAI API key at startup.**
`llm.service.ts:347-350` logs `key=${openaiKey.slice(0, 10)}...${openaiKey.slice(-4)}`. Even a partial API key leak in logs is a security risk and should be removed.

**B18. `GenerateOptions.systemPrompt` is ignored.**
`domain/ports/llm.port.ts:16-18` declares `systemPrompt?: string` in `GenerateOptions`, but `LlmService.generateChat()` uses the positional `systemPrompt` argument and never reads `options.systemPrompt`. This is confusing and could lead callers to supply the system prompt in the wrong place.

**B19. `LlmService` `maxConcurrent` cannot be set to `0`.**
`llm.service.ts:325` uses `Number(...) || 4`, so `LLM_MAX_CONCURRENT=0` becomes `4` rather than disabling the cap.

**B20. `parseRetryAfterMessage` does not match common "try again after X" wording.**
`llm-provider-rate-limit.ts:297-299` requires the phrase `\b(?:try again|retry after|try back)\s+in\s+...`. Messages like `"try again after 5 minutes"` (without `in`) are not matched, so a provider-supplied retry hint is missed and the exponential fallback is used instead.

### 6.2 Performance

**P1. Response cache is in-process and not shared.**
`llm.service.ts:289` uses a `Map` local to the `LlmService` instance. In a multi-instance deployment, each process independently calls the LLM for the same prompts. A shared Redis-backed cache would dedupe across workers.

**P2. Cache eviction is FIFO, not LRU.**
`setInCache()` (`llm.service.ts:669-679`) evicts the first inserted key. A frequently hit entry can be evicted while a one-time entry remains, reducing hit rate.

**P3. `getModelForProvider` cache can grow with rare `temperature`/`maxTokens` combinations.**
Each unique `provider:model:temperature:maxTokens:timeout` combo creates a new `ChatOpenAI` instance. With many `LLM_ROLE_CHAINS` and per-call `temperature`/`maxTokens` values, the map grows unbounded until process restart. In practice the count is modest, but there is no cap.

**P4. `LlmService` holds the concurrency semaphore for the entire fallback walk.**
`acquireSlot()` is called once before the provider loop and released in `finally` (`llm.service.ts:712-849`). This means the slot is occupied during same-provider 429 retries and sleeps, serializing more work than necessary. A more granular design would acquire a slot per provider attempt.

**P5. `LlmProviderRateLimit` parses error messages with regexes on every failure.**
`parseRetryAfterMs()` runs multiple `match`/`parse` steps on each error. This is negligible for HTTP errors but could be optimized if it becomes hot.

### 6.3 Architecture / anti-patterns

**A1. `LlmService` is a 930-line god class.**
It mixes provider registry, model factory, concurrency semaphore, circuit breaker, rate-limit backoff, response cache, token usage extraction, callback merging, and prompt version metadata. The file is approaching the size of the orchestrator service and would benefit from extracting `ProviderChain`, `ResponseCache`, `ModelFactory`, and `RateLimitBackoff` services.

**A2. Provider list is hard-coded.**
`PROVIDER_DEFINITIONS` (`llm.service.ts:81-230`) requires a code change to add or remove a provider. A dynamic JSON/env-driven registry would reduce churn as provider landscape changes.

**A3. `langfuse-instrumentation.ts` is a side-effect file imported for initialization.**
`packages/backend/src/langfuse-instrumentation.ts` runs at import time and is imported at the top of `main.ts`. It reads `process.env` directly before `ConfigService`/`validateEnv` and uses `console` for logging. This is fine for bootstrapping, but it is a separate lifecycle from `LangfuseModule` and is harder to mock in tests.

**A4. `PromptRegistry` duplicates the same fallback ladder twice.**
`getCompiledChat()` and `getCompiledText()` (`prompt-registry.ts:73-175`) are nearly identical. A shared helper would reduce drift and make the fallback logic easier to audit.

**A5. `withTimeout` is a generic utility but has no cancellation contract.**
`with-timeout.ts:10-18` rejects the caller but leaves the operation running. Callers must pass an `AbortSignal`-aware function for true cancellation; otherwise it is only a "give up" wrapper.

**A6. `LLM_DEFAULT_MODEL` dead config is an architecture smell.**
It is declared in `env.validation.ts` and `.env.example` does not list it, but the code never uses it. It should either be wired in or removed.

### 6.4 TypeScript / type safety

**T1. `getModelForProvider` uses an `any`-style `Record<string, unknown>` and a type assertion.**
`llm.service.ts:429-453` builds `ctorArgs: Record<string, unknown>` and casts it to `ConstructorParameters<typeof ChatOpenAI>[0]`. The field typing could be made precise with `ChatOpenAIInput` or an explicit `maxCompletionTokens` union, avoiding the `as` cast.

**T2. `engagement-decision.ts` parsers use `as` casts without schema validation.**
`parseDecisionResponse()` and `parseBatchDecisionResponse()` (`engagement-decision.ts:236-392`) cast parsed JSON to `Partial<ActionDecision>` and `ActionDecision`. `confidence` is not validated to be a number in range, `action` is only checked against a string array, and `reason`/`commentText` are unchecked. A Zod schema would catch malformed LLM output and provide a cleaner fallback.

**T3. `GenerateOptions` includes `systemPrompt` that is never consumed.**
`domain/ports/llm.port.ts:17` adds `systemPrompt?: string` to `GenerateOptions`, but `LlmService` ignores it. The interface and implementation are out of sync.

**T4. `prompt-registry.module.ts` has an inconsistent import extension.**
`prompt-registry.module.ts:3` imports `PromptRegistry` from `'./prompt-registry'` without the `.js` extension used elsewhere in the backend (e.g., `prompt-registry.ts` uses `../langfuse/langfuse.service.js`). This is the only infra module import that omits the extension and could cause ESM issues.

**T5. `isChatMessage` uses `in` operator on `unknown` after `typeof` check.**
`prompt-registry.ts:208-216` is safe because of `typeof msg === 'object' && msg !== null`, but a helper like `Object.prototype.hasOwnProperty.call` would be more robust for inherited properties.

### 6.5 Security / reliability

**S1. API key material is logged.**
See B17. `llm.service.ts:347-350` logs `OPENAI_API_KEY` partially. Should be removed entirely.

**S2. Prompt injection sanitization is not applied consistently.**
See B12. The sanitizer exists but is only used in `replies-monitor.service.ts`. Any scraped text interpolated into prompts (post text, comments, trends, author handles) in engagement and generation should pass through `sanitizeUntrustedInput`.

**S3. `LangfuseService` may export to the wrong base URL.**
See B8 and B9. The prompt client and the OTel instrumentation may disagree on `baseUrl`, and the `CallbackHandler` may not use the configured `LANGFUSE_BASE_URL` at all.

**S4. Response cache may retain sensitive user content.**
The cache key is the SHA-256 of the prompt text. If prompts contain user comments or scraped content (e.g., replies), that content is hashed and the full response is cached in memory for 5 minutes. This is acceptable for a single-process backend but should be documented and avoided for PII-heavy prompts.

**S5. `LlmService` does not support cancellation, leaving dangling requests on timeout.**
`ILlmPort` has no `signal`/`AbortController` parameter. `LlmDecisionService` and `withTimeout` consumers can abandon a promise, but the LLM HTTP request continues and may still consume tokens and trigger Langfuse traces.

**S6. `LLM_DEFAULT_MODEL` dead config is a reliability foot-gun.**
An operator may set `LLM_DEFAULT_MODEL` expecting it to apply, but the system ignores it and silently falls back to `OPENAI_MODEL` for OpenAI. This could cause silent model drift during incident response.

## 7. New feature / improvement ideas

1. **Fix reasoning-model support.** Pass `maxTokens` to `ChatOpenAI` as `maxCompletionTokens` for `gpt-5`/`o1`/`o3`/`o4-mini`/`codex-mini`, and align `LlmService`'s reasoning detection with what `ChatOpenAI` actually supports. Convert `system` messages to `developer` where required.
2. **Complete the response cache key.** Add `maxTokens`, provider/model, and `role` to `cacheKey()` so different token limits, providers, and roles do not collide. Consider a shared Redis cache for multi-instance deployments.
3. **Add `AbortSignal`/`AbortController` support to `ILlmPort` and `LlmService`.** Plumb an optional `signal` through `GenerateOptions` so `LlmDecisionService` and `withTimeout` callers can truly cancel in-flight requests.
4. **Apply `sanitizeUntrustedInput` to every prompt builder.** Sanitize scraped `postText`, `comment.text`, `authorHandle`, trending topics, and CAP content before interpolation in engagement and generation prompts.
5. **Harden JSON response parsing.** Replace greedy `/{[\s\S]*}/` and `/\[[\s\S]*\]/` with markdown-fence stripping and a Zod schema for `ActionDecision` and batch arrays.
6. **Align Langfuse base URL defaults and explicit `CallbackHandler` configuration.** Use `https://us.cloud.langfuse.com` consistently (matching `.env.example` and docs) and pass `baseUrl` to the `CallbackHandler` so self-hosted endpoints are honored.
7. **Remove or wire `LLM_DEFAULT_MODEL`.** Either delete it from `env.validation.ts` or make it the default for `OPENAI_MODEL` (or another provider) when that provider-specific env is empty.
8. **Make `PROMPT_VERSION` actually control the Langfuse label, or rename it.** If `PROMPT_VERSION` is only metadata, rename it to `PROMPT_METADATA_VERSION` and document that the fetched label is `production`.
9. **Support more than two chat messages or document the limitation.** If Langfuse chat prompts ever contain few-shot examples, `PromptRegistry` will silently drop them. Either update `CompiledChatPrompt` or log a warning when extra messages are discarded.
10. **Refactor `LlmService` into smaller services.** Split `ProviderChain`, `ResponseCache`, `ModelFactory`, and `RateLimitBackoff` to make the 930-line router testable and maintainable.

## 8. Cross-references

- `modules/generation/generation.service.ts` — calls `withLlmCallbacks` and `llm.generateChat`; injects `IPromptPort` and `LangfuseService`
- `modules/generation/generation.graph.ts` — calls `llm.generateChat` in `research_extract`, `hook_generation`, `draft_*`, `critique_*`, `refine_*`, `judge_*` nodes; uses `promptPort.getCompiledChat`/`getCompiledText` with inline fallbacks
- `modules/engagement/engagement-decision.service.ts` — calls `llm.generateChat`, uses `detectLanguage`, `matchesScript`, `normalizeLanguage`, and the `v0.4.0` engagement parsers
- `modules/orchestrator/llm-decision.service.ts` — calls `llm.generateChat` with timeout and fetches `orchestrator-system` via `IPromptPort`
- `modules/replies/replies-monitor.service.ts` — calls `llm.generateChat` and uses `sanitizeUntrustedInput`
- `modules/trending/trending-scraper.service.ts` — calls `llm.generateChat` for trend summarization
- `modules/content-enhancements/trend-guardrail.ts`, `ab-variant.generator.ts`, `visual-concept.service.ts`, `thread-depth.controller.ts` — call `llm.generateChat`
- `modules/autonomy/autonomous-runner.service.ts`, `dry-run/live-run.cli.ts`, `dry-run/dry-runner.ts` — drive `GenerationService` and thus the LLM router
- `packages/backend/src/langfuse-instrumentation.ts` — imported by `main.ts`; initializes the isolated Langfuse OTel tracer
- `app.module.ts` — imports `LlmModule`, `LangfuseModule`, `PromptRegistryModule`

## 9. Overall assessment

**Health score: 7 / 10**

The LLM infrastructure is robust and well-instrumented: a 15-provider fallback chain, per-provider circuit breakers and rate-limit backoff, a fast 5-minute response cache, Langfuse tracing via `AsyncLocalStorage`, and a clean `PromptRegistry` facade for Langfuse Prompt Management. The provider ordering and concurrency controls are deliberate responses to real free-tier 429 cascades.

However, several correctness issues affect day-to-day operation: the response cache key is incomplete and can return wrong-length or wrong-attributed responses, reasoning-model handling has a dead `maxCompletionTokens` branch and a mismatch with LangChain's detection, `LLM_DEFAULT_MODEL` is dead config, `LANGFUSE_BASE_URL` defaults are inconsistent, API key material is logged, prompt sanitization is not applied consistently, and `withTimeout`/race timeouts do not cancel in-flight requests. The JSON parsers in the engagement prompts are also fragile and could fail when models wrap output in markdown fences.

**Top recommended next actions:**

1. Fix the response cache key to include `maxTokens`, provider/model, and `role` to prevent stale or cross-model cache hits.
2. Correct reasoning-model parameter handling in `getModelForProvider` so `maxTokens` is mapped to `maxCompletionTokens` and `gpt-5`/`o4-mini` are handled consistently with LangChain.
3. Apply `sanitizeUntrustedInput` to all engagement and generation prompt builders that interpolate scraped or external text.
4. Align Langfuse base URL defaults to `https://us.cloud.langfuse.com` and pass `baseUrl` to the `CallbackHandler`.
5. Remove or wire `LLM_DEFAULT_MODEL`; stop logging partial API keys in `LlmService.onModuleInit`.
6. Add `AbortSignal` support to `ILlmPort`/`LlmService` so timeouts truly cancel requests.
7. Harden `parseDecisionResponse` and `parseBatchDecisionResponse` to strip markdown fences and validate with a Zod schema.
