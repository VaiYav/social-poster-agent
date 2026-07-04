// LLM port — abstract interface for LLM generation.
// Implementation: LlmService (OpenAI/Anthropic via LangChain).
// Unit tests can inject a mock LLM without API calls.

import type { BaseCallbackHandler } from './llm-primitives';

export const ILlmPort = Symbol('ILlmPort');

export interface GenerateOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * LangChain callback handlers to attach to the LLM invocation.
   * Used for Langfuse tracing — pass a CallbackHandler to capture the call
   * as a nested observation under an existing trace.
   * Handlers with undefined entries are filtered out by the implementation.
   */
  callbacks?: BaseCallbackHandler[];
}

export interface LlmResponse {
  content: string;
  model: string;
  tokens?: number;
  cost?: number;
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
}
