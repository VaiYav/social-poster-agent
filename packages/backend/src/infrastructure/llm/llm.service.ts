import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type IORedis from 'ioredis';
import type { BaseCallbackHandler } from '../../domain/ports/llm-primitives.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ILlmPort, GenerateOptions, LlmResponse, LlmRole, ProviderStatus } from '../../domain/ports/llm.port.js';
import { LlmProviderRateLimit } from './llm-provider-rate-limit.js';
import { IPromptPort } from '../../domain/ports/prompt.port.js';
import { SHARED_REDIS } from '../redis/redis.module.js';
import { parseBool } from '../config/parse-bool.js';
import { InMemoryLlmCache, RedisLlmCache, type LlmCache } from './llm-cache.js';
import { combineSignals, signalToPromise } from '../util/abort-signal.js';

/**
 * Provider definition — each provider is tried in order until one succeeds.
 * All providers expose an OpenAI-compatible API, so ChatOpenAI works for all.
 */
interface LlmProviderConfig {
  name: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  /** Whether this provider is considered free-tier for the UI model picker. */
  free: boolean;
  temperature: number;
  /**
   * Whether this provider/model accepts a `temperature` parameter.
   * OpenAI reasoning models (gpt-5-nano, o1, o3, etc.) reject temperature
   * with HTTP 400 — only the default (1) is supported. Set to false for
   * those models so we skip sending temperature entirely.
   */
  supportsTemperature: boolean;
  /**
   * Request timeout in milliseconds. Providers like OpenAI reasoning models
   * may need more time due to their inference characteristics.
   */
  timeout: number;
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

/** Provider registry entry used to build the chain from env vars. */
interface ProviderSpec {
  name: string;
  /** Env var that must be set for the provider to be included (not needed when alwaysInclude is true). */
  keyEnv?: string;
  /** Env var that holds the model name. */
  modelEnv: string;
  defaultModel: string;
  /** Whether this provider is considered free-tier for the UI model picker. */
  free?: boolean;
  /** OpenAI-compatible base URL, or a function to compute it from config. */
  baseURL?: string | ((config: ConfigService) => string);
  /** If true, include the provider even when keyEnv is empty. */
  alwaysInclude?: boolean;
  /** API key to use when the provider is keyless (e.g. Ollama). */
  defaultApiKey?: string;
  /** Optional override for supportsTemperature and timeout. */
  customize?: (
    config: ConfigService,
    model: string,
    defaultTimeout: number,
  ) => Partial<Pick<LlmProviderConfig, 'supportsTemperature' | 'timeout'>>;
}

const REASONING_MODEL_PATTERN = /^(gpt-5(\.\d+)?|o1|o3|o4-mini|codex-mini)/;

/**
 * Static provider registry. Keeping provider metadata as data makes the chain
 * extensible and eliminates the repetitive if/push blocks in buildProviderChain.
 */
const PROVIDER_DEFINITIONS: ProviderSpec[] = [
  // 1. Groq — FREE, fast inference (rate-limits under burst traffic)
  {
    name: 'groq',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
    free: true,
    baseURL: 'https://api.groq.com/openai/v1',
  },
  // 2. SambaNova — FREE 20M tokens/day, no credit card, OpenAI-compatible
  // Best free-tier quota available (200x Groq's 100K TPD). Llama 3.3 70B, DeepSeek, Qwen.
  // Positioned 2nd so it's the primary fallback when Groq rate-limits — its
  // massive free quota means it almost never 429s.
  {
    name: 'sambanova',
    keyEnv: 'SAMBANOVA_API_KEY',
    modelEnv: 'SAMBANOVA_MODEL',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    free: true,
    baseURL: 'https://api.sambanova.ai/v1',
  },
  // 3. Cerebras — FREE, fast (~3000 tok/s)
  // NOTE: llama-3.3-70b was deprecated/removed from Cerebras on Feb 16, 2026.
  // gpt-oss-120b is the current production model (120B params).
  {
    name: 'cerebras',
    keyEnv: 'CEREBRAS_API_KEY',
    modelEnv: 'CEREBRAS_MODEL',
    defaultModel: 'gpt-oss-120b',
    free: true,
    baseURL: 'https://api.cerebras.ai/v1',
  },
  // 4. OpenRouter — FREE models available (intermittent empty content on some free models)
  {
    name: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    free: true,
    baseURL: 'https://openrouter.ai/api/v1',
  },
  // 5. DeepSeek — cheap (may hit 402 Insufficient Balance if credits run out)
  {
    name: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    free: false,
    baseURL: 'https://api.deepseek.com',
  },
  // 6. Anthropic — strong creative/multilingual backstop via the
  // OpenAI-compatible endpoint. Previously advertised in .env.example but
  // never wired into the chain (dead config — fixed in the quality pass).
  {
    name: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-haiku-4-5',
    free: false,
    baseURL: 'https://api.anthropic.com/v1/',
  },
  // 7. OpenAI — paid overflow (may be quota-limited)
  // gpt-5-nano, gpt-5.4-nano, gpt-5-mini and other reasoning models (o1, o3, o4-mini) do NOT accept
  // `temperature` — only the default (1) is supported. We detect reasoning
  // models by name and set supportsTemperature=false so the caller skips it.
  {
    name: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-5-nano',
    free: false,
    customize: (_config, model, defaultTimeout) => {
      const isReasoningModel = REASONING_MODEL_PATTERN.test(model);
      return {
        supportsTemperature: !isReasoningModel,
        timeout: isReasoningModel ? 60000 : defaultTimeout,
      };
    },
  },
  // 8. Google Gemini — free tier (1500 RPD), strong multilingual (OpenAI-compatible endpoint)
  {
    name: 'google',
    keyEnv: 'GOOGLE_API_KEY',
    modelEnv: 'GOOGLE_MODEL',
    defaultModel: 'gemini-2.5-flash',
    free: true,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  // 9. NVIDIA NIM — free ~40 req/min, general multilingual (OpenAI-compatible)
  {
    name: 'nvidia',
    keyEnv: 'NVIDIA_API_KEY',
    modelEnv: 'NVIDIA_MODEL',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    free: true,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  },
  // 9. GitHub Models — FREE 150 RPD, no credit card, OpenAI-compatible
  // Access to GPT-5, Llama, DeepSeek, Mistral via one key. Needs GitHub PAT with models:read.
  {
    name: 'github',
    keyEnv: 'GITHUB_TOKEN',
    modelEnv: 'GITHUB_MODEL',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    free: true,
    baseURL: 'https://models.inference.ai.azure.com',
  },
  // 10. xAI Grok — $25 free credits on signup, no credit card, OpenAI-compatible
  {
    name: 'xai',
    keyEnv: 'XAI_API_KEY',
    modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-4.1-fast',
    free: false,
    baseURL: 'https://api.x.ai/v1',
  },
  // 11. Mistral AI — Free mode, no credit card, OpenAI-compatible
  // EU-hosted, strong multilingual (good for uk/es/it).
  {
    name: 'mistral',
    keyEnv: 'MISTRAL_API_KEY',
    modelEnv: 'MISTRAL_MODEL',
    defaultModel: 'mistral-small-latest',
    free: true,
    baseURL: 'https://api.mistral.ai/v1',
  },
  // 12. Hugging Face Inference Providers — $0.10/mo free, auto-failover, OpenAI-compatible
  // Routes to 15+ inference partners automatically.
  {
    name: 'huggingface',
    keyEnv: 'HF_TOKEN',
    modelEnv: 'HF_MODEL',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    free: true,
    baseURL: 'https://router.huggingface.co/v1',
  },
  // 13. Together AI — $25 free credits, no credit card, OpenAI-compatible
  // 68 free models including Llama 3.3 70B free variant. Credits don't expire.
  {
    name: 'together',
    keyEnv: 'TOGETHER_API_KEY',
    modelEnv: 'TOGETHER_MODEL',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    free: false,
    baseURL: 'https://api.together.ai/v1',
  },
  // 14. Cohere — Trial key: 1000 calls/mo, 20 RPM, no credit card
  // Not for production use (TOS). Good for prototyping.
  {
    name: 'cohere',
    keyEnv: 'COHERE_API_KEY',
    modelEnv: 'COHERE_MODEL',
    defaultModel: 'command-r7b',
    free: true,
    baseURL: 'https://api.cohere.ai/v1',
  },
  // 15. Ollama — local, last resort (no API key needed)
  {
    name: 'ollama',
    modelEnv: 'OLLAMA_DEFAULT_MODEL',
    defaultModel: 'gemma4',
    free: true,
    baseURL: (config) => `${config.get<string>('OLLAMA_URL', 'http://localhost:11434')}/v1`,
    alwaysInclude: true,
    defaultApiKey: 'ollama',
  },
];

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
 *
 * A signal can also be propagated so model.invoke() respects orchestrator
 * aborts / action timeouts.
 */
interface LlmContext {
  callbacks: BaseCallbackHandler[];
  signal?: AbortSignal;
}

const llmContextStorage = new AsyncLocalStorage<LlmContext>();

/**
 * Run a function with ambient Langfuse callbacks and an optional abort signal
 * in AsyncLocalStorage. All llm.generateChat()/generate() calls within `fn`
 * (including those deep inside LangGraph nodes) will automatically attach these
 * callbacks to their model.invoke() calls and respect the signal, nesting the
 * LLM observations under the graph trace.
 *
 * Exported so GenerationService can wrap graph.invoke() without threading
 * callbacks/signals through every node function signature.
 */
export function withLlmContext<T>(context: LlmContext, fn: () => Promise<T>): Promise<T> {
  return llmContextStorage.run(context, fn);
}

/** Backward-compatible wrapper: callbacks only. */
export function withLlmCallbacks<T>(callbacks: BaseCallbackHandler[], fn: () => Promise<T>): Promise<T> {
  return withLlmContext({ callbacks }, fn);
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
  private readonly cacheBackend: LlmCache;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxSize: number;
  private readonly cacheShared: boolean;

  // Sprint Q: Per-provider rate-limit cooldown (separate from circuit breaker)
  private readonly rateLimitBackoff: LlmProviderRateLimit;

  // Empty-content cooldown — when a provider returns empty content (model refused
  // to generate or parsing issue), skip it for 60s to avoid wasting time retrying
  // a provider that's currently in a bad state. This prevents the cascade where
  // Groq 429s → OpenRouter empty → Cerebras empty → caller times out before
  // reaching SambaNova. With this, the chain skips empty-content providers fast.
  private readonly emptyContentCooldowns = new Map<string, number>();
  private readonly emptyContentCooldownMs = 60_000;

  // Sprint J: Prompt version — bumped when prompts change, stored in llmMetadata
  // Sprint P: Now sourced from PromptRegistry when available, falls back to static constant
  static readonly PROMPT_VERSION = '0.5.0-quality-pass';

  // Q1: Per-role provider chains — parsed from LLM_ROLE_CHAINS env.
  // Format: "draft=google,deepseek;judge=groq,ollama" (role=comma-separated provider names).
  private roleChains = new Map<string, string[]>();

  // Q2: Global concurrency cap — prevents 429 cascades on free-tier providers
  // when parallel graph branches fan out (3 topics × 3 networks × N nodes).
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  // Q2: One retry on the SAME provider after a rate-limit (429) before failover —
  // a 429 is a reason to wait, not to switch providers.
  private readonly rateLimitRetryMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) @Optional() private readonly redis?: IORedis,
    @Optional() private readonly promptPort?: IPromptPort,
  ) {
    this.cbThreshold = this.configService.get<number>('LLM_CB_THRESHOLD', 3);
    this.cbCooldownMs = this.configService.get<number>('LLM_CB_COOLDOWN_MS', 60_000);
    // Auth/billing errors (401/402/403) are permanent until a human acts (rotate a key, top up
    // balance) — retrying every cbCooldownMs just repeats the same failure. Default 6h.
    this.cbTerminalCooldownMs = this.configService.get<number>('LLM_CB_TERMINAL_COOLDOWN_MS', 6 * 60 * 60 * 1000);
    this.cacheTtlMs = this.configService.get<number>('LLM_CACHE_TTL_MS', 300_000); // 5 min
    this.cacheMaxSize = this.configService.get<number>('LLM_CACHE_MAX_SIZE', 100);
    this.cacheShared = parseBool(this.configService.get<string>('LLM_CACHE_SHARED', 'true'), true);
    this.cacheBackend = this.buildCacheBackend();
    this.maxConcurrent = Number(this.configService.get<string | number>('LLM_MAX_CONCURRENT', 4)) || 4;
    this.rateLimitRetryMs = Number(this.configService.get<string | number>('LLM_RATE_LIMIT_RETRY_MS', 2_500)) || 2_500;
    this.rateLimitBackoff = new LlmProviderRateLimit(this.configService);
  }

