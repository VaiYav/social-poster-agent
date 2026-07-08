import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseCallbackHandler } from '../../domain/ports/llm-primitives.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ILlmPort, GenerateOptions, LlmResponse, LlmRole } from '../../domain/ports/llm.port.js';
import { IPromptPort } from '../../domain/ports/prompt.port.js';

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
    @Optional() private readonly promptPort?: IPromptPort,
  ) {
    this.cbThreshold = this.configService.get<number>('LLM_CB_THRESHOLD', 3);
    this.cbCooldownMs = this.configService.get<number>('LLM_CB_COOLDOWN_MS', 60_000);
    // Auth/billing errors (401/402/403) are permanent until a human acts (rotate a key, top up
    // balance) — retrying every cbCooldownMs just repeats the same failure. Default 6h.
    this.cbTerminalCooldownMs = this.configService.get<number>('LLM_CB_TERMINAL_COOLDOWN_MS', 6 * 60 * 60 * 1000);
    this.cacheTtlMs = this.configService.get<number>('LLM_CACHE_TTL_MS', 300_000); // 5 min
    this.cacheMaxSize = this.configService.get<number>('LLM_CACHE_MAX_SIZE', 100);
    this.maxConcurrent = Number(this.configService.get<string | number>('LLM_MAX_CONCURRENT', 4)) || 4;
    this.rateLimitRetryMs = Number(this.configService.get<string | number>('LLM_RATE_LIMIT_RETRY_MS', 2_500)) || 2_500;
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

    // Log OpenAI configuration for debugging
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY', '');
    const openaiModel = this.configService.get<string>('OPENAI_MODEL', 'gpt-5-nano');
    if (openaiKey) {
      this.logger.log(`OpenAI configured: model=${openaiModel}, key=${openaiKey.slice(0, 10)}...${openaiKey.slice(-4)}`);
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
      free: p.name !== 'openai' && p.name !== 'anthropic',
    }));
  }

  /**
   * Build the fallback chain from environment variables.
   * Only includes providers that have an API key set (or are keyless like Ollama).
   */
  private buildProviderChain(): LlmProviderConfig[] {
    const chain: LlmProviderConfig[] = [];
    const defaultTemp = 0.7;
    const defaultTimeout = 30000;

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
        timeout: defaultTimeout,
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
        timeout: defaultTimeout,
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
        timeout: defaultTimeout,
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
        timeout: defaultTimeout,
      });
    }

    // 4.5 Anthropic — strong creative/multilingual backstop via the
    // OpenAI-compatible endpoint. Previously advertised in .env.example but
    // never wired into the chain (dead config — fixed in the quality pass).
    const anthropicKey = this.configService.get<string>('ANTHROPIC_API_KEY', '');
    if (anthropicKey) {
      chain.push({
        name: 'anthropic',
        model: this.configService.get<string>('ANTHROPIC_MODEL', 'claude-haiku-4-5'),
        apiKey: anthropicKey,
        baseURL: 'https://api.anthropic.com/v1/',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 5. OpenAI — paid overflow (may be quota-limited)
    // gpt-5-nano, gpt-5.4-nano, gpt-5-mini and other reasoning models (o1, o3, o4-mini) do NOT accept
    // `temperature` — only the default (1) is supported. We detect reasoning
    // models by name and set supportsTemperature=false so the caller skips it.
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY', '');
    if (openaiKey) {
      const openaiModel = this.configService.get<string>('OPENAI_MODEL', 'gpt-5-nano');
      // Updated regex to match gpt-5.x variants and other reasoning models
      const isReasoningModel = /^(gpt-5(\.\d+)?|o1|o3|o4-mini|codex-mini)/.test(openaiModel);
      chain.push({
        name: 'openai',
        model: openaiModel,
        apiKey: openaiKey,
        temperature: defaultTemp,
        supportsTemperature: !isReasoningModel,
        timeout: isReasoningModel ? 60000 : defaultTimeout, // Reasoning models need more time
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
        timeout: defaultTimeout,
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
        timeout: defaultTimeout,
      });
    }

    // 8. SambaNova — FREE 20M tokens/day, no credit card, OpenAI-compatible
    // Best free-tier quota available (200x Groq's 100K TPD). Llama 3.3 70B, DeepSeek, Qwen.
    // Signup: cloud.sambanova.ai → email → API Keys → Create
    const sambanovaKey = this.configService.get<string>('SAMBANOVA_API_KEY', '');
    if (sambanovaKey) {
      chain.push({
        name: 'sambanova',
        model: this.configService.get<string>('SAMBANOVA_MODEL', 'Meta-Llama-3.3-70B-Instruct'),
        apiKey: sambanovaKey,
        baseURL: 'https://api.sambanova.ai/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 9. GitHub Models — FREE 150 RPD, no credit card, OpenAI-compatible
    // Access to GPT-5, Llama, DeepSeek, Mistral via one key. Needs GitHub PAT with models:read.
    // Signup: github.com/settings/tokens → fine-grained PAT → models:read scope
    const githubToken = this.configService.get<string>('GITHUB_TOKEN', '');
    if (githubToken) {
      chain.push({
        name: 'github',
        model: this.configService.get<string>('GITHUB_MODEL', 'meta-llama/Llama-3.3-70B-Instruct'),
        apiKey: githubToken,
        baseURL: 'https://models.inference.ai.azure.com',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 10. xAI Grok — $25 free credits on signup, no credit card, OpenAI-compatible
    // $25 = ~50M input tokens on grok-4.1-fast. Credits expire in 30 days.
    // Signup: console.x.ai → email → $25 auto-applied
    const xaiKey = this.configService.get<string>('XAI_API_KEY', '');
    if (xaiKey) {
      chain.push({
        name: 'xai',
        model: this.configService.get<string>('XAI_MODEL', 'grok-4.1-fast'),
        apiKey: xaiKey,
        baseURL: 'https://api.x.ai/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 11. Mistral AI — Free mode, no credit card, OpenAI-compatible
    // Free mode with limited usage. EU-hosted, strong multilingual (good for uk/es/it).
    // Signup: console.mistral.ai → API Keys → Create
    const mistralKey = this.configService.get<string>('MISTRAL_API_KEY', '');
    if (mistralKey) {
      chain.push({
        name: 'mistral',
        model: this.configService.get<string>('MISTRAL_MODEL', 'mistral-small-latest'),
        apiKey: mistralKey,
        baseURL: 'https://api.mistral.ai/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 12. Hugging Face Inference Providers — $0.10/mo free, auto-failover, OpenAI-compatible
    // Routes to 15+ inference partners automatically. PRO ($9/mo) → $2/mo credits.
    // Signup: huggingface.co/settings/tokens → fine-grained token → Make calls to Inference Providers
    const hfToken = this.configService.get<string>('HF_TOKEN', '');
    if (hfToken) {
      chain.push({
        name: 'huggingface',
        model: this.configService.get<string>('HF_MODEL', 'meta-llama/Llama-3.3-70B-Instruct'),
        apiKey: hfToken,
        baseURL: 'https://router.huggingface.co/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 13. Together AI — $25 free credits, no credit card, OpenAI-compatible
    // 68 free models including Llama 3.3 70B free variant. Credits don't expire.
    // Signup: api.together.ai → Settings → API Keys → Create
    const togetherKey = this.configService.get<string>('TOGETHER_API_KEY', '');
    if (togetherKey) {
      chain.push({
        name: 'together',
        model: this.configService.get<string>('TOGETHER_MODEL', 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free'),
        apiKey: togetherKey,
        baseURL: 'https://api.together.ai/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 14. Cohere — Trial key: 1000 calls/mo, 20 RPM, no credit card
    // Not for production use (TOS). Good for prototyping. Command A, R+, R7B.
    // Signup: cohere.com → Dashboard → API Keys → Trial key
    const cohereKey = this.configService.get<string>('COHERE_API_KEY', '');
    if (cohereKey) {
      chain.push({
        name: 'cohere',
        model: this.configService.get<string>('COHERE_MODEL', 'command-r7b'),
        apiKey: cohereKey,
        baseURL: 'https://api.cohere.ai/v1',
        temperature: defaultTemp,
        supportsTemperature: true,
        timeout: defaultTimeout,
      });
    }

    // 15. Ollama — local, last resort (no API key needed)
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
    // For reasoning models, omit maxTokens entirely (don't pass -1)
    const maxTokens = provider.supportsTemperature
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
      
      // OpenAI reasoning models (gpt-5, o1, o3, o4-mini) require max_completion_tokens instead of maxTokens
      const isOpenAIReasoning = provider.name === 'openai' && !provider.supportsTemperature;
      
      if (isOpenAIReasoning && maxTokens !== undefined) {
        // Use max_completion_tokens for OpenAI reasoning models
        ctorArgs.maxCompletionTokens = maxTokens;
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
      for (const name of roleChain) {
        const p = this.providers.find((pr) => pr.name === name);
        if (p) preferred.push(p);
      }
      const rest = this.providers.filter((p) => !preferred.includes(p));
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
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { status?: number; statusCode?: number })?.statusCode;
    if (status === 429) return true;
    const message = (err as Error)?.message ?? '';
    return /\b429\b|rate.?limit/i.test(message);
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
    const message = this.extractErrorMessage(err);
    return /^\s*(401|402|403)\b/.test(message);
  }

  /**
   * Safely extract error message from various error object shapes.
   * Some providers (OpenRouter) return undefined error objects in edge cases.
   */
  private extractErrorMessage(err: unknown): string {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.message;
    const message = (err as { message?: string })?.message;
    if (message) return message;
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { status?: number; statusCode?: number })?.statusCode;
    if (status) return `HTTP ${status}`;
    return 'unknown error';
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

    // Sprint J: Check cache first.
    // Q1: creative roles (draft/hook) bypass the cache — identical prompts
    // must still produce fresh creative output (dedup happens upstream via
    // the hook cache and SimHash).
    const cacheable = options?.role !== 'draft' && options?.role !== 'hook';
    const key = this.cacheKey(systemPrompt, userPrompt, options);
    if (cacheable) {
      const cached = this.getFromCache(key);
      if (cached) return cached;
    }

    // Q1: role-aware provider ordering (falls back to sticky default)
    const ordered = this.orderedProviders(options?.role);

    const errors: string[] = [];

    // Q2: global concurrency cap — hold one slot for the whole fallback walk
    await this.acquireSlot();
    try {
      for (const provider of ordered) {
        // Sprint J: Skip providers with tripped circuit breaker
        if (!this.isProviderAvailable(provider.name)) {
          this.logger.debug(`Skipping ${provider.name} — circuit breaker tripped`);
          errors.push(`${provider.name}: circuit breaker open`);
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
        const alsCallbacks = callbackStorage.getStore() ?? [];
        const explicitCallbacks = options?.callbacks ?? [];
        const callbacks = [...new Set([...alsCallbacks, ...explicitCallbacks])].filter(
          (h): h is BaseCallbackHandler => h != null,
        );

        // Q2: up to 2 attempts on the same provider — a 429 means "wait",
        // not "switch": failing over on rate limits cascades the whole chain
        // down to the weakest model (Ollama) during bursts.
        const maxAttempts = 2;
        let lastErr: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
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

            // Q3: Prefer REAL token usage from the provider (usage_metadata),
            // fall back to the chars/4 estimate only when absent.
            const usage = (response as { usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage_metadata;
            const usageTokens = usage?.total_tokens ?? ((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0));
            const tokens = usageTokens > 0
              ? usageTokens
              : this.estimateTokens(systemPrompt + userPrompt) + this.estimateTokens(content);
            const llmResponse: LlmResponse = {
              content,
              model: `${provider.name}/${provider.model}`,
              tokens,
            };

            // Sprint J: Cache the response (non-creative roles only)
            if (cacheable) {
              this.setInCache(key, llmResponse);
            }

            return llmResponse;
          } catch (err) {
            lastErr = err;
            const isLastAttempt = attempt === maxAttempts - 1;
            if (!isLastAttempt && this.isRateLimitError(err)) {
              const waitMs = this.rateLimitRetryMs + Math.floor(Math.random() * 1_500);
              this.logger.debug(`${provider.name} rate-limited (429) — retrying same provider in ${waitMs}ms`);
              await new Promise((r) => setTimeout(r, waitMs));
              continue;
            }
            break; // non-429 or retries exhausted → fail over
          }
        }

        const msg = this.extractErrorMessage(lastErr);
        errors.push(`${provider.name}: ${msg}`);
        // Q13: Don't count 429 (rate limit) as a circuit breaker failure —
        // 429 is transient and already handled by rate-limit retry + failover.
        // Counting it trips the breaker after cbThreshold 429s, blocking ALL
        // providers during rate-limit bursts and causing "All LLM providers failed".
        const isRateLimit = this.isRateLimitError(lastErr);
        if (!isRateLimit) {
          this.recordFailure(provider.name, this.isTerminalLlmError(lastErr));
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
    if (this.promptPort) {
      return this.promptPort.getCurrentVersion();
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
   * Reset circuit breakers for specific providers or all providers.
   * Useful after fixing auth/billing issues (e.g., topping up API keys).
   */
  resetCircuitBreakers(providerNames?: string[]): void {
    if (providerNames && providerNames.length > 0) {
      for (const name of providerNames) {
        this.circuitBreakers.delete(name);
        this.logger.log(`Circuit breaker reset for ${name}`);
      }
    } else {
      this.circuitBreakers.clear();
      this.logger.log('All circuit breakers reset');
    }
  }

  /**
   * Sprint J: Get cache stats for monitoring.
   */
  getCacheStats(): { size: number; maxSize: number; ttlMs: number } {
    return { size: this.cache.size, maxSize: this.cacheMaxSize, ttlMs: this.cacheTtlMs };
  }

}
