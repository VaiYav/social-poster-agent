import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { TokenBudgetService } from "../../../src/infrastructure/llm/token-budget.service.js";

function makeService(
  redis: { eval: ReturnType<typeof vi.fn>; mget: ReturnType<typeof vi.fn> },
  costBudget = "0",
  accountDailyBudget = "0",
) {
  const config = {
    get: (key: string, fallback?: string) =>
      key === "GENERATION_TOKEN_BUDGET_PER_RUN"
        ? "100"
        : key === "GENERATION_COST_BUDGET_PER_RUN"
          ? costBudget
          : key === "LLM_DAILY_BUDGET_PER_ACCOUNT_USD"
            ? accountDailyBudget
            : fallback,
  } as unknown as ConfigService;
  return new TokenBudgetService(config, redis as never);
}

describe("TokenBudgetService", () => {
  it("does not increment usage when a reserve is denied", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([0, 90, 0.25]),
      mget: vi.fn().mockResolvedValue(["90", "0.25"]),
    };
    const service = makeService(redis);

    const result = await service.reserve("generation", "run-1", 20, 0.1);

    expect(result.allowed).toBe(false);
    expect(await service.getUsage("generation", "run-1")).toEqual({ tokens: 90, cost: 0.25 });
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval.mock.calls[0]?.[0]).toContain("return {0, token_before, cost_before}");
  });

  it("returns the atomically committed usage for an allowed reserve", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([1, 70, 0.1]),
      mget: vi.fn(),
    };
    const service = makeService(redis);

    await expect(service.reserve("generation", "run-2", 70, 0.1)).resolves.toMatchObject({
      allowed: true,
      remainingTokens: 30,
    });
  });

  it("normalizes string-valued Lua replies for cost budgets", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue(["1", "70", "0.1"]),
      mget: vi.fn(),
    };
    const service = makeService(redis, "0.3");

    const result = await service.reserve("generation", "run-3", 70, 0.1);

    expect(result).toMatchObject({
      allowed: true,
      remainingTokens: 30,
    });
    expect(result.remainingCost).toBeCloseTo(0.2);
  });

  it("supports an account-scoped daily cost reservation", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([1, 0, 0.4]),
      mget: vi.fn(),
    };
    const service = makeService(redis, "0", "1.0");

    await expect(service.reserve("account_daily", "account-1", 0, 0.4)).resolves.toMatchObject({
      allowed: true,
      remainingCost: 0.6,
    });
    expect(redis.eval.mock.calls[0]?.[1]).toBe(2);
    expect(redis.eval.mock.calls[0]?.[2]).toContain("spa:llm:account:account-1:day:");
  });
});
