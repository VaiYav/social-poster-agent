import { Injectable, Logger, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';

/**
 * Rate limiter — Redis-based sliding window per network.
 *
 * CONSTITUTION §9: human-like delays + rate limits to avoid detection.
 * §8: max_posts_per_day: int ← default: 1
 * §9 red flags: «Постинг чаще 1/день/сеть»
 *
 * Limits (env-configurable, defaults are CONSERVATIVE = 1/day, 5/week):
 * - X: 1 post/day, 5 posts/week, 5 min min interval
 * - THREADS: 1 post/day, 5 posts/week, 5 min min interval
 * - FACEBOOK: 1 post/day, 5 posts/week, 5 min min interval
 *
 * Env vars (match .env.example):
 * - RATE_LIMIT_{NETWORK}_MAX_PER_DAY (default: 1)
 * - RATE_LIMIT_{NETWORK}_MAX_PER_WEEK (default: 5)
 * - RATE_LIMIT_MIN_DELAY_MS (default: 300000 = 5 min, applied to all networks)
 *
 * Uses Redis Lua script (EVAL) for atomic sliding window counters.
 * The script checks daily/weekly/interval limits and only increments if under the limit,
 * preventing the TOCTOU race between checkRateLimit and recordPost.
 *
 * Sprint L: Uses shared Redis connection from RedisModule.
 */

const DAILY_TTL_SECONDS = 86400 + 3600; // 25h
const WEEKLY_TTL_SECONDS = 7 * 86400 + 3600; // 7 days + 1h

/**
 * Lua script that atomically checks the current counters and only increments
 * the daily/weekly counters if the post is still within the configured limits.
 * Returns an array: { allowed, dailyCount, weeklyCount }.
 */
export const RECORD_POST_SCRIPT = `
local dailyKey = KEYS[1]
local weeklyKey = KEYS[2]
local intervalKey = KEYS[3]
local lastPostAtKey = KEYS[4]
local dailyLimit = tonumber(ARGV[1])
local weeklyLimit = tonumber(ARGV[2])
local intervalMs = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local dailyTtl = tonumber(ARGV[5])
local weeklyTtl = tonumber(ARGV[6])

local dailyCount = tonumber(redis.call('get', dailyKey) or '0')
if dailyLimit > 0 and dailyCount >= dailyLimit then
  return {0, dailyCount, tonumber(redis.call('get', weeklyKey) or '0')}
end

local weeklyCount = tonumber(redis.call('get', weeklyKey) or '0')
if weeklyLimit > 0 and weeklyCount >= weeklyLimit then
  return {0, dailyCount, weeklyCount}
end

local intervalTs = tonumber(redis.call('get', intervalKey) or '0')
if intervalMs > 0 and intervalTs > 0 and now - intervalTs < intervalMs then
  return {0, dailyCount, weeklyCount}
end

local newDaily = redis.call('incr', dailyKey)
if newDaily == 1 then
  redis.call('expire', dailyKey, dailyTtl)
end

local newWeekly = redis.call('incr', weeklyKey)
if newWeekly == 1 then
  redis.call('expire', weeklyKey, weeklyTtl)
end

redis.call('set', lastPostAtKey, now, 'PX', weeklyTtl)
if intervalMs > 0 then
  redis.call('set', intervalKey, now, 'PX', intervalMs)
end

return {1, newDaily, newWeekly}
`;
@Injectable()
export class RateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly prefix: string;

  // Per-network limits (env-configurable, defaults per constitution §8/§9)
  private readonly dailyLimits: Record<string, number>;
  private readonly weeklyLimits: Record<string, number>;
  private readonly minIntervalMs: Record<string, number>;

  // R1: interaction (engagement) limits — keyed by action (like/comment/follow/reply).
  private readonly interactionDailyLimits: Record<string, number>;
  private readonly interactionWeeklyLimits: Record<string, number>;
  private readonly interactionMinIntervalMs: number;
  private readonly failClosed: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
  ) {
    this.prefix = this.configService.get<string>('RATE_LIMIT_PREFIX', 'spa:ratelimit');
    this.failClosed = parseBool(this.configService.get<string>('RATE_LIMIT_FAIL_CLOSED', 'false'));

    // Global min delay between posts (env: RATE_LIMIT_MIN_DELAY_MS, default 5 min)
    const globalMinDelay = this.parseNumericConfig('RATE_LIMIT_MIN_DELAY_MS', 300_000);

    const networks = ['X', 'THREADS', 'FACEBOOK'] as const;

    this.dailyLimits = {};
    this.weeklyLimits = {};
    this.minIntervalMs = {};

    for (const net of networks) {
      // Read env vars matching .env.example: RATE_LIMIT_{NET}_MAX_PER_DAY
      this.dailyLimits[net] = this.parseNumericConfig(
        `RATE_LIMIT_${net}_MAX_PER_DAY`,
        1, // constitution §8 default: 1 post/day
      );

      this.weeklyLimits[net] = this.parseNumericConfig(
        `RATE_LIMIT_${net}_MAX_PER_WEEK`,
        5, // constitution §7 RateLimitConfig default: 5/week
      );

      this.minIntervalMs[net] = globalMinDelay;
    }

    // R1: interaction limits — separate from post limits so engagement keys like
    // "X-like" don't fall through to the 1/day post default (which silently capped
    // likes to 1/day and killed the per-session budget). The human-behavior engine
    // paces actions itself, so the interaction min-interval defaults to 0.
    const intDaily = (action: string, def: number) =>
      this.parseNumericConfig(`RATE_LIMIT_INTERACTION_${action.toUpperCase()}_MAX_PER_DAY`, def);
    const intWeekly = (action: string, def: number) =>
      this.parseNumericConfig(`RATE_LIMIT_INTERACTION_${action.toUpperCase()}_MAX_PER_WEEK`, def);
    this.interactionDailyLimits = {
      like: intDaily('like', 60),
      comment: intDaily('comment', 20),
      follow: intDaily('follow', 15),
      reply: intDaily('reply', 20),
      repost: intDaily('repost', 10),
      quote: intDaily('quote', 5),
    };
    this.interactionWeeklyLimits = {
      like: intWeekly('like', 300),
      comment: intWeekly('comment', 100),
      follow: intWeekly('follow', 75),
      reply: intWeekly('reply', 100),
      repost: intWeekly('repost', 50),
      quote: intWeekly('quote', 25),
    };
    this.interactionMinIntervalMs =
      this.parseNumericConfig('RATE_LIMIT_INTERACTION_MIN_DELAY_MS', 0);
  }

  /**
   * Resolve effective limits for a key. Composite keys "{NETWORK}-{action}"
   * (engagement) use interaction limits; bare network keys use post limits.
   */
  private resolveLimits(network: string): { daily: number; weekly: number; intervalMs: number } {
    const dashIdx = network.indexOf('-');
    if (dashIdx > 0) {
      const action = network.slice(dashIdx + 1).toLowerCase();
      if (action in this.interactionDailyLimits) {
        return {
          daily: this.interactionDailyLimits[action]!,
          weekly: this.interactionWeeklyLimits[action]!,
          intervalMs: this.interactionMinIntervalMs,
        };
      }
    }
    return {
      daily: this.dailyLimits[network] ?? 1,
      weekly: this.weeklyLimits[network] ?? 5,
      intervalMs: this.minIntervalMs[network] ?? 300_000,
    };
  }

  onModuleInit(): void {
    this.logger.log(
      `Rate limiter initialized (shared Redis connection) — ` +
        `limits: X=${this.dailyLimits['X']}/day ${this.weeklyLimits['X']}/week, ` +
        `THREADS=${this.dailyLimits['THREADS']}/day ${this.weeklyLimits['THREADS']}/week, ` +
        `FACEBOOK=${this.dailyLimits['FACEBOOK']}/day ${this.weeklyLimits['FACEBOOK']}/week`,
    );
  }

  onModuleDestroy(): void {
    // Sprint L: Redis connection is managed by RedisModule — don't close here
  }

  /**
   * Atomically read multiple string keys. Uses MGET when the Redis client supports it;
   * otherwise falls back to parallel GETs (for older test mocks).
   */
  private async getMultiple(keys: string[]): Promise<(string | null)[]> {
    if (typeof this.redis?.mget === 'function') {
      return this.redis.mget(keys);
    }
    const values = await Promise.all(keys.map((k) => this.redis!.get(k)));
    return values as (string | null)[];
  }

  /**
   * Parse a numeric config value from ConfigService, treating empty string as unset
   * and preserving `0` as a valid value.
   */
  private parseNumericConfig(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  /**
   * Check if a post is allowed under the rate limit for this network.
   * Returns { allowed, reason, retryAfterMs } — if not allowed, caller should defer.
   * retryAfterMs tells BullMQ / callers how long to wait before retrying.
   *
   * Checks in order: daily limit → weekly limit → min interval.
   * Does NOT increment counters — call recordPost() after successful post.
   */
  async checkRateLimit(network: string): Promise<{ allowed: boolean; reason?: string; retryAfterMs?: number }> {
    if (!this.redis) {
      // 2.7.3: optionally fail-closed when Redis is unavailable
      if (this.failClosed) {
        return {
          allowed: false,
          reason: 'Redis unavailable — rate limit check failed closed',
          retryAfterMs: 300_000,
        };
      }
      return { allowed: true, reason: 'Redis not connected — rate limit bypassed' };
    }

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const weekStartDate = this.getWeekStart();
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const dailyKey = `${this.prefix}:${network}:daily:${today}`;
    const weeklyKey = `${this.prefix}:${network}:weekly:${weekStart}`;
    const intervalKey = `${this.prefix}:${network}:interval`;
    const lastPostAtKey = `${this.prefix}:${network}:lastPostAt`;

    const { daily: dailyLimit, weekly: weeklyLimit, intervalMs } = this.resolveLimits(network);

    // 2.7.1: use a single MGET so daily/weekly/interval are read atomically.
    // Fall back to individual GETs for older test mocks that don't expose mget.
    const [dailyStr, weeklyStr, intervalStr, lastPostAtStr] = await this.getMultiple([
      dailyKey,
      weeklyKey,
      intervalKey,
      lastPostAtKey,
    ]);

    // Check daily limit (read-only — don't increment yet). A limit of 0 means unlimited.
    const dailyCount = parseInt(dailyStr ?? '0', 10);
    if (dailyLimit > 0 && dailyCount >= dailyLimit) {
      const nextDayStart = new Date(`${today}T00:00:00.000Z`).getTime() + 86_400_000;
      return {
        allowed: false,
        reason: `Daily limit reached for ${network} (${dailyCount}/${dailyLimit})`,
        retryAfterMs: Math.max(0, nextDayStart - now),
      };
    }

    // Check weekly limit. A limit of 0 means unlimited.
    const weeklyCount = parseInt(weeklyStr ?? '0', 10);
    if (weeklyLimit > 0 && weeklyCount >= weeklyLimit) {
      const nextWeekStart = weekStartDate.getTime() + 7 * 86_400_000;
      return {
        allowed: false,
        reason: `Weekly limit reached for ${network} (${weeklyCount}/${weeklyLimit})`,
        retryAfterMs: Math.max(0, nextWeekStart - now),
      };
    }

    // Check minimum interval (0 = no interval gate; engine paces interactions)
    if (intervalStr && intervalMs > 0) {
      const elapsed = now - parseInt(intervalStr, 10);
      if (elapsed < intervalMs) {
        const waitMs = intervalMs - elapsed;
        return {
          allowed: false,
          reason: `Rate limit: wait ${Math.ceil(waitMs / 1000)}s before next ${network} post`,
          retryAfterMs: waitMs,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record that a post was made — atomically checks daily/weekly/interval limits
   * and increments the counters only if the post is still within the limit.
   * Called after a successful post.
   *
   * 2.7: Uses a single Lua script to avoid the TOCTOU race between the read in
   * checkRateLimit and the increments in recordPost.
   */
  async recordPost(network: string): Promise<{ allowed: boolean; dailyCount: number; weeklyCount: number }> {
    const empty = { allowed: true, dailyCount: 0, weeklyCount: 0 };
    if (!this.redis) return empty;

    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart().toISOString().slice(0, 10);
    const dailyKey = `${this.prefix}:${network}:daily:${today}`;
    const weeklyKey = `${this.prefix}:${network}:weekly:${weekStart}`;
    const intervalKey = `${this.prefix}:${network}:interval`;
    const lastPostAtKey = `${this.prefix}:${network}:lastPostAt`;
    const { daily: dailyLimit, weekly: weeklyLimit, intervalMs } = this.resolveLimits(network);
    const now = Date.now();

    const result = (await this.redis.eval(
      RECORD_POST_SCRIPT,
      4,
      dailyKey,
      weeklyKey,
      intervalKey,
      lastPostAtKey,
      String(dailyLimit),
      String(weeklyLimit),
      String(intervalMs),
      String(now),
      String(DAILY_TTL_SECONDS),
      String(WEEKLY_TTL_SECONDS),
    )) as unknown as [number, number, number] | undefined;

    if (!result || !Array.isArray(result)) {
      this.logger.warn(`Redis eval returned unexpected result for ${network} — rate limit not recorded`);
      return empty;
    }

    const [allowed, dailyCount, weeklyCount] = result;
    if (!allowed) {
      this.logger.warn(
        `recordPost raced past rate limit for ${network} (` +
          `daily=${dailyCount}/${dailyLimit}, weekly=${weeklyCount}/${weeklyLimit}` +
          `) — not incrementing counter`,
      );
    }

    return { allowed: allowed === 1, dailyCount, weeklyCount };
  }

  /**
   * Reset rate limit counters for a network (and optional action suffix).
   * Useful for operational recovery when a limit was reached unintentionally.
   */
  async resetRateLimit(network: string): Promise<void> {
    if (!this.redis) return;

    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart().toISOString().slice(0, 10);
    const dailyKey = `${this.prefix}:${network}:daily:${today}`;
    const weeklyKey = `${this.prefix}:${network}:weekly:${weekStart}`;
    const intervalKey = `${this.prefix}:${network}:interval`;
    const lastPostAtKey = `${this.prefix}:${network}:lastPostAt`;

    await this.redis.del(dailyKey, weeklyKey, intervalKey, lastPostAtKey);
    this.logger.warn(`Rate limit counters reset for ${network}`);
  }

  /**
   * Get current rate limit status for a network.
   */
  async getStatus(network: string): Promise<{
    dailyCount: number;
    dailyLimit: number;
    weeklyCount: number;
    weeklyLimit: number;
    lastPostAt: number | null;
    minIntervalMs: number;
  }> {
    const { daily: dailyLimit, weekly: weeklyLimit, intervalMs } = this.resolveLimits(network);

    if (!this.redis) {
      return {
        dailyCount: 0,
        dailyLimit,
        weeklyCount: 0,
        weeklyLimit,
        lastPostAt: null,
        minIntervalMs: intervalMs,
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart().toISOString().slice(0, 10);
    const dailyKey = `${this.prefix}:${network}:daily:${today}`;
    const weeklyKey = `${this.prefix}:${network}:weekly:${weekStart}`;
    const intervalKey = `${this.prefix}:${network}:interval`;
    const lastPostAtKey = `${this.prefix}:${network}:lastPostAt`;

    const [dailyCountStr, weeklyCountStr, lastPostAtTs, intervalTs] = await Promise.all([
      this.redis.get(dailyKey),
      this.redis.get(weeklyKey),
      this.redis.get(lastPostAtKey),
      this.redis.get(intervalKey),
    ]);

    // lastPostAt is persisted for 7 days + 1h. Fall back to the shorter-lived
    // intervalKey for backward compatibility with data written before the split.
    const effectiveLastPostAt = lastPostAtTs ?? intervalTs;

    return {
      dailyCount: dailyCountStr ? parseInt(dailyCountStr, 10) : 0,
      dailyLimit,
      weeklyCount: weeklyCountStr ? parseInt(weeklyCountStr, 10) : 0,
      weeklyLimit,
      lastPostAt: effectiveLastPostAt ? parseInt(effectiveLastPostAt, 10) : null,
      minIntervalMs: intervalMs,
    };
  }

  /**
   * Get the ISO date string for the start of the current week (Monday-based).
   */
  // Minor-26 fix: use UTC instead of server local time for consistent week boundaries
  private getWeekStart(): Date {
    const now = new Date();
    const day = now.getUTCDay(); // 0 = Sunday (UTC)
    const diff = day === 0 ? -6 : 1 - day; // adjust to Monday
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
    return monday;
  }
}
