import { Inject, Injectable, Logger } from "@nestjs/common";
import IORedis from "ioredis";
import { ConfigService } from "@nestjs/config";
import { SHARED_REDIS } from "../redis/redis.module.js";

export type BudgetScope = "orchestrator" | "generation";

interface BudgetConfig {
  tokenBudget: number; // 0 = unlimited
  costBudget: number; // 0 = unlimited
}

export class TokenBudgetExceeded extends Error {
  constructor(
    public readonly scope: BudgetScope,
    public readonly runId: string | undefined,
    public readonly reason: string,
  ) {
    super(`Token budget exceeded for ${scope}${runId ? ` run ${runId}` : ""}: ${reason}`);
    this.name = "TokenBudgetExceeded";
  }
}

/**
 * TokenBudgetService — tracks LLM token and cost consumption per scope.
 *
 * - Hourly scope (orchestrator): global bucket that resets every 60 minutes.
 * - Run scope (generation): one bucket per runId, reset after a 24-hour TTL.
 *
 * Uses a reserve/charge pattern: call `reserve()` before an LLM call with an
 * upper-bound estimate, then `charge()` the actual usage (or `release()` the
 * reservation and `charge()` actuals separately).
 */
@Injectable()
export class TokenBudgetService {
  private readonly logger = new Logger(TokenBudgetService.name);
  private readonly budgets: Record<BudgetScope, BudgetConfig>;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
  ) {
    this.budgets = {
      orchestrator: {
        tokenBudget: this.readNumber("ORCHESTRATOR_TOKEN_BUDGET_PER_HOUR"),
        costBudget: this.readNumber("ORCHESTRATOR_COST_BUDGET_PER_HOUR"),
      },
      generation: {
        tokenBudget: this.readNumber("GENERATION_TOKEN_BUDGET_PER_RUN"),
        costBudget: this.readNumber("GENERATION_COST_BUDGET_PER_RUN"),
      },
    };
  }

  /**
   * Reserve an upper-bound amount before an LLM call. If the budget is already
   * exceeded by the reservation, returns `allowed=false` and does NOT increment.
   */
  async reserve(
    scope: BudgetScope,
    runId: string | undefined,
    tokens: number,
    cost: number,
  ): Promise<{ allowed: boolean; remainingTokens: number; remainingCost: number }> {
    const config = this.budgets[scope];
    if (config.tokenBudget <= 0 && config.costBudget <= 0) {
      return { allowed: true, remainingTokens: Infinity, remainingCost: Infinity };
    }
    return this.atomicDelta(scope, runId, tokens, cost);
  }

  /**
   * Charge actual tokens/cost without a prior reservation. For small calls where
   * the real usage is known upfront (e.g. prompt already generated).
   */
  async charge(
    scope: BudgetScope,
    runId: string | undefined,
    tokens: number,
    cost: number,
  ): Promise<{ allowed: boolean; remainingTokens: number; remainingCost: number }> {
    const config = this.budgets[scope];
    if (config.tokenBudget <= 0 && config.costBudget <= 0) {
      return { allowed: true, remainingTokens: Infinity, remainingCost: Infinity };
    }
    return this.atomicDelta(scope, runId, tokens, cost);
  }

  /**
   * Release a prior reservation (negative delta). Usually called after `charge(actual)`
   * so the net is `actual`, or on a failed LLM call to undo the reservation.
   */
  async release(
    scope: BudgetScope,
    runId: string | undefined,
    tokens: number,
    cost: number,
  ): Promise<void> {
    const config = this.budgets[scope];
    if (config.tokenBudget <= 0 && config.costBudget <= 0) return;
    await this.atomicDelta(scope, runId, -tokens, -cost, false);
  }

  /**
   * Fetch current usage without reserving.
   */
  async getUsage(scope: BudgetScope, runId?: string): Promise<{ tokens: number; cost: number }> {
    const { tokenKey, costKey } = this.makeKeys(scope, runId);
    const [tokensRaw, costRaw] = await this.redis.mget(tokenKey, costKey);
    return {
      tokens: Number(tokensRaw ?? 0),
      cost: Number(costRaw ?? 0),
    };
  }

  private async atomicDelta(
    scope: BudgetScope,
    runId: string | undefined,
    tokenDelta: number,
    costDelta: number,
    enforce = true,
  ): Promise<{ allowed: boolean; remainingTokens: number; remainingCost: number }> {
    const config = this.budgets[scope];
    const { tokenKey, costKey, ttl } = this.makeKeys(scope, runId);

    const multi = this.redis.multi();
    if (config.tokenBudget > 0) multi.incrby(tokenKey, tokenDelta);
    if (config.costBudget > 0) multi.incrbyfloat(costKey, costDelta);
    if (config.tokenBudget > 0) multi.expire(tokenKey, ttl);
    if (config.costBudget > 0) multi.expire(costKey, ttl);

    const results = await multi.exec();
    // index 0/1 are the increments
    const tokenAfter = config.tokenBudget > 0 ? Number(results?.[0]?.[1] ?? 0) : 0;
    const costAfter = config.costBudget > 0 ? Number(results?.[1]?.[1] ?? 0) : 0;

    const tokenAllowed = config.tokenBudget <= 0 || tokenAfter <= config.tokenBudget;
    const costAllowed = config.costBudget <= 0 || costAfter <= config.costBudget;

    if (enforce && (!tokenAllowed || !costAllowed)) {
      this.logger.warn(
        `${scope}${runId ? ` run ${runId}` : ""} budget exceeded ` +
          `(tokens ${tokenAfter}/${config.tokenBudget}, cost ${costAfter.toFixed(4)}/${config.costBudget.toFixed(4)})`,
      );
      return {
        allowed: false,
        remainingTokens: Math.max(0, config.tokenBudget - tokenAfter),
        remainingCost: Math.max(0, config.costBudget - costAfter),
      };
    }

    return {
      allowed: true,
      remainingTokens: config.tokenBudget > 0 ? config.tokenBudget - tokenAfter : Infinity,
      remainingCost: config.costBudget > 0 ? config.costBudget - costAfter : Infinity,
    };
  }

  private makeKeys(
    scope: BudgetScope,
    runId: string | undefined,
  ): { tokenKey: string; costKey: string; ttl: number } {
    if (scope === "generation" && runId) {
      return {
        tokenKey: `spa:llm:run:${runId}:tokens`,
        costKey: `spa:llm:run:${runId}:cost`,
        ttl: 24 * 60 * 60,
      };
    }
    const now = new Date();
    const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    return {
      tokenKey: `spa:llm:hour:${hour}:${scope}:tokens`,
      costKey: `spa:llm:hour:${hour}:${scope}:cost`,
      ttl: 2 * 60 * 60,
    };
  }

  private readNumber(key: string): number {
    const raw = Number(this.configService.get<string>(key, "0"));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }
}
