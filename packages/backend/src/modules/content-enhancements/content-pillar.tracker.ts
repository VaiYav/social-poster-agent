/**
 * P6: Content Pillar Rotation — strategic diversity enforcement.
 *
 * The brand-voice.md defines 7 content themes (pillars) but there was no
 * enforcement — the LLM could generate 5 daily-horoscope posts in a row.
 * This tracker uses Redis to count posts per pillar over a rolling 7-day
 * window and recommends which pillar to prioritize next.
 *
 * Pillars (from brand-voice.md "Content Themes"):
 *   1. daily_weather   — daily/weekly cosmic weather
 *   2. educational     — "Did you know..." about houses, aspects, nodes
 *   3. compatibility   — sign pairs, synastry
 *   4. ai_advantage    — why AI-astrology is more accurate
 *   5. self_discovery  — Moon sign, Rising sign, Chiron, retrogrades
 *   6. wellness        — meditations by sign, timing by lunar phases
 *   7. blog_promo      — announce fresh articles with a content hook
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

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';

/**
 * The 7 content pillars from brand-voice.md.
 * The order matches the document's "Content Themes (rotation)" section.
 */
export const CONTENT_PILLARS = [
  'daily_weather',
  'educational',
  'compatibility',
  'ai_advantage',
  'self_discovery',
  'wellness',
  'blog_promo',
] as const;
export type ContentPillar = (typeof CONTENT_PILLARS)[number];

/**
 * Target ratio per pillar — what fraction of posts should be each pillar.
 * Sums to 1.0. Tunable via env in future; defaults favor variety.
 */
const DEFAULT_TARGET_RATIOS: Record<ContentPillar, number> = {
  daily_weather: 0.20,   // frequent but not dominant
  educational: 0.20,     // high value, evergreen
  compatibility: 0.10,   // niche but engaging
  ai_advantage: 0.10,    // brand differentiator
  self_discovery: 0.20,  // core value prop
  wellness: 0.10,        // actionable
  blog_promo: 0.10,      // distribution
};

/** Redis key prefix. */
const PILLAR_KEY_PREFIX = 'spa:pillar';
/** Rolling window for pillar counts (7 days in seconds). */
const WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Heuristic: classify a topic into a content pillar based on keywords.
 * This is a fast deterministic classifier — not perfect, but good enough
 * to steer prioritization. The LLM still has final say on the actual angle.
 *
 * Classification rules (first match wins):
 *   - "compatibility" / "synastry" / "match" + sign names → compatibility
 *   - "ai" / "algorithm" / "10 planets" → ai_advantage
 *   - "meditation" / "wellness" / "ritual" / "lunar phase" → wellness
 *   - "new article" / "blog" / "read more" / "fresh" → blog_promo
 *   - "did you know" / "house" / "aspect" / "node" / "retrograde" → educational
 *   - "moon sign" / "rising sign" / "chiron" / "self" / "discover" → self_discovery
 *   - default → daily_weather
 */
export function classifyPillar(topic: string, keywords: string[]): ContentPillar {
  const text = `${topic} ${keywords.join(' ')}`.toLowerCase();

  if (/(compatib|synastr|sign match|couple|relationship|partner)/.test(text)) return 'compatibility';
  if (/(ai |algorithm|10 planets|machine|ai-powered|ai read)/.test(text)) return 'ai_advantage';
  if (/(meditat|wellness|ritual|lunar phase|journal|self-care|mindful)/.test(text)) return 'wellness';
  if (/(new article|blog|read more|fresh|just published|new post)/.test(text)) return 'blog_promo';
  if (/(did you know|house|aspect|node|retrograde|orbit|ingress|transit)/.test(text)) return 'educational';
  if (/(moon sign|rising sign|chiron|self|discover|birth chart|natal)/.test(text)) return 'self_discovery';
  return 'daily_weather';
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
    // Future: load target ratios from env/config. For now, use defaults.
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
   * Ties broken by pillar order (daily_weather first).
   */
  async recommendPillar(): Promise<PillarRecommendation> {
    const stats = await this.getPillarStats();

    // Sort by deficit descending — most underrepresented first
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
    // 2.8.2: Only set TTL on the FIRST write. Refreshing TTL on every
    // increment turned the "7-day rolling window" into "7 days since the
    // most recent post", which overcounts old posts when posting restarts.
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
