import { describe, expect, it, vi } from "vitest";
import { LlmUsageLedgerService } from "../../../src/infrastructure/llm/llm-usage-ledger.service.js";

describe("COST-001 LlmUsageLedgerService", () => {
  it("persists every provider attempt without secrets and preserves cache/outcome fields", async () => {
    const prisma = {
      llmUsageEvent: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    const service = new LlmUsageLedgerService(prisma as never);

    await service.recordAttempts(
      [
        {
          llm_role: "critique",
          provider_requested: "groq",
          provider_actual: "openai",
          model_requested: "cheap",
          model_actual: "gpt-5-nano",
          model_snapshot_or_alias: "gpt-5-nano",
          fallback_policy: "role_chain_then_fallback",
          attempt_index: 1,
          fallback_depth: 1,
          cache_hit: false,
          rate_limit_retry: false,
          reasoning_effort: "not_sent",
          temperature_sent: 0.2,
          outcome: "success",
          normalized_error_category: "none",
          input_tokens: 100,
          output_tokens: 20,
          cost_usd: 0.001,
          cost_source: "price_table",
          latency_ms: 120,
        },
      ],
      { accountId: "account-1", runId: "run-1" },
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.llmUsageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: "account-1",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5-nano",
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.001,
        cached: false,
        outcome: "success",
      }),
    });
  });

  it("does not propagate ledger database failures to the generation path", async () => {
    const prisma = {
      llmUsageEvent: { create: vi.fn() },
      $transaction: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const service = new LlmUsageLedgerService(prisma as never);

    await expect(service.recordAttempts([], { accountId: "account-1" })).resolves.toBeUndefined();
    await expect(
      service.recordAttempts(
        [
          {
            llm_role: "utility",
            provider_requested: "groq",
            provider_actual: "groq",
            model_requested: "m",
            model_actual: "m",
            model_snapshot_or_alias: "m",
            fallback_policy: "default_provider_chain",
            attempt_index: 0,
            fallback_depth: 0,
            cache_hit: false,
            rate_limit_retry: false,
            reasoning_effort: "not_sent",
            temperature_sent: "not_sent",
            outcome: "error",
            normalized_error_category: "timeout",
            cost_source: "unknown",
            latency_ms: 100,
          },
        ],
        {},
      ),
    ).resolves.toBeUndefined();
  });
});