  onModuleInit(): void {
    this.providers = this.buildProviderChain();
    this.roleChains = this.parseRoleChains(
      this.configService.get<string>('LLM_ROLE_CHAINS', ''),
    );

    if (this.providers.length === 0) {
      this.logger.warn('No LLM providers configured — LLM generation will fail');
      return;
    }

    const summary = this.providers
      .map((p) => `${p.name}/${p.model}`)
      .join(' → ');
    this.logger.log(`LLM provider chain (${this.providers.length}): ${summary}`);
    this.logger.log(`LLM cache: ${this.cacheShared ? 'Redis shared' : 'in-memory'} (prefix=${this.configService.get<string>('LLM_CACHE_KEY_PREFIX', 'spa:cache:llm')})`);

    // Log OpenAI configuration for debugging (never log the key)
    const openaiModel = this.configService.get<string>('OPENAI_MODEL', 'gpt-5-nano');
    const hasOpenAiKey = !!this.configService.get<string>('OPENAI_API_KEY', '');
    if (hasOpenAiKey) {
      this.logger.log(`OpenAI configured: model=${openaiModel}`);
    } else {
      this.logger.warn('OpenAI API key not configured');
    }
  }

  /**
   * List available LLM models for UI model picker (F3).
   * Returns provider name, model id, and whether it's free or paid.
   */
  getAvailableModels(): Array<{ provider: string; model: string; free: boolean }> {
    return this.providers.map((p) => ({
      provider: p.name,
      model: p.model,
      free: p.free,
    }));
  }

