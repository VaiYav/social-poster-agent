// LLM port — abstract interface for LLM generation.
// Implementation: LlmService (OpenAI/Anthropic via LangChain).
// Unit tests can inject a mock LLM without API calls.

import type { BaseCallbackHandler } from "./llm-primitives.js";
import type { PromptReference } from "./prompt.port.js";

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

/** Stable router policy identifier attached to every concrete provider attempt. */
export type LlmFallbackPolicy =
  | "explicit_model_then_fallback"
  | "role_chain_then_fallback"
  | "sticky_provider_then_default"
  | "default_provider_chain";

export type LlmAttemptOutcome = "success" | "error" | "cache_hit";

/**
 * Provider-neutral error taxonomy for dashboards, release gates, and retries.
 * `none` is explicit on successful/cache-hit completion records.
 */
export type LlmNormalizedErrorCategory =
  | "none"
  | "rate_limit"
  | "auth"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "empty_output"
  | "aborted"
  | "budget_exceeded"
  | "unknown";

export type LlmCostSource = "provider" | "price_table" | "unknown";

/**
 * Secret-free, provider-attributed completion record for one router attempt.
 * Field names intentionally match the Langfuse metadata contract.
 */
export interface LlmAttemptTelemetry {
  llm_role: LlmRole | "unspecified";
  provider_requested: string;
  provider_actual: string;
  model_requested: string;
  model_actual: string;
  model_snapshot_or_alias: string;
  fallback_policy: LlmFallbackPolicy;
  attempt_index: number;
  fallback_depth: number;
  cache_hit: boolean;
  rate_limit_retry: boolean;
  reasoning_effort: string;
  temperature_sent: number | "not_sent";
  max_output_tokens?: number;
  outcome: LlmAttemptOutcome;
  normalized_error_category: LlmNormalizedErrorCategory;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  cost_source: LlmCostSource;
  latency_ms: number;
  time_to_first_token_ms?: number;
  error_status_code?: number;
  prompt_name?: string;
  prompt_version?: number;
  prompt_label?: string;
  prompt_is_fallback?: boolean;
  prompt_fallback_digest?: string;
}

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
  /** Stable Langfuse observation name for this logical graph node. */
  traceName?: string;
  /**
   * Exact prompt identity for this call. The native handle is consumed only by
   * Langfuse's prompt runnable and is never emitted as ordinary metadata.
   */
  promptReference?: PromptReference;
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
  /** Optional durable cost attribution context. */
  accountId?: string;
  postId?: string;
  /** F3: explicit provider/model override, e.g. "openai/gpt-5-nano". */
  model?: string;
}

export interface LlmResponse {
  content: string;
  model: string;
  tokens?: number;
  cost?: number;
  /** Provenance for cost telemetry; optional for legacy adapters and mocks. */
  costSource?: LlmCostSource;
  /** Additive EVAL-102 boundary; legacy consumers can ignore it. */
  attempts?: readonly LlmAttemptTelemetry[];
}

/** Typed failure boundary for callers that need router-attempt evidence. */
export class LlmTelemetryError extends Error {
  readonly normalized_error_category: LlmNormalizedErrorCategory;
  readonly attempts: readonly LlmAttemptTelemetry[];

  constructor(
    message: string,
    normalizedErrorCategory: LlmNormalizedErrorCategory,
    attempts: readonly LlmAttemptTelemetry[],
  ) {
    super(message);
    this.name = "LlmTelemetryError";
    this.normalized_error_category = normalizedErrorCategory;
    this.attempts = [...attempts];
  }
}

export function isLlmTelemetryError(value: unknown): value is LlmTelemetryError {
  return value instanceof LlmTelemetryError;
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
