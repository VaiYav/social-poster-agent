import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

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
 * Uses Redis INCR + EXPIRE for atomic sliding window counters.
 */
@Injectable()
export class RateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly redisUrl: string;
  private readonly prefix: string;
  private redis: IORedis | null = null;

  // Per-network limits (env-configurable, defaults per constitution §8/§9)
  private readonly dailyLimits: Record<string, number>;
  private readonly weeklyLimits: Record<string, number>;
  private readonly minIntervalMs: Record<string, number>;

  constructor(private readonly configService: ConfigService) {
    this.redisUrl = this.configService.get<string>('REDIS_URL', 'redis://localhost:6381');
    this.prefix = this.configService.get<string>('RATE_LIMIT_PREFIX', 'spa:ratelimit');

    // Global min delay between posts (env: RATE_LIMIT_MIN_DELAY_MS, default 5 min)
    const globalMinDelay = this.configService.get<number>('RATE_LIMIT_MIN_DELAY_MS', 300_000);

    const networks = ['X', 'THREADS', 'FACEBOOK'] as const;

    this.dailyLimits = {};
    this.weeklyLimits = {};
    this.minIntervalMs = {};

    for (const net of networks) {
      // Read env vars matching .env.example: RATE_LIMIT_{NET}_MAX_PER_DAY
      this.dailyLimits[net] = this.configService.get<number>(
        `RATE_LIMIT_${net}_MAX_PER_DAY`,
        1, // constitution §8 default: 1 post/day
      );

      this.weeklyLimits[net] = this.configService.get<number>(
        `RATE_LIMIT_${net}_MAX_PER_WEEK`,
        5, // constitution §7 RateLimitConfig default: 5/week
      );

      this.minIntervalMs[net] = globalMinDelay;
    }
  }

  onModuleInit(): void {
    this.redis = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    this.logger.log(
      `Rate limiter connected to Redis (${this.redisUrl}) — ` +
        `limits: X=${this.dailyLimits['X']}/day ${this.weeklyLimits['X']}/week, ` +
        `THREADS=${this.dailyLimits['THREADS']}/day ${this.weeklyLimits['THREADS']}/week, ` +
        `FACEBOOK=${this.dailyLimits['FACEBOOK']}/day ${this.weeklyLimits['FACEBOOK']}/week`,
    );
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
    this.logger.log('Rate limiter Redis connection closed');
  }

  /**
   * Check if a post is allowed under the rate limit for this network.
   * Returns { allowed, reason } — if not allowed, caller should defer.
   *
   * Checks in order: daily limit → weekly limit → min interval.
   * Does NOT increment counters — call recordPost() after successful post.
   */
  async checkRateLimit(network: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.redis) {
      return { allowed: true, reason: 'Redis not connected — rate limit bypassed' };
    }

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart().toISOString().slice(0, 10);
    const dailyKey = `${this.prefix}:${network}:daily:${today}`;
    const weeklyKey = `${this.prefix}:${network}:weekly:${weekStart}`;
    const intervalKey = `${this.prefix}:${network}:interval`;

    // Check daily limit (read-only — don't increment yet)
    const dailyCount = parseInt((await this.redis.get(dailyKey)) ?? '0', 10);
    const dailyLimit = this.dailyLimits[network] ?? 1;
    if (dailyCount >= dailyLimit) {
      return {
        allowed: false,
        reason: `Daily limit reached for ${network} (${dailyCount}/${dailyLimit})`,
      };
    }

    // Check weekly limit
    const weeklyCount = parseInt((await this.redis.get(weeklyKey)) ?? '0', 10);
    const weeklyLimit = this.weeklyLimits[network] ?? 5;
    if (weeklyCount >= weeklyLimit) {
      return {
        allowed: false,
        reason: `Weekly limit reached for ${network} (${weeklyCount}/${weeklyLimit})`,
      };
    }

    // Check minimum interval between posts
    const lastPostTs = await this.redis.get(intervalKey);
    const intervalMs = this.minIntervalMs[network] ?? 300_000;
    if (lastPostTs) {
      const elapsed = now - parseInt(lastPostTs, 10);
      if (elapsed < intervalMs) {
        const waitMs = intervalMs - elapsed;
        return {
          allowed: false,
          reason: `Rate limit: wait ${Math.ceil(waitMs / 1000)}s before next ${network} post`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record that a post was made — increments daily/weekly counters + updates interval timestamp.
   * Called after a successful post.
   */
  async recordPost(network: string): Promise<void> {
    if (!this.redis) return;

    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart().toISOString().slice(0, 10);
    const dailyKey = `${this.prefix}:${network}:daily:${today}`;
    const weeklyKey = `${this.prefix}:${network}:weekly:${weekStart}`;
    const intervalKey = `${this.prefix}:${network}:interval`;
    const intervalMs = this.minIntervalMs[network] ?? 300_000;

    // Increment daily counter (set TTL on first increment)
    const dailyCount = await this.redis.incr(dailyKey);
    if (dailyCount === 1) {
      await this.redis.expire(dailyKey, 86400 + 3600); // 25h TTL
    }

    // Increment weekly counter (set TTL on first increment)
    const weeklyCount = await this.redis.incr(weeklyKey);
    if (weeklyCount === 1) {
      await this.redis.expire(weeklyKey, 7 * 86400 + 3600); // 7 days + 1h TTL
    }

    // Update interval timestamp
    await this.redis.set(intervalKey, Date.now().toString(), 'PX', intervalMs);
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
    if (!this.redis) {
      return {
        dailyCount: 0,
        dailyLimit: this.dailyLimits[network] ?? 1,
        weeklyCount: 0,
        weeklyLimit: this.weeklyLimits[network] ?? 5,
        lastPostAt: null,
        minIntervalMs: this.minIntervalMs[network] ?? 300_000,
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart().toISOString().slice(0, 10);
    const dailyKey = `${this.prefix}:${network}:daily:${today}`;
    const weeklyKey = `${this.prefix}:${network}:weekly:${weekStart}`;
    const intervalKey = `${this.prefix}:${network}:interval`;

    const [dailyCountStr, weeklyCountStr, lastPostTs] = await Promise.all([
      this.redis.get(dailyKey),
      this.redis.get(weeklyKey),
      this.redis.get(intervalKey),
    ]);

    return {
      dailyCount: dailyCountStr ? parseInt(dailyCountStr, 10) : 0,
      dailyLimit: this.dailyLimits[network] ?? 1,
      weeklyCount: weeklyCountStr ? parseInt(weeklyCountStr, 10) : 0,
      weeklyLimit: this.weeklyLimits[network] ?? 5,
      lastPostAt: lastPostTs ? parseInt(lastPostTs, 10) : null,
      minIntervalMs: this.minIntervalMs[network] ?? 300_000,
    };
  }

  /**
   * Get the ISO date string for the start of the current week (Monday-based).
   */
  private getWeekStart(): Date {
    const now = new Date();
    const day = now.getDay(); // 0 = Sunday
    const diff = day === 0 ? -6 : 1 - day; // adjust to Monday
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }
}