  /**
   * Build the fallback chain from environment variables.
   * Only includes providers that have an API key set (or are keyless like Ollama).
   */
  private buildProviderChain(): LlmProviderConfig[] {
    const defaultTemp = 0.7;
    const defaultTimeout = 30000;
    const chain: LlmProviderConfig[] = [];

    for (const def of PROVIDER_DEFINITIONS) {
      const key = def.keyEnv ? this.configService.get<string>(def.keyEnv, '') : '';
      if (!def.alwaysInclude && !key) continue;

      const model = this.configService.get<string>(def.modelEnv, def.defaultModel);
      const apiKey = def.alwaysInclude ? (def.defaultApiKey ?? key ?? '') : (key || '');
      if (!def.alwaysInclude && !apiKey) continue;

      const baseURL = typeof def.baseURL === 'function' ? def.baseURL(this.configService) : def.baseURL;
      const custom = def.customize ? def.customize(this.configService, model, defaultTimeout) : {};

      chain.push({
        name: def.name,
        model,
        apiKey,
        baseURL,
        free: def.free ?? true,
        temperature: defaultTemp,
        supportsTemperature: custom.supportsTemperature ?? true,
        timeout: custom.timeout ?? defaultTimeout,
      });
    }

    return chain;
  }

  /**
   * Build the cache backend. Redis shared cache is the default; in-memory is the
   * legacy fallback when LLM_CACHE_SHARED=false.
   */
  private buildCacheBackend(): LlmCache {
    if (this.cacheShared) {
      if (!this.redis) {
        throw new Error('LLM_CACHE_SHARED=true but SHARED_REDIS is not available');
      }
      const prefix = this.configService.get<string>('LLM_CACHE_KEY_PREFIX', 'spa:cache:llm');
      return new RedisLlmCache(prefix, this.redis);
    }
    return new InMemoryLlmCache(this.cacheMaxSize, this.cacheTtlMs);
  }

