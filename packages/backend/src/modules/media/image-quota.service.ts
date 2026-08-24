import { Inject, Injectable } from "@nestjs/common";
import IORedis from "ioredis";
import { ConfigService } from "@nestjs/config";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";

export interface ImageQuotaResult {
  readonly allowed: boolean;
  readonly reason?: "DAILY_LIMIT" | "COST_BUDGET";
  readonly count: number;
  readonly spentMicroUsd: number;
}

const RESERVE_SCRIPT = `
local count = tonumber(redis.call('get', KEYS[1]) or '0')
local spent = tonumber(redis.call('get', KEYS[2]) or '0')
local limit = tonumber(ARGV[1])
local budget = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
if limit > 0 and count + 1 > limit then return {0, 1, count, spent} end
if budget > 0 and spent + cost > budget then return {0, 2, count, spent} end
local nextCount = redis.call('incr', KEYS[1])
local nextSpent = redis.call('incrby', KEYS[2], cost)
redis.call('expire', KEYS[1], ttl)
redis.call('expire', KEYS[2], ttl)
return {1, 0, nextCount, nextSpent}
`;

const RELEASE_SCRIPT = `
local count = math.max(0, tonumber(redis.call('get', KEYS[1]) or '0') - 1)
local spent = math.max(0, tonumber(redis.call('get', KEYS[2]) or '0') - tonumber(ARGV[1]))
redis.call('set', KEYS[1], count)
redis.call('set', KEYS[2], spent)
return {count, spent}
`;

@Injectable()
export class ImageQuotaService {
  private readonly dailyLimit: number;
  private readonly budgetMicroUsd: number;

  constructor(
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
    config: ConfigService,
  ) {
    const limit = Number(config.get<string>("IMAGE_GENERATION_DAILY_LIMIT_PER_ACCOUNT", "3"));
    const budget = Number(config.get<string>("IMAGE_GENERATION_COST_BUDGET_USD_PER_DAY", "1"));
    this.dailyLimit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 3;
    this.budgetMicroUsd =
      Number.isFinite(budget) && budget >= 0 ? Math.round(budget * 1_000_000) : 1_000_000;
  }

  async reserve(
    accountId: string,
    estimatedCostUsd: number,
    limits?: { dailyLimit?: number; budgetUsd?: number },
  ): Promise<ImageQuotaResult> {
    const costMicroUsd = Math.max(0, Math.round(estimatedCostUsd * 1_000_000));
    const dailyLimit = limits?.dailyLimit ?? this.dailyLimit;
    const budgetMicroUsd = Math.round(
      (limits?.budgetUsd ?? this.budgetMicroUsd / 1_000_000) * 1_000_000,
    );
    const ttl = secondsUntilUtcDayEnd();
    const result = (await this.redis.eval(
      RESERVE_SCRIPT,
      2,
      `spa:imagegen:${accountId}:daily`,
      `spa:imagegen:${accountId}:budget`,
      dailyLimit,
      budgetMicroUsd,
      costMicroUsd,
      ttl,
    )) as [number, number, number, number];
    const [allowed, reasonCode, count, spentMicroUsd] = result;
    return {
      allowed: allowed === 1,
      ...(reasonCode === 1 ? { reason: "DAILY_LIMIT" as const } : {}),
      ...(reasonCode === 2 ? { reason: "COST_BUDGET" as const } : {}),
      count,
      spentMicroUsd,
    };
  }

  async release(accountId: string, reservedCostUsd: number): Promise<void> {
    await this.redis.eval(
      RELEASE_SCRIPT,
      2,
      `spa:imagegen:${accountId}:daily`,
      `spa:imagegen:${accountId}:budget`,
      Math.max(0, Math.round(reservedCostUsd * 1_000_000)),
    );
  }
}

function secondsUntilUtcDayEnd(): number {
  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((end.getTime() - now.getTime()) / 1000));
}
