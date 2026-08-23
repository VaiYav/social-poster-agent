/**
 * MOD-05: Infrastructure Adapters Module — LlmService unit tests.
 *
 * Tests multi-provider fallback chain, generate, generateChat, error handling,
 * and provider configuration.
 *
 * Source: packages/backend/src/infrastructure/llm/llm.service.ts
 * Traces to: REQ-001, REQ-002, REQ-NF-001
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock ChatOpenAI ──
// LlmService lazily creates ChatOpenAI instances per provider.
// We mock the constructor so no real API call is made.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  ChatOpenAIMock: vi.fn(),
}));

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: mocks.ChatOpenAIMock.mockImplementation(function (this: unknown, opts: unknown) {
    const model = {
      lc_runnable: true,
      model: (opts as { model?: string }).model,
      apiKey: (opts as { apiKey?: string }).apiKey,
      temperature: (opts as { temperature?: number }).temperature,
      configuration: (opts as { configuration?: unknown }).configuration,
      invoke: mocks.invoke,
      withConfig: (boundConfig: Record<string, unknown>) => ({
        lc_runnable: true,
        invoke: (input: unknown, runtimeConfig?: Record<string, unknown>) =>
          mocks.invoke(input, {
            ...runtimeConfig,
            ...boundConfig,
            metadata: {
              ...((runtimeConfig?.metadata as Record<string, unknown> | undefined) ?? {}),
              ...((boundConfig.metadata as Record<string, unknown> | undefined) ?? {}),
            },
          }),
      }),
    };
    return model;
  }),
}));

import { ConfigService } from "@nestjs/config";
import { BaseCallbackHandler as LangChainBaseCallbackHandler } from "@langchain/core/callbacks/base";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { BaseCallbackHandler } from "../../../src/domain/ports/llm-primitives.js";
import { LlmTelemetryError } from "../../../src/domain/ports/llm.port.js";
import type { IPromptPort, PromptReference } from "../../../src/domain/ports/prompt.port.js";
import { normalizeLlmErrorCategory } from "../../../src/infrastructure/llm/llm-attempt-telemetry.js";
import { LlmService } from "../../../src/infrastructure/llm/llm.service.js";
import {
  recordPromptReference,
  withPromptLabelContext,
} from "../../../src/infrastructure/prompt/prompt-label-context.js";
import {
  TokenBudgetExceeded,
  type TokenBudgetService,
} from "../../../src/infrastructure/llm/token-budget.service.js";
import { createMockRedis } from "../../mocks/index.js";

// ── Helpers ──

function createRateLimitError(
  retryAfter: string | null = "120",
): Error & { status: number; headers: Headers } {
  const err = new Error("429 rate limit") as Error & { status: number; headers: Headers };
  err.status = 429;
  if (retryAfter) {
    err.headers = new Headers([["retry-after", retryAfter]]);
  } else {
    err.headers = new Headers();
  }
  return err;
}

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    OPENAI_API_KEY: "test-openai-key",
    GROQ_API_KEY: "test-groq-key",
    GROQ_MODEL: "meta-llama/llama-4-scout-17b-16e-instruct",
    OPENROUTER_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    CEREBRAS_API_KEY: "",
    OLLAMA_URL: "http://localhost:11434",
    OLLAMA_DEFAULT_MODEL: "gemma4",
    LLM_DEFAULT_MODEL: "gpt-5-nano",
    LLM_CACHE_SHARED: "true",
    LLM_CACHE_KEY_PREFIX: "spa:cache:llm",
  };
  return {
    get: vi.fn(
      (key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue,
    ),
  } as unknown as ConfigService;
}

// ── Tests ──

describe("LlmService (MOD-05 — Infrastructure Adapters)", () => {
  let service: LlmService;
  let configService: ConfigService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockReset();
    configService = createMockConfigService();
    redis = createMockRedis();
    service = new LlmService(configService, redis);
  });

  // ── onModuleInit ──

  it("onModuleInit() builds provider chain from env vars", () => {
    service.onModuleInit();

    const status = service.getProviderStatus();
    // Groq + OpenAI + Ollama (Ollama always included as last resort)
    expect(status.length).toBeGreaterThanOrEqual(2);
    expect(status.some((p) => p.name === "groq")).toBe(true);
    expect(status.some((p) => p.name === "openai")).toBe(true);
    expect(status.some((p) => p.name === "ollama")).toBe(true);
  });

  it("onModuleInit() includes only providers with API keys (plus Ollama)", () => {
    const minimalConfig = createMockConfigService({
      OPENAI_API_KEY: "",
      GROQ_API_KEY: "groq-key",
      OPENROUTER_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      CEREBRAS_API_KEY: "",
    });
    const minimalService = new LlmService(minimalConfig, createMockRedis());
    minimalService.onModuleInit();

    const status = minimalService.getProviderStatus();
    // Only Groq + Ollama
    expect(status).toHaveLength(2);
    expect(status[0]!.name).toBe("groq");
    expect(status[1]!.name).toBe("ollama");
  });

  it("keeps configured provider order by default and opts into cost ordering explicitly", () => {
    service.onModuleInit();
    expect(service.getProviderStatus()[0]?.name).toBe("groq");

    const costAware = new LlmService(
      createMockConfigService({ LLM_COST_ROUTER_ENABLED: "true" }),
      createMockRedis(),
    );
    costAware.onModuleInit();
    expect(costAware.getProviderStatus()[0]?.name).toBe("groq");
  });

  it("onModuleInit() does not throw when no API keys are set", () => {
    const emptyConfig = createMockConfigService({
      OPENAI_API_KEY: "",
      GROQ_API_KEY: "",
      OPENROUTER_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      CEREBRAS_API_KEY: "",
    });
    const emptyService = new LlmService(emptyConfig, createMockRedis());

    expect(() => emptyService.onModuleInit()).not.toThrow();
    // Ollama is always included
    expect(emptyService.getProviderStatus()).toHaveLength(1);
  });

  // ── generateChat ──

  it("generateChat() invokes first provider (Groq) with system and user messages", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "LLM response text" });

    const result = await service.generateChat("You are helpful", "Write a tweet");

    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeArgs = mocks.invoke.mock.calls[0]![0];
    expect(invokeArgs).toHaveLength(2);
    expect(invokeArgs[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(invokeArgs[1]).toEqual({ role: "user", content: "Write a tweet" });

    expect(result.content).toBe("LLM response text");
    expect(result.model).toContain("groq");
  });

  it("COST-001 records provider attempts with durable attribution context", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "Ledgered response" });
    const ledger = { recordAttempts: vi.fn().mockResolvedValue(undefined) };
    (service as unknown as { usageLedger: typeof ledger }).usageLedger = ledger;

    await service.generateChat("system", "user", {
      role: "utility",
      accountId: "account-1",
      budgetRunId: "run-1",
    });

    expect(ledger.recordAttempts).toHaveBeenCalledWith(
      [expect.objectContaining({ provider_actual: "groq", outcome: "success" })],
      { accountId: "account-1", postId: undefined, runId: "run-1" },
    );
  });

  it("COST-001 fails closed before provider invocation when account daily cap rejects", async () => {
    const budget = {
      reserve: vi.fn().mockImplementation((scope: string) =>
        Promise.resolve({
          allowed: scope !== "account_daily",
          remainingTokens: 0,
          remainingCost: 0,
        }),
      ),
      charge: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const capped = new LlmService(configService, redis, undefined, budget as never);
    capped.onModuleInit();
    (capped as unknown as { providers: Array<{ name: string }> }).providers = (
      capped as unknown as { providers: Array<{ name: string }> }
    ).providers.filter((provider) => provider.name === "openai");
    mocks.invoke.mockResolvedValue({ content: "must not run" });

    await expect(
      capped.generateChat("system", "user", {
        accountId: "account-1",
        maxTokens: 100,
        model: "openai/gpt-5-nano",
      }),
    ).rejects.toThrow("All LLM providers failed");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("generateChat() bakes custom temperature into an immutable per-call instance (race fix)", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "response" });

    await service.generateChat("system", "user", { temperature: 0.2 });

    // Quality pass: temperature is no longer mutated on a shared instance —
    // a dedicated instance is constructed with the requested temperature.
    const ctorArgs = mocks.ChatOpenAIMock.mock.calls[0]![0];
    expect(ctorArgs.temperature).toBe(0.2);
  });

  it("BUG-13: generateChat() forwards maxTokens into the per-call instance", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "short" });

    await service.generateChat("system", "user", { maxTokens: 100 });

    // Quality pass: maxTokens is part of the constructor args / cache key now
    // (previously it was mutated on a shared instance — a concurrency race).
    const ctorArgs = mocks.ChatOpenAIMock.mock.calls[0]![0];
    expect(ctorArgs.maxTokens).toBe(100);
  });

  it("BUG-13: generateChat() defaults maxTokens to no-limit (-1) when not provided (no leak)", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "x" });

    await service.generateChat("system", "user");

    const ctorArgs = mocks.ChatOpenAIMock.mock.calls[0]![0];
    expect(ctorArgs.maxTokens).toBe(-1);
  });

  it("generateChat() handles string response content", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "plain string content" });

    const result = await service.generateChat("sys", "usr");

    expect(result.content).toBe("plain string content");
  });

  it("generateChat() JSON-stringifies non-string response content", async () => {
    service.onModuleInit();
    const objContent = { text: "hello", meta: { tokens: 50 } };
    mocks.invoke.mockResolvedValue({ content: objContent });

    const result = await service.generateChat("sys", "usr");

    expect(result.content).toBe(JSON.stringify(objContent));
  });

  // ── Fallback ──

  it("EVAL-102: attributes first-provider failure and second-provider success", async () => {
    service.onModuleInit();
    // First call (Groq) fails with a NON-rate-limit error → immediate failover.
    // (A 429/rate-limit error would now retry the SAME provider once first —
    // covered in tests/unit/llm/llm-service-routing.spec.ts LS-003.)
    mocks.invoke.mockRejectedValueOnce(new Error("Groq exploded")).mockResolvedValueOnce({
      content: "OpenAI response",
      usage_metadata: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_token_details: { cache_read: 3 },
        output_token_details: { reasoning: 2 },
      },
      response_metadata: { cost: 0.000_123 },
    });

    const result = await service.generateChat("sys", "usr", {
      role: "utility",
      maxTokens: 321,
      traceName: "generation.utility",
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("OpenAI response");
    expect(result.model).toBe("openai/gpt-5-nano");
    expect(result.cost).toBe(0.000_123);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts?.[0]).toMatchObject({
      provider_requested: "groq",
      provider_actual: "groq",
      model_requested: "meta-llama/llama-4-scout-17b-16e-instruct",
      model_actual: "meta-llama/llama-4-scout-17b-16e-instruct",
      attempt_index: 0,
      fallback_depth: 0,
      rate_limit_retry: false,
      outcome: "error",
      normalized_error_category: "unknown",
    });
    expect(result.attempts?.[1]).toMatchObject({
      provider_requested: "groq",
      provider_actual: "openai",
      model_requested: "meta-llama/llama-4-scout-17b-16e-instruct",
      model_actual: "gpt-5-nano",
      model_snapshot_or_alias: "gpt-5-nano",
      attempt_index: 1,
      fallback_depth: 1,
      rate_limit_retry: false,
      reasoning_effort: "not_sent",
      temperature_sent: "not_sent",
      max_output_tokens: 321,
      outcome: "success",
      normalized_error_category: "none",
      input_tokens: 11,
      output_tokens: 7,
      cached_input_tokens: 3,
      reasoning_tokens: 2,
      total_tokens: 18,
      cost_usd: 0.000_123,
      cost_source: "provider",
    });

    const attributedAttempts =
      result.attempts?.filter(
        (attempt) =>
          attempt.provider_actual.length > 0 &&
          attempt.model_actual.length > 0 &&
          attempt.provider_actual !== "openai-compatible",
      ) ?? [];
    expect(attributedAttempts.length / (result.attempts?.length ?? 1)).toBeGreaterThanOrEqual(0.99);

    const invokeMetadata = mocks.invoke.mock.calls.map(
      (call) => (call[1] as { metadata: Record<string, unknown> }).metadata,
    );
    expect(invokeMetadata).toEqual([
      expect.objectContaining({
        provider_requested: "groq",
        provider_actual: "groq",
        attempt_index: 0,
        fallback_depth: 0,
        cache_hit: false,
        rate_limit_retry: false,
      }),
      expect.objectContaining({
        provider_requested: "groq",
        provider_actual: "openai",
        attempt_index: 1,
        fallback_depth: 1,
        cache_hit: false,
        rate_limit_retry: false,
      }),
    ]);
    const serializedMetadata = JSON.stringify(invokeMetadata);
    expect(serializedMetadata).not.toContain("test-groq-key");
    expect(serializedMetadata).not.toContain("test-openai-key");
    expect(serializedMetadata).not.toMatch(/api[_-]?key|cookie|password/i);
  });

  it("generateChat() throws when all providers fail", async () => {
    service.onModuleInit();
    mocks.invoke.mockRejectedValue(new Error("All down"));

    await expect(service.generateChat("sys", "usr")).rejects.toThrow("All LLM providers failed");
  });

  it("reports LLM subsystem health after success and total failure", async () => {
    const resilience = { reportHealth: vi.fn().mockResolvedValue(undefined) };
    const resilientService = new LlmService(
      configService,
      createMockRedis(),
      undefined,
      undefined,
      resilience as never,
    );
    resilientService.onModuleInit();

    mocks.invoke.mockResolvedValueOnce({ content: "ok" });
    await resilientService.generateChat("sys", "success");
    expect(resilience.reportHealth).toHaveBeenCalledWith("llm", "HEALTHY");

    mocks.invoke.mockRejectedValue(new Error("providers down"));
    await expect(resilientService.generateChat("sys", "failure")).rejects.toThrow(
      "All LLM providers failed",
    );
    expect(resilience.reportHealth).toHaveBeenCalledWith(
      "llm",
      "CRITICAL",
      expect.stringContaining("All LLM providers failed"),
    );
  });

  it("generateChat() uses sticky provider after first success", async () => {
    service.onModuleInit();
    // Groq fails, OpenAI succeeds
    mocks.invoke
      .mockRejectedValueOnce(new Error("Groq down"))
      .mockResolvedValueOnce({ content: "OpenAI response" })
      .mockResolvedValueOnce({ content: "OpenAI response 2" });

    await service.generateChat("sys", "usr");
    const result2 = await service.generateChat("sys", "usr");

    // Second call should use OpenAI first (sticky)
    expect(result2.model).toContain("openai");
  });

  it("generateChat() rejects empty content and falls back", async () => {
    service.onModuleInit();
    mocks.invoke
      .mockResolvedValueOnce({ content: "" })
      .mockResolvedValueOnce({ content: "real content" });

    const result = await service.generateChat("sys", "usr");

    expect(result.content).toBe("real content");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts?.[0]).toMatchObject({
      provider_actual: "groq",
      outcome: "error",
      normalized_error_category: "empty_output",
    });
    expect(result.attempts?.[1]).toMatchObject({
      provider_actual: "openai",
      outcome: "success",
      normalized_error_category: "none",
    });
  });

  // ── generate ──

  it("generate() delegates to invokeWithFallback with user-only message", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "generated text" });

    const result = await service.generate("Write a haiku");

    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeArgs = mocks.invoke.mock.calls[0]![0];
    // No system prompt → only user message
    expect(invokeArgs).toHaveLength(1);
    expect(invokeArgs[0]).toEqual({ role: "user", content: "Write a haiku" });

    expect(result.content).toBe("generated text");
  });

  // ── LlmResponse shape ──

  it("generateChat() returns LlmResponse with content and model fields", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "test" });

    const result = await service.generateChat("sys", "usr");

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("model");
    expect(typeof result.content).toBe("string");
    expect(typeof result.model).toBe("string");
  });

  // ── getProviderStatus ──

  it("getProviderStatus() returns empty array before onModuleInit", () => {
    expect(service.getProviderStatus()).toEqual([]);
  });

  it("getProviderStatus() returns provider list after onModuleInit", () => {
    service.onModuleInit();
    const status = service.getProviderStatus();

    expect(status.length).toBeGreaterThan(0);
    expect(status[0]).toHaveProperty("name");
    expect(status[0]).toHaveProperty("model");
  });

  // ── Sprint J: Token Counting ──

  it("SJ-001: generate() returns response with tokens field (estimated)", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "This is a test response from the LLM" });

    const result = await service.generate("test prompt");

    expect(result.tokens).toBeDefined();
    expect(typeof result.tokens).toBe("number");
    expect(result.tokens!).toBeGreaterThan(0);
  });

  // ── Sprint J: Content Caching ──

  it("SJ-002: generate() returns cached response on second call with same prompt", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "cached response" });

    const result1 = await service.generate("identical prompt for cache test");
    const result2 = await service.generate("identical prompt for cache test");

    expect(result1.content).toBe("cached response");
    expect(result2.content).toBe("cached response");
    expect(result1.attempts?.[0]).toMatchObject({
      cache_hit: false,
      outcome: "success",
      attempt_index: 0,
    });
    expect(result1.costSource).toBe("unknown");
    expect(result2.attempts).toEqual([
      expect.objectContaining({
        provider_actual: "groq",
        model_actual: "meta-llama/llama-4-scout-17b-16e-instruct",
        cache_hit: true,
        outcome: "cache_hit",
        normalized_error_category: "none",
        attempt_index: 0,
        fallback_depth: 0,
      }),
    ]);
    expect(result2.attempts?.[0]?.cost_source).toBe("unknown");
    // invoke should only be called once (second call hits cache)
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("SJ-003: clearCache() forces next call to invoke LLM again", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "response" });

    await service.generate("cache clear test prompt");
    await service.clearCache();
    await service.generate("cache clear test prompt");

    // After clearCache, invoke should be called twice
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("SJ-004: getCacheStats() returns cache size, max size, and TTL", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "test" });

    await service.generate("cache stats test");

    const stats = await service.getCacheStats();
    expect(stats).toHaveProperty("size");
    expect(stats).toHaveProperty("maxSize");
    expect(stats).toHaveProperty("ttlMs");
    expect(stats.size).toBeGreaterThan(0);
  });

  // ── Sprint J: Circuit Breaker ──

  it("SJ-005: circuit breaker trips after threshold failures, skips provider", async () => {
    service.onModuleInit();
    // Make invoke fail for all calls (triggers circuit breaker)
    mocks.invoke.mockRejectedValue(new Error("provider down"));

    // First call — all providers fail
    await expect(service.generate("cb test 1")).rejects.toThrow();

    // Get provider status — should show failures
    const status = service.getProviderStatus();
    expect(status.length).toBeGreaterThan(0);
    // At least one provider should have failures > 0
    const hasFailures = status.some((s) => s.failures > 0);
    expect(hasFailures).toBe(true);
  });

  it("SJ-006: getProviderStatus() includes circuitOpen and failures fields", () => {
    service.onModuleInit();
    const status = service.getProviderStatus();

    expect(status[0]).toHaveProperty("circuitOpen");
    expect(status[0]).toHaveProperty("failures");
    expect(typeof status[0]!.circuitOpen).toBe("boolean");
    expect(typeof status[0]!.failures).toBe("number");
  });

  it("SQ-001: getProviderStatus() includes rate-limit cooldown fields", () => {
    service.onModuleInit();
    const status = service.getProviderStatus();

    expect(status[0]).toHaveProperty("rateLimitUntil");
    expect(status[0]).toHaveProperty("rateLimitStrikes");
    expect(status[0]).toHaveProperty("consecutive429s");
    expect(typeof status[0]!.rateLimitUntil).toBe("number");
    expect(typeof status[0]!.rateLimitStrikes).toBe("number");
    expect(typeof status[0]!.consecutive429s).toBe("number");
  });

  // ── Sprint Q: Rate-limit backoff ──

  it("EVAL-102: same-provider rate-limit retry has a new index without fallback depth", async () => {
    service.onModuleInit();
    mocks.invoke.mockRejectedValueOnce(createRateLimitError("0.001")).mockResolvedValueOnce({
      content: "Groq retry response",
      usage_metadata: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    });

    const result = await service.generateChat("sys", "usr", { role: "utility" });

    expect(result.model).toBe("groq/meta-llama/llama-4-scout-17b-16e-instruct");
    expect(result.attempts).toEqual([
      expect.objectContaining({
        provider_actual: "groq",
        attempt_index: 0,
        fallback_depth: 0,
        rate_limit_retry: false,
        normalized_error_category: "rate_limit",
        outcome: "error",
      }),
      expect.objectContaining({
        provider_actual: "groq",
        attempt_index: 1,
        fallback_depth: 0,
        rate_limit_retry: true,
        normalized_error_category: "none",
        outcome: "success",
      }),
    ]);
    expect(
      (mocks.invoke.mock.calls[1]?.[1] as { metadata: Record<string, unknown> }).metadata,
    ).toMatchObject({ attempt_index: 1, fallback_depth: 0, rate_limit_retry: true });
  });

  it("SQ-002: long Retry-After header fails over and sets rate-limit cooldown", async () => {
    service.onModuleInit();
    const err = createRateLimitError("120");

    mocks.invoke.mockRejectedValueOnce(err).mockResolvedValueOnce({ content: "OpenAI response" });

    const result = await service.generateChat("sys", "usr");

    expect(result.content).toBe("OpenAI response");
    expect(result.model).toContain("openai");
    // Groq is put in cooldown, not retried on the same provider.
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    const status = service.getProviderStatus();
    const groq = status.find((s) => s.name === "groq");
    expect(groq?.consecutive429s).toBe(1);
    expect(groq?.rateLimitUntil).toBeGreaterThan(Date.now());
  });

  it("SQ-003: resetCircuitBreakers also clears rate-limit cooldown", async () => {
    service.onModuleInit();
    const err = createRateLimitError("120");

    mocks.invoke.mockRejectedValueOnce(err).mockResolvedValueOnce({ content: "OpenAI response" });
    await service.generateChat("sys", "usr");

    let status = service.getProviderStatus();
    expect(status.find((s) => s.name === "groq")?.rateLimitUntil).toBeGreaterThan(Date.now());

    service.resetCircuitBreakers(["groq"]);
    status = service.getProviderStatus();
    expect(status.find((s) => s.name === "groq")?.rateLimitUntil).toBe(0);
  });

  it("EVAL-102: aborting an in-flight invocation returns structured aborted telemetry", async () => {
    service.onModuleInit();
    const controller = new AbortController();
    mocks.invoke.mockImplementation(
      (_messages: unknown, config: { signal?: AbortSignal } | undefined) =>
        new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
          if (config?.signal?.aborted) {
            rejectAbort();
            return;
          }
          config?.signal?.addEventListener("abort", rejectAbort, { once: true });
        }),
    );

    const outcome = service
      .generateChat("sys", "usr", { role: "utility", signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    controller.abort();
    const error = await outcome;

    expect(error).toBeInstanceOf(LlmTelemetryError);
    if (!(error instanceof LlmTelemetryError)) throw new Error("Expected LlmTelemetryError");
    expect(error.message).toBe("Abort");
    expect(error.normalized_error_category).toBe("aborted");
    expect(error.attempts).toEqual([
      expect.objectContaining({
        provider_actual: "groq",
        attempt_index: 0,
        fallback_depth: 0,
        outcome: "error",
        normalized_error_category: "aborted",
      }),
    ]);
  });

  it("EVAL-102: budget denial is exposed as structured attempt telemetry", async () => {
    const deniedBudget = {
      reserve: vi.fn().mockResolvedValue({
        allowed: false,
        remainingTokens: 0,
        remainingCost: 0,
      }),
      release: vi.fn().mockResolvedValue(undefined),
      charge: vi.fn().mockResolvedValue(undefined),
    } as unknown as TokenBudgetService;
    const deniedService = new LlmService(configService, redis, undefined, deniedBudget);
    deniedService.onModuleInit();

    const error = await deniedService
      .generateChat("sys", "usr", {
        role: "utility",
        budgetScope: "generation",
        budgetRunId: "synthetic-run",
        maxTokens: 100,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmTelemetryError);
    if (!(error instanceof LlmTelemetryError)) throw new Error("Expected LlmTelemetryError");
    expect(error.normalized_error_category).toBe("budget_exceeded");
    expect(error.attempts.length).toBeGreaterThan(0);
    expect(error.attempts.every((attempt) => attempt.outcome === "error")).toBe(true);
    expect(
      error.attempts.every((attempt) => attempt.normalized_error_category === "budget_exceeded"),
    ).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["rate_limit", createRateLimitError("1")],
    ["auth", Object.assign(new Error("unauthorized"), { status: 401 })],
    ["billing", Object.assign(new Error("insufficient quota"), { status: 402 })],
    ["timeout", Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })],
    ["model_not_found", Object.assign(new Error("model not found"), { status: 404 })],
    ["empty_output", new Error("provider returned empty output")],
    ["aborted", new DOMException("The operation was aborted", "AbortError")],
    [
      "budget_exceeded",
      new TokenBudgetExceeded("generation", "synthetic-run", "pre-call reserve over budget"),
    ],
    ["unknown", new Error("unclassified provider failure")],
  ] as const)("EVAL-102: normalizes %s errors", (expected, error) => {
    expect(normalizeLlmErrorCategory(error)).toBe(expected);
  });

  // ── Sprint J: Prompt Versioning ──

  it("SJ-007: getPromptVersion() returns version string", () => {
    const version = service.getPromptVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  // ── Langfuse tracing: callbacks propagation ──

  it("LF-001: generateChat() passes callbacks to model.invoke when provided in options", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "traced response" });

    const fakeHandler = { name: "LangfuseCallbackHandler" } as BaseCallbackHandler;
    await service.generateChat("sys", "usr", { callbacks: [fakeHandler] });

    // model.invoke should receive { callbacks: [...] } as the second arg
    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeCall = mocks.invoke.mock.calls[0]!;
    expect(invokeCall[0]).toHaveLength(2); // system + user messages
    expect(invokeCall[1]).toBeDefined();
    expect((invokeCall[1] as { callbacks: unknown[] }).callbacks).toContain(fakeHandler);
  });

  it("LF-002/EVAL-102: no-callback path stays callback-free while carrying attempt metadata", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "response" });

    await service.generateChat("sys", "usr");

    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeCall = mocks.invoke.mock.calls[0]!;
    const invokeConfig = invokeCall[1] as {
      callbacks?: BaseCallbackHandler[];
      metadata: Record<string, unknown>;
    };
    expect(invokeConfig.callbacks).toBeUndefined();
    expect(invokeConfig.metadata).toMatchObject({
      provider_requested: "groq",
      provider_actual: "groq",
      model_actual: "meta-llama/llama-4-scout-17b-16e-instruct",
      attempt_index: 0,
      fallback_depth: 0,
      cache_hit: false,
      rate_limit_retry: false,
    });
  });

  it("LF-003: generateChat() passes stable observation name and role metadata", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "named response" });

    await service.generateChat("sys", "usr", {
      role: "draft",
      traceName: "generation.draft.X",
    });

    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeCall = mocks.invoke.mock.calls[0]!;
    expect(invokeCall[1]).toMatchObject({
      runName: "generation.draft.X",
      metadata: { llm_role: "draft" },
    });
  });

  it("EVAL-103: links two LLM calls through separate native prompt runnables", async () => {
    service.onModuleInit();
    mocks.invoke
      .mockResolvedValueOnce({ content: "research response" })
      .mockResolvedValueOnce({ content: "draft response" });
    const sensitiveResearchSource = "private research prompt source must not be metadata";
    const sensitiveDraftSource = "private draft prompt source must not be metadata";
    const researchClient = {
      name: "research-extract",
      version: 7,
      isFallback: false,
      prompt: sensitiveResearchSource,
    };
    const draftClient = {
      name: "draft-post",
      version: 12,
      isFallback: false,
      prompt: sensitiveDraftSource,
    };
    const researchReference: PromptReference = {
      name: "research-extract",
      label: "production",
      version: 7,
      isFallback: false,
      nativePrompt: researchClient,
    };
    const draftReference: PromptReference = {
      name: "draft-post",
      label: "candidate",
      version: 12,
      isFallback: false,
      nativePrompt: draftClient,
    };
    const handler = LangChainBaseCallbackHandler.fromMethods({});
    const promptConfigSpy = vi.spyOn(ChatPromptTemplate.prototype, "withConfig");

    try {
      const { research, draft } = await withPromptLabelContext(async () => {
        recordPromptReference("research system", "research user", researchReference);
        recordPromptReference("draft system", "draft user", draftReference);
        const research = await service.generateChat("research system", "research user", {
          callbacks: [handler],
          role: "draft",
          traceName: "generation.research_extract",
        });
        const draft = await service.generateChat("draft system", "draft user", {
          callbacks: [handler],
          role: "draft",
          traceName: "generation.draft.X",
        });
        return { research, draft };
      });

      const linkedPrompts = promptConfigSpy.mock.calls
        .map(([config]) => config.metadata?.langfusePrompt)
        .filter((prompt): prompt is object => typeof prompt === "object" && prompt !== null);
      expect(linkedPrompts).toEqual([researchClient, draftClient]);

      const generationMetadata = mocks.invoke.mock.calls.map(
        (call) => (call[1] as { metadata: Record<string, unknown> }).metadata,
      );
      expect(generationMetadata).toEqual([
        expect.objectContaining({
          prompt_name: "research-extract",
          prompt_label: "production",
          prompt_version: 7,
          prompt_is_fallback: false,
        }),
        expect.objectContaining({
          prompt_name: "draft-post",
          prompt_label: "candidate",
          prompt_version: 12,
          prompt_is_fallback: false,
        }),
      ]);
      expect(generationMetadata[0]).not.toHaveProperty("langfusePrompt");
      expect(generationMetadata[1]).not.toHaveProperty("langfusePrompt");
      const emittedMetadata = JSON.stringify({ generationMetadata, research, draft });
      expect(emittedMetadata).not.toContain(sensitiveResearchSource);
      expect(emittedMetadata).not.toContain(sensitiveDraftSource);
    } finally {
      promptConfigSpy.mockRestore();
    }
  });

  it("EVAL-103: fallback identity emits digest and label without a native version link", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "fallback response" });
    const fallbackDigest = "a".repeat(64);
    const handler = LangChainBaseCallbackHandler.fromMethods({});
    const promptConfigSpy = vi.spyOn(ChatPromptTemplate.prototype, "withConfig");

    try {
      const result = await service.generateChat("fallback system", "fallback user", {
        callbacks: [handler],
        role: "refine",
        promptReference: {
          name: "refine-post",
          label: "production",
          isFallback: true,
          fallbackDigest,
        },
      });

      expect(promptConfigSpy).not.toHaveBeenCalled();
      const metadata = (mocks.invoke.mock.calls[0]?.[1] as { metadata: Record<string, unknown> })
        .metadata;
      expect(metadata).toMatchObject({
        prompt_name: "refine-post",
        prompt_label: "production",
        prompt_is_fallback: true,
        prompt_fallback_digest: fallbackDigest,
      });
      expect(metadata).not.toHaveProperty("prompt_version");
      expect(result.attempts?.[0]).not.toHaveProperty("prompt_version");
    } finally {
      promptConfigSpy.mockRestore();
    }
  });

  it("EVAL-103: consumes a direct caller reference from the prompt port", async () => {
    const nativePrompt = {
      name: "orchestrator-system",
      version: 6,
      isFallback: false,
    };
    const consumePromptReference = vi.fn().mockReturnValue({
      name: "orchestrator-system",
      label: "production",
      version: 6,
      isFallback: false,
      nativePrompt,
    } satisfies PromptReference);
    const promptPort = {
      getCurrentVersion: () => "production",
      consumePromptReference,
    } as unknown as IPromptPort;
    const directService = new LlmService(configService, redis, promptPort);
    directService.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "decision" });
    const handler = LangChainBaseCallbackHandler.fromMethods({});
    const promptConfigSpy = vi.spyOn(ChatPromptTemplate.prototype, "withConfig");

    try {
      await directService.generateChat("", "orchestrator prompt", {
        callbacks: [handler],
        role: "utility",
        traceName: "orchestrator.decision",
      });

      expect(consumePromptReference).toHaveBeenCalledWith("", "orchestrator prompt");
      expect(promptConfigSpy.mock.calls[0]?.[0].metadata?.langfusePrompt).toBe(nativePrompt);
      expect(
        (mocks.invoke.mock.calls[0]?.[1] as { metadata: Record<string, unknown> }).metadata,
      ).toMatchObject({
        prompt_name: "orchestrator-system",
        prompt_label: "production",
        prompt_version: 6,
        prompt_is_fallback: false,
      });
    } finally {
      promptConfigSpy.mockRestore();
    }
  });

  it("EVAL-103: no-handler path stays direct even when a native reference is present", async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: "untraced response" });
    const promptConfigSpy = vi.spyOn(ChatPromptTemplate.prototype, "withConfig");

    try {
      await service.generateChat("system", "user", {
        role: "draft",
        promptReference: {
          name: "draft-post",
          label: "production",
          version: 8,
          isFallback: false,
          nativePrompt: { name: "draft-post", version: 8, isFallback: false },
        },
      });

      expect(promptConfigSpy).not.toHaveBeenCalled();
      expect(mocks.invoke.mock.calls[0]?.[0]).toEqual([
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ]);
    } finally {
      promptConfigSpy.mockRestore();
    }
  });
});