  /**
   * Get or create a ChatOpenAI instance for a provider + call options combo.
   *
   * BUG-FIX (race condition): instances were previously cached per provider and
   * MUTATED per call (`model.temperature = ...`). Parallel graph nodes (draft
   * t=0.7, critique t=0.3, judge t=0.2 across 3 networks × 3 topics) clobbered
   * each other's temperature/maxTokens between assignment and invoke().
   * Now the cache key includes temperature + maxTokens and instances are never
   * mutated — concurrent calls with different options get different instances.
   *
   * For models that don't support `temperature` (OpenAI reasoning models),
   * both temperature and maxTokens are omitted entirely — passing them would
   * cause HTTP 400 (see BUG-13/BUG-14 notes in git history).
   */
  private getModelForProvider(provider: LlmProviderConfig, options?: GenerateOptions): ChatOpenAI {
    // Effective per-call parameters (resolved BEFORE caching — immutable after)
    const temperature = provider.supportsTemperature
      ? (options?.temperature ?? provider.temperature)
      : undefined;
    // For reasoning models, use max_completion_tokens when the caller provides
    // a maxTokens value; otherwise omit it. For normal models, default to -1
    // (no explicit limit) when maxTokens is not provided.
    const isOpenAIReasoning = provider.name === 'openai' && !provider.supportsTemperature;
    const maxTokens = isOpenAIReasoning
      ? options?.maxTokens
      : provider.supportsTemperature
        ? (options?.maxTokens ?? -1)
        : undefined;

    const key = `${provider.name}:${provider.model}:t${temperature ?? 'na'}:m${maxTokens ?? 'na'}:to${provider.timeout}`;
    let model = this.models.get(key);
    if (!model) {
      const ctorArgs: Record<string, unknown> = {
        model: provider.model,
        apiKey: provider.apiKey,
        configuration: { baseURL: provider.baseURL },
        timeout: provider.timeout,
        maxRetries: 0, // we handle fallback ourselves
      };
      
      if (isOpenAIReasoning && maxTokens !== undefined) {
        // OpenAI reasoning models (gpt-5, o1, o3, o4-mini) reject `max_tokens` and require `max_completion_tokens`.
        // Use modelKwargs to force the correct API body parameter and avoid ChatOpenAI
        // potentially mapping an unsupported `maxCompletionTokens` field to `max_tokens`.
        ctorArgs.modelKwargs = { max_completion_tokens: maxTokens };
      } else if (maxTokens !== undefined) {
        // Use maxTokens for other models
        ctorArgs.maxTokens = maxTokens;
      }
      
      // Only add temperature if the provider supports it
      if (temperature !== undefined) {
        ctorArgs.temperature = temperature;
      }
      
      model = new ChatOpenAI(ctorArgs as ConstructorParameters<typeof ChatOpenAI>[0]);
      this.models.set(key, model);
    }
    return model;
  }

