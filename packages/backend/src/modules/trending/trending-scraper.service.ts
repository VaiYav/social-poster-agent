/**
 * F22 / Item 38: TrendingScraperService — Google Trends + X trending scraping.
 *
 * Extends the astrological trending detection with real-time trend sources:
 *   1. Google Trends RSS feed (no API key required, public data)
 *   2. X (Twitter) trending topics tab (scraped via browser port)
 *
 * Design:
 *   - Google Trends: fetches daily trending searches via the public RSS feed
 *     (https://trends.google.com/trending/rss). No auth, no API key.
 *   - X Trends: uses IBrowserPort to navigate to the Explore/Trending tab
 *     and extract trending topic text. Reuses existing Camoufox session pool.
 *   - Results are merged with astrological trending (TrendingService) and
 *     deduplicated.
 *   - Cached for 15 minutes (TRENDING_CACHE_TTL_MS) to avoid scraping on
 *     every generation run.
 *
 * Safety:
 *   - X scraping reuses the existing session pool (no extra login)
 *   - Respects robots.txt (Google Trends RSS is public)
 *   - Rate-limited by cache TTL (15 min default)
 *   - Failures are logged but don't block generation (graceful degradation)
 */

import { Injectable, Logger, Optional, Inject, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { LlmService } from '../../infrastructure/llm/llm.service.js';
import type { BrowserContext, Page } from 'playwright-core';
import { SocialNetwork } from '@prisma/client';
import { parseGoogleTrendsRss as parseGoogleTrendsRssPure } from './google-trends-rss.js';
import { parseBool } from '../../infrastructure/config/parse-bool';

// ── Types ──

export interface ScrapedTrendingTopic {
  source: 'google_trends' | 'x_trends';
  topic: string;
  rank?: number; // 1 = top trend
  url?: string;
  traffic?: string; // e.g. "500K+ searches" (Google Trends)
  scrapedAt: Date;
}

export interface MergedTrendingTopic {
  topic: string;
  sources: ('astro' | 'google_trends' | 'x_trends')[];
  networks: string[]; // recommended networks
  priority: number; // 1 = highest (multiple sources agree)
  scrapedAt?: Date;
}

// ── Constants ──

const GOOGLE_TRENDS_RSS_URL = 'https://trends.google.com/trending/rss?geo=US';
const X_TRENDS_URL = 'https://x.com/explore/tabs/trending';
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const X_SCRAPE_TIMEOUT_MS = 30_000; // 30s timeout for X scraping
const X_TREND_SELECTOR = '[data-testid="trend"]';

/**
 * Niche keyword whitelist — Google/X trends must contain at least one of these
 * (case-insensitive substring match) to pass the fast keyword filter.
 * Topics that don't match any keyword go to the LLM relevance filter as a
 * second-chance borderline check.
 *
 * Covers: astrology, wellness, women's cycles, love/relationships, business/mindset,
 * personal growth, mental health, spirituality, self-care, human wellbeing.
 */
const NICHE_KEYWORDS: readonly string[] = [
  // Astrology / cosmic
  'astro', 'zodiac', 'horoscope', 'moon', 'sun sign', 'star sign', 'mercury',
  'retrograde', 'eclipse', 'planet', 'natal', 'birth chart', 'cosmic', 'celestial',
  'solstice', 'equinox', 'full moon', 'new moon', 'lunar', 'solar', 'jupiter',
  'saturn', 'venus', 'mars', 'pluto', 'neptune', 'uranus', 'chiron', 'midheaven',
  'rising sign', 'moon sign', 'venus retrograde', 'mercury retrograde',
  // Wellness / self-care
  'wellness', 'self-care', 'self care', 'meditation', 'mindfulness', 'yoga',
  'breathwork', 'journaling', 'gratitude', 'manifest', 'manifestation',
  'crystal', 'tarot', 'oracle', 'ritual', 'affirmation', 'healing', 'energy',
  'chakra', 'aura', 'cleanse', 'detox', 'wellbeing', 'well-being',
  // Women's cycles / feminine
  'cycle', 'menstrual', 'period', 'feminine', 'divine feminine', 'womb',
  'luteal', 'follicular', 'ovulation', 'menopause', 'hormone', 'cycle syncing',
  // Love / relationships
  'love', 'relationship', 'dating', 'partner', 'romance', 'soulmate',
  'twin flame', 'breakup', 'heartbreak', 'attachment', 'intimacy', 'marriage',
  'couple', 'compatibility', 'synastry', 'venus in',
  // Business / mindset / growth
  'business', 'entrepreneur', 'mindset', 'productivity', 'goal', 'success',
  'leadership', 'career', 'purpose', 'abundance', 'wealth', 'money mindset',
  'discipline', 'habit', 'routine', 'focus', 'manifest money', 'side hustle',
  // Mental health / emotional
  'anxiety', 'stress', 'burnout', 'depression', 'mental health', 'therapy',
  'emotional', 'trauma', 'self-love', 'self love', 'confidence', 'boundaries',
  'overthinking', 'people pleaser', 'inner child', 'shadow work',
  // Spirituality
  'spiritual', 'spirituality', 'soul', 'purpose', 'awakening', 'intuition',
  'universe', 'synchronicity', 'sign from the universe', 'higher self',
  'manifestation', 'law of attraction', 'vibration', 'frequency',
];

@Injectable()
export class TrendingScraperService implements OnModuleInit {
  private readonly logger = new Logger(TrendingScraperService.name);
  private readonly cacheTtlMs: number;
  private readonly enabled: boolean;
  private readonly xScrapeEnabled: boolean;
  private readonly llmFilterEnabled: boolean;

  // Cache: { topics, expiresAt }
  private googleTrendsCache: { topics: ScrapedTrendingTopic[]; expiresAt: number } | null = null;
  private xTrendsCache: { topics: ScrapedTrendingTopic[]; expiresAt: number } | null = null;

  /**
   * LLM relevance cache — avoids re-calling the LLM for the same topic across runs.
   * Key = lowercased topic, value = boolean (relevant to niche).
   * Lives for the lifetime of the service instance (cleared on invalidateCache).
   */
  private readonly llmRelevanceCache = new Map<string, boolean>();

  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Optional() private readonly llmService?: LlmService,
    @Optional() @Inject(IBrowserPort) private readonly browser?: IBrowserPort,
  ) {
    this.cacheTtlMs = this.configService.get<number>('TRENDING_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS);
    this.enabled = parseBool(this.configService.get<string>('TRENDING_SCRAPING_ENABLED', 'true'));
    this.xScrapeEnabled = parseBool(this.configService.get<string>('X_TRENDS_SCRAPING_ENABLED', 'true'));
    this.llmFilterEnabled = parseBool(this.configService.get<string>('TRENDING_LLM_FILTER_ENABLED', 'true'));
  }

  /**
   * Sprint Q: Register a cron job to proactively refresh the trending cache.
   * Default: every 2 hours (TRENDING_SCRAPER_SCHEDULE).
   * This ensures generation runs always have fresh cached trends without
   * waiting for inline scraping (which blocks generation for ~20-30s).
   */
  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Trending scraper disabled (TRENDING_SCRAPING_ENABLED=false)');
      return;
    }

    // SPA_DRY_RUN: skip cron registration in dry-run mode
    const isDryRun = parseBool(this.configService.get<string>('SPA_DRY_RUN', 'false'));
    if (isDryRun) {
      this.logger.warn('SPA_DRY_RUN=true — trending scraper cron NOT registered');
      return;
    }

    const cronExpr = this.configService.get<string>(
      'TRENDING_SCRAPER_SCHEDULE',
      '0 */2 * * *',
    ) ?? '0 */2 * * *';

    const job = new CronJob(cronExpr, async () => {
      await this.refreshCache();
    });

    try {
      this.schedulerRegistry?.addCronJob('trending-scraper', job);
      job.start();
      this.logger.log(`Trending scraper cron registered: ${cronExpr}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — trending scraper cron will not run');
    }

    // Initial cache warm-up on startup (non-blocking)
    void this.refreshCache();
  }

  /**
   * Proactively refresh both Google Trends and X Trends caches.
   * Called by cron and on startup. Errors are logged but never thrown.
   */
  private async refreshCache(): Promise<void> {
    try {
      this.logger.log('Refreshing trending cache (cron)...');
      const [google, x] = await Promise.allSettled([
        this.getGoogleTrends(20),
        this.xScrapeEnabled ? this.getXTrends(20) : Promise.resolve([]),
      ]);

      const googleCount = google.status === 'fulfilled' ? google.value.length : 0;
      const xCount = x.status === 'fulfilled' ? x.value.length : 0;
      this.logger.log(`Trending cache refreshed: Google=${googleCount}, X=${xCount}`);

      if (google.status === 'rejected') {
        this.logger.warn(`Google Trends refresh failed: ${google.reason?.message ?? 'unknown'}`);
      }
      if (x.status === 'rejected') {
        this.logger.warn(`X Trends refresh failed: ${x.reason?.message ?? 'unknown'}`);
      }
    } catch (err) {
      this.logger.warn(`Trending cache refresh failed: ${(err as Error).message}`);
    }
  }

  // ── Google Trends (RSS feed — no auth) ──

  /**
   * Fetch Google Trends daily trending searches via public RSS feed.
   * No API key required — this is public data.
   * Cached for TRENDING_CACHE_TTL_MS (default 15 min).
   */
  async getGoogleTrends(limit = 20): Promise<ScrapedTrendingTopic[]> {
    if (!this.enabled) return [];

    // Check cache
    if (this.googleTrendsCache && Date.now() < this.googleTrendsCache.expiresAt) {
      this.logger.debug(`Google Trends cache hit (${this.googleTrendsCache.topics.length} topics)`);
      return this.googleTrendsCache.topics.slice(0, limit);
    }

    try {
      const topics = await this.fetchGoogleTrendsRss(limit);
      this.googleTrendsCache = { topics, expiresAt: Date.now() + this.cacheTtlMs };
      this.logger.log(`Fetched ${topics.length} Google Trends topics`);
      return topics.slice(0, limit);
    } catch (err) {
      this.logger.warn(`Failed to fetch Google Trends: ${(err as Error).message}`);
      return this.googleTrendsCache?.topics ?? [];
    }
  }

  /**
   * Parse Google Trends RSS feed.
   * The RSS feed contains <item> elements with <title> (topic) and <ht:approx_traffic> (traffic).
   */
  private async fetchGoogleTrendsRss(limit: number): Promise<ScrapedTrendingTopic[]> {
    // Use global fetch (Node 18+)
    const response = await fetch(GOOGLE_TRENDS_RSS_URL, {
      headers: { 'User-Agent': 'SocialPosterAgent/1.0 (trending detection)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Google Trends RSS returned ${response.status}`);
    }

    const xml = await response.text();
    return this.parseGoogleTrendsRss(xml, limit);
  }

  /**
   * Parse RSS XML to extract trending topics.
   * Uses regex-based parsing (no XML dependency needed for simple RSS).
   */
  private parseGoogleTrendsRss(xml: string, limit: number): ScrapedTrendingTopic[] {
    // TR1: delegate to the hardened pure parser (CDATA + multiline titles + entity decoding).
    const now = new Date();
    return parseGoogleTrendsRssPure(xml, limit).map((t): ScrapedTrendingTopic => ({
      source: 'google_trends',
      topic: t.topic,
      rank: t.rank,
      url: t.url,
      traffic: t.traffic,
      scrapedAt: now,
    }));
  }

  // ── X Trends (browser scraping) ──

  /**
   * Scrape X (Twitter) trending topics via browser.
   * Reuses the existing Camoufox session pool — no extra login needed.
   * Cached for TRENDING_CACHE_TTL_MS (default 15 min).
   */
  async getXTrends(limit = 20): Promise<ScrapedTrendingTopic[]> {
    if (!this.enabled || !this.xScrapeEnabled || !this.browser) {
      return [];
    }

    // Check cache
    if (this.xTrendsCache && Date.now() < this.xTrendsCache.expiresAt) {
      this.logger.debug(`X Trends cache hit (${this.xTrendsCache.topics.length} topics)`);
      return this.xTrendsCache.topics.slice(0, limit);
    }

    let context: BrowserContext | null = null;
    try {
      context = await this.browser.acquireContext('X' as SocialNetwork);
      const page = await context.newPage();

      // Navigate to trending tab
      await page.goto(X_TRENDS_URL, { waitUntil: 'domcontentloaded', timeout: X_SCRAPE_TIMEOUT_MS });
      await page.waitForTimeout(2000); // let trends load

      // Extract trending topics
      const topics = await this.extractXTrends(page, limit);

      this.xTrendsCache = { topics, expiresAt: Date.now() + this.cacheTtlMs };
      this.logger.log(`Scraped ${topics.length} X trending topics`);
      return topics.slice(0, limit);
    } catch (err) {
      this.logger.warn(`Failed to scrape X trends: ${(err as Error).message}`);
      return this.xTrendsCache?.topics ?? [];
    } finally {
      if (context) {
        try {
          await this.browser.releaseContext('X' as SocialNetwork, context);
        } catch (err) {
          this.logger.warn(`Failed to release X context: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * Extract trending topic text from X Explore page.
   * The trending tab shows trend cards with [data-testid="trend"].
   */
  private async extractXTrends(page: Page, limit: number): Promise<ScrapedTrendingTopic[]> {
    const now = new Date();

    // Wait for trend elements to appear
    try {
      await page.waitForSelector(X_TREND_SELECTOR, { timeout: 10_000 });
    } catch {
      this.logger.warn('X trend elements not found — page may not have loaded trends');
      return [];
    }

    // Extract trend text from each trend card
    const trends = await page.evaluate(
      ({ selector, limit }: { selector: string; limit: number }) => {
        const elements = document.querySelectorAll(selector);
        const results: Array<{ topic: string; rank: number }> = [];
        elements.forEach((el, idx) => {
          if (idx >= limit) return;
          // Trend text is usually in a span within the trend card
          const text = el.textContent?.trim()?.split('\n')[0]?.trim();
          if (text && text.length > 0 && text.length < 200) {
            results.push({ topic: text, rank: idx + 1 });
          }
        });
        return results;
      },
      { selector: X_TREND_SELECTOR, limit },
    );

    return trends.map((t) => ({
      source: 'x_trends' as const,
      topic: t.topic,
      rank: t.rank,
      scrapedAt: now,
    }));
  }

  // ── Niche relevance filtering (keyword whitelist + LLM borderline) ──

  /**
   * Fast keyword filter — returns true if the topic contains at least one
   * niche keyword (case-insensitive substring match).
   * This is the first-pass filter; topics that fail go to the LLM filter.
   */
  private isRelevantByKeyword(topic: string): boolean {
    const lower = topic.toLowerCase();
    return NICHE_KEYWORDS.some((kw) => lower.includes(kw));
  }

  /**
   * LLM relevance filter for borderline topics that didn't match any keyword.
   * Asks the LLM whether the topic is relevant to our niche
   * (astrology / wellness / women's cycles / love / relationships / business /
   * personal growth / mental health / spirituality).
   *
   * Results are cached per-topic (lowercased) to avoid repeated LLM calls.
   * If LLM is unavailable or the call fails, the topic is rejected (fail-closed).
   *
   * @returns true if the LLM considers the topic relevant
   */
  private async isRelevantByLlm(topic: string): Promise<boolean> {
    const key = topic.toLowerCase().trim();
    const cached = this.llmRelevanceCache.get(key);
    if (cached !== undefined) return cached;

    if (!this.llmService || !this.llmFilterEnabled) {
      // No LLM available — fail-closed (reject borderline topics)
      this.llmRelevanceCache.set(key, false);
      return false;
    }

    const systemPrompt =
      'You are a relevance classifier for a social media content agent focused on ' +
      'astrology, wellness, women\'s cycles, love & relationships, business & mindset, ' +
      'personal growth, mental health, and spirituality. ' +
      'Respond with ONLY "YES" or "NO" — no explanation.';
    const userPrompt =
      `Is the trending topic "${topic}" relevant to any of these niches for a social media audience?\n` +
      '- Astrology, zodiac, horoscopes, cosmic events\n' +
      '- Wellness, self-care, meditation, mindfulness\n' +
      "- Women's cycles, feminine energy, hormones\n" +
      '- Love, relationships, dating, romance\n' +
      '- Business, entrepreneurship, mindset, productivity\n' +
      '- Personal growth, purpose, manifestation\n' +
      '- Mental health, emotional wellbeing, therapy\n' +
      '- Spirituality, intuition, soul work\n\n' +
      'Answer YES if the topic can be meaningfully connected to any of these niches, NO otherwise.';

    try {
      const response = await this.llmService.generateChat(systemPrompt, userPrompt, {
        temperature: 0,
      });
      const answer = response.content.trim().toUpperCase();
      const relevant = answer.startsWith('YES');
      this.llmRelevanceCache.set(key, relevant);
      this.logger.debug(`LLM relevance for "${topic}": ${relevant ? 'YES' : 'NO'}`);
      return relevant;
    } catch (err) {
      this.logger.warn(`LLM relevance filter failed for "${topic}": ${(err as Error).message}`);
      this.llmRelevanceCache.set(key, false);
      return false;
    }
  }

  /**
   * Two-layer niche filter: keyword whitelist (fast) → LLM (borderline).
   * Astro topics bypass filtering (they are always relevant by definition).
   *
   * @param topics Scraped topics from Google/X
   * @returns Topics relevant to our niche
   */
  private async filterByNicheRelevance(
    topics: ScrapedTrendingTopic[],
  ): Promise<ScrapedTrendingTopic[]> {
    const passed: ScrapedTrendingTopic[] = [];
    const borderline: ScrapedTrendingTopic[] = [];

    // Layer 1: keyword whitelist (fast, no LLM)
    for (const topic of topics) {
      if (this.isRelevantByKeyword(topic.topic)) {
        passed.push(topic);
      } else {
        borderline.push(topic);
      }
    }

    this.logger.debug(
      `Niche filter: ${passed.length} passed keyword, ${borderline.length} borderline → LLM`,
    );

    // Layer 2: LLM filter for borderline topics
    if (borderline.length === 0) return passed;

    // Batch LLM checks in parallel (limited concurrency to avoid rate limits)
    const MAX_LLM_CONCURRENCY = 3;
    const llmResults: ScrapedTrendingTopic[] = [];

    for (let i = 0; i < borderline.length; i += MAX_LLM_CONCURRENCY) {
      const batch = borderline.slice(i, i + MAX_LLM_CONCURRENCY);
      const checks = await Promise.all(
        batch.map(async (t) => {
          const relevant = await this.isRelevantByLlm(t.topic);
          return relevant ? t : null;
        }),
      );
      for (const c of checks) {
        if (c) llmResults.push(c);
      }
    }

    this.logger.debug(
      `Niche filter: ${llmResults.length} borderline topics passed LLM relevance check`,
    );

    return [...passed, ...llmResults];
  }

  // ── Merged trending (all sources) ──

  /**
   * Get merged trending topics from all sources (Google Trends + X + astro).
   * Topics that appear in multiple sources get higher priority.
   *
   * Niche filtering: Google/X trends are filtered by keyword whitelist + LLM
   * to ensure only topics relevant to our niche (astro/wellness/love/business/etc.)
   * are included. Astro calendar topics bypass filtering (always relevant).
   *
   * @param astroTopics - Topics from TrendingService (astrological events)
   * @returns Merged and prioritized trending topics
   */
  async getMergedTrending(
    astroTopics: Array<{ topic: string; networks: string[] }>,
  ): Promise<MergedTrendingTopic[]> {
    const [rawGoogle, rawX] = await Promise.all([
      this.getGoogleTrends(20),
      this.getXTrends(20),
    ]);

    // Niche filter: only keep Google/X trends relevant to our content niche
    const [googleTopics, xTopics] = await Promise.all([
      this.filterByNicheRelevance(rawGoogle),
      this.filterByNicheRelevance(rawX),
    ]);

    this.logger.log(
      `Niche-filtered trends: Google ${rawGoogle.length}→${googleTopics.length}, ` +
      `X ${rawX.length}→${xTopics.length}`,
    );

    const merged = new Map<string, MergedTrendingTopic>();

    // Add astro topics (priority base — always relevant, bypass filter)
    for (const astro of astroTopics) {
      const key = astro.topic.toLowerCase().trim();
      merged.set(key, {
        topic: astro.topic,
        sources: ['astro'],
        networks: astro.networks,
        priority: 3, // astro = high priority (predictable, high-value)
      });
    }

    // Add Google Trends (already niche-filtered)
    for (const gt of googleTopics) {
      const key = gt.topic.toLowerCase().trim();
      const existing = merged.get(key);
      if (existing) {
        existing.sources.push('google_trends');
        existing.priority += 2; // cross-source confirmation = higher priority
      } else {
        merged.set(key, {
          topic: gt.topic,
          sources: ['google_trends'],
          networks: ['X', 'THREADS', 'FACEBOOK'],
          priority: 2,
          scrapedAt: gt.scrapedAt,
        });
      }
    }

    // Add X Trends (already niche-filtered)
    for (const xt of xTopics) {
      const key = xt.topic.toLowerCase().trim();
      const existing = merged.get(key);
      if (existing) {
        existing.sources.push('x_trends');
        existing.priority += 2;
        // X trends are best for X posting
        if (!existing.networks.includes('X')) existing.networks.push('X');
      } else {
        merged.set(key, {
          topic: xt.topic,
          sources: ['x_trends'],
          networks: ['X', 'THREADS'], // X trends are most relevant to X/Threads
          priority: 2,
          scrapedAt: xt.scrapedAt,
        });
      }
    }

    // Sort by priority (highest first), then by rank
    return Array.from(merged.values()).sort((a, b) => b.priority - a.priority);
  }

  // ── Cache management ──

  /** Invalidate both caches (for testing or manual refresh). */
  invalidateCache(): void {
    this.googleTrendsCache = null;
    this.xTrendsCache = null;
    this.llmRelevanceCache.clear();
  }

  /** Get cache status for health check / debugging. */
  getCacheStatus(): {
    googleTrends: { cached: boolean; topics: number; expiresAt?: Date };
    xTrends: { cached: boolean; topics: number; expiresAt?: Date };
  } {
    return {
      googleTrends: {
        cached: this.googleTrendsCache !== null,
        topics: this.googleTrendsCache?.topics.length ?? 0,
        expiresAt: this.googleTrendsCache
          ? new Date(this.googleTrendsCache.expiresAt)
          : undefined,
      },
      xTrends: {
        cached: this.xTrendsCache !== null,
        topics: this.xTrendsCache?.topics.length ?? 0,
        expiresAt: this.xTrendsCache ? new Date(this.xTrendsCache.expiresAt) : undefined,
      },
    };
  }
}
