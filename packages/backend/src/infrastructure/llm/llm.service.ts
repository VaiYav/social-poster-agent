import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ILlmPort, GenerateOptions, LlmResponse } from '../../domain/ports/llm.port.js';
import { PromptRegistry } from './prompt-registry.js';
import { LangfuseService } from '../langfuse/langfuse.service.js';

/**
 * Provider definition — each provider is tried in order until one succeeds.
 * All providers expose an OpenAI-compatible API, so ChatOpenAI works for all.
 */
interface LlmProviderConfig {
  name: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  temperature: number;
  /**
   * Whether this provider/model accepts a `temperature` parameter.
   * OpenAI reasoning models (gpt-5-nano, o1, o3, etc.) reject temperature
   * with HTTP 400 — only the default (1) is supported. Set to false for
   * those models so we skip sending temperature entirely.
   */
  supportsTemperature: boolean;
}

/**
 * Sprint J: Circuit breaker state per provider.
 * Tracks consecutive failures and cooldown period.
 */
interface CircuitBreakerState {
  failures: number;
  lastFailureAt: number;
  tripped: boolean;
  /** Set when the last failure was a terminal (auth/billing) error — see recordFailure(). */
  terminal: boolean;
}

/** Sprint J: Cache entry for content caching. */
interface CacheEntry {
  response: LlmResponse;
  expiresAt: number;
}

/**
 * AsyncLocalStorage for ambient Langfuse callback propagation.
 *
 * Generation runs invoke the LangGraph workflow which calls llm.generateChat()
 * many times across parallel per-network branches. Rather than threading
 * callback handlers through every graph node function signature, we store
 * them in ALS at the graph.invoke() boundary (GenerationService) and read
 * them here. This is async-safe: concurrent generation runs (up to 3 topics
 * per batch) each get their own ALS context.
 *
 * Callers can also pass callbacks explicitly via GenerateOptions.callbacks —
 * those are merged with the ALS callbacks (deduped by reference).
 */
const callbackStorage = new AsyncLocalStorage<BaseCallbackHandler[]>();

/**
 * Run a function with ambient Langfuse callbacks in AsyncLocalStorage.
 * All llm.generateChat()/generate() calls within `fn` (including those deep
 * inside LangGraph nodes) will automatically attach these callbacks to their
 * model.invoke() calls, nesting the LLM observations under the graph trace.
 *
 * Exported so GenerationService can wrap graph.invoke() without threading
 * callbacks through every node function signature.
 */
export function withLlmCallbacks<T>(callbacks: BaseCallbackHandler[], fn: () => Promise<T>): Promise<T> {
  return callbackStorage.run(callbacks, fn);
}

/**
 * LLM service — multi-provider fallback router.
 *
 * Reuses the same API keys as content-agent-platform (OQ-6 resolved).
 * Provider chain (FREE-FIRST, matching CAP's cheap-tier strategy):
 *   1. Groq (FREE, fast — llama-3.3-70b)
 *   2. OpenRouter FREE (meta-llama/llama-3.3-70b-instruct:free)
 *   3. DeepSeek (cheap — deepseek-chat)
 *   4. Cerebras (FREE, fast — llama-3.3-70b)
 *   5. OpenAI (gpt-5-nano — paid overflow)
 *   6. Ollama local (gemma4 — last resort, no API key needed)
 *
 * Implements ILlmPort for testability — unit tests inject a mock ILlmPort.
 * LangGraph workflow is in modules/generation/generation.service.ts.
 */
