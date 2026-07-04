// Prompt port — abstract interface for prompt management.
// Implementation: PromptRegistry (infrastructure/llm/prompt-registry.ts).
// Graph nodes and services depend on this port, not the concrete class,
// enabling hexagonal architecture compliance and easy mocking in tests.

/**
 * Result of compiling a chat prompt — system + user messages ready for
 * `ILlmPort.generateChat()`.
 */
export interface CompiledChatPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export const IPromptPort = Symbol('IPromptPort');

/**
 * Port for fetching and compiling prompts from a prompt management system
 * (Langfuse Prompt Management) with local fallback.
 *
 * Implementations try the remote prompt manager first, then fall back to
 * local templates or inline fallbacks provided by the caller.
 */
export interface IPromptPort {
  /**
   * Fetch and compile a chat prompt (system + user messages).
   *
   * @param name Prompt name in the prompt manager (e.g. 'research-extract')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback — used when neither the remote
   *   prompt manager nor the local registry has the prompt
   */
  getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback?: CompiledChatPrompt,
  ): Promise<CompiledChatPrompt>;

  /**
   * Fetch and compile a text prompt (single string).
   *
   * @param name Prompt name in the prompt manager (e.g. 'critique-post')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback text
   */
  getCompiledText(
    name: string,
    variables: Record<string, string>,
    fallback?: string,
  ): Promise<string>;

  /**
   * The active prompt version, sourced from PROMPT_VERSION env var.
   * Used for tracking in llmMetadata.
   */
  getCurrentVersion(): string;
}
