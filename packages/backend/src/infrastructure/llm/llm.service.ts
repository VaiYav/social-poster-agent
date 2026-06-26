import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type { ILlmPort, GenerateOptions, LlmResponse } from '../../domain/ports/llm.port.js';

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
 *   5. OpenAI (gpt-4o-mini — paid overflow)
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

  constructor(private readonly configService: ConfigService) {}

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
      });
    }

    // 4. Cerebras — FREE, fast
    const cerebrasKey = this.configService.get<string>('CEREBRAS_API_KEY', '');
    if (cerebrasKey) {
      chain.push({
        name: 'cerebras',
        model: this.configService.get<string>('CEREBRAS_MODEL', 'llama-3.3-70b'),
        apiKey: cerebrasKey,
        baseURL: 'https://api.cerebras.ai/v1',
        temperature: defaultTemp,
      });
    }

    // 5. OpenAI — paid overflow (may be quota-limited)
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY', '');
    if (openaiKey) {
      chain.push({
        name: 'openai',
        model: this.configService.get<string>('LLM_DEFAULT_MODEL', 'gpt-4o-mini'),
        apiKey: openaiKey,
        temperature: defaultTemp,
      });
    }

    // 6. Ollama — local, last resort (no API key needed)
    const ollamaUrl = this.configService.get<string>('OLLAMA_URL', 'http://localhost:11434');
    const ollamaModel = this.configService.get<string>('OLLAMA_DEFAULT_MODEL', 'gemma4');
    chain.push({
      name: 'ollama',
      model: ollamaModel,
      apiKey: 'ollama', // Ollama doesn't need a real key, but ChatOpenAI requires non-empty
      baseURL: `${ollamaUrl}/v1`,
      temperature: defaultTemp,
    });

    return chain;
  }

  /**
   * Get or create a ChatOpenAI instance for a specific provider.
   */
  private getModelForProvider(provider: LlmProviderConfig): ChatOpenAI {
    const key = `${provider.name}:${provider.model}`;
    let model = this.models.get(key);
    if (!model) {
      model = new ChatOpenAI({
        model: provider.model,
        apiKey: provider.apiKey,
        configuration: { baseURL: provider.baseURL },
        temperature: provider.temperature,
        timeout: 30000,
        maxRetries: 0, // we handle fallback ourselves
      });
      this.models.set(key, model);
    }
    return model;
  }

  /**
   * Try each provider in the chain until one succeeds.
   * If lastWorkingProvider is set, try it first (sticky).
   */
  private async invokeWithFallback(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions,
  ): Promise<LlmResponse> {
    if (this.providers.length === 0) {
      throw new Error('No LLM providers configured');
    }

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
      try {
        const model = this.getModelForProvider(provider);
        if (options?.temperature !== undefined) {
          model.temperature = options.temperature;
        }

        const messages = systemPrompt
          ? [
              { role: 'system' as const, content: systemPrompt },
              { role: 'user' as const, content: userPrompt },
            ]
          : [{ role: 'user' as const, content: userPrompt }];

        const response = await model.invoke(messages);
        const content =
          typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);

        if (!content || content.trim().length === 0) {
          throw new Error(`${provider.name} returned empty content`);
        }

        this.lastWorkingProvider = provider.name;
        this.logger.debug(`LLM success via ${provider.name}/${provider.model}`);

        return {
          content,
          model: `${provider.name}/${provider.model}`,
        };
      } catch (err) {
        const msg = (err as Error).message;
        errors.push(`${provider.name}: ${msg}`);
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
   * Health check — returns the list of configured providers.
   */
  getProviderStatus(): { name: string; model: string }[] {
    return this.providers.map((p) => ({ name: p.name, model: p.model }));
  }
}