@Injectable()
export class LlmService implements ILlmPort, OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private providers: LlmProviderConfig[] = [];
  private models: Map<string, ChatOpenAI> = new Map();
  private lastWorkingProvider: string | null = null;

  // Sprint J: Circuit breaker — per-provider failure tracking
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();
  private readonly cbThreshold: number; // failures before tripping
  private readonly cbCooldownMs: number; // cooldown after tripping (transient failures)
  private readonly cbTerminalCooldownMs: number; // cooldown after a terminal (401/402/403) failure

  // Sprint J: Response cache — avoids re-calling LLM for identical prompts
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly cacheMaxSize: number;

  // Sprint J: Prompt version — bumped when prompts change, stored in llmMetadata
  // Sprint P: Now sourced from PromptRegistry when available, falls back to static constant
  static readonly PROMPT_VERSION = '0.4.0-sprint-j';

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly promptRegistry?: PromptRegistry,
    @Optional() private readonly langfuse?: LangfuseService,
  ) {
    this.cbThreshold = this.configService.get<number>('LLM_CB_THRESHOLD', 3);
    this.cbCooldownMs = this.configService.get<number>('LLM_CB_COOLDOWN_MS', 60_000);
    // Auth/billing errors (401/402/403) are permanent until a human acts (rotate a key, top up
    // balance) — retrying every cbCooldownMs just repeats the same failure. Default 6h.
    this.cbTerminalCooldownMs = this.configService.get<number>('LLM_CB_TERMINAL_COOLDOWN_MS', 6 * 60 * 60 * 1000);
    this.cacheTtlMs = this.configService.get<number>('LLM_CACHE_TTL_MS', 300_000); // 5 min
    this.cacheMaxSize = this.configService.get<number>('LLM_CACHE_MAX_SIZE', 100);
  }

  onModuleInit(): void {
    this.providers = this.buildProviderChain();

    if (this.providers.length === 0) {
      this.logger.warn('No LLM providers configured — LLM generation will fail');
      return;
    }

    const summary = this.providers
      .map((p) => `${p.name}/${p.model}`)
      .join(' → ');
    this.logger.log(`LLM provider chain (${this.providers.length}): ${summary}`);
  }

  /**
   * List available LLM models for UI model picker (F3).
   * Returns provider name, model id, and whether it's free or paid.
   */
  getAvailableModels(): Array<{ provider: string; model: string; free: boolean }> {
    return this.providers.map((p) => ({
      provider: p.name,
      model: p.model,
      free: p.name !== 'openai',
    }));
  }

  /**
   * Build the fallback chain from environment variables.
   * Only includes providers that have an API key set (or are keyless like Ollama).
   */
  private buildProviderChain(): LlmProviderConfig[] {
    const chain: LlmProviderConfig[] = [];
    const defaultTemp = 0.7;

    // 1. Groq — FREE, fast inference
    const groqKey = this.configService.get<string>('GROQ_API_KEY', '');
    if (groqKey) {
      chain.push({
        name: 'groq',
        model: this.configService.get<string>('GROQ_MODEL', 'llama-3.3-70b-versatile'),
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
      });
    }

    // 2. OpenRouter — FREE models available
    const openrouterKey = this.configService.get<string>('OPENROUTER_API_KEY', '');
    if (openrouterKey) {
      chain.push({
        name: 'openrouter',
        model: this.configService.get<string>(
          'OPENROUTER_MODEL',
          'meta-llama/llama-3.3-70b-instruct:free',
        ),
        apiKey: openrouterKey,
        baseURL: 'https://openrouter.ai/api/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
      });
    }

    // 3. DeepSeek — cheap
    const deepseekKey = this.configService.get<string>('DEEPSEEK_API_KEY', '');
    if (deepseekKey) {
      chain.push({
        name: 'deepseek',
        model: this.configService.get<string>('DEEPSEEK_MODEL', 'deepseek-chat'),
        apiKey: deepseekKey,
        baseURL: 'https://api.deepseek.com',
        temperature: defaultTemp,
        supportsTemperature: true,
      });
    }

    // 4. Cerebras — FREE, fast
    // NOTE: llama-3.3-70b was deprecated/removed from Cerebras on Feb 16, 2026.
    // gpt-oss-120b is the current production model (120B params, ~3000 tok/s).
    const cerebrasKey = this.configService.get<string>('CEREBRAS_API_KEY', '');
    if (cerebrasKey) {
      chain.push({
        name: 'cerebras',
        model: this.configService.get<string>('CEREBRAS_MODEL', 'gpt-oss-120b'),
        apiKey: cerebrasKey,
        baseURL: 'https://api.cerebras.ai/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
      });
    }

    // 5. OpenAI — paid overflow (may be quota-limited)
    // gpt-5-nano and other reasoning models (o1, o3, o4-mini) do NOT accept
    // `temperature` — only the default (1) is supported. We detect reasoning
    // models by name and set supportsTemperature=false so the caller skips it.
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY', '');
    if (openaiKey) {
      const openaiModel = this.configService.get<string>('LLM_DEFAULT_MODEL', 'gpt-5-nano');
      const isReasoningModel = /^(gpt-5|o1|o3|o4-mini)/.test(openaiModel);
      chain.push({
        name: 'openai',
        model: openaiModel,
        apiKey: openaiKey,
        temperature: defaultTemp,
        supportsTemperature: !isReasoningModel,
      });
    }

    // 6. Google Gemini — free tier (1500 RPD), strong multilingual (OpenAI-compatible endpoint)
    const googleKey = this.configService.get<string>('GOOGLE_API_KEY', '');
    if (googleKey) {
      chain.push({
        name: 'google',
        model: this.configService.get<string>('GOOGLE_MODEL', 'gemini-2.5-flash'),
        apiKey: googleKey,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        temperature: defaultTemp,
        supportsTemperature: true,
      });
    }

    // 7. NVIDIA NIM — free ~40 req/min, general multilingual (OpenAI-compatible)
    const nvidiaKey = this.configService.get<string>('NVIDIA_API_KEY', '');
    if (nvidiaKey) {
      chain.push({
        name: 'nvidia',
        model: this.configService.get<string>('NVIDIA_MODEL', 'meta/llama-3.3-70b-instruct'),
        apiKey: nvidiaKey,
        baseURL: 'https://integrate.api.nvidia.com/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
      });
    }

    // 8. Ollama — local, last resort (no API key needed)
    const ollamaUrl = this.configService.get<string>('OLLAMA_URL', 'http://localhost:11434');
    const ollamaModel = this.configService.get<string>('OLLAMA_DEFAULT_MODEL', 'gemma4');
    chain.push({
      name: 'ollama',
      model: ollamaModel,
      apiKey: 'ollama', // Ollama doesn't need a real key, but ChatOpenAI requires non-empty
      baseURL: `${ollamaUrl}/v1`,
      temperature: defaultTemp,
      supportsTemperature: true,
    });

    return chain;
  }

  /**
   * Get or create a ChatOpenAI instance for a specific provider.
   * For models that don't support `temperature` (OpenAI reasoning models),
   * the parameter is omitted entirely — passing it would cause HTTP 400.
   */
  private getModelForProvider(provider: LlmProviderConfig): ChatOpenAI {
    const key = `${provider.name}:${provider.model}`;
    let model = this.models.get(key);
    if (!model) {
      const ctorArgs: Record<string, unknown> = {
        model: provider.model,
        apiKey: provider.apiKey,
        configuration: { baseURL: provider.baseURL },
        timeout: 30000,
        maxRetries: 0, // we handle fallback ourselves
      };
      if (provider.supportsTemperature) {
        ctorArgs.temperature = provider.temperature;
      }
      model = new ChatOpenAI(ctorArgs as ConstructorParameters<typeof ChatOpenAI>[0]);
      this.models.set(key, model);
    }
    return model;
  }

  /**
   * Sprint J: Estimate token count from text length.
   * Rough heuristic: ~4 characters per token for English text.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Sprint J: Circuit breaker — check if a provider is available.
   * Returns false if provider has exceeded failure threshold and is in cooldown.
   */
  private isProviderAvailable(providerName: string): boolean {
    const cb = this.circuitBreakers.get(providerName);
    if (!cb || !cb.tripped) return true;
    // Terminal (auth/billing) failures get a much longer cooldown than transient ones.
    const cooldownMs = cb.terminal ? this.cbTerminalCooldownMs : this.cbCooldownMs;
    if (Date.now() - cb.lastFailureAt > cooldownMs) {
      cb.tripped = false;
      cb.failures = 0;
      cb.terminal = false;
      this.logger.log(`Circuit breaker reset for ${providerName} (cooldown elapsed)`);
      return true;
    }
    return false;
  }

  /**
   * Detect auth/billing errors (401/402/403) that are permanent until a human acts —
   * as opposed to transient errors (429/5xx/timeouts) worth retrying soon.
   */
  private isTerminalLlmError(err: unknown): boolean {
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { status?: number; statusCode?: number })?.statusCode;
    if (status === 401 || status === 402 || status === 403) return true;
    const message = (err as Error)?.message ?? '';
    return /^\s*(401|402|403)\b/.test(message);
  }

  /**
   * Sprint J: Record a provider failure in the circuit breaker.
   * Terminal (auth/billing) failures trip the breaker immediately (no point waiting for
   * cbThreshold — the same key/balance issue will fail on every subsequent call too) and
   * use the much longer cbTerminalCooldownMs cooldown.
   */
  private recordFailure(providerName: string, terminal = false): void {
    const cb = this.circuitBreakers.get(providerName) ?? {
      failures: 0,
      lastFailureAt: 0,
      tripped: false,
      terminal: false,
    };
    cb.failures += 1;
    cb.lastFailureAt = Date.now();
    cb.terminal = terminal;
    if ((terminal || cb.failures >= this.cbThreshold) && !cb.tripped) {
      cb.tripped = true;
      const cooldownMs = terminal ? this.cbTerminalCooldownMs : this.cbCooldownMs;
      this.logger.warn(
        `Circuit breaker TRIPPED for ${providerName} (${cb.failures} failures${terminal ? ', terminal' : ''}) — cooldown ${cooldownMs}ms`,
      );
    }
    this.circuitBreakers.set(providerName, cb);
  }

  /**
   * Sprint J: Record a provider success — resets the circuit breaker.
   */
  private recordSuccess(providerName: string): void {
    this.circuitBreakers.delete(providerName);
  }

  /**
   * Sprint J: Generate cache key from prompts + options.
   */
  private cacheKey(systemPrompt: string, userPrompt: string, options?: GenerateOptions): string {
    // Include temperature in the cache key to prevent collisions between
    // calls with different temperature values (0.7 vs 0.9 would return the
    // same cached response, which is semantically wrong).
    // For reasoning models that ignore temperature, normalize undefined/0
    // to a single canonical value so they still get cache hits.
    const temp = options?.temperature;
    const tempKey = temp === undefined || temp === 0 ? 'reasoning' : String(temp);
    const input = `${systemPrompt}||${userPrompt}||t=${tempKey}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  /**
   * Sprint J: Check cache for a response.
   */
  private getFromCache(key: string): LlmResponse | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    this.logger.debug(`LLM cache hit (key: ${key.slice(0, 8)})`);
    return entry.response;
  }

  /**
   * Sprint J: Store a response in cache.
   * Evicts oldest entries if cache is full (simple FIFO eviction).
   */
  private setInCache(key: string, response: LlmResponse): void {
    if (this.cache.size >= this.cacheMaxSize) {
      // Evict oldest entry (first inserted)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  /**
   * Try each provider in the chain until one succeeds.
   * If lastWorkingProvider is set, try it first (sticky).
   * Sprint J: Adds circuit breaker, caching, token counting, prompt versioning.
   */
  private async invokeWithFallback(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions,
  ): Promise<LlmResponse> {
    if (this.providers.length === 0) {
      throw new Error('No LLM providers configured');
    }

    // Sprint J: Check cache first
    const key = this.cacheKey(systemPrompt, userPrompt, options);
    const cached = this.getFromCache(key);
    if (cached) return cached;

    // Reorder: try last working provider first
    let ordered = this.providers;
    if (this.lastWorkingProvider) {
      const lastIdx = this.providers.findIndex(
        (p) => p.name === this.lastWorkingProvider,
      );
      if (lastIdx >= 0) {
        ordered = [
          this.providers[lastIdx]!,
          ...this.providers.slice(0, lastIdx),
          ...this.providers.slice(lastIdx + 1),
        ];
      }
    }

    const errors: string[] = [];

    for (const provider of ordered) {
      // Sprint J: Skip providers with tripped circuit breaker
      if (!this.isProviderAvailable(provider.name)) {
        this.logger.debug(`Skipping ${provider.name} — circuit breaker tripped`);
        errors.push(`${provider.name}: circuit breaker open`);
        continue;
      }

      try {
        const model = this.getModelForProvider(provider);
        // Only override temperature if the provider supports it.
        // OpenAI reasoning models (gpt-5-nano, o1, o3) reject non-default
        // temperature with HTTP 400, so we skip the override for them.
        if (options?.temperature !== undefined && provider.supportsTemperature) {
          model.temperature = options.temperature;
        }

        // BUG-13: forward the per-call output cap. Previously GenerateOptions.maxTokens was
        // accepted but silently ignored (only temperature was applied), so a caller capping a
        // JSON decision at e.g. 100 tokens actually spent far more. Always assign (no-limit is
        // -1 in ChatOpenAI) so a prior call's cap can't leak through the cached model instance.
        //
        // BUG-14: LangChain @langchain/openai 0.4.x's isReasoningModel() only detects o1/o3
        // prefixes — it does NOT recognize gpt-5-nano and other gpt-5* models as reasoning
        // models. This means it sends `max_tokens` (the legacy parameter) instead of
        // `max_completion_tokens`, which gpt-5 models reject with HTTP 400:
        //   "Unsupported parameter: 'max_tokens' is not supported with this model"
        // Our provider config already flags reasoning models via supportsTemperature=false.
        // We reuse that flag here: for reasoning models, skip maxTokens entirely (set to -1
        // = no limit) to avoid sending the wrong parameter name. The output cap is a
        // nice-to-have optimization, not worth a 400 that takes down the entire provider.
        if (provider.supportsTemperature) {
          model.maxTokens = options?.maxTokens ?? -1;
        } else {
          // Reasoning model — LangChain will omit max_tokens when it's -1 (for non-reasoning
          // detection) or use max_completion_tokens (for o1/o3). For gpt-5*, setting -1
          // ensures the parameter is omitted entirely rather than sent with the wrong name.
          model.maxTokens = -1;
        }

        const messages = systemPrompt
          ? [
              { role: 'system' as const, content: systemPrompt },
              { role: 'user' as const, content: userPrompt },
            ]
          : [{ role: 'user' as const, content: userPrompt }];

        // Langfuse tracing: merge callbacks from GenerateOptions (explicit)
        // and AsyncLocalStorage (ambient — set by GenerationService around
        // graph.invoke() so all LLM calls in the graph nest under one trace).
        // Dedupe by reference; filter out undefined entries.
        const alsCallbacks = callbackStorage.getStore() ?? [];
        const explicitCallbacks = options?.callbacks ?? [];
        const callbacks = [...new Set([...alsCallbacks, ...explicitCallbacks])].filter(
          (h): h is BaseCallbackHandler => h != null,
        );

        const response = await model.invoke(messages, callbacks.length > 0 ? { callbacks } : undefined);
        const content =
          typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);

        if (!content || content.trim().length === 0) {
          throw new Error(`${provider.name} returned empty content`);
        }

        this.lastWorkingProvider = provider.name;
        this.recordSuccess(provider.name);
        this.logger.debug(`LLM success via ${provider.name}/${provider.model}`);

        // Sprint J: Token counting (estimated) + prompt version
        const inputTokens = this.estimateTokens(systemPrompt + userPrompt);
        const outputTokens = this.estimateTokens(content);
        const llmResponse: LlmResponse = {
          content,
          model: `${provider.name}/${provider.model}`,
          tokens: inputTokens + outputTokens,
        };

        // Sprint J: Cache the response
        this.setInCache(key, llmResponse);

        return llmResponse;
      } catch (err) {
        const msg = (err as Error).message;
        errors.push(`${provider.name}: ${msg}`);
        this.recordFailure(provider.name, this.isTerminalLlmError(err));
        this.logger.warn(
          `LLM provider ${provider.name} failed: ${msg.slice(0, 120)}`,
        );
        // Continue to next provider
      }
    }

    throw new Error(
      `All LLM providers failed:\n${errors.join('\n')}`,
    );
  }

  async generateChat(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions,
  ): Promise<LlmResponse> {
    return this.invokeWithFallback(systemPrompt, userPrompt, options);
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<LlmResponse> {
    return this.invokeWithFallback('', prompt, options);
  }

  /**
   * Health check — returns the list of configured providers with circuit breaker status.
   */
  getProviderStatus(): Array<{ name: string; model: string; circuitOpen: boolean; failures: number }> {
    return this.providers.map((p) => {
      const cb = this.circuitBreakers.get(p.name);
      return {
        name: p.name,
        model: p.model,
        circuitOpen: cb?.tripped ?? false,
        failures: cb?.failures ?? 0,
      };
    });
  }

  /**
   * Sprint J/P: Get the current prompt version for tracking in llmMetadata.
   * Sprint P: Sources from PromptRegistry when available, falls back to static constant.
   */
  getPromptVersion(): string {
    if (this.promptRegistry) {
      return this.promptRegistry.getCurrentVersion();
    }
    return LlmService.PROMPT_VERSION;
  }

  /**
   * Sprint J: Clear the response cache (for testing or manual invalidation).
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Sprint J: Get cache stats for monitoring.
   */
  getCacheStats(): { size: number; maxSize: number; ttlMs: number } {
    return { size: this.cache.size, maxSize: this.cacheMaxSize, ttlMs: this.cacheTtlMs };
  }

  /**
   * Sprint P: Get a prompt template from the registry.
   * Returns undefined when no registry is configured (backward compat).
   */
  getPromptTemplate(name: string): { systemPrompt: string; userPromptTemplate: string; version: string } | undefined {
    if (!this.promptRegistry) return undefined;
    const version = this.promptRegistry.getCurrentVersion();
    const tpl = this.promptRegistry.get(version, name);
    return {
      systemPrompt: tpl.systemPrompt,
      userPromptTemplate: tpl.userPromptTemplate,
      version: tpl.version,
    };
  }
}
