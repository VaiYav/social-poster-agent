/**
 * P1: Hook Performance Bank — learning loop from engagement metrics.
 *
 * Categorizes hooks by technique (question / bold / counter-intuitive / story /
 * data) and tracks average engagement per technique per network. The data
 * feeds back into the hook_generation prompt so the LLM prefers techniques
 * that historically perform well.
 *
 * Data flow:
 *   1. Generation: hook_generation node tags each hook with its technique.
 *      The technique is stored in Post.llmMetadata.hookTechnique.
 *   2. After posting: PostMetrics are scraped (F6 analytics).
 *   3. This bank aggregates metrics by technique + network and caches the
 *      result in Redis (1-hour TTL).
 *   4. Generation: hook_generation reads the bank's recommendation and
 *      steers the LLM toward high-performing techniques.
 *
 * Redis keys:
 *   `spa:hookbank:stats:<network>` — JSON hash: { technique: { avg, count } }
 *   `spa:hookbank:updated`         — timestamp of last aggregation
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { SocialNetwork, PostStatus, Prisma } from '@prisma/client';

/**
 * Hook techniques — matches the categories in the hook_generation prompt.
 */
export const HOOK_TECHNIQUES = [
  'question',
  'bold',
  'counter_intuitive',
  'story',
  'data',
] as const;
export type HookTechnique = (typeof HOOK_TECHNIQUES)[number];

/**
 * Per-technique performance stats.
 */
export interface TechniqueStats {
  technique: HookTechnique;
  /** Normalized engagement score (likes + 2*comments + 3*shares) / impressions. */
  avgEngagement: number;
  /** Average LLM quality score (1-10) for posts using this technique. */
  avgQualityScore: number;
  /** Hybrid score: 0.4 * normalizedQuality + 0.6 * normalizedEngagement (0-1 range). */
  hybridScore: number;
  /** Number of posts sampled. */
  sampleSize: number;
  /** Relative multiplier vs baseline (1.0 = average). */
  performanceMultiplier: number;
}

/**
 * Recommendation for the hook_generation node.
 */
export interface HookRecommendation {
  /** Techniques ranked best-to-worst by performance. */
  rankedTechniques: TechniqueStats[];
  /** The top-performing technique. */
  topTechnique: HookTechnique;
  /** The worst-performing technique (to avoid). */
  bottomTechnique: HookTechnique | null;
  /** Human-readable guidance string for the LLM prompt. */
  guidance: string;
  /** Whether this recommendation is based on real data or a fallback. */
  hasData: boolean;
}

/** Redis key prefix. */
const BANK_KEY_PREFIX = 'spa:hookbank';
/** Cache TTL for aggregated stats (1 hour). */
const CACHE_TTL_SECONDS = 3600;
/** Minimum sample size per technique before trusting the data. */
const MIN_SAMPLE_SIZE = 3;

/**
 * Heuristic: classify a hook text into a technique.
 * Used when the LLM didn't tag the hook (older posts or fallback).
 *
 *   - Starts with "?" or "what/why/how/when/where/who" → question
 *   - Contains "!" and a strong claim word → bold
 *   - Contains "but", "actually", "however", "contrary" → counter_intuitive
 *   - Contains "I", "my", "me", "yesterday", "last week" → story
 *   - Contains numbers, "%", "x more", "studies show" → data
 *   - default → question (safest)
 */
export function classifyHookTechnique(hook: string): HookTechnique {
  const h = hook.toLowerCase().trim();
  if (/^(what|why|how|when|where|who|did|do|can|could|would|will|is|are)\b/.test(h)) return 'question';
  if (/[!%]/.test(h) || /\b(always|never|every|must|definitely|absolutely)\b/.test(h)) return 'bold';
  if (/\b(but|actually|however|contrary|unlike|despite|while most|most people think)\b/.test(h)) return 'counter_intuitive';
  if (/^(i|my|me|yesterday|last week|last month|recently)\b/.test(h)) return 'story';
  if (/\b(\d|%|x more|studies show|research|data|statistics|percent)\b/.test(h)) return 'data';
  return 'question';
}

@Injectable()
export class HookPerformanceBank {
  private readonly logger = new Logger(HookPerformanceBank.name);

