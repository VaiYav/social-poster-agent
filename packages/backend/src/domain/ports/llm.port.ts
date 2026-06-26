// LLM port — abstract interface for LLM generation.
// Implementation: LlmService (OpenAI/Anthropic via LangChain).
// Unit tests can inject a mock LLM without API calls.

export const ILlmPort = Symbol('ILlmPort');

export interface GenerateOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
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
}
