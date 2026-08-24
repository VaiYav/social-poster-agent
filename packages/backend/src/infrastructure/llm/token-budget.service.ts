import { Inject, Injectable, Logger } from "@nestjs/common";
import IORedis from "ioredis";
import { ConfigService } from "@nestjs/config";
import { SHARED_REDIS } from "../redis/redis.module.js";

export type BudgetScope = "orchestrator" | "generation" | "account_daily";

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
      account_daily: {
        tokenBudget: 0,
        costBudget: this.readNumber("LLM_DAILY_BUDGET_PER_ACCOUNT_USD"),
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

    // A MULTI increment-then-check can overshoot under concurrent callers.
    // Evaluate the check and write in one Redis operation instead.
    const rawResult = await this.redis.eval(
      `local token_before = tonumber(redis.call('GET', KEYS[1]) or '0')
       local cost_before = tonumber(redis.call('GET', KEYS[2]) or '0')
       local token_after = token_before + tonumber(ARGV[1])
       local cost_after = cost_before + tonumber(ARGV[2])
       local token_limit = tonumber(ARGV[3])
       local cost_limit = tonumber(ARGV[4])
       local enforce = tonumber(ARGV[5])
       if enforce == 1 and ((token_limit > 0 and token_after > token_limit) or (cost_limit > 0 and cost_after > cost_limit)) then
         return {0, token_before, cost_before}
       end
       if token_limit > 0 then redis.call('SET', KEYS[1], token_after, 'EX', ARGV[6]) end
       if cost_limit > 0 then redis.call('SET', KEYS[2], cost_after, 'EX', ARGV[6]) end
       return {1, token_after, cost_after}`,
      2,
      tokenKey,
      costKey,
      tokenDelta,
      costDelta,
      config.tokenBudget,
      config.costBudget,
      enforce ? 1 : 0,
      ttl,
    );
    if (!Array.isArray(rawResult) || rawResult.length < 3) {
      throw new Error("Token budget Redis script returned an invalid result");
    }
    const allowedFlag = Number(rawResult[0]);
    const tokenAfter = Number(rawResult[1]);
    const costAfter = Number(rawResult[2]);
    if (![allowedFlag, tokenAfter, costAfter].every(Number.isFinite)) {
      throw new Error("Token budget Redis script returned non-numeric usage");
    }
    const allowed = allowedFlag === 1;

    const tokenAllowed = config.tokenBudget <= 0 || tokenAfter <= config.tokenBudget;
    const costAllowed = config.costBudget <= 0 || costAfter <= config.costBudget;

    if (enforce && !allowed) {
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
    if (scope === "account_daily" && runId) {
      const day = new Date().toISOString().slice(0, 10);
      return {
        tokenKey: `spa:llm:account:${runId}:day:${day}:tokens`,
        costKey: `spa:llm:account:${runId}:day:${day}:cost`,
        ttl: 2 * 24 * 60 * 60,
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
