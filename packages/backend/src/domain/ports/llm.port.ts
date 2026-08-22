// LLM port — abstract interface for LLM generation.
// Implementation: LlmService (OpenAI/Anthropic via LangChain).
// Unit tests can inject a mock LLM without API calls.

import type { BaseCallbackHandler } from "./llm-primitives.js";

export const ILlmPort = Symbol("ILlmPort");

/**
 * Role of an LLM call — enables per-role provider routing (LLM_ROLE_CHAINS).
 * Creative roles (draft/hook) can be routed to stronger models while
 * analytical roles (critique/judge) stay on the cheapest chain.
 */
export type LlmRole =
  | "draft"
  | "hook"
  | "critique"
  | "judge"
  | "facts"
  | "utility"
  | "refine"
  | "vision"
  | "outline";

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
  /**
   * P0: token/cost budget scope. 'orchestrator' is hourly; 'generation' is per-run.
   */
  budgetScope?: "orchestrator" | "generation";
  /** P0: generation run ID for per-run budget tracking. */
  budgetRunId?: string;
  /** F3: explicit provider/model override, e.g. "openai/gpt-5-nano". */
  model?: string;
}

export interface LlmResponse {
  content: string;
  model: string;
  tokens?: number;
  cost?: number;
}

export function isLlmResponse(value: unknown): value is LlmResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["content"] === "string" && typeof obj["model"] === "string";
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
   * Generate text from a system + user prompt pair WITH a screenshot image.
   * Used by the LLM-in-the-loop browser engine (BrowserAgentService #47).
   *
   * The image is passed as a base64-encoded PNG data URL. The LLM sees the
   * screenshot and the text prompt, and returns a text response (action
   * decision, extracted data, verification result, etc.).
   *
   * Providers that support vision: OpenAI (gpt-4o), Anthropic (Claude 3.5),
   * Google Gemini, OpenRouter (vision models). The free-first router will
   * skip providers that don't support vision — see LlmService for routing.
   *
   * @param systemPrompt - System prompt (instructions for the LLM)
   * @param userPrompt - User prompt (the question/task)
   * @param imageBase64 - Base64-encoded PNG image (data:image/png;base64,...)
   * @param options - Generation options (role='vision' routes to vision-capable providers)
   * @returns LLM response with text content
   */
  generateVision(
    systemPrompt: string,
    userPrompt: string,
    imageBase64: string,
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