  constructor(
    @Inject(SHARED_REDIS) private readonly redis: Redis,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * Daily cron: aggregate hook performance at 7am (after metrics scraper at 6am).
   * Configurable via HOOK_BANK_AGGREGATE_SCHEDULE env var.
   */
  @Cron(process.env.HOOK_BANK_AGGREGATE_SCHEDULE ?? '0 7 * * *')
  async scheduledAggregate(): Promise<void> {
    await this.aggregateStats();
  }

  /**
   * Aggregate hook performance from posted posts + their metrics + quality scores.
   * Groups by technique + network, computes:
   *   - Normalized engagement score (likes + 2*comments + 3*shares)
   *   - Average LLM quality score (1-10)
   *   - Hybrid score (quality + engagement blend)
   *
   * Quality score is always available (set by critique node during generation).
   * Engagement metrics may be absent (metrics scraping is optional/stubbed).
   * The hybrid score uses quality as the primary signal when engagement is missing.
   *
   * Results are cached in Redis for CACHE_TTL_SECONDS.
   */
  async aggregateStats(): Promise<void> {
    if (!this.prisma) {
      this.logger.debug('P1: Prisma unavailable — skipping aggregation');
      return;
    }

    try {
      // Fetch posted posts with hook metadata + their latest metrics
      const posts = await this.prisma.post.findMany({
        where: {
          status: PostStatus.POSTED,
          llmMetadata: { not: Prisma.DbNull },
        },
        select: {
          id: true,
          network: true,
          llmMetadata: true,
          metrics: {
            orderBy: { collectedAt: 'desc' },
            take: 1,
          },
        },
        take: 500, // last 500 posted posts
      });

      // Group by (network, technique) — track both engagement and quality
      const groups = new Map<string, {
        engagementSum: number;
        engagementCount: number;
        qualitySum: number;
        qualityCount: number;
      }>();

      for (const post of posts) {
        const metadata = post.llmMetadata as {
          hook?: string;
          hookTechnique?: string;
          qualityScore?: number;
        } | null;
        if (!metadata?.hook) continue;

        // Use stored technique or classify heuristically
        const technique = (
          metadata.hookTechnique && HOOK_TECHNIQUES.includes(metadata.hookTechnique as HookTechnique)
            ? metadata.hookTechnique
            : classifyHookTechnique(metadata.hook)
        ) as HookTechnique;

        const key = `${post.network}:${technique}`;
        const existing = groups.get(key) ?? {
          engagementSum: 0,
          engagementCount: 0,
          qualitySum: 0,
          qualityCount: 0,
        };

        // Track engagement (if metrics available)
        const metrics = post.metrics[0];
        if (metrics) {
          const engagement = metrics.likes + 2 * metrics.comments + 3 * metrics.shares;
          existing.engagementSum += engagement;
          existing.engagementCount += 1;
        }

        // Track quality score (always available from critique node)
        if (typeof metadata.qualityScore === 'number' && metadata.qualityScore > 0) {
          existing.qualitySum += metadata.qualityScore;
          existing.qualityCount += 1;
        }

        groups.set(key, existing);
      }

      // Compute averages and write to Redis
      const pipeline = this.redis.multi();
      for (const network of [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK]) {
        const stats: Record<string, {
          avg: number;
          count: number;
          avgQuality: number;
          qualityCount: number;
        }> = {};
        for (const technique of HOOK_TECHNIQUES) {
          const key = `${network}:${technique}`;
          const group = groups.get(key);
          if (group && (group.engagementCount > 0 || group.qualityCount > 0)) {
            stats[technique] = {
              avg: group.engagementCount > 0 ? group.engagementSum / group.engagementCount : 0,
              count: group.engagementCount,
              avgQuality: group.qualityCount > 0 ? group.qualitySum / group.qualityCount : 0,
              qualityCount: group.qualityCount,
            };
          }
        }
        pipeline.set(
          `${BANK_KEY_PREFIX}:stats:${network}`,
          JSON.stringify(stats),
          'EX',
          CACHE_TTL_SECONDS,
        );
      }
      pipeline.set(`${BANK_KEY_PREFIX}:updated`, Date.now().toString(), 'EX', CACHE_TTL_SECONDS);
      await pipeline.exec();

      this.logger.log(
        `P1: Aggregated hook performance from ${posts.length} posts — ` +
          `${groups.size} (network, technique) groups (quality + engagement)`,
      );
    } catch (err) {
      this.logger.warn(`P1: Aggregation failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get a hook recommendation for a specific network.
   * Reads cached stats from Redis and ranks techniques by hybrid score.
   *
   * Hybrid scoring:
   *   - When engagement data available: 0.4 * quality + 0.6 * engagement
   *   - When only quality data: quality score alone (normalized to 0-1)
   *   - When no data: neutral (all techniques equal)
   *
   * @param network Target social network
   * @returns Recommendation with ranked techniques and LLM guidance
   */
  async getRecommendation(network: SocialNetwork): Promise<HookRecommendation> {
    try {
      const raw = await this.redis.get(`${BANK_KEY_PREFIX}:stats:${network}`);
      if (!raw) {
        return this.fallbackRecommendation(network, 'No cached stats — run aggregateStats() first');
      }

      const stats = JSON.parse(raw) as Record<
        string,
        { avg: number; count: number; avgQuality: number; qualityCount: number }
      >;

      // Compute baselines
      const allEngagement = Object.values(stats).filter((s) => s.count >= MIN_SAMPLE_SIZE).map((s) => s.avg);
      const allQuality = Object.values(stats).filter((s) => s.qualityCount >= MIN_SAMPLE_SIZE).map((s) => s.avgQuality);
      const engagementBaseline = allEngagement.length > 0 ? allEngagement.reduce((a, b) => a + b, 0) / allEngagement.length : 0;
      const qualityBaseline = allQuality.length > 0 ? allQuality.reduce((a, b) => a + b, 0) / allQuality.length : 5;

      // Build ranked list using hybrid score
      const ranked: TechniqueStats[] = HOOK_TECHNIQUES.map((technique) => {
        const s = stats[technique];
        const hasEngagement = s && s.count >= MIN_SAMPLE_SIZE;
        const hasQuality = s && s.qualityCount >= MIN_SAMPLE_SIZE;

        if (!hasEngagement && !hasQuality) {
          return {
            technique,
            avgEngagement: 0,
            avgQualityScore: 0,
            hybridScore: 0.5, // neutral
            sampleSize: s?.count ?? 0,
            performanceMultiplier: 1, // neutral when no data
          };
        }

        const avgEng = hasEngagement ? s.avg : 0;
        const avgQual = hasQuality ? s.avgQuality : 0;

        // Normalize: quality to 0-1 (divide by 10), engagement to 0-1 (divide by baseline)
        const normalizedQuality = avgQual / 10;
        const normalizedEngagement = engagementBaseline > 0 ? avgEng / (engagementBaseline * 2) : 0;

        // Hybrid: weight engagement more when available, quality as fallback
        const hybridScore = hasEngagement
          ? 0.4 * normalizedQuality + 0.6 * Math.min(normalizedEngagement, 1)
          : normalizedQuality; // quality-only when no engagement

        const performanceMultiplier = hasEngagement && engagementBaseline > 0
          ? avgEng / engagementBaseline
          : hasQuality && qualityBaseline > 0
            ? avgQual / qualityBaseline
            : 1;

        return {
          technique,
          avgEngagement: avgEng,
          avgQualityScore: avgQual,
          hybridScore,
          sampleSize: Math.max(s?.count ?? 0, s?.qualityCount ?? 0),
          performanceMultiplier,
        };
      }).sort((a, b) => b.hybridScore - a.hybridScore);

      // Find top technique with enough data (quality or engagement)
      const topWith = ranked.find((r) => r.sampleSize >= MIN_SAMPLE_SIZE);
      const topTechnique = topWith?.technique ?? 'question';

      // Find bottom technique with enough data
      const bottomWith = [...ranked]
        .reverse()
        .find((r) => r.sampleSize >= MIN_SAMPLE_SIZE && r.hybridScore < 0.4);
      const bottomTechnique = bottomWith?.technique ?? null;

      const hasData = Boolean(topWith);

      // Build guidance string for the LLM
      let guidance = '';
      if (hasData) {
        const topMult = topWith!.performanceMultiplier.toFixed(1);
        const topQual = topWith!.avgQualityScore.toFixed(1);
        guidance =
          `Historical performance on ${network} (last ${topWith!.sampleSize} posts):\n` +
          `- Best technique: "${topTechnique}" (${topMult}x baseline, avg quality ${topQual}/10)\n`;
        if (bottomTechnique) {
          guidance += `- Weakest technique: "${bottomTechnique}" — avoid overusing\n`;
        }
        guidance += `- Prefer "${topTechnique}" hooks when the topic allows.`;
      } else {
        guidance = `No historical data yet for ${network} — use a mix of all 5 techniques.`;
      }

      return {
        rankedTechniques: ranked,
        topTechnique,
        bottomTechnique,
        guidance,
        hasData,
      };
    } catch (err) {
      return this.fallbackRecommendation(network, `Stats read failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get raw stats for all networks (for dashboard/API).
   * Returns the cached aggregation data.
   */
  async getStats(): Promise<{
    networks: Record<string, Record<string, { avg: number; count: number; avgQuality: number; qualityCount: number }>>;
    lastUpdated: number | null;
  }> {
    const networks: Record<string, Record<string, { avg: number; count: number; avgQuality: number; qualityCount: number }>> = {};
    for (const network of [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK]) {
      const raw = await this.redis.get(`${BANK_KEY_PREFIX}:stats:${network}`);
      if (raw) {
        networks[network] = JSON.parse(raw);
      } else {
        networks[network] = {};
      }
    }
    const updatedRaw = await this.redis.get(`${BANK_KEY_PREFIX}:updated`);
    return { networks, lastUpdated: updatedRaw ? parseInt(updatedRaw, 10) : null };
  }

  /**
   * Fallback recommendation when no data is available.
   */
  private fallbackRecommendation(network: SocialNetwork, reason: string): HookRecommendation {
    this.logger.debug(`P1: Using fallback for ${network} — ${reason}`);
    return {
      rankedTechniques: HOOK_TECHNIQUES.map((t) => ({
        technique: t,
        avgEngagement: 0,
        avgQualityScore: 0,
        hybridScore: 0.5,
        sampleSize: 0,
        performanceMultiplier: 1,
      })),
      topTechnique: 'question',
      bottomTechnique: null,
      guidance: `No historical data yet for ${network} — use a mix of all 5 techniques.`,
      hasData: false,
    };
  }
}
