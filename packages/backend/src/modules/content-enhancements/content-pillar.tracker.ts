/**
 * P6: Content Pillar Rotation — strategic diversity enforcement.
 *
 * The brand voice defines content pillars but there was no enforcement —
 * the LLM could generate 5 similar posts in a row. This tracker uses Redis
 * to count posts per pillar over a rolling 7-day window and recommends
 * which pillar to prioritize next.
 *
 * Pillars:
 *   1. general           — default, broad-audience posts
 *   2. educational       — explainers, how-to, tips
 *   3. product           — features, launches, updates
 *   4. opinion           — takes, hot opinions, commentary
 *   5. behind-the-scenes — process, team, building
 *   6. trending          — news, timely, viral
 *   7. blog_promo        — announce fresh articles with a content hook
 *
 * Integration:
 *   - GenerationService calls `recommendPillar()` before topic selection.
 *   - The recommended pillar is injected into the topic's keywords so the
 *     generation graph steers the LLM toward the underrepresented pillar.
 *   - After posts are saved, `recordPillar()` increments the counter.
 *
 * Redis keys:
 *   `spa:pillar:<pillar>:count` — INCR per post, EXPIRE 7 days
 *   `spa:pillar:last7`          — hash field per pillar with count
 */

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";

/**
 * Generic content pillars.
 */
export const CONTENT_PILLARS = [
  "general",
  "educational",
  "product",
  "opinion",
  "behind-the-scenes",
  "trending",
  "blog_promo",
] as const;
export type ContentPillar = (typeof CONTENT_PILLARS)[number];

/**
 * Target ratio per pillar — what fraction of posts should be each pillar.
 * Sums to 1.0. Tunable via env in future; defaults favor variety.
 */
const DEFAULT_TARGET_RATIOS: Record<ContentPillar, number> = {
  general: 0.2,
  educational: 0.2,
  product: 0.15,
  opinion: 0.1,
  "behind-the-scenes": 0.1,
  trending: 0.1,
  blog_promo: 0.15,
};

/** Redis key prefix. */
const PILLAR_KEY_PREFIX = "spa:pillar";
/** Rolling window for pillar counts (7 days in seconds). */
const WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Heuristic: classify a topic into a content pillar based on keywords.
 * This is a fast deterministic classifier — not perfect, but good enough
 * to steer prioritization. The LLM still has final say on the actual angle.
 *
 * Classification rules (first match wins):
 *   - "new article" / "blog" / "read more" / "fresh" → blog_promo
 *   - "opinion" / "hot take" / "controversial" / "unpopular" → opinion
 *   - "behind the scenes" / "process" / "how we" / "team" → behind-the-scenes
 *   - "product" / "feature" / "tool" / "launch" / "update" → product
 *   - "trending" / "news" / "viral" / "this week" → trending
 *   - "did you know" / "how to" / "guide" / "tutorial" / "explain" → educational
 *   - default → general
 */
export function classifyPillar(topic: string, keywords: string[]): ContentPillar {
  const text = `${topic} ${keywords.join(" ")}`.toLowerCase();

  if (/(new article|blog|read more|fresh|just published|new post)/.test(text)) return "blog_promo";
  if (/(opinion|hot take|controversial|unpopular|think|believe|argue|take on)/.test(text))
    return "opinion";
  if (
    /(behind the scenes|behind-the-scenes|process|how we|team|building|making of|day in the life)/.test(
      text,
    )
  )
    return "behind-the-scenes";
  if (/(product|feature|tool|demo|launch|release|update|app|service)/.test(text)) return "product";
  if (/(trending|trend|news|just happened|this week|today in|viral|breaking)/.test(text))
    return "trending";
  if (
    /(did you know|how to|guide|tutorial|learn|tip|explainer|faq|explain|deep dive|what is|why does)/.test(
      text,
    )
  )
    return "educational";
  return "general";
}

/**
 * Pillar stats for the rolling 7-day window.
 */
export interface PillarStats {
  pillar: ContentPillar;
  count: number;
  targetRatio: number;
  /** Actual ratio = count / totalPosts. 0 when no posts. */
  actualRatio: number;
  /** Deficit = targetRatio - actualRatio. Positive = underrepresented. */
  deficit: number;
}

/**
 * Recommendation result — which pillar to prioritize next and why.
 */
export interface PillarRecommendation {
  recommended: ContentPillar;
  reason: string;
  stats: PillarStats[];
}

@Injectable()
export class ContentPillarTracker {
  private readonly logger = new Logger(ContentPillarTracker.name);
  private readonly targetRatios: Record<ContentPillar, number>;

  constructor(@Inject(SHARED_REDIS) private readonly redis: Redis) {
    this.targetRatios = DEFAULT_TARGET_RATIOS;
  }

  /**
   * Get the current 7-day post count for each pillar.
   */
  async getPillarStats(): Promise<PillarStats[]> {
    const counts = await Promise.all(
      CONTENT_PILLARS.map(async (pillar) => {
        const val = await this.redis.get(`${PILLAR_KEY_PREFIX}:${pillar}:count`);
        return { pillar, count: Number(val) || 0 };
      }),
    );

    const total = counts.reduce((sum, c) => sum + c.count, 0);

    return counts.map((c) => {
      const targetRatio = this.targetRatios[c.pillar] ?? 0;
      const actualRatio = total > 0 ? c.count / total : 0;
      return {
        pillar: c.pillar,
        count: c.count,
        targetRatio,
        actualRatio,
        deficit: targetRatio - actualRatio,
      };
    });
  }

  /**
   * Recommend which pillar to prioritize next.
   * Picks the pillar with the highest deficit (most underrepresented).
   * Ties broken by pillar order (general first).
   */
  async recommendPillar(): Promise<PillarRecommendation> {
    const stats = await this.getPillarStats();

    const sorted = [...stats].sort((a, b) => b.deficit - a.deficit);
    const recommended = sorted[0]!;

    return {
      recommended: recommended.pillar,
      reason:
        `Pillar "${recommended.pillar}" is underrepresented ` +
        `(actual ${(recommended.actualRatio * 100).toFixed(0)}% vs target ${(recommended.targetRatio * 100).toFixed(0)}%, ` +
        `${recommended.count} posts in last 7 days)`,
      stats,
    };
  }

  /**
   * Record a post against a pillar — increments the 7-day counter.
   * Call this after a post is saved to the database.
   */
  async recordPillar(pillar: ContentPillar): Promise<void> {
    const key = `${PILLAR_KEY_PREFIX}:${pillar}:count`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, WINDOW_SECONDS);
    }
    this.logger.debug(`P6: Recorded post for pillar "${pillar}"`);
  }

  /**
   * Record a post by classifying its topic into a pillar.
   * Convenience wrapper: classifyPillar() + recordPillar().
   */
  async recordPost(topic: string, keywords: string[]): Promise<ContentPillar> {
    const pillar = classifyPillar(topic, keywords);
    await this.recordPillar(pillar);
    return pillar;
  }
}
