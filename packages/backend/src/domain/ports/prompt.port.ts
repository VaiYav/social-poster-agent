// Prompt port — abstract interface for prompt management.
// Implementation: PromptRegistry (infrastructure/prompt/prompt-registry.ts).
// Graph nodes and services depend on this port, not the concrete class,
// enabling hexagonal architecture compliance and easy mocking in tests.

/**
 * Result of compiling a chat prompt — system + user messages ready for
 * `ILlmPort.generateChat()`.
 */
export interface CompiledChatPrompt {
  systemPrompt: string;
  userPrompt: string;
  /** The resolved Langfuse label that produced this prompt content. */
  label?: string;
  /** Whether the content came from a fallback (inline or remote) instead of the requested label. */
  isFallback?: boolean;
}

export const IPromptPort = Symbol('IPromptPort');

/**
 * Optional intermediate fallback source for prompts.
 *
 * Implementations are injected as an array via `PROMPT_FALLBACK_PROVIDERS`.
 * PromptRegistry tries them between the remote prompt manager (Langfuse)
 * and the caller-provided inline fallback. This makes the fallback chain
 * extensible (OCP) — new sources (e.g. local JSON cache, S3) can be added
 * by binding to the token without modifying PromptRegistry.
 */
export interface IPromptFallbackProvider {
  tryGetChatPrompt(
    name: string,
    variables: Record<string, string>,
  ): Promise<CompiledChatPrompt | null>;
  tryGetTextPrompt(
    name: string,
    variables: Record<string, string>,
  ): Promise<string | null>;
}

/** DI token for the optional array of intermediate fallback providers. */
export const PROMPT_FALLBACK_PROVIDERS = Symbol('PROMPT_FALLBACK_PROVIDERS');

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
   * @param label Optional Langfuse label override; if omitted, the registry
   *   resolves from PROMPT_VERSION / PROMPT_VERSION_<NAME> env vars.
   */
  getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback?: CompiledChatPrompt,
    label?: string,
  ): Promise<CompiledChatPrompt>;

  /**
   * Fetch and compile a text prompt (single string).
   *
   * @param name Prompt name in the prompt manager (e.g. 'critique-post')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback text
   * @param label Optional Langfuse label override; if omitted, the registry
   *   resolves from PROMPT_VERSION / PROMPT_VERSION_<NAME> env vars.
   */
  getCompiledText(
    name: string,
    variables: Record<string, string>,
    fallback?: string,
    label?: string,
  ): Promise<string>;

  /**
   * The active prompt version, sourced from PROMPT_VERSION env var.
   * Used for tracking in llmMetadata.
   */
  getCurrentVersion(): string;
}
