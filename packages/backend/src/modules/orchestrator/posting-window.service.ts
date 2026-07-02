/**
 * PostingWindowService — Smart posting windows (WS-4).
 *
 * Builds an engagement heatmap from PostMetrics history and recommends
 * the best posting hours per network per day. Uses exponential decay
 * to weight recent posts more heavily.
 *
 * Cold-start: when < POSTING_WINDOW_MIN_SAMPLES posts have metrics,
 * falls back to hardcoded hours from POSTING_WINDOW_FALLBACK_HOURS.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { SocialNetwork } from '@prisma/client';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import type { PostingWindow } from './types.js';

const CACHE_KEY_PREFIX = 'spa:posting-window:heatmap';
const CACHE_TTL_SEC = 3600; // 1 hour

interface HourScore {
  hour: number;
  score: number;
  samples: number;
}

@Injectable()
export class PostingWindowService {
  private readonly logger = new Logger(PostingWindowService.name);
  private readonly minSamples: number;
  private readonly topHours: number;
  private readonly decayDays: number;
  private readonly fallbackHours: number[];
  private readonly bypass: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
  ) {
    this.minSamples = Number(this.configService.get<string>('POSTING_WINDOW_MIN_SAMPLES', '10'));
    this.topHours = Number(this.configService.get<string>('POSTING_WINDOW_TOP_HOURS', '3'));
    this.decayDays = Number(this.configService.get<string>('POSTING_WINDOW_DECAY_DAYS', '30'));
    const fallbackCsv = this.configService.get<string>('POSTING_WINDOW_FALLBACK_HOURS', '9,12,18,21');
    this.fallbackHours = fallbackCsv.split(',').map((h) => Number(h.trim())).filter((h) => !isNaN(h));
    this.bypass = parseBool(this.configService.get<string>('POSTING_WINDOW_BYPASS', 'false'));
  }

  /**
   * Get posting window recommendation for a network.
   * Uses cached heatmap if available, otherwise builds from DB.
   */
  async getRecommendation(network: string): Promise<PostingWindow> {
    try {
      const heatmap = await this.getOrBuildHeatmap(network);
      const totalSamples = heatmap.reduce((sum, h) => sum + h.samples, 0);

      if (totalSamples < this.minSamples) {
        // Cold start — use fallback hours
        const currentHour = new Date().getUTCHours();
        const inWindow = this.bypass || this.fallbackHours.some(
          (h) => Math.abs(h - currentHour) <= 1, // ±1 hour tolerance
        );
        return {
          bestHours: this.fallbackHours,
          inWindow,
          confidence: 'low',
        };
      }

      // Sort by score descending, take top N
      const sorted = [...heatmap].sort((a, b) => b.score - a.score);
      const best = sorted.slice(0, this.topHours).map((h) => h.hour);

      const currentHour = new Date().getUTCHours();
      const inWindow = this.bypass || best.some((h) => Math.abs(h - currentHour) <= 1);

      const confidence = totalSamples > 50 ? 'high' : 'medium';

      return { bestHours: best, inWindow, confidence };
    } catch (err) {
      this.logger.warn(`PostingWindow recommendation failed for ${network}: ${(err as Error).message}`);
      return {
        bestHours: this.fallbackHours,
        inWindow: this.bypass,
        confidence: 'low',
      };
    }
  }

  /**
   * Get heatmap from Redis cache or build from DB.
   */
  private async getOrBuildHeatmap(network: string): Promise<HourScore[]> {
    const cacheKey = `${CACHE_KEY_PREFIX}:${network}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as HourScore[];
      }
    } catch {
      // Redis error — proceed to build
    }

    const heatmap = await this.buildHeatmap(network);

    try {
      await this.redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(heatmap));
    } catch {
      // Cache write failure is non-critical
    }

    return heatmap;
  }

  /**
   * Build engagement heatmap from PostMetrics history.
   * Uses exponential decay — posts within `decayDays` are weighted more.
   */
  private async buildHeatmap(network: string): Promise<HourScore[]> {
    const sinceDate = new Date(Date.now() - this.decayDays * 24 * 60 * 60 * 1000);

    const metrics = await this.prisma.postMetrics.findMany({
      where: {
        post: { network: network as SocialNetwork, postedAt: { gte: sinceDate } },
      },
      include: {
        post: { select: { postedAt: true } },
      },
      orderBy: { collectedAt: 'desc' },
      take: 500, // Limit to prevent unbounded queries on high-volume networks
    });

    // Group by hour, accumulate weighted engagement scores
    const hourMap = new Map<number, { score: number; samples: number }>();
    const now = Date.now();
    const decayMs = this.decayDays * 24 * 60 * 60 * 1000;

    // Deduplicate — keep only the latest metrics per post
    const seenPosts = new Set<string>();
    for (const m of metrics) {
      if (seenPosts.has(m.postId)) continue;
      seenPosts.add(m.postId);

      if (!m.post?.postedAt) continue;

      const hour = m.post.postedAt.getUTCHours();
      const ageMs = now - m.post.postedAt.getTime();
      const decayWeight = Math.exp(-ageMs / decayMs); // exponential decay
      const engagementScore = m.likes + m.comments * 2 + m.shares * 3;

      const existing = hourMap.get(hour) ?? { score: 0, samples: 0 };
      existing.score += engagementScore * decayWeight;
      existing.samples += 1;
      hourMap.set(hour, existing);
    }

    // Return all 24 hours (0 score for hours with no data)
    const heatmap: HourScore[] = [];
    for (let h = 0; h < 24; h++) {
      const entry = hourMap.get(h);
      heatmap.push({
        hour: h,
        score: entry?.score ?? 0,
        samples: entry?.samples ?? 0,
      });
    }

    return heatmap;
  }
}