  /**
   * Q1: Parse LLM_ROLE_CHAINS env into a role → provider-names map.
   * Format: "draft=google,deepseek;judge=groq,ollama". Unknown roles/providers
   * are kept as-is and simply won't match anything at ordering time.
   */
  private parseRoleChains(raw: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!raw || !raw.trim()) return map;
    for (const entry of raw.split(';')) {
      const [role, names] = entry.split('=');
      if (!role || !names) continue;
      const list = names.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
      if (list.length > 0) map.set(role.trim().toLowerCase(), list);
    }
    return map;
  }

  /**
   * Q1: Order providers for a call.
   * - When a role chain is configured for options.role: preferred providers
   *   first (in configured order), then the remaining chain as backstop.
   * - Otherwise: default chain with sticky lastWorkingProvider first.
   */
  private orderedProviders(role?: LlmRole): LlmProviderConfig[] {
    const roleChain = role ? this.roleChains.get(role) : undefined;
    if (roleChain && roleChain.length > 0) {
      const preferred: LlmProviderConfig[] = [];
      const preferredNames = new Set<string>();
      for (const name of roleChain) {
        const p = this.providers.find((pr) => pr.name === name);
        if (p) {
          preferred.push(p);
          preferredNames.add(p.name);
        }
      }
      const rest = this.providers.filter((p) => !preferredNames.has(p.name));
      return [...preferred, ...rest];
    }

    if (this.lastWorkingProvider) {
      const lastIdx = this.providers.findIndex((p) => p.name === this.lastWorkingProvider);
      if (lastIdx >= 0) {
        return [
          this.providers[lastIdx]!,
          ...this.providers.slice(0, lastIdx),
          ...this.providers.slice(lastIdx + 1),
        ];
      }
    }
    return this.providers;
  }

  /** Q2: Detect a rate-limit (429) error — worth a retry on the SAME provider. */
  private isRateLimitError(err: unknown): boolean {
    const status = LlmProviderRateLimit.extractStatusCode(err);
    if (status === 429) return true;
    if (typeof err === 'object' && err !== null) {
      const code = Reflect.get(err, 'code');
      const lcErrorCode = Reflect.get(err, 'lc_error_code');
      if (code === 'rate_limit_exceeded' || lcErrorCode === 'MODEL_RATE_LIMIT') return true;
    }
    const message = LlmProviderRateLimit.extractErrorMessage(err);
    return /\b429\b|rate[ _]?limit|rate_limit_exceeded|too many requests/i.test(message);
  }

  /** Q2: Acquire a slot in the global concurrency semaphore. */
  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  /** Q2: Release a semaphore slot and wake the next waiter. */
  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * Sprint J: Estimate token count from text length.
   * Rough heuristic: ~4 characters per token for English text.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * P2: Estimate USD cost for a single LLM call based on provider pricing.
   * Prices are per 1M tokens (input, output) as of 2026-07. Free-tier
   * providers (groq, sambanova, cerebras, openrouter free, google free,
   * nvidia, github, mistral free, huggingface free, together free, cohere
   * trial, ollama) return 0. Paid providers use published API pricing.
   * When token usage is unavailable (0), returns 0 — the cost is tracked
   * only when we have real usage data.
   */
  private estimateCost(providerName: string, _model: string, inputTokens: number, outputTokens: number): number {
    if (inputTokens === 0 && outputTokens === 0) return 0;
    // Pricing per 1M tokens: [input, output]. 0 = free tier.
    // Sources: provider pricing pages, 2026-07. Rounded to 2 decimals.
    const PRICING: Record<string, [number, number]> = {
      groq: [0, 0],
      sambanova: [0, 0],
      cerebras: [0, 0],
      openrouter: [0, 0], // free models only in the chain
      deepseek: [0.27, 1.10],
      anthropic: [0.80, 4.00], // claude-haiku-4-5
      openai: [0.50, 2.00], // gpt-5-nano approximate
      google: [0, 0], // free tier
      nvidia: [0, 0],
      github: [0, 0],
      xai: [2.00, 10.00], // grok-4.1-fast
      mistral: [0, 0], // free tier
      huggingface: [0, 0],
      together: [0, 0], // free variant in chain
      cohere: [0, 0], // trial
      ollama: [0, 0],
    };
    const [inputPer1M, outputPer1M] = PRICING[providerName] ?? [0, 0];
    if (inputPer1M === 0 && outputPer1M === 0) return 0;
    return Number(((inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M).toFixed(6));
  }

  /**
   * Q3: Extract token usage from a LangChain response without type assertions.
   */
  private extractUsageMetadata(response: unknown): { total: number | undefined; input: number; output: number } {
    const usage = response && typeof response === 'object' ? Reflect.get(response, 'usage_metadata') : undefined;
    if (!usage || typeof usage !== 'object') {
      return { total: undefined, input: 0, output: 0 };
    }
    const total = Reflect.get(usage, 'total_tokens');
    const input = Reflect.get(usage, 'input_tokens');
    const output = Reflect.get(usage, 'output_tokens');
    return {
      total: typeof total === 'number' ? total : undefined,
      input: typeof input === 'number' ? input : 0,
      output: typeof output === 'number' ? output : 0,
    };
  }

  /**
   * Sprint J/Q: Circuit breaker + rate-limit cooldown — check if a provider is available.
   * Returns false if the provider is in a rate-limit penalty box or has a tripped breaker.
   */
  private isProviderAvailable(providerName: string): boolean {
    if (!this.rateLimitBackoff.isAvailable(providerName)) {
      return false;
    }

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
    const status = LlmProviderRateLimit.extractStatusCode(err);
    if (status === 401 || status === 402 || status === 403) return true;
    const message = LlmProviderRateLimit.extractErrorMessage(err);
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
   * Sprint J: Record a provider success — resets the circuit breaker and rate-limit cooldown.
   */
  private recordSuccess(providerName: string): void {
    this.circuitBreakers.delete(providerName);
    this.rateLimitBackoff.recordSuccess(providerName);
    this.emptyContentCooldowns.delete(providerName);
  }

  /**
   * Sprint J: Generate cache key from prompts + options.
   * The key includes the provider/model so a fallback response is not served
   * as a hit for a different provider, and includes maxTokens/role/temperature
   * so calls with different parameters do not collide.
   */
  private cacheKey(
    systemPrompt: string,
    userPrompt: string,
    options: GenerateOptions | undefined,
    provider: LlmProviderConfig,
  ): string {
    const temp = options?.temperature;
    const tempKey = temp === undefined ? 'undef' : String(temp);
    const parts = [
      systemPrompt,
      userPrompt,
      `provider=${provider.name}`,
      `model=${provider.model}`,
      `t=${tempKey}`,
      `maxTokens=${options?.maxTokens ?? 'undef'}`,
      `role=${options?.role ?? 'none'}`,
    ];
    const input = parts.join('||');
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
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

    // Sprint J: Check cache first.
    // Q1: creative roles (draft/hook) bypass the cache — identical prompts
    // must still produce fresh creative output (dedup happens upstream via
    // the hook cache and SimHash).
    const cacheable = options?.role !== 'draft' && options?.role !== 'hook';

    // Q1: role-aware provider ordering (falls back to sticky default)
    const ordered = this.orderedProviders(options?.role);

    const errors: string[] = [];

    // Q2: global concurrency cap — hold one slot for the whole fallback walk
    await this.acquireSlot();
    try {
      for (const provider of ordered) {
        const key = this.cacheKey(systemPrompt, userPrompt, options, provider);
        if (cacheable) {
          const cached = await this.cacheBackend.get(key);
          if (cached) {
            this.logger.debug(`LLM cache hit (key: ${key.slice(0, 8)})`);
            return cached;
          }
        }

        // Sprint J/Q: Skip providers with tripped circuit breaker or rate-limit cooldown
        if (!this.isProviderAvailable(provider.name)) {
          const rl = this.rateLimitBackoff.getStatus(provider.name);
          if (rl.rateLimitUntil > Date.now()) {
            this.logger.debug(
              `Skipping ${provider.name} — rate-limit cooldown until ${new Date(rl.rateLimitUntil).toISOString()}`,
            );
            errors.push(`${provider.name}: rate-limit cooldown`);
          } else {
            this.logger.debug(`Skipping ${provider.name} — circuit breaker tripped`);
            errors.push(`${provider.name}: circuit breaker open`);
          }
          continue;
        }

        // Empty-content cooldown — skip providers that recently returned empty content
        const emptyCooldownUntil = this.emptyContentCooldowns.get(provider.name);
        if (emptyCooldownUntil && emptyCooldownUntil > Date.now()) {
          this.logger.debug(
            `Skipping ${provider.name} — empty-content cooldown until ${new Date(emptyCooldownUntil).toISOString()}`,
          );
          errors.push(`${provider.name}: empty-content cooldown`);
          continue;
        }

        // BUG-13/BUG-14 handling now lives inside getModelForProvider():
        // temperature/maxTokens are resolved per call and baked into an
        // immutable, cache-keyed instance (no shared-state races), and
        // reasoning models get both parameters omitted entirely.
        const model = this.getModelForProvider(provider, options);

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
        const alsContext = llmContextStorage.getStore();
        const alsCallbacks = alsContext?.callbacks ?? [];
        const explicitCallbacks = options?.callbacks ?? [];
        const callbacks = [...new Set([...alsCallbacks, ...explicitCallbacks])].filter(
          (h): h is BaseCallbackHandler => h != null,
        );

        // Q2: up to 2 attempts on the same provider — a 429 means "wait",
        // not "switch": failing over on rate limits cascades the whole chain
        // down to the weakest model (Ollama) during bursts.
        // Sprint Q: 429s now update a dedicated rate-limit cooldown; we only
        // retry same provider if the provider tells us it will recover quickly.
        const maxAttempts = 2;
        let lastErr: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            if (options?.signal?.aborted) {
              throw new Error('Abort');
            }

            const invokeConfig: { callbacks?: BaseCallbackHandler[]; signal?: AbortSignal } = {};
            if (callbacks.length > 0) invokeConfig.callbacks = callbacks;
            if (options?.signal) invokeConfig.signal = options.signal;
            const response = await model.invoke(
              messages,
              Object.keys(invokeConfig).length > 0 ? invokeConfig : undefined,
            );
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

            // Q3: Prefer REAL token usage from the provider (usage_metadata),
            // fall back to the chars/4 estimate only when absent.
            const usage = this.extractUsageMetadata(response);
            const usageTokens = usage.total ?? (usage.input + usage.output);
            const tokens = usageTokens > 0
              ? usageTokens
              : this.estimateTokens(systemPrompt + userPrompt) + this.estimateTokens(content);
            const llmResponse: LlmResponse = {
              content,
              model: `${provider.name}/${provider.model}`,
              tokens,
              cost: this.estimateCost(provider.name, provider.model, usage.input, usage.output),
            };

            if (options?.signal?.aborted) {
              throw new Error('Abort');
            }

            // Sprint J: Cache the response (non-creative roles only)
            if (cacheable) {
              await this.cacheBackend.set(key, llmResponse, this.cacheTtlMs);
            }

            return llmResponse;
          } catch (err) {
            lastErr = err;
            // 2.6.4: if the caller aborted, stop retrying immediately and propagate
            if (options?.signal?.aborted) {
              throw err;
            }
            if (!this.isRateLimitError(err)) {
              break; // non-429 → fail over immediately
            }

            const now = Date.now();
            const retryAfterMs = LlmProviderRateLimit.parseRetryAfterMs(err, now);
            const status = this.rateLimitBackoff.recordRateLimit(provider.name, retryAfterMs, now);

            const isLastAttempt = attempt === maxAttempts - 1;
            if (!isLastAttempt) {
              let retryDelayMs: number | undefined;
              if (retryAfterMs !== undefined && retryAfterMs <= this.rateLimitBackoff.retryAfterMaxMs) {
                retryDelayMs = retryAfterMs;
              } else if (retryAfterMs === undefined) {
                retryDelayMs = this.rateLimitRetryMs + Math.floor(Math.random() * 1_500);
              }

              if (retryDelayMs !== undefined) {
                this.logger.debug(
                  `${provider.name} rate-limited (429) — retrying same provider in ${retryDelayMs}ms (consecutive: ${status.consecutive429s})`,
                );
                await new Promise((r) => setTimeout(r, retryDelayMs));
                continue;
              }
            }

            this.logger.warn(
              `${provider.name} rate-limited (429) — cooldown until ${new Date(status.rateLimitUntil).toISOString()} (consecutive: ${status.consecutive429s}, strikes: ${status.rateLimitStrikes})`,
            );
            break; // cooldown set → fail over
          }
        }

        const msg = LlmProviderRateLimit.extractErrorMessage(lastErr);
        errors.push(`${provider.name}: ${msg}`);
        // Q13: Don't count 429 (rate limit) as a circuit breaker failure —
        // 429 is transient and already handled by rate-limit retry + failover.
        // Counting it trips the breaker after cbThreshold 429s, blocking ALL
        // providers during rate-limit bursts and causing "All LLM providers failed".
        const isRateLimit = this.isRateLimitError(lastErr);
        if (!isRateLimit) {
          this.recordFailure(provider.name, this.isTerminalLlmError(lastErr));
          // Empty content: set a short cooldown so the chain skips this provider
          // on the next call instead of wasting time retrying it. This prevents
          // the cascade where multiple providers return empty content in quick
          // succession and the caller times out before reaching a working one.
          if (msg.includes('empty content')) {
            this.emptyContentCooldowns.set(provider.name, Date.now() + this.emptyContentCooldownMs);
            this.logger.debug(
              `${provider.name} empty-content cooldown set for ${this.emptyContentCooldownMs}ms`,
            );
          }
        } else {
          this.logger.debug(`${provider.name} rate-limited (429) — not counting as circuit breaker failure`);
        }
        this.logger.warn(
          `LLM provider ${provider.name} failed: ${msg.slice(0, 120)}`,
        );
        // Continue to next provider
      }
    } finally {
      this.releaseSlot();
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
    const alsContext = llmContextStorage.getStore();
    const effectiveSignal = combineSignals(options?.signal, alsContext?.signal);

    if (effectiveSignal?.aborted) {
      throw new Error('Abort');
    }

    if (!effectiveSignal) {
      return this.invokeWithFallback(systemPrompt, userPrompt, options);
    }

    return await Promise.race([
      this.invokeWithFallback(systemPrompt, userPrompt, { ...options, signal: effectiveSignal }),
      signalToPromise(effectiveSignal),
    ]);
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<LlmResponse> {
    return this.generateChat('', prompt, options);
  }

  /**
   * Health check — returns the list of configured providers with circuit breaker and rate-limit status.
   */
  getProviderStatus(): ProviderStatus[] {
    return this.providers.map((p) => {
      const cb = this.circuitBreakers.get(p.name);
      const rl = this.rateLimitBackoff.getStatus(p.name);
      return {
        name: p.name,
        model: p.model,
        circuitOpen: cb?.tripped ?? false,
        failures: cb?.failures ?? 0,
        rateLimitUntil: rl.rateLimitUntil,
        rateLimitStrikes: rl.rateLimitStrikes,
        consecutive429s: rl.consecutive429s,
      };
    });
  }

  /**
   * Sprint J/P: Get the current prompt version for tracking in llmMetadata.
   * Sprint P: Sources from PromptRegistry when available, falls back to static constant.
   */
  getPromptVersion(): string {
    if (this.promptPort) {
      return this.promptPort.getCurrentVersion();
    }
    return LlmService.PROMPT_VERSION;
  }

  /**
   * Sprint J: Clear the response cache (for testing or manual invalidation).
   */
  async clearCache(): Promise<void> {
    await this.cacheBackend.clear();
  }

  /**
   * Reset circuit breakers for specific providers or all providers.
   * Useful after fixing auth/billing issues (e.g., topping up API keys).
   */
  resetCircuitBreakers(providerNames?: string[]): void {
    if (providerNames && providerNames.length > 0) {
      for (const name of providerNames) {
        this.circuitBreakers.delete(name);
        this.rateLimitBackoff.reset([name]);
        this.emptyContentCooldowns.delete(name);
        this.logger.log(`Circuit breaker + rate-limit reset for ${name}`);
      }
    } else {
      this.circuitBreakers.clear();
      this.rateLimitBackoff.reset();
      this.emptyContentCooldowns.clear();
      this.logger.log('All circuit breakers and rate-limit cooldowns reset');
    }
  }

  /**
   * Sprint J: Get cache stats for monitoring.
   */
  async getCacheStats(): Promise<{ size: number; maxSize: number; ttlMs: number }> {
    const { size } = await this.cacheBackend.stats();
    return { size, maxSize: this.cacheMaxSize, ttlMs: this.cacheTtlMs };
  }

}
