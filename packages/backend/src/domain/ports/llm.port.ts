// LLM port — abstract interface for LLM generation.
// Implementation: LlmService (OpenAI/Anthropic via LangChain).
// Unit tests can inject a mock LLM without API calls.

import type { BaseCallbackHandler } from './llm-primitives';

export const ILlmPort = Symbol('ILlmPort');

/**
 * Role of an LLM call — enables per-role provider routing (LLM_ROLE_CHAINS).
 * Creative roles (draft/hook) can be routed to stronger models while
 * analytical roles (critique/judge) stay on the cheapest chain.
 */
export type LlmRole = 'draft' | 'hook' | 'critique' | 'judge' | 'facts' | 'utility' | 'refine';

export interface GenerateOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Call role for provider routing and cache policy.
   * Creative roles ('draft', 'hook') bypass the response cache — identical
   * prompts should still produce fresh creative output.
   */
  role?: LlmRole;
  /**
   * LangChain callback handlers to attach to the LLM invocation.
   * Used for Langfuse tracing — pass a CallbackHandler to capture the call
   * as a nested observation under an existing trace.
   * Handlers with undefined entries are filtered out by the implementation.
   */
  callbacks?: BaseCallbackHandler[];
  /**
   * AbortSignal to cancel the in-flight LLM request.
   * Passed to LangChain's model.invoke() so the underlying HTTP request is aborted.
   */
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string;
  model: string;
  tokens?: number;
  cost?: number;
}

export function isLlmResponse(value: unknown): value is LlmResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['content'] === 'string' && typeof obj['model'] === 'string';
}

export interface ProviderStatus {
  name: string;
  model: string;
  circuitOpen: boolean;
  failures: number;
  rateLimitUntil: number;
  rateLimitStrikes: number;
  consecutive429s: number;
}

export interface ILlmPort {
  /**
   * Generate text from a prompt using the configured LLM provider.
   */
  generate(prompt: string, options?: GenerateOptions): Promise<LlmResponse>;

  /**
   * Generate text from a system + user prompt pair.
   */
  generateChat(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions,
  ): Promise<LlmResponse>;

  /**
   * Sprint J: Get the current prompt version for tracking in llmMetadata.
   */
  getPromptVersion?(): string;

  /**
   * Get provider circuit breaker + rate-limit status for monitoring.
   */
  getProviderStatus?(): ProviderStatus[];

  /**
   * Reset circuit breakers after fixing auth/billing issues.
   */
  resetCircuitBreakers?(providerNames?: string[]): void;
}
